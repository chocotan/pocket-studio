package server

import (
	"encoding/json"
	"log"
	"net/http"
	"sort"
	"sync"
	"time"

	"github.com/gorilla/websocket"

	"remote-agent/internal/protocol"
)

type Hub struct {
	mu          sync.RWMutex
	daemons     map[string]*daemonConn
	webs        map[*webConn]struct{}
	taskDevices map[string]string
	taskEvents  map[string][]protocol.Envelope
	taskRecords map[string]protocol.TaskRecord
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
		daemons:     make(map[string]*daemonConn),
		webs:        make(map[*webConn]struct{}),
		taskDevices: make(map[string]string),
		taskEvents:  make(map[string][]protocol.Envelope),
		taskRecords: make(map[string]protocol.TaskRecord),
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
				record.Prompt = task.Prompt
				record.ParentTaskID = task.ParentTaskID
				if task.ResumeSessionID != "" {
					record.SessionID = task.ResumeSessionID
				}
				record.Status = "queued"
				record.UpdatedAt = now
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
			for _, record := range snapshot.Tasks {
				h.taskDevices[record.TaskID] = snapshot.DeviceID
				record.DeviceID = snapshot.DeviceID
				h.taskRecords[record.TaskID] = record
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
		default:
			log.Printf("daemon %s sent unsupported type %s", dc.deviceID, env.Type)
		}
	}
}

func (h *Hub) stateView() StateView {
	h.mu.RLock()
	defer h.mu.RUnlock()
	devices := make([]DeviceView, 0, len(h.daemons))
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
	tasks := make([]protocol.TaskRecord, 0, len(h.taskRecords))
	for _, record := range h.taskRecords {
		tasks = append(tasks, record)
	}
	sort.Slice(tasks, func(i, j int) bool {
		return tasks[i].UpdatedAt > tasks[j].UpdatedAt
	})
	return StateView{Devices: devices, Tasks: tasks}
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

func appendBounded[T any](items []T, item T, max int) []T {
	items = append(items, item)
	if len(items) <= max {
		return items
	}
	return append([]T(nil), items[len(items)-max:]...)
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

func MarshalPayload(v any) json.RawMessage {
	raw, _ := json.Marshal(v)
	return raw
}
