package daemon

import (
	"bufio"
	"bytes"
	"context"
	"crypto/sha1"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/creack/pty"
	"github.com/gorilla/websocket"

	"remote-agent/internal/hostinfo"
	"remote-agent/internal/protocol"
)

type Daemon struct {
	cfg Config

	mu             sync.Mutex
	tasks          map[string]*runningTask
	history        map[string]protocol.TaskRecord
	projects       map[string]protocol.Project
	projectStates  map[string]json.RawMessage
	send           chan protocol.Envelope
	sendBinary     chan []byte
	terminalBinary bool
	termMu         sync.Mutex
	terminalPTYs   map[string]*runningPTY
}

const (
	reconnectInitialDelay = time.Second
	reconnectMaxDelay     = 5 * time.Minute
	reconnectStableAfter  = 30 * time.Second
)

type runningTask struct {
	id        string
	cmd       *exec.Cmd
	cancel    context.CancelFunc
	done      chan struct{}
	workspace string
	acpx      bool
	agent     string
	session   string
	mu        sync.Mutex
	stopping  bool
}

func New(cfg Config) *Daemon {
	return &Daemon{
		cfg:           cfg,
		tasks:         make(map[string]*runningTask),
		history:       make(map[string]protocol.TaskRecord),
		projects:      make(map[string]protocol.Project),
		projectStates: make(map[string]json.RawMessage),
		send:          make(chan protocol.Envelope, 128),
		sendBinary:    make(chan []byte, 256),
		terminalPTYs:  make(map[string]*runningPTY),
	}
}

func (d *Daemon) Run(ctx context.Context) error {
	if _, err := ensurePocketStudioTmuxConfig(); err != nil {
		log.Printf("ensure tmux config: %v", err)
	}
	if err := d.loadProjectStore(); err != nil {
		log.Printf("load daemon projects: %v", err)
	}
	if err := d.loadProjectStates(); err != nil {
		log.Printf("load daemon project states: %v", err)
	}
	nextDelay := reconnectInitialDelay
	for {
		started := time.Now()
		if err := d.runOnce(ctx); err != nil {
			log.Printf("daemon connection closed: %v", err)
		}
		if ctx.Err() != nil {
			return ctx.Err()
		}
		var delay time.Duration
		delay, nextDelay = reconnectDelay(nextDelay, time.Since(started))
		log.Printf("daemon reconnecting in %s", delay)
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(delay):
		}
	}
}

func reconnectDelay(current time.Duration, connectedFor time.Duration) (time.Duration, time.Duration) {
	if connectedFor >= reconnectStableAfter {
		current = reconnectInitialDelay
	}
	delay := current
	return delay, nextReconnectDelay(delay)
}

func nextReconnectDelay(current time.Duration) time.Duration {
	if current < reconnectInitialDelay {
		return reconnectInitialDelay
	}
	next := current * 2
	if next < current || next > reconnectMaxDelay {
		return reconnectMaxDelay
	}
	return next
}

func (d *Daemon) runOnce(ctx context.Context) error {
	u, err := url.Parse(d.cfg.Server.URL)
	if err != nil {
		return err
	}
	header := http.Header{}
	if token := strings.TrimSpace(d.cfg.Server.Token); token != "" {
		header.Set("Authorization", "Bearer "+token)
	}
	conn, _, err := websocket.DefaultDialer.DialContext(ctx, u.String(), header)
	if err != nil {
		return err
	}
	defer conn.Close()
	enableTCPNoDelay(conn)
	connCtx, cancelConn := context.WithCancel(ctx)
	defer cancelConn()

	writeDone := make(chan error, 1)
	go func() {
		for {
			select {
			case <-connCtx.Done():
				writeDone <- connCtx.Err()
				return
			case raw := <-d.sendBinary:
				if err := conn.WriteMessage(websocket.BinaryMessage, raw); err != nil {
					writeDone <- err
					return
				}
			case env := <-d.send:
				if err := writeEnvelope(conn, env); err != nil {
					writeDone <- err
					return
				}
			}
		}
	}()

	d.sendHello()
	d.sendSnapshot()

	go func() {
		ticker := time.NewTicker(15 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-connCtx.Done():
				return
			case <-ticker.C:
				d.send <- protocol.NewEnvelope(protocol.TypeDaemonHeartbeat, "daemon", protocol.DaemonHeartbeat{
					DeviceID:       d.cfg.Device.ID,
					Status:         "online",
					RunningTaskIDs: d.runningTaskIDs(),
					DaemonVersion:  "0.1.0",
				})
			}
		}
	}()

	readErr := make(chan error, 1)
	go func() {
		for {
			msgType, raw, err := conn.ReadMessage()
			if err != nil {
				readErr <- err
				return
			}
			if msgType == websocket.BinaryMessage {
				streamData, ok, err := protocol.UnmarshalTerminalStreamDataBinary(raw)
				if err != nil {
					log.Printf("daemon received invalid terminal binary frame: %v", err)
					continue
				}
				if ok {
					d.writeTerminalStream(streamData)
					continue
				}
			}
			if msgType != websocket.TextMessage && msgType != websocket.BinaryMessage {
				continue
			}
			var env protocol.Envelope
			if err := json.Unmarshal(raw, &env); err != nil {
				log.Printf("daemon received invalid json frame: %v", err)
				continue
			}
			d.handleEnvelope(connCtx, env)
		}
	}()

	select {
	case err := <-readErr:
		return err
	case err := <-writeDone:
		return err
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (d *Daemon) agentName() string {
	if d.cfg.ACPX.Enabled {
		return d.cfg.ACPX.Agent
	}
	return "claude_code"
}

func daemonConfigDir() string {
	if dir := strings.TrimSpace(os.Getenv("POCKET_STUDIO_DAEMON_CONFIG_DIR")); dir != "" {
		return dir
	}
	if dir := strings.TrimSpace(os.Getenv("POCKET_STUDIO_CONFIG_DIR")); dir != "" {
		return dir
	}
	if dir, err := os.UserConfigDir(); err == nil && dir != "" {
		return filepath.Join(dir, "pocket-studio")
	}
	if home, err := os.UserHomeDir(); err == nil && home != "" {
		return filepath.Join(home, ".config", "pocket-studio")
	}
	return ".pocket-studio"
}

func daemonProjectsPath() string {
	return filepath.Join(daemonConfigDir(), "projects.json")
}

func daemonProjectStatesPath() string {
	return filepath.Join(daemonConfigDir(), "project-states.json")
}

func daemonWorkspaceProjectsPath() string {
	return filepath.Join(daemonConfigDir(), "workspace-projects.json")
}

func (d *Daemon) loadProjectStore() error {
	raw, err := os.ReadFile(daemonProjectsPath())
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil
		}
		return err
	}
	var projects []protocol.Project
	if err := json.Unmarshal(raw, &projects); err != nil {
		return err
	}
	d.mu.Lock()
	defer d.mu.Unlock()
	for _, project := range projects {
		if project.ID == "" || project.WorkspacePath == "" {
			continue
		}
		project.DeviceID = d.cfg.Device.ID
		if project.AgentIDs == nil {
			project.AgentIDs = []string{}
		}
		if project.TmuxIDs == nil {
			project.TmuxIDs = []string{}
		}
		if len(project.StudioState) > 0 {
			if _, exists := d.projectStates[project.ID]; !exists {
				d.projectStates[project.ID] = append(json.RawMessage(nil), project.StudioState...)
			}
		}
		d.projects[project.ID] = project
	}
	return nil
}

func (d *Daemon) saveProjectStoreLocked() error {
	projects := make([]protocol.Project, 0, len(d.projects))
	for _, project := range d.projects {
		project.DeviceID = d.cfg.Device.ID
		projects = append(projects, project)
	}
	sort.Slice(projects, func(i, j int) bool {
		return projects[i].Name < projects[j].Name
	})
	if err := os.MkdirAll(daemonConfigDir(), 0o755); err != nil {
		return err
	}
	raw, err := json.MarshalIndent(projects, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(daemonProjectsPath(), append(raw, '\n'), 0o600)
}

func (d *Daemon) loadProjectStates() error {
	raw, err := os.ReadFile(daemonProjectStatesPath())
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil
		}
		return err
	}
	var states map[string]json.RawMessage
	if err := json.Unmarshal(raw, &states); err != nil {
		return err
	}
	d.mu.Lock()
	defer d.mu.Unlock()
	for id, state := range states {
		if id == "" || len(state) == 0 {
			continue
		}
		d.projectStates[id] = append(json.RawMessage(nil), state...)
	}
	return nil
}

func loadWorkspaceProjectIDs() (map[string]string, error) {
	raw, err := os.ReadFile(daemonWorkspaceProjectsPath())
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return map[string]string{}, nil
		}
		return nil, err
	}
	var ids map[string]string
	if err := json.Unmarshal(raw, &ids); err != nil {
		return nil, err
	}
	if ids == nil {
		ids = map[string]string{}
	}
	return ids, nil
}

