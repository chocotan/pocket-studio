package protocol

import (
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"time"
)

const (
	TypeDaemonHello          = "daemon.hello"
	TypeDaemonSnapshot       = "daemon.snapshot"
	TypeDaemonHeartbeat      = "daemon.heartbeat"
	TypeServerHello          = "server.hello"
	TypeWebHello             = "web.hello"
	TypeTaskDispatch         = "task.dispatch"
	TypeTaskEvent            = "task.event"
	TypeTaskHistoryGet       = "task.history.get"
	TypeTaskHistoryResult    = "task.history.result"
	TypeTaskSnapshot         = "task.snapshot"
	TypeTaskStop             = "task.stop"
	TypeTaskSetModel         = "task.set_model"
	TypeTaskSetConfigOption  = "task.set_config_option"
	TypeSessionDelete        = "session.delete"
	TypeSessionCreate        = "session.create"
	TypeWorkspaceList        = "workspace.list"
	TypeWorkspaceRead        = "workspace.read"
	TypeWorkspaceWrite       = "workspace.write"
	TypeWorkspaceResult      = "workspace.result"
	TypeProjectCreate        = "project.create"
	TypeProjectStateGet      = "project.state.get"
	TypeProjectStateSet      = "project.state.set"
	TypeProjectResult        = "project.result"
	TypeTerminalRun          = "terminal.run"
	TypeTerminalResult       = "terminal.result"
	TypeServerError          = "server.error"
	TypeTerminalStreamStart  = "terminal.stream.start"
	TypeTerminalStreamData   = "terminal.stream.data"
	TypeTerminalStreamTitle  = "terminal.stream.title"
	TypeTerminalStreamAlert  = "terminal.stream.alert"
	TypeTerminalStreamResize = "terminal.stream.resize"
	TypeTerminalStreamExit   = "terminal.stream.exit"
)

const (
	FeatureTerminalBinaryV1 = "terminal.binary.v1"
	FeatureDirectTerminalV1 = "terminal.direct.v1"
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
	DeviceID       string            `json:"device_id"`
	DeviceName     string            `json:"device_name"`
	DaemonVersion  string            `json:"daemon_version"`
	Agent          string            `json:"agent,omitempty"`
	AgentLabel     string            `json:"agent_label,omitempty"`
	Agents         []AgentCapability `json:"agents,omitempty"`
	Workspaces     []Workspace       `json:"workspaces"`
	Features       []string          `json:"features,omitempty"`
	DirectEndpoint *DirectEndpoint   `json:"direct_endpoint,omitempty"`
}

type DirectEndpoint struct {
	TerminalWebSocketURL string `json:"terminal_ws_url"`
	Token                string `json:"token,omitempty"`
}

type ServerHello struct {
	Features []string `json:"features,omitempty"`
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
	RequestID       string      `json:"request_id,omitempty"`
	TaskID          string      `json:"task_id"`
	WorkspaceID     string      `json:"workspace_id,omitempty"`
	WorkspacePath   string      `json:"workspace_path"`
	Agent           string      `json:"agent"`
	AgentRuntime    string      `json:"agent_runtime,omitempty"`
	SessionName     string      `json:"session_name,omitempty"`
	ModelID         string      `json:"model_id,omitempty"`
	Prompt          string      `json:"prompt"`
	ParentTaskID    string      `json:"parent_task_id,omitempty"`
	ResumeSessionID string      `json:"resume_session_id,omitempty"`
	Options         TaskOptions `json:"options"`
}

