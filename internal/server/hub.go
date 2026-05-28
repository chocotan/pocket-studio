package server

import (
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/creack/pty"
	"github.com/gorilla/websocket"

	"remote-agent/internal/protocol"
)

type Project struct {
	ID            string   `json:"id"`
	Name          string   `json:"name"`
	DeviceID      string   `json:"device_id"`
	WorkspacePath string   `json:"workspace_path"`
	AgentIDs      []string `json:"agent_ids"`
	TmuxIDs       []string `json:"tmux_ids"`
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
	terminalConns map[string]*websocket.Conn
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
	return &Hub{
		daemons:       make(map[string]*daemonConn),
		webs:          make(map[*webConn]struct{}),
		taskDevices:   make(map[string]string),
		taskEvents:    make(map[string][]protocol.Envelope),
		taskRecords:   make(map[string]protocol.TaskRecord),
		pending:       make(map[string]chan protocol.Envelope),
		projects:      make(map[string]Project),
		projectStates: make(map[string]string),
		terminalConns: make(map[string]*websocket.Conn),
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
		if req.ID == "" {
			req.ID = "proj-" + protocol.NewID("")[4:12]
		}
		if req.AgentIDs == nil {
			req.AgentIDs = []string{}
		}
		if req.TmuxIDs == nil {
			req.TmuxIDs = []string{}
		}
		h.projects[req.ID] = req
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
				writeJSON(w, http.StatusOK, map[string]any{
					"openFiles":       []any{},
					"activeFilePath":  "",
					"fileTree":        []any{},
					"expandedPaths":   []string{"."},
					"terminalLines":   []any{},
					"explorerVisible": true,
					"terminalVisible": false,
					"activeTaskId":    "",
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
			
			rawState, err := json.Marshal(req.State)
			if err != nil {
				writeJSON(w, http.StatusBadRequest, protocol.ServerError{Code: "bad_payload", Message: err.Error()})
				return
			}
			
			h.mu.Lock()
			h.projectStates[req.ProjectID] = string(rawState)
			
			if proj, ok := h.projects[req.ProjectID]; ok {
				var parsedState struct {
					ActiveTaskId string   `json:"activeTaskId"`
					OpenTabs     []string `json:"openTabs"`
				}
				if json.Unmarshal(rawState, &parsedState) == nil {
					var agentIDs []string
					for _, tab := range parsedState.OpenTabs {
						if strings.HasPrefix(tab, "agent-") || strings.HasPrefix(tab, "task-") {
							agentIDs = append(agentIDs, tab)
						}
					}
					if parsedState.ActiveTaskId != "" {
						found := false
						for _, id := range agentIDs {
							if id == parsedState.ActiveTaskId {
								found = true
								break
							}
						}
						if !found {
							agentIDs = append(agentIDs, parsedState.ActiveTaskId)
						}
					}
					proj.AgentIDs = agentIDs
					h.projects[req.ProjectID] = proj
				}
			}
			h.mu.Unlock()
			
			writeJSON(w, http.StatusOK, map[string]any{"success": true})
			return
		}
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
			dc.deviceName = hello.DeviceName
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
					_ = wc.WriteMessage(websocket.BinaryMessage, streamData.Data)
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
					_ = wc.Close()
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
	for _, dc := range h.daemons {
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

	devices = append(devices, DeviceView{
		ID:         "dev_local",
		Name:       "Local Machine",
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
	command := r.URL.Query().Get("command")

	h.mu.RLock()
	proj, ok := h.projects[projID]
	h.mu.RUnlock()

	workspacePath := "/home/choco/Agent"
	deviceID := "dev_local"
	if ok {
		if proj.WorkspacePath != "" {
			workspacePath = proj.WorkspacePath
		}
		if proj.DeviceID != "" {
			deviceID = proj.DeviceID
		}
	}

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
		h.termMu.Lock()
		h.terminalConns[key] = conn
		h.termMu.Unlock()

		defer func() {
			h.termMu.Lock()
			delete(h.terminalConns, key)
			h.termMu.Unlock()

			exitPayload := protocol.TerminalStreamExit{
				ProjectID:  projID,
				TerminalID: terminalID,
			}
			dc.send <- protocol.NewEnvelope(protocol.TypeTerminalStreamExit, "server", exitPayload)
		}()

		startPayload := protocol.TerminalStreamStart{
			ProjectID:     projID,
			TerminalID:    terminalID,
			WorkspacePath: workspacePath,
			Command:       command,
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
	var cmd *exec.Cmd
	if command != "" {
		cmd = exec.Command("tmux", "-u", "new-session", "-A", "-s", sessionName, "-c", resolvedPath, command)
	} else {
		cmd = exec.Command("tmux", "-u", "new-session", "-A", "-s", sessionName, "-c", resolvedPath)
	}

	ptyFile, err := pty.Start(cmd)
	if err != nil {
		log.Printf("failed to start tmux: %v. falling back to bash.", err)
		cmd = exec.Command("bash")
		cmd.Dir = resolvedPath
		ptyFile, err = pty.Start(cmd)
		if err != nil {
			log.Printf("failed to start fallback shell: %v", err)
			return
		}
	}
	defer ptyFile.Close()

	go func() {
		buf := make([]byte, 1024)
		for {
			n, err := ptyFile.Read(buf)
			if err != nil {
				break
			}
			if err := conn.WriteMessage(websocket.BinaryMessage, buf[:n]); err != nil {
				break
			}
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
				_ = pty.Setsize(ptyFile, &pty.Winsize{
					Cols: resizeMsg.Cols,
					Rows: resizeMsg.Rows,
				})
			} else {
				_, _ = ptyFile.Write(payload)
			}
		}
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
		if name == ".git" || name == "node_modules" || name == ".next" || name == "dist" || name == "build" {
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