func saveWorkspaceProjectIDs(ids map[string]string) error {
	if err := os.MkdirAll(daemonConfigDir(), 0o755); err != nil {
		return err
	}
	raw, err := json.MarshalIndent(ids, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(daemonWorkspaceProjectsPath(), append(raw, '\n'), 0o600)
}

func canonicalProjectIDForWorkspace(workspacePath string) (string, error) {
	real, err := filepath.EvalSymlinks(workspacePath)
	if err != nil {
		real = workspacePath
	}
	real = filepath.Clean(real)
	ids, err := loadWorkspaceProjectIDs()
	if err != nil {
		return "", err
	}
	if id := strings.TrimSpace(ids[real]); id != "" {
		return id, nil
	}
	id := protocol.NewID("ws")
	ids[real] = id
	if err := saveWorkspaceProjectIDs(ids); err != nil {
		return "", err
	}
	return id, nil
}

func (d *Daemon) saveProjectStatesLocked() error {
	if err := os.MkdirAll(daemonConfigDir(), 0o755); err != nil {
		return err
	}
	raw, err := json.MarshalIndent(d.projectStates, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(daemonProjectStatesPath(), append(raw, '\n'), 0o600)
}

func (d *Daemon) workspacesSnapshot() []protocol.Workspace {
	d.mu.Lock()
	defer d.mu.Unlock()
	workspaces := make([]protocol.Workspace, 0, len(d.cfg.Workspaces)+len(d.projects))
	seen := make(map[string]bool)
	for _, workspace := range d.cfg.Workspaces {
		if workspace.Path == "" {
			continue
		}
		workspace.ID = d.projectIDForWorkspacePath(workspace.Path)
		workspaces = append(workspaces, workspace)
		seen[workspace.Path] = true
	}
	for _, project := range d.projects {
		if project.WorkspacePath == "" || seen[project.WorkspacePath] {
			continue
		}
		workspaces = append(workspaces, protocol.Workspace{
			ID:   d.projectIDForWorkspacePath(project.WorkspacePath),
			Name: project.Name,
			Path: project.WorkspacePath,
		})
		seen[project.WorkspacePath] = true
	}
	return workspaces
}

func (d *Daemon) agentLabel() string {
	return agentDisplayName(d.agentName())
}

func (d *Daemon) agentCapabilities() []protocol.AgentCapability {
	if !d.cfg.ACPX.Enabled {
		if _, err := exec.LookPath(d.cfg.Claude.Command); err == nil {
			return []protocol.AgentCapability{{Name: "claude_code", Label: "Claude Code"}}
		}
		return nil
	}
	names := []string{
		"codex",
		"claude",
		"gemini",
		"cursor",
		"copilot",
		"qwen",
		"opencode",
		"openclaw",
		"pi",
		"droid",
		"iflow",
		"kilocode",
		"kimi",
		"kiro",
		"qoder",
		"trae",
	}
	caps := make([]protocol.AgentCapability, 0, len(names))
	preferred := strings.ToLower(strings.TrimSpace(d.cfg.ACPX.Agent))
	if preferred != "" && installedAgentCommand(preferred) != "" {
		caps = append(caps, protocol.AgentCapability{Name: preferred, Label: agentDisplayName(preferred)})
	}
	for _, name := range names {
		if name == preferred {
			continue
		}
		if installedAgentCommand(name) == "" {
			continue
		}
		caps = append(caps, protocol.AgentCapability{Name: name, Label: agentDisplayName(name)})
	}
	return caps
}

func installedAgentCommand(agent string) string {
	switch strings.ToLower(strings.TrimSpace(agent)) {
	case "claude", "claude_code", "claude-code":
		return lookPathAny("claude")
	case "codex":
		return lookPathAny("codex")
	case "gemini":
		return lookPathAny("gemini")
	case "cursor":
		return lookPathAny("cursor-agent", "cursor")
	case "copilot":
		return lookPathAny("copilot")
	case "qwen":
		return lookPathAny("qwen")
	case "opencode":
		return lookPathAny("opencode")
	case "openclaw":
		return lookPathAny("openclaw")
	case "pi":
		return lookPathAny("pi")
	case "droid":
		return lookPathAny("droid", "factory-droid")
	case "iflow":
		return lookPathAny("iflow")
	case "kilocode":
		return lookPathAny("kilocode")
	case "kimi":
		return lookPathAny("kimi")
	case "kiro":
		return lookPathAny("kiro")
	case "qoder":
		return lookPathAny("qoder")
	case "trae":
		return lookPathAny("trae")
	default:
		return ""
	}
}

func lookPathAny(names ...string) string {
	for _, name := range names {
		if path, err := exec.LookPath(name); err == nil {
			return path
		}
	}
	return ""
}

func agentDisplayName(agent string) string {
	switch strings.ToLower(strings.TrimSpace(agent)) {
	case "claude", "claude_code", "claude-code":
		return "Claude Code"
	case "codex":
		return "Codex"
	case "gemini":
		return "Gemini"
	case "cursor":
		return "Cursor Agent"
	case "copilot":
		return "GitHub Copilot"
	case "openclaw":
		return "OpenClaw"
	case "pi":
		return "Pi"
	case "droid", "factory-droid", "factorydroid":
		return "Factory Droid"
	case "qwen":
		return "Qwen Code"
	case "opencode":
		return "OpenCode"
	case "iflow":
		return "iFlow"
	case "kilocode":
		return "Kilo Code"
	case "kimi":
		return "Kimi"
	case "kiro":
		return "Kiro"
	case "qoder":
		return "Qoder"
	case "trae":
		return "Trae"
	default:
		if agent == "" {
			return "Agent"
		}
		return agent
	}
}

func (d *Daemon) handleEnvelope(ctx context.Context, env protocol.Envelope) {
	switch env.Type {
	case protocol.TypeServerHello:
		hello, err := protocol.DecodePayload[protocol.ServerHello](env)
		if err != nil {
			return
		}
		d.mu.Lock()
		d.terminalBinary = hasFeature(hello.Features, protocol.FeatureTerminalBinaryV1)
		d.mu.Unlock()
	case protocol.TypeSessionCreate:
		session, err := protocol.DecodePayload[protocol.SessionCreate](env)
		if err != nil {
			d.emitError("", "bad_payload", err.Error())
			return
		}
		go d.createSession(ctx, session)
	case protocol.TypeTaskDispatch:
		task, err := protocol.DecodePayload[protocol.TaskDispatch](env)
		if err != nil {
			d.emitError("", "bad_payload", err.Error())
			return
		}
		go d.startTask(ctx, task)
	case protocol.TypeTaskStop:
		stop, err := protocol.DecodePayload[protocol.TaskStop](env)
		if err != nil {
			d.emitError("", "bad_payload", err.Error())
			return
		}
		d.stopTask(stop.TaskID)
	case protocol.TypeTaskSetModel:
		change, err := protocol.DecodePayload[protocol.TaskSetModel](env)
		if err != nil {
			d.emitError("", "bad_payload", err.Error())
			return
		}
		go d.setTaskModel(ctx, change)
	case protocol.TypeSessionDelete:
		remove, err := protocol.DecodePayload[protocol.SessionDelete](env)
		if err != nil {
			d.emitError("", "bad_payload", err.Error())
			return
		}
		go d.deleteSession(ctx, remove)
	case protocol.TypeWorkspaceList:
		request, err := protocol.DecodePayload[protocol.WorkspaceListRequest](env)
		if err != nil {
			d.sendWorkspaceError("", err.Error())
			return
		}
		go d.listWorkspace(request)
	case protocol.TypeWorkspaceRead:
		request, err := protocol.DecodePayload[protocol.WorkspaceReadRequest](env)
		if err != nil {
			d.sendWorkspaceError("", err.Error())
			return
		}
		go d.readWorkspaceFile(request)
	case protocol.TypeWorkspaceWrite:
		request, err := protocol.DecodePayload[protocol.WorkspaceWriteRequest](env)
		if err != nil {
			d.sendWorkspaceError("", err.Error())
			return
		}
		go d.writeWorkspaceFile(request)
	case protocol.TypeProjectCreate:
		request, err := protocol.DecodePayload[protocol.ProjectCreateRequest](env)
		if err != nil {
			d.sendProjectError("", err.Error())
			return
		}
		go d.createProject(request)
	case protocol.TypeProjectStateGet:
		request, err := protocol.DecodePayload[protocol.ProjectStateGetRequest](env)
		if err != nil {
			d.sendProjectError("", err.Error())
			return
		}
		go d.getProjectState(request)
	case protocol.TypeProjectStateSet:
		request, err := protocol.DecodePayload[protocol.ProjectStateSetRequest](env)
		if err != nil {
			d.sendProjectError("", err.Error())
			return
		}
		go d.setProjectState(request)
	case protocol.TypeTerminalRun:
		request, err := protocol.DecodePayload[protocol.TerminalRunRequest](env)
		if err != nil {
			d.sendTerminalError("", "", err.Error())
			return
		}
		go d.runTerminalCommand(ctx, request)
	case protocol.TypeTerminalStreamStart:
		request, err := protocol.DecodePayload[protocol.TerminalStreamStart](env)
		if err == nil {
			go d.startTerminalStream(ctx, request)
		}
	case protocol.TypeTerminalStreamData:
		request, err := protocol.DecodePayload[protocol.TerminalStreamData](env)
		if err == nil {
			d.writeTerminalStream(request)
		}
	case protocol.TypeTerminalStreamResize:
		request, err := protocol.DecodePayload[protocol.TerminalStreamResize](env)
		if err == nil {
			d.resizeTerminalStream(request)
		}
	case protocol.TypeTerminalStreamExit:
		request, err := protocol.DecodePayload[protocol.TerminalStreamExit](env)
		if err == nil {
			d.exitTerminalStream(request)
		}
	}
}

func (d *Daemon) createSession(parent context.Context, session protocol.SessionCreate) {
	if session.TaskID == "" {
		session.TaskID = protocol.NewID("tsk")
	}
	workspace, err := d.resolveWorkspacePath(session.WorkspaceID, session.WorkspacePath)
	if err != nil {
		d.emitError(session.TaskID, "workspace_denied", err.Error())
		return
	}
	if !d.supportsTaskAgent(session.Agent) {
		d.emitError(session.TaskID, "unsupported_agent", "unsupported agent")
		return
	}
	task := protocol.TaskDispatch{
		TaskID:        session.TaskID,
		WorkspaceID:   workspace.ID,
		WorkspacePath: workspace.Path,
		Agent:         session.Agent,
		SessionName:   session.SessionName,
		Options:       session.Options,
	}
	ctx, cancel := context.WithCancel(parent)
	defer cancel()
	if d.cfg.ACPX.Enabled {
		if err := d.createACPXSession(ctx, task, workspace.Path, session.TaskID); err != nil {
			d.emitError(session.TaskID, "session_ensure_failed", err.Error())
			return
		}
	}
	now := time.Now().Unix()
	d.mu.Lock()
	record := d.history[session.TaskID]
	if record.TaskID == "" {
		record.TaskID = session.TaskID
		record.StartedAt = now
	}
	record.WorkspaceID = workspace.ID
	record.WorkspacePath = workspace.Path
	record.DeviceID = d.cfg.Device.ID
	record.Agent = taskAgentName(task, d.cfg.ACPX.Agent)
	record.SessionName = taskSessionName(task, d.cfg.ACPX.SessionName)
	record.Status = "created"
	record.UpdatedAt = now
	d.history[session.TaskID] = record
	d.mu.Unlock()
	d.emitTaskEvent(session.TaskID, "session.created", 0, map[string]any{
		"workspace":    workspace.Path,
		"agent":        record.Agent,
		"session_name": record.SessionName,
	}, nil)
}

func (d *Daemon) startTask(parent context.Context, task protocol.TaskDispatch) {
	if task.TaskID == "" {
		task.TaskID = protocol.NewID("tsk")
	}
	workspace, err := d.resolveWorkspacePath(task.WorkspaceID, task.WorkspacePath)
	if err != nil {
		d.emitError(task.TaskID, "workspace_denied", err.Error())
		return
	}
	if !d.supportsTaskAgent(task.Agent) {
		d.emitError(task.TaskID, "unsupported_agent", "unsupported agent")
		return
	}

	ctx, cancel := context.WithCancel(parent)
	command, args, source := d.buildAgentCommand(task, workspace.Path)
	if d.cfg.ACPX.Enabled {
		if err := d.ensureACPXSession(ctx, task, workspace.Path, task.TaskID); err != nil {
			cancel()
			d.emitError(task.TaskID, "session_ensure_failed", err.Error())
			return
		}
	}

	cmd := exec.CommandContext(ctx, command, args...)
	cmd.Dir = workspace.Path
	setProcessGroup(cmd)

	stdout, err := cmd.StdoutPipe()
	if err != nil {
		cancel()
		d.emitError(task.TaskID, "stdout_pipe_failed", err.Error())
		return
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		cancel()
		d.emitError(task.TaskID, "stderr_pipe_failed", err.Error())
		return
	}
	if err := cmd.Start(); err != nil {
		cancel()
		d.emitError(task.TaskID, "start_failed", err.Error())
		return
	}

	rt := &runningTask{
		id:        task.TaskID,
		cmd:       cmd,
		cancel:    cancel,
		done:      make(chan struct{}),
		workspace: workspace.Path,
		acpx:      d.cfg.ACPX.Enabled,
		agent:     taskAgentName(task, d.cfg.ACPX.Agent),
		session:   taskSessionName(task, d.cfg.ACPX.SessionName),
	}
	d.mu.Lock()
	d.tasks[task.TaskID] = rt
	now := time.Now().Unix()
	record := d.history[task.TaskID]
	if record.TaskID == "" {
		record.TaskID = task.TaskID
		record.StartedAt = now
	}
	record.WorkspaceID = workspace.ID
	record.WorkspacePath = workspace.Path
	record.DeviceID = d.cfg.Device.ID
	record.Prompt = task.Prompt
	record.ParentTaskID = task.ParentTaskID
	if task.ResumeSessionID != "" {
		record.SessionID = task.ResumeSessionID
	}
	record.Agent = taskAgentName(task, d.cfg.ACPX.Agent)
	record.SessionName = taskSessionName(task, d.cfg.ACPX.SessionName)
	if task.ModelID != "" {
		record.ModelID = task.ModelID
	}
	record.Status = "running"
	record.UpdatedAt = now
	d.history[task.TaskID] = record
	d.mu.Unlock()

	emitter := &taskEmitter{daemon: d, taskID: task.TaskID}
	emitter.emit("task.started", map[string]any{
		"workspace": workspace.Path,
		"command":   command,
		"args":      args,
		"agent":     source,
	}, nil)

	var wg sync.WaitGroup
	wg.Add(2)
	go func() {
		defer wg.Done()
		d.scanOutput(stdout, "stdout", emitter)
	}()
	go func() {
		defer wg.Done()
		d.scanTextOutput(stderr, "stderr", emitter)
	}()

	waitErr := cmd.Wait()
	wg.Wait()
	close(rt.done)
	cancel()

	d.mu.Lock()
	delete(d.tasks, task.TaskID)
	d.mu.Unlock()

	if waitErr != nil {
		if rt.isStopping() {
			emitter.emit("task.killed", map[string]any{"reason": "user_requested"}, nil)
			return
		}
		if emitter.completedNormally() {
			emitter.emit("task.completed", map[string]any{"exit_code": exitCodeFromError(waitErr), "stop_reason": "end_turn"}, nil)
			return
		}
		emitter.emit("task.failed", map[string]any{"error": waitErr.Error()}, nil)
		return
	}
	emitter.emit("task.completed", map[string]any{"exit_code": 0}, nil)
}

func (d *Daemon) supportsTaskAgent(agent string) bool {
	agent = strings.ToLower(strings.TrimSpace(agent))
	if agent == "" || agent == "acpx" {
		return true
	}
	if d.cfg.ACPX.Enabled {
		return isKnownACPXAgent(agent) && installedAgentCommand(agent) != ""
	}
	return agent == "claude_code" || agent == "claude" || agent == "claude-code"
}

func taskAgentName(task protocol.TaskDispatch, fallback string) string {
	agent := strings.ToLower(strings.TrimSpace(task.Agent))
	if agent == "" || agent == "acpx" {
		agent = strings.ToLower(strings.TrimSpace(fallback))
	}
	if agent == "" {
		return "claude"
	}
	if agent == "claude_code" || agent == "claude-code" {
		return "claude"
	}
	return agent
}

func taskSessionName(task protocol.TaskDispatch, fallback string) string {
	if sessionName := strings.TrimSpace(task.SessionName); sessionName != "" {
		return sessionName
	}
	return strings.TrimSpace(fallback)
}

func isKnownACPXAgent(agent string) bool {
	switch agent {
	case "claude_code", "claude-code":
		agent = "claude"
	}
	switch agent {
	case "codex", "claude", "gemini", "cursor", "copilot", "qwen", "opencode", "openclaw", "pi", "droid", "iflow", "kilocode", "kimi", "kiro", "qoder", "trae":
		return true
	default:
		return false
	}
}

func (d *Daemon) buildClaudeArgs(task protocol.TaskDispatch) []string {
	args := append([]string{}, d.cfg.Claude.Args...)
	if len(args) == 0 {
		args = append(args, "--output-format", "stream-json")
	}
	args = ensureClaudeStreamJSONVerbose(args)
	if task.ResumeSessionID != "" {
		args = append(args, "--resume", task.ResumeSessionID)
	}
	args = append(args, "-p", task.Prompt)
	if len(task.Options.AllowedTools) > 0 {
		allowedTools := allowedToolsForTask(task)
		if len(allowedTools) > 0 {
			args = append(args, "--allowedTools", strings.Join(allowedTools, ","))
		}
	}
	return args
}

func (d *Daemon) buildAgentCommand(task protocol.TaskDispatch, workspacePath string) (string, []string, string) {
	if d.cfg.ACPX.Enabled {
		agent := taskAgentName(task, d.cfg.ACPX.Agent)
		return d.cfg.ACPX.Command, d.buildACPXPromptArgs(task, workspacePath), agent
	}
	return d.cfg.Claude.Command, d.buildClaudeArgs(task), "claude_code"
}

func (d *Daemon) buildACPXPromptArgs(task protocol.TaskDispatch, workspacePath string) []string {
	args := d.buildACPXPromptGlobalArgs(task, workspacePath)
	args = append(args, taskAgentName(task, d.cfg.ACPX.Agent))
	if sessionName := taskSessionName(task, d.cfg.ACPX.SessionName); sessionName != "" {
		args = append(args, "-s", sessionName)
	}
	args = append(args, task.Prompt)
	return args
}

func (d *Daemon) buildACPXSessionArgs(task protocol.TaskDispatch, workspacePath string, command string) []string {
	args := d.buildACPXGlobalArgs(workspacePath)
	args = append(args, taskAgentName(task, d.cfg.ACPX.Agent), "sessions", command)
	if sessionName := taskSessionName(task, d.cfg.ACPX.SessionName); sessionName != "" {
		args = append(args, "--name", sessionName)
	}
	return args
}

func (d *Daemon) buildACPXSessionListArgs(workspacePath string, agent string) []string {
	args := d.buildACPXGlobalArgs(workspacePath)
	args = append(args, agent, "sessions", "list", "--local")
	return args
}

func (d *Daemon) buildACPXCancelArgs(workspacePath string, agent string, sessionName string) []string {
	args := d.buildACPXGlobalArgs(workspacePath)
	args = append(args, agent, "cancel")
	if sessionName != "" {
		args = append(args, "-s", sessionName)
	}
	return args
}

func (d *Daemon) buildACPXSessionCloseArgs(workspacePath string, agent string, sessionName string) []string {
	args := d.buildACPXGlobalArgs(workspacePath)
	args = append(args, agent, "sessions", "close")
	if sessionName != "" {
		args = append(args, sessionName)
	}
	return args
}

func (d *Daemon) buildACPXSetModelArgs(workspacePath string, agent string, sessionName string, modelID string) []string {
	args := d.buildACPXGlobalArgs(workspacePath)
	args = append(args, agent, "set", "model", modelID)
	if sessionName != "" {
		args = append(args, "-s", sessionName)
	}
	return args
}

func (d *Daemon) buildACPXGlobalArgs(workspacePath string) []string {
	args := append([]string{}, d.cfg.ACPX.Args...)
	args = ensureACPXApproveAll(args)
	args = ensureACPXJSONFormat(args)
	args = d.ensureACPXTtl(args)
	args = append(args, "--cwd", workspacePath)
	return args
}

func (d *Daemon) buildACPXPromptGlobalArgs(task protocol.TaskDispatch, workspacePath string) []string {
	args := append([]string{}, d.cfg.ACPX.Args...)
	args = ensureACPXApproveAll(args)
	args = ensureACPXJSONFormat(args)
	args = d.ensureACPXTtl(args)
	args = ensureACPXModel(args, task.ModelID)
	args = append(args, "--cwd", workspacePath)
	return args
}

func (d *Daemon) ensureACPXTtl(args []string) []string {
	if d.cfg.ACPX.TTLSeconds == 0 {
		return args
	}
	for i, arg := range args {
		if arg == "--ttl" && i+1 < len(args) {
			return args
		}
		if strings.HasPrefix(arg, "--ttl=") {
			return args
		}
	}
	return append(args, "--ttl", fmt.Sprint(d.cfg.ACPX.TTLSeconds))
}

func ensureACPXJSONFormat(args []string) []string {
	for i, arg := range args {
		if arg == "--format" && i+1 < len(args) {
			return args
		}
		if strings.HasPrefix(arg, "--format=") {
			return args
		}
	}
	return append([]string{"--format", "json"}, args...)
}

func ensureACPXModel(args []string, modelID string) []string {
	modelID = strings.TrimSpace(modelID)
	if modelID == "" {
		return args
	}
	for i, arg := range args {
		if arg == "--model" && i+1 < len(args) {
			return args
		}
		if strings.HasPrefix(arg, "--model=") {
			return args
		}
	}
	return append(args, "--model", modelID)
}

func ensureACPXApproveAll(args []string) []string {
	next := args[:0]
	skipNext := false
	for _, arg := range args {
		if skipNext {
			skipNext = false
			continue
		}
		switch arg {
		case "--approve-all", "--approve-reads", "--deny-all", "--permission-policy", "--policy":
			if arg == "--permission-policy" || arg == "--policy" {
				skipNext = true
			}
			continue
		default:
			if strings.HasPrefix(arg, "--permission-policy=") || strings.HasPrefix(arg, "--policy=") {
				continue
			}
			next = append(next, arg)
		}
	}
	return append(next, "--approve-all")
}

func ensureClaudeStreamJSONVerbose(args []string) []string {
	hasStreamJSON := false
	hasVerbose := false
	for i, arg := range args {
		if arg == "--verbose" {
			hasVerbose = true
		}
		if arg == "--output-format" && i+1 < len(args) && args[i+1] == "stream-json" {
			hasStreamJSON = true
		}
		if strings.HasPrefix(arg, "--output-format=") && strings.TrimPrefix(arg, "--output-format=") == "stream-json" {
			hasStreamJSON = true
		}
	}
	if hasStreamJSON && !hasVerbose {
		args = append(args, "--verbose")
	}
	return args
}

func allowedToolsForTask(task protocol.TaskDispatch) []string {
	tools := make([]string, 0, len(task.Options.AllowedTools))
	for _, tool := range task.Options.AllowedTools {
		normalized := strings.ToLower(strings.TrimSpace(tool))
		if normalized == "" {
			continue
		}
		if !task.Options.AutoShell && (normalized == "bash" || normalized == "shell") {
			continue
		}
		tools = append(tools, tool)
	}
	return tools
}

type taskEmitter struct {
	mu       sync.Mutex
	sequence int64
	daemon   *Daemon
	taskID   string
	endTurn  bool
}

func (e *taskEmitter) emit(eventType string, data any, raw json.RawMessage) {
	e.mu.Lock()
	e.sequence++
	sequence := e.sequence
	e.mu.Unlock()
	e.daemon.emitTaskEvent(e.taskID, eventType, sequence, data, raw)
}

func (e *taskEmitter) markEndTurn() {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.endTurn = true
}

func (e *taskEmitter) completedNormally() bool {
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.endTurn
}

func (d *Daemon) scanOutput(r io.Reader, stream string, emitter *taskEmitter) {
	scanner := bufio.NewScanner(r)
	scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	adapter := newAgentOutputAdapter(emitter)
	defer adapter.flush()
	for scanner.Scan() {
		line := scanner.Bytes()
		var raw json.RawMessage
		if json.Valid(line) {
			raw = append(raw, line...)
			adapter.handle(raw)
			continue
		}
		adapter.flush()
		emitter.emit("tool.output", map[string]string{
			"stream": stream,
			"text":   string(line),
		}, nil)
	}
}

func (d *Daemon) ensureACPXSession(ctx context.Context, task protocol.TaskDispatch, workspacePath string, taskID string) error {
	return d.syncACPXSession(ctx, task, workspacePath, taskID, "ensure")
}

func (d *Daemon) createACPXSession(ctx context.Context, task protocol.TaskDispatch, workspacePath string, taskID string) error {
	return d.syncACPXSession(ctx, task, workspacePath, taskID, "new")
}

func (d *Daemon) syncACPXSession(ctx context.Context, task protocol.TaskDispatch, workspacePath string, taskID string, command string) error {
	args := d.buildACPXSessionArgs(task, workspacePath, command)
	cmd := exec.CommandContext(ctx, d.cfg.ACPX.Command, args...)
	cmd.Dir = workspacePath
	var stdout bytes.Buffer
	var stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	err := cmd.Run()
	if err != nil {
		text := strings.TrimSpace(stderr.String())
		if text == "" {
			text = strings.TrimSpace(stdout.String())
		}
		if text == "" {
			text = err.Error()
		}
		return fmt.Errorf("%s: %s", err, text)
	}
	var raw json.RawMessage
	output := bytes.TrimSpace(stdout.Bytes())
	if json.Valid(output) {
		raw = append(raw, output...)
		data := map[string]any{
			"agent":        taskAgentName(task, d.cfg.ACPX.Agent),
			"session_name": taskSessionName(task, d.cfg.ACPX.SessionName),
		}
		var session map[string]any
		if err := json.Unmarshal(raw, &session); err == nil {
			for _, key := range []string{"acpxRecordId", "acpxSessionId", "agentSessionId", "name"} {
				if value, ok := session[key]; ok {
					data[key] = value
				}
			}
		}
		d.emitTaskEvent(taskID, "acpx.session", 0, data, raw)
	}
	d.emitACPXStatus(ctx, task, workspacePath, taskID)
	return nil
}

func (d *Daemon) emitACPXStatus(ctx context.Context, task protocol.TaskDispatch, workspacePath string, taskID string) {
	args := d.buildACPXGlobalArgs(workspacePath)
	args = append(args, taskAgentName(task, d.cfg.ACPX.Agent), "status")
	if sessionName := taskSessionName(task, d.cfg.ACPX.SessionName); sessionName != "" {
		args = append(args, "-s", sessionName)
	}
	statusCtx, cancel := context.WithTimeout(ctx, 8*time.Second)
	defer cancel()
	cmd := exec.CommandContext(statusCtx, d.cfg.ACPX.Command, args...)
	cmd.Dir = workspacePath
	var stdout bytes.Buffer
	var stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		d.emitTaskEvent(taskID, "acpx.status_failed", 0, map[string]string{
			"error": strings.TrimSpace(stderr.String()),
		}, nil)
		return
	}
	raw := bytes.TrimSpace(stdout.Bytes())
	data := map[string]any{
		"ttl_seconds": d.cfg.ACPX.TTLSeconds,
		"agent":       taskAgentName(task, d.cfg.ACPX.Agent),
		"session":     taskSessionName(task, d.cfg.ACPX.SessionName),
	}
	if json.Valid(raw) {
		var status map[string]any
		if err := json.Unmarshal(raw, &status); err == nil {
			for key, value := range status {
				data[key] = value
			}
		}
		d.emitTaskEvent(taskID, "acpx.status", 0, data, append(json.RawMessage(nil), raw...))
		return
	}
	text := strings.TrimSpace(stdout.String())
	if text != "" {
		data["text"] = text
	}
	d.emitTaskEvent(taskID, "acpx.status", 0, data, nil)
}

func (d *Daemon) scanTextOutput(r io.Reader, stream string, emitter *taskEmitter) {
	scanner := bufio.NewScanner(r)
	scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	for scanner.Scan() {
		text := scanner.Text()
		if d.cfg.ACPX.Enabled && isACPXStatusLine(text) {
			emitter.emit("acpx.raw", map[string]string{
				"stream": stream,
				"text":   text,
			}, nil)
			continue
		}
		emitter.emit("tool.output", map[string]string{
			"stream": stream,
			"text":   text,
		}, nil)
	}
}

func isACPXStatusLine(text string) bool {
	return strings.HasPrefix(strings.TrimSpace(text), "[acpx] ")
}

type agentOutputAdapter struct {
	emitter         *taskEmitter
	assistantText   strings.Builder
	assistantRaw    json.RawMessage
	thinkingText    strings.Builder
	thinkingRaw     json.RawMessage
	toolRawByID     map[string]json.RawMessage
	toolNameByID    map[string]string
	toolInputByID   map[string]any
	toolStatusByID  map[string]string
	toolEmittedByID map[string]bool
}

func newAgentOutputAdapter(emitter *taskEmitter) *agentOutputAdapter {
	return &agentOutputAdapter{
		emitter:         emitter,
		toolRawByID:     make(map[string]json.RawMessage),
		toolNameByID:    make(map[string]string),
		toolInputByID:   make(map[string]any),
		toolStatusByID:  make(map[string]string),
		toolEmittedByID: make(map[string]bool),
	}
}

func (a *agentOutputAdapter) handle(raw json.RawMessage) {
	if a.handleACPXJSONRPC(raw) {
		return
	}
	a.flush()
	a.emitter.emit(classifyClaudeEvent(raw), nil, raw)
}

func (a *agentOutputAdapter) flush() {
	a.flushThinking()
	a.flushAssistant()
}

func (a *agentOutputAdapter) flushAssistant() {
	if a.assistantText.Len() == 0 {
		return
	}
	text := a.assistantText.String()
	raw := a.assistantRaw
	a.assistantText.Reset()
	a.assistantRaw = nil
	a.emitter.emit("assistant.message", map[string]string{"text": text}, raw)
}

func (a *agentOutputAdapter) flushThinking() {
	text := strings.TrimSpace(a.thinkingText.String())
	if text == "" {
		a.thinkingText.Reset()
		a.thinkingRaw = nil
		return
	}
	raw := a.thinkingRaw
	a.thinkingText.Reset()
	a.thinkingRaw = nil
	a.emitter.emit("assistant.thinking", map[string]string{"text": text}, raw)
}

func (a *agentOutputAdapter) handleACPXJSONRPC(raw json.RawMessage) bool {
	var msg map[string]any
	if err := json.Unmarshal(raw, &msg); err != nil {
		return false
	}
	if msg["jsonrpc"] != "2.0" {
		return false
	}
	method, _ := msg["method"].(string)
	if method != "session/update" {
		if method == "session/request_permission" {
			a.flush()
			a.emitter.emit("permission.request", nil, raw)
			return true
		}
		if _, ok := msg["result"]; ok {
			if result, _ := msg["result"].(map[string]any); stringField(result, "stopReason") == "end_turn" {
				a.emitter.markEndTurn()
			}
			a.flush()
			if hasAvailableModels(msg) {
				a.emitter.emit("model.list", nil, raw)
				return true
			}
			a.emitter.emit("metric.updated", nil, raw)
		}
		return true
	}
	params, _ := msg["params"].(map[string]any)
	update, _ := params["update"].(map[string]any)
	updateType, _ := update["sessionUpdate"].(string)
	switch updateType {
	case "agent_message_chunk":
		a.flushThinking()
		a.appendAssistantChunk(update, raw)
	case "agent_thought_chunk":
		a.appendThinkingChunk(update, raw)
	case "available_commands_update":
		a.flush()
		a.emitter.emit("commands.updated", nil, raw)
	case "current_mode_update":
		a.flush()
		a.emitter.emit("mode.updated", nil, raw)
	case "user_message_chunk", "config_option_update", "session_info_update":
		a.flush()
		a.emitter.emit("acpx.raw", nil, raw)
	case "usage_update":
		a.flush()
		a.emitter.emit("metric.updated", nil, raw)
	case "tool_call", "tool_call_update":
		a.flush()
		a.emitToolUpdate(update, raw)
	default:
		a.flush()
		a.emitter.emit("acpx.raw", nil, raw)
	}
	return true
}

func (a *agentOutputAdapter) appendAssistantChunk(update map[string]any, raw json.RawMessage) {
	text := textFromACPXContent(update["content"])
	if text == "" {
		return
	}
	a.assistantText.WriteString(text)
	a.assistantRaw = raw
}

func (a *agentOutputAdapter) appendThinkingChunk(update map[string]any, raw json.RawMessage) {
	text := textFromACPXContent(update["content"])
	if text == "" {
		return
	}
	a.thinkingText.WriteString(text)
	a.thinkingRaw = raw
}

func (a *agentOutputAdapter) emitToolUpdate(update map[string]any, raw json.RawMessage) {
	id := stringField(update, "toolCallId", "tool_call_id", "id")
	if id == "" {
		id = protocol.NewID("tool")
	}
	if name := stringField(update, "title", "kind", "name"); name != "" {
		a.toolNameByID[id] = name
	}
	if status := stringField(update, "status"); status != "" {
		a.toolStatusByID[id] = status
	}
	if input, ok := update["rawInput"]; ok {
		a.toolInputByID[id] = input
	}
	if !a.toolEmittedByID[id] {
		a.emitNormalizedToolCall(id)
	}
	if hasAnyKey(update, "rawOutput", "status") {
		if !hasAnyKey(update, "rawOutput") && strings.EqualFold(stringField(update, "status"), "pending") {
			a.emitter.emit("acpx.raw", nil, raw)
			return
		}
		result := map[string]any{
			"tool_use_id": id,
			"type":        "tool_result",
			"content":     acpxToolOutput(update),
			"is_error":    statusIndicatesError(stringField(update, "status")),
		}
		normalized := map[string]any{
			"type": "user",
			"message": map[string]any{
				"role":    "user",
				"content": []any{result},
			},
		}
		a.emitter.emit("tool.output", nil, mustJSON(normalized))
		return
	}
	a.toolRawByID[id] = raw
}

func (a *agentOutputAdapter) emitNormalizedToolCall(id string) {
	a.toolEmittedByID[id] = true
	call := map[string]any{
		"type":   "tool_use",
		"id":     id,
		"name":   valueOrDefault(a.toolNameByID[id], "tool_call"),
		"status": valueOrDefault(a.toolStatusByID[id], "pending"),
		"input":  valueOrDefaultAny(a.toolInputByID[id], map[string]any{}),
	}
	normalized := map[string]any{
		"type": "assistant",
		"message": map[string]any{
			"role":    "assistant",
			"content": []any{call},
		},
	}
	callRaw := mustJSON(normalized)
	a.toolRawByID[id] = callRaw
	a.emitter.emit("tool.call", nil, callRaw)
}

func hasNonEmptyInput(update map[string]any) bool {
	value, ok := update["rawInput"]
	if !ok || value == nil {
		return false
	}
	if object, ok := value.(map[string]any); ok {
		return len(object) > 0
	}
	if text, ok := value.(string); ok {
		return strings.TrimSpace(text) != ""
	}
	return true
}

func textFromACPXContent(value any) string {
	switch content := value.(type) {
	case string:
		return content
	case map[string]any:
		return stringField(content, "text", "content")
	default:
		return ""
	}
}

func acpxToolOutput(update map[string]any) string {
	if output, ok := update["rawOutput"]; ok {
		return stringifyValue(output)
	}
	if status := stringField(update, "status"); status != "" {
		return status
	}
	return ""
}

func stringifyValue(value any) string {
	switch typed := value.(type) {
	case nil:
		return ""
	case string:
		return typed
	case map[string]any:
		if text := stringField(typed, "text", "content", "stdout", "stderr", "output"); text != "" {
			return text
		}
		raw, _ := json.MarshalIndent(typed, "", "  ")
		return string(raw)
	default:
		raw, err := json.MarshalIndent(typed, "", "  ")
		if err == nil {
			return string(raw)
		}
		return fmt.Sprint(typed)
	}
}

func stringField(source map[string]any, keys ...string) string {
	for _, key := range keys {
		if value, ok := source[key].(string); ok {
			return value
		}
	}
	return ""
}

func hasAnyKey(source map[string]any, keys ...string) bool {
	for _, key := range keys {
		if _, ok := source[key]; ok {
			return true
		}
	}
	return false
}

func hasAvailableModels(msg map[string]any) bool {
	result, _ := msg["result"].(map[string]any)
	models, _ := result["models"].(map[string]any)
	available, ok := models["availableModels"].([]any)
	return ok && len(available) > 0
}

func valueOrDefault(value, fallback string) string {
	if value == "" {
		return fallback
	}
	return value
}

func valueOrDefaultAny(value any, fallback any) any {
	if value == nil {
		return fallback
	}
	return value
}

func statusIndicatesError(status string) bool {
	normalized := strings.ToLower(status)
	return strings.Contains(normalized, "error") || strings.Contains(normalized, "fail")
}

func exitCodeFromError(err error) int {
	var exitErr *exec.ExitError
	if errors.As(err, &exitErr) {
		return exitErr.ExitCode()
	}
	return -1
}

func classifyClaudeEvent(raw json.RawMessage) string {
	var obj map[string]any
	if err := json.Unmarshal(raw, &obj); err != nil {
		return "tool.output"
	}
	t, _ := obj["type"].(string)
	if containsToolResult(obj) {
		return "tool.output"
	}
	if t == "assistant" || t == "message" {
		if containsToolUse(obj) {
			return "tool.call"
		}
	}
	switch t {
	case "assistant", "message", "text":
		return "assistant.message"
	case "tool_use", "tool_call":
		return "tool.call"
	case "tool_result":
		return "tool.output"
	case "result", "done":
		return "metric.updated"
	default:
		return "claude.raw"
	}
}

func containsToolResult(obj map[string]any) bool {
	if _, ok := obj["tool_use_result"]; ok {
		return true
	}
	message, _ := obj["message"].(map[string]any)
	content, _ := message["content"].([]any)
	for _, item := range content {
		part, _ := item.(map[string]any)
		if partType, _ := part["type"].(string); partType == "tool_result" {
			return true
		}
	}
	return false
}

func containsToolUse(obj map[string]any) bool {
	message, _ := obj["message"].(map[string]any)
	content, _ := message["content"].([]any)
	for _, item := range content {
		part, _ := item.(map[string]any)
		if partType, _ := part["type"].(string); partType == "tool_use" {
			return true
		}
	}
	return false
}

func (d *Daemon) stopTask(taskID string) {
	d.mu.Lock()
	rt := d.tasks[taskID]
	d.mu.Unlock()
	if rt == nil {
		d.emitError(taskID, "task_not_found", "task is not running")
		return
	}
	rt.markStopping()
	d.emitTaskEvent(taskID, "task.stopping", 0, map[string]string{"reason": "user_requested"}, nil)
	if rt.acpx {
		d.cancelACPXTask(rt)
	}
	terminateProcess(rt.cmd)
	select {
	case <-rt.done:
	case <-time.After(5 * time.Second):
		killProcess(rt.cmd)
	}
}

func (d *Daemon) cancelACPXTask(rt *runningTask) {
	if rt.workspace == "" {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, d.cfg.ACPX.Command, d.buildACPXCancelArgs(rt.workspace, rt.agent, rt.session)...)
	cmd.Dir = rt.workspace
	_ = cmd.Run()
}

func (d *Daemon) setTaskModel(parent context.Context, change protocol.TaskSetModel) {
	taskID := strings.TrimSpace(change.TaskID)
	modelID := strings.TrimSpace(change.ModelID)
	if taskID == "" || modelID == "" {
		d.emitError(taskID, "bad_payload", "task.set_model requires task_id and model_id")
		return
	}
	if !d.cfg.ACPX.Enabled {
		d.emitTaskEvent(taskID, "model.update_failed", 0, map[string]string{
			"model_id": modelID,
			"error":    "model switching requires acpx",
		}, nil)
		return
	}
	d.mu.Lock()
	record := d.history[taskID]
	rt := d.tasks[taskID]
	d.mu.Unlock()
	workspacePath := record.WorkspacePath
	agent := taskAgentName(protocol.TaskDispatch{Agent: record.Agent}, d.cfg.ACPX.Agent)
	sessionName := strings.TrimSpace(record.SessionName)
	if rt != nil {
		if rt.workspace != "" {
			workspacePath = rt.workspace
		}
		if rt.agent != "" {
			agent = rt.agent
		}
		if rt.session != "" {
			sessionName = rt.session
		}
	}
	if workspacePath == "" {
		d.emitTaskEvent(taskID, "model.update_failed", 0, map[string]string{
			"model_id": modelID,
			"error":    "task has no workspace",
		}, nil)
		return
	}
	ctx, cancel := context.WithTimeout(parent, 30*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, d.cfg.ACPX.Command, d.buildACPXSetModelArgs(workspacePath, agent, sessionName, modelID)...)
	cmd.Dir = workspacePath
	var stdout bytes.Buffer
	var stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		text := strings.TrimSpace(stderr.String())
		if text == "" {
			text = strings.TrimSpace(stdout.String())
		}
		if text == "" {
			text = err.Error()
		}
		d.emitTaskEvent(taskID, "model.update_failed", 0, map[string]string{
			"model_id": modelID,
			"error":    text,
		}, nil)
		return
	}
	d.mu.Lock()
	record = d.history[taskID]
	record.ModelID = modelID
	record.UpdatedAt = time.Now().Unix()
	d.history[taskID] = record
	d.mu.Unlock()
	raw := bytes.TrimSpace(stdout.Bytes())
	var rawJSON json.RawMessage
	if json.Valid(raw) {
		rawJSON = append(rawJSON, raw...)
	}
	d.emitTaskEvent(taskID, "model.updated", 0, map[string]string{
		"model_id": modelID,
	}, rawJSON)
}

