package protocol

import (
	"encoding/json"
	"time"
)

const (
	TypeDaemonHello     = "daemon.hello"
	TypeDaemonSnapshot  = "daemon.snapshot"
	TypeDaemonHeartbeat = "daemon.heartbeat"
	TypeWebHello        = "web.hello"
	TypeTaskDispatch    = "task.dispatch"
	TypeTaskEvent       = "task.event"
	TypeTaskSnapshot    = "task.snapshot"
	TypeTaskStop        = "task.stop"
	TypeTaskSetModel    = "task.set_model"
	TypeSessionDelete   = "session.delete"
	TypeSessionCreate   = "session.create"
	TypeWorkspaceList   = "workspace.list"
	TypeWorkspaceRead   = "workspace.read"
	TypeWorkspaceWrite  = "workspace.write"
	TypeWorkspaceResult = "workspace.result"
	TypeTerminalRun     = "terminal.run"
	TypeTerminalResult  = "terminal.result"
	TypeServerError     = "server.error"
	TypeTerminalStreamStart  = "terminal.stream.start"
	TypeTerminalStreamData   = "terminal.stream.data"
	TypeTerminalStreamResize = "terminal.stream.resize"
	TypeTerminalStreamExit   = "terminal.stream.exit"
)

type Envelope struct {
	ID        string          `json:"id"`
	Type      string          `json:"type"`
	Version   int             `json:"version"`
	Timestamp int64           `json:"timestamp"`
	From      string          `json:"from"`
	To        RouteTarget     `json:"to,omitempty"`
	TraceID   string          `json:"trace_id,omitempty"`
	Payload   json.RawMessage `json:"payload,omitempty"`
}

type RouteTarget struct {
	DeviceID string `json:"device_id,omitempty"`
	TaskID   string `json:"task_id,omitempty"`
}

type Workspace struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	Path string `json:"path"`
}

type AgentCapability struct {
	Name  string `json:"name"`
	Label string `json:"label"`
}

type DaemonHello struct {
	DeviceID      string            `json:"device_id"`
	DeviceName    string            `json:"device_name"`
	DaemonVersion string            `json:"daemon_version"`
	Agent         string            `json:"agent,omitempty"`
	AgentLabel    string            `json:"agent_label,omitempty"`
	Agents        []AgentCapability `json:"agents,omitempty"`
	Workspaces    []Workspace       `json:"workspaces"`
}

type DaemonSnapshot struct {
	DeviceID       string   `json:"device_id"`
	RunningTaskIDs []string `json:"running_task_ids"`
}

type DaemonHeartbeat struct {
	DeviceID       string   `json:"device_id"`
	Status         string   `json:"status"`
	RunningTaskIDs []string `json:"running_task_ids"`
	DaemonVersion  string   `json:"daemon_version"`
}

type TaskDispatch struct {
	TaskID          string      `json:"task_id"`
	WorkspaceID     string      `json:"workspace_id,omitempty"`
	WorkspacePath   string      `json:"workspace_path"`
	Agent           string      `json:"agent"`
	SessionName     string      `json:"session_name,omitempty"`
	ModelID         string      `json:"model_id,omitempty"`
	Prompt          string      `json:"prompt"`
	ParentTaskID    string      `json:"parent_task_id,omitempty"`
	ResumeSessionID string      `json:"resume_session_id,omitempty"`
	Options         TaskOptions `json:"options"`
}

type SessionCreate struct {
	TaskID        string      `json:"task_id"`
	WorkspaceID   string      `json:"workspace_id,omitempty"`
	WorkspacePath string      `json:"workspace_path"`
	Agent         string      `json:"agent"`
	SessionName   string      `json:"session_name,omitempty"`
	Options       TaskOptions `json:"options"`
}

type TaskOptions struct {
	AutoShell      bool     `json:"auto_shell"`
	AllowedTools   []string `json:"allowed_tools,omitempty"`
	TimeoutSeconds int      `json:"timeout_seconds,omitempty"`
}

type TaskEvent struct {
	TaskID    string          `json:"task_id"`
	EventID   string          `json:"event_id"`
	EventType string          `json:"event_type"`
	Source    string          `json:"source"`
	Sequence  int64           `json:"sequence"`
	Timestamp int64           `json:"timestamp,omitempty"`
	Data      json.RawMessage `json:"data,omitempty"`
	Raw       json.RawMessage `json:"raw,omitempty"`
}

