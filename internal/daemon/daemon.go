package daemon

import (
	"bufio"
	"bytes"
	"context"
	"crypto/rand"
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

	mu              sync.Mutex
	tasks           map[string]*runningTask
	history         map[string]protocol.TaskRecord
	projects        map[string]protocol.Project
	projectStates   map[string]json.RawMessage
	send            chan protocol.Envelope
	sendBinary      chan []byte
	terminalBinary  bool
	termMu          sync.Mutex
	terminalPTYs    map[string]*runningPTY
	hookURL         string
	hookToken       string
	hookAlerts      map[string]time.Time
	directACP       map[string]*directACPSession
	directACPStarts map[string]*directACPStart
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

type directACPSession struct {
	taskID        string
	agent         string
	session       string
	workspace     string
	modelConfigID string
	configIDs     map[string]string
	client        *directACPClient
	promptMu      sync.Mutex
	resetting     bool
}

type directACPStart struct {
	done chan struct{}
	err  error
}

func New(cfg Config) *Daemon {
	return &Daemon{
		cfg:             cfg,
		tasks:           make(map[string]*runningTask),
		history:         make(map[string]protocol.TaskRecord),
		projects:        make(map[string]protocol.Project),
		projectStates:   make(map[string]json.RawMessage),
		send:            make(chan protocol.Envelope, 128),
		sendBinary:      make(chan []byte, 256),
		terminalPTYs:    make(map[string]*runningPTY),
		hookToken:       randomHookToken(),
		hookAlerts:      make(map[string]time.Time),
		directACP:       make(map[string]*directACPSession),
		directACPStarts: make(map[string]*directACPStart),
	}
}

func (d *Daemon) Run(ctx context.Context) error {
	if stopHookServer, err := d.startTerminalHookServer(ctx); err != nil {
		log.Printf("start terminal hook server: %v", err)
	} else {
		defer stopHookServer()
	}
	if _, err := ensurePocketStudioTmuxConfig(); err != nil {
		log.Printf("ensure tmux config: %v", err)
	}
	if err := d.loadProjectStore(); err != nil {
		log.Printf("load daemon projects: %v", err)
	}
	if err := d.loadProjectStates(); err != nil {
		log.Printf("load daemon project states: %v", err)
	}
	if err := d.loadDirectACPStore(); err != nil {
		log.Printf("load direct acp sessions: %v", err)
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

func daemonDirectACPSessionsPath() string {
	return filepath.Join(daemonConfigDir(), "direct-acp-sessions.json")
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

type directACPStore struct {
	Version int                   `json:"version"`
	Tasks   []protocol.TaskRecord `json:"tasks"`
}

func (d *Daemon) loadDirectACPStore() error {
	raw, err := os.ReadFile(daemonDirectACPSessionsPath())
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil
		}
		return err
	}
	var store directACPStore
	if err := json.Unmarshal(raw, &store); err != nil {
		return err
	}
	d.mu.Lock()
	defer d.mu.Unlock()
	for _, record := range store.Tasks {
		if record.TaskID == "" || !isDirectACPRecord(record) {
			continue
		}
		record.DeviceID = d.cfg.Device.ID
		if record.Status == "running" || record.Status == "stopping" {
			record.Status = "interrupted"
			record.UpdatedAt = protocolNow()
		}
		d.history[record.TaskID] = record
	}
	return nil
}

func (d *Daemon) saveDirectACPStoreLocked() error {
	tasks := make([]protocol.TaskRecord, 0)
	for _, record := range d.history {
		if !isDirectACPRecord(record) {
			continue
		}
		record.Events = normalizedTaskHistoryEvents(record)
		if record.Status == "running" || record.Status == "stopping" {
			record.Status = "interrupted"
		}
		tasks = append(tasks, record)
	}
	sort.Slice(tasks, func(i, j int) bool {
		return tasks[i].UpdatedAt > tasks[j].UpdatedAt
	})
	if err := os.MkdirAll(daemonConfigDir(), 0o755); err != nil {
		return err
	}
	raw, err := json.MarshalIndent(directACPStore{Version: 1, Tasks: tasks}, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(daemonDirectACPSessionsPath(), append(raw, '\n'), 0o600)
}

func isDirectACPRecord(record protocol.TaskRecord) bool {
	return strings.EqualFold(strings.TrimSpace(record.AgentRuntime), "direct_acp")
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
	case "acpx", "online":
		return "ACPX"
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
			d.emitRequestError(requestIDFromEnvelope(env), "bad_payload", err.Error())
			return
		}
		go d.createSession(ctx, session)
	case protocol.TypeTaskDispatch:
		task, err := protocol.DecodePayload[protocol.TaskDispatch](env)
		if err != nil {
			d.emitRequestError(requestIDFromEnvelope(env), "bad_payload", err.Error())
			return
		}
		go d.startTask(ctx, task)
	case protocol.TypeTaskStop:
		stop, err := protocol.DecodePayload[protocol.TaskStop](env)
		if err != nil {
			d.emitRequestError(requestIDFromEnvelope(env), "bad_payload", err.Error())
			return
		}
		d.stopTask(stop.TaskID)
	case protocol.TypeTaskSetModel:
		change, err := protocol.DecodePayload[protocol.TaskSetModel](env)
		if err != nil {
			d.emitRequestError(requestIDFromEnvelope(env), "bad_payload", err.Error())
			return
		}
		go d.setTaskModel(ctx, change)
	case protocol.TypeTaskSetConfigOption:
		change, err := protocol.DecodePayload[protocol.TaskSetConfigOption](env)
		if err != nil {
			d.emitRequestError(requestIDFromEnvelope(env), "bad_payload", err.Error())
			return
		}
		go d.setTaskConfigOption(ctx, change)
	case protocol.TypeTaskHistoryGet:
		request, err := protocol.DecodePayload[protocol.TaskHistoryGet](env)
		if err != nil {
			d.emitRequestError(requestIDFromEnvelope(env), "bad_payload", err.Error())
			return
		}
		d.sendTaskHistory(request)
	case protocol.TypeSessionDelete:
		remove, err := protocol.DecodePayload[protocol.SessionDelete](env)
		if err != nil {
			d.emitRequestError(requestIDFromEnvelope(env), "bad_payload", err.Error())
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
	if !d.supportsTaskAgentForRuntime(session.Agent, session.AgentRuntime) {
		d.emitError(session.TaskID, "unsupported_agent", "unsupported agent")
		return
	}
	task := protocol.TaskDispatch{
		RequestID:     session.RequestID,
		TaskID:        session.TaskID,
		WorkspaceID:   workspace.ID,
		WorkspacePath: workspace.Path,
		Agent:         session.Agent,
		AgentRuntime:  session.AgentRuntime,
		SessionName:   session.SessionName,
		Options:       session.Options,
	}
	ctx, cancel := context.WithCancel(parent)
	defer cancel()
	if isDirectACPRuntime(session.AgentRuntime) {
		if err := d.ensureDirectACPSession(ctx, task, workspace.Path, session.TaskID); err != nil {
			d.emitError(session.TaskID, "session_ensure_failed", err.Error())
			return
		}
	} else if d.cfg.ACPX.Enabled {
		if _, sessionName, err := d.ensureACPXSession(ctx, task, workspace.Path, session.TaskID); err != nil {
			d.emitError(session.TaskID, "session_ensure_failed", err.Error())
			return
		} else if sessionName != "" {
			session.SessionName = sessionName
			task.SessionName = sessionName
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
	record.AgentRuntime = task.AgentRuntime
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

func (d *Daemon) sendTaskHistory(request protocol.TaskHistoryGet) {
	d.mu.Lock()
	record := d.history[request.TaskID]
	d.mu.Unlock()

	result := protocol.TaskHistoryResult{
		RequestID: request.RequestID,
		TaskID:    request.TaskID,
	}
	if record.TaskID != "" {
		record.Events = normalizedTaskHistoryEvents(record)
		result.Record = &record
		result.Events = append([]protocol.TaskEvent(nil), record.Events...)
	}
	d.send <- protocol.NewEnvelope(protocol.TypeTaskHistoryResult, "daemon", result)
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
	if !d.supportsTaskAgentForRuntime(task.Agent, task.AgentRuntime) {
		d.emitError(task.TaskID, "unsupported_agent", "unsupported agent")
		return
	}

	if isDirectACPRuntime(task.AgentRuntime) {
		d.startDirectACPTask(parent, task, workspace)
		return
	}

	ctx, cancel := context.WithCancel(parent)
	command, args, source := d.buildAgentCommand(task, workspace.Path)
	if d.cfg.ACPX.Enabled {
		if _, sessionName, err := d.ensureACPXSession(ctx, task, workspace.Path, task.TaskID); err != nil {
			cancel()
			d.emitError(task.TaskID, "session_ensure_failed", err.Error())
			return
		} else if sessionName != "" {
			task.SessionName = sessionName
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
	record.AgentRuntime = task.AgentRuntime
	record.SessionName = taskSessionName(task, d.cfg.ACPX.SessionName)
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
		errorText := waitErr.Error()
		if acpxErr := strings.TrimSpace(emitter.errorText()); acpxErr != "" {
			errorText = acpxErr
		}
		emitter.emit("task.failed", map[string]any{"error": errorText}, nil)
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

func (d *Daemon) supportsTaskAgentForRuntime(agent string, runtime string) bool {
	if isDirectACPRuntime(runtime) {
		_, ok := d.directACPAgentConfig(agent)
		return ok
	}
	return d.supportsTaskAgent(agent)
}

func isDirectACPRuntime(runtime string) bool {
	return strings.EqualFold(strings.TrimSpace(runtime), "direct_acp")
}

func (d *Daemon) directACPAgentConfig(agent string) (DirectACPAgentConfig, bool) {
	if !d.cfg.DirectACP.Enabled {
		return DirectACPAgentConfig{}, false
	}
	agent = taskAgentName(protocol.TaskDispatch{Agent: agent}, "")
	if agent == "" {
		return DirectACPAgentConfig{}, false
	}
	cfg, ok := d.cfg.DirectACP.Agents[agent]
	if !ok || strings.TrimSpace(cfg.Command) == "" {
		return DirectACPAgentConfig{}, false
	}
	return cfg, true
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
	args = append(args, "prompt")
	if sessionName := d.acpxSessionNameForTask(task); sessionName != "" {
		args = append(args, "--session", sessionName)
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

func (d *Daemon) acpxSessionNameForTask(task protocol.TaskDispatch) string {
	if sessionName := taskSessionName(task, d.cfg.ACPX.SessionName); sessionName != "" {
		return sessionName
	}
	recordID := strings.TrimSpace(task.TaskID)
	if recordID == "" {
		return ""
	}
	d.mu.Lock()
	if record := d.history[recordID]; record.SessionName != "" {
		d.mu.Unlock()
		return record.SessionName
	}
	d.mu.Unlock()
	if record := readACPXSessionDiskRecord(recordID); record != nil {
		return stringField(record, "name")
	}
	return ""
}

func (d *Daemon) buildACPXCancelArgs(workspacePath string, agent string, sessionName string) []string {
	args := d.buildACPXGlobalArgs(workspacePath)
	args = append(args, agent, "cancel")
	if sessionName != "" {
		args = append(args, "--session", sessionName)
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
		args = append(args, "--session", sessionName)
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
	agent := taskAgentName(task, d.cfg.ACPX.Agent)
	if agent != "opencode" && agent != "codex" {
		args = ensureACPXModel(args, task.ModelID)
	}
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
	mu        sync.Mutex
	sequence  int64
	daemon    *Daemon
	taskID    string
	endTurn   bool
	lastError string
}

func (e *taskEmitter) emit(eventType string, data any, raw json.RawMessage) {
	e.daemon.emitTaskEventWithNextSequence(e.taskID, eventType, data, raw)
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

func (e *taskEmitter) markError(text string) {
	text = strings.TrimSpace(text)
	if text == "" {
		return
	}
	e.mu.Lock()
	defer e.mu.Unlock()
	e.lastError = text
}

func (e *taskEmitter) errorText() string {
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.lastError
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

func (d *Daemon) ensureACPXSession(ctx context.Context, task protocol.TaskDispatch, workspacePath string, taskID string) (string, string, error) {
	return d.syncACPXSession(ctx, task, workspacePath, taskID, "ensure")
}

func (d *Daemon) createACPXSession(ctx context.Context, task protocol.TaskDispatch, workspacePath string, taskID string) (string, string, error) {
	return d.syncACPXSession(ctx, task, workspacePath, taskID, "new")
}

func (d *Daemon) syncACPXSession(ctx context.Context, task protocol.TaskDispatch, workspacePath string, taskID string, command string) (string, string, error) {
	agentName := taskAgentName(task, d.cfg.ACPX.Agent)
	var conflictingDirectACPs []string
	d.mu.Lock()
	for id, session := range d.directACP {
		if session.agent == agentName {
			conflictingDirectACPs = append(conflictingDirectACPs, id)
		}
	}
	d.mu.Unlock()

	for _, id := range conflictingDirectACPs {
		log.Printf("[Daemon] Stopping conflicting Direct ACP session %q for agent %q because ACPX command %q is starting", id, agentName, command)
		d.stopDirectACPTask(id)
	}

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
		return "", "", fmt.Errorf("%s: %s", err, text)
	}
	recordID := ""
	sessionName := taskSessionName(task, d.cfg.ACPX.SessionName)
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
			recordID = stringField(session, "acpxRecordId")
			sessionName = firstNonEmpty(stringField(session, "name"), sessionName)
			for _, key := range []string{"acpxRecordId", "acpxSessionId", "agentSessionId", "name"} {
				if value, ok := session[key]; ok {
					data[key] = value
				}
			}
		}
		d.emitTaskEvent(taskID, "acpx.session", 0, data, raw)
	}
	d.emitACPXStatus(ctx, task, workspacePath, taskID)
	return recordID, sessionName, nil
}

func (d *Daemon) emitACPXStatus(ctx context.Context, task protocol.TaskDispatch, workspacePath string, taskID string) {
	args := d.buildACPXGlobalArgs(workspacePath)
	args = append(args, taskAgentName(task, d.cfg.ACPX.Agent), "status")
	if sessionName := taskSessionName(task, d.cfg.ACPX.SessionName); sessionName != "" {
		args = append(args, "--session", sessionName)
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
			d.emitTaskEvent(taskID, "acpx.status", 0, data, append(json.RawMessage(nil), raw...))
			if !d.emitACPXModelList(taskID, status) {
				d.emitACPXModelListFromSessions(ctx, task, workspacePath, taskID)
			}
			return
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

func (d *Daemon) emitACPXModelList(taskID string, status map[string]any) bool {
	if status == nil {
		return false
	}
	if acpx, _ := status["acpx"].(map[string]any); acpx != nil {
		if raw := acpxModelListRaw(status, acpx); raw != nil {
			d.emitTaskEvent(taskID, "model.list", 0, raw, mustJSON(raw))
			return true
		}
		return false
	}
	if raw := acpxModelListRaw(status, status); raw != nil {
		d.emitTaskEvent(taskID, "model.list", 0, raw, mustJSON(raw))
		return true
	}
	return false
}

func (d *Daemon) emitACPXModelListFromSessions(ctx context.Context, task protocol.TaskDispatch, workspacePath string, taskID string) {
	listCtx, cancel := context.WithTimeout(ctx, 8*time.Second)
	defer cancel()
	agent := taskAgentName(task, d.cfg.ACPX.Agent)
	cmd := exec.CommandContext(listCtx, d.cfg.ACPX.Command, d.buildACPXSessionListArgs(workspacePath, agent)...)
	cmd.Dir = workspacePath
	var stdout bytes.Buffer
	cmd.Stdout = &stdout
	if err := cmd.Run(); err != nil {
		return
	}
	var records []map[string]any
	if err := json.Unmarshal(bytes.TrimSpace(stdout.Bytes()), &records); err != nil {
		return
	}
	sessionName := taskSessionName(task, d.cfg.ACPX.SessionName)
	for _, record := range records {
		if stringField(record, "name") != sessionName {
			continue
		}
		acpx, _ := record["acpx"].(map[string]any)
		if acpx == nil {
			continue
		}
		if raw := acpxModelListRaw(record, acpx); raw != nil {
			d.emitTaskEvent(taskID, "model.list", 0, raw, mustJSON(raw))
		}
		return
	}
}

func (d *Daemon) scanTextOutput(r io.Reader, stream string, emitter *taskEmitter) {
	scanner := bufio.NewScanner(r)
	scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	for scanner.Scan() {
		text := scanner.Text()
		if d.cfg.ACPX.Enabled {
			emitter.markError(extractACPXErrorText(text))
		}
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

func extractACPXErrorText(text string) string {
	text = strings.TrimSpace(text)
	if text == "" || !json.Valid([]byte(text)) {
		return ""
	}
	var msg map[string]any
	if err := json.Unmarshal([]byte(text), &msg); err != nil {
		return ""
	}
	errObj, _ := msg["error"].(map[string]any)
	if errObj == nil {
		return ""
	}
	message := stringField(errObj, "message")
	detail := ""
	if data, _ := errObj["data"].(map[string]any); data != nil {
		detail = stringField(data, "detailCode", "acpxCode")
	}
	if message == "" {
		message = stringifyValue(errObj)
	}
	if detail != "" {
		return message + " (" + detail + ")"
	}
	return message
}

type agentOutputAdapter struct {
	emitter            *taskEmitter
	streamPrefix       string
	assistantText      strings.Builder
	assistantRaw       json.RawMessage
	assistantStreaming bool
	assistantStreamID  string
	thinkingText       strings.Builder
	thinkingRaw        json.RawMessage
	thinkingStreaming  bool
	thinkingStreamID   string
	streamCounter      int64
}

func newAgentOutputAdapter(emitter *taskEmitter) *agentOutputAdapter {
	return &agentOutputAdapter{
		emitter:      emitter,
		streamPrefix: protocol.NewID("stream"),
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
	if a.assistantStreaming {
		a.assistantStreaming = false
		a.assistantStreamID = ""
		return
	}
	a.assistantStreamID = ""
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
	if a.thinkingStreaming {
		a.thinkingStreaming = false
		a.thinkingStreamID = ""
		return
	}
	a.thinkingStreamID = ""
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
		if text := extractACPXErrorText(string(raw)); text != "" {
			a.flush()
			a.emitter.markError(text)
			a.emitter.emit("task.error", map[string]string{"error": text}, raw)
			return true
		}
		if method == "session/request_permission" {
			a.flush()
			a.emitter.emit("permission.request", nil, raw)
			return true
		}
		if _, ok := msg["result"]; ok {
			endTurn := false
			if result, _ := msg["result"].(map[string]any); stringField(result, "stopReason") == "end_turn" {
				a.emitter.markEndTurn()
				endTurn = true
			}
			a.flush()
			if endTurn {
				a.emitter.emit("turn.completed", map[string]string{"stop_reason": "end_turn"}, nil)
			}
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
		a.emitRawToolUpdate(update, raw)
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
	a.assistantStreaming = true
	if a.assistantStreamID == "" {
		a.streamCounter++
		a.assistantStreamID = fmt.Sprintf("%s-assistant-%d", a.streamPrefix, a.streamCounter)
	}
	a.emitter.emit("assistant.message", map[string]any{
		"text":      a.assistantText.String(),
		"replace":   true,
		"stream_id": a.assistantStreamID,
	}, raw)
}

func (a *agentOutputAdapter) appendThinkingChunk(update map[string]any, raw json.RawMessage) {
	text := textFromACPXContent(update["content"])
	if text == "" {
		return
	}
	a.thinkingText.WriteString(text)
	a.thinkingRaw = raw
	a.thinkingStreaming = true
	if a.thinkingStreamID == "" {
		a.streamCounter++
		a.thinkingStreamID = fmt.Sprintf("%s-thinking-%d", a.streamPrefix, a.streamCounter)
	}
	a.emitter.emit("assistant.thinking", map[string]any{
		"text":      a.thinkingText.String(),
		"replace":   true,
		"stream_id": a.thinkingStreamID,
	}, raw)
}

func (a *agentOutputAdapter) emitRawToolUpdate(update map[string]any, raw json.RawMessage) {
	id := stringField(update, "toolCallId", "tool_call_id", "id")
	if id == "" {
		id = protocol.NewID("tool")
	}
	data := map[string]any{
		"tool_use_id": id,
		"name":        stringField(update, "title", "kind", "name"),
		"status":      stringField(update, "status"),
		"input":       update["rawInput"],
		"output":      update["rawOutput"],
	}
	eventType := "tool.call"
	if hasAnyKey(update, "rawOutput") {
		eventType = "tool.output"
	} else if status := stringField(update, "status"); statusIndicatesError(status) {
		eventType = "tool.output"
	}
	a.emitter.emit(eventType, data, raw)
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
	if d.stopDirectACPTask(taskID) {
		return
	}
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
	if rt.cmd != nil {
		terminateProcess(rt.cmd)
	}
	select {
	case <-rt.done:
	case <-time.After(5 * time.Second):
		if rt.cmd != nil {
			killProcess(rt.cmd)
		}
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
		if taskID == "" {
			d.emitRequestError(change.RequestID, "bad_payload", "task.set_model requires task_id and model_id")
			return
		}
		d.emitError(taskID, "bad_payload", "task.set_model requires task_id and model_id")
		return
	}
	if d.setDirectACPModel(parent, change) {
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

func (d *Daemon) setTaskConfigOption(parent context.Context, change protocol.TaskSetConfigOption) {
	taskID := strings.TrimSpace(change.TaskID)
	configID := strings.TrimSpace(change.ConfigID)
	if taskID == "" || configID == "" {
		if taskID == "" {
			d.emitRequestError(change.RequestID, "bad_payload", "task.set_config_option requires task_id and config_id")
			return
		}
		d.emitError(taskID, "bad_payload", "task.set_config_option requires task_id and config_id")
		return
	}
	if d.setDirectACPConfigOption(parent, change) {
		return
	}
	d.emitTaskEvent(taskID, "config.update_failed", 0, map[string]string{
		"config_id": configID,
		"value":     change.Value,
		"error":     "config options require direct ACP",
	}, nil)
}

func (d *Daemon) deleteSession(parent context.Context, remove protocol.SessionDelete) {
	taskID := strings.TrimSpace(remove.TaskID)
	if taskID == "" {
		d.emitRequestError(remove.RequestID, "bad_payload", "session.delete requires task_id")
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
	}
	if isDirectACPRuntime(firstNonEmpty(remove.AgentRuntime, record.AgentRuntime)) {
		d.deleteDirectACPSession(taskID)
	} else if d.cfg.ACPX.Enabled && workspacePath != "" {
		if err := d.deleteACPXSession(parent, rt, workspacePath, agent, sessionName); err != nil {
			text := strings.TrimSpace(err.Error())
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

func (d *Daemon) deleteACPXSession(parent context.Context, rt *runningTask, workspacePath string, agent string, sessionName string) error {
	if rt != nil {
		if rt.acpx {
			d.cancelACPXTask(rt)
		}
		if rt.cancel != nil {
			rt.cancel()
		}
	}
	ctx, cancel := context.WithTimeout(parent, 20*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, d.cfg.ACPX.Command, d.buildACPXSessionCloseArgs(workspacePath, agent, sessionName)...)
	cmd.Dir = workspacePath
	var stderr bytes.Buffer
	var stdout bytes.Buffer
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
		return errors.New(text)
	}
	return nil
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
	cmd.Env = taskEnv()
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
				if existing := d.history[record.TaskID]; existing.TaskID != "" && isDirectACPRecord(existing) {
					continue
				}
				if existing := d.history[record.TaskID]; len(existing.Events) > 0 {
					record.Events = compactStreamTaskEvents(mergeTaskEvents(record.Events, existing.Events))
					if existing.Status == "running" || existing.Status == "stopping" {
						record.Status = existing.Status
					}
					if existing.UpdatedAt > record.UpdatedAt {
						record.UpdatedAt = existing.UpdatedAt
					}
				}
				d.history[record.TaskID] = record
			}
			d.mu.Unlock()
		} else {
			log.Printf("acpx sessions list failed: %v", err)
		}
	}
	d.mu.Lock()
	tasks := make([]protocol.TaskRecord, 0, len(d.history))
	for _, record := range d.history {
		record.Events = normalizedTaskHistoryEvents(record)
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
	taskByID := make(map[string]protocol.TaskRecord, len(records))
	for _, item := range records {
		recordID := stringField(item, "acpxRecordId")
		if recordID == "" {
			continue
		}
		if !isRunningACPXSessionRecord(item) {
			item = mergeACPXSessionDiskRecord(item, recordID)
		}
		sessionName := stringField(item, "name")
		closed, _ := item["closed"].(bool)
		taskID := acpxTaskIDForRecord(recordID, sessionName)
		cwd := stringField(item, "cwd")
		modelID := ""
		if acpx, _ := item["acpx"].(map[string]any); acpx != nil {
			modelID = stringField(acpx, "current_model_id")
		}
		status := "created"
		if closed {
			status = "closed"
		}
		createdAt := parseACPXTime(stringField(item, "createdAt"))
		updatedAt := parseACPXTime(stringField(item, "lastUsedAt"))
		if updatedAt == 0 {
			updatedAt = parseACPXTime(stringField(item, "updated_at"))
		}
		if updatedAt == 0 {
			updatedAt = createdAt
		}
		events := acpxSessionHistoryEvents(taskID, item, createdAt, updatedAt)
		if !isRunningACPXSessionRecord(item) {
			events = appendMissingACPXPromptEvents(events, taskID, recordID, createdAt, updatedAt)
		}
		prompt := latestPromptFromEvents(events)
		record := protocol.TaskRecord{
			TaskID:        taskID,
			DeviceID:      d.cfg.Device.ID,
			WorkspaceID:   workspaceIDForPath(cwd),
			WorkspacePath: cwd,
			Agent:         agent,
			AgentRuntime:  "acpx",
			SessionName:   sessionName,
			ModelID:       modelID,
			Prompt:        prompt,
			Status:        status,
			SessionID:     recordID,
			StartedAt:     createdAt,
			UpdatedAt:     updatedAt,
			Events:        events,
		}
		if previous, ok := taskByID[taskID]; ok && preferACPXTaskRecord(previous, record) {
			continue
		}
		taskByID[taskID] = record
	}
	tasks := make([]protocol.TaskRecord, 0, len(taskByID))
	for _, record := range taskByID {
		tasks = append(tasks, record)
	}
	sort.Slice(tasks, func(i, j int) bool {
		return tasks[i].UpdatedAt > tasks[j].UpdatedAt
	})
	return tasks, nil
}

func preferACPXTaskRecord(existing protocol.TaskRecord, candidate protocol.TaskRecord) bool {
	existingEvents := len(existing.Events)
	candidateEvents := len(candidate.Events)
	if existingEvents != candidateEvents {
		return existingEvents > candidateEvents
	}
	if existing.Prompt != "" && candidate.Prompt == "" {
		return true
	}
	if existing.Prompt == "" && candidate.Prompt != "" {
		return false
	}
	return existing.UpdatedAt >= candidate.UpdatedAt
}

func acpxTaskIDForRecord(recordID string, sessionName string) string {
	if sessionName != "" {
		return sessionName
	}
	return recordID
}

func isRunningACPXSessionRecord(record map[string]any) bool {
	if closed, ok := record["closed"].(bool); ok {
		return !closed
	}
	status := strings.ToLower(strings.TrimSpace(stringField(record, "status", "state")))
	switch status {
	case "closed", "completed", "complete", "failed", "cancelled", "canceled", "interrupted", "stopped":
		return false
	case "running", "active", "created", "pending", "working":
		return true
	}
	return true
}

func mergeACPXSessionDiskRecord(record map[string]any, recordID string) map[string]any {
	disk := readACPXSessionDiskRecord(recordID)
	if disk == nil {
		return record
	}
	merged := make(map[string]any, len(disk)+len(record))
	for key, value := range disk {
		merged[key] = value
	}
	for key, value := range record {
		if isEmptyACPXRecordValue(value) {
			continue
		}
		merged[key] = value
	}
	return merged
}

func readACPXSessionDiskRecord(recordID string) map[string]any {
	path := acpxSessionFilePath(recordID, ".json")
	raw, err := os.ReadFile(path)
	if err != nil || len(bytes.TrimSpace(raw)) == 0 {
		return nil
	}
	var record map[string]any
	if err := json.Unmarshal(raw, &record); err != nil {
		return nil
	}
	return record
}

func acpxSessionFilePath(recordID string, suffix string) string {
	if home, err := os.UserHomeDir(); err == nil && home != "" {
		return filepath.Join(home, ".acpx", "sessions", recordID+suffix)
	}
	return filepath.Join(".acpx", "sessions", recordID+suffix)
}

func isEmptyACPXRecordValue(value any) bool {
	switch typed := value.(type) {
	case nil:
		return true
	case string:
		return strings.TrimSpace(typed) == ""
	case []any:
		return len(typed) == 0
	case map[string]any:
		return len(typed) == 0
	default:
		return false
	}
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

func appendMissingACPXPromptEvents(events []protocol.TaskEvent, taskID string, recordID string, createdAt int64, updatedAt int64) []protocol.TaskEvent {
	if hasACPXUserPromptEvent(events) {
		return events
	}
	prompts := acpxPromptsFromStream(recordID)
	if len(prompts) == 0 {
		return events
	}
	seq := int64(len(events) + 1)
	for _, prompt := range prompts {
		prompt = strings.TrimSpace(prompt)
		if prompt == "" {
			continue
		}
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
		raw := map[string]any{
			"jsonrpc": "2.0",
			"method":  "session/prompt",
			"params": map[string]any{
				"sessionId": recordID,
				"prompt":    []any{map[string]any{"type": "text", "text": prompt}},
			},
		}
		events = append(events, protocol.TaskEvent{
			TaskID:    taskID,
			EventID:   fmt.Sprintf("%s_%d", taskID, seq),
			EventType: "user.prompt",
			Source:    "acpx",
			Sequence:  seq,
			Timestamp: timestamp,
			Data:      mustJSON(map[string]any{"prompt": prompt}),
			Raw:       mustJSON(raw),
		})
		seq++
	}
	return events
}

func hasACPXUserPromptEvent(events []protocol.TaskEvent) bool {
	for _, event := range events {
		if event.EventType == "user.prompt" {
			return true
		}
	}
	return false
}

func acpxPromptsFromStream(recordID string) []string {
	path := acpxSessionFilePath(recordID, ".stream.ndjson")
	file, err := os.Open(path)
	if err != nil {
		return nil
	}
	defer file.Close()
	prompts := make([]string, 0)
	scanner := bufio.NewScanner(file)
	scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	for scanner.Scan() {
		var msg map[string]any
		if err := json.Unmarshal(scanner.Bytes(), &msg); err != nil {
			continue
		}
		if stringField(msg, "method") != "session/prompt" {
			continue
		}
		params, _ := msg["params"].(map[string]any)
		if params == nil {
			continue
		}
		prompt := acpxContentText(params["prompt"])
		if strings.TrimSpace(prompt) != "" {
			prompts = append(prompts, prompt)
		}
	}
	return prompts
}

func acpxModelListRaw(record map[string]any, acpx map[string]any) map[string]any {
	available, ok := acpx["available_models"].([]any)
	if !ok || len(available) == 0 {
		if modelConfig := acpxModelConfigOption(acpx); modelConfig != nil {
			available, _ = modelConfig["options"].([]any)
		}
	}
	models := make([]any, 0, len(available))
	for _, value := range available {
		id, name := acpxModelOptionIDName(value)
		if id == "" {
			continue
		}
		models = append(models, map[string]any{"modelId": id, "name": firstNonEmpty(name, id)})
	}
	if len(models) == 0 {
		return nil
	}
	currentModelID := stringField(acpx, "current_model_id", "currentModelId")
	if currentModelID == "" {
		if modelConfig := acpxModelConfigOption(acpx); modelConfig != nil {
			currentModelID = stringField(modelConfig, "currentValue", "current_value", "value")
		}
	}
	return map[string]any{
		"jsonrpc": "2.0",
		"id":      2,
		"result": map[string]any{
			"sessionId": stringField(record, "acpSessionId", "acpxRecordId"),
			"models": map[string]any{
				"currentModelId":  currentModelID,
				"availableModels": models,
			},
		},
	}
}

func acpxModelConfigOption(acpx map[string]any) map[string]any {
	options, _ := acpx["config_options"].([]any)
	if len(options) == 0 {
		options, _ = acpx["configOptions"].([]any)
	}
	for _, value := range options {
		option, _ := value.(map[string]any)
		if option == nil {
			continue
		}
		category := strings.ToLower(strings.TrimSpace(stringField(option, "category")))
		id := strings.TrimSpace(stringField(option, "id", "configId", "config_id"))
		if category == "model" || id == "model" {
			return option
		}
	}
	return nil
}

func acpxModelOptionIDName(value any) (string, string) {
	if record, _ := value.(map[string]any); record != nil {
		id := strings.TrimSpace(firstNonEmpty(
			stringField(record, "value", "modelId", "model_id", "id"),
			fmt.Sprint(record["name"]),
		))
		name := strings.TrimSpace(firstNonEmpty(stringField(record, "name", "label"), id))
		return id, name
	}
	id := strings.TrimSpace(fmt.Sprint(value))
	return id, id
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
		return compactStreamTaskEvents(append([]protocol.TaskEvent(nil), extra...))
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
	return compactStreamTaskEvents(merged)
}

func compactStreamTaskEvents(events []protocol.TaskEvent) []protocol.TaskEvent {
	if len(events) == 0 {
		return events
	}
	compacted := make([]protocol.TaskEvent, 0, len(events))
	streamIndexes := make(map[string]int)
	streamTexts := make(map[string]string)
	for _, event := range events {
		key, data, ok := streamTaskEventKey(event)
		if !ok {
			compacted = append(compacted, event)
			continue
		}
		text, _ := data["text"].(string)
		if appendValue, _ := data["append"].(bool); appendValue {
			text = streamTexts[key] + text
		}
		streamTexts[key] = text
		data["text"] = text
		data["replace"] = true
		delete(data, "append")
		if raw, err := json.Marshal(data); err == nil {
			event.Data = raw
		}
		if index, ok := streamIndexes[key]; ok {
			event.EventID = compacted[index].EventID
			event.Sequence = compacted[index].Sequence
			event.Timestamp = compacted[index].Timestamp
			compacted[index] = event
			continue
		}
		streamIndexes[key] = len(compacted)
		compacted = append(compacted, event)
	}
	return compacted
}

func streamTaskEventKey(event protocol.TaskEvent) (string, map[string]any, bool) {
	if event.EventType != "assistant.message" && event.EventType != "assistant.thinking" {
		return "", nil, false
	}
	if len(event.Data) == 0 {
		return "", nil, false
	}
	var data map[string]any
	if err := json.Unmarshal(event.Data, &data); err != nil {
		return "", nil, false
	}
	streamID, _ := data["stream_id"].(string)
	if strings.TrimSpace(streamID) == "" {
		return "", nil, false
	}
	return event.EventType + ":" + streamID, data, true
}

func taskEventSignature(event protocol.TaskEvent) string {
	if len(event.Data) > 0 {
		return event.EventType + ":" + string(event.Data)
	}
	if len(event.Raw) > 0 {
		return event.EventType + ":" + string(event.Raw)
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

func (d *Daemon) emitRequestError(requestID, code, message string) {
	d.send <- protocol.NewEnvelope(protocol.TypeServerError, "daemon", protocol.ServerError{
		Code:      code,
		Message:   message,
		RequestID: requestID,
	})
}

func requestIDFromEnvelope(env protocol.Envelope) string {
	var obj map[string]any
	if err := json.Unmarshal(env.Payload, &obj); err != nil {
		return ""
	}
	requestID, _ := obj["request_id"].(string)
	return requestID
}

func (d *Daemon) emitTaskEventWithNextSequence(taskID, eventType string, data any, raw json.RawMessage) {
	d.mu.Lock()
	record := d.history[taskID]
	seq := nextHistoryEventSequence(record.Events)

	var dataRaw json.RawMessage
	if data != nil {
		dataRaw, _ = json.Marshal(data)
	}
	event := protocol.TaskEvent{
		TaskID:    taskID,
		EventID:   protocol.NewID("evt"),
		EventType: eventType,
		Source:    "claude_code",
		Sequence:  seq,
		Timestamp: time.Now().Unix(),
		Data:      dataRaw,
		Raw:       raw,
	}

	record.Status = statusFromEvent(event.EventType, record.Status)
	now := time.Now().Unix()
	if record.StartedAt == 0 {
		record.StartedAt = now
	}
	record.UpdatedAt = now
	record.Events = append(record.Events, event)
	d.history[taskID] = record
	if isDirectACPRecord(record) {
		if err := d.saveDirectACPStoreLocked(); err != nil {
			log.Printf("save direct acp sessions: %v", err)
		}
	}
	d.mu.Unlock()

	d.send <- protocol.NewEnvelope(protocol.TypeTaskEvent, "daemon", event)
	d.maybeSendAgentCompletionAlert(record, event)
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

func userPromptTaskEvent(taskID, prompt string, timestamp int64, sequence int64) protocol.TaskEvent {
	prompt = strings.TrimSpace(prompt)
	if taskID == "" || prompt == "" {
		return protocol.TaskEvent{}
	}
	dataRaw, _ := json.Marshal(map[string]string{"prompt": prompt})
	if timestamp == 0 {
		timestamp = time.Now().Unix()
	}
	return protocol.TaskEvent{
		TaskID:    taskID,
		EventID:   protocol.NewID("evt"),
		EventType: "user.prompt",
		Source:    "web",
		Sequence:  sequence,
		Timestamp: timestamp,
		Data:      dataRaw,
	}
}

func normalizedTaskHistoryEvents(record protocol.TaskRecord) []protocol.TaskEvent {
	events := compactStreamTaskEvents(record.Events)
	if strings.TrimSpace(record.Prompt) == "" || hasUserPromptEvent(events) {
		return events
	}
	promptEvent := userPromptTaskEvent(record.TaskID, record.Prompt, firstNonZero(record.StartedAt, record.UpdatedAt, protocolNow()), 0)
	if promptEvent.TaskID == "" {
		return events
	}
	promptEvent.EventID = "history-user-prompt-" + record.TaskID
	insertAt := promptEventInsertIndex(events)
	events = append(events, protocol.TaskEvent{})
	copy(events[insertAt+1:], events[insertAt:])
	events[insertAt] = promptEvent
	return events
}

func hasUserPromptEvent(events []protocol.TaskEvent) bool {
	for _, event := range events {
		if event.EventType == "user.prompt" {
			return true
		}
	}
	return false
}

func promptEventInsertIndex(events []protocol.TaskEvent) int {
	lastTaskStarted := -1
	for idx, event := range events {
		if event.EventType == "task.started" {
			lastTaskStarted = idx
		}
	}
	if lastTaskStarted >= 0 {
		return lastTaskStarted
	}
	return 0
}

func firstNonZero(values ...int64) int64 {
	for _, value := range values {
		if value != 0 {
			return value
		}
	}
	return 0
}

func nextHistoryEventSequence(events []protocol.TaskEvent) int64 {
	var maxSeq int64
	for _, event := range events {
		if event.Sequence > maxSeq {
			maxSeq = event.Sequence
		}
	}
	return maxSeq + 1
}

func (d *Daemon) recordTaskEvent(event protocol.TaskEvent) {
	var record protocol.TaskRecord
	d.mu.Lock()
	record = d.history[event.TaskID]
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
	record.Events = append(record.Events, event)
	d.history[event.TaskID] = record
	if isDirectACPRecord(record) {
		if err := d.saveDirectACPStoreLocked(); err != nil {
			log.Printf("save direct acp sessions: %v", err)
		}
	}
	d.mu.Unlock()
	d.maybeSendAgentCompletionAlert(record, event)
}

func (d *Daemon) maybeSendAgentCompletionAlert(record protocol.TaskRecord, event protocol.TaskEvent) {
	if !isAgentCompletionEvent(event.EventType) {
		return
	}
	if !isAgentChatRecord(record) {
		return
	}
	projectID := d.projectIDForWorkspacePath(record.WorkspacePath)
	if projectID == "" {
		return
	}
	tabID := d.agentNotificationTabID(projectID, record)
	message := agentCompletionMessage(event.EventType)
	alert := d.agentCompletionAlert(projectID, tabID, record.Agent, record.AgentRuntime, message)
	if alert == nil {
		return
	}
	d.send <- protocol.NewEnvelope(protocol.TypeTerminalStreamAlert, "daemon", *alert)
}

func isAgentCompletionEvent(eventType string) bool {
	return eventType == "task.completed" || eventType == "task.failed" || eventType == "task.killed"
}

func isAgentChatRecord(record protocol.TaskRecord) bool {
	runtime := strings.ToLower(strings.TrimSpace(record.AgentRuntime))
	return runtime == "acpx" || runtime == "direct_acp"
}

func agentCompletionMessage(eventType string) string {
	switch eventType {
	case "task.failed":
		return "任务执行失败"
	case "task.killed":
		return "任务已取消"
	default:
		return "任务已完成"
	}
}

func (d *Daemon) agentNotificationTabID(projectID string, record protocol.TaskRecord) string {
	taskID := strings.TrimSpace(record.TaskID)
	sessionName := strings.TrimSpace(record.SessionName)
	d.mu.Lock()
	raw := append(json.RawMessage(nil), d.projectStates[projectID]...)
	d.mu.Unlock()
	if tabID := agentTabIDFromProjectState(raw, taskID, sessionName); tabID != "" {
		return tabID
	}
	return taskID
}

func agentTabIDFromProjectState(raw json.RawMessage, taskID string, sessionName string) string {
	if len(raw) == 0 {
		return ""
	}
	var state struct {
		LayoutTree any `json:"layoutTree"`
	}
	if json.Unmarshal(raw, &state) != nil {
		return ""
	}
	var found string
	var walk func(any)
	walk = func(value any) {
		if found != "" {
			return
		}
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
				if kind, _ := tab["kind"].(string); kind != "agent_chat" {
					continue
				}
				agentSessionID, _ := tab["agentSessionId"].(string)
				if agentSessionID == "" || (agentSessionID != taskID && agentSessionID != sessionName) {
					continue
				}
				found, _ = tab["id"].(string)
				return
			}
			return
		}
		children, _ := obj["children"].([]any)
		for _, child := range children {
			walk(child)
		}
	}
	walk(state.LayoutTree)
	return found
}

func (d *Daemon) agentCompletionAlert(projectID string, tabID string, agent string, runtime string, message string) *protocol.TerminalStreamAlert {
	projectID = strings.TrimSpace(projectID)
	tabID = strings.TrimSpace(tabID)
	agent = strings.TrimSpace(agent)
	runtime = strings.TrimSpace(runtime)
	message = strings.TrimSpace(message)
	if projectID == "" || tabID == "" {
		return nil
	}
	if message == "" {
		message = "任务已完成"
	}
	key := projectID + "::" + tabID + "::" + agent + "::" + runtime + "::" + message
	now := time.Now()
	d.termMu.Lock()
	defer d.termMu.Unlock()
	if last := d.hookAlerts[key]; !last.IsZero() && now.Sub(last) < 2*time.Second {
		return nil
	}
	d.hookAlerts[key] = now
	for itemKey, last := range d.hookAlerts {
		if now.Sub(last) > time.Minute {
			delete(d.hookAlerts, itemKey)
		}
	}
	return &protocol.TerminalStreamAlert{
		ProjectID:  projectID,
		TerminalID: tabID,
		Reason:     "agent_done",
		Message:    message,
		Agent:      agent,
		Title:      agentNotificationTitle(agent, runtime),
	}
}

func agentNotificationTitle(agent string, runtime string) string {
	agent = strings.TrimSpace(agent)
	runtime = strings.TrimSpace(runtime)
	if runtime == "direct_acp" {
		return "Direct ACP对话 (" + agent + ")"
	}
	if runtime == "acpx" {
		return "ACPX会话 (" + agent + ")"
	}
	if agent != "" {
		return "Agent对话 (" + agent + ")"
	}
	return "Agent对话"
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

func randomHookToken() string {
	var buf [24]byte
	if _, err := rand.Read(buf[:]); err != nil {
		sum := sha1.Sum([]byte(fmt.Sprintf("%d:%d", time.Now().UnixNano(), os.Getpid())))
		return fmt.Sprintf("%x", sum[:])
	}
	return fmt.Sprintf("%x", buf[:])
}

type runningPTY struct {
	projectID   string
	terminalID  string
	sessionName string
	usesTmux    bool
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
		if rPty.usesTmux {
			resizeTmuxSession(rPty.sessionName, req.Cols, req.Rows)
			d.sendTerminalSnapshot(req.ProjectID, req.TerminalID, rPty.sessionName)
		}
		return
	}

	terminalCommand := d.normalizeTerminalCommand(req.Command)
	initialTitle := initialTerminalTitle(terminalCommand, req.InitialTitle)
	agentName := agentTerminalCommand(terminalCommand)
	agentHooks := d.prepareTerminalAgentHooks(workspace.Path, req.ProjectID, req.TerminalID, agentName)
	command := terminalAgentCommandWithHooks(terminalCommand, agentName, agentHooks.env)
	cmd, err := tmuxNewSessionCommand(sessionName, initialTitle, workspace.Path, command, agentHooks.env)
	if err != nil {
		log.Printf("daemon failed to prepare tmux config: %v. falling back to user shell.", err)
		cmd = nil
	}
	if cmd != nil {
		cmd.Env = terminalEnv(agentHooks.env...)
	}

	var ptyFile *os.File
	usesTmux := false
	if cmd != nil {
		ptyFile, err = pty.Start(cmd)
		usesTmux = err == nil
	}
	if cmd == nil || err != nil {
		usesTmux = false
		log.Printf("daemon failed to start tmux: %v. falling back to user shell.", err)
		if req.Command != "" {
			cmd = exec.Command(userShell(), "-lc", req.Command)
		} else {
			cmd = exec.Command(userShell(), "-l")
		}
		cmd.Dir = workspace.Path
		cmd.Env = terminalEnv(agentHooks.env...)
		ptyFile, err = pty.Start(cmd)
		if err != nil {
			d.termMu.Unlock()
			log.Printf("daemon failed to start fallback shell: %v", err)
			return
		}
	}
	applyTerminalSize(ptyFile, req.Cols, req.Rows)
	if usesTmux {
		resizeTmuxSession(sessionName, req.Cols, req.Rows)
	}

	done := make(chan struct{})
	rPty := &runningPTY{
		projectID:   req.ProjectID,
		terminalID:  req.TerminalID,
		sessionName: sessionName,
		usesTmux:    usesTmux,
		ptyFile:     ptyFile,
		cmd:         cmd,
		done:        done,
	}
	d.terminalPTYs[key] = rPty
	d.termMu.Unlock()
	if usesTmux {
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
	}
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

type terminalHookEvent struct {
	ProjectID  string `json:"project_id"`
	TerminalID string `json:"terminal_id"`
	Agent      string `json:"agent,omitempty"`
	Event      string `json:"event,omitempty"`
	Message    string `json:"message,omitempty"`
	Token      string `json:"token,omitempty"`
}

func (d *Daemon) startTerminalHookServer(ctx context.Context) (func(), error) {
	mux := http.NewServeMux()
	mux.HandleFunc("/terminal-event", d.handleTerminalHookEvent)
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return nil, err
	}
	server := &http.Server{Handler: mux}
	d.hookURL = "http://" + listener.Addr().String() + "/terminal-event"
	go func() {
		<-ctx.Done()
		_ = server.Close()
	}()
	go func() {
		if err := server.Serve(listener); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Printf("terminal hook server: %v", err)
		}
	}()
	return func() { _ = server.Close() }, nil
}

func (d *Daemon) handleTerminalHookEvent(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	defer r.Body.Close()
	var event terminalHookEvent
	if err := json.NewDecoder(io.LimitReader(r.Body, 64*1024)).Decode(&event); err != nil {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	if event.Token != d.hookToken {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	if strings.TrimSpace(event.ProjectID) == "" || strings.TrimSpace(event.TerminalID) == "" {
		http.Error(w, "project_id and terminal_id are required", http.StatusBadRequest)
		return
	}
	if event.Event != "" && event.Event != "done" && event.Event != "idle" {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	alert := d.terminalHookAlert(event)
	if alert == nil {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	d.send <- protocol.NewEnvelope(protocol.TypeTerminalStreamAlert, "daemon", *alert)
	w.WriteHeader(http.StatusAccepted)
}

func (d *Daemon) terminalHookAlert(event terminalHookEvent) *protocol.TerminalStreamAlert {
	projectID := strings.TrimSpace(event.ProjectID)
	terminalID := strings.TrimSpace(event.TerminalID)
	agent := strings.TrimSpace(event.Agent)
	message := strings.TrimSpace(event.Message)
	if message == "" {
		message = "任务已完成"
	}
	key := projectID + "::" + terminalID + "::" + agent + "::" + message
	now := time.Now()
	d.termMu.Lock()
	defer d.termMu.Unlock()
	if last := d.hookAlerts[key]; !last.IsZero() && now.Sub(last) < 2*time.Second {
		return nil
	}
	d.hookAlerts[key] = now
	for itemKey, last := range d.hookAlerts {
		if now.Sub(last) > time.Minute {
			delete(d.hookAlerts, itemKey)
		}
	}
	return &protocol.TerminalStreamAlert{
		ProjectID:  projectID,
		TerminalID: terminalID,
		Reason:     "agent_done",
		Message:    message,
		Agent:      agent,
	}
}

func (d *Daemon) sendTerminalSnapshot(projectID string, terminalID string, sessionName string) {
	if data := tmuxCapturePane(sessionName); len(data) > 0 {
		d.sendTerminalStreamData(protocol.TerminalStreamData{
			ProjectID:  projectID,
			TerminalID: terminalID,
			Data:       data,
		})
	}
	title, fullTitle, command := tmuxTerminalInfo(sessionName)
	if title != "" {
		d.send <- protocol.NewEnvelope(protocol.TypeTerminalStreamTitle, "daemon", protocol.TerminalStreamTitle{
			ProjectID:  projectID,
			TerminalID: terminalID,
			Title:      title,
			FullTitle:  fullTitle,
			Command:    command,
		})
	}
}

func (d *Daemon) watchTerminalTitle(ctx context.Context, projectID string, terminalID string, sessionName string, done <-chan struct{}) {
	ticker := time.NewTicker(2500 * time.Millisecond)
	defer ticker.Stop()
	lastTitle := ""
	lastFullTitle := ""
	lastCommand := ""
	for {
		title, fullTitle, command := tmuxTerminalInfo(sessionName)
		if title != "" && (title != lastTitle || fullTitle != lastFullTitle || command != lastCommand) {
			lastTitle = title
			lastFullTitle = fullTitle
			lastCommand = command
			d.send <- protocol.NewEnvelope(protocol.TypeTerminalStreamTitle, "daemon", protocol.TerminalStreamTitle{
				ProjectID:  projectID,
				TerminalID: terminalID,
				Title:      title,
				FullTitle:  fullTitle,
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

func tmuxTerminalInfo(sessionName string) (string, string, string) {
	cmd := tmuxCommand("display-message", "-p", "-t", sessionName, "#{pane_title}\t#{pane_current_path}\t#{pane_current_command}")
	raw, err := cmd.Output()
	if err != nil {
		return "", "", ""
	}
	parts := strings.Split(strings.TrimSpace(string(raw)), "\t")
	paneTitle := strings.TrimSpace(parts[0])
	currentPath := ""
	if len(parts) > 1 {
		currentPath = strings.TrimSpace(parts[1])
	}
	command := ""
	if len(parts) > 2 {
		command = strings.TrimSpace(parts[2])
	}
	title := terminalTitleFromPaneInfo(paneTitle, currentPath, command)
	fullTitle := fullTerminalTitle(title, paneTitle, currentPath)
	return title, fullTitle, command
}

func terminalTitleFromPaneInfo(paneTitle string, currentPath string, command string) string {
	paneTitle = strings.TrimSpace(paneTitle)
	currentPath = strings.TrimSpace(currentPath)
	command = strings.TrimSpace(command)
	title := paneTitle
	if title == "" {
		title = command
	}
	if currentPath != "" && tmuxTitleLooksShortenedPath(title) {
		title = compactPathTitle(currentPath)
	}
	return title
}

func fullTerminalTitle(title string, paneTitle string, currentPath string) string {
	if currentPath != "" && tmuxTitleLooksShortenedPath(title) {
		return currentPath
	}
	if paneTitle != "" && paneTitle != title {
		return paneTitle
	}
	return title
}

func compactPathTitle(path string) string {
	if path == "" {
		return ""
	}
	if path == "/" {
		return path
	}
	if home, err := os.UserHomeDir(); err == nil && home != "" {
		if shortPath, err := filepath.Rel(home, path); err == nil && !pathRelativeToParent(shortPath) {
			if shortPath == "." {
				return "~"
			}
			return filepath.ToSlash(filepath.Join("~", shortPath))
		}
	}
	return path
}

func pathRelativeToParent(path string) bool {
	return path == ".." || strings.HasPrefix(path, "../") || strings.HasPrefix(path, `..\`)
}

func tmuxTitleLooksShortenedPath(title string) bool {
	return title == "~" || strings.HasPrefix(title, "~/") || strings.HasPrefix(title, "..")
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

func tmuxNewSessionCommand(sessionName string, initialTitle string, workspacePath string, command string, env []string) (*exec.Cmd, error) {
	configPath, err := ensurePocketStudioTmuxConfig()
	if err != nil {
		return nil, err
	}
	args := []string{"-u", "-L", tmuxSocketName, "-f", configPath, "start-server", ";", "source-file", configPath, ";", "new-session", "-A", "-s", sessionName, "-n", initialTitle, "-c", workspacePath}
	for _, item := range env {
		key, _, ok := strings.Cut(item, "=")
		if !ok || strings.TrimSpace(key) == "" {
			continue
		}
		args = append(args, "-e", item)
	}
	if command != "" {
		args = append(args, command)
	}
	return exec.Command("tmux", args...), nil
}

func tmuxCommand(args ...string) *exec.Cmd {
	fullArgs := append([]string{"-L", tmuxSocketName}, args...)
	return exec.Command("tmux", fullArgs...)
}

var killTmuxSession = func(sessionName string) error {
	return tmuxCommand("kill-session", "-t", sessionName).Run()
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
set-option -ga terminal-features ",xterm-256color:RGB:clipboard,tmux-256color:RGB:clipboard,*-256color:RGB:clipboard"
set-option -g history-limit 50000
set-option -g mouse on
set-option -g set-clipboard external
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
bind-key -T copy-mode-vi y send-keys -X copy-selection-and-cancel
bind-key -T copy-mode-vi Enter send-keys -X copy-selection-and-cancel
bind-key -T copy-mode-vi Escape send-keys -X cancel
`)
	return b.String()
}

func taskEnv() []string {
	return terminalEnv()
}

func terminalEnv(extra ...string) []string {
	shell := userShell()
	env := make([]string, 0, len(os.Environ())+8+len(extra))
	pathValue := ""
	extraKeys := make(map[string]struct{}, len(extra))
	for _, item := range extra {
		key, _, ok := strings.Cut(item, "=")
		if ok && key != "" {
			extraKeys[key] = struct{}{}
		}
	}
	for _, item := range os.Environ() {
		key, _, ok := strings.Cut(item, "=")
		if !ok {
			env = append(env, item)
			continue
		}
		if key == "PATH" {
			pathValue = strings.TrimPrefix(item, "PATH=")
			continue
		}
		switch key {
		case "NO_COLOR", "TERM", "COLORTERM", "CLICOLOR", "CLICOLOR_FORCE", "FORCE_COLOR", "SHELL":
			continue
		default:
			if _, overridden := extraKeys[key]; overridden {
				continue
			}
			env = append(env, item)
		}
	}
	if pathValue == "" {
		pathValue = os.Getenv("PATH")
	}
	env = append(env,
		"PATH="+pathValue,
		"TERM=xterm-256color",
		"COLORTERM=truecolor",
		"TERM_PROGRAM=PocketStudio",
		"CLICOLOR=1",
		"CLICOLOR_FORCE=1",
		"FORCE_COLOR=1",
		"SHELL="+shell,
	)
	return append(env, extra...)
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
	case command == "online" || command == "acpx" || strings.HasPrefix(command, "acpx "):
		return "ACPX"
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

func (d *Daemon) normalizeTerminalCommand(command string) string {
	command = strings.TrimSpace(command)
	if command == "online" {
		return shellCommand([]string{d.cfg.ACPX.Command, taskAgentName(protocol.TaskDispatch{}, d.cfg.ACPX.Agent)})
	}
	return command
}

type terminalAgentHooks struct {
	env []string
}

func (d *Daemon) prepareTerminalAgentHooks(workspacePath string, projectID string, terminalID string, agent string) terminalAgentHooks {
	hooks := terminalAgentHooks{}
	if d.hookURL == "" || d.hookToken == "" || !supportsPluginTerminalAgent(agent) {
		return hooks
	}
	removeLegacyProjectAgentHookPlugin(workspacePath, agent)
	if err := writeAgentHookPlugin(agent); err != nil {
		log.Printf("write %s terminal hook plugin for %s: %v", agent, workspacePath, err)
		return hooks
	}
	hooks.env = []string{
		"POCKET_STUDIO_HOOK_URL=" + d.hookURL,
		"POCKET_STUDIO_HOOK_TOKEN=" + d.hookToken,
		"POCKET_STUDIO_PROJECT_ID=" + projectID,
		"POCKET_STUDIO_TERMINAL_ID=" + terminalID,
		"POCKET_STUDIO_AGENT=" + agent,
	}
	if configEnv := terminalAgentPluginConfigEnv(agent); configEnv != "" {
		hooks.env = append(hooks.env, configEnv)
	}
	return hooks
}

func writeAgentHookPlugin(agent string) error {
	switch agent {
	case "claude", "claude_code", "claude-code":
		return writeClaudeHookIntegration()
	case "agy", "antigravity":
		return writeAntigravityHookIntegration()
	case "codex":
		return writeCodexNotifyIntegration()
	case "opencode":
		return writeFileIfChanged(
			filepath.Join(userConfigDir(), "opencode", "plugins", "pocket-studio.ts"),
			pocketStudioOpenCodePlugin(),
		)
	case "kilo", "kilocode":
		return writeFileIfChanged(
			kiloPocketStudioPluginPath(),
			pocketStudioKiloPlugin(),
		)
	case "pi":
		return writeFileIfChanged(
			piPocketStudioExtensionPath(),
			pocketStudioPiExtension(),
		)
	default:
		return nil
	}
}

func terminalAgentPluginConfigEnv(agent string) string {
	switch agent {
	case "kilo", "kilocode":
		raw, err := json.Marshal(map[string][]string{
			"plugin": {kiloPocketStudioPluginPath()},
		})
		if err != nil {
			return ""
		}
		return "KILO_CONFIG_CONTENT=" + string(raw)
	case "pi":
		return "POCKET_STUDIO_PI_EXTENSION=" + piPocketStudioExtensionPath()
	default:
		return ""
	}
}

func kiloPocketStudioPluginPath() string {
	return filepath.Join(userConfigDir(), "kilo", "plugin", "pocket-studio.ts")
}

func piPocketStudioExtensionPath() string {
	if dir := strings.TrimSpace(os.Getenv("PI_CODING_AGENT_DIR")); dir != "" {
		return filepath.Join(dir, "extensions", "pocket-studio.ts")
	}
	if home, err := os.UserHomeDir(); err == nil && home != "" {
		return filepath.Join(home, ".pi", "agent", "extensions", "pocket-studio.ts")
	}
	return filepath.Join(".pi", "agent", "extensions", "pocket-studio.ts")
}

func writeClaudeHookIntegration() error {
	scriptPath := pocketStudioHookScriptPath("claude-stop.js")
	if err := writeFileIfChanged(scriptPath, pocketStudioTerminalNotifyScript(nil)); err != nil {
		return err
	}
	settingsPath := claudeSettingsPath()
	settings := map[string]any{}
	if raw, err := os.ReadFile(settingsPath); err == nil && len(bytes.TrimSpace(raw)) > 0 {
		if err := json.Unmarshal(raw, &settings); err != nil {
			return fmt.Errorf("read claude settings: %w", err)
		}
	}
	hooks := objectMap(settings["hooks"])
	stopHooks := hookEntryList(hooks["Stop"])
	command := shellCommand([]string{nodeCommand(), scriptPath})
	if !hookEntryListHasCommand(stopHooks, command) {
		stopHooks = append(stopHooks, map[string]any{
			"hooks": []any{
				map[string]any{
					"type":    "command",
					"command": command,
					"timeout": float64(10),
				},
			},
		})
	}
	hooks["Stop"] = stopHooks
	settings["hooks"] = hooks
	raw, err := json.MarshalIndent(settings, "", "  ")
	if err != nil {
		return err
	}
	raw = append(raw, '\n')
	return writeFileIfChanged(settingsPath, string(raw))
}

func antigravitySettingsPath() string {
	if dir := strings.TrimSpace(os.Getenv("ANTIGRAVITY_CONFIG_DIR")); dir != "" {
		return filepath.Join(dir, "settings.json")
	}
	if home, err := os.UserHomeDir(); err == nil && home != "" {
		return filepath.Join(home, ".gemini", "antigravity-cli", "settings.json")
	}
	return filepath.Join(".gemini", "antigravity-cli", "settings.json")
}

func writeAntigravityHookIntegration() error {
	scriptPath := pocketStudioHookScriptPath("antigravity-stop.js")
	if err := writeFileIfChanged(scriptPath, pocketStudioTerminalNotifyScript(nil)); err != nil {
		return err
	}
	settingsPath := antigravitySettingsPath()
	settings := map[string]any{}
	if raw, err := os.ReadFile(settingsPath); err == nil && len(bytes.TrimSpace(raw)) > 0 {
		if err := json.Unmarshal(raw, &settings); err != nil {
			return fmt.Errorf("read antigravity settings: %w", err)
		}
	}
	hooks := objectMap(settings["hooks"])
	stopHooks := hookEntryList(hooks["Stop"])
	command := shellCommand([]string{nodeCommand(), scriptPath})
	if !hookEntryListHasCommand(stopHooks, command) {
		stopHooks = append(stopHooks, map[string]any{
			"hooks": []any{
				map[string]any{
					"type":    "command",
					"command": command,
					"timeout": float64(10),
				},
			},
		})
	}
	hooks["Stop"] = stopHooks
	settings["hooks"] = hooks
	raw, err := json.MarshalIndent(settings, "", "  ")
	if err != nil {
		return err
	}
	raw = append(raw, '\n')
	return writeFileIfChanged(settingsPath, string(raw))
}

func writeCodexNotifyIntegration() error {
	scriptPath := pocketStudioHookScriptPath("codex-notify.js")
	previousPath := filepath.Join(filepath.Dir(scriptPath), "codex-notify-previous.json")
	wrapper := []string{nodeCommand(), scriptPath}
	if err := writeFileIfChanged(scriptPath, pocketStudioTerminalNotifyScript(&previousPath)); err != nil {
		return err
	}
	configPath := codexConfigPath()
	raw, err := os.ReadFile(configPath)
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	content := string(raw)
	current, hasNotify := topLevelTomlStringArray(content, "notify")
	if !sameStringSlice(current, wrapper) {
		if !isCodexPocketStudioNotify(current, scriptPath) {
			previous := current
			if len(previous) == 0 && errors.Is(err, os.ErrNotExist) {
				previous = nil
			}
			if err := writeCodexPreviousNotify(previousPath, previous); err != nil {
				return err
			}
		}
	}
	nextContent := setTopLevelTomlStringArray(content, "notify", wrapper, hasNotify)
	return writeFileIfChanged(configPath, nextContent)
}

func removeLegacyProjectAgentHookPlugin(workspacePath string, agent string) {
	workspacePath = strings.TrimSpace(workspacePath)
	if workspacePath == "" {
		return
	}
	var path string
	switch agent {
	case "opencode":
		path = filepath.Join(workspacePath, ".opencode", "plugins", "pocket-studio.ts")
	case "kilo", "kilocode":
		path = filepath.Join(workspacePath, ".kilo", "plugin", "pocket-studio.ts")
	default:
		return
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return
	}
	content := string(raw)
	if strings.Contains(content, "POCKET_STUDIO_HOOK_URL") &&
		strings.Contains(content, "POCKET_STUDIO_TERMINAL_ID") &&
		strings.Contains(content, "pocket-studio") {
		if err := os.Remove(path); err != nil {
			log.Printf("remove legacy %s terminal hook plugin %s: %v", agent, path, err)
		}
	}
}

func userConfigDir() string {
	if dir := strings.TrimSpace(os.Getenv("XDG_CONFIG_HOME")); dir != "" {
		return dir
	}
	if home, err := os.UserHomeDir(); err == nil && home != "" {
		return filepath.Join(home, ".config")
	}
	return "."
}

func pocketStudioHookScriptPath(name string) string {
	return filepath.Join(userConfigDir(), "pocket-studio", "hooks", name)
}

func claudeSettingsPath() string {
	if dir := strings.TrimSpace(os.Getenv("CLAUDE_CONFIG_DIR")); dir != "" {
		return filepath.Join(dir, "settings.json")
	}
	if home, err := os.UserHomeDir(); err == nil && home != "" {
		return filepath.Join(home, ".claude", "settings.json")
	}
	return filepath.Join(".claude", "settings.json")
}

func codexConfigPath() string {
	if dir := strings.TrimSpace(os.Getenv("CODEX_HOME")); dir != "" {
		return filepath.Join(dir, "config.toml")
	}
	if home, err := os.UserHomeDir(); err == nil && home != "" {
		return filepath.Join(home, ".codex", "config.toml")
	}
	return filepath.Join(".codex", "config.toml")
}

func nodeCommand() string {
	if node, err := exec.LookPath("node"); err == nil && strings.TrimSpace(node) != "" {
		return node
	}
	return "node"
}

func objectMap(value any) map[string]any {
	if existing, ok := value.(map[string]any); ok {
		return existing
	}
	return map[string]any{}
}

func hookEntryList(value any) []any {
	if entries, ok := value.([]any); ok {
		return entries
	}
	return []any{}
}

func hookEntryListHasCommand(entries []any, command string) bool {
	for _, entry := range entries {
		entryMap, ok := entry.(map[string]any)
		if !ok {
			continue
		}
		hooks, ok := entryMap["hooks"].([]any)
		if !ok {
			continue
		}
		for _, hook := range hooks {
			hookMap, ok := hook.(map[string]any)
			if !ok {
				continue
			}
			if hookMap["command"] == command {
				return true
			}
		}
	}
	return false
}

func shellCommand(args []string) string {
	quoted := make([]string, 0, len(args))
	for _, arg := range args {
		quoted = append(quoted, shellQuote(arg))
	}
	return strings.Join(quoted, " ")
}

func shellQuote(value string) string {
	if value == "" {
		return "''"
	}
	if strings.IndexFunc(value, func(r rune) bool {
		return !(r >= 'A' && r <= 'Z') &&
			!(r >= 'a' && r <= 'z') &&
			!(r >= '0' && r <= '9') &&
			!strings.ContainsRune("@%_+=:,./-", r)
	}) == -1 {
		return value
	}
	return "'" + strings.ReplaceAll(value, "'", "'\"'\"'") + "'"
}

func writeCodexPreviousNotify(path string, previous []string) error {
	raw, err := json.MarshalIndent(map[string]any{"previous_notify": previous}, "", "  ")
	if err != nil {
		return err
	}
	raw = append(raw, '\n')
	return writeFileIfChanged(path, string(raw))
}

func sameStringSlice(left []string, right []string) bool {
	if len(left) != len(right) {
		return false
	}
	for i := range left {
		if left[i] != right[i] {
			return false
		}
	}
	return true
}

func isCodexPocketStudioNotify(command []string, scriptPath string) bool {
	for _, item := range command {
		if item == scriptPath {
			return true
		}
	}
	return false
}

func topLevelTomlStringArray(content string, key string) ([]string, bool) {
	lines := strings.SplitAfter(content, "\n")
	offset := 0
	for _, line := range lines {
		trimmed := strings.TrimSpace(line)
		if strings.HasPrefix(trimmed, "[") {
			return nil, false
		}
		if strings.HasPrefix(trimmed, key+" ") || strings.HasPrefix(trimmed, key+"=") {
			eq := strings.Index(line, "=")
			if eq < 0 {
				return nil, false
			}
			valueStart := offset + eq + 1
			value, ok := scanTomlArrayValue(content[valueStart:])
			if !ok {
				return nil, false
			}
			items, ok := parseTomlStringArray(value)
			return items, ok
		}
		offset += len(line)
	}
	return nil, false
}

func setTopLevelTomlStringArray(content string, key string, value []string, replace bool) string {
	line := key + " = " + formatTomlStringArray(value) + "\n"
	if !replace {
		return line + content
	}
	lines := strings.SplitAfter(content, "\n")
	offset := 0
	for _, item := range lines {
		trimmed := strings.TrimSpace(item)
		if strings.HasPrefix(trimmed, "[") {
			break
		}
		if strings.HasPrefix(trimmed, key+" ") || strings.HasPrefix(trimmed, key+"=") {
			eq := strings.Index(item, "=")
			if eq < 0 {
				break
			}
			start := offset
			valueStart := offset + eq + 1
			_, ok, consumed := scanTomlArrayValueWithLength(content[valueStart:])
			if !ok {
				break
			}
			end := valueStart + consumed
			for end < len(content) && (content[end] == ' ' || content[end] == '\t') {
				end++
			}
			if end < len(content) && content[end] == '\n' {
				end++
			}
			return content[:start] + line + content[end:]
		}
		offset += len(item)
	}
	return line + content
}

func scanTomlArrayValue(content string) (string, bool) {
	value, ok, _ := scanTomlArrayValueWithLength(content)
	return value, ok
}

func scanTomlArrayValueWithLength(content string) (string, bool, int) {
	start := strings.Index(content, "[")
	if start < 0 {
		return "", false, 0
	}
	inString := false
	escaped := false
	for i := start; i < len(content); i++ {
		ch := content[i]
		if inString {
			if escaped {
				escaped = false
				continue
			}
			if ch == '\\' {
				escaped = true
				continue
			}
			if ch == '"' {
				inString = false
			}
			continue
		}
		switch ch {
		case '"':
			inString = true
		case ']':
			return content[start : i+1], true, i + 1
		}
	}
	return "", false, 0
}

func parseTomlStringArray(value string) ([]string, bool) {
	decoder := json.NewDecoder(strings.NewReader(value))
	var items []string
	if err := decoder.Decode(&items); err != nil {
		return nil, false
	}
	return items, true
}

func formatTomlStringArray(items []string) string {
	parts := make([]string, 0, len(items))
	for _, item := range items {
		encoded, _ := json.Marshal(item)
		parts = append(parts, string(encoded))
	}
	return "[" + strings.Join(parts, ", ") + "]"
}

func writeFileIfChanged(path string, content string) error {
	if existing, err := os.ReadFile(path); err == nil && string(existing) == content {
		return nil
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	return os.WriteFile(path, []byte(content), 0o644)
}

func pocketStudioOpenCodePlugin() string {
	return `export const PocketStudio = async () => ({
  event: async ({ event }) => {
    if (event.type !== "session.idle") return
    const url = process.env.POCKET_STUDIO_HOOK_URL
    if (!url) return
    await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        token: process.env.POCKET_STUDIO_HOOK_TOKEN,
        project_id: process.env.POCKET_STUDIO_PROJECT_ID,
        terminal_id: process.env.POCKET_STUDIO_TERMINAL_ID,
        agent: process.env.POCKET_STUDIO_AGENT || "opencode",
        event: "done",
        message: "任务已完成"
      })
    }).catch(() => {})
  }
})
`
}

func pocketStudioKiloPlugin() string {
	return `export default async () => ({
  event: async ({ event }) => {
    if (event.type !== "session.idle") return
    const url = process.env.POCKET_STUDIO_HOOK_URL
    if (!url) return
    await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        token: process.env.POCKET_STUDIO_HOOK_TOKEN,
        project_id: process.env.POCKET_STUDIO_PROJECT_ID,
        terminal_id: process.env.POCKET_STUDIO_TERMINAL_ID,
        agent: process.env.POCKET_STUDIO_AGENT || "kilo",
        event: "done",
        message: "任务已完成"
      })
    }).catch(() => {})
  }
})
`
}

func pocketStudioPiExtension() string {
	return `import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"

async function postPocketStudio() {
  const url = process.env.POCKET_STUDIO_HOOK_URL
  if (!url) return
  const body = {
    token: process.env.POCKET_STUDIO_HOOK_TOKEN,
    project_id: process.env.POCKET_STUDIO_PROJECT_ID,
    terminal_id: process.env.POCKET_STUDIO_TERMINAL_ID,
    agent: process.env.POCKET_STUDIO_AGENT || "pi",
    event: "done",
    message: "任务已完成"
  }
  if (!body.token || !body.project_id || !body.terminal_id) return
  await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  }).catch(() => {})
}

export default function (pi: ExtensionAPI) {
  pi.on("agent_end", async (event) => {
    if (event?.willRetry) return
    await postPocketStudio()
  })
}
`
}

func pocketStudioTerminalNotifyScript(previousNotifyPath *string) string {
	previousPathLiteral := "null"
	if previousNotifyPath != nil {
		encoded, _ := json.Marshal(*previousNotifyPath)
		previousPathLiteral = string(encoded)
	}
	return `#!/usr/bin/env node
const { spawnSync } = require("node:child_process")
const { readFileSync } = require("node:fs")

const previousNotifyPath = ` + previousPathLiteral + `

function readStdin() {
  try {
    if (process.stdin.isTTY) return ""
    return readFileSync(0, "utf8")
  } catch {
    return ""
  }
}

function parseJson(value) {
  const text = String(value || "").trim()
  if (!text) return null
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

function lastJsonArg() {
  for (let index = process.argv.length - 1; index >= 2; index--) {
    const parsed = parseJson(process.argv[index])
    if (parsed && typeof parsed === "object") return parsed
  }
  const stdin = parseJson(readStdin())
  return stdin && typeof stdin === "object" ? stdin : {}
}

function text(value) {
  if (value == null) return ""
  if (typeof value === "string") return value.trim()
  if (typeof value === "number" || typeof value === "boolean") return String(value)
  return ""
}

function messageFromPayload(payload) {
  const candidates = [
    payload.message,
    payload.notification,
    payload.summary,
    payload.title,
    payload.reason,
    payload.last_assistant_message,
    payload["last-assistant-message"],
    payload.transcript_path ? "任务已完成" : ""
  ]
  for (const candidate of candidates) {
    const value = text(candidate)
    if (value) return value.length > 240 ? value.slice(0, 239) + "..." : value
  }
  return "任务已完成"
}

async function postPocketStudio(payload) {
  const url = process.env.POCKET_STUDIO_HOOK_URL
  if (!url) return
  const body = {
    token: process.env.POCKET_STUDIO_HOOK_TOKEN,
    project_id: process.env.POCKET_STUDIO_PROJECT_ID,
    terminal_id: process.env.POCKET_STUDIO_TERMINAL_ID,
    agent: process.env.POCKET_STUDIO_AGENT || "agent",
    event: "done",
    message: messageFromPayload(payload)
  }
  if (!body.token || !body.project_id || !body.terminal_id) return
  try {
    await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    })
  } catch {}
}

function readPreviousNotify() {
  if (!previousNotifyPath) return null
  try {
    const parsed = JSON.parse(readFileSync(previousNotifyPath, "utf8"))
    return Array.isArray(parsed.previous_notify) ? parsed.previous_notify : null
  } catch {
    return null
  }
}

function runPreviousNotify(payloadArg) {
  const previous = readPreviousNotify()
  if (!previous || previous.length === 0) return
  const [command, ...args] = previous
  if (!command) return
  spawnSync(command, [...args, payloadArg], {
    stdio: "ignore",
    env: process.env,
    cwd: process.cwd()
  })
}

async function main() {
  const payloadArg = process.argv[process.argv.length - 1] || "{}"
  const payload = lastJsonArg()
  await postPocketStudio(payload)
  runPreviousNotify(payloadArg)
}

main().catch(() => {})
`
}

func supportsPluginTerminalAgent(agent string) bool {
	switch agent {
	case "claude", "claude_code", "claude-code", "codex", "opencode", "kilo", "kilocode", "pi", "agy", "antigravity":
		return true
	default:
		return false
	}
}

func terminalAgentCommandWithHooks(command string, agent string, env []string) string {
	if agent != "pi" || strings.TrimSpace(command) == "" {
		return command
	}
	extensionPath := ""
	for _, item := range env {
		if value, ok := strings.CutPrefix(item, "POCKET_STUDIO_PI_EXTENSION="); ok {
			extensionPath = strings.TrimSpace(value)
			break
		}
	}
	if extensionPath == "" || commandHasPiExtension(command, extensionPath) {
		return command
	}
	return command + " --extension " + shellQuote(extensionPath)
}

func commandHasPiExtension(command string, extensionPath string) bool {
	if strings.Contains(command, "--extension "+extensionPath) || strings.Contains(command, "--extension="+extensionPath) {
		return true
	}
	quoted := shellQuote(extensionPath)
	return strings.Contains(command, "--extension "+quoted) || strings.Contains(command, "--extension="+quoted)
}

func agentTerminalCommand(command string) string {
	command = strings.ToLower(strings.TrimSpace(command))
	if command == "" {
		return ""
	}
	fields := strings.Fields(command)
	base := ""
	if len(fields) > 0 {
		base = filepath.Base(fields[0])
	}
	switch base {
	case "claude", "codex", "opencode", "kilo", "kilocode", "pi", "agy", "antigravity", "acpx":
		return base
	}
	switch {
	case command == "online" || strings.HasPrefix(command, "acpx "):
		return "acpx"
	case strings.Contains(command, "opencode"):
		return "opencode"
	case strings.Contains(command, "kilocode"):
		return "kilocode"
	case strings.Contains(command, "kilo"):
		return "kilo"
	case strings.Contains(command, "claude"):
		return "claude"
	case strings.Contains(command, "codex"):
		return "codex"
	case strings.Contains(command, "antigravity"):
		return "antigravity"
	default:
		return ""
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
		if rPty.usesTmux {
			resizeTmuxSession(rPty.sessionName, req.Cols, req.Rows)
		}
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
		if req.CloseSession && rPty.usesTmux {
			_ = killTmuxSession(rPty.sessionName)
		}
	}
}