func (d *Daemon) deleteSession(parent context.Context, remove protocol.SessionDelete) {
	taskID := strings.TrimSpace(remove.TaskID)
	if taskID == "" {
		d.emitError("", "bad_payload", "session.delete requires task_id")
		return
	}
	d.mu.Lock()
	record := d.history[taskID]
	rt := d.tasks[taskID]
	d.mu.Unlock()
	workspacePath := firstNonEmpty(remove.WorkspacePath, record.WorkspacePath, d.defaultACPXWorkspace())
	agent := taskAgentName(protocol.TaskDispatch{Agent: firstNonEmpty(remove.Agent, record.Agent)}, d.cfg.ACPX.Agent)
	sessionName := firstNonEmpty(remove.SessionName, record.SessionName)
	if rt != nil {
		rt.markStopping()
		if rt.cancel != nil {
			rt.cancel()
		}
	}
	if d.cfg.ACPX.Enabled && workspacePath != "" {
		ctx, cancel := context.WithTimeout(parent, 20*time.Second)
		defer cancel()
		cmd := exec.CommandContext(ctx, d.cfg.ACPX.Command, d.buildACPXSessionCloseArgs(workspacePath, agent, sessionName)...)
		cmd.Dir = workspacePath
		var stderr bytes.Buffer
		cmd.Stderr = &stderr
		if err := cmd.Run(); err != nil {
			text := strings.TrimSpace(stderr.String())
			if text == "" {
				text = err.Error()
			}
			d.emitTaskEvent(taskID, "session.delete_failed", 0, map[string]string{"error": text}, nil)
			return
		}
	}
	d.mu.Lock()
	delete(d.history, taskID)
	delete(d.tasks, taskID)
	d.mu.Unlock()
	d.sendSnapshot()
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return strings.TrimSpace(value)
		}
	}
	return ""
}

