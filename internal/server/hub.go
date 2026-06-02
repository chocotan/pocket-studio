package server

import (
	"crypto/sha1"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"math"
	"mime"
	"net/http"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"

	"remote-agent/internal/auth"
	"remote-agent/internal/hostinfo"
	"remote-agent/internal/protocol"
)

var (
	safeTerminalIDPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{1,96}$`)
)

type Project struct {
	ID            string          `json:"id"`
	Name          string          `json:"name"`
	DeviceID      string          `json:"device_id"`
	WorkspacePath string          `json:"workspace_path"`
	AgentIDs      []string        `json:"agent_ids"`
	TmuxIDs       []string        `json:"tmux_ids"`
	StudioState   json.RawMessage `json:"studio_state,omitempty"`
	UserID        string          `json:"-"`
}

func projectFromProtocol(project protocol.Project) Project {
	return Project{
		ID:            project.ID,
		Name:          project.Name,
		DeviceID:      project.DeviceID,
		WorkspacePath: project.WorkspacePath,
		AgentIDs:      project.AgentIDs,
		TmuxIDs:       project.TmuxIDs,
		StudioState:   project.StudioState,
	}
}

func protocolProjectFromProject(project Project) protocol.Project {
	return protocol.Project{
		ID:            project.ID,
		Name:          project.Name,
		DeviceID:      project.DeviceID,
		WorkspacePath: project.WorkspacePath,
		AgentIDs:      project.AgentIDs,
		TmuxIDs:       project.TmuxIDs,
		StudioState:   project.StudioState,
	}
}

type Hub struct {
	auth          *auth.Manager
	mu            sync.RWMutex
	daemons       map[string]*daemonConn
	webs          map[*webConn]struct{}
	taskDevices   map[string]string
	taskEvents    map[string][]protocol.Envelope
	taskRecords   map[string]protocol.TaskRecord
	pending       map[string]chan protocol.Envelope
	projects      map[string]Project
	termMu        sync.RWMutex
	terminalConns map[string]*terminalConn
}

type daemonConn struct {
	userID     string
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
	userID string
	conn   *websocket.Conn
	send   chan protocol.Envelope
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

func NewHub(authManager *auth.Manager) *Hub {
	h := &Hub{
		auth:          authManager,
		daemons:       make(map[string]*daemonConn),
		webs:          make(map[*webConn]struct{}),
		taskDevices:   make(map[string]string),
		taskEvents:    make(map[string][]protocol.Envelope),
		taskRecords:   make(map[string]protocol.TaskRecord),
		pending:       make(map[string]chan protocol.Envelope),
		projects:      make(map[string]Project),
		terminalConns: make(map[string]*terminalConn),
	}
	return h
}

func scopedKey(userID string, id string) string {
	if userID == "" {
		userID = auth.OwnerAdmin
	}
	return userID + "\x00" + id
}

func daemonKey(userID string, deviceID string) string {
	return scopedKey(userID, deviceID)
}

func terminalKey(userID string, projectID string, terminalID string) string {
	return userID + "\x00" + projectID + "\x00" + terminalID
}

func (h *Hub) projectByID(userID string, projectID string) (Project, bool) {
	if projectID == "" {
		return Project{}, false
	}
	h.mu.RLock()
	project, ok := h.projects[scopedKey(userID, projectID)]
	if !ok {
		project, ok = h.daemonWorkspaceProjectByIDLocked(userID, projectID)
	}
	h.mu.RUnlock()
	return project, ok
}

func daemonWorkspaceProjectID(deviceID string, workspace protocol.Workspace) string {
	sum := sha1.Sum([]byte(deviceID + "\x00" + workspace.Path))
	return "ws_" + fmt.Sprintf("%x", sum[:8])
}

func projectNameForWorkspace(workspace protocol.Workspace) string {
	if name := strings.TrimSpace(workspace.Name); name != "" {
		return name
	}
	if base := filepath.Base(workspace.Path); base != "." && base != "/" && base != "" {
		return base
	}
	return workspace.Path
}

func projectFromDaemonWorkspace(userID string, deviceID string, workspace protocol.Workspace) Project {
	return Project{
		ID:            daemonWorkspaceProjectID(deviceID, workspace),
		Name:          projectNameForWorkspace(workspace),
		DeviceID:      deviceID,
		WorkspacePath: workspace.Path,
		AgentIDs:      []string{},
		TmuxIDs:       []string{},
		UserID:        userID,
	}
}

func (h *Hub) daemonWorkspaceProjectByIDLocked(userID string, projectID string) (Project, bool) {
	for _, dc := range h.daemons {
		if dc.userID != userID {
			continue
		}
		for _, workspace := range dc.workspaces {
			project := projectFromDaemonWorkspace(userID, dc.deviceID, workspace)
			if project.ID == projectID {
				return project, true
			}
		}
	}
	return Project{}, false
}

func (h *Hub) listProjectsLocked(userID string) []Project {
	list := make([]Project, 0, len(h.projects))
	seen := make(map[string]bool)
	for _, project := range h.projects {
		if project.UserID != userID {
			continue
		}
		list = append(list, project)
		seen[project.DeviceID+"\x00"+project.WorkspacePath] = true
	}
	for _, dc := range h.daemons {
		if dc.userID != userID {
			continue
		}
		for _, workspace := range dc.workspaces {
			if workspace.Path == "" {
				continue
			}
			key := dc.deviceID + "\x00" + workspace.Path
			if seen[key] {
				continue
			}
			project := projectFromDaemonWorkspace(userID, dc.deviceID, workspace)
			list = append(list, project)
			seen[key] = true
		}
	}
	return list
}

func (h *Hub) projectHasOnlineDaemonLocked(project Project) bool {
	return h.daemons[daemonKey(project.UserID, project.DeviceID)] != nil
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

func (h *Hub) authenticate(w http.ResponseWriter, r *http.Request) (string, bool) {
	userID, err := h.auth.AuthenticateRequest(r)
	if err != nil {
		writeJSON(w, http.StatusUnauthorized, protocol.ServerError{Code: "unauthorized", Message: "invalid or missing token"})
		return "", false
	}
	return userID, true
}

func (h *Hub) ServeWebSocket(w http.ResponseWriter, r *http.Request) {
	userID, ok := h.authenticate(w, r)
	if !ok {
		return
	}
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("upgrade web: %v", err)
		return
	}
	wc := &webConn{userID: userID, conn: conn, send: make(chan protocol.Envelope, 64)}
	h.mu.Lock()
	h.webs[wc] = struct{}{}
	h.mu.Unlock()

	go writeLoop(conn, wc.send)
	wc.send <- protocol.NewEnvelope("server.state", "server", h.stateView(userID))
	h.readWebLoop(wc)
}

func (h *Hub) ServeDaemonSocket(w http.ResponseWriter, r *http.Request) {
	userID, ok := h.authenticate(w, r)
	if !ok {
		return
	}
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("upgrade daemon: %v", err)
		return
	}

	dc := &daemonConn{userID: userID, conn: conn, send: make(chan protocol.Envelope, 64), lastSeen: time.Now()}
	go writeLoop(conn, dc.send)
	h.readDaemonLoop(dc)
}

func (h *Hub) ServeAPI(w http.ResponseWriter, r *http.Request) {
	userID, ok := h.authenticate(w, r)
	if !ok {
		return
	}
	r = r.WithContext(auth.WithUserID(r.Context(), userID))
	if r.URL.Path == "/api/state" && r.Method == http.MethodGet {
		writeJSON(w, http.StatusOK, h.stateView(userID))
		return
	}
	if r.URL.Path == "/api/project/list" && r.Method == http.MethodGet {
		h.mu.RLock()
		list := h.listProjectsLocked(userID)
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
		requestID := protocol.NewID("req")
		env, err := h.requestDaemonForDevice(r, req.DeviceID, protocol.TypeProjectCreate, req.WorkspacePath, requestID, protocol.ProjectCreateRequest{
			RequestID:     requestID,
			Name:          req.Name,
			DeviceID:      req.DeviceID,
			WorkspacePath: req.WorkspacePath,
		})
		writeProjectResult(w, env, err, true, func(project Project) {
			project.UserID = userID
			h.mu.Lock()
			h.projects[scopedKey(userID, project.ID)] = project
			h.mu.Unlock()
		})
		return
	}
	if r.URL.Path == "/api/project/state" {
		if r.Method == http.MethodGet {
			projID := r.URL.Query().Get("project_id")
			if projID == "" {
				writeJSON(w, http.StatusBadRequest, protocol.ServerError{Code: "bad_request", Message: "project_id is required"})
				return
			}
			project, ok := h.projectByID(userID, projID)
			if !ok {
				writeJSON(w, http.StatusNotFound, protocol.ServerError{Code: "not_found", Message: "project not found"})
				return
			}
			requestID := protocol.NewID("req")
			env, err := h.requestDaemonForDevice(r, project.DeviceID, protocol.TypeProjectStateGet, project.WorkspacePath, requestID, protocol.ProjectStateGetRequest{
				RequestID:     requestID,
				ProjectID:     project.ID,
				WorkspacePath: project.WorkspacePath,
			})
			writeProjectStateResult(w, env, err)
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
			project, ok := h.projectByID(userID, req.ProjectID)
			if !ok {
				writeJSON(w, http.StatusNotFound, protocol.ServerError{Code: "not_found", Message: "project not found"})
				return
			}
			requestID := protocol.NewID("req")
			env, err := h.requestDaemonForDevice(r, project.DeviceID, protocol.TypeProjectStateSet, project.WorkspacePath, requestID, protocol.ProjectStateSetRequest{
				RequestID:     requestID,
				ProjectID:     project.ID,
				WorkspacePath: project.WorkspacePath,
				State:         rawState,
			})
			writeProjectResult(w, env, err, false, nil)
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
		project, ok := h.projectByID(userID, req.ProjectID)
		if !ok {
			writeJSON(w, http.StatusNotFound, protocol.ServerError{Code: "not_found", Message: "project not found"})
			return
		}
		requestID := protocol.NewID("req")
		env, err := h.requestDaemonForDevice(r, project.DeviceID, protocol.TypeWorkspaceList, project.WorkspacePath, requestID, protocol.WorkspaceListRequest{
			RequestID:     requestID,
			WorkspacePath: project.WorkspacePath,
			Path:          req.Path,
		})
		writeAPIEnvelope(w, env, err)
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
		_, ok := h.projectByID(userID, req.ProjectID)
		if !ok {
			writeJSON(w, http.StatusNotFound, protocol.ServerError{Code: "not_found", Message: "project not found"})
			return
		}
		writeJSON(w, http.StatusBadRequest, protocol.ServerError{Code: "unsupported", Message: "file search is not supported by the daemon protocol yet"})
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
		project, ok := h.projectByID(userID, req.ProjectID)
		if !ok {
			writeJSON(w, http.StatusNotFound, protocol.ServerError{Code: "not_found", Message: "project not found"})
			return
		}
		requestID := protocol.NewID("req")
		env, err := h.requestDaemonForDevice(r, project.DeviceID, protocol.TypeWorkspaceRead, project.WorkspacePath, requestID, protocol.WorkspaceReadRequest{
			RequestID:     requestID,
			WorkspacePath: project.WorkspacePath,
			Path:          req.Path,
		})
		writeProjectFileReadEnvelope(w, req.Path, env, err)
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
		project, ok := h.projectByID(userID, req.ProjectID)
		if !ok {
			writeJSON(w, http.StatusNotFound, protocol.ServerError{Code: "not_found", Message: "project not found"})
			return
		}
		requestID := protocol.NewID("req")
		env, err := h.requestDaemonForDevice(r, project.DeviceID, protocol.TypeWorkspaceWrite, project.WorkspacePath, requestID, protocol.WorkspaceWriteRequest{
			RequestID:     requestID,
			WorkspacePath: project.WorkspacePath,
			Path:          req.Path,
			Content:       req.Content,
		})
		writeProjectFileReadEnvelope(w, req.Path, env, err)
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
		_, ok := h.projectByID(userID, req.ProjectID)
		if !ok {
			writeJSON(w, http.StatusNotFound, protocol.ServerError{Code: "not_found", Message: "project not found"})
			return
		}
		writeJSON(w, http.StatusBadRequest, protocol.ServerError{Code: "unsupported", Message: "file actions are not supported by the daemon protocol yet"})
		return
	}
	if r.URL.Path == "/api/workspace/list" && r.Method == http.MethodPost {
		var req protocol.WorkspaceListRequest
		if !decodeJSON(w, r, &req) {
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
		env, err := h.requestDaemon(r, protocol.TypeWorkspaceRead, req.WorkspacePath, req.RequestID, req)
		writeAPIEnvelope(w, env, err)
		return
	}
	if r.URL.Path == "/api/workspace/write" && r.Method == http.MethodPost {
		var req protocol.WorkspaceWriteRequest
		if !decodeJSON(w, r, &req) {
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
		h.closeTerminal(userID, req.ProjectID, req.TerminalID)
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
			dc := h.daemons[daemonKey(wc.userID, deviceID)]
			if dc != nil {
				h.taskDevices[scopedKey(wc.userID, session.TaskID)] = deviceID
				now := time.Now().Unix()
				record := h.taskRecords[scopedKey(wc.userID, session.TaskID)]
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
				h.taskRecords[scopedKey(wc.userID, session.TaskID)] = record
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
			dc := h.daemons[daemonKey(wc.userID, deviceID)]
			if dc != nil {
				h.taskDevices[scopedKey(wc.userID, task.TaskID)] = deviceID
				now := time.Now().Unix()
				record := h.taskRecords[scopedKey(wc.userID, task.TaskID)]
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
				h.taskRecords[scopedKey(wc.userID, task.TaskID)] = record
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
			deviceID := h.taskDevices[scopedKey(wc.userID, stop.TaskID)]
			dc := h.daemons[daemonKey(wc.userID, deviceID)]
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
			deviceID := h.taskDevices[scopedKey(wc.userID, change.TaskID)]
			dc := h.daemons[daemonKey(wc.userID, deviceID)]
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
				deviceID = h.taskDevices[scopedKey(wc.userID, remove.TaskID)]
			}
			dc := h.daemons[daemonKey(wc.userID, deviceID)]
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
			dc := h.daemons[daemonKey(wc.userID, deviceID)]
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

func (h *Hub) closeTerminal(userID string, projectID string, terminalID string) {
	key := terminalKey(userID, projectID, terminalID)
	h.termMu.Lock()
	if wc := h.terminalConns[key]; wc != nil {
		_ = wc.conn.Close()
		delete(h.terminalConns, key)
	}
	h.termMu.Unlock()

	h.mu.RLock()
	project, ok := h.projects[scopedKey(userID, projectID)]
	if !ok {
		project, ok = h.daemonWorkspaceProjectByIDLocked(userID, projectID)
	}
	var dc *daemonConn
	if ok {
		dc = h.daemons[daemonKey(userID, project.DeviceID)]
	}
	h.mu.RUnlock()

	if dc != nil {
		dc.send <- protocol.NewEnvelope(protocol.TypeTerminalStreamExit, "server", protocol.TerminalStreamExit{
			ProjectID:  projectID,
			TerminalID: terminalID,
		})
		return
	}
}

func (h *Hub) readDaemonLoop(dc *daemonConn) {
	defer func() {
		h.mu.Lock()
		if dc.deviceID != "" && h.daemons[daemonKey(dc.userID, dc.deviceID)] == dc {
			delete(h.daemons, daemonKey(dc.userID, dc.deviceID))
		}
		h.mu.Unlock()
		h.broadcastToUser(dc.userID, protocol.NewEnvelope("server.state", "server", h.stateView(dc.userID)))
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
			key := daemonKey(dc.userID, hello.DeviceID)
			if old := h.daemons[key]; old != nil && old != dc {
				_ = old.conn.Close()
			}
			h.daemons[key] = dc
			h.mu.Unlock()
			h.broadcastToUser(dc.userID, protocol.NewEnvelope("server.state", "server", h.stateView(dc.userID)))
		case protocol.TypeDaemonHeartbeat, protocol.TypeDaemonSnapshot:
			dc.lastSeen = time.Now()
			h.broadcastToUser(dc.userID, protocol.NewEnvelope("server.state", "server", h.stateView(dc.userID)))
		case protocol.TypeTaskSnapshot:
			snapshot, err := protocol.DecodePayload[protocol.TaskSnapshot](env)
			if err != nil {
				dc.send <- serverError("bad_payload", err.Error())
				continue
			}
			h.mu.Lock()
			seen := make(map[string]struct{}, len(snapshot.Tasks))
			for _, record := range snapshot.Tasks {
				taskKey := scopedKey(dc.userID, record.TaskID)
				seen[taskKey] = struct{}{}
				h.taskDevices[taskKey] = snapshot.DeviceID
				record.DeviceID = snapshot.DeviceID
				h.taskRecords[taskKey] = record
			}
			for taskID, deviceID := range h.taskDevices {
				if !strings.HasPrefix(taskID, dc.userID+"\x00") {
					continue
				}
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
			h.broadcastToUser(dc.userID, protocol.NewEnvelope("server.state", "server", h.stateView(dc.userID)))
		case protocol.TypeTaskEvent:
			taskEvent, err := protocol.DecodePayload[protocol.TaskEvent](env)
			if err == nil && taskEvent.TaskID != "" {
				h.mu.Lock()
				taskKey := scopedKey(dc.userID, taskEvent.TaskID)
				if dc.deviceID != "" {
					h.taskDevices[taskKey] = dc.deviceID
				}
				h.taskEvents[taskKey] = appendBounded(h.taskEvents[taskKey], env, 1000)
				record := h.taskRecords[taskKey]
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
				h.taskRecords[taskKey] = record
				h.mu.Unlock()
			}
			forward := env
			forward.From = "server"
			h.broadcastToUser(dc.userID, forward)
		case protocol.TypeTerminalStreamData:
			streamData, err := protocol.DecodePayload[protocol.TerminalStreamData](env)
			if err == nil {
				key := terminalKey(dc.userID, streamData.ProjectID, streamData.TerminalID)
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
				key := terminalKey(dc.userID, streamTitle.ProjectID, streamTitle.TerminalID)
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
				key := terminalKey(dc.userID, streamExit.ProjectID, streamExit.TerminalID)
				h.termMu.Lock()
				wc := h.terminalConns[key]
				delete(h.terminalConns, key)
				h.termMu.Unlock()
				if wc != nil {
					_ = wc.conn.Close()
				}
			}
		case protocol.TypeWorkspaceResult, protocol.TypeTerminalResult, protocol.TypeProjectResult:
			if h.resolvePending(dc.userID, env) {
				continue
			}
			forward := env
			forward.From = "server"
			h.broadcastToUser(dc.userID, forward)
		default:
			log.Printf("daemon %s sent unsupported type %s", dc.deviceID, env.Type)
		}
	}
}

func (h *Hub) stateView(userID string) StateView {
	h.mu.RLock()
	defer h.mu.RUnlock()
	devices := make([]DeviceView, 0, len(h.daemons))
	for _, dc := range h.daemons {
		if dc.userID != userID {
			continue
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

	tasks := make([]protocol.TaskRecord, 0, len(h.taskRecords))
	prefix := userID + "\x00"
	for key, record := range h.taskRecords {
		if !strings.HasPrefix(key, prefix) {
			continue
		}
		tasks = append(tasks, record)
	}
	sort.Slice(tasks, func(i, j int) bool {
		return tasks[i].UpdatedAt > tasks[j].UpdatedAt
	})
	return StateView{Devices: devices, Tasks: tasks}
}

func (h *Hub) requestDaemon(r *http.Request, messageType string, workspacePath string, requestID string, payload any) (protocol.Envelope, error) {
	return h.requestDaemonForDevice(r, r.URL.Query().Get("device_id"), messageType, workspacePath, requestID, payload)
}

func (h *Hub) requestDaemonForDevice(r *http.Request, deviceID string, messageType string, workspacePath string, requestID string, payload any) (protocol.Envelope, error) {
	userID := auth.UserIDFromContext(r.Context())
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
		case protocol.ProjectCreateRequest:
			typed.RequestID = requestID
			payload = typed
		case protocol.ProjectStateGetRequest:
			typed.RequestID = requestID
			payload = typed
		case protocol.ProjectStateSetRequest:
			typed.RequestID = requestID
			payload = typed
		case protocol.TerminalRunRequest:
			typed.RequestID = requestID
			payload = typed
		}
	}
	h.mu.RLock()
	if deviceID == "" {
		for _, dc := range h.daemons {
			if dc.userID != userID {
				continue
			}
			if workspacePath == "" || daemonHasWorkspace(dc, workspacePath) {
				deviceID = dc.deviceID
				break
			}
		}
	}
	dc := h.daemons[daemonKey(userID, deviceID)]
	h.mu.RUnlock()
	if dc == nil {
		return protocol.Envelope{}, errors.New("target device is offline")
	}
	response := make(chan protocol.Envelope, 1)
	h.mu.Lock()
	h.pending[scopedKey(userID, requestID)] = response
	h.mu.Unlock()
	defer func() {
		h.mu.Lock()
		delete(h.pending, scopedKey(userID, requestID))
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

func (h *Hub) resolvePending(userID string, env protocol.Envelope) bool {
	requestID := requestIDFromEnvelope(env)
	if requestID == "" {
		return false
	}
	h.mu.RLock()
	ch := h.pending[scopedKey(userID, requestID)]
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

func (h *Hub) broadcastToUser(userID string, env protocol.Envelope) {
	h.mu.RLock()
	webs := make([]*webConn, 0, len(h.webs))
	for wc := range h.webs {
		if wc.userID != userID {
			continue
		}
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

func writeProjectFileReadEnvelope(w http.ResponseWriter, requestedPath string, env protocol.Envelope, err error) {
	if err != nil {
		writeJSON(w, http.StatusBadGateway, protocol.ServerError{Code: "daemon_request_failed", Message: err.Error()})
		return
	}
	result, decodeErr := protocol.DecodePayload[protocol.WorkspaceResult](env)
	if decodeErr != nil {
		writeJSON(w, http.StatusBadGateway, protocol.ServerError{Code: "bad_daemon_payload", Message: decodeErr.Error()})
		return
	}
	if result.Error != "" {
		writeJSON(w, http.StatusOK, projectFileReadResult{Path: requestedPath, Name: filepath.Base(requestedPath), Error: result.Error})
		return
	}
	path := result.Path
	if path == "" {
		path = requestedPath
	}
	content := []byte(result.Content)
	mimeType := mime.TypeByExtension(strings.ToLower(filepath.Ext(path)))
	if mimeType == "" {
		mimeType = http.DetectContentType(content)
	}
	response := projectFileReadResult{
		Path:     filepath.ToSlash(path),
		Name:     filepath.Base(path),
		Kind:     "text",
		Content:  result.Content,
		MimeType: mimeType,
		Size:     int64(len(content)),
	}
	if strings.HasPrefix(mimeType, "image/") {
		response.Kind = "image"
		response.Content = ""
		response.DataURL = "data:" + mimeType + ";base64," + base64.StdEncoding.EncodeToString(content)
	}
	writeJSON(w, http.StatusOK, response)
}

func writeProjectResult(w http.ResponseWriter, env protocol.Envelope, err error, includeProject bool, onProject func(Project)) {
	if err != nil {
		writeJSON(w, http.StatusBadGateway, protocol.ServerError{Code: "daemon_request_failed", Message: err.Error()})
		return
	}
	result, decodeErr := protocol.DecodePayload[protocol.ProjectResult](env)
	if decodeErr != nil {
		writeJSON(w, http.StatusBadGateway, protocol.ServerError{Code: "bad_daemon_payload", Message: decodeErr.Error()})
		return
	}
	if result.Error != "" {
		writeJSON(w, http.StatusBadRequest, protocol.ServerError{Code: "project_request_failed", Message: result.Error})
		return
	}
	if includeProject {
		if result.Project == nil {
			writeJSON(w, http.StatusBadGateway, protocol.ServerError{Code: "bad_daemon_payload", Message: "project result is missing project"})
			return
		}
		project := projectFromProtocol(*result.Project)
		if onProject != nil {
			onProject(project)
		}
		writeJSON(w, http.StatusOK, project)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"success": true})
}

func writeProjectStateResult(w http.ResponseWriter, env protocol.Envelope, err error) {
	if err != nil {
		writeJSON(w, http.StatusBadGateway, protocol.ServerError{Code: "daemon_request_failed", Message: err.Error()})
		return
	}
	result, decodeErr := protocol.DecodePayload[protocol.ProjectResult](env)
	if decodeErr != nil {
		writeJSON(w, http.StatusBadGateway, protocol.ServerError{Code: "bad_daemon_payload", Message: decodeErr.Error()})
		return
	}
	if result.Error != "" {
		writeJSON(w, http.StatusBadRequest, protocol.ServerError{Code: "project_request_failed", Message: result.Error})
		return
	}
	if len(result.State) == 0 {
		writeJSON(w, http.StatusOK, defaultStudioState())
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(result.State)
}

func defaultStudioState() map[string]any {
	return map[string]any{
		"layoutTree":      nil,
		"focusedId":       "",
		"newTerminalType": "bash",
	}
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
	userID, ok := h.authenticate(w, r)
	if !ok {
		return
	}
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

	proj, ok := h.projectByID(userID, projID)
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
	dc := h.daemons[daemonKey(userID, deviceID)]
	h.mu.RUnlock()

	if dc == nil {
		_ = conn.WriteJSON(map[string]string{"type": "error", "message": "target device is offline"})
		return
	}

	key := terminalKey(userID, projID, terminalID)
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
}

func parseTerminalDimension(value string) uint16 {
	n, err := strconv.Atoi(value)
	if err != nil || n <= 0 || n > math.MaxUint16 {
		return 0
	}
	return uint16(n)
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
