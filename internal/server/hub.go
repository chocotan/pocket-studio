package server

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"log"
	"math"
	"mime"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
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

var (
	safeTerminalIDPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{1,96}$`)
)

const maxProjectFileReadSize = 8 * 1024 * 1024

type Project struct {
	ID            string          `json:"id"`
	Name          string          `json:"name"`
	DeviceID      string          `json:"device_id"`
	WorkspacePath string          `json:"workspace_path"`
	AgentIDs      []string        `json:"agent_ids"`
	TmuxIDs       []string        `json:"tmux_ids"`
	StudioState   json.RawMessage `json:"studio_state,omitempty"`
}

type Hub struct {
	mu            sync.RWMutex
	daemons       map[string]*daemonConn
	webs          map[*webConn]struct{}
	taskDevices   map[string]string
	taskEvents    map[string][]protocol.Envelope
	taskRecords   map[string]protocol.TaskRecord
	pending       map[string]chan protocol.Envelope
	projects      map[string]Project
	projectStates map[string]string // projectId -> JSON string
	termMu        sync.RWMutex
	terminalConns map[string]*terminalConn
	configDir     string
}

type daemonConn struct {
	deviceID   string
	deviceName string
	agent      string
	agentLabel string
	agents     []protocol.AgentCapability
	workspaces []protocol.Workspace
	conn       *websocket.Conn
	send       chan protocol.Envelope
	lastSeen   time.Time
}

type webConn struct {
	conn *websocket.Conn
	send chan protocol.Envelope
}

type terminalConn struct {
	conn *websocket.Conn
	mu   sync.Mutex
}

type DeviceView struct {
	ID         string                     `json:"id"`
	Name       string                     `json:"name"`
	Status     string                     `json:"status"`
	Agent      string                     `json:"agent,omitempty"`
	AgentLabel string                     `json:"agent_label,omitempty"`
	Agents     []protocol.AgentCapability `json:"agents,omitempty"`
	LastSeenAt int64                      `json:"last_seen_at"`
	Workspaces []protocol.Workspace       `json:"workspaces"`
}

type StateView struct {
	Devices []DeviceView          `json:"devices"`
	Tasks   []protocol.TaskRecord `json:"tasks"`
}

func NewHub() *Hub {
	h := &Hub{
		daemons:       make(map[string]*daemonConn),
		webs:          make(map[*webConn]struct{}),
		taskDevices:   make(map[string]string),
		taskEvents:    make(map[string][]protocol.Envelope),
		taskRecords:   make(map[string]protocol.TaskRecord),
		pending:       make(map[string]chan protocol.Envelope),
		projects:      make(map[string]Project),
		projectStates: make(map[string]string),
		terminalConns: make(map[string]*terminalConn),
	}
	h.configDir = pocketStudioConfigDir()
	if err := h.loadProjects(); err != nil {
		log.Printf("load projects: %v", err)
	}
	return h
}

func pocketStudioConfigDir() string {
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

func (h *Hub) projectsPath() string {
	return filepath.Join(h.configDir, "projects.json")
}

func (h *Hub) loadProjects() error {
	raw, err := os.ReadFile(h.projectsPath())
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil
		}
		return err
	}
	var projects []Project
	if err := json.Unmarshal(raw, &projects); err != nil {
		return err
	}
	for _, project := range projects {
		if project.ID == "" {
			continue
		}
		if project.AgentIDs == nil {
			project.AgentIDs = []string{}
		}
		if project.TmuxIDs == nil {
			project.TmuxIDs = []string{}
		}
		if len(project.StudioState) > 0 {
			h.projectStates[project.ID] = string(project.StudioState)
		}
		h.projects[project.ID] = project
	}
	return nil
}

func (h *Hub) saveProjectsLocked() error {
	projects := make([]Project, 0, len(h.projects))
	for _, project := range h.projects {
		projects = append(projects, project)
	}
	sort.Slice(projects, func(i, j int) bool {
		return projects[i].Name < projects[j].Name
	})
	if err := os.MkdirAll(h.configDir, 0o755); err != nil {
		return err
	}
	raw, err := json.MarshalIndent(projects, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(h.projectsPath(), append(raw, '\n'), 0o644)
}

func (h *Hub) newProjectIDLocked() string {
	for {
		id := protocol.NewUUIDNoDash()
		if _, exists := h.projects[id]; !exists {
			return id
		}
	}
}

func (h *Hub) projectByID(projectID string) (Project, bool) {
	if projectID == "" {
		return Project{}, false
	}
	h.mu.RLock()
	project, ok := h.projects[projectID]
	h.mu.RUnlock()
	return project, ok
}

func collectTerminalTabIDs(node any) []string {
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
		if typ == "pane" {
			if id, _ := obj["id"].(string); id != "" {
				ids = append(ids, id)
			}
			return
		}
		children, _ := obj["children"].([]any)
		for _, child := range children {
			walk(child)
		}
	}
	walk(node)
	return ids
}

func cleanStudioState(value any) {
	obj, ok := value.(map[string]any)
	if !ok {
		return
	}
	if layout, ok := obj["layoutTree"]; ok {
		cleanStudioLayout(layout)
	}
}

func cleanStudioLayout(value any) {
	obj, ok := value.(map[string]any)
	if !ok {
		return
	}
	if title, ok := obj["title"].(string); ok {
		obj["title"] = title
	}
	if tabs, ok := obj["tabs"].([]any); ok {
		for _, tabValue := range tabs {
			tab, ok := tabValue.(map[string]any)
			if !ok {
				continue
			}
			if title, ok := tab["title"].(string); ok {
				tab["title"] = title
			}
		}
	}
	if children, ok := obj["children"].([]any); ok {
		for _, child := range children {
			cleanStudioLayout(child)
		}
	}
}

var upgrader = websocket.Upgrader{
	CheckOrigin: func(r *http.Request) bool { return true },
}

func (h *Hub) ServeWebSocket(w http.ResponseWriter, r *http.Request) {
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("upgrade web: %v", err)
		return
	}
	wc := &webConn{conn: conn, send: make(chan protocol.Envelope, 64)}
	h.mu.Lock()
	h.webs[wc] = struct{}{}
	h.mu.Unlock()

	go writeLoop(conn, wc.send)
	wc.send <- protocol.NewEnvelope("server.state", "server", h.stateView())
	h.readWebLoop(wc)
}

func (h *Hub) ServeDaemonSocket(w http.ResponseWriter, r *http.Request) {
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("upgrade daemon: %v", err)
		return
	}

	dc := &daemonConn{conn: conn, send: make(chan protocol.Envelope, 64), lastSeen: time.Now()}
	go writeLoop(conn, dc.send)
	h.readDaemonLoop(dc)
}

func (h *Hub) ServeAPI(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path == "/api/state" && r.Method == http.MethodGet {
		writeJSON(w, http.StatusOK, h.stateView())
		return
	}
	if r.URL.Path == "/api/project/list" && r.Method == http.MethodGet {
		h.mu.RLock()
		list := make([]Project, 0, len(h.projects))
		for _, p := range h.projects {
			list = append(list, p)
		}
		h.mu.RUnlock()

		sort.Slice(list, func(i, j int) bool {
			return list[i].Name < list[j].Name
		})

		writeJSON(w, http.StatusOK, list)
		return
	}
	if r.URL.Path == "/api/project/create" && r.Method == http.MethodPost {
		var req Project
		if !decodeJSON(w, r, &req) {
			return
		}
		if req.Name == "" || req.DeviceID == "" || req.WorkspacePath == "" {
			writeJSON(w, http.StatusBadRequest, protocol.ServerError{Code: "bad_request", Message: "name, device_id, and workspace_path are required"})
			return
		}

		h.mu.Lock()
		req.ID = h.newProjectIDLocked()
		if req.AgentIDs == nil {
			req.AgentIDs = []string{}
		}
		if req.TmuxIDs == nil {
			req.TmuxIDs = []string{}
		}
		h.projects[req.ID] = req
		if err := h.saveProjectsLocked(); err != nil {
			h.mu.Unlock()
			writeJSON(w, http.StatusInternalServerError, protocol.ServerError{Code: "save_failed", Message: err.Error()})
			return
		}
		h.mu.Unlock()

		writeJSON(w, http.StatusOK, req)
		return
	}
	if r.URL.Path == "/api/project/state" {
		if r.Method == http.MethodGet {
			projID := r.URL.Query().Get("project_id")
			if projID == "" {
				writeJSON(w, http.StatusBadRequest, protocol.ServerError{Code: "bad_request", Message: "project_id is required"})
				return
			}

			h.mu.RLock()
			state, ok := h.projectStates[projID]
			h.mu.RUnlock()

			if !ok {
				if project, exists := h.projects[projID]; exists && len(project.StudioState) > 0 {
					state = string(project.StudioState)
					ok = true
				}
			}

			if !ok {
				writeJSON(w, http.StatusOK, map[string]any{
					"layoutTree":      nil,
					"focusedId":       "",
					"newTerminalType": "bash",
				})
				return
			}

			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write([]byte(state))
			return
		} else if r.Method == http.MethodPost {
			var req struct {
				ProjectID string `json:"project_id"`
				State     any    `json:"state"`
			}
			if !decodeJSON(w, r, &req) {
				return
			}
			if req.ProjectID == "" {
				writeJSON(w, http.StatusBadRequest, protocol.ServerError{Code: "bad_request", Message: "project_id is required"})
				return
			}

			cleanStudioState(req.State)
			rawState, err := json.Marshal(req.State)
			if err != nil {
				writeJSON(w, http.StatusBadRequest, protocol.ServerError{Code: "bad_payload", Message: err.Error()})
				return
			}

			h.mu.Lock()
			h.projectStates[req.ProjectID] = string(rawState)

			if proj, ok := h.projects[req.ProjectID]; ok {
				proj.StudioState = append(proj.StudioState[:0], rawState...)
				var parsedState struct {
					FocusedID  string `json:"focusedId"`
					LayoutTree any    `json:"layoutTree"`
				}
				if json.Unmarshal(rawState, &parsedState) == nil {
					if parsedState.FocusedID != "" {
						proj.TmuxIDs = collectTerminalTabIDs(parsedState.LayoutTree)
					}
				}
				h.projects[req.ProjectID] = proj
			}
			if err := h.saveProjectsLocked(); err != nil {
				h.mu.Unlock()
				writeJSON(w, http.StatusInternalServerError, protocol.ServerError{Code: "save_failed", Message: err.Error()})
				return
			}
			h.mu.Unlock()

			writeJSON(w, http.StatusOK, map[string]any{"success": true})
			return
		}
	}
	if r.URL.Path == "/api/project/files" && r.Method == http.MethodPost {
		var req struct {
			ProjectID string `json:"project_id"`
			Path      string `json:"path,omitempty"`
		}
		if !decodeJSON(w, r, &req) {
			return
		}
		if req.ProjectID == "" {
			writeJSON(w, http.StatusBadRequest, protocol.ServerError{Code: "bad_request", Message: "project_id is required"})
			return
		}
		h.mu.RLock()
		project, ok := h.projects[req.ProjectID]
		h.mu.RUnlock()
		if !ok {
			writeJSON(w, http.StatusNotFound, protocol.ServerError{Code: "not_found", Message: "project not found"})
			return
		}
		if project.DeviceID != "dev_local" {
			requestID := protocol.NewID("req")
			env, err := h.requestDaemon(r, protocol.TypeWorkspaceList, project.WorkspacePath, requestID, protocol.WorkspaceListRequest{
				RequestID:     requestID,
				WorkspacePath: project.WorkspacePath,
				Path:          req.Path,
			})
			writeAPIEnvelope(w, env, err)
			return
		}
		res, _ := h.handleLocalWorkspaceList(protocol.WorkspaceListRequest{
			RequestID:     protocol.NewID("req"),
			WorkspacePath: project.WorkspacePath,
			Path:          req.Path,
		})
		writeJSON(w, http.StatusOK, res)
		return
	}
	if r.URL.Path == "/api/project/search-files" && r.Method == http.MethodPost {
		var req struct {
			ProjectID string `json:"project_id"`
			Query     string `json:"query"`
			Limit     int    `json:"limit,omitempty"`
		}
		if !decodeJSON(w, r, &req) {
			return
		}
		project, ok := h.projectByID(req.ProjectID)
		if !ok {
			writeJSON(w, http.StatusNotFound, protocol.ServerError{Code: "not_found", Message: "project not found"})
			return
		}
		if project.DeviceID != "dev_local" {
			writeJSON(w, http.StatusBadRequest, protocol.ServerError{Code: "unsupported", Message: "remote file search is not supported yet"})
			return
		}
		writeJSON(w, http.StatusOK, h.handleLocalProjectFileSearch(project, req.Query, req.Limit))
		return
	}
	if r.URL.Path == "/api/project/file/read" && r.Method == http.MethodPost {
		var req struct {
			ProjectID string `json:"project_id"`
			Path      string `json:"path"`
		}
		if !decodeJSON(w, r, &req) {
			return
		}
		project, ok := h.projectByID(req.ProjectID)
		if !ok {
			writeJSON(w, http.StatusNotFound, protocol.ServerError{Code: "not_found", Message: "project not found"})
			return
		}
		if project.DeviceID != "dev_local" {
			requestID := protocol.NewID("req")
			env, err := h.requestDaemon(r, protocol.TypeWorkspaceRead, project.WorkspacePath, requestID, protocol.WorkspaceReadRequest{
				RequestID:     requestID,
				WorkspacePath: project.WorkspacePath,
				Path:          req.Path,
			})
			writeAPIEnvelope(w, env, err)
			return
		}
		writeJSON(w, http.StatusOK, h.handleLocalProjectFileRead(project, req.Path))
		return
	}
	if r.URL.Path == "/api/project/file/write" && r.Method == http.MethodPost {
		var req struct {
			ProjectID string `json:"project_id"`
			Path      string `json:"path"`
			Content   string `json:"content"`
		}
		if !decodeJSON(w, r, &req) {
			return
		}
		project, ok := h.projectByID(req.ProjectID)
		if !ok {
			writeJSON(w, http.StatusNotFound, protocol.ServerError{Code: "not_found", Message: "project not found"})
			return
		}
		if project.DeviceID != "dev_local" {
			requestID := protocol.NewID("req")
			env, err := h.requestDaemon(r, protocol.TypeWorkspaceWrite, project.WorkspacePath, requestID, protocol.WorkspaceWriteRequest{
				RequestID:     requestID,
				WorkspacePath: project.WorkspacePath,
				Path:          req.Path,
				Content:       req.Content,
			})
			writeAPIEnvelope(w, env, err)
			return
		}
		writeJSON(w, http.StatusOK, h.handleLocalProjectFileWrite(project, req.Path, req.Content))
		return
	}
	if r.URL.Path == "/api/project/file/action" && r.Method == http.MethodPost {
		var req struct {
			ProjectID string `json:"project_id"`
			Action    string `json:"action"`
			Path      string `json:"path"`
			Target    string `json:"target,omitempty"`
		}
		if !decodeJSON(w, r, &req) {
			return
		}
		project, ok := h.projectByID(req.ProjectID)
		if !ok {
			writeJSON(w, http.StatusNotFound, protocol.ServerError{Code: "not_found", Message: "project not found"})
			return
		}
		if project.DeviceID != "dev_local" {
			writeJSON(w, http.StatusBadRequest, protocol.ServerError{Code: "unsupported", Message: "remote file actions are not supported yet"})
			return
		}
		writeJSON(w, http.StatusOK, h.handleLocalProjectFileAction(project, req.Action, req.Path, req.Target))
		return
	}
	if r.URL.Path == "/api/workspace/list" && r.Method == http.MethodPost {
		var req protocol.WorkspaceListRequest
		if !decodeJSON(w, r, &req) {
			return
		}
		deviceID := r.URL.Query().Get("device_id")
		if deviceID == "dev_local" {
			res, _ := h.handleLocalWorkspaceList(req)
			writeJSON(w, http.StatusOK, res)
			return
		}
		env, err := h.requestDaemon(r, protocol.TypeWorkspaceList, req.WorkspacePath, req.RequestID, req)
		writeAPIEnvelope(w, env, err)
		return
	}
	if r.URL.Path == "/api/workspace/read" && r.Method == http.MethodPost {
		var req protocol.WorkspaceReadRequest
		if !decodeJSON(w, r, &req) {
			return
		}
		deviceID := r.URL.Query().Get("device_id")
		if deviceID == "dev_local" {
			res, _ := h.handleLocalWorkspaceRead(req)
			writeJSON(w, http.StatusOK, res)
			return
		}
		env, err := h.requestDaemon(r, protocol.TypeWorkspaceRead, req.WorkspacePath, req.RequestID, req)
		writeAPIEnvelope(w, env, err)
		return
	}
	if r.URL.Path == "/api/workspace/write" && r.Method == http.MethodPost {
		var req protocol.WorkspaceWriteRequest
		if !decodeJSON(w, r, &req) {
			return
		}
		deviceID := r.URL.Query().Get("device_id")
		if deviceID == "dev_local" {
			res, _ := h.handleLocalWorkspaceWrite(req)
			writeJSON(w, http.StatusOK, res)
			return
		}
		env, err := h.requestDaemon(r, protocol.TypeWorkspaceWrite, req.WorkspacePath, req.RequestID, req)
		writeAPIEnvelope(w, env, err)
		return
	}
	if r.URL.Path == "/api/terminal/run" && r.Method == http.MethodPost {
		var req protocol.TerminalRunRequest
		if !decodeJSON(w, r, &req) {
			return
		}
		env, err := h.requestDaemon(r, protocol.TypeTerminalRun, req.WorkspacePath, req.RequestID, req)
		writeAPIEnvelope(w, env, err)
		return
	}
	if r.URL.Path == "/api/terminal/close" && r.Method == http.MethodPost {
		var req struct {
			ProjectID  string `json:"project_id"`
			TerminalID string `json:"terminal_id"`
		}
		if !decodeJSON(w, r, &req) {
			return
		}
		if req.ProjectID == "" || req.TerminalID == "" {
			writeJSON(w, http.StatusBadRequest, protocol.ServerError{Code: "bad_request", Message: "project_id and terminal_id are required"})
			return
		}
		h.closeTerminal(req.ProjectID, req.TerminalID)
		writeJSON(w, http.StatusOK, map[string]any{"success": true})
		return
	}
	http.NotFound(w, r)
}

func (h *Hub) readWebLoop(wc *webConn) {
	defer func() {
		h.mu.Lock()
		delete(h.webs, wc)
		h.mu.Unlock()
		close(wc.send)
		_ = wc.conn.Close()
	}()

	for {
		var env protocol.Envelope
		if err := wc.conn.ReadJSON(&env); err != nil {
			return
		}
		switch env.Type {
		case protocol.TypeSessionCreate:
			session, err := protocol.DecodePayload[protocol.SessionCreate](env)
			if err != nil {
				wc.send <- serverError("bad_payload", err.Error())
				continue
			}
			deviceID := env.To.DeviceID
			if deviceID == "" {
				wc.send <- serverError("missing_device", "session.create requires to.device_id")
				continue
			}
			h.mu.Lock()
			dc := h.daemons[deviceID]
			if dc != nil {
				h.taskDevices[session.TaskID] = deviceID
				now := time.Now().Unix()
				record := h.taskRecords[session.TaskID]
				if record.TaskID == "" {
					record.TaskID = session.TaskID
					record.StartedAt = now
				}
				record.DeviceID = deviceID
				record.WorkspaceID = session.WorkspaceID
				record.WorkspacePath = session.WorkspacePath
				record.Agent = session.Agent
				record.SessionName = session.SessionName
				record.Prompt = ""
				record.Status = "created"
				record.UpdatedAt = now
				h.taskRecords[session.TaskID] = record
			}
			h.mu.Unlock()
			if dc == nil {
				wc.send <- serverError("device_offline", "target device is offline")
				continue
			}
			forward := env
			forward.From = "server"
			if forward.ID == "" {
				forward.ID = protocol.NewID("msg")
			}
			dc.send <- forward
		case protocol.TypeTaskDispatch:
			task, err := protocol.DecodePayload[protocol.TaskDispatch](env)
			if err != nil {
				wc.send <- serverError("bad_payload", err.Error())
				continue
			}
			deviceID := env.To.DeviceID
			if deviceID == "" {
				wc.send <- serverError("missing_device", "task.dispatch requires to.device_id")
				continue
			}
			h.mu.Lock()
			dc := h.daemons[deviceID]
			if dc != nil {
				h.taskDevices[task.TaskID] = deviceID
				now := time.Now().Unix()
				record := h.taskRecords[task.TaskID]
				if record.TaskID == "" {
					record.TaskID = task.TaskID
					record.StartedAt = now
				}
				record.DeviceID = deviceID
				record.WorkspaceID = task.WorkspaceID
				record.WorkspacePath = task.WorkspacePath
				record.Agent = task.Agent
				record.SessionName = task.SessionName
				record.ModelID = task.ModelID
				record.Prompt = task.Prompt
				record.ParentTaskID = task.ParentTaskID
				if task.ResumeSessionID != "" {
					record.SessionID = task.ResumeSessionID
				}
				record.Status = "queued"
				record.UpdatedAt = now
				if !hasLatestUserPrompt(record.Events, task.Prompt) {
					userEvent := protocol.TaskEvent{
						TaskID:    task.TaskID,
						EventID:   protocol.NewID("evt"),
						EventType: "user.prompt",
						Source:    "web",
						Sequence:  int64(len(record.Events) + 1),
						Timestamp: now,
						Data:      MarshalPayload(map[string]string{"prompt": task.Prompt}),
					}
					record.Events = appendBounded(record.Events, userEvent, 1000)
				}
				h.taskRecords[task.TaskID] = record
			}
			h.mu.Unlock()
			if dc == nil {
				wc.send <- serverError("device_offline", "target device is offline")
				continue
			}
			forward := env
			forward.From = "server"
			if forward.ID == "" {
				forward.ID = protocol.NewID("msg")
			}
			dc.send <- forward
		case protocol.TypeTaskStop:
			stop, err := protocol.DecodePayload[protocol.TaskStop](env)
			if err != nil {
				wc.send <- serverError("bad_payload", err.Error())
				continue
			}
			h.mu.RLock()
			deviceID := h.taskDevices[stop.TaskID]
			dc := h.daemons[deviceID]
			h.mu.RUnlock()
			if dc == nil {
				wc.send <- serverError("task_not_routable", "task has no connected daemon")
				continue
			}
			forward := env
			forward.From = "server"
			dc.send <- forward
		case protocol.TypeTaskSetModel:
			change, err := protocol.DecodePayload[protocol.TaskSetModel](env)
			if err != nil {
				wc.send <- serverError("bad_payload", err.Error())
				continue
			}
			if change.TaskID == "" || change.ModelID == "" {
				wc.send <- serverError("bad_payload", "task.set_model requires task_id and model_id")
				continue
			}
			h.mu.RLock()
			deviceID := h.taskDevices[change.TaskID]
			dc := h.daemons[deviceID]
			h.mu.RUnlock()
			if dc == nil {
				wc.send <- serverError("task_not_routable", "task has no connected daemon")
				continue
			}
			forward := env
			forward.From = "server"
			dc.send <- forward
		case protocol.TypeSessionDelete:
			remove, err := protocol.DecodePayload[protocol.SessionDelete](env)
			if err != nil {
				wc.send <- serverError("bad_payload", err.Error())
				continue
			}
			if remove.TaskID == "" {
				wc.send <- serverError("bad_payload", "session.delete requires task_id")
				continue
			}
			h.mu.RLock()
			deviceID := env.To.DeviceID
			if deviceID == "" {
				deviceID = h.taskDevices[remove.TaskID]
			}
			dc := h.daemons[deviceID]
			h.mu.RUnlock()
			if dc == nil {
				wc.send <- serverError("task_not_routable", "session has no connected daemon")
				continue
			}
			forward := env
			forward.From = "server"
			dc.send <- forward
		case protocol.TypeWorkspaceList, protocol.TypeWorkspaceRead, protocol.TypeWorkspaceWrite, protocol.TypeTerminalRun:
			deviceID := env.To.DeviceID
			if deviceID == "" {
				wc.send <- serverError("missing_device", env.Type+" requires to.device_id")
				continue
			}
			h.mu.RLock()
			dc := h.daemons[deviceID]
			h.mu.RUnlock()
			if dc == nil {
				wc.send <- serverError("device_offline", "target device is offline")
				continue
			}
			forward := env
			forward.From = "server"
			if forward.ID == "" {
				forward.ID = protocol.NewID("msg")
			}
			dc.send <- forward
		default:
			wc.send <- serverError("unsupported_type", "unsupported web message type")
		}
	}
}

func (h *Hub) closeTerminal(projectID string, terminalID string) {
	key := projectID + "::" + terminalID
	h.termMu.Lock()
	if wc := h.terminalConns[key]; wc != nil {
		_ = wc.conn.Close()
		delete(h.terminalConns, key)
	}
	h.termMu.Unlock()

	h.mu.RLock()
	project, ok := h.projects[projectID]
	var dc *daemonConn
	if ok {
		dc = h.daemons[project.DeviceID]
	}
	h.mu.RUnlock()

	if dc != nil {
		dc.send <- protocol.NewEnvelope(protocol.TypeTerminalStreamExit, "server", protocol.TerminalStreamExit{
			ProjectID:  projectID,
			TerminalID: terminalID,
		})
		return
	}

	sessionName := "pocket-studio-" + projectID + "-" + terminalID
	_ = exec.Command("tmux", "kill-session", "-t", sessionName).Run()
}

func (h *Hub) readDaemonLoop(dc *daemonConn) {
	defer func() {
		h.mu.Lock()
		if dc.deviceID != "" && h.daemons[dc.deviceID] == dc {
			delete(h.daemons, dc.deviceID)
		}
		h.mu.Unlock()
		h.broadcast(protocol.NewEnvelope("server.state", "server", h.stateView()))
		close(dc.send)
		_ = dc.conn.Close()
	}()

	for {
		var env protocol.Envelope
		if err := dc.conn.ReadJSON(&env); err != nil {
			return
		}
		switch env.Type {
		case protocol.TypeDaemonHello:
			hello, err := protocol.DecodePayload[protocol.DaemonHello](env)
			if err != nil {
				dc.send <- serverError("bad_payload", err.Error())
				continue
			}
			dc.deviceID = hello.DeviceID
			dc.deviceName = hostinfo.ResolveDeviceName(hello.DeviceName)
			dc.agent = hello.Agent
			dc.agentLabel = hello.AgentLabel
			dc.agents = hello.Agents
			dc.workspaces = hello.Workspaces
			dc.lastSeen = time.Now()
			h.mu.Lock()
			if old := h.daemons[hello.DeviceID]; old != nil && old != dc {
				_ = old.conn.Close()
			}
			h.daemons[hello.DeviceID] = dc
			h.mu.Unlock()
			h.broadcast(protocol.NewEnvelope("server.state", "server", h.stateView()))
		case protocol.TypeDaemonHeartbeat, protocol.TypeDaemonSnapshot:
			dc.lastSeen = time.Now()
			h.broadcast(protocol.NewEnvelope("server.state", "server", h.stateView()))
		case protocol.TypeTaskSnapshot:
			snapshot, err := protocol.DecodePayload[protocol.TaskSnapshot](env)
			if err != nil {
				dc.send <- serverError("bad_payload", err.Error())
				continue
			}
			h.mu.Lock()
			seen := make(map[string]struct{}, len(snapshot.Tasks))
			for _, record := range snapshot.Tasks {
				seen[record.TaskID] = struct{}{}
				h.taskDevices[record.TaskID] = snapshot.DeviceID
				record.DeviceID = snapshot.DeviceID
				h.taskRecords[record.TaskID] = record
			}
			for taskID, deviceID := range h.taskDevices {
				if deviceID != snapshot.DeviceID {
					continue
				}
				if _, ok := seen[taskID]; ok {
					continue
				}
				delete(h.taskDevices, taskID)
				delete(h.taskRecords, taskID)
				delete(h.taskEvents, taskID)
			}
			h.mu.Unlock()
			h.broadcast(protocol.NewEnvelope("server.state", "server", h.stateView()))
		case protocol.TypeTaskEvent:
			taskEvent, err := protocol.DecodePayload[protocol.TaskEvent](env)
			if err == nil && taskEvent.TaskID != "" {
				h.mu.Lock()
				if dc.deviceID != "" {
					h.taskDevices[taskEvent.TaskID] = dc.deviceID
				}
				h.taskEvents[taskEvent.TaskID] = appendBounded(h.taskEvents[taskEvent.TaskID], env, 1000)
				record := h.taskRecords[taskEvent.TaskID]
				record.TaskID = taskEvent.TaskID
				if sessionID := extractSessionID(taskEvent); sessionID != "" {
					record.SessionID = sessionID
				}
				if dc.deviceID != "" {
					record.DeviceID = dc.deviceID
				}
				if modelID := extractModelID(taskEvent); modelID != "" {
					record.ModelID = modelID
				}
				record.Status = statusFromEvent(taskEvent.EventType, record.Status)
				record.UpdatedAt = time.Now().Unix()
				if taskEvent.Timestamp == 0 {
					taskEvent.Timestamp = record.UpdatedAt
				}
				record.Events = appendBounded(record.Events, taskEvent, 1000)
				h.taskRecords[taskEvent.TaskID] = record
				h.mu.Unlock()
			}
			forward := env
			forward.From = "server"
			h.broadcast(forward)
		case protocol.TypeTerminalStreamData:
			streamData, err := protocol.DecodePayload[protocol.TerminalStreamData](env)
			if err == nil {
				key := streamData.ProjectID + "::" + streamData.TerminalID
				h.termMu.RLock()
				wc := h.terminalConns[key]
				h.termMu.RUnlock()
				if wc != nil {
					wc.mu.Lock()
					_ = wc.conn.WriteMessage(websocket.BinaryMessage, streamData.Data)
					wc.mu.Unlock()
				}
			}
		case protocol.TypeTerminalStreamTitle:
			streamTitle, err := protocol.DecodePayload[protocol.TerminalStreamTitle](env)
			if err == nil {
				key := streamTitle.ProjectID + "::" + streamTitle.TerminalID
				h.termMu.RLock()
				wc := h.terminalConns[key]
				h.termMu.RUnlock()
				if wc != nil {
					wc.mu.Lock()
					_ = wc.conn.WriteJSON(map[string]string{
						"type":    "title",
						"title":   streamTitle.Title,
						"command": streamTitle.Command,
					})
					wc.mu.Unlock()
				}
			}
		case protocol.TypeTerminalStreamExit:
			streamExit, err := protocol.DecodePayload[protocol.TerminalStreamExit](env)
			if err == nil {
				key := streamExit.ProjectID + "::" + streamExit.TerminalID
				h.termMu.Lock()
				wc := h.terminalConns[key]
				delete(h.terminalConns, key)
				h.termMu.Unlock()
				if wc != nil {
					_ = wc.conn.Close()
				}
			}
		case protocol.TypeWorkspaceResult, protocol.TypeTerminalResult:
			if h.resolvePending(env) {
				continue
			}
			forward := env
			forward.From = "server"
			h.broadcast(forward)
		default:
			log.Printf("daemon %s sent unsupported type %s", dc.deviceID, env.Type)
		}
	}
}

func (h *Hub) stateView() StateView {
	h.mu.RLock()
	defer h.mu.RUnlock()
	devices := make([]DeviceView, 0, len(h.daemons)+1)
	hasLocalDaemon := false
	for _, dc := range h.daemons {
		if dc.deviceID == "dev_local" {
			hasLocalDaemon = true
		}
		devices = append(devices, DeviceView{
			ID:         dc.deviceID,
			Name:       dc.deviceName,
			Status:     "online",
			Agent:      dc.agent,
			AgentLabel: dc.agentLabel,
			Agents:     dc.agents,
			LastSeenAt: dc.lastSeen.Unix(),
			Workspaces: dc.workspaces,
		})
	}

	localWorkspaces := []protocol.Workspace{}
	localWorkspacesSeen := make(map[string]bool)
	for _, proj := range h.projects {
		if proj.DeviceID == "dev_local" && proj.WorkspacePath != "" {
			if !localWorkspacesSeen[proj.WorkspacePath] {
				localWorkspacesSeen[proj.WorkspacePath] = true
				localWorkspaces = append(localWorkspaces, protocol.Workspace{
					ID:   "ws-" + proj.ID,
					Name: proj.Name,
					Path: proj.WorkspacePath,
				})
			}
		}
	}
	if len(localWorkspaces) == 0 {
		localWorkspaces = append(localWorkspaces, protocol.Workspace{
			ID:   "local-agent",
			Name: "Agent",
			Path: "/home/choco/Agent",
		})
	}

	if !hasLocalDaemon {
		devices = append(devices, DeviceView{
			ID:         "dev_local",
			Name:       hostinfo.DisplayName(),
			Status:     "online",
			Agent:      "claude",
			AgentLabel: "Claude Code",
			Agents: []protocol.AgentCapability{
				{Name: "claude", Label: "Claude Code"},
				{Name: "bash", Label: "Standard Bash"},
				{Name: "gemini", Label: "Gemini CLI"},
			},
			LastSeenAt: time.Now().Unix(),
			Workspaces: localWorkspaces,
		})
	}

	tasks := make([]protocol.TaskRecord, 0, len(h.taskRecords))
	for _, record := range h.taskRecords {
		tasks = append(tasks, record)
	}
	sort.Slice(tasks, func(i, j int) bool {
		return tasks[i].UpdatedAt > tasks[j].UpdatedAt
	})
	return StateView{Devices: devices, Tasks: tasks}
}

func (h *Hub) requestDaemon(r *http.Request, messageType string, workspacePath string, requestID string, payload any) (protocol.Envelope, error) {
	if requestID == "" {
		requestID = protocol.NewID("req")
		switch typed := payload.(type) {
		case protocol.WorkspaceListRequest:
			typed.RequestID = requestID
			payload = typed
		case protocol.WorkspaceReadRequest:
			typed.RequestID = requestID
			payload = typed
		case protocol.WorkspaceWriteRequest:
			typed.RequestID = requestID
			payload = typed
		case protocol.TerminalRunRequest:
			typed.RequestID = requestID
			payload = typed
		}
	}
	deviceID := r.URL.Query().Get("device_id")
	h.mu.RLock()
	if deviceID == "" {
		for _, dc := range h.daemons {
			if workspacePath == "" || daemonHasWorkspace(dc, workspacePath) {
				deviceID = dc.deviceID
				break
			}
		}
	}
	dc := h.daemons[deviceID]
	h.mu.RUnlock()
	if dc == nil {
		return protocol.Envelope{}, errors.New("target device is offline")
	}
	response := make(chan protocol.Envelope, 1)
	h.mu.Lock()
	h.pending[requestID] = response
	h.mu.Unlock()
	defer func() {
		h.mu.Lock()
		delete(h.pending, requestID)
		h.mu.Unlock()
	}()
	env := protocol.NewEnvelope(messageType, "server", payload)
	env.To.DeviceID = deviceID
	dc.send <- env
	select {
	case result := <-response:
		return result, nil
	case <-r.Context().Done():
		return protocol.Envelope{}, r.Context().Err()
	case <-time.After(30 * time.Second):
		return protocol.Envelope{}, errors.New("daemon request timed out")
	}
}

func (h *Hub) resolvePending(env protocol.Envelope) bool {
	requestID := requestIDFromEnvelope(env)
	if requestID == "" {
		return false
	}
	h.mu.RLock()
	ch := h.pending[requestID]
	h.mu.RUnlock()
	if ch == nil {
		return false
	}
	select {
	case ch <- env:
	default:
	}
	return true
}

func requestIDFromEnvelope(env protocol.Envelope) string {
	var obj map[string]any
	if err := json.Unmarshal(env.Payload, &obj); err != nil {
		return ""
	}
	requestID, _ := obj["request_id"].(string)
	return requestID
}

func daemonHasWorkspace(dc *daemonConn, workspacePath string) bool {
	for _, workspace := range dc.workspaces {
		if workspace.Path == workspacePath {
			return true
		}
	}
	return false
}

func (h *Hub) broadcast(env protocol.Envelope) {
	h.mu.RLock()
	webs := make([]*webConn, 0, len(h.webs))
	for wc := range h.webs {
		webs = append(webs, wc)
	}
	h.mu.RUnlock()
	for _, wc := range webs {
		select {
		case wc.send <- env:
		default:
		}
	}
}

func writeLoop(conn *websocket.Conn, ch <-chan protocol.Envelope) {
	for env := range ch {
		if env.Version == 0 {
			env.Version = 1
		}
		if env.Timestamp == 0 {
			env.Timestamp = time.Now().Unix()
		}
		if env.ID == "" {
			env.ID = protocol.NewID("msg")
		}
		if err := conn.WriteJSON(env); err != nil {
			return
		}
	}
}

func serverError(code, message string) protocol.Envelope {
	return protocol.NewEnvelope(protocol.TypeServerError, "server", protocol.ServerError{Code: code, Message: message})
}

func decodeJSON(w http.ResponseWriter, r *http.Request, out any) bool {
	defer r.Body.Close()
	if err := json.NewDecoder(r.Body).Decode(out); err != nil {
		writeJSON(w, http.StatusBadRequest, protocol.ServerError{Code: "bad_payload", Message: err.Error()})
		return false
	}
	return true
}

func writeAPIEnvelope(w http.ResponseWriter, env protocol.Envelope, err error) {
	if err != nil {
		writeJSON(w, http.StatusBadGateway, protocol.ServerError{Code: "daemon_request_failed", Message: err.Error()})
		return
	}
	if len(env.Payload) == 0 {
		writeJSON(w, http.StatusOK, map[string]any{})
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(env.Payload)
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}

func appendBounded[T any](items []T, item T, max int) []T {
	items = append(items, item)
	if len(items) <= max {
		return items
	}
	return append([]T(nil), items[len(items)-max:]...)
}

func hasLatestUserPrompt(events []protocol.TaskEvent, prompt string) bool {
	for index := len(events) - 1; index >= 0; index-- {
		event := events[index]
		if event.EventType != "user.prompt" {
			continue
		}
		var payload map[string]string
		if err := json.Unmarshal(event.Data, &payload); err != nil {
			return false
		}
		return payload["prompt"] == prompt
	}
	return false
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

func extractModelID(event protocol.TaskEvent) string {
	for _, raw := range []json.RawMessage{event.Raw, event.Data} {
		if len(raw) == 0 {
			continue
		}
		var obj map[string]any
		if err := json.Unmarshal(raw, &obj); err != nil {
			continue
		}
		for _, key := range []string{"model_id", "modelId"} {
			if modelID, _ := obj[key].(string); modelID != "" {
				return modelID
			}
		}
	}
	return ""
}

func MarshalPayload(v any) json.RawMessage {
	raw, _ := json.Marshal(v)
	return raw
}

func (h *Hub) ServeTerminalWebSocket(w http.ResponseWriter, r *http.Request) {
	projID := r.URL.Query().Get("project_id")
	if projID == "" {
		http.Error(w, "project_id is required", http.StatusBadRequest)
		return
	}
	terminalID := r.URL.Query().Get("terminal_id")
	if terminalID == "" {
		terminalID = "default"
	}
	if !safeTerminalIDPattern.MatchString(terminalID) {
		http.Error(w, "invalid terminal_id", http.StatusBadRequest)
		return
	}
	command := r.URL.Query().Get("command")
	initialCols := parseTerminalDimension(r.URL.Query().Get("cols"))
	initialRows := parseTerminalDimension(r.URL.Query().Get("rows"))

	h.mu.RLock()
	proj, ok := h.projects[projID]
	h.mu.RUnlock()
	if !ok {
		http.Error(w, "project not found", http.StatusNotFound)
		return
	}
	workspacePath := proj.WorkspacePath
	deviceID := proj.DeviceID

	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("upgrade terminal websocket: %v", err)
		return
	}
	defer conn.Close()

	h.mu.RLock()
	dc := h.daemons[deviceID]
	h.mu.RUnlock()

	if dc != nil {
		key := projID + "::" + terminalID
		terminal := &terminalConn{conn: conn}
		h.termMu.Lock()
		h.terminalConns[key] = terminal
		h.termMu.Unlock()

		defer func() {
			h.termMu.Lock()
			if h.terminalConns[key] == terminal {
				delete(h.terminalConns, key)
			}
			h.termMu.Unlock()
		}()

		startPayload := protocol.TerminalStreamStart{
			ProjectID:     projID,
			TerminalID:    terminalID,
			WorkspacePath: workspacePath,
			Command:       command,
			InitialTitle:  initialTerminalTitle(command),
			Cols:          initialCols,
			Rows:          initialRows,
		}
		dc.send <- protocol.NewEnvelope(protocol.TypeTerminalStreamStart, "server", startPayload)

		for {
			msgType, payload, err := conn.ReadMessage()
			if err != nil {
				break
			}
			if msgType == websocket.BinaryMessage || msgType == websocket.TextMessage {
				var resizeMsg struct {
					Type string `json:"type"`
					Cols uint16 `json:"cols"`
					Rows uint16 `json:"rows"`
				}
				if err := json.Unmarshal(payload, &resizeMsg); err == nil && resizeMsg.Type == "resize" {
					resizePayload := protocol.TerminalStreamResize{
						ProjectID:  projID,
						TerminalID: terminalID,
						Cols:       resizeMsg.Cols,
						Rows:       resizeMsg.Rows,
					}
					dc.send <- protocol.NewEnvelope(protocol.TypeTerminalStreamResize, "server", resizePayload)
				} else {
					dataPayload := protocol.TerminalStreamData{
						ProjectID:  projID,
						TerminalID: terminalID,
						Data:       payload,
					}
					dc.send <- protocol.NewEnvelope(protocol.TypeTerminalStreamData, "server", dataPayload)
				}
			}
		}
		return
	}

	resolvedPath := resolveLocalPath(workspacePath)
	_ = os.MkdirAll(resolvedPath, 0o755)

	sessionName := "pocket-studio-" + projID + "-" + terminalID
	initialTitle := initialTerminalTitle(command)
	var cmd *exec.Cmd
	if command != "" {
		cmd = exec.Command("tmux", "-u", "new-session", "-A", "-s", sessionName, "-n", initialTitle, "-c", resolvedPath, command, ";", "set-option", "-g", "status", "off", ";", "set-option", "-g", "set-titles", "on", ";", "set-option", "-g", "default-terminal", "tmux-256color", ";", "set-option", "-ga", "terminal-overrides", ",xterm-256color:RGB,tmux-256color:RGB", ";", "set-window-option", "-g", "allow-rename", "on", ";", "set-window-option", "-g", "automatic-rename", "off")
	} else {
		cmd = exec.Command("tmux", "-u", "new-session", "-A", "-s", sessionName, "-n", initialTitle, "-c", resolvedPath, ";", "set-option", "-g", "status", "off", ";", "set-option", "-g", "set-titles", "on", ";", "set-option", "-g", "default-terminal", "tmux-256color", ";", "set-option", "-ga", "terminal-overrides", ",xterm-256color:RGB,tmux-256color:RGB", ";", "set-window-option", "-g", "allow-rename", "on", ";", "set-window-option", "-g", "automatic-rename", "off")
	}
	cmd.Env = terminalEnv()

	ptyFile, err := pty.Start(cmd)
	if err != nil {
		log.Printf("failed to start tmux: %v. falling back to bash.", err)
		if command != "" {
			cmd = exec.Command("bash", "-c", command)
		} else {
			cmd = exec.Command("bash")
		}
		cmd.Dir = resolvedPath
		cmd.Env = terminalEnv()
		ptyFile, err = pty.Start(cmd)
		if err != nil {
			log.Printf("failed to start fallback shell: %v", err)
			return
		}
	}
	applyTerminalSize(ptyFile, initialCols, initialRows)
	resizeTmuxSession(sessionName, initialCols, initialRows)
	defer ptyFile.Close()
	titleDone := make(chan struct{})
	defer close(titleDone)
	var writeMu sync.Mutex
	go watchLocalTerminalTitle(conn, sessionName, titleDone, &writeMu)
	writeLocalTerminalSnapshot(conn, sessionName, &writeMu)

	go func() {
		buf := make([]byte, 1024)
		for {
			n, err := ptyFile.Read(buf)
			if err != nil {
				break
			}
			writeMu.Lock()
			if err := conn.WriteMessage(websocket.BinaryMessage, buf[:n]); err != nil {
				writeMu.Unlock()
				break
			}
			writeMu.Unlock()
		}
	}()

	for {
		msgType, payload, err := conn.ReadMessage()
		if err != nil {
			break
		}
		if msgType == websocket.BinaryMessage || msgType == websocket.TextMessage {
			var resizeMsg struct {
				Type string `json:"type"`
				Cols uint16 `json:"cols"`
				Rows uint16 `json:"rows"`
			}
			if err := json.Unmarshal(payload, &resizeMsg); err == nil && resizeMsg.Type == "resize" {
				applyTerminalSize(ptyFile, resizeMsg.Cols, resizeMsg.Rows)
				resizeTmuxSession(sessionName, resizeMsg.Cols, resizeMsg.Rows)
			} else {
				_, _ = ptyFile.Write(payload)
			}
		}
	}
}

func parseTerminalDimension(value string) uint16 {
	n, err := strconv.Atoi(value)
	if err != nil || n <= 0 || n > math.MaxUint16 {
		return 0
	}
	return uint16(n)
}

func terminalEnv() []string {
	return append(os.Environ(),
		"TERM=xterm-256color",
		"COLORTERM=truecolor",
		"TERM_PROGRAM=PocketStudio",
		"FORCE_COLOR=1",
	)
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
	_ = exec.Command("tmux", "resize-window", "-t", sessionName, "-x", strconv.Itoa(int(cols)), "-y", strconv.Itoa(int(rows))).Run()
}

func writeLocalTerminalSnapshot(conn *websocket.Conn, sessionName string, writeMu *sync.Mutex) {
	if data := tmuxCapturePane(sessionName); len(data) > 0 {
		writeMu.Lock()
		_ = conn.WriteMessage(websocket.BinaryMessage, data)
		writeMu.Unlock()
	}
	title, command := tmuxTerminalInfo(sessionName)
	if title != "" {
		writeMu.Lock()
		_ = conn.WriteJSON(map[string]string{
			"type":    "title",
			"title":   title,
			"command": command,
		})
		writeMu.Unlock()
	}
}

func watchLocalTerminalTitle(conn *websocket.Conn, sessionName string, done <-chan struct{}, writeMu *sync.Mutex) {
	ticker := time.NewTicker(1200 * time.Millisecond)
	defer ticker.Stop()
	lastTitle := ""
	lastCommand := ""
	for {
		title, command := tmuxTerminalInfo(sessionName)
		if title != "" && (title != lastTitle || command != lastCommand) {
			lastTitle = title
			lastCommand = command
			writeMu.Lock()
			err := conn.WriteJSON(map[string]string{
				"type":    "title",
				"title":   title,
				"command": command,
			})
			writeMu.Unlock()
			if err != nil {
				return
			}
		}
		select {
		case <-done:
			return
		case <-ticker.C:
		}
	}
}

func tmuxTerminalInfo(sessionName string) (string, string) {
	cmd := exec.Command("tmux", "display-message", "-p", "-t", sessionName, "#{window_name}\t#{pane_current_command}")
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
	cmd := exec.Command("tmux", "capture-pane", "-p", "-e", "-J", "-t", sessionName)
	raw, err := cmd.Output()
	if err != nil {
		return nil
	}
	if len(raw) == 0 {
		return nil
	}
	return append(raw, '\r')
}

func initialTerminalTitle(command string) string {
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
	case command == "pi" || strings.HasPrefix(command, "pi "):
		return "Pi"
	case command == "agy" || strings.Contains(command, "antigravity"):
		return "Antigravity"
	default:
		return command
	}
}

func resolveLocalPath(path string) string {
	if strings.HasPrefix(path, "~") {
		home, err := os.UserHomeDir()
		if err == nil {
			return filepath.Join(home, strings.TrimPrefix(path, "~"))
		}
	}
	abs, err := filepath.Abs(path)
	if err == nil {
		return abs
	}
	return path
}

func (h *Hub) handleLocalWorkspaceList(req protocol.WorkspaceListRequest) (protocol.WorkspaceResult, error) {
	target := resolveLocalPath(req.WorkspacePath)
	if req.Path != "" && req.Path != "." {
		target = filepath.Join(target, req.Path)
	}
	entries, err := os.ReadDir(target)
	if err != nil {
		return protocol.WorkspaceResult{RequestID: req.RequestID, Error: err.Error()}, nil
	}
	var items []protocol.FileEntry
	for _, entry := range entries {
		name := entry.Name()
		if shouldSkipFileTreeName(name) {
			continue
		}
		info, err := entry.Info()
		if err != nil {
			continue
		}
		childPath := name
		if req.Path != "" && req.Path != "." {
			childPath = filepath.ToSlash(filepath.Join(req.Path, name))
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
	return protocol.WorkspaceResult{
		RequestID:     req.RequestID,
		WorkspacePath: req.WorkspacePath,
		Path:          req.Path,
		Entries:       items,
	}, nil
}

func (h *Hub) handleLocalWorkspaceRead(req protocol.WorkspaceReadRequest) (protocol.WorkspaceResult, error) {
	target := filepath.Join(resolveLocalPath(req.WorkspacePath), req.Path)
	info, err := os.Stat(target)
	if err != nil {
		return protocol.WorkspaceResult{RequestID: req.RequestID, Error: err.Error()}, nil
	}
	if info.IsDir() {
		return protocol.WorkspaceResult{RequestID: req.RequestID, Error: "cannot read directory"}, nil
	}
	content, err := os.ReadFile(target)
	if err != nil {
		return protocol.WorkspaceResult{RequestID: req.RequestID, Error: err.Error()}, nil
	}
	return protocol.WorkspaceResult{
		RequestID:     req.RequestID,
		WorkspacePath: req.WorkspacePath,
		Path:          req.Path,
		Content:       string(content),
	}, nil
}

func (h *Hub) handleLocalWorkspaceWrite(req protocol.WorkspaceWriteRequest) (protocol.WorkspaceResult, error) {
	target := filepath.Join(resolveLocalPath(req.WorkspacePath), req.Path)
	if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
		return protocol.WorkspaceResult{RequestID: req.RequestID, Error: err.Error()}, nil
	}
	if err := os.WriteFile(target, []byte(req.Content), 0o644); err != nil {
		return protocol.WorkspaceResult{RequestID: req.RequestID, Error: err.Error()}, nil
	}
	return protocol.WorkspaceResult{
		RequestID:     req.RequestID,
		WorkspacePath: req.WorkspacePath,
		Path:          req.Path,
		Content:       req.Content,
	}, nil
}

type projectFileSearchResult struct {
	Entries []protocol.FileEntry `json:"entries"`
	Error   string               `json:"error,omitempty"`
}

type projectFileReadResult struct {
	Path     string `json:"path"`
	Name     string `json:"name"`
	Kind     string `json:"kind"`
	Content  string `json:"content,omitempty"`
	DataURL  string `json:"data_url,omitempty"`
	MimeType string `json:"mime_type,omitempty"`
	Size     int64  `json:"size,omitempty"`
	Error    string `json:"error,omitempty"`
}

type projectFileActionResult struct {
	Success bool   `json:"success"`
	Error   string `json:"error,omitempty"`
}

func (h *Hub) handleLocalProjectFileSearch(project Project, query string, limit int) projectFileSearchResult {
	query = strings.TrimSpace(strings.ToLower(query))
	if query == "" {
		return projectFileSearchResult{Entries: []protocol.FileEntry{}}
	}
	if limit <= 0 || limit > 200 {
		limit = 80
	}
	root := resolveLocalPath(project.WorkspacePath)
	var entries []protocol.FileEntry
	err := filepath.WalkDir(root, func(path string, entry os.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		name := entry.Name()
		if entry.IsDir() && shouldSkipFileTreeName(name) && path != root {
			return filepath.SkipDir
		}
		if entry.IsDir() {
			return nil
		}
		rel, err := filepath.Rel(root, path)
		if err != nil {
			return nil
		}
		rel = filepath.ToSlash(rel)
		if !strings.Contains(strings.ToLower(rel), query) {
			return nil
		}
		info, err := entry.Info()
		if err != nil {
			return nil
		}
		entries = append(entries, protocol.FileEntry{
			Name:     name,
			Path:     rel,
			IsDir:    false,
			Size:     info.Size(),
			Modified: info.ModTime().Unix(),
		})
		if len(entries) >= limit {
			return filepath.SkipAll
		}
		return nil
	})
	if err != nil {
		return projectFileSearchResult{Error: err.Error()}
	}
	return projectFileSearchResult{Entries: entries}
}

func (h *Hub) handleLocalProjectFileRead(project Project, path string) projectFileReadResult {
	target, ok := safeProjectPath(project.WorkspacePath, path)
	if !ok {
		return projectFileReadResult{Path: path, Error: "invalid path"}
	}
	info, err := os.Stat(target)
	if err != nil {
		return projectFileReadResult{Path: path, Error: err.Error()}
	}
	if info.IsDir() {
		return projectFileReadResult{Path: path, Error: "cannot read directory"}
	}
	if info.Size() > maxProjectFileReadSize {
		return projectFileReadResult{Path: path, Name: filepath.Base(path), Size: info.Size(), Error: "file is too large to preview"}
	}
	content, err := os.ReadFile(target)
	if err != nil {
		return projectFileReadResult{Path: path, Error: err.Error()}
	}
	mimeType := mime.TypeByExtension(strings.ToLower(filepath.Ext(target)))
	if mimeType == "" {
		mimeType = http.DetectContentType(content)
	}
	result := projectFileReadResult{
		Path:     filepath.ToSlash(path),
		Name:     filepath.Base(path),
		MimeType: mimeType,
		Size:     info.Size(),
	}
	if strings.HasPrefix(mimeType, "image/") {
		result.Kind = "image"
		result.DataURL = "data:" + mimeType + ";base64," + base64.StdEncoding.EncodeToString(content)
		return result
	}
	result.Kind = "text"
	result.Content = string(content)
	return result
}

func (h *Hub) handleLocalProjectFileWrite(project Project, path string, content string) projectFileReadResult {
	target, ok := safeProjectPath(project.WorkspacePath, path)
	if !ok {
		return projectFileReadResult{Path: path, Error: "invalid path"}
	}
	if err := os.WriteFile(target, []byte(content), 0o644); err != nil {
		return projectFileReadResult{Path: path, Error: err.Error()}
	}
	return h.handleLocalProjectFileRead(project, path)
}

func (h *Hub) handleLocalProjectFileAction(project Project, action string, path string, target string) projectFileActionResult {
	switch action {
	case "mkdir":
		targetPath, ok := safeProjectPath(project.WorkspacePath, path)
		if !ok {
			return projectFileActionResult{Error: "invalid path"}
		}
		if err := os.MkdirAll(targetPath, 0o755); err != nil {
			return projectFileActionResult{Error: err.Error()}
		}
	case "create_file":
		targetPath, ok := safeProjectPath(project.WorkspacePath, path)
		if !ok {
			return projectFileActionResult{Error: "invalid path"}
		}
		if err := os.MkdirAll(filepath.Dir(targetPath), 0o755); err != nil {
			return projectFileActionResult{Error: err.Error()}
		}
		file, err := os.OpenFile(targetPath, os.O_RDWR|os.O_CREATE|os.O_EXCL, 0o644)
		if err != nil {
			return projectFileActionResult{Error: err.Error()}
		}
		_ = file.Close()
	case "delete":
		targetPath, ok := safeProjectPath(project.WorkspacePath, path)
		if !ok {
			return projectFileActionResult{Error: "invalid path"}
		}
		if err := os.RemoveAll(targetPath); err != nil {
			return projectFileActionResult{Error: err.Error()}
		}
	case "move":
		sourcePath, ok := safeProjectPath(project.WorkspacePath, path)
		if !ok {
			return projectFileActionResult{Error: "invalid source path"}
		}
		targetPath, ok := safeProjectPath(project.WorkspacePath, target)
		if !ok {
			return projectFileActionResult{Error: "invalid target path"}
		}
		if err := os.MkdirAll(filepath.Dir(targetPath), 0o755); err != nil {
			return projectFileActionResult{Error: err.Error()}
		}
		if err := os.Rename(sourcePath, targetPath); err != nil {
			return projectFileActionResult{Error: err.Error()}
		}
	default:
		return projectFileActionResult{Error: "unknown action"}
	}
	return projectFileActionResult{Success: true}
}

func safeProjectPath(root string, rel string) (string, bool) {
	root = resolveLocalPath(root)
	cleanRel := filepath.Clean(rel)
	if cleanRel == "." || strings.HasPrefix(cleanRel, ".."+string(filepath.Separator)) || cleanRel == ".." || filepath.IsAbs(cleanRel) {
		return "", false
	}
	target := filepath.Join(root, cleanRel)
	absTarget, err := filepath.Abs(target)
	if err != nil {
		return "", false
	}
	absRoot, err := filepath.Abs(root)
	if err != nil {
		return "", false
	}
	if absTarget != absRoot && !strings.HasPrefix(absTarget, absRoot+string(filepath.Separator)) {
		return "", false
	}
	return absTarget, true
}

func shouldSkipFileTreeName(name string) bool {
	switch name {
	case ".git", "node_modules", ".next", "dist", "build", "target", ".idea":
		return true
	default:
		return false
	}
}
