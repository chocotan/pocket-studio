package daemon

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"

	"remote-agent/internal/protocol"
	acp "github.com/coder/acp-go-sdk"
)

type goSDKSession struct {
	taskID        string
	agent         string
	session       string
	workspace     string
	modelConfigID string
	configIDs     map[string]string
	client        *goSDKClient
	resetting     bool
	promptMu      sync.Mutex
}

type goSDKClient struct {
	cmd             *exec.Cmd
	conn            *acp.ClientSideConnection
	emitter         *taskEmitter
	workspace       string
	done            chan struct{}
	session         string
	terminals       sync.Map
	nextTerm        atomic.Int64
	mu              sync.Mutex
	assistantText   strings.Builder
	thinkingText    strings.Builder
}

type goSDKTerminal struct {
	cmd             *exec.Cmd
	output          bytes.Buffer
	outputByteLimit int
	truncated       bool
	exitCode        *int
	signal          *string
	done            chan struct{}
	mu              sync.Mutex
}

var _ acp.Client = (*goSDKClient)(nil)

func (c *goSDKClient) ReadTextFile(ctx context.Context, p acp.ReadTextFileRequest) (acp.ReadTextFileResponse, error) {
	absPath, err := c.resolveWorkspacePath(p.Path)
	if err != nil {
		return acp.ReadTextFileResponse{}, err
	}
	contentBytes, err := os.ReadFile(absPath)
	if err != nil {
		return acp.ReadTextFileResponse{}, err
	}
	content := string(contentBytes)
	if p.Line != nil || p.Limit != nil {
		lines := strings.Split(content, "\n")
		start := 0
		if p.Line != nil && *p.Line > 0 {
			start = *p.Line - 1
			if start > len(lines) {
				start = len(lines)
			}
		}
		end := len(lines)
		if p.Limit != nil && *p.Limit > 0 && start+*p.Limit < end {
			end = start + *p.Limit
		}
		content = strings.Join(lines[start:end], "\n")
	}
	return acp.ReadTextFileResponse{
		Content: content,
	}, nil
}

func (c *goSDKClient) WriteTextFile(ctx context.Context, p acp.WriteTextFileRequest) (acp.WriteTextFileResponse, error) {
	absPath, err := c.resolveWorkspacePath(p.Path)
	if err != nil {
		return acp.WriteTextFileResponse{}, err
	}
	dir := filepath.Dir(absPath)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return acp.WriteTextFileResponse{}, err
	}
	err = os.WriteFile(absPath, []byte(p.Content), 0o644)
	if err != nil {
		return acp.WriteTextFileResponse{}, err
	}
	return acp.WriteTextFileResponse{}, nil
}

func (c *goSDKClient) CreateTerminal(ctx context.Context, p acp.CreateTerminalRequest) (acp.CreateTerminalResponse, error) {
	if p.Command == "" {
		return acp.CreateTerminalResponse{}, errors.New("terminal command is required")
	}
	outputLimit := 1024 * 1024
	if p.OutputByteLimit != nil && *p.OutputByteLimit > 0 {
		outputLimit = *p.OutputByteLimit
	}
	cmd := exec.CommandContext(context.Background(), p.Command, p.Args...)
	if p.Cwd != nil && *p.Cwd != "" {
		resolved, err := c.resolveWorkspacePath(*p.Cwd)
		if err != nil {
			return acp.CreateTerminalResponse{}, err
		}
		cmd.Dir = resolved
	} else {
		cmd.Dir = c.workspace
	}
	env := os.Environ()
	if p.Env != nil {
		for _, ev := range p.Env {
			env = append(env, fmt.Sprintf("%s=%s", ev.Name, ev.Value))
		}
	}
	cmd.Env = env
	setProcessGroup(cmd)
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return acp.CreateTerminalResponse{}, err
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		return acp.CreateTerminalResponse{}, err
	}
	if err := cmd.Start(); err != nil {
		return acp.CreateTerminalResponse{}, err
	}
	id := fmt.Sprintf("gosdk_term_%d", c.nextTerm.Add(1))
	terminal := &goSDKTerminal{
		cmd:             cmd,
		outputByteLimit: outputLimit,
		done:            make(chan struct{}),
	}
	c.terminals.Store(id, terminal)
	go terminal.scan(stdout)
	go terminal.scan(stderr)
	go func() {
		err := cmd.Wait()
		terminal.mu.Lock()
		if exitErr, ok := err.(*exec.ExitError); ok {
			code := exitErr.ExitCode()
			terminal.exitCode = &code
		} else if err == nil {
			code := 0
			terminal.exitCode = &code
		} else {
			code := -1
			terminal.exitCode = &code
			signal := err.Error()
			terminal.signal = &signal
		}
		terminal.mu.Unlock()
		close(terminal.done)
	}()
	return acp.CreateTerminalResponse{
		TerminalId: id,
	}, nil
}