func (rt *runningTask) markStopping() {
	rt.mu.Lock()
	defer rt.mu.Unlock()
	rt.stopping = true
}

func (rt *runningTask) isStopping() bool {
	rt.mu.Lock()
	defer rt.mu.Unlock()
	return rt.stopping
}

func (d *Daemon) resolveWorkspacePath(workspaceID string, requested string) (protocol.Workspace, error) {
	path := strings.TrimSpace(requested)
	if path == "" {
		for _, ws := range d.cfg.Workspaces {
			if workspaceID == "" || ws.ID == workspaceID {
				return ws, nil
			}
		}
		return protocol.Workspace{}, fmt.Errorf("workspace_path is required")
	}
	if strings.HasPrefix(path, "~"+string(filepath.Separator)) || path == "~" {
		home, err := os.UserHomeDir()
		if err != nil {
			return protocol.Workspace{}, err
		}
		if path == "~" {
			path = home
		} else {
			path = filepath.Join(home, strings.TrimPrefix(path, "~"+string(filepath.Separator)))
		}
	}
	if !filepath.IsAbs(path) {
		abs, err := filepath.Abs(path)
		if err != nil {
			return protocol.Workspace{}, err
		}
		path = abs
	}
	absPath, err := filepath.Abs(filepath.Clean(path))
	if err != nil {
		return protocol.Workspace{}, err
	}
	if err := os.MkdirAll(absPath, 0o755); err != nil {
		return protocol.Workspace{}, err
	}
	real, err := filepath.EvalSymlinks(absPath)
	if err != nil {
		return protocol.Workspace{}, err
	}
	return protocol.Workspace{
		ID:   d.projectIDForWorkspacePath(real),
		Name: filepath.Base(real),
		Path: real,
	}, nil
}