type SessionCreate struct {
	RequestID     string      `json:"request_id,omitempty"`
	TaskID        string      `json:"task_id"`
	WorkspaceID   string      `json:"workspace_id,omitempty"`
	WorkspacePath string      `json:"workspace_path"`
	Agent         string      `json:"agent"`
	AgentRuntime  string      `json:"agent_runtime,omitempty"`
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
	AgentRuntime  string      `json:"agent_runtime,omitempty"`
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

type TaskHistoryGet struct {
	RequestID string `json:"request_id,omitempty"`
	TaskID    string `json:"task_id"`
}

type TaskHistoryResult struct {
	RequestID string      `json:"request_id,omitempty"`
	TaskID    string      `json:"task_id"`
	Record    *TaskRecord `json:"record,omitempty"`
	Events    []TaskEvent `json:"events,omitempty"`
}

type TaskSnapshot struct {
	DeviceID string       `json:"device_id"`
	Tasks    []TaskRecord `json:"tasks"`
}

type TaskStop struct {
	RequestID string `json:"request_id,omitempty"`
	TaskID    string `json:"task_id"`
	Reason    string `json:"reason"`
}

type TaskSetModel struct {
	RequestID string `json:"request_id,omitempty"`
	TaskID    string `json:"task_id"`
	ModelID   string `json:"model_id"`
}

type TaskSetConfigOption struct {
	RequestID string `json:"request_id,omitempty"`
	TaskID    string `json:"task_id"`
	ConfigID  string `json:"config_id"`
	Value     string `json:"value"`
}

type SessionDelete struct {
	RequestID     string `json:"request_id,omitempty"`
	TaskID        string `json:"task_id"`
	Agent         string `json:"agent,omitempty"`
	AgentRuntime  string `json:"agent_runtime,omitempty"`
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

type Project struct {
	ID             string          `json:"id"`
	Name           string          `json:"name"`
	DeviceID       string          `json:"device_id"`
	WorkspacePath  string          `json:"workspace_path"`
	AgentIDs       []string        `json:"agent_ids"`
	TmuxIDs        []string        `json:"tmux_ids"`
	StudioState    json.RawMessage `json:"studio_state,omitempty"`
	DirectMode     bool            `json:"direct_mode,omitempty"`
	DirectEndpoint *DirectEndpoint `json:"direct_endpoint,omitempty"`
}

type ProjectCreateRequest struct {
	RequestID     string `json:"request_id"`
	Name          string `json:"name"`
	DeviceID      string `json:"device_id,omitempty"`
	WorkspacePath string `json:"workspace_path"`
	DirectMode    bool   `json:"direct_mode,omitempty"`
}

type ProjectStateGetRequest struct {
	RequestID     string `json:"request_id"`
	ProjectID     string `json:"project_id"`
	WorkspacePath string `json:"workspace_path,omitempty"`
}

type ProjectStateSetRequest struct {
	RequestID     string          `json:"request_id"`
	ProjectID     string          `json:"project_id"`
	WorkspacePath string          `json:"workspace_path,omitempty"`
	State         json.RawMessage `json:"state"`
}

type ProjectResult struct {
	RequestID string          `json:"request_id"`
	Project   *Project        `json:"project,omitempty"`
	State     json.RawMessage `json:"state,omitempty"`
	Error     string          `json:"error,omitempty"`
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
	Code      string `json:"code"`
	Message   string `json:"message"`
	RequestID string `json:"request_id,omitempty"`
	TaskID    string `json:"task_id,omitempty"`
	SessionID string `json:"session_id,omitempty"`
	Agent     string `json:"agent,omitempty"`
}

type TerminalStreamStart struct {
	ProjectID     string `json:"project_id"`
	TerminalID    string `json:"terminal_id"`
	WorkspacePath string `json:"workspace_path"`
	Command       string `json:"command"`
	InitialTitle  string `json:"initial_title,omitempty"`
	Cols          uint16 `json:"cols,omitempty"`
	Rows          uint16 `json:"rows,omitempty"`
}

type TerminalStreamData struct {
	ProjectID  string `json:"project_id"`
	TerminalID string `json:"terminal_id"`
	Data       []byte `json:"data"`
}

var terminalStreamBinaryMagic = [4]byte{'P', 'S', 'T', 'D'}

const terminalStreamBinaryVersion byte = 1

func MarshalTerminalStreamDataBinary(data TerminalStreamData) ([]byte, error) {
	projectID := []byte(data.ProjectID)
	terminalID := []byte(data.TerminalID)
	if len(projectID) > 0xffff {
		return nil, fmt.Errorf("project id is too long")
	}
	if len(terminalID) > 0xffff {
		return nil, fmt.Errorf("terminal id is too long")
	}
	size := 4 + 1 + 2 + 2 + len(projectID) + len(terminalID) + len(data.Data)
	out := make([]byte, size)
	copy(out[:4], terminalStreamBinaryMagic[:])
	out[4] = terminalStreamBinaryVersion
	binary.BigEndian.PutUint16(out[5:7], uint16(len(projectID)))
	binary.BigEndian.PutUint16(out[7:9], uint16(len(terminalID)))
	offset := 9
	copy(out[offset:], projectID)
	offset += len(projectID)
	copy(out[offset:], terminalID)
	offset += len(terminalID)
	copy(out[offset:], data.Data)
	return out, nil
}

func UnmarshalTerminalStreamDataBinary(raw []byte) (TerminalStreamData, bool, error) {
	if len(raw) < 9 || !bytesEqual(raw[:4], terminalStreamBinaryMagic[:]) {
		return TerminalStreamData{}, false, nil
	}
	if raw[4] != terminalStreamBinaryVersion {
		return TerminalStreamData{}, true, fmt.Errorf("unsupported terminal stream binary version %d", raw[4])
	}
	projectLen := int(binary.BigEndian.Uint16(raw[5:7]))
	terminalLen := int(binary.BigEndian.Uint16(raw[7:9]))
	offset := 9
	if len(raw) < offset+projectLen+terminalLen {
		return TerminalStreamData{}, true, errors.New("truncated terminal stream binary frame")
	}
	projectID := string(raw[offset : offset+projectLen])
	offset += projectLen
	terminalID := string(raw[offset : offset+terminalLen])
	offset += terminalLen
	data := append([]byte(nil), raw[offset:]...)
	return TerminalStreamData{ProjectID: projectID, TerminalID: terminalID, Data: data}, true, nil
}

func bytesEqual(a []byte, b []byte) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

type TerminalStreamTitle struct {
	ProjectID  string `json:"project_id"`
	TerminalID string `json:"terminal_id"`
	Title      string `json:"title"`
	FullTitle  string `json:"full_title,omitempty"`
	Command    string `json:"command,omitempty"`
}

type TerminalStreamAlert struct {
	ProjectID  string `json:"project_id"`
	TerminalID string `json:"terminal_id"`
	Title      string `json:"title,omitempty"`
	Reason     string `json:"reason,omitempty"`
	Message    string `json:"message,omitempty"`
	Agent      string `json:"agent,omitempty"`
}

type TerminalStreamResize struct {
	ProjectID  string `json:"project_id"`
	TerminalID string `json:"terminal_id"`
	Cols       uint16 `json:"cols"`
	Rows       uint16 `json:"rows"`
}

type TerminalStreamExit struct {
	ProjectID    string `json:"project_id"`
	TerminalID   string `json:"terminal_id"`
	CloseSession bool   `json:"close_session,omitempty"`
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