func (c *goSDKClient) KillTerminal(ctx context.Context, p acp.KillTerminalRequest) (acp.KillTerminalResponse, error) {
	term, err := c.lookupTerminal(p.TerminalId)
	if err != nil {
		return acp.KillTerminalResponse{}, err
	}
	terminateProcess(term.cmd)
	return acp.KillTerminalResponse{}, nil
}

func (c *goSDKClient) ReleaseTerminal(ctx context.Context, p acp.ReleaseTerminalRequest) (acp.ReleaseTerminalResponse, error) {
	term, err := c.lookupTerminal(p.TerminalId)
	if err != nil {
		return acp.ReleaseTerminalResponse{}, err
	}
	terminateProcess(term.cmd)
	c.terminals.Delete(p.TerminalId)
	return acp.ReleaseTerminalResponse{}, nil
}

func (c *goSDKClient) TerminalOutput(ctx context.Context, p acp.TerminalOutputRequest) (acp.TerminalOutputResponse, error) {
	term, err := c.lookupTerminal(p.TerminalId)
	if err != nil {
		return acp.TerminalOutputResponse{}, err
	}
	term.mu.Lock()
	defer term.mu.Unlock()
	output := term.output.String()
	term.output.Reset()
	truncated := term.truncated
	term.truncated = false
	return acp.TerminalOutputResponse{
		Output:    output,
		Truncated: truncated,
	}, nil
}

func (c *goSDKClient) WaitForTerminalExit(ctx context.Context, p acp.WaitForTerminalExitRequest) (acp.WaitForTerminalExitResponse, error) {
	term, err := c.lookupTerminal(p.TerminalId)
	if err != nil {
		return acp.WaitForTerminalExitResponse{}, err
	}
	select {
	case <-term.done:
	case <-ctx.Done():
		return acp.WaitForTerminalExitResponse{}, ctx.Err()
	}
	term.mu.Lock()
	defer term.mu.Unlock()
	return acp.WaitForTerminalExitResponse{
		ExitCode: term.exitCode,
		Signal:   term.signal,
	}, nil
}

func (c *goSDKClient) RequestPermission(ctx context.Context, p acp.RequestPermissionRequest) (acp.RequestPermissionResponse, error) {
	if len(p.Options) == 0 {
		return acp.RequestPermissionResponse{
			Outcome: acp.RequestPermissionOutcome{
				Cancelled: &acp.RequestPermissionOutcomeCancelled{},
			},
		}, nil
	}
	raw, _ := json.Marshal(p)
	c.emitter.emit("permission.request", p, raw)

	return acp.RequestPermissionResponse{
		Outcome: acp.RequestPermissionOutcome{
			Selected: &acp.RequestPermissionOutcomeSelected{
				OptionId: p.Options[0].OptionId,
			},
		},
	}, nil
}

func (c *goSDKClient) SessionUpdate(ctx context.Context, n acp.SessionNotification) error {
	raw, _ := json.Marshal(n)
	u := n.Update
	acpxTurnIndex := c.emitter.acpxTurnIndex()

	switch {
	case u.AgentMessageChunk != nil:
		chunk := u.AgentMessageChunk
		if chunk.Content.Text != nil {
			c.mu.Lock()
			c.assistantText.WriteString(chunk.Content.Text.Text)
			fullText := c.assistantText.String()
			c.mu.Unlock()

			data := map[string]any{
				"text":            fullText,
				"stream_id":       fmt.Sprintf("gosdk_stream_assistant_%s", n.SessionId),
				"acpx_turn_index": acpxTurnIndex,
				"acpx_event_key":  fmt.Sprintf("turn:%d:assistant.message:%s", acpxTurnIndex, n.SessionId),
				"replace":         true,
			}
			c.emitter.emit("assistant.message", data, raw)
		}
	case u.AgentThoughtChunk != nil:
		chunk := u.AgentThoughtChunk
		if chunk.Content.Text != nil {
			c.mu.Lock()
			c.thinkingText.WriteString(chunk.Content.Text.Text)
			fullText := c.thinkingText.String()
			c.mu.Unlock()

			data := map[string]any{
				"text":            fullText,
				"stream_id":       fmt.Sprintf("gosdk_stream_thinking_%s", n.SessionId),
				"acpx_turn_index": acpxTurnIndex,
				"acpx_event_key":  fmt.Sprintf("turn:%d:assistant.thinking:%s", acpxTurnIndex, n.SessionId),
				"replace":         true,
			}
			c.emitter.emit("assistant.thinking", data, raw)
		}
	case u.ToolCall != nil:
		tc := u.ToolCall
		data := map[string]any{
			"tool_use_id":     tc.ToolCallId,
			"name":            tc.Title,
			"status":          tc.Status,
			"acpx_turn_index": acpxTurnIndex,
			"acpx_event_key":  fmt.Sprintf("turn:%d:tool.call:%s", acpxTurnIndex, tc.ToolCallId),
		}
		c.emitter.emit("tool.call", data, raw)
	case u.ToolCallUpdate != nil:
		tcu := u.ToolCallUpdate
		data := map[string]any{
			"tool_use_id":     tcu.ToolCallId,
			"status":          tcu.Status,
			"acpx_turn_index": acpxTurnIndex,
			"acpx_event_key":  fmt.Sprintf("turn:%d:tool.output:%s", acpxTurnIndex, tcu.ToolCallId),
		}
		if tcu.RawOutput != nil {
			data["output"] = tcu.RawOutput
		}
		c.emitter.emit("tool.output", data, raw)
	case u.ConfigOptionUpdate != nil:
		c.emitter.emit("config.updated", nil, raw)
	case u.SessionInfoUpdate != nil:
		c.emitter.emit("acpx.raw", nil, raw)
	case u.UsageUpdate != nil:
		c.emitter.emit("metric.updated", nil, raw)
	}
	return nil
}

