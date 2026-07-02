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
	"runtime"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"remote-agent/internal/protocol"
)

type directACPClient struct {
	cmd       *exec.Cmd
	stdin     io.WriteCloser
	emitter   *taskEmitter
	workspace string
	writeMu   sync.Mutex
	pending   sync.Map
	nextID    atomic.Int64
	done      chan struct{}
	session   string
	terminals sync.Map
	nextTerm  atomic.Int64
}

type directACPResponse struct {
	Result json.RawMessage `json:"result,omitempty"`
	Error  any             `json:"error,omitempty"`
}

type directACPModelListEvent struct {
	CurrentModelID  string                     `json:"currentModelId,omitempty"`
	AvailableModels []directACPModelListOption `json:"availableModels"`
}

type directACPModelListOption struct {
	ModelID     string `json:"modelId"`
	Name        string `json:"name"`
	Description string `json:"description,omitempty"`
}

type directACPConfigOptionsEvent struct {
	ConfigOptions []map[string]any `json:"configOptions"`
}

type directACPCapabilities struct {
	List   bool
	Load   bool
	Resume bool
}

func (d *Daemon) createDirectACPSession(ctx context.Context, task protocol.TaskDispatch, workspacePath string, taskID string) error {
	agent := taskAgentName(task, d.cfg.ACPX.Agent)
	sessionName := taskSessionName(task, d.cfg.ACPX.SessionName)
	if sessionName == "" {
		sessionName = taskID
	}
	cfg, ok := d.directACPAgentConfig(agent)
	if !ok {
		return fmt.Errorf("direct ACP agent %q is not configured", agent)
	}

	emitter := &taskEmitter{daemon: d, taskID: taskID}
	client, err := startDirectACPClient(context.Background(), cfg, workspacePath, emitter)
	if err != nil {
		return err
	}
	initRaw, err := client.request(ctx, "initialize", map[string]any{
		"protocolVersion": 1,
		"clientCapabilities": map[string]any{
			"terminal": true,
			"fs": map[string]any{
				"readTextFile":  true,
				"writeTextFile": true,
			},
		},
		"clientInfo": map[string]any{
			"name":    "Pocket Studio",
			"version": "0",
		},
	})
	if err != nil {
		client.close()
		return fmt.Errorf("initialize direct ACP: %w", err)
	}
	capabilities := directACPCapabilitiesFromInitialize(initRaw)
	initModelConfigID, initModelList := directACPModelList(initRaw)
	raw, recovered, err := d.openDirectACPSession(ctx, client, task, workspacePath, capabilities)
	if err != nil {
		client.close()
		return err
	}
	client.session = firstStringInJSON(raw, "sessionId", "session_id", "id")
	if client.session == "" && recovered {
		client.session = firstNonEmpty(task.ResumeSessionID, restoredDirectACPSessionID(d.history[taskID]))
	}
	if client.session == "" {
		client.session = sessionName
	}
	modelConfigID, modelList := directACPModelList(raw)
	if modelConfigID == "" {
		modelConfigID = initModelConfigID
	}
	if len(modelList.AvailableModels) == 0 {
		modelList = initModelList
	}
	configOptions := directACPConfigOptions(raw)
	if len(configOptions.ConfigOptions) == 0 {
		configOptions = directACPConfigOptions(initRaw)
	}

	now := protocolNow()
	d.mu.Lock()
	if existing := d.directACP[taskID]; existing != nil {
		existing.client.close()
	}
	d.directACP[taskID] = &directACPSession{
		taskID:        taskID,
		agent:         agent,
		session:       sessionName,
		workspace:     workspacePath,
		modelConfigID: modelConfigID,
		configIDs:     directACPConfigIDs(configOptions.ConfigOptions),
		client:        client,
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
	record.AgentRuntime = "direct_acp"
	record.SessionName = sessionName
	record.SessionID = client.session
	if record.Status == "" {
		record.Status = "created"
	}
	record.UpdatedAt = now
	if record.ModelID == "" && modelList.CurrentModelID != "" {
		record.ModelID = modelList.CurrentModelID
	}
	d.history[taskID] = record
	if err := d.saveDirectACPStoreLocked(); err != nil {
		log.Printf("save direct acp sessions: %v", err)
	}
	d.mu.Unlock()

	d.emitTaskEvent(taskID, "acp.session", 0, map[string]any{
		"agent":          agent,
		"agent_runtime":  "direct_acp",
		"session_name":   sessionName,
		"agentSessionId": client.session,
		"recovered":      recovered,
	}, raw)
	if len(modelList.AvailableModels) > 0 {
		d.emitTaskEvent(taskID, "model.list", 0, modelList, raw)
	}
	if len(configOptions.ConfigOptions) > 0 {
		d.emitTaskEvent(taskID, "config.options", 0, configOptions, raw)
	}
	return nil
}

func (d *Daemon) openDirectACPSession(ctx context.Context, client *directACPClient, task protocol.TaskDispatch, workspacePath string, capabilities directACPCapabilities) (json.RawMessage, bool, error) {
	d.mu.Lock()
	restoredSessionID := restoredDirectACPSessionID(d.history[task.TaskID])
	d.mu.Unlock()
	sessionID := firstNonEmpty(task.ResumeSessionID, restoredSessionID)
	if sessionID != "" && capabilities.Load {
		raw, err := client.request(ctx, "session/load", map[string]any{
			"sessionId":  sessionID,
			"cwd":        workspacePath,
			"mcpServers": []any{},
		})
		if err == nil {
			return raw, true, nil
		}
	}
	if sessionID != "" && capabilities.Resume {
		raw, err := client.request(ctx, "session/resume", map[string]any{
			"sessionId":  sessionID,
			"cwd":        workspacePath,
			"mcpServers": []any{},
		})
		if err == nil {
			return raw, true, nil
		}
	}
	raw, err := client.request(ctx, "session/new", map[string]any{
		"cwd":        workspacePath,
		"mcpServers": []any{},
	})
	if err != nil {
		return raw, false, fmt.Errorf("create direct ACP session: %w", err)
	}
	return raw, false, nil
}

func restoredDirectACPSessionID(record protocol.TaskRecord) string {
	return strings.TrimSpace(record.SessionID)
}

func (d *Daemon) startDirectACPTask(parent context.Context, task protocol.TaskDispatch, workspace protocol.Workspace) {
	sessionName := taskSessionName(task, d.cfg.ACPX.SessionName)
	if sessionName == "" {
		sessionName = task.TaskID
	}
	ctx, cancel := context.WithCancel(parent)
	if err := d.ensureDirectACPSession(ctx, task, workspace.Path, task.TaskID); err != nil {
		cancel()
		d.emitError(task.TaskID, "session_ensure_failed", err.Error())
		return
	}

	d.mu.Lock()
	session := d.directACP[task.TaskID]
	if session == nil {
		d.mu.Unlock()
		cancel()
		d.emitError(task.TaskID, "session_not_found", "direct ACP session is not available")
		return
	}
	promptMu := &session.promptMu
	record := d.history[task.TaskID]
	agent := taskAgentName(task, d.cfg.ACPX.Agent)
	if task.ModelID == "" {
		task.ModelID = record.ModelID
	}
	d.mu.Unlock()

	promptMu.Lock()
	defer promptMu.Unlock()

	d.mu.Lock()
	currentSession := d.directACP[task.TaskID]
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
	record.SessionID = firstNonEmpty(task.ResumeSessionID, client.session)
	record.Agent = agent
	record.AgentRuntime = task.AgentRuntime
	record.SessionName = sessionName
	if task.ModelID != "" {
		record.ModelID = task.ModelID
	}
	record.Status = "running"
	record.UpdatedAt = now
	userEvent := userPromptTaskEvent(task.TaskID, task.Prompt, record.UpdatedAt, nextHistoryEventSequence(record.Events))
	if userEvent.TaskID != "" {
		record.Events = append(record.Events, userEvent)
	}
	d.history[task.TaskID] = record
	if err := d.saveDirectACPStoreLocked(); err != nil {
		log.Printf("save direct acp sessions: %v", err)
	}
	rt := &runningTask{
		id:        task.TaskID,
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
		d.send <- protocol.NewEnvelope(protocol.TypeTaskEvent, "daemon", userEvent)
	}
	emitter.emit("task.started", map[string]any{
		"workspace":     workspace.Path,
		"command":       client.cmd.Path,
		"args":          client.cmd.Args[1:],
		"agent":         record.Agent,
		"agent_runtime": "direct_acp",
	}, nil)

	if task.ModelID != "" {
		if raw, err := d.updateDirectACPModel(ctx, session, task.ModelID); err != nil {
			emitter.emit("model.update_failed", map[string]string{
				"model_id": task.ModelID,
				"error":    err.Error(),
			}, raw)
		} else {
			d.recordDirectACPModel(task.TaskID, task.ModelID)
			emitter.emit("model.updated", map[string]string{"model_id": task.ModelID}, raw)
			_, modelList := directACPModelList(raw)
			if len(modelList.AvailableModels) > 0 {
				emitter.emit("model.list", modelList, raw)
			}
		}
	}

	_, err := client.request(ctx, "session/prompt", map[string]any{
		"sessionId": client.session,
		"prompt": []map[string]any{
			{
				"type": "text",
				"text": task.Prompt,
			},
		},
	})

	d.mu.Lock()
	delete(d.tasks, task.TaskID)
	d.mu.Unlock()
	close(rt.done)
	cancel()

	if err != nil {
		if rt.isStopping() {
			emitter.emit("task.killed", map[string]any{"reason": "user_requested"}, nil)
			return
		}
		emitter.emit("task.failed", map[string]any{"error": err.Error()}, nil)
		return
	}
	if emitter.completedNormally() {
		emitter.emit("task.completed", map[string]any{"exit_code": 0, "stop_reason": "end_turn"}, nil)
		return
	}
	emitter.emit("task.completed", map[string]any{"exit_code": 0}, nil)
}

func (d *Daemon) ensureDirectACPSession(ctx context.Context, task protocol.TaskDispatch, workspacePath string, taskID string) error {
	agentName := taskAgentName(task, d.cfg.ACPX.Agent)
	var conflictingACPXTasks []string
	d.mu.Lock()
	for id, rt := range d.tasks {
		if rt.acpx && rt.agent == agentName {
			conflictingACPXTasks = append(conflictingACPXTasks, id)
		}
	}
	d.mu.Unlock()

	for _, id := range conflictingACPXTasks {
		log.Printf("[Daemon] Stopping conflicting ACPX task %s for agent %q because Direct ACP session is being ensured", id, agentName)
		d.stopTask(id)
	}

	if d.cfg.ACPX.Enabled {
		acpxSessionName := taskSessionName(task, d.cfg.ACPX.SessionName)
		if acpxSessionName != "" {
			log.Printf("[Daemon] Closing conflicting ACPX session %q for agent %q because Direct ACP session is being ensured", acpxSessionName, agentName)
			_ = d.deleteACPXSession(ctx, nil, workspacePath, agentName, acpxSessionName)
		}
	}

	for {
		d.mu.Lock()
		if session := d.directACP[taskID]; session != nil {
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
		if start := d.directACPStarts[taskID]; start != nil {
			done := start.done
			d.mu.Unlock()
			select {
			case <-done:
				if start.err != nil {
					return start.err
				}
				return nil
			case <-ctx.Done():
				return ctx.Err()
			}
		}
		start := &directACPStart{done: make(chan struct{})}
		d.directACPStarts[taskID] = start
		d.startingTasks[taskID] = struct{}{}
		d.mu.Unlock()

		err := d.createDirectACPSession(ctx, task, workspacePath, taskID)

		d.mu.Lock()
		start.err = err
		delete(d.directACPStarts, taskID)
		delete(d.startingTasks, taskID)
		close(start.done)
		d.mu.Unlock()
		return err
	}
}

func (d *Daemon) stopDirectACPTask(taskID string) bool {
	d.mu.Lock()
	session := d.directACP[taskID]
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
	_ = session.client.notify("session/cancel", map[string]any{"sessionId": session.client.session})
	if rt != nil && rt.cancel != nil {
		rt.cancel()
	}
	session.client.close()
	d.mu.Lock()
	if current := d.directACP[taskID]; current == session {
		delete(d.directACP, taskID)
	}
	d.mu.Unlock()
	return true
}

func (d *Daemon) deleteDirectACPSession(taskID string) bool {
	d.mu.Lock()
	session := d.directACP[taskID]
	delete(d.directACP, taskID)
	delete(d.history, taskID)
	saveErr := d.saveDirectACPStoreLocked()
	d.mu.Unlock()
	if saveErr != nil {
		log.Printf("save direct acp sessions: %v", saveErr)
	}
	if session == nil {
		return false
	}
	_ = session.client.notify("session/cancel", map[string]any{"sessionId": session.client.session})
	_ = session.client.notify("session/close", map[string]any{"sessionId": session.client.session})
	session.client.close()
	return true
}

func (d *Daemon) setDirectACPModel(parent context.Context, change protocol.TaskSetModel) bool {
	taskID := strings.TrimSpace(change.TaskID)
	modelID := strings.TrimSpace(change.ModelID)
	d.mu.Lock()
	session := d.directACP[taskID]
	d.mu.Unlock()
	if session == nil {
		return false
	}
	ctx, cancel := context.WithTimeout(parent, 30*time.Second)
	defer cancel()
	raw, err := d.updateDirectACPConfigOption(ctx, session, session.modelConfigID, "model", modelID)
	if err != nil {
		d.emitTaskEvent(taskID, "model.update_failed", 0, map[string]string{
			"model_id": modelID,
			"error":    err.Error(),
		}, raw)
		return true
	}
	modelConfigID, modelList := directACPModelList(raw)
	if modelConfigID != "" {
		session.modelConfigID = modelConfigID
	}
	configOptions := directACPConfigOptions(raw)
	if len(configOptions.ConfigOptions) > 0 {
		session.configIDs = directACPConfigIDs(configOptions.ConfigOptions)
	}
	if modelList.CurrentModelID == "" {
		modelList.CurrentModelID = modelID
	}
	d.recordDirectACPModel(taskID, modelID)
	d.emitTaskEvent(taskID, "model.updated", 0, map[string]string{"model_id": modelID}, raw)
	if len(modelList.AvailableModels) > 0 {
		d.emitTaskEvent(taskID, "model.list", 0, modelList, raw)
	}
	if len(configOptions.ConfigOptions) > 0 {
		d.emitTaskEvent(taskID, "config.options", 0, configOptions, raw)
	}
	return true
}

func (d *Daemon) updateDirectACPModel(ctx context.Context, session *directACPSession, modelID string) (json.RawMessage, error) {
	configID := strings.TrimSpace(session.modelConfigID)
	if configID == "" {
		configID = "model"
	}
	raw, err := d.updateDirectACPConfigOption(ctx, session, configID, "model", modelID)
	if err != nil {
		return raw, err
	}
	modelConfigID, _ := directACPModelList(raw)
	if modelConfigID != "" {
		session.modelConfigID = modelConfigID
	}
	return raw, nil
}

func (d *Daemon) setDirectACPConfigOption(parent context.Context, change protocol.TaskSetConfigOption) bool {
	taskID := strings.TrimSpace(change.TaskID)
	configID := strings.TrimSpace(change.ConfigID)
	value := strings.TrimSpace(change.Value)
	d.mu.Lock()
	session := d.directACP[taskID]
	d.mu.Unlock()
	if session == nil {
		return false
	}
	ctx, cancel := context.WithTimeout(parent, 30*time.Second)
	defer cancel()
	wireConfigID := configID
	if session.configIDs != nil && session.configIDs[configID] != "" {
		wireConfigID = session.configIDs[configID]
	}
	raw, err := d.updateDirectACPConfigOption(ctx, session, wireConfigID, configID, value)
	if err != nil {
		d.emitTaskEvent(taskID, "config.update_failed", 0, map[string]string{
			"config_id": configID,
			"value":     value,
			"error":     err.Error(),
		}, raw)
		return true
	}
	configOptions := directACPConfigOptions(raw)
	if len(configOptions.ConfigOptions) > 0 {
		session.configIDs = directACPConfigIDs(configOptions.ConfigOptions)
		if modelConfigID, modelList := directACPModelList(raw); len(modelList.AvailableModels) > 0 {
			if modelConfigID != "" {
				session.modelConfigID = modelConfigID
			}
			if modelList.CurrentModelID != "" {
				d.recordDirectACPModel(taskID, modelList.CurrentModelID)
			}
			d.emitTaskEvent(taskID, "model.list", 0, modelList, raw)
		}
	}
	d.emitTaskEvent(taskID, "config.updated", 0, map[string]string{"config_id": configID, "value": value}, raw)
	if len(configOptions.ConfigOptions) > 0 {
		d.emitTaskEvent(taskID, "config.options", 0, configOptions, raw)
	}
	return true
}

func (d *Daemon) updateDirectACPConfigOption(ctx context.Context, session *directACPSession, configID string, fallbackConfigID string, value string) (json.RawMessage, error) {
	configID = strings.TrimSpace(configID)
	if configID == "" {
		configID = strings.TrimSpace(fallbackConfigID)
	}
	raw, err := session.client.request(ctx, "session/set_config_option", map[string]any{
		"sessionId": session.client.session,
		"configId":  configID,
		"value":     value,
	})
	if err != nil && strings.Contains(err.Error(), "Method not found") {
		raw, err = session.client.request(ctx, "session/setConfigOption", map[string]any{
			"sessionId": session.client.session,
			"configId":  configID,
			"value":     value,
		})
	}
	return raw, err
}

func (d *Daemon) recordDirectACPModel(taskID string, modelID string) {
	d.mu.Lock()
	record := d.history[taskID]
	record.ModelID = modelID
	record.UpdatedAt = protocolNow()
	d.history[taskID] = record
	if err := d.saveDirectACPStoreLocked(); err != nil {
		log.Printf("save direct acp sessions: %v", err)
	}
	d.mu.Unlock()
}

func startDirectACPClient(ctx context.Context, cfg DirectACPAgentConfig, workspacePath string, emitter *taskEmitter) (*directACPClient, error) {
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
	client := &directACPClient{
		cmd:       cmd,
		stdin:     stdin,
		emitter:   emitter,
		workspace: workspacePath,
		done:      make(chan struct{}),
	}
	go client.readStdout(stdout)
	go scanDirectACPStderr(stderr, emitter)
	go func() {
		_ = cmd.Wait()
		client.closeTerminals()
		close(client.done)
	}()
	return client, nil
}

func directACPCommand(ctx context.Context, cfg DirectACPAgentConfig) *exec.Cmd {
	if shell := loginShell(); shell != "" {
		command := shellCommand(append([]string{cfg.Command}, cfg.Args...))
		args := []string{"-c", command}
		if shellSupportsLogin(shell) {
			args = []string{"-l", "-c", command}
		}
		return exec.CommandContext(ctx, shell, args...)
	}
	return exec.CommandContext(ctx, cfg.Command, cfg.Args...)
}

func loginShell() string {
	if runtime.GOOS == "windows" {
		return ""
	}
	if shell := strings.TrimSpace(os.Getenv("SHELL")); shell != "" {
		return shell
	}
	for _, candidate := range []string{"/bin/bash", "/usr/bin/bash", "/bin/zsh", "/bin/sh"} {
		if _, err := os.Stat(candidate); err == nil {
			return candidate
		}
	}
	return ""
}

func shellSupportsLogin(shell string) bool {
	base := filepath.Base(shell)
	return slices.Contains([]string{"bash", "zsh", "ksh"}, base)
}

func (c *directACPClient) readStdout(stdout io.Reader) {
	scanner := bufio.NewScanner(stdout)
	scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	adapter := newAgentOutputAdapter(c.emitter, 0)
	defer adapter.flush()
	for scanner.Scan() {
		line := scanner.Bytes()
		if !json.Valid(line) {
			adapter.flush()
			if text := strings.TrimSpace(string(line)); text != "" {
				log.Printf("direct ACP %s stdout: %s", filepath.Base(c.cmd.Path), text)
			}
			continue
		}
		raw := append(json.RawMessage(nil), line...)
		var msg map[string]any
		if err := json.Unmarshal(raw, &msg); err == nil {
			if id, ok := jsonRPCIDString(msg["id"]); ok {
				if chValue, exists := c.pending.LoadAndDelete(id); exists {
					ch := chValue.(chan directACPResponse)
					adapter.handle(raw)
					ch <- directACPResponse{Result: raw, Error: msg["error"]}
					close(ch)
					continue
				}
				if method, _ := msg["method"].(string); method != "" {
					adapter.handle(raw)
					go c.handleRequest(id, method, msg["params"])
					continue
				}
			}
		}
		adapter.handle(raw)
	}
}

func (c *directACPClient) handleRequest(id string, method string, params any) {
	result, err := c.handleClientRequest(method, params)
	if err != nil {
		_ = c.write(map[string]any{
			"jsonrpc": "2.0",
			"id":      id,
			"error": map[string]any{
				"code":    -32000,
				"message": err.Error(),
			},
		})
		return
	}
	_ = c.write(map[string]any{
		"jsonrpc": "2.0",
		"id":      id,
		"result":  result,
	})
}

func (c *directACPClient) handleClientRequest(method string, params any) (any, error) {
	switch method {
	case "session/update":
		return map[string]any{}, nil
	case "session/request_permission":
		return directACPAllowPermission(params), nil
	case "fs/read_text_file", "fs/readTextFile", "readTextFile":
		return c.readTextFile(params)
	case "fs/write_text_file", "fs/writeTextFile", "writeTextFile":
		return c.writeTextFile(params)
	case "terminal/create", "createTerminal":
		return c.createTerminal(params)
	case "terminal/output", "terminalOutput":
		return c.terminalOutput(params)
	case "terminal/wait_for_exit", "terminal/waitForExit", "waitForTerminalExit":
		return c.waitForTerminalExit(params)
	case "terminal/kill", "killTerminal":
		return c.killTerminal(params)
	case "terminal/release", "releaseTerminal":
		return c.releaseTerminal(params)
	default:
		return nil, fmt.Errorf("unsupported ACP client request %q", method)
	}
}

func scanDirectACPStderr(stderr io.Reader, emitter *taskEmitter) {
	scanner := bufio.NewScanner(stderr)
	scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	for scanner.Scan() {
		text := scanner.Text()
		if strings.TrimSpace(text) == "" {
			continue
		}
		log.Printf("direct ACP stderr: %s", text)
	}
}

func (c *directACPClient) request(ctx context.Context, method string, params any) (json.RawMessage, error) {
	id := fmt.Sprint(c.nextID.Add(1))
	ch := make(chan directACPResponse, 1)
	c.pending.Store(id, ch)
	if err := c.write(map[string]any{
		"jsonrpc": "2.0",
		"id":      id,
		"method":  method,
		"params":  params,
	}); err != nil {
		c.pending.Delete(id)
		return nil, err
	}
	select {
	case response := <-ch:
		if response.Error != nil {
			return response.Result, fmt.Errorf("ACP %s failed: %v", method, response.Error)
		}
		return response.Result, nil
	case <-ctx.Done():
		c.pending.Delete(id)
		return nil, ctx.Err()
	case <-c.done:
		c.pending.Delete(id)
		return nil, errors.New("ACP process exited")
	}
}

func (c *directACPClient) notify(method string, params any) error {
	return c.write(map[string]any{
		"jsonrpc": "2.0",
		"method":  method,
		"params":  params,
	})
}

func (c *directACPClient) write(message map[string]any) error {
	raw, err := json.Marshal(message)
	if err != nil {
		return err
	}
	c.writeMu.Lock()
	defer c.writeMu.Unlock()
	if _, err := c.stdin.Write(append(raw, '\n')); err != nil {
		return err
	}
	return nil
}

func (c *directACPClient) close() {
	_ = c.stdin.Close()
	c.closeTerminals()
	terminateProcess(c.cmd)
	select {
	case <-c.done:
	default:
		killProcess(c.cmd)
	}
}

type directACPTerminal struct {
	cmd             *exec.Cmd
	output          strings.Builder
	outputByteLimit int
	truncated       bool
	exitCode        *int
	signal          *string
	done            chan struct{}
	mu              sync.Mutex
}

func directACPAllowPermission(params any) map[string]any {
	options, _ := mapFromAny(params)["options"].([]any)
	for _, item := range options {
		option, _ := item.(map[string]any)
		kind := stringField(option, "kind")
		if strings.HasPrefix(kind, "allow") {
			if optionID := stringField(option, "optionId", "option_id", "id"); optionID != "" {
				return map[string]any{"outcome": map[string]any{"outcome": "selected", "optionId": optionID}}
			}
		}
	}
	return map[string]any{"outcome": map[string]any{"outcome": "cancelled"}}
}

func (c *directACPClient) readTextFile(params any) (map[string]any, error) {
	request := mapFromAny(params)
	target, err := c.resolveWorkspacePath(stringField(request, "path"))
	if err != nil {
		return nil, err
	}
	raw, err := os.ReadFile(target)
	if err != nil {
		return nil, err
	}
	content := string(raw)
	line := intField(request, "line")
	limit := intField(request, "limit")
	if line > 0 || limit > 0 {
		lines := strings.Split(content, "\n")
		start := max(line-1, 0)
		if start > len(lines) {
			start = len(lines)
		}
		end := len(lines)
		if limit > 0 && start+limit < end {
			end = start + limit
		}
		content = strings.Join(lines[start:end], "\n")
	}
	return map[string]any{"content": content}, nil
}

func (c *directACPClient) writeTextFile(params any) (map[string]any, error) {
	request := mapFromAny(params)
	target, err := c.resolveWorkspacePath(stringField(request, "path"))
	if err != nil {
		return nil, err
	}
	if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
		return nil, err
	}
	if err := os.WriteFile(target, []byte(stringField(request, "content")), 0o644); err != nil {
		return nil, err
	}
	return map[string]any{}, nil
}

func (c *directACPClient) resolveWorkspacePath(path string) (string, error) {
	if strings.TrimSpace(path) == "" {
		return "", errors.New("path is required")
	}
	if !filepath.IsAbs(path) {
		path = filepath.Join(c.workspace, path)
	}
	cleanWorkspace, err := filepath.Abs(c.workspace)
	if err != nil {
		return "", err
	}
	cleanTarget, err := filepath.Abs(path)
	if err != nil {
		return "", err
	}
	rel, err := filepath.Rel(cleanWorkspace, cleanTarget)
	if err != nil {
		return "", err
	}
	if rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return "", fmt.Errorf("path %q is outside workspace", cleanTarget)
	}
	return cleanTarget, nil
}