func (d *Daemon) resolveWorkspaceFile(workspaceID string, workspacePath string, requestedPath string) (protocol.Workspace, string, string, error) {
	workspace, err := d.resolveWorkspacePath(workspaceID, workspacePath)
	if err != nil {
		return protocol.Workspace{}, "", "", err
	}
	relative := strings.TrimSpace(requestedPath)
	var target string
	if relative == "" || relative == "." {
		target = workspace.Path
		relative = "."
	} else if filepath.IsAbs(relative) {
		target = filepath.Clean(relative)
	} else {
		target = filepath.Join(workspace.Path, relative)
	}
	absTarget, err := filepath.Abs(filepath.Clean(target))
	if err != nil {
		return protocol.Workspace{}, "", "", err
	}
	relToRoot, err := filepath.Rel(workspace.Path, absTarget)
	if err != nil {
		return protocol.Workspace{}, "", "", err
	}
	if relToRoot == ".." || strings.HasPrefix(relToRoot, ".."+string(filepath.Separator)) || filepath.IsAbs(relToRoot) {
		return protocol.Workspace{}, "", "", fmt.Errorf("path is outside workspace")
	}
	if relToRoot == "." {
		return workspace, absTarget, ".", nil
	}
	return workspace, absTarget, filepath.ToSlash(relToRoot), nil
}

func (d *Daemon) listWorkspace(request protocol.WorkspaceListRequest) {
	workspace, target, relative, err := d.resolveWorkspaceFile(request.WorkspaceID, request.WorkspacePath, request.Path)
	if err != nil {
		d.sendWorkspaceError(request.RequestID, err.Error())
		return
	}
	entries, err := os.ReadDir(target)
	if err != nil {
		d.sendWorkspaceResult(protocol.WorkspaceResult{RequestID: request.RequestID, WorkspaceID: workspace.ID, WorkspacePath: workspace.Path, Path: relative, Error: err.Error()})
		return
	}
	items := make([]protocol.FileEntry, 0, len(entries))
	for _, entry := range entries {
		name := entry.Name()
		if name == ".git" || name == "node_modules" || name == ".next" || name == "dist" || name == "build" {
			continue
		}
		info, err := entry.Info()
		if err != nil {
			continue
		}
		childPath := name
		if relative != "." {
			childPath = filepath.ToSlash(filepath.Join(relative, name))
		}
		items = append(items, protocol.FileEntry{
			Name:     name,
			Path:     childPath,
			IsDir:    entry.IsDir(),
			Size:     info.Size(),
			Modified: info.ModTime().Unix(),
		})
	}
	sort.Slice(items, func(i, j int) bool {
		if items[i].IsDir != items[j].IsDir {
			return items[i].IsDir
		}
		return strings.ToLower(items[i].Name) < strings.ToLower(items[j].Name)
	})
	d.sendWorkspaceResult(protocol.WorkspaceResult{RequestID: request.RequestID, WorkspaceID: workspace.ID, WorkspacePath: workspace.Path, Path: relative, Entries: items})
}

func (d *Daemon) readWorkspaceFile(request protocol.WorkspaceReadRequest) {
	workspace, target, relative, err := d.resolveWorkspaceFile(request.WorkspaceID, request.WorkspacePath, request.Path)
	if err != nil {
		d.sendWorkspaceError(request.RequestID, err.Error())
		return
	}
	info, err := os.Stat(target)
	if err != nil {
		d.sendWorkspaceResult(protocol.WorkspaceResult{RequestID: request.RequestID, WorkspaceID: workspace.ID, WorkspacePath: workspace.Path, Path: relative, Error: err.Error()})
		return
	}
	if info.IsDir() {
		d.sendWorkspaceResult(protocol.WorkspaceResult{RequestID: request.RequestID, WorkspaceID: workspace.ID, WorkspacePath: workspace.Path, Path: relative, Error: "cannot read directory"})
		return
	}
	if info.Size() > 1024*1024 {
		d.sendWorkspaceResult(protocol.WorkspaceResult{RequestID: request.RequestID, WorkspaceID: workspace.ID, WorkspacePath: workspace.Path, Path: relative, Error: "file is larger than 1MB"})
		return
	}
	content, err := os.ReadFile(target)
	if err != nil {
		d.sendWorkspaceResult(protocol.WorkspaceResult{RequestID: request.RequestID, WorkspaceID: workspace.ID, WorkspacePath: workspace.Path, Path: relative, Error: err.Error()})
		return
	}
	d.sendWorkspaceResult(protocol.WorkspaceResult{RequestID: request.RequestID, WorkspaceID: workspace.ID, WorkspacePath: workspace.Path, Path: relative, Content: string(content)})
}

func (d *Daemon) writeWorkspaceFile(request protocol.WorkspaceWriteRequest) {
	workspace, target, relative, err := d.resolveWorkspaceFile(request.WorkspaceID, request.WorkspacePath, request.Path)
	if err != nil {
		d.sendWorkspaceError(request.RequestID, err.Error())
		return
	}
	if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
		d.sendWorkspaceResult(protocol.WorkspaceResult{RequestID: request.RequestID, WorkspaceID: workspace.ID, WorkspacePath: workspace.Path, Path: relative, Error: err.Error()})
		return
	}
	if err := os.WriteFile(target, []byte(request.Content), 0o644); err != nil {
		d.sendWorkspaceResult(protocol.WorkspaceResult{RequestID: request.RequestID, WorkspaceID: workspace.ID, WorkspacePath: workspace.Path, Path: relative, Error: err.Error()})
		return
	}
	d.sendWorkspaceResult(protocol.WorkspaceResult{RequestID: request.RequestID, WorkspaceID: workspace.ID, WorkspacePath: workspace.Path, Path: relative, Content: request.Content})
}

func (d *Daemon) createProject(request protocol.ProjectCreateRequest) {
	name := strings.TrimSpace(request.Name)
	if name == "" {
		name = filepath.Base(request.WorkspacePath)
	}
	workspace, err := d.resolveWorkspacePath("", request.WorkspacePath)
	if err != nil {
		d.sendProjectError(request.RequestID, err.Error())
		return
	}
	project := protocol.Project{
		ID:            d.projectIDForWorkspacePath(workspace.Path),
		Name:          name,
		DeviceID:      d.cfg.Device.ID,
		WorkspacePath: workspace.Path,
		AgentIDs:      []string{},
		TmuxIDs:       []string{},
	}
	d.mu.Lock()
	d.projects[project.ID] = project
	err = d.saveProjectStoreLocked()
	d.mu.Unlock()
	if err != nil {
		d.sendProjectError(request.RequestID, err.Error())
		return
	}
	d.sendProjectResult(protocol.ProjectResult{RequestID: request.RequestID, Project: &project})
	d.sendHello()
}

func (d *Daemon) getProjectState(request protocol.ProjectStateGetRequest) {
	projectID := request.ProjectID
	if projectID == "" && request.WorkspacePath != "" {
		projectID = d.projectIDForWorkspacePath(request.WorkspacePath)
	}
	if err := d.loadProjectStates(); err != nil {
		log.Printf("reload project states: %v", err)
	}
	d.mu.Lock()
	state := append(json.RawMessage(nil), d.projectStates[projectID]...)
	if len(state) == 0 {
		if project, ok := d.projects[projectID]; ok && len(project.StudioState) > 0 {
			state = append(json.RawMessage(nil), project.StudioState...)
		}
	}
	if len(state) == 0 && request.WorkspacePath != "" {
		legacyID := legacyProjectIDForWorkspace(d.cfg.Device.ID, request.WorkspacePath)
		if legacyID != projectID {
			if stored := d.projectStates[legacyID]; len(stored) > 0 {
				state = append(json.RawMessage(nil), stored...)
				d.projectStates[projectID] = append(json.RawMessage(nil), stored...)
				_ = d.saveProjectStatesLocked()
			}
		}
	}
	if len(state) == 0 && request.WorkspacePath != "" {
		for _, project := range d.projects {
			if project.WorkspacePath != request.WorkspacePath {
				continue
			}
			if stored := d.projectStates[project.ID]; len(stored) > 0 {
				state = append(json.RawMessage(nil), stored...)
				break
			}
			if len(project.StudioState) > 0 {
				state = append(json.RawMessage(nil), project.StudioState...)
				break
			}
		}
	}
	d.mu.Unlock()
	d.sendProjectResult(protocol.ProjectResult{RequestID: request.RequestID, State: state})
}

