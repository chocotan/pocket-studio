package daemon

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha1"
	"encoding/base64"
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

	"remote-agent/internal/protocol"
)

type Daemon struct {
	cfg Config

	mu                      sync.Mutex
	tasks                   map[string]*runningTask
	history                 map[string]protocol.TaskRecord
	projects                map[string]protocol.Project
	projectStates           map[string]json.RawMessage
	send                    chan protocol.Envelope
	sendBinary              chan []byte
	terminalBinary          bool
	termMu                  sync.Mutex
	terminalPTYs            map[string]*runningPTY
	directTerminalConns     map[string]map[*directTerminalSubscriber]struct{}
	directAgentChatConns    map[string]map[*directAgentChatSubscriber]struct{}
	directAgentChatProjects map[string]string
	hookURL                 string
	hookToken               string
	hookAlerts              map[string]time.Time
	directACP               map[string]*directACPSession
	directACPStarts         map[string]*directACPStart
	startingTasks           map[string]struct{}
	taskDispatchMu          map[string]*sync.Mutex
	directACPStoreErr       error
	shuttingDown            bool
}

const (
	reconnectInitialDelay = time.Second
	reconnectMaxDelay     = 5 * time.Minute
	reconnectStableAfter  = 30 * time.Second
)

type runningTask struct {
	id        string
	turnID    string
	recordID  string
	cmd       *exec.Cmd
	cancel    context.CancelFunc
	done      chan struct{}
	workspace string
	agent     string
	session   string
	emitter   *taskEmitter
	mu        sync.Mutex
	stopping  bool
	deleting  bool
}

type runningTaskSnapshot struct {
	recordID string
	session  string
	cmd      *exec.Cmd
}

type directACPSession struct {
	taskID        string
	agent         string
	session       string
	workspace     string
	modelConfigID string
	configIDs     map[string]string
	client        *directACPClient
	persisted     bool
	promptMu      sync.Mutex
	resetting     bool
}

type directACPStart struct {
	done   chan struct{}
	cancel context.CancelFunc
	err    error
}

func New(cfg Config) *Daemon {
	return &Daemon{
		cfg:                     cfg,
		tasks:                   make(map[string]*runningTask),
		history:                 make(map[string]protocol.TaskRecord),
		projects:                make(map[string]protocol.Project),
		projectStates:           make(map[string]json.RawMessage),
		send:                    make(chan protocol.Envelope, 128),
		sendBinary:              make(chan []byte, 256),
		terminalPTYs:            make(map[string]*runningPTY),
		directTerminalConns:     make(map[string]map[*directTerminalSubscriber]struct{}),
		directAgentChatConns:    make(map[string]map[*directAgentChatSubscriber]struct{}),
		directAgentChatProjects: make(map[string]string),
		hookToken:               randomHookToken(),
		hookAlerts:              make(map[string]time.Time),
		directACP:               make(map[string]*directACPSession),
		directACPStarts:         make(map[string]*directACPStart),
		startingTasks:           make(map[string]struct{}),
		taskDispatchMu:          make(map[string]*sync.Mutex),
	}
}

func (d *Daemon) Run(ctx context.Context) error {
	defer d.shutdownPersistentSessions()

	if strings.TrimSpace(d.cfg.DirectWeb.Token) == "" {
		d.cfg.DirectWeb.Token = randomHookToken()
	}
	if stopDirectWebServer, err := d.startDirectWebServer(ctx); err != nil {
		log.Printf("start direct web server: %v", err)
	} else {
		defer stopDirectWebServer()
	}
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

const daemonSessionShutdownTimeout = 2 * time.Second

func (d *Daemon) shutdownPersistentSessions() {
	d.mu.Lock()
	if d.
		shuttingDown {
		d.mu.Unlock()
		return
	}
	d.shuttingDown = true
	tasks := make([]*runningTask,
		0,
		len(d.
			tasks),
	)
	for _, task := range d.tasks {
		tasks = append(tasks, task)
	}
	clients := make(map[*directACPClient]struct {
	}, len(d.
		directACP))
	for _, session := range d.directACP {
		if session !=
			nil && session.client !=
			nil {
			clients[session.client] = struct{}{}
		}
	}
	starts := make([]*directACPStart,
		0, len(d.directACPStarts))
	for _, start := range d.directACPStarts {
		if start !=
			nil {
			starts = append(starts, start)
		}
	}
	d.tasks = make(map[string]*runningTask)
	d.directACP = make(map[string]*directACPSession)
	d.startingTasks = make(map[string]struct{})
	d.mu.Unlock()
	for _, task := range tasks {
		if task != nil && task.cancel != nil {
			task.
				cancel()
		}
	}
	for _, start := range starts {
		if start.cancel != nil {
			start.cancel()
		}
	}
	var closeWG sync.WaitGroup
	closeWG.Add(
		len(clients) + len(starts))
	for client := range clients {
		go func() {
			defer closeWG.Done()
			client.close()
		}()
	}
	for _, start := range starts {
		go func(start *directACPStart) {
			defer closeWG.Done()
			<-start.done
		}(start)
	}
	closed := make(chan struct{})
	go func() {
		closeWG.Wait()
		close(closed)
	}()
	select {
	case <-closed:
		return
	case <-time.After(
		daemonSessionShutdownTimeout):
	}
	for client := range clients {
		killProcess(client.
			cmd)
	}
	select {
	case <-closed:
	case <-time.After(250 * time.Millisecond):
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
	d.sendSnapshot(connCtx)

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
	return "direct_acp"
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
			d.mu.Lock()
			d.directACPStoreErr = nil
			d.mu.Unlock()
			return nil
		}
		d.mu.Lock()
		d.directACPStoreErr = err
		d.mu.Unlock()
		return err
	}
	var store directACPStore
	if err := json.Unmarshal(raw, &store); err != nil {
		err = fmt.Errorf("decode direct ACP session store: %w", err)
		d.mu.Lock()
		d.directACPStoreErr = err
		d.mu.Unlock()
		return err
	}
	if store.Version != 1 {
		err = fmt.Errorf("decode direct ACP session store: unsupported version %d", store.Version)
		d.mu.Lock()
		d.directACPStoreErr = err
		d.mu.Unlock()
		return err
	}
	d.mu.Lock()
	defer d.mu.Unlock()
	d.directACPStoreErr = nil
	changed := false
	for _, record := range store.Tasks {
		if record.TaskID == "" || !isDirectACPRecord(record) {
			continue
		}
		record.DeviceID = d.cfg.Device.ID
		if restored, updated := restoreInterruptedTaskRecord(record); updated {
			record = restored
			changed = true
		}
		d.history[record.TaskID] = record
	}
	if changed {
		return d.saveDirectACPStoreLocked()
	}
	return nil
}

func restoreInterruptedTaskRecord(record protocol.TaskRecord) (protocol.TaskRecord, bool) {
	status := strings.ToLower(strings.TrimSpace(record.Status))
	if status != "running" && status != "stopping" && status != "interrupted" {
		return record, false
	}
	changed := status != "interrupted"
	record.Status = "interrupted"
	for index := len(record.Events) - 1; index >= 0; index-- {
		event := record.Events[index]
		if isTerminalTaskEventType(event.EventType) {
			return record, changed
		}
		if event.EventType == "task.started" || event.EventType == "user.prompt" {
			break
		}
	}

	now := protocolNow()
	data := map[string]any{
		"error":  "task interrupted by daemon restart",
		"reason": "interrupted",
	}
	if turnID := latestPromptTurnID(record.Events); turnID != "" {
		data["turn_id"] = turnID
	}
	raw, _ := json.Marshal(data)
	record.Events = append(record.Events, protocol.TaskEvent{
		TaskID:    record.TaskID,
		EventID:   protocol.NewID("evt"),
		EventType: "task.failed",
		Source:    "daemon",
		Sequence:  nextHistoryEventSequence(record.Events),
		Timestamp: now,
		Data:      raw,
	})
	record.UpdatedAt = now
	return record, true
}

func isTerminalTaskEventType(eventType string) bool {
	switch eventType {
	case "task.completed", "turn.completed", "task.failed", "turn.failed", "task.killed", "task.stopped":
		return true
	default:
		return false
	}
}

func (d *Daemon) saveDirectACPStoreLocked() error {
	if d.directACPStoreErr != nil {
		return fmt.Errorf("refusing to overwrite unreadable direct ACP session store: %w", d.directACPStoreErr)
	}
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
	raw, err := json.MarshalIndent(directACPStore{Version: 1, Tasks: tasks}, "", "  ")
	if err != nil {
		return err
	}
	return writeFileAtomic(daemonDirectACPSessionsPath(), append(raw, '\n'), 0o600)
}