func (c *goSDKClient) close() {
	if c.cmd != nil && c.cmd.Process != nil {
		_ = c.cmd.Process.Kill()
	}
	c.closeTerminals()
}

func (c *goSDKClient) closeTerminals() {
	c.terminals.Range(func(key, value any) bool {
		if term, ok := value.(*goSDKTerminal); ok {
			terminateProcess(term.cmd)
		}
		return true
	})
}

func (c *goSDKClient) lookupTerminal(id string) (*goSDKTerminal, error) {
	val, ok := c.terminals.Load(id)
	if !ok {
		return nil, fmt.Errorf("terminal %q not found", id)
	}
	return val.(*goSDKTerminal), nil
}

func (c *goSDKClient) resolveWorkspacePath(path string) (string, error) {
	cleanTarget := filepath.Clean(path)
	if !filepath.IsAbs(cleanTarget) {
		cleanTarget = filepath.Join(c.workspace, cleanTarget)
	}
	if !strings.HasPrefix(cleanTarget, c.workspace) {
		return "", fmt.Errorf("path %q is outside workspace %q", path, c.workspace)
	}
	return cleanTarget, nil
}

func (t *goSDKTerminal) scan(r io.Reader) {
	scanner := bufio.NewScanner(r)
	scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	for scanner.Scan() {
		t.appendOutput(scanner.Text() + "\n")
	}
}

func (t *goSDKTerminal) appendOutput(text string) {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.output.WriteString(text)
	if t.outputByteLimit <= 0 || t.output.Len() <= t.outputByteLimit {
		return
	}
	current := t.output.String()
	if len(current) > t.outputByteLimit {
		current = current[len(current)-t.outputByteLimit:]
	}
	t.output.Reset()
	t.output.WriteString(current)
	t.truncated = true
}