func (d *Daemon) setProjectState(request protocol.ProjectStateSetRequest) {
	projectID := request.ProjectID
	if projectID == "" && request.WorkspacePath != "" {
		projectID = d.projectIDForWorkspacePath(request.WorkspacePath)
	}
	if projectID == "" {
		d.sendProjectError(request.RequestID, "project_id is required")
		return
	}
	state := append(json.RawMessage(nil), request.State...)
	d.mu.Lock()
	d.projectStates[projectID] = state
	if project, ok := d.projects[projectID]; ok {
		project.StudioState = state
		project.TmuxIDs = collectTerminalTabIDsFromRaw(state)
		d.projects[projectID] = project
	}
	stateErr := d.saveProjectStatesLocked()
	projectErr := d.saveProjectStoreLocked()
	d.mu.Unlock()
	if stateErr != nil {
		d.sendProjectError(request.RequestID, stateErr.Error())
		return
	}
	if projectErr != nil {
		d.sendProjectError(request.RequestID, projectErr.Error())
		return
	}
	d.sendProjectResult(protocol.ProjectResult{RequestID: request.RequestID, State: state})
}

func (d *Daemon) runTerminalCommand(parent context.Context, request protocol.TerminalRunRequest) {
	command := strings.TrimSpace(request.Command)
	if command == "" {
		d.sendTerminalError(request.RequestID, command, "command is required")
		return
	}
	workspace, err := d.resolveWorkspacePath(request.WorkspaceID, request.WorkspacePath)
	if err != nil {
		d.sendTerminalError(request.RequestID, command, err.Error())
		return
	}
	ctx, cancel := context.WithTimeout(parent, 2*time.Minute)
	defer cancel()
	started := time.Now()
	shell := userShell()
	cmd := exec.CommandContext(ctx, shell, "-lc", command)
	cmd.Dir = workspace.Path
	cmd.Env = terminalEnv()
	var stdout bytes.Buffer
	var stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	err = cmd.Run()
	output := strings.TrimRight(stdout.String()+stderr.String(), "\n")
	result := protocol.TerminalResult{
		RequestID: request.RequestID,
		Command:   command,
		Output:    output,
		ExitCode:  0,
		Duration:  time.Since(started).Milliseconds(),
	}
	if err != nil {
		result.ExitCode = exitCodeFromError(err)
		result.Error = err.Error()
	}
	d.send <- protocol.NewEnvelope(protocol.TypeTerminalResult, "daemon", result)
}

func (d *Daemon) sendWorkspaceResult(result protocol.WorkspaceResult) {
	d.send <- protocol.NewEnvelope(protocol.TypeWorkspaceResult, "daemon", result)
}

func (d *Daemon) sendProjectResult(result protocol.ProjectResult) {
	d.send <- protocol.NewEnvelope(protocol.TypeProjectResult, "daemon", result)
}

func (d *Daemon) sendProjectError(requestID string, message string) {
	d.sendProjectResult(protocol.ProjectResult{RequestID: requestID, Error: message})
}

func (d *Daemon) sendHello() {
	d.send <- protocol.NewEnvelope(protocol.TypeDaemonHello, "daemon", protocol.DaemonHello{
		DeviceID:      d.cfg.Device.ID,
		DeviceName:    hostinfo.ResolveDeviceName(d.cfg.Device.Name),
		DaemonVersion: "0.1.0",
		Agent:         d.agentName(),
		AgentLabel:    d.agentLabel(),
		Agents:        d.agentCapabilities(),
		Workspaces:    d.workspacesSnapshot(),
		Features:      []string{protocol.FeatureTerminalBinaryV1},
	})
}

func (d *Daemon) sendWorkspaceError(requestID string, message string) {
	d.sendWorkspaceResult(protocol.WorkspaceResult{RequestID: requestID, Error: message})
}

func (d *Daemon) sendTerminalError(requestID string, command string, message string) {
	d.send <- protocol.NewEnvelope(protocol.TypeTerminalResult, "daemon", protocol.TerminalResult{
		RequestID: requestID,
		Command:   command,
		Error:     message,
		ExitCode:  -1,
	})
}

func (d *Daemon) projectIDForWorkspacePath(workspacePath string) string {
	id, err := canonicalProjectIDForWorkspace(workspacePath)
	if err != nil {
		log.Printf("canonical project id for %s: %v", workspacePath, err)
		return legacyProjectIDForWorkspace(d.cfg.Device.ID, workspacePath)
	}
	return id
}

func workspaceIDForPath(path string) string {
	clean := strings.Trim(filepath.ToSlash(filepath.Clean(path)), "/")
	if clean == "" {
		return "workspace"
	}
	id := strings.NewReplacer("/", "-", " ", "-").Replace(clean)
	if len(id) > 80 {
		return id[len(id)-80:]
	}
	return id
}

func legacyProjectIDForWorkspace(deviceID string, workspacePath string) string {
	sum := sha1.Sum([]byte(deviceID + "\x00" + workspacePath))
	return "ws_" + fmt.Sprintf("%x", sum[:8])
}

func collectTerminalTabIDsFromRaw(raw json.RawMessage) []string {
	if len(raw) == 0 {
		return []string{}
	}
	var state struct {
		LayoutTree any `json:"layoutTree"`
	}
	if json.Unmarshal(raw, &state) != nil {
		return []string{}
	}
	var ids []string
	var walk func(any)
	walk = func(value any) {
		obj, ok := value.(map[string]any)
		if !ok {
			return
		}
		typ, _ := obj["type"].(string)
		if typ == "panel" {
			tabs, _ := obj["tabs"].([]any)
			for _, tabValue := range tabs {
				tab, ok := tabValue.(map[string]any)
				if !ok {
					continue
				}
				if kind, _ := tab["kind"].(string); kind != "" && kind != "terminal" {
					continue
				}
				if id, _ := tab["id"].(string); id != "" {
					ids = append(ids, id)
				}
			}
			return
		}
		children, _ := obj["children"].([]any)
		for _, child := range children {
			walk(child)
		}
	}
	walk(state.LayoutTree)
	return ids
}

func (d *Daemon) runningTaskIDs() []string {
	d.mu.Lock()
	defer d.mu.Unlock()
	ids := make([]string, 0, len(d.tasks))
	for id := range d.tasks {
		ids = append(ids, id)
	}
	return ids
}

func (d *Daemon) sendSnapshot() {
	if d.cfg.ACPX.Enabled {
		if tasks, err := d.acpxSessionRecords(context.Background()); err == nil {
			d.mu.Lock()
			for _, record := range tasks {
				if existing := d.history[record.TaskID]; len(existing.Events) > 0 {
					record.Events = mergeTaskEvents(record.Events, existing.Events)
					if existing.Status == "running" || existing.Status == "stopping" {
						record.Status = existing.Status
					}
					if existing.UpdatedAt > record.UpdatedAt {
						record.UpdatedAt = existing.UpdatedAt
					}
				}
				d.history[record.TaskID] = record
			}
			for taskID := range d.history {
				if strings.HasPrefix(taskID, "acpx_") {
					found := false
					for _, record := range tasks {
						if record.TaskID == taskID {
							found = true
							break
						}
					}
					if !found {
						delete(d.history, taskID)
					}
				}
			}
			d.mu.Unlock()
		} else {
			log.Printf("acpx sessions list failed: %v", err)
		}
	}
	d.mu.Lock()
	tasks := make([]protocol.TaskRecord, 0, len(d.history))
	for _, record := range d.history {
		tasks = append(tasks, record)
	}
	d.mu.Unlock()
	d.send <- protocol.NewEnvelope(protocol.TypeTaskSnapshot, "daemon", protocol.TaskSnapshot{
		DeviceID: d.cfg.Device.ID,
		Tasks:    tasks,
	})
}

func (d *Daemon) acpxSessionRecords(ctx context.Context) ([]protocol.TaskRecord, error) {
	workspace := d.defaultACPXWorkspace()
	agent := strings.TrimSpace(d.cfg.ACPX.Agent)
	if agent == "" {
		agent = "claude"
	}
	listCtx, cancel := context.WithTimeout(ctx, 12*time.Second)
	defer cancel()
	cmd := exec.CommandContext(listCtx, d.cfg.ACPX.Command, d.buildACPXSessionListArgs(workspace, agent)...)
	cmd.Dir = workspace
	var stdout bytes.Buffer
	var stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		text := strings.TrimSpace(stderr.String())
		if text == "" {
			text = strings.TrimSpace(stdout.String())
		}
		if text == "" {
			text = err.Error()
		}
		return nil, fmt.Errorf("%s: %s", err, text)
	}
	var records []map[string]any
	if err := json.Unmarshal(bytes.TrimSpace(stdout.Bytes()), &records); err != nil {
		return nil, err
	}
	tasks := make([]protocol.TaskRecord, 0, len(records))
	for _, item := range records {
		recordID := stringField(item, "acpxRecordId")
		if recordID == "" {
			continue
		}
		if closed, _ := item["closed"].(bool); closed {
			continue
		}
		taskID := "acpx_" + recordID
		sessionName := stringField(item, "name")
		cwd := stringField(item, "cwd")
		modelID := ""
		if acpx, _ := item["acpx"].(map[string]any); acpx != nil {
			modelID = stringField(acpx, "current_model_id")
		}
		status := "created"
		createdAt := parseACPXTime(stringField(item, "createdAt"))
		updatedAt := parseACPXTime(stringField(item, "lastUsedAt"))
		if updatedAt == 0 {
			updatedAt = parseACPXTime(stringField(item, "updated_at"))
		}
		if updatedAt == 0 {
			updatedAt = createdAt
		}
		events := acpxSessionHistoryEvents(taskID, item, createdAt, updatedAt)
		prompt := latestPromptFromEvents(events)
		tasks = append(tasks, protocol.TaskRecord{
			TaskID:        taskID,
			DeviceID:      d.cfg.Device.ID,
			WorkspaceID:   workspaceIDForPath(cwd),
			WorkspacePath: cwd,
			Agent:         agent,
			SessionName:   sessionName,
			ModelID:       modelID,
			Prompt:        prompt,
			Status:        status,
			SessionID:     recordID,
			StartedAt:     createdAt,
			UpdatedAt:     updatedAt,
			Events:        events,
		})
	}
	return tasks, nil
}

func acpxSessionHistoryEvents(taskID string, record map[string]any, createdAt int64, updatedAt int64) []protocol.TaskEvent {
	events := make([]protocol.TaskEvent, 0)
	seq := int64(1)
	add := func(eventType string, data any, raw any) {
		timestamp := createdAt
		if timestamp == 0 {
			timestamp = updatedAt
		}
		if timestamp != 0 {
			timestamp += seq - 1
			if updatedAt != 0 && timestamp > updatedAt {
				timestamp = updatedAt
			}
		}
		event := protocol.TaskEvent{
			TaskID:    taskID,
			EventID:   fmt.Sprintf("%s_%d", taskID, seq),
			EventType: eventType,
			Source:    "acpx",
			Sequence:  seq,
			Timestamp: timestamp,
			Data:      mustJSON(data),
			Raw:       mustJSON(raw),
		}
		events = append(events, event)
		seq++
	}

	if acpx, _ := record["acpx"].(map[string]any); acpx != nil {
		if raw := acpxModelListRaw(record, acpx); raw != nil {
			add("model.list", raw, raw)
		}
		if raw := acpxCommandsRaw(record, acpx); raw != nil {
			add("commands.updated", raw, raw)
		}
	}

	messages, _ := record["messages"].([]any)
	for _, item := range messages {
		message, _ := item.(map[string]any)
		if message == nil {
			continue
		}
		if user, _ := message["User"].(map[string]any); user != nil {
			prompt := acpxContentText(user["content"])
			if strings.TrimSpace(prompt) != "" {
				raw := map[string]any{
					"type": "user",
					"message": map[string]any{
						"role":    "user",
						"content": []any{map[string]any{"type": "text", "text": prompt}},
					},
				}
				add("user.prompt", map[string]any{"prompt": prompt}, raw)
			}
			continue
		}
		agent, _ := message["Agent"].(map[string]any)
		if agent == nil {
			continue
		}
		content, _ := agent["content"].([]any)
		for _, partValue := range content {
			part, _ := partValue.(map[string]any)
			if part == nil {
				continue
			}
			if thinking, ok := part["Thinking"]; ok {
				text := acpxThinkingText(thinking)
				if strings.TrimSpace(text) != "" {
					add("assistant.thinking", map[string]any{"text": text}, map[string]any{"type": "thinking", "text": text})
				}
				continue
			}
			if text := acpxTextPart(part["Text"]); strings.TrimSpace(text) != "" {
				raw := map[string]any{
					"type": "assistant",
					"message": map[string]any{
						"role":    "assistant",
						"content": []any{map[string]any{"type": "text", "text": text}},
					},
				}
				add("assistant.message", map[string]any{"text": text}, raw)
				continue
			}
			if toolUse, _ := part["ToolUse"].(map[string]any); toolUse != nil {
				id := stringField(toolUse, "id", "tool_use_id", "toolCallId")
				name := stringField(toolUse, "name", "title")
				input := acpxToolInput(toolUse)
				raw := map[string]any{
					"type": "assistant",
					"message": map[string]any{
						"role": "assistant",
						"content": []any{map[string]any{
							"type":  "tool_use",
							"id":    id,
							"name":  name,
							"input": input,
						}},
					},
				}
				add("tool.call", map[string]any{"tool_use_id": id, "name": name, "input": input}, raw)
			}
		}
		results, _ := agent["tool_results"].(map[string]any)
		for id, resultValue := range results {
			result, _ := resultValue.(map[string]any)
			if result == nil {
				continue
			}
			toolUseID := firstNonEmpty(stringField(result, "tool_use_id", "toolUseId", "id"), id)
			text := acpxToolResultText(result)
			isError, _ := result["is_error"].(bool)
			raw := map[string]any{
				"type": "user",
				"message": map[string]any{
					"role": "user",
					"content": []any{map[string]any{
						"type":        "tool_result",
						"tool_use_id": toolUseID,
						"content":     text,
						"is_error":    isError,
					}},
				},
				"tool_use_result": map[string]any{
					"stdout":   text,
					"stderr":   "",
					"is_error": isError,
				},
			}
			add("tool.output", map[string]any{"tool_use_id": toolUseID, "text": text, "is_error": isError}, raw)
		}
	}
	return events
}