func isDirectACPRecord(record protocol.TaskRecord) bool {
	rt := strings.TrimSpace(record.AgentRuntime)
	return strings.EqualFold(rt, "direct_acp")
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
	names := make([]string, 0, len(d.cfg.DirectACP.Agents)+1)
	seen := make(map[string]bool)
	for name, cfg := range d.cfg.DirectACP.Agents {
		if strings.TrimSpace(cfg.Command) != "" {
			names = append(names, name)
			seen[normalizeAgentCapabilityName(name)] = true
		}
	}
	if !seen["antigravity"] && executableAvailable("agy", "antigravity") {
		names = append(names, "antigravity")
	}
	sort.Strings(names)
	caps := make([]protocol.AgentCapability, 0, len(names))
	for _, name := range names {
		caps = append(caps, protocol.AgentCapability{Name: name, Label: agentDisplayName(name)})
	}
	return caps
}

func executableAvailable(names ...string) bool {
	for _, name := range names {
		if path, err := exec.LookPath(name); err == nil && strings.TrimSpace(path) != "" {
			return true
		}
	}
	return false
}

func agentDisplayName(agent string) string {
	switch normalizeAgentCapabilityName(agent) {
	case "claude":
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
	case "antigravity":
		return "Antigravity"
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
	case protocol.TypeSessionList:
		request, err := protocol.DecodePayload[protocol.SessionListRequest](env)
		if err != nil {
			d.sendSessionListResult(protocol.SessionListResult{RequestID: requestIDFromEnvelope(env), Error: err.Error()})
			return
		}
		go d.listDirectACPSessions(ctx, request)
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
	case protocol.TypeProjectDelete:
		request, err := protocol.DecodePayload[protocol.ProjectDeleteRequest](env)
		if err != nil {
			d.sendProjectError("", err.Error())
			return
		}
		go d.deleteProject(request)
	case protocol.TypeDeviceAliasSet:
		request, err := protocol.DecodePayload[protocol.DeviceAliasSetRequest](env)
		if err != nil {
			d.sendDeviceAliasResult(protocol.DeviceAliasResult{RequestID: requestIDFromEnvelope(env), Error: err.Error()})
			return
		}
		go d.setDeviceAlias(request)
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
		RequestID:       session.RequestID,
		TaskID:          session.TaskID,
		WorkspaceID:     workspace.ID,
		WorkspacePath:   workspace.Path,
		Agent:           session.Agent,
		AgentRuntime:    session.AgentRuntime,
		SessionName:     session.SessionName,
		ResumeSessionID: session.ResumeSessionID,
		ImportHistory:   session.ImportHistory,
		Options:         session.Options,
	}
	if task.ResumeSessionID != "" && !d.hasPersistedConversationEvents(task.TaskID) {
		task.ImportHistory = true
	}
	ctx, cancel := context.WithCancel(parent)
	defer cancel()
	if !isDirectACPRuntime(session.AgentRuntime) {
		d.emitError(session.TaskID, "unsupported_runtime", "only direct_acp is supported")
		return
	}
	if err := d.ensureDirectACPSession(ctx, task, workspace.Path, session.TaskID); err != nil {
		d.emitError(session.TaskID, "session_ensure_failed", err.Error())
		return
	}
	now := time.Now().Unix()
	d.mu.Lock()
	record := d.taskHistoryRecordLocked(session.TaskID)
	record = restoreTaskRecordForUI(record, session.TaskID)
	if record.TaskID == "" {
		record.TaskID = session.TaskID
		record.StartedAt = now
	}
	record.WorkspaceID = workspace.ID
	record.WorkspacePath = workspace.Path
	record.DeviceID = d.cfg.Device.ID
	record.Agent = d.recordAgentNameForTask(task)
	record.AgentRuntime = task.AgentRuntime
	record.SessionName = strings.TrimSpace(task.SessionName)
	if record.Status == "" {
		record.Status = "created"
	}
	record.UpdatedAt = now
	d.history[session.TaskID] = record
	d.mu.Unlock()
	d.emitTaskEvent(session.TaskID, "session.created", 0, map[string]any{
		"workspace":    workspace.Path,
		"agent":        record.Agent,
		"session_name": record.SessionName,
	}, nil)
}

func (d *Daemon) hasPersistedConversationEvents(taskID string) bool {
	d.mu.Lock()
	events := append([]protocol.TaskEvent(nil), d.history[taskID].Events...)
	d.mu.Unlock()
	for _, event := range events {
		switch event.EventType {
		case "user.prompt", "assistant.message", "assistant.thinking", "tool.call", "tool.output":
			return true
		}
	}
	return false
}

func (d *Daemon) sendTaskHistory(request protocol.TaskHistoryGet) {
	record := d.taskHistoryForRequest(request.TaskID, request.WorkspacePath)

	result := protocol.TaskHistoryResult{
		RequestID: request.RequestID,
		TaskID:    request.TaskID,
	}
	if record.TaskID != "" {
		record.TaskID = request.TaskID
		for i := range record.Events {
			record.Events[i].TaskID = request.TaskID
		}
		record.Events = normalizedTaskHistoryEvents(record)
		result.Record = &record
		result.Events = append([]protocol.TaskEvent(nil), record.Events...)
	}
	d.send <- protocol.NewEnvelope(protocol.TypeTaskHistoryResult, "daemon", result)
}

func (d *Daemon) taskHistoryForRequest(taskID string, workspacePath string) protocol.TaskRecord {
	_ = workspacePath
	d.mu.Lock()
	record := d.taskHistoryRecordLocked(taskID)
	d.mu.Unlock()
	return record
}

func (d *Daemon) taskHistoryRecordLocked(taskID string) protocol.TaskRecord {
	record := d.history[taskID]
	if record.TaskID != "" {
		return record
	}
	for _, candidate := range d.history {
		if taskMatchesRecord(candidate, taskID) {
			return candidate
		}
	}
	return protocol.TaskRecord{}
}

func taskMatchesRecord(record protocol.TaskRecord, taskID string) bool {
	taskID = strings.TrimSpace(taskID)
	if taskID == "" {
		return false
	}
	return record.TaskID == taskID || record.SessionName == taskID || record.SessionID == taskID
}

func restoreTaskRecordForUI(record protocol.TaskRecord, taskID string) protocol.TaskRecord {
	if record.TaskID == "" || record.TaskID == taskID {
		return record
	}
	record.TaskID = taskID
	for i := range record.Events {
		record.Events[i].TaskID = taskID
	}
	return record
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

	if !isDirectACPRuntime(task.AgentRuntime) {
		d.emitError(task.TaskID, "unsupported_runtime", "only direct_acp is supported")
		return
	}
	d.startDirectACPTask(parent, task, workspace)
	return

	// The prompt command uses an IDLE timeout, not a total one: a turn that is
	// actively streaming output (thinking, tool calls, text) keeps resetting the
	// timer and is never killed, no matter how long it legitimately runs. Only a
	// turn that produces NO output for the whole idle window is treated as hung.

}

func (d *Daemon) supportsTaskAgent(agent string) bool {
	_, ok := d.directACPAgentConfig(agent)
	return ok
}

func (d *Daemon) supportsTaskAgentForRuntime(agent string, runtime string) bool {
	return isDirectACPRuntime(runtime) && d.supportsTaskAgent(agent)
}