func (d *Daemon) createGoSDKSession(ctx context.Context, task protocol.TaskDispatch, workspacePath string, taskID string) error {
	agent := taskAgentName(task, d.cfg.ACPX.Agent)
	sessionName := taskSessionName(task, d.cfg.ACPX.SessionName)
	if sessionName == "" {
		sessionName = taskID
	}
	cfg, ok := d.directACPAgentConfig(agent)
	if !ok {
		return fmt.Errorf("agent %q is not configured for gosdk", agent)
	}

	emitter := &taskEmitter{daemon: d, taskID: taskID}
	client, err := startGoSDKClient(context.Background(), cfg, workspacePath, emitter)
	if err != nil {
		return err
	}

	_, err = client.conn.Initialize(ctx, acp.InitializeRequest{
		ProtocolVersion: acp.ProtocolVersionNumber,
		ClientCapabilities: acp.ClientCapabilities{
			Terminal: true,
			Fs: acp.FileSystemCapabilities{
				ReadTextFile:  true,
				WriteTextFile: true,
			},
		},
		ClientInfo: &acp.Implementation{
			Name:    "Pocket Studio GoSDK",
			Version: "0",
		},
	})
	if err != nil {
		client.close()
		return fmt.Errorf("initialize GoSDK connection: %w", err)
	}

	sessResp, err := client.conn.NewSession(ctx, acp.NewSessionRequest{
		Cwd:        workspacePath,
		McpServers: []acp.McpServer{},
	})
	if err != nil {
		client.close()
		return fmt.Errorf("create GoSDK session: %w", err)
	}

	client.session = string(sessResp.SessionId)

	now := protocolNow()
	d.mu.Lock()
	if existing := d.goSDKSessions[taskID]; existing != nil {
		existing.client.close()
	}
	if d.goSDKSessions == nil {
		d.goSDKSessions = make(map[string]*goSDKSession)
	}
	d.goSDKSessions[taskID] = &goSDKSession{
		taskID:    taskID,
		agent:     agent,
		session:   sessionName,
		workspace: workspacePath,
		client:    client,
	}

	record := d.history[taskID]
	if record.TaskID == "" {
		record.TaskID = taskID
		record.StartedAt = now
	}
	record.DeviceID = d.cfg.Device.ID
	record.WorkspaceID = workspaceIDForPath(workspacePath)
	record.WorkspacePath = workspacePath
	record.Agent = agent
	record.AgentRuntime = "gosdk"
	record.SessionName = sessionName
	record.SessionID = client.session
	if record.Status == "" {
		record.Status = "created"
	}
	record.UpdatedAt = now
	d.history[taskID] = record
	if err := d.saveDirectACPStoreLocked(); err != nil {
		log.Printf("save direct acp sessions (GoSDK): %v", err)
	}
	d.mu.Unlock()

	d.emitTaskEvent(taskID, "acp.session", 0, map[string]any{
		"agent":          agent,
		"agent_runtime":  "gosdk",
		"session_name":   sessionName,
		"agentSessionId": client.session,
		"recovered":      false,
	}, nil)

	return nil
}

func startGoSDKClient(ctx context.Context, cfg DirectACPAgentConfig, workspacePath string, emitter *taskEmitter) (*goSDKClient, error) {
	cmd := directACPCommand(ctx, cfg)
	cmd.Dir = workspacePath
	cmd.Env = mergeEnv(os.Environ(), cfg.Env)
	setProcessGroup(cmd)
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return nil, err
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, err
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		return nil, err
	}
	if err := cmd.Start(); err != nil {
		return nil, err
	}

	client := &goSDKClient{
		cmd:       cmd,
		emitter:   emitter,
		workspace: workspacePath,
		done:      make(chan struct{}),
	}
	client.conn = acp.NewClientSideConnection(client, stdin, stdout)

	go func() {
		scanDirectACPStderr(stderr, emitter)
	}()

	go func() {
		select {
		case <-client.conn.Done():
		}
		_ = cmd.Wait()
		client.closeTerminals()
		close(client.done)
	}()

	return client, nil
}