func acpxModelListRaw(record map[string]any, acpx map[string]any) map[string]any {
	available, ok := acpx["available_models"].([]any)
	if !ok || len(available) == 0 {
		return nil
	}
	models := make([]any, 0, len(available))
	for _, value := range available {
		id := strings.TrimSpace(fmt.Sprint(value))
		if id == "" {
			continue
		}
		models = append(models, map[string]any{"modelId": id, "name": id})
	}
	if len(models) == 0 {
		return nil
	}
	return map[string]any{
		"jsonrpc": "2.0",
		"id":      2,
		"result": map[string]any{
			"sessionId": stringField(record, "acpSessionId", "acpxRecordId"),
			"models": map[string]any{
				"currentModelId":  stringField(acpx, "current_model_id", "currentModelId"),
				"availableModels": models,
			},
		},
	}
}

func acpxCommandsRaw(record map[string]any, acpx map[string]any) map[string]any {
	available, ok := acpx["available_commands"].([]any)
	if !ok || len(available) == 0 {
		return nil
	}
	commands := make([]any, 0, len(available))
	for _, value := range available {
		name := strings.TrimSpace(fmt.Sprint(value))
		if name == "" {
			continue
		}
		commands = append(commands, map[string]any{"name": name})
	}
	if len(commands) == 0 {
		return nil
	}
	return map[string]any{
		"jsonrpc": "2.0",
		"method":  "session/update",
		"params": map[string]any{
			"sessionId": stringField(record, "acpSessionId", "acpxRecordId"),
			"update": map[string]any{
				"sessionUpdate":     "available_commands_update",
				"availableCommands": commands,
			},
		},
	}
}

func acpxContentText(value any) string {
	items, ok := value.([]any)
	if !ok {
		return acpxTextPart(value)
	}
	parts := make([]string, 0, len(items))
	for _, item := range items {
		text := acpxTextPart(item)
		if strings.TrimSpace(text) != "" {
			parts = append(parts, text)
		}
	}
	return strings.Join(parts, "\n")
}

func acpxTextPart(value any) string {
	switch typed := value.(type) {
	case nil:
		return ""
	case string:
		return typed
	case map[string]any:
		if text := stringField(typed, "Text", "text", "content"); text != "" {
			return text
		}
		if nested, ok := typed["Text"]; ok {
			return acpxTextPart(nested)
		}
	}
	return stringifyValue(value)
}

func acpxThinkingText(value any) string {
	if thinking, _ := value.(map[string]any); thinking != nil {
		return stringField(thinking, "text", "Text", "content")
	}
	return acpxTextPart(value)
}

func acpxToolInput(toolUse map[string]any) map[string]any {
	if input, _ := toolUse["input"].(map[string]any); input != nil {
		return input
	}
	rawInput := strings.TrimSpace(stringField(toolUse, "raw_input", "rawInput"))
	if rawInput == "" {
		return map[string]any{}
	}
	var parsed map[string]any
	if err := json.Unmarshal([]byte(rawInput), &parsed); err == nil && parsed != nil {
		return parsed
	}
	return map[string]any{"input": rawInput}
}

func acpxToolResultText(result map[string]any) string {
	if content, _ := result["content"].(map[string]any); content != nil {
		if text := acpxTextPart(content); strings.TrimSpace(text) != "" {
			return text
		}
	}
	if output, ok := result["output"]; ok {
		return stringifyValue(output)
	}
	return stringifyValue(result)
}

func latestPromptFromEvents(events []protocol.TaskEvent) string {
	for i := len(events) - 1; i >= 0; i-- {
		if events[i].EventType != "user.prompt" || len(events[i].Data) == 0 {
			continue
		}
		var data map[string]any
		if err := json.Unmarshal(events[i].Data, &data); err == nil {
			if prompt := stringField(data, "prompt"); prompt != "" {
				return prompt
			}
		}
	}
	return ""
}

func mergeTaskEvents(base []protocol.TaskEvent, extra []protocol.TaskEvent) []protocol.TaskEvent {
	if len(base) == 0 {
		return append([]protocol.TaskEvent(nil), extra...)
	}
	merged := append([]protocol.TaskEvent(nil), base...)
	seen := make(map[string]struct{}, len(merged))
	for _, event := range merged {
		seen[taskEventSignature(event)] = struct{}{}
	}
	for _, event := range extra {
		signature := taskEventSignature(event)
		if _, ok := seen[signature]; ok {
			continue
		}
		merged = append(merged, event)
		seen[signature] = struct{}{}
	}
	return merged
}

func taskEventSignature(event protocol.TaskEvent) string {
	if len(event.Raw) > 0 {
		return event.EventType + ":" + string(event.Raw)
	}
	if len(event.Data) > 0 {
		return event.EventType + ":" + string(event.Data)
	}
	return fmt.Sprintf("%s:%d:%s", event.EventType, event.Sequence, event.EventID)
}

func (d *Daemon) defaultACPXWorkspace() string {
	if len(d.cfg.Workspaces) > 0 && d.cfg.Workspaces[0].Path != "" {
		return d.cfg.Workspaces[0].Path
	}
	home, err := os.UserHomeDir()
	if err == nil && home != "" {
		return home
	}
	return "."
}

func parseACPXTime(value string) int64 {
	if value == "" {
		return 0
	}
	if parsed, err := time.Parse(time.RFC3339Nano, value); err == nil {
		return parsed.Unix()
	}
	return 0
}

func (d *Daemon) emitError(taskID, code, message string) {
	if taskID == "" {
		d.send <- protocol.NewEnvelope(protocol.TypeServerError, "daemon", protocol.ServerError{Code: code, Message: message})
		return
	}
	d.emitTaskEvent(taskID, "task.failed", 0, map[string]string{"code": code, "message": message}, nil)
}

func (d *Daemon) emitTaskEvent(taskID, eventType string, sequence int64, data any, raw json.RawMessage) {
	var dataRaw json.RawMessage
	if data != nil {
		dataRaw, _ = json.Marshal(data)
	}
	event := protocol.TaskEvent{
		TaskID:    taskID,
		EventID:   protocol.NewID("evt"),
		EventType: eventType,
		Source:    "claude_code",
		Sequence:  sequence,
		Timestamp: time.Now().Unix(),
		Data:      dataRaw,
		Raw:       raw,
	}
	d.recordTaskEvent(event)
	d.send <- protocol.NewEnvelope(protocol.TypeTaskEvent, "daemon", event)
}

func (d *Daemon) recordTaskEvent(event protocol.TaskEvent) {
	d.mu.Lock()
	defer d.mu.Unlock()
	record := d.history[event.TaskID]
	record.TaskID = event.TaskID
	if sessionID := extractSessionID(event); sessionID != "" {
		record.SessionID = sessionID
	}
	record.Status = statusFromEvent(event.EventType, record.Status)
	now := time.Now().Unix()
	if record.StartedAt == 0 {
		record.StartedAt = now
	}
	record.UpdatedAt = now
	record.Events = appendBounded(record.Events, event, 1000)
	d.history[event.TaskID] = record
}

func extractSessionID(event protocol.TaskEvent) string {
	for _, raw := range []json.RawMessage{event.Raw, event.Data} {
		if len(raw) == 0 {
			continue
		}
		var obj map[string]any
		if err := json.Unmarshal(raw, &obj); err != nil {
			continue
		}
		if sessionID, _ := obj["session_id"].(string); sessionID != "" {
			return sessionID
		}
		for _, key := range []string{"sessionId", "acpxRecordId", "acpxSessionId", "agentSessionId"} {
			if sessionID, _ := obj[key].(string); sessionID != "" {
				return sessionID
			}
		}
		if message, ok := obj["message"].(map[string]any); ok {
			if sessionID, _ := message["session_id"].(string); sessionID != "" {
				return sessionID
			}
		}
	}
	return ""
}

func statusFromEvent(eventType, fallback string) string {
	switch eventType {
	case "task.started":
		return "running"
	case "task.stopping":
		return "stopping"
	case "task.completed":
		return "completed"
	case "task.failed":
		return "failed"
	case "task.killed":
		return "killed"
	default:
		if fallback == "" {
			return "running"
		}
		return fallback
	}
}

func appendBounded[T any](items []T, item T, max int) []T {
	items = append(items, item)
	if len(items) <= max {
		return items
	}
	return append([]T(nil), items[len(items)-max:]...)
}

func hasFeature(features []string, target string) bool {
	for _, feature := range features {
		if feature == target {
			return true
		}
	}
	return false
}

func writeEnvelope(conn *websocket.Conn, env protocol.Envelope) error {
	if env.ID == "" {
		env.ID = protocol.NewID("msg")
	}
	if env.Version == 0 {
		env.Version = 1
	}
	if env.Timestamp == 0 {
		env.Timestamp = time.Now().Unix()
	}
	return conn.WriteJSON(env)
}

func enableTCPNoDelay(conn *websocket.Conn) {
	if tcp, ok := conn.UnderlyingConn().(*net.TCPConn); ok {
		_ = tcp.SetNoDelay(true)
	}
}

func mustJSON(value any) json.RawMessage {
	raw, _ := json.Marshal(value)
	return raw
}

type runningPTY struct {
	projectID   string
	terminalID  string
	sessionName string
	ptyFile     *os.File
	cmd         *exec.Cmd
	done        chan struct{}
}

const (
	tmuxSocketName   = "pocket-studio"
	tmuxHistoryLimit = 50000
)