type TaskRecord struct {
	TaskID        string      `json:"task_id"`
	DeviceID      string      `json:"device_id,omitempty"`
	WorkspaceID   string      `json:"workspace_id,omitempty"`
	WorkspacePath string      `json:"workspace_path"`
	Agent         string      `json:"agent,omitempty"`
	SessionName   string      `json:"session_name,omitempty"`
	ModelID       string      `json:"model_id,omitempty"`
	Prompt        string      `json:"prompt"`
	Status        string      `json:"status"`
	SessionID     string      `json:"session_id,omitempty"`
	ParentTaskID  string      `json:"parent_task_id,omitempty"`
	StartedAt     int64       `json:"started_at"`
	UpdatedAt     int64       `json:"updated_at"`
	Events        []TaskEvent `json:"events"`
}

type TaskSnapshot struct {
	DeviceID string       `json:"device_id"`
	Tasks    []TaskRecord `json:"tasks"`
}

type TaskStop struct {
	TaskID string `json:"task_id"`
	Reason string `json:"reason"`
}

type TaskSetModel struct {
	TaskID  string `json:"task_id"`
	ModelID string `json:"model_id"`
}

type SessionDelete struct {
	TaskID        string `json:"task_id"`
	Agent         string `json:"agent,omitempty"`
	SessionName   string `json:"session_name,omitempty"`
	WorkspaceID   string `json:"workspace_id,omitempty"`
	WorkspacePath string `json:"workspace_path,omitempty"`
}

type WorkspaceListRequest struct {
	RequestID     string `json:"request_id"`
	WorkspaceID   string `json:"workspace_id,omitempty"`
	WorkspacePath string `json:"workspace_path"`
	Path          string `json:"path,omitempty"`
}

type WorkspaceReadRequest struct {
	RequestID     string `json:"request_id"`
	WorkspaceID   string `json:"workspace_id,omitempty"`
	WorkspacePath string `json:"workspace_path"`
	Path          string `json:"path"`
}

type WorkspaceWriteRequest struct {
	RequestID     string `json:"request_id"`
	WorkspaceID   string `json:"workspace_id,omitempty"`
	WorkspacePath string `json:"workspace_path"`
	Path          string `json:"path"`
	Content       string `json:"content"`
}

type WorkspaceResult struct {
	RequestID     string          `json:"request_id"`
	WorkspaceID   string          `json:"workspace_id,omitempty"`
	WorkspacePath string          `json:"workspace_path,omitempty"`
	Path          string          `json:"path,omitempty"`
	Entries       []FileEntry     `json:"entries,omitempty"`
	Content       string          `json:"content,omitempty"`
	Error         string          `json:"error,omitempty"`
	Raw           json.RawMessage `json:"raw,omitempty"`
}

type FileEntry struct {
	Name     string `json:"name"`
	Path     string `json:"path"`
	IsDir    bool   `json:"is_dir"`
	Size     int64  `json:"size,omitempty"`
	Modified int64  `json:"modified,omitempty"`
}

type TerminalRunRequest struct {
	RequestID     string `json:"request_id"`
	WorkspaceID   string `json:"workspace_id,omitempty"`
	WorkspacePath string `json:"workspace_path"`
	Command       string `json:"command"`
}

type TerminalResult struct {
	RequestID string `json:"request_id"`
	Command   string `json:"command,omitempty"`
	Output    string `json:"output,omitempty"`
	Error     string `json:"error,omitempty"`
	ExitCode  int    `json:"exit_code"`
	Duration  int64  `json:"duration_ms,omitempty"`
}

type ServerError struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

type TerminalStreamStart struct {
	ProjectID     string `json:"project_id"`
	TerminalID    string `json:"terminal_id"`
	WorkspacePath string `json:"workspace_path"`
	Command       string `json:"command"`
}

type TerminalStreamData struct {
	ProjectID  string `json:"project_id"`
	TerminalID string `json:"terminal_id"`
	Data       []byte `json:"data"`
}

type TerminalStreamResize struct {
	ProjectID  string `json:"project_id"`
	TerminalID string `json:"terminal_id"`
	Cols       uint16 `json:"cols"`
	Rows       uint16 `json:"rows"`
}

type TerminalStreamExit struct {
	ProjectID  string `json:"project_id"`
	TerminalID string `json:"terminal_id"`
}

func NewEnvelope(messageType, from string, payload any) Envelope {
	raw, _ := json.Marshal(payload)
	now := time.Now().Unix()
	return Envelope{
		ID:        NewID("msg"),
		Type:      messageType,
		Version:   1,
		Timestamp: now,
		From:      from,
		Payload:   raw,
	}
}

func DecodePayload[T any](env Envelope) (T, error) {
	var out T
	if len(env.Payload) == 0 {
		return out, nil
	}
	err := json.Unmarshal(env.Payload, &out)
	return out, err
}