func (d *Daemon) recordAgentNameForTask(task protocol.TaskDispatch) string {
	return taskAgentName(task, "")
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
	if agent == "" {
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

func normalizeAgentName(agent string) string {
	agent = strings.ToLower(strings.TrimSpace(agent))
	switch agent {
	case "claude_code", "claude-code":
		return "claude"
	case "kilo", "kilo-code":
		return "kilocode"
	default:
		return agent
	}
}

func normalizeAgentCapabilityName(agent string) string {
	agent = normalizeAgentName(agent)
	switch agent {
	case "agy":
		return "antigravity"
	case "github-copilot":
		return "copilot"
	case "cursor-agent":
		return "cursor"
	case "open-claw":
		return "openclaw"
	default:
		return agent
	}
}

type taskEmitter struct {
	mu        sync.Mutex
	sequence  int64
	daemon    *Daemon
	taskID    string
	endTurn   bool
	lastError string
	rawTool   int
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

func extractACPErrorText(text string) string {
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
	assistantEventKey  string
	thinkingText       strings.Builder
	thinkingRaw        json.RawMessage
	thinkingStreaming  bool
	thinkingStreamID   string
	thinkingEventKey   string
	streamCounter      int64
	turnIndex          int
	assistantOrdinal   int
	thinkingOrdinal    int
	toolOrdinal        int
	historyUserPrompts int
	seenUserPrompts    int
	userStreaming      bool
	targetPrompt       string
	reachedNewPrompt   bool
	startupInfo        map[string]*oneShotTextSuppressor
	startupInfoOrder   []string
	toolUpdates        map[string]toolUpdateState
}

type toolUpdateState struct {
	name        string
	kind        string
	status      string
	input       any
	streamID    string
	callEmitted bool
}

func newAgentOutputAdapter(emitter *taskEmitter, historyUserPrompts int, targetPrompt string) *agentOutputAdapter {
	return &agentOutputAdapter{
		emitter:            emitter,
		streamPrefix:       protocol.NewID("stream"),
		historyUserPrompts: historyUserPrompts,
		targetPrompt:       strings.TrimSpace(targetPrompt),
		startupInfo:        make(map[string]*oneShotTextSuppressor),
		toolUpdates:        make(map[string]toolUpdateState),
	}
}

func (a *agentOutputAdapter) handle(raw json.RawMessage) {
	if a.handleACPJSONRPC(raw) {
		return
	}
	a.flush()
	if !a.reachedNewPrompt && a.historyUserPrompts > 0 && a.seenUserPrompts <= a.historyUserPrompts {
		if text := extractACPErrorText(string(raw)); text != "" {
			a.emitter.markError(text)
			a.emitter.emit("task.error", map[string]string{"error": text}, raw)
		}
		return
	}
	eventType := classifyClaudeEvent(raw)
	if eventType == "tool.call" || eventType == "tool.output" {
		if data := claudeToolEventData(raw); data != nil {
			data = a.indexedEventData(eventType, data, "")
			a.emitter.emit(eventType, data, raw)
			return
		}
	}
	if eventType == "assistant.message" {
		var obj map[string]any
		if err := json.Unmarshal(raw, &obj); err == nil && obj != nil {
			var content []any
			if message, _ := obj["message"].(map[string]any); message != nil {
				content, _ = message["content"].([]any)
			} else {
				content, _ = obj["content"].([]any)
			}
			if len(content) > 0 {
				hasThinking := false
				for _, item := range content {
					part, _ := item.(map[string]any)
					if part == nil {
						continue
					}
					t, _ := part["type"].(string)
					if t == "thinking" {
						hasThinking = true
						break
					}
				}
				if hasThinking {
					a.flush()
					for _, item := range content {
						part, _ := item.(map[string]any)
						if part == nil {
							continue
						}
						t, _ := part["type"].(string)
						if t == "thinking" {
							text := stringField(part, "thinking", "text")
							if text == "" {
								if sig := stringField(part, "signature"); sig != "" {
									var sigObj map[string]any
									if json.Unmarshal([]byte(sig), &sigObj) == nil && sigObj != nil {
										text = stringField(sigObj, "thinking", "text")
									}
								}
							}
							if text != "" {
								a.emitter.emit("assistant.thinking", a.indexedEventData("assistant.thinking", map[string]any{"text": text}, ""), raw)
							}
						} else if t == "text" {
							text := stringField(part, "text")
							if text != "" {
								a.emitter.emit("assistant.message", a.nextAssistantEventData(map[string]any{"text": text}), raw)
							}
						}
					}
					return
				}
			}
		}
		if text := assistantTextFromRawMessage(raw); text != "" {
			a.emitter.emit(eventType, a.nextAssistantEventData(map[string]any{"text": text}), raw)
			return
		}
	}
	a.emitter.emit(eventType, nil, raw)
}

func (a *agentOutputAdapter) flush() {
	for _, sessionID := range a.startupInfoOrder {
		if text := a.startupInfo[sessionID].flush(); text != "" {
			a.appendAssistantText(text, nil)
		}
	}
	a.flushThinking()
	a.flushAssistant()
	a.userStreaming = false
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
		a.assistantEventKey = ""
		return
	}
	eventKey := a.assistantEventKey
	a.assistantEventKey = ""
	a.assistantStreamID = ""
	a.emitter.emit("assistant.message", a.nextAssistantEventDataWithKey(map[string]any{"text": text}, eventKey), raw)
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
		a.thinkingEventKey = ""
		return
	}
	eventKey := a.thinkingEventKey
	a.thinkingEventKey = ""
	a.thinkingStreamID = ""
	a.emitter.emit("assistant.thinking", a.nextThinkingEventDataWithKey(map[string]any{"text": text}, eventKey), raw)
}

func (a *agentOutputAdapter) handleACPJSONRPC(raw json.RawMessage) bool {
	var msg map[string]any
	if err := json.Unmarshal(raw, &msg); err != nil {
		return false
	}
	if msg["jsonrpc"] != "2.0" {
		return false
	}
	if sessionID, startupInfo := piStartupInfoFromJSONRPC(msg); sessionID != "" && startupInfo != "" {
		if _, exists := a.startupInfo[sessionID]; !exists {
			suppressor := &oneShotTextSuppressor{}
			suppressor.arm(startupInfo)
			a.startupInfo[sessionID] = suppressor
			a.startupInfoOrder = append(a.startupInfoOrder, sessionID)
		}
	}
	method, _ := msg["method"].(string)
	if method != "session/update" {
		if text := extractACPErrorText(string(raw)); text != "" {
			a.flush()
			a.emitter.markError(text)
			a.emitter.emit("task.error", map[string]string{"error": text}, raw)
			return true
		}
	}
	if method == "session/update" {
		params, _ := msg["params"].(map[string]any)
		update, _ := params["update"].(map[string]any)
		updateType, _ := update["sessionUpdate"].(string)
		if updateType == "user_message_chunk" {
			if !a.userStreaming {
				a.userStreaming = true
				a.seenUserPrompts++
			}
			var chunkText string
			if content, _ := update["content"].(map[string]any); content != nil {
				chunkText, _ = content["text"].(string)
			} else if contentText, _ := update["content"].(string); contentText != "" {
				chunkText = contentText
			}
			if chunkText != "" && a.observedPromptIsCurrent(chunkText) {
				a.reachedNewPrompt = true
			}
		} else if updateType != "" {
			a.userStreaming = false
		}
	} else {
		a.userStreaming = false
		if method == "session/prompt" {
			a.seenUserPrompts++
			if params, _ := msg["params"].(map[string]any); params != nil {
				promptText := acpContentText(params["prompt"])
				// ACP emits this outbound request only for the prompt command that
				// owns this stdout stream. Loaded history arrives as user chunks.
				if promptText != "" && (a.targetPrompt == "" || promptTextMatchesTarget(promptText, a.targetPrompt)) {
					a.reachedNewPrompt = true
				}
			}
		}
	}
	if !a.reachedNewPrompt && a.historyUserPrompts > 0 && a.seenUserPrompts == 0 && acpMessageStartsTurnContent(msg) {
		a.reachedNewPrompt = true
	}

	if !a.reachedNewPrompt && a.historyUserPrompts > 0 && a.seenUserPrompts <= a.historyUserPrompts {
		return true
	}

	if method != "session/update" {
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
	sessionID := stringField(params, "sessionId", "session_id")
	update, _ := params["update"].(map[string]any)
	updateType, _ := update["sessionUpdate"].(string)
	switch updateType {
	case "agent_message_chunk":
		a.flushThinking()
		a.appendAssistantChunk(sessionID, update, raw)
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
		a.emitter.emit("provider.raw", nil, raw)
	case "usage_update":
		a.flush()
		a.emitter.emit("metric.updated", nil, raw)
	case "tool_call", "tool_call_update":
		a.flush()
		a.emitRawToolUpdate(update, raw)
	default:
		a.flush()
		a.emitter.emit("provider.raw", nil, raw)
	}
	return true
}

func acpMessageStartsTurnContent(msg map[string]any) bool {
	method := stringField(msg, "method")
	if method == "session/request_permission" {
		return true
	}
	if method != "session/update" {
		return false
	}
	params, _ := msg["params"].(map[string]any)
	update, _ := params["update"].(map[string]any)
	switch stringField(update, "sessionUpdate") {
	case "agent_message_chunk", "agent_thought_chunk", "tool_call", "tool_call_update":
		return true
	default:
		return false
	}
}

func (a *agentOutputAdapter) observedPromptIsCurrent(promptText string) bool {
	if a == nil {
		return false
	}
	if a.historyUserPrompts > 0 && a.seenUserPrompts <= a.historyUserPrompts {
		return false
	}
	if strings.TrimSpace(a.targetPrompt) == "" {
		return true
	}
	return promptTextMatchesTarget(promptText, a.targetPrompt)
}

func promptTextMatchesTarget(promptText string, targetPrompt string) bool {
	promptText = strings.TrimSpace(promptText)
	targetPrompt = strings.TrimSpace(targetPrompt)
	if promptText == "" || targetPrompt == "" {
		return false
	}
	return strings.Contains(targetPrompt, promptText) || strings.Contains(promptText, targetPrompt)
}

func (a *agentOutputAdapter) appendAssistantChunk(sessionID string, update map[string]any, raw json.RawMessage) {
	text := textFromACPContent(update["content"])
	if text == "" {
		return
	}
	if suppressor := a.startupInfo[sessionID]; suppressor != nil {
		text = suppressor.filter(text)
		if text == "" {
			return
		}
	}
	if diagnostic, remainder, ok := splitACPProviderDiagnostic(text); ok {
		a.flushAssistant()
		a.emitter.emit("provider.raw", map[string]any{"stream": "assistant", "text": diagnostic}, raw)
		text = remainder
		if text == "" {
			return
		}
	}
	a.appendAssistantText(text, raw)
}

func splitACPProviderDiagnostic(text string) (string, string, bool) {
	trimmed := strings.TrimSpace(text)
	if isACPReconnectStatus(trimmed) {
		return trimmed, "", true
	}
	return splitCodexModelMetadataWarning(text)
}

func isACPReconnectStatus(text string) bool {
	const prefix = "Reconnecting... "
	progress, ok := strings.CutPrefix(text, prefix)
	if !ok {
		return false
	}
	current, total, ok := strings.Cut(progress, "/")
	return ok && !strings.Contains(total, "/") && decimalDigits(current) && decimalDigits(total)
}

func decimalDigits(value string) bool {
	if value == "" {
		return false
	}
	for _, char := range value {
		if char < '0' || char > '9' {
			return false
		}
	}
	return true
}

func splitCodexModelMetadataWarning(text string) (string, string, bool) {
	const prefix = "Warning: Model metadata for "
	const suffix = " not found. Defaulting to fallback metadata; this can degrade performance and cause issues."
	trimmed := strings.TrimLeft(text, " \t\r\n")
	if !strings.HasPrefix(trimmed, prefix) {
		return "", text, false
	}
	end := strings.Index(trimmed, suffix)
	if end < 0 {
		return "", text, false
	}
	end += len(suffix)
	for end < len(trimmed) && (trimmed[end] == '\r' || trimmed[end] == '\n') {
		end++
	}
	diagnostic := strings.TrimSpace(trimmed[:end])
	return diagnostic, trimmed[end:], true
}

func (a *agentOutputAdapter) appendAssistantText(text string, raw json.RawMessage) {
	a.assistantText.WriteString(text)
	a.assistantRaw = raw
	a.assistantStreaming = true
	if a.assistantStreamID == "" {
		a.streamCounter++
		a.assistantStreamID = fmt.Sprintf("%s-assistant-%d", a.streamPrefix, a.streamCounter)
	}
	if a.assistantEventKey == "" {
		a.assistantEventKey = a.nextAssistantEventKey()
	}
	a.emitter.emit("assistant.message", a.indexedEventData("assistant.message", map[string]any{
		"text":      a.assistantText.String(),
		"replace":   true,
		"stream_id": a.assistantStreamID,
	}, a.assistantEventKey), raw)
}

type oneShotTextSuppressor struct {
	target     string
	pending    string
	armed      bool
	configured bool
}

func (s *oneShotTextSuppressor) arm(target string) {
	if target == "" || s.configured {
		return
	}
	s.target = target
	s.armed = true
	s.configured = true
}

func (s *oneShotTextSuppressor) filter(text string) string {
	if !s.armed {
		return text
	}
	s.pending += text
	if strings.HasPrefix(s.target, s.pending) {
		if len(s.pending) < len(s.target) {
			return ""
		}
		s.armed = false
		s.pending = ""
		return ""
	}
	if strings.HasPrefix(s.pending, s.target) {
		remainder := strings.TrimPrefix(s.pending, s.target)
		s.armed = false
		s.pending = ""
		return remainder
	}
	pending := s.pending
	s.armed = false
	s.pending = ""
	return pending
}

func (s *oneShotTextSuppressor) flush() string {
	if !s.armed || s.pending == "" {
		return ""
	}
	pending := s.pending
	s.armed = false
	s.pending = ""
	return pending
}

func piStartupInfoFromJSONRPC(msg map[string]any) (string, string) {
	result, _ := msg["result"].(map[string]any)
	if result == nil {
		return "", ""
	}
	meta, _ := result["_meta"].(map[string]any)
	return stringField(result, "sessionId", "session_id"), piStartupInfoFromMeta(meta)
}

func piStartupInfoFromMeta(meta map[string]any) string {
	piMeta, _ := meta["piAcp"].(map[string]any)
	startupInfo, _ := piMeta["startupInfo"].(string)
	return startupInfo
}

func (a *agentOutputAdapter) appendThinkingChunk(update map[string]any, raw json.RawMessage) {
	text := textFromACPContent(update["content"])
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
	if a.thinkingEventKey == "" {
		a.thinkingEventKey = a.nextThinkingEventKey()
	}
	a.emitter.emit("assistant.thinking", a.indexedEventData("assistant.thinking", map[string]any{
		"text":      a.thinkingText.String(),
		"replace":   true,
		"stream_id": a.thinkingStreamID,
	}, a.thinkingEventKey), raw)
}

func (a *agentOutputAdapter) emitRawToolUpdate(update map[string]any, raw json.RawMessage) {
	id := stringField(update, "toolCallId", "tool_call_id", "id")
	if id == "" {
		id = protocol.NewID("tool")
	}
	state := a.toolUpdates[id]
	if name := stringField(update, "title", "kind", "name"); name != "" {
		state.name = name
	}
	if kind := stringField(update, "kind"); kind != "" {
		state.kind = kind
	}
	if status := stringField(update, "status"); status != "" {
		state.status = status
	}
	if input, ok := firstNonNilPresentValue(update, "rawInput", "raw_input", "input"); ok {
		state.input = input
	}
	if streamID := stringField(update, "streamId", "stream_id", "outputStreamId", "output_stream_id"); streamID != "" {
		state.streamID = streamID
	}

	updateType := stringField(update, "sessionUpdate")
	output, hasOutput := firstNonNilPresentValue(update, "rawOutput", "raw_output", "output", "result")
	if !hasOutput && updateType != "tool_call" {
		output, hasOutput = firstNonNilPresentValue(update, "content")
	}
	appendOutput := false
	if hasAnyKey(update, "outputDelta", "output_delta", "rawOutputDelta", "raw_output_delta") {
		output = firstPresentValue(update, "outputDelta", "output_delta", "rawOutputDelta", "raw_output_delta")
		hasOutput = true
		appendOutput = true
	}
	if delta, terminalID, ok := terminalOutputDelta(update); ok {
		output = delta
		hasOutput = true
		appendOutput = true
		if state.streamID == "" {
			state.streamID = terminalID
		}
	}
	var webSearchOutput map[string]any
	synthesizeWebSearchOutput := false
	if !hasOutput {
		webSearchOutput, synthesizeWebSearchOutput = completedWebSearchOutput(state.input, state.status)
	}
	if synthesizeWebSearchOutput && state.kind == "" {
		state.kind = "search"
	}

	data := map[string]any{
		"tool_use_id": id,
		"name":        state.name,
		"status":      state.status,
		"input":       state.input,
		"output":      output,
	}
	if state.kind != "" {
		data["kind"] = state.kind
	}
	if state.streamID != "" {
		data["stream_id"] = state.streamID
	}
	if appendValue, ok := boolField(update, "append", "isDelta", "is_delta", "delta"); ok {
		data["append"] = appendValue
	}
	if appendOutput {
		data["append"] = true
	}
	if synthesizeWebSearchOutput {
		if !state.callEmitted {
			a.emitToolUpdateEvent("tool.call", id, data, raw)
			state.callEmitted = true
		}
		data["output"] = webSearchOutput
		a.toolUpdates[id] = state
		a.emitToolUpdateEvent("tool.output", id, data, raw)
		return
	}
	eventType := "tool.call"
	if hasOutput {
		eventType = "tool.output"
	} else if statusIndicatesError(state.status) {
		eventType = "tool.output"
	}
	if eventType == "tool.call" {
		state.callEmitted = true
	}
	a.toolUpdates[id] = state
	a.emitToolUpdateEvent(eventType, id, data, raw)
}

func (a *agentOutputAdapter) emitToolUpdateEvent(eventType, id string, data map[string]any, raw json.RawMessage) {
	eventKey := ""
	if id != "" {
		eventKey = "turn:" + strconv.Itoa(a.turnIndex) + ":" + eventType + ":" + id
	} else {
		eventKey = indexedEventKey(a.turnIndex, eventType, a.toolOrdinal)
		a.toolOrdinal++
	}
	data = a.indexedEventData(eventType, data, eventKey)
	a.emitter.emit(eventType, data, raw)
}

func completedWebSearchOutput(input any, status string) (map[string]any, bool) {
	if !statusIndicatesCompleted(status) {
		return nil, false
	}
	inputMap, _ := input.(map[string]any)
	if inputMap == nil || !strings.EqualFold(strings.ReplaceAll(stringField(inputMap, "type"), "_", ""), "websearch") {
		return nil, false
	}
	action, _ := inputMap["action"].(map[string]any)
	if len(action) == 0 {
		return nil, false
	}
	output := map[string]any{
		"action": action,
		"status": status,
		"type":   inputMap["type"],
	}
	if query, ok := firstNonNilPresentValue(inputMap, "query", "search_query", "searchQuery"); ok {
		output["query"] = query
	}
	if queries, ok := firstNonNilPresentValue(action, "queries"); ok {
		output["queries"] = queries
	} else if queries, ok := firstNonNilPresentValue(inputMap, "queries"); ok {
		output["queries"] = queries
	}
	return output, true
}

func terminalOutputDelta(update map[string]any) (any, string, bool) {
	meta, _ := update["_meta"].(map[string]any)
	delta, _ := meta["terminal_output_delta"].(map[string]any)
	if delta == nil {
		return nil, "", false
	}
	value, ok := delta["data"]
	if !ok {
		return nil, "", false
	}
	return value, stringField(delta, "terminal_id", "terminalId"), true
}

func (a *agentOutputAdapter) nextAssistantEventKey() string {
	eventKey := indexedEventKey(a.turnIndex, "assistant.message", a.assistantOrdinal)
	a.assistantOrdinal++
	return eventKey
}

func (a *agentOutputAdapter) nextThinkingEventKey() string {
	eventKey := indexedEventKey(a.turnIndex, "assistant.thinking", a.thinkingOrdinal)
	a.thinkingOrdinal++
	return eventKey
}

func (a *agentOutputAdapter) nextAssistantEventData(data map[string]any) map[string]any {
	return a.nextAssistantEventDataWithKey(data, "")
}

func (a *agentOutputAdapter) nextAssistantEventDataWithKey(data map[string]any, eventKey string) map[string]any {
	if eventKey == "" {
		eventKey = a.nextAssistantEventKey()
	}
	return a.indexedEventData("assistant.message", data, eventKey)
}

func (a *agentOutputAdapter) nextThinkingEventDataWithKey(data map[string]any, eventKey string) map[string]any {
	if eventKey == "" {
		eventKey = a.nextThinkingEventKey()
	}
	return a.indexedEventData("assistant.thinking", data, eventKey)
}

func (a *agentOutputAdapter) indexedEventData(eventType string, data map[string]any, eventKey string) map[string]any {
	_ = eventType
	_ = eventKey
	return data
}

func firstPresentValue(values map[string]any, keys ...string) any {
	for _, key := range keys {
		if value, ok := values[key]; ok {
			return value
		}
	}
	return nil
}

func firstNonNilPresentValue(values map[string]any, keys ...string) (any, bool) {
	for _, key := range keys {
		if value, ok := values[key]; ok && value != nil {
			return value, true
		}
	}
	return nil, false
}

func boolField(values map[string]any, keys ...string) (bool, bool) {
	for _, key := range keys {
		value, ok := values[key]
		if !ok {
			continue
		}
		switch typed := value.(type) {
		case bool:
			return typed, true
		case string:
			switch strings.ToLower(strings.TrimSpace(typed)) {
			case "true", "1", "yes":
				return true, true
			case "false", "0", "no":
				return false, true
			}
		}
	}
	return false, false
}

func textFromACPContent(value any) string {
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

func statusIndicatesCompleted(status string) bool {
	switch strings.ToLower(strings.TrimSpace(status)) {
	case "completed", "complete", "success", "succeeded", "done":
		return true
	default:
		return false
	}
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

// claudeToolEventData extracts a normalized tool payload from a claude
// stream-json assistant/user message whose content array holds a tool_use or
// tool_result block. The frontend's tool-call renderer expects flat
// name/input/output/tool_use_id fields (the same shape emitRawToolUpdate
// produces for the ACP path); the raw claude shape buries them inside
// message.content[], so without this the tool card renders blank. Returns nil
// when no tool block is found (caller falls back to emitting raw with nil data).
func claudeToolEventData(raw json.RawMessage) map[string]any {
	var obj map[string]any
	if err := json.Unmarshal(raw, &obj); err != nil {
		return nil
	}
	message, _ := obj["message"].(map[string]any)
	content, _ := message["content"].([]any)
	for _, item := range content {
		part, _ := item.(map[string]any)
		switch partType, _ := part["type"].(string); partType {
		case "tool_use":
			id := stringField(part, "id", "tool_use_id")
			if id == "" {
				id = protocol.NewID("tool")
			}
			return map[string]any{
				"tool_use_id": id,
				"name":        stringField(part, "name"),
				"input":       part["input"],
				"status":      "running",
			}
		case "tool_result":
			id := stringField(part, "tool_use_id", "id")
			data := map[string]any{
				"tool_use_id": id,
				"output":      part["content"],
			}
			if isErr, _ := part["is_error"].(bool); isErr {
				data["is_error"] = true
				data["status"] = "failed"
			} else {
				data["status"] = "completed"
			}
			return data
		}
	}
	return nil
}

func assistantTextFromRawMessage(raw json.RawMessage) string {
	var obj map[string]any
	if err := json.Unmarshal(raw, &obj); err != nil {
		return ""
	}
	return strings.TrimSpace(textFromAssistantMessageObject(obj))
}

func textFromAssistantMessageObject(obj map[string]any) string {
	if text := stringField(obj, "text", "content"); text != "" {
		return text
	}
	if message, _ := obj["message"].(map[string]any); message != nil {
		if text := stringField(message, "text", "content"); text != "" {
			return text
		}
		if content, ok := message["content"]; ok {
			return acpContentText(content)
		}
	}
	if content, ok := obj["content"]; ok {
		return acpContentText(content)
	}
	return ""
}

func (d *Daemon) stopTask(taskID string) {
	if d.stopDirectACPTask(taskID) {
		return
	}
	d.emitError(
		taskID, "task_not_found",
		"direct ACP task is not running",
	)
}

func (d *Daemon) setTaskModel(parent context.Context, change protocol.TaskSetModel) {
	taskID :=
		strings.TrimSpace(change.
			TaskID)
	modelID := strings.TrimSpace(change.ModelID)
	if taskID ==
		"" ||
		modelID ==
			"" {
		if taskID ==
			"" {
			d.emitRequestError(change.RequestID,
				"bad_payload",
				"task.set_model requires task_id and model_id",
			)
			return

		}
		d.emitError(taskID,
			"bad_payload", "task.set_model requires task_id and model_id",
		)

		return
	}
	if d.setDirectACPModel(parent, change) {
		return
	}
	d.emitTaskEvent(taskID, "model.update_failed",
		0, map[string]string{"model_id": modelID, "error": "model switching requires an active direct ACP session"}, nil)
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
	_ = parent
	taskID := strings.TrimSpace(remove.
		TaskID)
	if taskID ==
		"" {
		d.emitRequestError(remove.
			RequestID,
			"bad_payload",

			"session.delete requires task_id",
		)
		return
	}
	d.
		deleteDirectACPSession(taskID)
	d.
		sendTaskSnapshot(context.
			Background(),

			[]string{taskID})
	d.sendSnapshot(context.Background())
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
	if err == nil && relToRoot != ".." && !strings.HasPrefix(relToRoot, ".."+string(filepath.Separator)) && !filepath.IsAbs(relToRoot) {
		if relToRoot == "." {
			return workspace, absTarget, ".", nil
		}
		return workspace, absTarget, filepath.ToSlash(relToRoot), nil
	}
	return workspace, absTarget, filepath.ToSlash(absTarget), nil
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

	var data []byte
	if strings.HasPrefix(request.Content, "data:") && strings.Contains(request.Content, ";base64,") {
		parts := strings.SplitN(request.Content, ";base64,", 2)
		if len(parts) == 2 {
			decoded, err := base64.StdEncoding.DecodeString(parts[1])
			if err == nil {
				data = decoded
			} else {
				data = []byte(request.Content)
			}
		} else {
			data = []byte(request.Content)
		}
	} else if strings.HasPrefix(request.Content, "base64:") {
		decoded, err := base64.StdEncoding.DecodeString(strings.TrimPrefix(request.Content, "base64:"))
		if err == nil {
			data = decoded
		} else {
			data = []byte(request.Content)
		}
	} else {
		data = []byte(request.Content)
	}

	if err := os.WriteFile(target, data, 0o644); err != nil {
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
		DirectMode:    request.DirectMode,
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

func (d *Daemon) deleteProject(request protocol.ProjectDeleteRequest) {
	d.mu.Lock()
	var targetWorkspacePath string
	targetProj, exists := d.projects[request.ProjectID]
	if exists {
		targetWorkspacePath = targetProj.WorkspacePath
	}
	d.mu.Unlock()

	if targetWorkspacePath == "" {
		if ids, err := loadWorkspaceProjectIDs(); err == nil {
			for path, id := range ids {
				if id == request.ProjectID {
					targetWorkspacePath = path
					break
				}
			}
		}
	}

	d.mu.Lock()
	idsToDelete := map[string]bool{request.ProjectID: true}
	for id, proj := range d.projects {
		if targetWorkspacePath != "" && proj.WorkspacePath == targetWorkspacePath {
			idsToDelete[id] = true
		}
	}

	deletedAny := false
	for id := range idsToDelete {
		if _, ok := d.projects[id]; ok {
			delete(d.projects, id)
			delete(d.projectStates, id)
			deletedAny = true
		}
	}

	if deletedAny {
		_ = d.saveProjectStoreLocked()
		_ = d.saveProjectStatesLocked()
	}
	d.mu.Unlock()

	if ids, err := loadWorkspaceProjectIDs(); err == nil {
		modified := false
		for path, id := range ids {
			if idsToDelete[id] || (targetWorkspacePath != "" && path == targetWorkspacePath) {
				delete(ids, path)
				modified = true
			}
		}
		if modified {
			_ = saveWorkspaceProjectIDs(ids)
		}
	}

	// Find and exit all terminal streams and tmux sessions associated with these project IDs.
	d.termMu.Lock()
	var ptysToExit []*runningPTY
	for _, rPty := range d.terminalPTYs {
		if idsToDelete[rPty.projectID] {
			ptysToExit = append(ptysToExit, rPty)
		}
	}
	d.termMu.Unlock()

	for _, rPty := range ptysToExit {
		d.exitTerminalStream(protocol.TerminalStreamExit{
			ProjectID:    rPty.projectID,
			TerminalID:   rPty.terminalID,
			CloseSession: true,
		})
	}

	d.sendProjectResult(protocol.ProjectResult{RequestID: request.RequestID, Project: nil})
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

func (d *Daemon) sendDeviceAliasResult(result protocol.DeviceAliasResult) {
	d.send <- protocol.NewEnvelope(protocol.TypeDeviceAliasSet, "daemon", result)
}

func (d *Daemon) sendProjectError(requestID string, message string) {
	d.sendProjectResult(protocol.ProjectResult{RequestID: requestID, Error: message})
}

func (d *Daemon) sendHello() {
	d.send <- protocol.NewEnvelope(protocol.TypeDaemonHello, "daemon", protocol.DaemonHello{
		DeviceID:       d.cfg.Device.ID,
		DeviceName:     d.cfg.DisplayDeviceName(),
		DaemonVersion:  "0.1.0",
		Agent:          d.agentName(),
		AgentLabel:     d.agentLabel(),
		Agents:         d.agentCapabilities(),
		Workspaces:     d.workspacesSnapshot(),
		Features:       []string{protocol.FeatureTerminalBinaryV1, protocol.FeatureDirectTerminalV1},
		DirectEndpoint: d.directEndpoint(),
	})
}

func (d *Daemon) setDeviceAlias(request protocol.DeviceAliasSetRequest) {
	if request.DeviceID != "" && request.DeviceID != d.cfg.Device.ID {
		d.sendDeviceAliasResult(protocol.DeviceAliasResult{RequestID: request.RequestID, Error: "device_id does not match this daemon"})
		return
	}
	alias := strings.TrimSpace(request.Alias)
	d.mu.Lock()
	cfg := d.cfg
	d.mu.Unlock()
	cfg.Device.Alias = alias
	if err := SaveConfigFile(cfg); err != nil {
		d.sendDeviceAliasResult(protocol.DeviceAliasResult{RequestID: request.RequestID, Error: err.Error()})
		return
	}
	d.mu.Lock()
	d.cfg = cfg
	d.mu.Unlock()
	deviceName := cfg.DisplayDeviceName()
	d.sendDeviceAliasResult(protocol.DeviceAliasResult{
		RequestID:  request.RequestID,
		DeviceID:   cfg.Device.ID,
		DeviceName: deviceName,
		Alias:      alias,
	})
	d.sendHello()
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
	ids := make([]string, 0, len(d.tasks)+len(d.startingTasks))
	for id := range d.tasks {
		ids = append(ids, id)
	}
	for id := range d.startingTasks {
		if _, running := d.tasks[id]; running {
			continue
		}
		ids = append(ids, id)
	}
	return ids
}

func (d *Daemon) sendSnapshot(ctx context.Context) {
	d.
		sendTaskSnapshot(ctx,
			nil)
}

func (d *Daemon) sendTaskSnapshot(ctx context.Context, deletedTaskIDs []string) {
	d.mu.Lock()
	tasks := make([]protocol.TaskRecord, 0, len(d.history))
	for _, record := range d.history {
		record.Events = normalizedTaskHistoryEvents(record)
		tasks = append(tasks, record)
	}
	d.mu.Unlock()
	envelope := protocol.NewEnvelope(protocol.TypeTaskSnapshot, "daemon", protocol.TaskSnapshot{
		DeviceID:       d.cfg.Device.ID,
		Tasks:          tasks,
		DeletedTaskIDs: deletedTaskIDs,
	})
	select {
	case d.send <- envelope:
	case <-ctx.Done():
	}
}

func indexedEventKey(turnIndex int, eventType string, ordinal int) string {
	if turnIndex < 0 {
		turnIndex = 0
	}
	if ordinal < 0 {
		ordinal = 0
	}
	return fmt.Sprintf("turn:%d:%s:%d", turnIndex, eventType, ordinal)
}

func acpContentText(value any) string {
	items, ok := value.([]any)
	if !ok {
		return acpTextPart(value)
	}
	parts := make([]string, 0, len(items))
	for _, item := range items {
		text := acpTextPart(item)
		if strings.TrimSpace(text) != "" {
			parts = append(parts, text)
		}
	}
	return strings.Join(parts, "\n")
}

func acpTextPart(value any) string {
	switch typed := value.(type) {
	case nil:
		return ""
	case string:
		trimmed := strings.TrimSpace(typed)
		if strings.HasPrefix(trimmed, "{") && strings.HasSuffix(trimmed, "}") {
			var parsed map[string]any
			if err := json.Unmarshal([]byte(trimmed), &parsed); err == nil && parsed != nil {
				if content, ok := parsed["content"]; ok {
					return acpContentText(content)
				}
				if text := stringField(parsed, "Text", "text", "content"); text != "" {
					return text
				}
			}
		}
		if strings.HasPrefix(trimmed, "[") && strings.HasSuffix(trimmed, "]") {
			var parsed []any
			if err := json.Unmarshal([]byte(trimmed), &parsed); err == nil {
				return acpContentText(parsed)
			}
		}
		return typed
	case map[string]any:
		if text := stringField(typed, "Text", "text", "content"); text != "" {
			return acpTextPart(text)
		}
		if nested, ok := typed["Text"]; ok {
			return acpTextPart(nested)
		}
	}
	return stringifyValue(value)
}

func textFieldFromEventJSON(raw json.RawMessage, keys ...string) string {
	if len(raw) == 0 {
		return ""
	}
	var data map[string]any
	if err := json.Unmarshal(raw, &data); err != nil {
		return ""
	}
	return strings.Join(strings.Fields(stringField(data, keys...)), " ")
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

func taskEventTurnID(event protocol.TaskEvent) string {
	for _, raw := range []json.RawMessage{event.Data, event.Raw} {
		if len(raw) == 0 {
			continue
		}
		var data map[string]any
		if err := json.Unmarshal(raw, &data); err != nil {
			continue
		}
		if turnID := stringField(data, "turn_id", "turnId"); turnID != "" {
			return turnID
		}
	}
	return ""
}

func latestPromptTurnID(events []protocol.TaskEvent) string {
	var selected protocol.TaskEvent
	found := false
	for _, event := range events {
		if event.EventType != "user.prompt" || taskEventTurnID(event) == "" {
			continue
		}
		if !found || event.Sequence > selected.Sequence ||
			(event.Sequence == selected.Sequence && event.Timestamp >= selected.Timestamp) {
			selected = event
			found = true
		}
	}
	return taskEventTurnID(selected)
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

	data = injectUniqueFields(data, seq)
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
	record.Events = upsertTaskEvent(record.Events, event)
	d.history[taskID] = record
	if isDirectACPRecord(record) {
		if err := d.saveDirectACPStoreLocked(); err != nil {
			log.Printf("save direct acp sessions: %v", err)
		}
	}
	d.mu.Unlock()

	d.sendTaskEvent(event)
	d.maybeSendAgentCompletionAlert(record, event)
}

func upsertTaskEvent(events []protocol.TaskEvent, event protocol.TaskEvent) []protocol.TaskEvent {
	return append(events, event)
}

func (d *Daemon) emitTaskEvent(taskID, eventType string, sequence int64, data any, raw json.RawMessage) {
	data = injectUniqueFields(data, sequence)
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
	d.sendTaskEvent(event)
}

func (d *Daemon) sendTaskEvent(event protocol.TaskEvent) {
	d.send <- protocol.NewEnvelope(protocol.TypeTaskEvent, "daemon", event)
	d.broadcastDirectAgentChatEvent(event)
}

func injectUniqueFields(data any, seq int64) any {
	if data == nil {
		return nil
	}
	if m, ok := data.(map[string]any); ok {
		newMap := make(map[string]any, len(m)+2)
		for k, v := range m {
			newMap[k] = v
		}
		newMap["_seq"] = seq
		newMap["_ts"] = time.Now().UnixNano()
		return newMap
	}
	if m, ok := data.(map[string]string); ok {
		newMap := make(map[string]any, len(m)+2)
		for k, v := range m {
			newMap[k] = v
		}
		newMap["_seq"] = seq
		newMap["_ts"] = time.Now().UnixNano()
		return newMap
	}
	return data
}

func userPromptTaskEvent(taskID, turnID, prompt string, timestamp int64, sequence int64, turnIndex int) protocol.TaskEvent {
	_ = turnIndex
	prompt = strings.TrimSpace(prompt)
	if taskID == "" || prompt == "" {
		return protocol.TaskEvent{}
	}
	data := map[string]any{"prompt": prompt}
	if turnID != "" {
		data["turn_id"] = turnID
	}
	dataRaw, _ := json.Marshal(data)
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
	turnID, turnIndex := historyPromptTurnMetadata(record.Events, record.AgentRuntime)
	promptEvent := userPromptTaskEvent(record.TaskID, turnID, record.Prompt, firstNonZero(record.StartedAt, record.UpdatedAt, protocolNow()), 0, turnIndex)
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

func historyPromptTurnMetadata(events []protocol.TaskEvent, agentRuntime string) (string, int) {
	turnID := ""
	turnIndex := -1
	for index := len(events) - 1; index >= 0; index-- {
		event := events[index]
		if event.EventType != "task.started" {
			continue
		}
		turnID = taskEventTurnID(event)
		break
	}
	_ = agentRuntime
	if turnID == "" {
		identityIndex := turnIndex
		if identityIndex < 0 {
			identityIndex = 0
		}
		turnID = fmt.Sprintf("history-turn-%d", identityIndex)
	}
	return turnID, turnIndex
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
	target := d.agentNotificationTarget(projectID, record)
	message := agentCompletionMessage(event.EventType)
	alert := d.agentCompletionAlert(projectID, target.hostProjectID, target.panelID, target.tabID, record.Agent, record.AgentRuntime, message)
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
	return runtime == "direct_acp"
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

type notificationTabTarget struct {
	hostProjectID string
	panelID       string
	tabID         string
}

func (d *Daemon) agentNotificationTarget(projectID string, record protocol.TaskRecord) notificationTabTarget {
	taskID := strings.TrimSpace(record.TaskID)
	sessionName := strings.TrimSpace(record.SessionName)
	states := d.projectStateSnapshot()
	for _, hostProjectID := range orderedProjectStateIDs(states, projectID) {
		target := agentTabTargetFromProjectState(states[hostProjectID], projectID, taskID, sessionName, hostProjectID == projectID)
		if target.tabID != "" {
			target.hostProjectID = hostProjectID
			return target
		}
	}
	return notificationTabTarget{hostProjectID: projectID, tabID: taskID}
}

func (d *Daemon) terminalNotificationTarget(projectID string, terminalID string) notificationTabTarget {
	terminalID = strings.TrimSpace(terminalID)
	states := d.projectStateSnapshot()
	for _, hostProjectID := range orderedProjectStateIDs(states, projectID) {
		target := terminalTabTargetFromProjectState(states[hostProjectID], projectID, terminalID, hostProjectID == projectID)
		if target.tabID != "" {
			target.hostProjectID = hostProjectID
			return target
		}
	}
	return notificationTabTarget{hostProjectID: projectID, tabID: terminalID}
}

func (d *Daemon) projectStateSnapshot() map[string]json.RawMessage {
	d.mu.Lock()
	defer d.mu.Unlock()
	states := make(map[string]json.RawMessage, len(d.projectStates)+len(d.projects))
	for id, raw := range d.projectStates {
		if id == "" || len(raw) == 0 {
			continue
		}
		states[id] = append(json.RawMessage(nil), raw...)
	}
	for id, project := range d.projects {
		if id == "" || len(project.StudioState) == 0 {
			continue
		}
		if _, ok := states[id]; !ok {
			states[id] = append(json.RawMessage(nil), project.StudioState...)
		}
	}
	return states
}

func orderedProjectStateIDs(states map[string]json.RawMessage, preferred string) []string {
	ids := make([]string, 0, len(states))
	if preferred != "" {
		if _, ok := states[preferred]; ok {
			ids = append(ids, preferred)
		}
	}
	rest := make([]string, 0, len(states))
	for id := range states {
		if id == "" || id == preferred {
			continue
		}
		rest = append(rest, id)
	}
	sort.Strings(rest)
	return append(ids, rest...)
}

func agentTabTargetFromProjectState(raw json.RawMessage, projectID string, taskID string, sessionName string, allowMissingProjectID bool) notificationTabTarget {
	if len(raw) == 0 {
		return notificationTabTarget{}
	}
	var state struct {
		LayoutTree any `json:"layoutTree"`
	}
	if json.Unmarshal(raw, &state) != nil {
		return notificationTabTarget{}
	}
	var found notificationTabTarget
	var walk func(any)
	walk = func(value any) {
		if found.tabID != "" {
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
				if !tabBelongsToProject(tab, projectID, allowMissingProjectID) {
					continue
				}
				agentSessionID, _ := tab["agentSessionId"].(string)
				agentSessionName, _ := tab["agentSessionName"].(string)
				if !matchesAnyNonEmpty(agentSessionID, taskID, sessionName) && !matchesAnyNonEmpty(agentSessionName, taskID, sessionName) {
					continue
				}
				found.panelID, _ = obj["id"].(string)
				found.tabID, _ = tab["id"].(string)
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

func terminalTabTargetFromProjectState(raw json.RawMessage, projectID string, terminalID string, allowMissingProjectID bool) notificationTabTarget {
	if len(raw) == 0 || terminalID == "" {
		return notificationTabTarget{}
	}
	var state struct {
		LayoutTree any `json:"layoutTree"`
	}
	if json.Unmarshal(raw, &state) != nil {
		return notificationTabTarget{}
	}
	var found notificationTabTarget
	var walk func(any)
	walk = func(value any) {
		if found.tabID != "" {
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
				if kind, _ := tab["kind"].(string); kind != "terminal" {
					continue
				}
				tabID, _ := tab["id"].(string)
				if tabID != terminalID || !tabBelongsToProject(tab, projectID, allowMissingProjectID) {
					continue
				}
				found.panelID, _ = obj["id"].(string)
				found.tabID = tabID
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

func tabBelongsToProject(tab map[string]any, projectID string, allowMissingProjectID bool) bool {
	tabProjectID, _ := tab["projectId"].(string)
	if strings.TrimSpace(tabProjectID) == "" {
		return allowMissingProjectID
	}
	return strings.TrimSpace(projectID) == "" || tabProjectID == projectID
}

func matchesAnyNonEmpty(value string, candidates ...string) bool {
	value = strings.TrimSpace(value)
	if value == "" {
		return false
	}
	for _, candidate := range candidates {
		if value == strings.TrimSpace(candidate) {
			return true
		}
	}
	return false
}

func (d *Daemon) agentCompletionAlert(projectID string, hostProjectID string, panelID string, tabID string, agent string, runtime string, message string) *protocol.TerminalStreamAlert {
	projectID = strings.TrimSpace(projectID)
	hostProjectID = strings.TrimSpace(hostProjectID)
	panelID = strings.TrimSpace(panelID)
	tabID = strings.TrimSpace(tabID)
	agent = strings.TrimSpace(agent)
	runtime = strings.TrimSpace(runtime)
	message = strings.TrimSpace(message)
	if projectID == "" || tabID == "" {
		return nil
	}
	if hostProjectID == "" {
		hostProjectID = projectID
	}
	if message == "" {
		message = "任务已完成"
	}
	key := projectID + "::" + hostProjectID + "::" + tabID + "::" + agent + "::" + runtime + "::" + message
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
		ProjectID:     projectID,
		HostProjectID: hostProjectID,
		PanelID:       panelID,
		TerminalID:    tabID,
		Reason:        "agent_done",
		Message:       message,
		Agent:         agent,
		Title:         agentNotificationTitle(agent, runtime),
	}
}

func agentNotificationTitle(agent string, runtime string) string {
	agent = strings.TrimSpace(agent)
	_ = runtime
	if agent != "" {
		return "对话 (" + agent + ")"
	}
	return "对话"
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
		for _, key := range []string{"sessionId", "acpxRecordId", "acpx_record_id", "acpxSessionId", "acpx_session_id", "agentSessionId"} {
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

type taskLifecycleState struct {
	status     string
	turn       int
	hasTurn    bool
	order      int64
	hasOrder   bool
	timestamp  int64
	sequence   int64
	eventIndex int
}

type taskTurn struct {
	index      int
	hasIndex   bool
	id         string
	startIndex int
	hasPrompt  bool
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
	defaultTmuxSocketName = "pocket-studio"
	tmuxHistoryLimit      = 50000
)

func tmuxSocketName() string {
	value := strings.TrimSpace(os.Getenv("POCKET_STUDIO_TMUX_SOCKET"))
	if value == "" || len(value) > 80 {
		return defaultTmuxSocketName
	}
	for _, char := range value {
		if (char >= 'a' && char <= 'z') || (char >= 'A' && char <= 'Z') ||
			(char >= '0' && char <= '9') || char == '-' || char == '_' || char == '.' {
			continue
		}
		return defaultTmuxSocketName
	}
	return value
}

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
		cmd.Env = tmuxProcessEnv(agentHooks.env...)
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
			d.broadcastDirectTerminalExit(exitPayload)
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
			d.broadcastDirectTerminalData(data)
			return
		}
		select {
		case d.sendBinary <- frame:
			d.broadcastDirectTerminalData(data)
			return
		default:
		}
	}
	d.send <- protocol.NewEnvelope(protocol.TypeTerminalStreamData, "daemon", data)
	d.broadcastDirectTerminalData(data)
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
	target := d.terminalNotificationTarget(projectID, terminalID)
	key := projectID + "::" + target.hostProjectID + "::" + target.tabID + "::" + agent + "::" + message
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
		ProjectID:     projectID,
		HostProjectID: target.hostProjectID,
		PanelID:       target.panelID,
		TerminalID:    target.tabID,
		Reason:        "agent_done",
		Message:       message,
		Agent:         agent,
	}
}

func (d *Daemon) sendTerminalSnapshot(projectID string, terminalID string, sessionName string) {
	if data := tmuxCapturePane(sessionName); len(data) > 0 {
		// Include mouse tracking enablement sequences so that reconnected clients
		// restore mouse reporting state in xterm.
		dataWithMouse := append(data, []byte("\x1b[?1000h\x1b[?1002h\x1b[?1006h")...)
		d.sendTerminalStreamData(protocol.TerminalStreamData{
			ProjectID:  projectID,
			TerminalID: terminalID,
			Data:       dataWithMouse,
		})
	}
	title, fullTitle, command := tmuxTerminalInfo(sessionName)
	if title != "" {
		titlePayload := protocol.TerminalStreamTitle{
			ProjectID:  projectID,
			TerminalID: terminalID,
			Title:      title,
			FullTitle:  fullTitle,
			Command:    command,
		}
		d.broadcastDirectTerminalTitle(titlePayload)
		d.send <- protocol.NewEnvelope(protocol.TypeTerminalStreamTitle, "daemon", titlePayload)
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
			titlePayload := protocol.TerminalStreamTitle{
				ProjectID:  projectID,
				TerminalID: terminalID,
				Title:      title,
				FullTitle:  fullTitle,
				Command:    command,
			}
			d.broadcastDirectTerminalTitle(titlePayload)
			d.send <- protocol.NewEnvelope(protocol.TypeTerminalStreamTitle, "daemon", titlePayload)
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
	} else if tmuxTitleLooksInitialPlaceholder(title, command) {
		title = terminalTitleFromCommand(command)
	}
	if currentPath != "" && tmuxTitleLooksShortenedPath(title) {
		title = compactPathTitle(currentPath)
	}
	return title
}

func terminalTitleFromCommand(command string) string {
	command = strings.TrimSpace(command)
	if command == "" {
		return ""
	}
	return initialTerminalTitle(command, "")
}

func tmuxTitleLooksInitialPlaceholder(title string, command string) bool {
	title = strings.TrimSpace(title)
	lowerTitle := strings.ToLower(title)
	if lowerTitle == "xterm" || lowerTitle == "xterm-256color" || lowerTitle == "tmux" || lowerTitle == "tmux-256color" || lowerTitle == "screen" || lowerTitle == "screen-256color" {
		return true
	}
	command = strings.TrimSpace(command)
	if title == "" || command == "" {
		return false
	}
	commandTitle, ok := knownTerminalTitleForCommand(command)
	if !ok {
		return false
	}
	switch title {
	case "Shell", "Claude Code", "Codex", "OpenCode", "Kilo Code", "Pi", "Antigravity", "Qwen Code", "Kimi", "GitHub Copilot", "Cursor Agent", "OpenClaw":
		return title != commandTitle
	default:
		return false
	}
}

func knownTerminalTitleForCommand(command string) (string, bool) {
	command = strings.TrimSpace(command)
	if command == "" || command == "bash" || command == "zsh" || command == "sh" {
		return "Shell", command != ""
	}
	switch {
	case strings.Contains(command, "claude"):
		return "Claude Code", true
	case strings.Contains(command, "codex"):
		return "Codex", true
	case command == "qwen" || strings.HasPrefix(command, "qwen "):
		return "Qwen Code", true
	case command == "kimi" || strings.HasPrefix(command, "kimi "):
		return "Kimi", true
	case command == "copilot" || strings.HasPrefix(command, "copilot "):
		return "GitHub Copilot", true
	case command == "cursor-agent" || strings.HasPrefix(command, "cursor-agent ") || command == "cursor" || strings.HasPrefix(command, "cursor "):
		return "Cursor Agent", true
	case strings.Contains(command, "openclaw"):
		return "OpenClaw", true
	case strings.Contains(command, "opencode"):
		return "OpenCode", true
	case strings.Contains(command, "kilo"):
		return "Kilo Code", true
	case command == "pi" || strings.HasPrefix(command, "pi "):
		return "Pi", true
	case command == "agy" || strings.Contains(command, "antigravity"):
		return "Antigravity", true
	default:
		return "", false
	}
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
	title = strings.TrimSpace(title)
	if title == "" {
		return true
	}
	if title == "~" || strings.HasPrefix(title, "~/") || strings.HasPrefix(title, "..") {
		return true
	}
	if strings.HasPrefix(title, "/") {
		return true
	}
	lower := strings.ToLower(title)
	if lower == "xterm" || lower == "xterm-256color" || lower == "tmux" || lower == "tmux-256color" || lower == "screen" || lower == "screen-256color" {
		return true
	}
	if lower == "localhost" {
		return true
	}
	if h, err := os.Hostname(); err == nil && lower == strings.ToLower(h) {
		return true
	}
	return false
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
	args := []string{"-u", "-L", tmuxSocketName(), "-f", configPath, "start-server", ";", "source-file", configPath, ";", "new-session", "-A", "-s", sessionName, "-n", initialTitle, "-c", workspacePath}
	for _, item := range env {
		key, _, ok := strings.Cut(item, "=")
		if !ok || strings.TrimSpace(key) == "" {
			continue
		}
		args = append(args, "-e", item)
	}
	if runtime.GOOS != "windows" {
		shell := userShell()
		if command == "" {
			command = "env -u TMUX " + shellQuote(shell)
		} else {
			command = "env -u TMUX " + command
		}
	}
	if command != "" {
		args = append(args, command)
	}
	return exec.Command("tmux", args...), nil
}

func tmuxCommand(args ...string) *exec.Cmd {
	fullArgs := append([]string{"-L", tmuxSocketName()}, args...)
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
set-option -g xterm-keys on
set-option -g history-limit 50000
set-option -g mouse on
set-option -g set-clipboard external
set-option -sg escape-time 10
set-option -g prefix C-a
unbind-key C-b
bind-key C-a send-prefix
unbind-key -n Home
unbind-key -n End
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

func tmuxProcessEnv(extra ...string) []string {
	env := terminalEnv(extra...)
	filtered := env[:0]
	for _, item := range env {
		if strings.HasPrefix(item, "POCKET_E2E_PROCESS_OWNER=") {
			continue
		}
		filtered = append(filtered, item)
	}
	return filtered
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
	case command == "qwen" || strings.HasPrefix(command, "qwen "):
		return "Qwen Code"
	case command == "kimi" || strings.HasPrefix(command, "kimi "):
		return "Kimi"
	case command == "copilot" || strings.HasPrefix(command, "copilot "):
		return "GitHub Copilot"
	case command == "cursor-agent" || strings.HasPrefix(command, "cursor-agent ") || command == "cursor" || strings.HasPrefix(command, "cursor "):
		return "Cursor Agent"
	case strings.Contains(command, "openclaw"):
		return "OpenClaw"
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
	return strings.TrimSpace(command)
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
	case "claude", "codex", "opencode", "kilo", "kilocode", "pi", "agy", "antigravity", "qwen", "kimi", "copilot", "cursor-agent", "cursor", "openclaw":
		if base == "cursor-agent" {
			return "cursor"
		}
		return base
	}
	switch {
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
	case strings.Contains(command, "openclaw"):
		return "openclaw"
	case strings.Contains(command, "cursor-agent") || strings.Contains(command, "cursor "):
		return "cursor"
	case strings.Contains(command, "copilot"):
		return "copilot"
	case strings.Contains(command, "qwen"):
		return "qwen"
	case strings.Contains(command, "kimi"):
		return "kimi"
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
			// Find all pane PIDs inside this tmux session
			listCmd := tmuxCommand("list-panes", "-t", rPty.sessionName, "-F", "#{pane_pid}")
			if output, err := listCmd.Output(); err == nil {
				lines := strings.Split(string(output), "\n")
				for _, line := range lines {
					line = strings.TrimSpace(line)
					if line == "" {
						continue
					}
					if pid, err := strconv.Atoi(line); err == nil && pid > 0 {
						killProcessesRecursively(pid)
					}
				}
			}
			_ = killTmuxSession(rPty.sessionName)
		}
	}
}