func (d *Daemon) startTerminalStream(parent context.Context, req protocol.TerminalStreamStart) {
	workspace, err := d.resolveWorkspacePath("", req.WorkspacePath)
	if err != nil {
		log.Printf("terminal stream failed to resolve workspace path: %v", err)
		return
	}

	key := req.ProjectID + "::" + req.TerminalID
	sessionName := terminalSessionName(workspace.Path, req.TerminalID)
	d.termMu.Lock()
	if rPty, exists := d.terminalPTYs[key]; exists {
		d.termMu.Unlock()
		applyTerminalSize(rPty.ptyFile, req.Cols, req.Rows)
		resizeTmuxSession(rPty.sessionName, req.Cols, req.Rows)
		d.sendTerminalSnapshot(req.ProjectID, req.TerminalID, rPty.sessionName)
		return
	}

	initialTitle := initialTerminalTitle(req.Command, req.InitialTitle)
	cmd, err := tmuxNewSessionCommand(sessionName, initialTitle, workspace.Path, req.Command)
	if err != nil {
		log.Printf("daemon failed to prepare tmux config: %v. falling back to user shell.", err)
		cmd = nil
	}
	if cmd != nil {
		cmd.Env = terminalEnv()
	}

	var ptyFile *os.File
	if cmd != nil {
		ptyFile, err = pty.Start(cmd)
	}
	if cmd == nil || err != nil {
		log.Printf("daemon failed to start tmux: %v. falling back to user shell.", err)
		if req.Command != "" {
			cmd = exec.Command(userShell(), "-lc", req.Command)
		} else {
			cmd = exec.Command(userShell(), "-l")
		}
		cmd.Dir = workspace.Path
		cmd.Env = terminalEnv()
		ptyFile, err = pty.Start(cmd)
		if err != nil {
			d.termMu.Unlock()
			log.Printf("daemon failed to start fallback shell: %v", err)
			return
		}
	}
	applyTerminalSize(ptyFile, req.Cols, req.Rows)
	resizeTmuxSession(sessionName, req.Cols, req.Rows)

	done := make(chan struct{})
	rPty := &runningPTY{
		projectID:   req.ProjectID,
		terminalID:  req.TerminalID,
		sessionName: sessionName,
		ptyFile:     ptyFile,
		cmd:         cmd,
		done:        done,
	}
	d.terminalPTYs[key] = rPty
	d.termMu.Unlock()
	go d.watchTerminalTitle(parent, req.ProjectID, req.TerminalID, sessionName, done)
	d.sendTerminalSnapshot(req.ProjectID, req.TerminalID, sessionName)
	go func() {
		select {
		case <-done:
			return
		case <-parent.Done():
			return
		case <-time.After(250 * time.Millisecond):
			d.sendTerminalSnapshot(req.ProjectID, req.TerminalID, sessionName)
		}
	}()

	go func() {
		defer func() {
			ptyFile.Close()
			_ = cmd.Wait()
			close(done)

			d.termMu.Lock()
			if d.terminalPTYs[key] == rPty {
				delete(d.terminalPTYs, key)
			}
			d.termMu.Unlock()

			// Send exit signal back to Go server
			exitPayload := protocol.TerminalStreamExit{
				ProjectID:  req.ProjectID,
				TerminalID: req.TerminalID,
			}
			d.send <- protocol.NewEnvelope(protocol.TypeTerminalStreamExit, "daemon", exitPayload)
		}()

		buf := make([]byte, 1024)
		for {
			n, err := ptyFile.Read(buf)
			if err != nil {
				break
			}
			dataPayload := protocol.TerminalStreamData{
				ProjectID:  req.ProjectID,
				TerminalID: req.TerminalID,
				Data:       buf[:n],
			}
			d.sendTerminalStreamData(dataPayload)
		}
	}()
}

func (d *Daemon) sendTerminalStreamData(data protocol.TerminalStreamData) {
	d.mu.Lock()
	terminalBinary := d.terminalBinary
	d.mu.Unlock()
	if terminalBinary {
		frame, err := protocol.MarshalTerminalStreamDataBinary(data)
		if err != nil {
			d.send <- protocol.NewEnvelope(protocol.TypeTerminalStreamData, "daemon", data)
			return
		}
		select {
		case d.sendBinary <- frame:
			return
		default:
		}
	}
	d.send <- protocol.NewEnvelope(protocol.TypeTerminalStreamData, "daemon", data)
}

func (d *Daemon) sendTerminalSnapshot(projectID string, terminalID string, sessionName string) {
	if data := tmuxCapturePane(sessionName); len(data) > 0 {
		d.sendTerminalStreamData(protocol.TerminalStreamData{
			ProjectID:  projectID,
			TerminalID: terminalID,
			Data:       data,
		})
	}
	title, command := tmuxTerminalInfo(sessionName)
	if title != "" {
		d.send <- protocol.NewEnvelope(protocol.TypeTerminalStreamTitle, "daemon", protocol.TerminalStreamTitle{
			ProjectID:  projectID,
			TerminalID: terminalID,
			Title:      title,
			Command:    command,
		})
	}
}

func (d *Daemon) watchTerminalTitle(ctx context.Context, projectID string, terminalID string, sessionName string, done <-chan struct{}) {
	ticker := time.NewTicker(2500 * time.Millisecond)
	defer ticker.Stop()
	lastTitle := ""
	lastCommand := ""
	for {
		title, command := tmuxTerminalInfo(sessionName)
		if title != "" && (title != lastTitle || command != lastCommand) {
			lastTitle = title
			lastCommand = command
			d.send <- protocol.NewEnvelope(protocol.TypeTerminalStreamTitle, "daemon", protocol.TerminalStreamTitle{
				ProjectID:  projectID,
				TerminalID: terminalID,
				Title:      title,
				Command:    command,
			})
		}
		select {
		case <-ctx.Done():
			return
		case <-done:
			return
		case <-ticker.C:
		}
	}
}

func tmuxTerminalInfo(sessionName string) (string, string) {
	cmd := tmuxCommand("display-message", "-p", "-t", sessionName, "#{window_name}\t#{pane_current_command}")
	raw, err := cmd.Output()
	if err != nil {
		return "", ""
	}
	parts := strings.SplitN(strings.TrimSpace(string(raw)), "\t", 2)
	title := strings.TrimSpace(parts[0])
	command := ""
	if len(parts) > 1 {
		command = strings.TrimSpace(parts[1])
	}
	if title == "" {
		title = command
	}
	return title, command
}

func tmuxCapturePane(sessionName string) []byte {
	cmd := tmuxCommand("capture-pane", "-p", "-e", "-J", "-S", "-"+strconv.Itoa(tmuxHistoryLimit), "-t", sessionName)
	raw, err := cmd.Output()
	if err != nil {
		return nil
	}
	if len(raw) == 0 {
		return nil
	}
	return append(raw, '\r')
}

func tmuxNewSessionCommand(sessionName string, initialTitle string, workspacePath string, command string) (*exec.Cmd, error) {
	configPath, err := ensurePocketStudioTmuxConfig()
	if err != nil {
		return nil, err
	}
	args := []string{"-u", "-L", tmuxSocketName, "-f", configPath, "start-server", ";", "source-file", configPath, ";", "new-session", "-A", "-s", sessionName, "-n", initialTitle, "-c", workspacePath}
	if command != "" {
		args = append(args, command)
	}
	return exec.Command("tmux", args...), nil
}

func tmuxCommand(args ...string) *exec.Cmd {
	fullArgs := append([]string{"-L", tmuxSocketName}, args...)
	return exec.Command("tmux", fullArgs...)
}

func ensurePocketStudioTmuxConfig() (string, error) {
	configPath := filepath.Join(daemonConfigDir(), "tmux.conf")
	if err := os.MkdirAll(filepath.Dir(configPath), 0o755); err != nil {
		return "", err
	}
	content := pocketStudioTmuxConfig(userShell())
	if existing, err := os.ReadFile(configPath); err == nil && string(existing) == content {
		return configPath, nil
	}
	if err := os.WriteFile(configPath, []byte(content), 0o600); err != nil {
		return "", err
	}
	return configPath, nil
}

func pocketStudioTmuxConfig(shell string) string {
	var b strings.Builder
	if shell != "" {
		fmt.Fprintf(&b, "set-option -g default-shell %q\n", shell)
	}
	b.WriteString(`set-option -g status off
set-option -g set-titles on
set-option -g default-terminal "tmux-256color"
set-option -g terminal-overrides ",xterm-256color:RGB,tmux-256color:RGB,*-256color:RGB"
set-option -ga terminal-features ",xterm-256color:RGB,tmux-256color:RGB,*-256color:RGB"
set-option -g history-limit 50000
set-option -g mouse on
set-option -sg escape-time 10
set-option -g prefix C-a
unbind-key C-b
bind-key C-a send-prefix
set-environment -gu NO_COLOR
set-environment -g COLORTERM truecolor
set-environment -g CLICOLOR 1
set-environment -g CLICOLOR_FORCE 1
set-environment -g FORCE_COLOR 1
set-window-option -g allow-rename on
set-window-option -g automatic-rename off
set-window-option -g mode-keys vi
bind-key v copy-mode
bind-key -T copy-mode-vi v send-keys -X begin-selection
bind-key -T copy-mode-vi y send-keys -X copy-pipe-and-cancel "sh -c 'if command -v wl-copy >/dev/null 2>&1; then wl-copy; elif command -v xclip >/dev/null 2>&1; then xclip -selection clipboard; elif command -v xsel >/dev/null 2>&1; then xsel --clipboard --input; elif command -v pbcopy >/dev/null 2>&1; then pbcopy; else cat >/dev/null; fi'"
bind-key -T copy-mode-vi Enter send-keys -X copy-pipe-and-cancel "sh -c 'if command -v wl-copy >/dev/null 2>&1; then wl-copy; elif command -v xclip >/dev/null 2>&1; then xclip -selection clipboard; elif command -v xsel >/dev/null 2>&1; then xsel --clipboard --input; elif command -v pbcopy >/dev/null 2>&1; then pbcopy; else cat >/dev/null; fi'"
bind-key -T copy-mode-vi Escape send-keys -X cancel
`)
	return b.String()
}

func terminalEnv() []string {
	shell := userShell()
	env := make([]string, 0, len(os.Environ())+8)
	for _, item := range os.Environ() {
		key, _, ok := strings.Cut(item, "=")
		if !ok {
			env = append(env, item)
			continue
		}
		switch key {
		case "NO_COLOR", "TERM", "COLORTERM", "CLICOLOR", "CLICOLOR_FORCE", "FORCE_COLOR", "SHELL":
			continue
		default:
			env = append(env, item)
		}
	}
	return append(env,
		"TERM=xterm-256color",
		"COLORTERM=truecolor",
		"TERM_PROGRAM=PocketStudio",
		"CLICOLOR=1",
		"CLICOLOR_FORCE=1",
		"FORCE_COLOR=1",
		"SHELL="+shell,
	)
}

func userShell() string {
	if runtime.GOOS != "windows" {
		if zsh, err := exec.LookPath("zsh"); err == nil && zsh != "" {
			return zsh
		}
	}
	if shell := strings.TrimSpace(os.Getenv("SHELL")); shell != "" {
		return shell
	}
	if runtime.GOOS != "windows" {
		if shell := loginShellFromPasswd(); shell != "" {
			return shell
		}
	}
	if runtime.GOOS == "windows" {
		return "cmd"
	}
	return "/bin/sh"
}

func applyTerminalSize(ptyFile *os.File, cols uint16, rows uint16) {
	if ptyFile == nil || cols == 0 || rows == 0 {
		return
	}
	_ = pty.Setsize(ptyFile, &pty.Winsize{Cols: cols, Rows: rows})
}

func resizeTmuxSession(sessionName string, cols uint16, rows uint16) {
	if sessionName == "" || cols == 0 || rows == 0 {
		return
	}
	_ = tmuxCommand("resize-window", "-t", sessionName, "-x", strconv.Itoa(int(cols)), "-y", strconv.Itoa(int(rows))).Run()
}

func terminalSessionName(workspacePath string, terminalID string) string {
	sum := sha1.Sum([]byte(workspacePath + "\x00" + terminalID))
	return "pocket-studio-" + fmt.Sprintf("%x", sum[:10])
}

func initialTerminalTitle(command string, fallback string) string {
	fallback = strings.TrimSpace(fallback)
	if fallback != "" {
		return fallback
	}
	command = strings.TrimSpace(command)
	if command == "" || command == "bash" || command == "zsh" || command == "sh" {
		return "Shell"
	}
	switch {
	case strings.Contains(command, "claude"):
		return "Claude Code"
	case strings.Contains(command, "codex"):
		return "Codex"
	case strings.Contains(command, "opencode"):
		return "OpenCode"
	case strings.Contains(command, "kilo"):
		return "Kilo Code"
	case command == "pi" || strings.HasPrefix(command, "pi "):
		return "Pi"
	case command == "agy" || strings.Contains(command, "antigravity"):
		return "Antigravity"
	default:
		return command
	}
}

func (d *Daemon) writeTerminalStream(req protocol.TerminalStreamData) {
	key := req.ProjectID + "::" + req.TerminalID
	d.termMu.Lock()
	rPty := d.terminalPTYs[key]
	d.termMu.Unlock()

	if rPty != nil {
		_, _ = rPty.ptyFile.Write(req.Data)
	}
}

func (d *Daemon) resizeTerminalStream(req protocol.TerminalStreamResize) {
	key := req.ProjectID + "::" + req.TerminalID
	d.termMu.Lock()
	rPty := d.terminalPTYs[key]
	d.termMu.Unlock()

	if rPty != nil {
		applyTerminalSize(rPty.ptyFile, req.Cols, req.Rows)
		resizeTmuxSession(rPty.sessionName, req.Cols, req.Rows)
	}
}

func (d *Daemon) exitTerminalStream(req protocol.TerminalStreamExit) {
	key := req.ProjectID + "::" + req.TerminalID
	d.termMu.Lock()
	rPty := d.terminalPTYs[key]
	d.termMu.Unlock()

	if rPty != nil {
		_ = rPty.ptyFile.Close()
		if rPty.cmd.Process != nil {
			_ = rPty.cmd.Process.Kill()
		}
	}
}