func (c *directACPClient) createTerminal(params any) (map[string]any, error) {
	request := mapFromAny(params)
	command := stringField(request, "command")
	if command == "" {
		return nil, errors.New("terminal command is required")
	}
	args := stringSliceField(request, "args")
	outputLimit := intField(request, "outputByteLimit", "output_byte_limit")
	if outputLimit <= 0 {
		outputLimit = 1024 * 1024
	}
	ctx := context.Background()
	cmd := exec.CommandContext(ctx, command, args...)
	if cwd := stringField(request, "cwd"); cwd != "" {
		resolved, err := c.resolveWorkspacePath(cwd)
		if err != nil {
			return nil, err
		}
		cmd.Dir = resolved
	} else {
		cmd.Dir = c.workspace
	}
	cmd.Env = mergeEnv(os.Environ(), envFromACP(request["env"]))
	setProcessGroup(cmd)
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
	id := fmt.Sprintf("term_%d", c.nextTerm.Add(1))
	terminal := &directACPTerminal{
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
	return map[string]any{"terminalId": id}, nil
}

func (c *directACPClient) terminalOutput(params any) (map[string]any, error) {
	terminal, err := c.lookupTerminal(params)
	if err != nil {
		return nil, err
	}
	terminal.mu.Lock()
	defer terminal.mu.Unlock()
	response := map[string]any{
		"output":    terminal.output.String(),
		"truncated": terminal.truncated,
	}
	if terminal.exitCode != nil || terminal.signal != nil {
		response["exitStatus"] = map[string]any{
			"exitCode": terminal.exitCode,
			"signal":   terminal.signal,
		}
	}
	return response, nil
}

func (c *directACPClient) waitForTerminalExit(params any) (map[string]any, error) {
	terminal, err := c.lookupTerminal(params)
	if err != nil {
		return nil, err
	}
	<-terminal.done
	terminal.mu.Lock()
	defer terminal.mu.Unlock()
	return map[string]any{
		"exitCode": terminal.exitCode,
		"signal":   terminal.signal,
	}, nil
}

func (c *directACPClient) killTerminal(params any) (map[string]any, error) {
	terminal, err := c.lookupTerminal(params)
	if err != nil {
		return nil, err
	}
	terminateProcess(terminal.cmd)
	return map[string]any{}, nil
}

func (c *directACPClient) releaseTerminal(params any) (map[string]any, error) {
	request := mapFromAny(params)
	id := stringField(request, "terminalId", "terminal_id")
	if id == "" {
		return nil, errors.New("terminalId is required")
	}
	if value, ok := c.terminals.LoadAndDelete(id); ok {
		terminal := value.(*directACPTerminal)
		select {
		case <-terminal.done:
		default:
			terminateProcess(terminal.cmd)
		}
	}
	return map[string]any{}, nil
}

func (c *directACPClient) lookupTerminal(params any) (*directACPTerminal, error) {
	request := mapFromAny(params)
	id := stringField(request, "terminalId", "terminal_id")
	if id == "" {
		return nil, errors.New("terminalId is required")
	}
	value, ok := c.terminals.Load(id)
	if !ok {
		return nil, fmt.Errorf("terminal not found: %s", id)
	}
	return value.(*directACPTerminal), nil
}

func (c *directACPClient) closeTerminals() {
	c.terminals.Range(func(key any, value any) bool {
		c.terminals.Delete(key)
		terminal := value.(*directACPTerminal)
		select {
		case <-terminal.done:
		default:
			terminateProcess(terminal.cmd)
		}
		return true
	})
}

func (t *directACPTerminal) scan(r io.Reader) {
	scanner := bufio.NewScanner(r)
	scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	for scanner.Scan() {
		t.appendOutput(scanner.Text() + "\n")
	}
}

func (t *directACPTerminal) appendOutput(text string) {
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

func directACPModelList(raw json.RawMessage) (string, directACPModelListEvent) {
	var msg map[string]any
	if err := json.Unmarshal(raw, &msg); err != nil {
		return "", directACPModelListEvent{}
	}
	result, _ := msg["result"].(map[string]any)
	if result == nil {
		result = msg
	}
	if models, ok := result["models"].(map[string]any); ok {
		return "", directACPModelListFromRecord(models)
	}
	configOptions, _ := result["configOptions"].([]any)
	if len(configOptions) == 0 {
		configOptions, _ = result["config_options"].([]any)
	}
	for _, item := range configOptions {
		option, _ := item.(map[string]any)
		category := strings.ToLower(stringField(option, "category"))
		id := stringField(option, "id", "configId", "config_id")
		if category != "model" && id != "model" {
			continue
		}
		list := directACPModelListFromRecord(option)
		return id, list
	}
	return "", directACPModelListEvent{}
}

func directACPCapabilitiesFromInitialize(raw json.RawMessage) directACPCapabilities {
	var msg map[string]any
	if err := json.Unmarshal(raw, &msg); err != nil {
		return directACPCapabilities{}
	}
	result, _ := msg["result"].(map[string]any)
	if result == nil {
		result = msg
	}
	caps, _ := result["agentCapabilities"].(map[string]any)
	if caps == nil {
		caps, _ = result["agent_capabilities"].(map[string]any)
	}
	sessionCaps, _ := caps["sessionCapabilities"].(map[string]any)
	if sessionCaps == nil {
		sessionCaps, _ = caps["session_capabilities"].(map[string]any)
	}
	return directACPCapabilities{
		List:   directACPCapabilityEnabled(sessionCaps["list"]),
		Load:   directACPCapabilityEnabled(caps["loadSession"]) || directACPCapabilityEnabled(caps["load_session"]),
		Resume: directACPCapabilityEnabled(sessionCaps["resume"]),
	}
}

func directACPCapabilityEnabled(value any) bool {
	switch v := value.(type) {
	case bool:
		return v
	case string:
		text := strings.TrimSpace(strings.ToLower(v))
		return text != "" && text != "false" && text != "0"
	case map[string]any:
		if enabled, ok := v["enabled"]; ok {
			return directACPCapabilityEnabled(enabled)
		}
		return true
	default:
		return value != nil
	}
}

func directACPConfigOptions(raw json.RawMessage) directACPConfigOptionsEvent {
	var msg map[string]any
	if err := json.Unmarshal(raw, &msg); err != nil {
		return directACPConfigOptionsEvent{}
	}
	result, _ := msg["result"].(map[string]any)
	if result == nil {
		result = msg
	}
	items, _ := result["configOptions"].([]any)
	if len(items) == 0 {
		items, _ = result["config_options"].([]any)
	}
	out := directACPConfigOptionsEvent{ConfigOptions: make([]map[string]any, 0, len(items))}
	for _, item := range items {
		option, _ := item.(map[string]any)
		if option == nil {
			continue
		}
		normalized := cloneMap(option)
		if id := stringField(normalized, "id", "configId", "config_id"); id != "" {
			normalized["id"] = id
		}
		if category := stringField(normalized, "category"); category != "" {
			normalized["category"] = strings.ToLower(category)
		}
		out.ConfigOptions = append(out.ConfigOptions, normalized)
	}
	return out
}

func directACPConfigIDs(options []map[string]any) map[string]string {
	out := make(map[string]string)
	for _, option := range options {
		id := stringField(option, "id", "configId", "config_id")
		if id == "" {
			continue
		}
		out[id] = id
		category := strings.ToLower(stringField(option, "category"))
		if category != "" && out[category] == "" {
			out[category] = id
		}
	}
	return out
}

func directACPModelListFromRecord(record map[string]any) directACPModelListEvent {
	options, _ := record["availableModels"].([]any)
	if len(options) == 0 {
		options, _ = record["available_models"].([]any)
	}
	if len(options) == 0 {
		options, _ = record["options"].([]any)
	}
	out := directACPModelListEvent{
		CurrentModelID: stringField(record, "currentModelId", "current_model_id", "currentValue", "current_value", "model"),
	}
	for _, item := range options {
		model := directACPModelOption(item)
		if model.ModelID != "" {
			out.AvailableModels = append(out.AvailableModels, model)
		}
	}
	if out.CurrentModelID == "" && len(out.AvailableModels) > 0 {
		out.CurrentModelID = out.AvailableModels[0].ModelID
	}
	return out
}

func directACPModelOption(value any) directACPModelListOption {
	if text, ok := value.(string); ok {
		id := strings.TrimSpace(text)
		return directACPModelListOption{ModelID: id, Name: id}
	}
	record, _ := value.(map[string]any)
	id := strings.TrimSpace(stringField(record, "modelId", "model_id", "id", "value", "name"))
	if id == "" {
		return directACPModelListOption{}
	}
	name := stringField(record, "name", "label")
	if name == "" {
		name = id
	}
	return directACPModelListOption{
		ModelID:     id,
		Name:        name,
		Description: stringField(record, "description"),
	}
}

func cloneMap(in map[string]any) map[string]any {
	out := make(map[string]any, len(in))
	for key, value := range in {
		out[key] = value
	}
	return out
}

func mapFromAny(value any) map[string]any {
	m, _ := value.(map[string]any)
	if m == nil {
		return map[string]any{}
	}
	return m
}

func intField(source map[string]any, keys ...string) int {
	for _, key := range keys {
		switch value := source[key].(type) {
		case int:
			return value
		case int64:
			return int(value)
		case float64:
			return int(value)
		case json.Number:
			n, _ := value.Int64()
			return int(n)
		}
	}
	return 0
}

func stringSliceField(source map[string]any, key string) []string {
	values, _ := source[key].([]any)
	if len(values) == 0 {
		return nil
	}
	out := make([]string, 0, len(values))
	for _, value := range values {
		if s, ok := value.(string); ok {
			out = append(out, s)
		}
	}
	return out
}

func envFromACP(value any) map[string]string {
	out := make(map[string]string)
	switch env := value.(type) {
	case []any:
		for _, item := range env {
			entry, _ := item.(map[string]any)
			name := stringField(entry, "name")
			if name != "" {
				out[name] = stringField(entry, "value")
			}
		}
	case map[string]any:
		for key, value := range env {
			if s, ok := value.(string); ok {
				out[key] = s
			}
		}
	}
	return out
}

func encodeJSONLine(message map[string]any) []byte {
	raw, _ := json.Marshal(message)
	return append(raw, '\n')
}

func readJSONLine(r *bufio.Reader) (map[string]any, error) {
	line, err := r.ReadBytes('\n')
	if err != nil {
		return nil, err
	}
	var msg map[string]any
	if err := json.Unmarshal(bytes.TrimSpace(line), &msg); err != nil {
		return nil, err
	}
	return msg, nil
}

func jsonRPCIDString(value any) (string, bool) {
	switch typed := value.(type) {
	case string:
		return typed, typed != ""
	case float64:
		return fmt.Sprint(int64(typed)), true
	default:
		return "", false
	}
}

func firstStringInJSON(raw json.RawMessage, keys ...string) string {
	var msg map[string]any
	if err := json.Unmarshal(raw, &msg); err != nil {
		return ""
	}
	if result, ok := msg["result"].(map[string]any); ok {
		for _, key := range keys {
			if value, _ := result[key].(string); value != "" {
				return value
			}
		}
	}
	for _, key := range keys {
		if value, _ := msg[key].(string); value != "" {
			return value
		}
	}
	return ""
}

func mergeEnv(base []string, extra map[string]string) []string {
	if len(extra) == 0 {
		return base
	}
	out := append([]string{}, base...)
	index := make(map[string]int)
	for i, item := range out {
		if key, _, ok := strings.Cut(item, "="); ok {
			index[key] = i
		}
	}
	for key, value := range extra {
		if i, ok := index[key]; ok {
			out[i] = key + "=" + value
		} else {
			out = append(out, key+"="+value)
		}
	}
	return out
}

func protocolNow() int64 {
	return time.Now().Unix()
}