func (d *Daemon) startGoSDKTask(parent context.Context, task protocol.TaskDispatch, workspace protocol.Workspace) {
	sessionName := taskSessionName(task, d.cfg.ACPX.SessionName)
	if sessionName == "" {
		sessionName = task.TaskID
	}
	turnID := task.TurnID
	if turnID == "" {
		turnID = protocol.NewID("turn")
	}
	ctx, cancel := context.WithCancel(parent)
	if err := d.ensureGoSDKSession(ctx, task, workspace.Path, task.TaskID); err != nil {
		cancel()
		d.emitError(task.TaskID, "session_ensure_failed", err.Error())
		return
	}

	d.mu.Lock()
	session := d.goSDKSessions[task.TaskID]
	if session == nil {
		d.mu.Unlock()
		cancel()
		d.emitError(task.TaskID, "session_not_found", "GoSDK session is not available")
		return
	}
	promptMu := &session.promptMu
	record := d.history[task.TaskID]
	agent := taskAgentName(task, d.cfg.ACPX.Agent)
	d.mu.Unlock()

	promptMu.Lock()
	defer promptMu.Unlock()

	d.mu.Lock()
	currentSession := d.goSDKSessions[task.TaskID]
	if currentSession != session || session.resetting {
		d.mu.Unlock()
		cancel()
		return
	}
	client := session.client
	now := protocolNow()
	record = d.history[task.TaskID]
	if record.TaskID == "" {
		record.TaskID = task.TaskID
		record.StartedAt = now
	}
	record.WorkspaceID = workspace.ID
	record.WorkspacePath = workspace.Path
	record.DeviceID = d.cfg.Device.ID
	record.Prompt = task.Prompt
	record.ParentTaskID = task.ParentTaskID
	if client.session != "" {
		record.SessionID = client.session
	}
	record.Agent = agent
	record.AgentRuntime = "gosdk"
	record.SessionName = sessionName
	record.Status = "running"
	record.UpdatedAt = now
	userEvent := userPromptTaskEvent(task.TaskID, turnID, task.Prompt, record.UpdatedAt, nextHistoryEventSequence(record.Events), -1)
	if userEvent.TaskID != "" {
		record.Events = append(record.Events, userEvent)
	}
	d.history[task.TaskID] = record
	if err := d.saveDirectACPStoreLocked(); err != nil {
		log.Printf("save direct acp sessions (GoSDK): %v", err)
	}
	rt := &runningTask{
		id:        task.TaskID,
		turnID:    turnID,
		cancel:    cancel,
		done:      make(chan struct{}),
		workspace: workspace.Path,
		agent:     record.Agent,
		session:   sessionName,
	}
	d.tasks[task.TaskID] = rt
	d.mu.Unlock()

	emitter := client.emitter
	if userEvent.TaskID != "" {
		d.sendTaskEvent(userEvent)
	}
	emitter.emit("task.started", map[string]any{
		"turn_id":       turnID,
		"workspace":     workspace.Path,
		"command":       client.cmd.Path,
		"args":          client.cmd.Args[1:],
		"agent":         record.Agent,
		"agent_runtime": "gosdk",
	}, nil)

	client.mu.Lock()
	client.assistantText.Reset()
	client.thinkingText.Reset()
	client.mu.Unlock()

	_, err := client.conn.Prompt(ctx, acp.PromptRequest{
		SessionId: acp.SessionId(client.session),
		Prompt: []acp.ContentBlock{
			acp.TextBlock(task.Prompt),
		},
	})

	d.mu.Lock()
	currentTask := d.tasks[task.TaskID] == rt
	if currentTask {
		delete(d.tasks, task.TaskID)
	}
	d.mu.Unlock()
	close(rt.done)
	cancel()

	if err != nil {
		if !currentTask {
			return
		}
		if rt.isStopping() {
			emitter.emit("task.killed", map[string]any{"reason": "user_requested"}, nil)
			return
		}
		emitter.emit("task.failed", map[string]any{"error": err.Error()}, nil)
		return
	}
	if !currentTask {
		return
	}
	emitter.emit("task.completed", map[string]any{"exit_code": 0}, nil)
}

func (d *Daemon) ensureGoSDKSession(ctx context.Context, task protocol.TaskDispatch, workspacePath string, taskID string) error {
	for {
		d.mu.Lock()
		if session := d.goSDKSessions[taskID]; session != nil {
			if !session.resetting {
				d.mu.Unlock()
				return nil
			}
			d.mu.Unlock()
			select {
			case <-session.client.done:
			case <-ctx.Done():
				return ctx.Err()
			}
			continue
		}
		d.mu.Unlock()

		err := d.createGoSDKSession(ctx, task, workspacePath, taskID)
		return err
	}
}

func (d *Daemon) stopGoSDKTask(taskID string) bool {
	d.mu.Lock()
	session := d.goSDKSessions[taskID]
	rt := d.tasks[taskID]
	if session != nil {
		session.resetting = true
	}
	d.mu.Unlock()
	if session == nil {
		return false
	}
	if rt != nil {
		rt.markStopping()
		d.emitTaskEvent(taskID, "task.stopping", 0, map[string]string{"reason": "user_requested"}, nil)
	}
	
	_ = session.client.conn.Cancel(context.Background(), acp.CancelNotification{
		SessionId: acp.SessionId(session.client.session),
	})

	if rt != nil && rt.cancel != nil {
		rt.cancel()
	}
	session.client.close()

	d.mu.Lock()
	if current := d.goSDKSessions[taskID]; current == session {
		delete(d.goSDKSessions, taskID)
	}
	if rt != nil && d.tasks[taskID] == rt {
		delete(d.tasks, taskID)
	}
	d.mu.Unlock()
	return true
}

func (d *Daemon) deleteGoSDKSession(taskID string) bool {
	d.mu.Lock()
	session := d.goSDKSessions[taskID]
	delete(d.goSDKSessions, taskID)
	delete(d.history, taskID)
	saveErr := d.saveDirectACPStoreLocked()
	d.mu.Unlock()
	if saveErr != nil {
		log.Printf("save direct acp sessions (GoSDK): %v", saveErr)
	}
	if session == nil {
		return false
	}
	_ = session.client.conn.Cancel(context.Background(), acp.CancelNotification{
		SessionId: acp.SessionId(session.client.session),
	})
	_, _ = session.client.conn.CloseSession(context.Background(), acp.CloseSessionRequest{
		SessionId: acp.SessionId(session.client.session),
	})
	session.client.close()
	return true
}
