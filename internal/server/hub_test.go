package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"remote-agent/internal/auth"
	"remote-agent/internal/protocol"
)

func decodeServerError(t *testing.T, env protocol.Envelope) protocol.ServerError {
	t.Helper()
	var got protocol.ServerError
	if err := json.Unmarshal(env.Payload, &got); err != nil {
		t.Fatalf("decode server error: %v", err)
	}
	return got
}

func TestServerErrorForTaskDispatchCarriesCorrelation(t *testing.T) {
	env := serverErrorForTaskDispatch(protocol.TaskDispatch{
		RequestID:       "req-1",
		TaskID:          "task-1",
		ResumeSessionID: "session-1",
		Agent:           "acpx",
	}, "device_offline", "target device is offline")

	got := decodeServerError(t, env)
	if got.RequestID != "req-1" || got.TaskID != "task-1" || got.SessionID != "session-1" || got.Agent != "acpx" {
		t.Fatalf("server error correlation = %#v", got)
	}
}

func TestServerErrorForEnvelopeExtractsCorrelationFromBadPayload(t *testing.T) {
	env := protocol.Envelope{
		Payload: []byte(`{"request_id":"req-2","task_id":"task-2","session_id":"session-2","agent":"codex","bad":`),
	}
	got := decodeServerError(t, serverErrorForEnvelope(env, "bad_payload", "invalid json"))
	if got.RequestID != "" || got.TaskID != "" || got.SessionID != "" || got.Agent != "" {
		t.Fatalf("invalid payload correlation = %#v, want empty fields", got)
	}

	env.Payload = []byte(`{"request_id":"req-3","task_id":"task-3","session_id":"session-3","agent":"codex"}`)
	got = decodeServerError(t, serverErrorForEnvelope(env, "bad_payload", "decode failed"))
	if got.RequestID != "req-3" || got.TaskID != "task-3" || got.SessionID != "session-3" || got.Agent != "codex" {
		t.Fatalf("valid payload correlation = %#v", got)
	}
}

func TestInitialTerminalTitleDetectsAdditionalAgents(t *testing.T) {
	tests := map[string]string{
		"qwen --acp":            "Qwen Code",
		"kimi acp":              "Kimi",
		"copilot --acp --stdio": "GitHub Copilot",
		"cursor-agent acp":      "Cursor Agent",
		"openclaw acp":          "OpenClaw",
	}
	for command, want := range tests {
		if got := initialTerminalTitle(command); got != want {
			t.Fatalf("initialTerminalTitle(%q) = %q, want %q", command, got, want)
		}
	}
}

func TestTaskHistoryIsScopedByUserTask(t *testing.T) {
	h := NewHub(auth.NewOpen(""))
	now := int64(100)
	h.taskRecords[scopedKey(auth.OwnerAdmin, "task-1")] = protocol.TaskRecord{
		TaskID: "task-1",
		Status: "running",
		Events: []protocol.TaskEvent{
			{TaskID: "task-1", EventID: "evt-1", EventType: "assistant.message", Sequence: 1, Timestamp: now},
			{TaskID: "task-1", EventID: "evt-2", EventType: "tool.output", Sequence: 2, Timestamp: now + 1},
		},
	}
	h.taskRecords[scopedKey(auth.OwnerAdmin, "task-2")] = protocol.TaskRecord{
		TaskID: "task-2",
		Status: "running",
		Events: []protocol.TaskEvent{
			{TaskID: "task-2", EventID: "evt-other", EventType: "assistant.message", Sequence: 3, Timestamp: now},
		},
	}

	events := h.taskHistory(auth.OwnerAdmin, "task-1")
	if len(events) != 2 || events[0].EventID != "evt-1" || events[1].EventID != "evt-2" {
		t.Fatalf("taskHistory events = %#v, want task-1 history", events)
	}
	events[0].EventID = "mutated"
	if h.taskRecords[scopedKey(auth.OwnerAdmin, "task-1")].Events[0].EventID == "mutated" {
		t.Fatal("taskHistory returned mutable backing slice")
	}
}

func TestTaskHistorySynthesizesMissingUserPromptFromRecordPrompt(t *testing.T) {
	h := NewHub(auth.NewOpen(""))
	h.taskRecords[scopedKey(auth.OwnerAdmin, "task-1")] = protocol.TaskRecord{
		TaskID:    "task-1",
		Prompt:    "show disk usage",
		StartedAt: 100,
		Events: []protocol.TaskEvent{
			{TaskID: "task-1", EventID: "evt-assistant", EventType: "assistant.message", Sequence: 8, Timestamp: 101},
		},
	}

	events := h.taskHistory(auth.OwnerAdmin, "task-1")
	if len(events) != 2 || events[0].EventType != "user.prompt" || events[0].EventID != "history-user-prompt-task-1" {
		t.Fatalf("taskHistory events = %#v, want synthetic user prompt first", events)
	}
	var data map[string]string
	if err := json.Unmarshal(events[0].Data, &data); err != nil {
		t.Fatalf("decode synthetic prompt data: %v", err)
	}
	if data["prompt"] != "show disk usage" {
		t.Fatalf("synthetic prompt = %q", data["prompt"])
	}
}

func TestTaskHistorySynthesizesMissingUserPromptBeforeLastStartedTurn(t *testing.T) {
	h := NewHub(auth.NewOpen(""))
	h.taskRecords[scopedKey(auth.OwnerAdmin, "task-1")] = protocol.TaskRecord{
		TaskID: "task-1",
		Prompt: "second prompt",
		Events: []protocol.TaskEvent{
			{TaskID: "task-1", EventID: "evt-start-1", EventType: "task.started", Sequence: 1, Timestamp: 100},
			{TaskID: "task-1", EventID: "evt-assistant-1", EventType: "assistant.message", Sequence: 2, Timestamp: 101},
			{TaskID: "task-1", EventID: "evt-start-2", EventType: "task.started", Sequence: 3, Timestamp: 110},
			{TaskID: "task-1", EventID: "evt-assistant-2", EventType: "assistant.message", Sequence: 4, Timestamp: 111},
		},
	}

	events := h.taskHistory(auth.OwnerAdmin, "task-1")
	if len(events) != 5 || events[2].EventType != "user.prompt" || events[3].EventID != "evt-start-2" {
		t.Fatalf("taskHistory events = %#v, want synthetic prompt before last task.started", events)
	}
}

func TestTaskHistoryDoesNotDuplicateExistingUserPrompt(t *testing.T) {
	h := NewHub(auth.NewOpen(""))
	h.taskRecords[scopedKey(auth.OwnerAdmin, "task-1")] = protocol.TaskRecord{
		TaskID: "task-1",
		Prompt: "show disk usage",
		Events: []protocol.TaskEvent{
			{TaskID: "task-1", EventID: "evt-user", EventType: "user.prompt", Sequence: 1},
			{TaskID: "task-1", EventID: "evt-assistant", EventType: "assistant.message", Sequence: 2},
		},
	}

	events := h.taskHistory(auth.OwnerAdmin, "task-1")
	if len(events) != 2 || events[0].EventID != "evt-user" {
		t.Fatalf("taskHistory events = %#v, want existing prompt unchanged", events)
	}
}

func TestTaskSnapshotMapsACPXSessionNameAlias(t *testing.T) {
	h := NewHub(auth.NewOpen(""))
	dc := &daemonConn{userID: auth.OwnerAdmin, deviceID: "device-1"}
	h.taskRecords[scopedKey(auth.OwnerAdmin, "acpx-ui-task")] = protocol.TaskRecord{
		TaskID:      "acpx-ui-task",
		SessionName: "acpx-ui-task",
		SessionID:   "rec-1",
		Events: []protocol.TaskEvent{{
			TaskID:    "acpx-ui-task",
			EventID:   "evt-user",
			EventType: "user.prompt",
			Sequence:  1,
			Data:      json.RawMessage(`{"prompt":"hello"}`),
		}},
	}
	h.taskDevices[scopedKey(auth.OwnerAdmin, "acpx-ui-task")] = "device-1"

	h.handleDaemonMessage(dc, protocol.NewEnvelope(protocol.TypeTaskSnapshot, "daemon", protocol.TaskSnapshot{
		DeviceID: "device-1",
		Tasks: []protocol.TaskRecord{{
			TaskID:       "rec-1",
			DeviceID:     "device-1",
			SessionName:  "acpx-ui-task",
			SessionID:    "rec-1",
			Agent:        "opencode",
			AgentRuntime: "acpx",
			Events: []protocol.TaskEvent{{
				TaskID:    "rec-1",
				EventID:   "evt-assistant",
				EventType: "assistant.message",
				Sequence:  2,
				Data:      json.RawMessage(`{"text":"restored"}`),
			}},
		}},
	}))

	if got := h.taskAliases[scopedKey(auth.OwnerAdmin, "acpx-ui-task")]; got != "rec-1" {
		t.Fatalf("alias = %q, want rec-1", got)
	}
	events := h.taskHistory(auth.OwnerAdmin, "acpx-ui-task")
	if len(events) != 2 {
		t.Fatalf("events len = %d, want merged restored history: %#v", len(events), events)
	}
	for _, event := range events {
		if event.TaskID != "acpx-ui-task" {
			t.Fatalf("event task id = %q, want acpx-ui-task: %#v", event.TaskID, events)
		}
	}
	seenEvents := map[string]bool{}
	for _, event := range events {
		seenEvents[event.EventID] = true
	}
	if !seenEvents["evt-assistant"] || !seenEvents["evt-user"] {
		t.Fatalf("events = %#v, want canonical plus old alias events", events)
	}
}

func TestTaskSnapshotExplicitDeletionRemovesFreshActiveTaskAndAliases(t *testing.T) {
	h := NewHub(auth.NewOpen(""))
	dc := &daemonConn{userID: auth.OwnerAdmin, deviceID: "device-1"}
	taskKey := scopedKey(auth.OwnerAdmin, "task-delete")
	aliasKey := scopedKey(auth.OwnerAdmin, "provider-delete")
	record := protocol.TaskRecord{
		TaskID: "task-delete", SessionID: "provider-delete", SessionName: "task-delete",
		DeviceID: "device-1", Status: "running", UpdatedAt: time.Now().Unix(),
	}
	h.taskRecords[taskKey] = record
	h.taskRecords[aliasKey] = record
	h.taskDevices[taskKey] = "device-1"
	h.taskDevices[aliasKey] = "device-1"
	h.taskEvents[taskKey] = []protocol.Envelope{{Type: protocol.TypeTaskEvent}}
	h.taskEvents[aliasKey] = []protocol.Envelope{{Type: protocol.TypeTaskEvent}}
	h.taskAliases[aliasKey] = "task-delete"

	h.handleDaemonMessage(dc, protocol.NewEnvelope(protocol.TypeTaskSnapshot, "daemon", protocol.TaskSnapshot{
		DeviceID: "device-1", DeletedTaskIDs: []string{"task-delete"}, Tasks: []protocol.TaskRecord{record},
	}))

	for _, key := range []string{taskKey, aliasKey} {
		if _, ok := h.taskRecords[key]; ok {
			t.Fatalf("explicitly deleted task record %q remains", key)
		}
		if _, ok := h.taskDevices[key]; ok {
			t.Fatalf("explicitly deleted task device %q remains", key)
		}
		if _, ok := h.taskEvents[key]; ok {
			t.Fatalf("explicitly deleted task events %q remain", key)
		}
		if _, ok := h.taskAliases[key]; ok {
			t.Fatalf("explicitly deleted task alias %q remains", key)
		}
	}
}

func TestTaskSnapshotExplicitDeletionRejectsSpoofedSnapshotDevice(t *testing.T) {
	h := NewHub(auth.NewOpen(""))
	dc := &daemonConn{userID: auth.OwnerAdmin, deviceID: "device-1"}
	taskKey := scopedKey(auth.OwnerAdmin, "other-device-task")
	record := protocol.TaskRecord{
		TaskID: "other-device-task", DeviceID: "device-2", Status: "completed", UpdatedAt: time.Now().Unix(),
	}
	h.taskRecords[taskKey] = record
	h.taskDevices[taskKey] = "device-2"

	h.handleDaemonMessage(dc, protocol.NewEnvelope(protocol.TypeTaskSnapshot, "daemon", protocol.TaskSnapshot{
		DeviceID: "device-2", DeletedTaskIDs: []string{"other-device-task"}, Tasks: []protocol.TaskRecord{},
	}))

	if got, ok := h.taskRecords[taskKey]; !ok || got.DeviceID != "device-2" {
		t.Fatalf("device-1 deletion removed device-2 task: %#v, exists=%v", got, ok)
	}
}

func TestTaskSnapshotExplicitDeletionCannotRemoveAnotherDeviceTask(t *testing.T) {
	h := NewHub(auth.NewOpen(""))
	dc := &daemonConn{userID: auth.OwnerAdmin, deviceID: "device-1"}
	taskKey := scopedKey(auth.OwnerAdmin, "other-device-task")
	record := protocol.TaskRecord{
		TaskID: "other-device-task", DeviceID: "device-2", Status: "completed", UpdatedAt: time.Now().Unix(),
	}
	h.taskRecords[taskKey] = record
	h.taskDevices[taskKey] = "device-2"

	h.handleDaemonMessage(dc, protocol.NewEnvelope(protocol.TypeTaskSnapshot, "daemon", protocol.TaskSnapshot{
		DeviceID: "device-1", DeletedTaskIDs: []string{"other-device-task"}, Tasks: []protocol.TaskRecord{},
	}))

	if got, ok := h.taskRecords[taskKey]; !ok || got.DeviceID != "device-2" {
		t.Fatalf("device-1 deletion removed device-2 task: %#v, exists=%v", got, ok)
	}
}

func TestTaskSnapshotFromReplacedDaemonCannotDeleteCurrentTask(t *testing.T) {
	h := NewHub(auth.NewOpen(""))
	old := &daemonConn{userID: auth.OwnerAdmin, deviceID: "device-1"}
	replacement := &daemonConn{userID: auth.OwnerAdmin, deviceID: "device-1"}
	h.daemons[daemonKey(auth.OwnerAdmin, "device-1")] = replacement
	taskKey := scopedKey(auth.OwnerAdmin, "replacement-task")
	record := protocol.TaskRecord{
		TaskID: "replacement-task", DeviceID: "device-1", Status: "running", UpdatedAt: time.Now().Unix(),
	}
	h.taskRecords[taskKey] = record
	h.taskDevices[taskKey] = "device-1"

	h.handleDaemonMessage(old, protocol.NewEnvelope(protocol.TypeTaskSnapshot, "daemon", protocol.TaskSnapshot{
		DeviceID: "device-1", DeletedTaskIDs: []string{"replacement-task"}, Tasks: []protocol.TaskRecord{},
	}))

	if got, ok := h.taskRecords[taskKey]; !ok || got.Status != "running" {
		t.Fatalf("replaced daemon deleted current task: %#v, exists=%v", got, ok)
	}
}

func TestTaskSnapshotExplicitDeletionCannotRemoveAnotherUsersAlias(t *testing.T) {
	h := NewHub(auth.NewOpen(""))
	dc := &daemonConn{userID: "user-a", deviceID: "device-a"}
	userATaskKey := scopedKey("user-a", "shared-task")
	userBTaskKey := scopedKey("user-b", "shared-task")
	userBAliasKey := scopedKey("user-b", "provider-b")
	h.taskRecords[userATaskKey] = protocol.TaskRecord{TaskID: "shared-task", DeviceID: "device-a"}
	h.taskDevices[userATaskKey] = "device-a"
	h.taskRecords[userBTaskKey] = protocol.TaskRecord{TaskID: "shared-task", DeviceID: "device-b"}
	h.taskRecords[userBAliasKey] = protocol.TaskRecord{TaskID: "shared-task", DeviceID: "device-b"}
	h.taskDevices[userBTaskKey] = "device-b"
	h.taskDevices[userBAliasKey] = "device-b"
	h.taskEvents[userBAliasKey] = []protocol.Envelope{{Type: protocol.TypeTaskEvent}}
	h.taskAliases[userBAliasKey] = "shared-task"

	h.handleDaemonMessage(dc, protocol.NewEnvelope(protocol.TypeTaskSnapshot, "daemon", protocol.TaskSnapshot{
		DeviceID: "device-a", DeletedTaskIDs: []string{"shared-task"}, Tasks: []protocol.TaskRecord{},
	}))

	for _, key := range []string{userBTaskKey, userBAliasKey} {
		if _, ok := h.taskRecords[key]; !ok {
			t.Fatalf("user-a deletion removed user-b task record %q", key)
		}
		if got := h.taskDevices[key]; got != "device-b" {
			t.Fatalf("user-a deletion changed user-b task device %q to %q", key, got)
		}
	}
	if got := h.taskAliases[userBAliasKey]; got != "shared-task" {
		t.Fatalf("user-a deletion removed user-b alias: %q", got)
	}
	if _, ok := h.taskEvents[userBAliasKey]; !ok {
		t.Fatal("user-a deletion removed user-b task events")
	}
}

func TestEnrichTerminalStreamAlertUsesCachedHostLayout(t *testing.T) {
	h := NewHub(auth.NewOpen(""))
	h.cacheProjectState(auth.OwnerAdmin, Project{
		ID:            "host-project",
		Name:          "Host",
		DeviceID:      "device-a",
		WorkspacePath: "/host",
	}, json.RawMessage(`{
		"layoutTree": {
			"type": "panel",
			"id": "panel-host",
			"tabs": [
				{
					"id": "chat-host",
					"kind": "agent_chat",
					"agentSessionId": "task-b",
					"agentRuntime": "acpx",
					"projectId": "task-project"
				}
			]
		}
	}`))

	alert, _ := h.enrichTerminalStreamAlert(auth.OwnerAdmin, protocol.TerminalStreamAlert{
		ProjectID:  "task-project",
		TerminalID: "task-b",
		Reason:     "agent_done",
	})
	if alert.ProjectID != "task-project" || alert.HostProjectID != "host-project" || alert.PanelID != "panel-host" || alert.TerminalID != "chat-host" {
		t.Fatalf("enriched alert = %#v, want cached host layout target", alert)
	}
}

func TestPrepareTaskDispatchRecordAddsUserPromptEvent(t *testing.T) {
	h := NewHub(auth.NewOpen(""))
	task := protocol.TaskDispatch{
		TaskID:        "task-1",
		WorkspaceID:   "project-1",
		WorkspacePath: "/workspace",
		Agent:         "codex",
		SessionName:   "agent-task-1",
		Prompt:        "hello",
		Attachments: []protocol.TaskAttachment{{
			Type: "image", Name: "photo.png", Path: "photo.png", MimeType: "image/png",
		}},
	}
	userEvent := h.prepareTaskDispatchRecordLocked(auth.OwnerAdmin, "device-1", task)

	record := h.taskRecords[scopedKey(auth.OwnerAdmin, "task-1")]
	if record.TaskID != "task-1" || record.Status != "queued" || record.DeviceID != "device-1" {
		t.Fatalf("record = %#v", record)
	}
	if len(record.Events) != 1 || record.Events[0].EventType != "user.prompt" || record.Events[0].TaskID != "task-1" {
		t.Fatalf("record events = %#v", record.Events)
	}
	if userEvent.EventID == "" || userEvent.EventID != record.Events[0].EventID {
		t.Fatalf("returned user prompt event = %#v, record event = %#v", userEvent, record.Events[0])
	}
	var userData struct {
		Attachments []protocol.TaskAttachment `json:"attachments"`
	}
	if err := json.Unmarshal(userEvent.Data, &userData); err != nil {
		t.Fatalf("decode user prompt data: %v", err)
	}
	if len(userData.Attachments) != 1 || userData.Attachments[0].Path != "photo.png" || userData.Attachments[0].MimeType != "image/png" {
		t.Fatalf("user prompt attachments = %#v", userData.Attachments)
	}
	h.prepareTaskDispatchRecordLocked(auth.OwnerAdmin, "device-1", task)
	record = h.taskRecords[scopedKey(auth.OwnerAdmin, "task-1")]
	if len(record.Events) != 2 || record.Events[1].EventType != "user.prompt" || record.Events[1].Sequence != 2 {
		t.Fatalf("repeated prompt should append another user event, got %#v", record.Events)
	}
}

func TestPrepareTaskDispatchRecordUsesNextAvailableSequence(t *testing.T) {
	h := NewHub(auth.NewOpen(""))
	h.taskRecords[scopedKey(auth.OwnerAdmin, "task-1")] = protocol.TaskRecord{
		TaskID: "task-1",
		Events: []protocol.TaskEvent{
			{TaskID: "task-1", EventID: "evt-user-1", EventType: "user.prompt", Sequence: 1},
			{TaskID: "task-1", EventID: "evt-assistant-1", EventType: "assistant.message", Sequence: 42},
		},
	}
	task := protocol.TaskDispatch{
		TaskID:        "task-1",
		WorkspaceID:   "project-1",
		WorkspacePath: "/workspace",
		Agent:         "codex",
		SessionName:   "agent-task-1",
		Prompt:        "follow up",
	}

	userEvent := h.prepareTaskDispatchRecordLocked(auth.OwnerAdmin, "device-1", task)

	if userEvent.Sequence != 43 {
		t.Fatalf("user prompt sequence = %d, want 43", userEvent.Sequence)
	}
	record := h.taskRecords[scopedKey(auth.OwnerAdmin, "task-1")]
	if got := record.Events[len(record.Events)-1]; got.EventID != userEvent.EventID || got.Sequence != 43 {
		t.Fatalf("last record event = %#v, want returned prompt with sequence 43", got)
	}
}

func TestNextTaskEventSequenceAvoidsDuplicateAndZeroSequences(t *testing.T) {
	events := []protocol.TaskEvent{
		{TaskID: "task-1", EventID: "evt-user", Sequence: 1},
	}
	if got := nextTaskEventSequence(events, 1); got != 2 {
		t.Fatalf("nextTaskEventSequence duplicate = %d, want 2", got)
	}
	if got := nextTaskEventSequence(events, 0); got != 2 {
		t.Fatalf("nextTaskEventSequence zero = %d, want 2", got)
	}
	if got := nextTaskEventSequence(events, 5); got != 5 {
		t.Fatalf("nextTaskEventSequence unique = %d, want 5", got)
	}
}

func TestMergeTaskRecordEventsDeduplicatesSameEventDataWithDifferentRaw(t *testing.T) {
	data := json.RawMessage(`{"text":"same assistant answer"}`)
	base := []protocol.TaskEvent{
		{
			TaskID:    "task-1",
			EventID:   "evt-history",
			EventType: "assistant.message",
			Sequence:  5,
			Data:      data,
			Raw:       json.RawMessage(`{"type":"assistant","message":{"content":[{"text":"same assistant answer"}]}}`),
		},
	}
	extra := []protocol.TaskEvent{
		{
			TaskID:    "task-1",
			EventID:   "evt-live",
			EventType: "assistant.message",
			Sequence:  8,
			Data:      data,
			Raw:       json.RawMessage(`{"jsonrpc":"2.0","method":"session/update"}`),
		},
	}

	merged := mergeTaskRecordEvents(base, extra)
	if len(merged) != 1 || merged[0].EventID != "evt-history" {
		t.Fatalf("merged events = %#v, want one history event", merged)
	}
	if !hasTaskEventSignature(base, extra[0]) {
		t.Fatal("hasTaskEventSignature() = false, want same data signature match")
	}
}

func TestMergeTaskRecordEventsDeduplicatesRestoredACPXEventsByStableKey(t *testing.T) {
	base := []protocol.TaskEvent{
		{
			TaskID:    "task-1",
			EventID:   "history-start",
			EventType: "task.started",
			Source:    "acpx",
			Sequence:  1,
			Data:      json.RawMessage(`{"source":"acpx.history","turn_id":"history-turn-0","acpx_turn_index":0,"acpx_event_key":"turn:0:task.started:0"}`),
		},
		{
			TaskID:    "task-1",
			EventID:   "history-user",
			EventType: "user.prompt",
			Source:    "acpx",
			Sequence:  2,
			Data:      json.RawMessage(`{"prompt":"你好","turn_id":"history-turn-0","acpx_turn_index":0,"acpx_event_key":"turn:0:user.prompt:0"}`),
		},
		{
			TaskID:    "task-1",
			EventID:   "history-assistant",
			EventType: "assistant.message",
			Source:    "acpx",
			Sequence:  3,
			Data:      json.RawMessage(`{"text":"你好，有什么可以帮你？","acpx_turn_index":0,"acpx_event_key":"turn:0:assistant.message:0"}`),
		},
		{
			TaskID:    "task-1",
			EventID:   "history-done",
			EventType: "task.completed",
			Source:    "acpx",
			Sequence:  4,
			Data:      json.RawMessage(`{"exit_code":0,"stop_reason":"history","turn_id":"history-turn-0","acpx_turn_index":0,"acpx_event_key":"turn:0:task.completed:0"}`),
		},
	}
	extra := []protocol.TaskEvent{
		{
			TaskID:    "task-1",
			EventID:   "live-user",
			EventType: "user.prompt",
			Source:    "web",
			Sequence:  5,
			Data:      json.RawMessage(`{"prompt":"你好","turn_id":"turn-live","acpx_turn_index":0,"acpx_event_key":"turn:0:user.prompt:0"}`),
		},
		{
			TaskID:    "task-1",
			EventID:   "live-start",
			EventType: "task.started",
			Source:    "claude_code",
			Sequence:  6,
			Data:      json.RawMessage(`{"turn_id":"turn-live","_seq":6,"_ts":100,"acpx_turn_index":0,"acpx_event_key":"turn:0:task.started:0"}`),
		},
		{
			TaskID:    "task-1",
			EventID:   "live-assistant",
			EventType: "assistant.message",
			Source:    "claude_code",
			Sequence:  7,
			Data:      json.RawMessage(`{"text":"你好，有什么可以帮你？","stream_id":"stream-1","replace":true,"_seq":7,"_ts":101,"acpx_turn_index":0,"acpx_event_key":"turn:0:assistant.message:0"}`),
		},
		{
			TaskID:    "task-1",
			EventID:   "live-done",
			EventType: "task.completed",
			Source:    "claude_code",
			Sequence:  8,
			Data:      json.RawMessage(`{"exit_code":0,"stop_reason":"end_turn","_seq":8,"_ts":102,"acpx_turn_index":0,"acpx_event_key":"turn:0:task.completed:0"}`),
		},
	}

	merged := mergeTaskRecordEvents(base, extra)
	if len(merged) != len(base) {
		t.Fatalf("merged events = %#v, want only restored turn", merged)
	}
	for i, event := range merged {
		if event.EventID != base[i].EventID {
			t.Fatalf("merged[%d] = %q, want %q; events=%#v", i, event.EventID, base[i].EventID, merged)
		}
	}
}

func TestMergeTaskRecordEventsCoalescesLiveAssistantPrefixWithRestoredFullTurn(t *testing.T) {
	restored := []protocol.TaskEvent{
		{
			TaskID: "task-1", EventID: "history-user", EventType: "user.prompt", Source: "acpx", Sequence: 1,
			Data: json.RawMessage(`{"prompt":"磁盘剩余空间多少","turn_id":"history-turn-0","acpx_turn_index":0,"acpx_event_key":"turn:0:user.prompt:0"}`),
		},
		{
			TaskID: "task-1", EventID: "history-start", EventType: "task.started", Source: "acpx", Sequence: 2,
			Data: json.RawMessage(`{"_seq":2,"acpx_turn_index":0,"acpx_event_key":"turn:0:task.started:0"}`),
		},
		{
			TaskID: "task-1", EventID: "history-assistant", EventType: "assistant.message", Source: "acpx", Sequence: 3,
			Data: json.RawMessage(`{"text":"磁盘剩余空间为 60 GB，可用率正常。","acpx_turn_index":0,"acpx_event_key":"turn:0:assistant.message:0"}`),
		},
		{
			TaskID: "task-1", EventID: "history-done", EventType: "task.completed", Source: "acpx", Sequence: 4,
			Data: json.RawMessage(`{"_seq":10,"stop_reason":"end_turn","acpx_turn_index":0,"acpx_event_key":"turn:0:task.completed:0"}`),
		},
	}
	live := []protocol.TaskEvent{
		{
			TaskID: "task-1", EventID: "live-user", EventType: "user.prompt", Source: "web", Sequence: 11,
			Data: json.RawMessage(`{"prompt":"磁盘剩余空间多少","turn_id":"live-turn","acpx_turn_index":0,"acpx_event_key":"turn:0:user.prompt:0"}`),
		},
		{
			TaskID: "task-1", EventID: "live-start", EventType: "task.started", Source: "codex", Sequence: 12,
			Data: json.RawMessage(`{"_seq":2,"acpx_turn_index":0,"acpx_event_key":"turn:0:task.started:0"}`),
		},
		{
			TaskID: "task-1", EventID: "live-assistant", EventType: "assistant.message", Source: "codex", Sequence: 13,
			Data: json.RawMessage(`{"text":"磁盘剩余空间为 60 GB","stream_id":"assistant-0","replace":true,"_seq":8,"acpx_turn_index":0,"acpx_event_key":"turn:0:assistant.message:0"}`),
		},
	}

	for _, test := range []struct {
		name  string
		base  []protocol.TaskEvent
		extra []protocol.TaskEvent
	}{
		{name: "restored_then_live", base: restored, extra: live},
		{name: "live_then_restored", base: live, extra: restored},
	} {
		t.Run(test.name, func(t *testing.T) {
			merged := mergeTaskRecordEvents(test.base, test.extra)
			counts := map[string]int{}
			assistantText := ""
			for _, event := range merged {
				counts[event.EventType]++
				if turn, ok := taskEventACPXTurnIndex(event); ok && turn != 0 {
					t.Fatalf("event was spuriously rebased to turn %d: %#v", turn, merged)
				}
				if event.EventType == "assistant.message" {
					assistantText = taskEventComparableText(event)
				}
			}
			if counts["user.prompt"] != 1 || counts["assistant.message"] != 1 || counts["task.completed"] != 1 {
				t.Fatalf("merged counts = %#v, want one prompt, assistant, and terminal; events=%#v", counts, merged)
			}
			if assistantText != "磁盘剩余空间为 60 GB，可用率正常。" {
				t.Fatalf("assistant text = %q, want restored complete response; events=%#v", assistantText, merged)
			}
		})
	}
}

func TestMergeDaemonTaskRecordKeepsRestoredTerminalForLiveAssistantPrefix(t *testing.T) {
	existing := protocol.TaskRecord{
		TaskID: "task-1", AgentRuntime: "acpx", Status: "running", UpdatedAt: 100,
		Events: []protocol.TaskEvent{
			{TaskID: "task-1", EventID: "live-user", EventType: "user.prompt", Source: "web", Sequence: 1, Data: json.RawMessage(`{"prompt":"来点马斯克新闻","acpx_turn_index":0,"acpx_event_key":"turn:0:user.prompt:0"}`)},
			{TaskID: "task-1", EventID: "live-assistant", EventType: "assistant.message", Source: "codex", Sequence: 2, Data: json.RawMessage(`{"text":"马斯克新闻摘要","stream_id":"assistant-0","replace":true,"_seq":8,"acpx_turn_index":0,"acpx_event_key":"turn:0:assistant.message:0"}`)},
		},
	}
	incoming := protocol.TaskRecord{
		TaskID: "task-1", AgentRuntime: "acpx", Status: "completed", UpdatedAt: 101,
		Events: []protocol.TaskEvent{
			{TaskID: "task-1", EventID: "history-user", EventType: "user.prompt", Source: "acpx", Sequence: 1, Data: json.RawMessage(`{"prompt":"来点马斯克新闻","acpx_turn_index":0,"acpx_event_key":"turn:0:user.prompt:0"}`)},
			{TaskID: "task-1", EventID: "history-assistant", EventType: "assistant.message", Source: "acpx", Sequence: 2, Data: json.RawMessage(`{"text":"马斯克新闻摘要与来源链接。","acpx_turn_index":0,"acpx_event_key":"turn:0:assistant.message:0"}`)},
			{TaskID: "task-1", EventID: "history-done", EventType: "task.completed", Source: "acpx", Sequence: 3, Data: json.RawMessage(`{"_seq":10,"acpx_turn_index":0,"acpx_event_key":"turn:0:task.completed:0"}`)},
		},
	}

	mergedEvents := mergeDaemonTaskRecordEvents(incoming.Events, existing.Events, "acpx")
	if status := mergedTaskRecordStatus(existing, incoming, mergedEvents); status != "completed" {
		t.Fatalf("merged status = %q, want completed; events=%#v", status, mergedEvents)
	}
	counts := map[string]int{}
	promptEventID := ""
	for _, event := range mergedEvents {
		counts[event.EventType]++
		if event.EventType == "user.prompt" {
			promptEventID = event.EventID
		}
	}
	if counts["user.prompt"] != 1 || counts["assistant.message"] != 1 || counts["task.completed"] != 1 {
		t.Fatalf("merged lifecycle duplicated or lost events: counts=%#v events=%#v", counts, mergedEvents)
	}
	if promptEventID != "live-user" {
		t.Fatalf("merge replaced the live prompt identity with %q: %#v", promptEventID, mergedEvents)
	}
}

func TestMergeTaskRecordEventsKeepsRepeatedACPXPromptTurnsWithDifferentStableKeys(t *testing.T) {
	base := []protocol.TaskEvent{
		{
			TaskID:    "task-1",
			EventID:   "history-user-0",
			EventType: "user.prompt",
			Sequence:  1,
			Data:      json.RawMessage(`{"prompt":"你好","acpx_turn_index":0,"acpx_event_key":"turn:0:user.prompt:0"}`),
		},
		{
			TaskID:    "task-1",
			EventID:   "history-assistant-0",
			EventType: "assistant.message",
			Sequence:  2,
			Data:      json.RawMessage(`{"text":"你好！","acpx_turn_index":0,"acpx_event_key":"turn:0:assistant.message:0"}`),
		},
	}
	extra := []protocol.TaskEvent{
		{
			TaskID:    "task-1",
			EventID:   "history-user-1",
			EventType: "user.prompt",
			Sequence:  3,
			Data:      json.RawMessage(`{"prompt":"你好","acpx_turn_index":1,"acpx_event_key":"turn:1:user.prompt:0"}`),
		},
		{
			TaskID:    "task-1",
			EventID:   "history-assistant-1",
			EventType: "assistant.message",
			Sequence:  4,
			Data:      json.RawMessage(`{"text":"你好！","acpx_turn_index":1,"acpx_event_key":"turn:1:assistant.message:0"}`),
		},
	}

	merged := mergeTaskRecordEvents(base, extra)
	if len(merged) != 4 {
		t.Fatalf("merged events = %#v, want both repeated prompt turns", merged)
	}
}

func TestOrderTaskRecordEventsUsesACPXLogicalSequenceBeforeTransportOrder(t *testing.T) {
	events := []protocol.TaskEvent{
		{TaskID: "task-1", EventID: "tail", EventType: "assistant.message", Sequence: 14, Timestamp: 100, Data: json.RawMessage(`{"text":"tail","_seq":7,"acpx_turn_index":0,"acpx_event_key":"turn:0:assistant.message:1"}`)},
		{TaskID: "task-1", EventID: "done", EventType: "task.completed", Sequence: 17, Timestamp: 50, Data: json.RawMessage(`{"_seq":10,"acpx_turn_index":0,"acpx_event_key":"turn:0:task.completed:0"}`)},
		{TaskID: "task-1", EventID: "output", EventType: "tool.output", Sequence: 13, Timestamp: 300, Data: json.RawMessage(`{"_seq":6,"acpx_turn_index":0,"acpx_event_key":"turn:0:tool.output:tool-1"}`)},
		{TaskID: "task-1", EventID: "user", EventType: "user.prompt", Sequence: 1, Timestamp: 200, Data: json.RawMessage(`{"prompt":"hello","acpx_turn_index":0,"acpx_event_key":"turn:0:user.prompt:0"}`)},
		{TaskID: "task-1", EventID: "first", EventType: "assistant.message", Sequence: 5, Timestamp: 400, Data: json.RawMessage(`{"text":"first","_seq":5,"acpx_turn_index":0,"acpx_event_key":"turn:0:assistant.message:0"}`)},
		{TaskID: "task-1", EventID: "start", EventType: "task.started", Sequence: 2, Timestamp: 150, Data: json.RawMessage(`{"_seq":2,"acpx_turn_index":0,"acpx_event_key":"turn:0:task.started:0"}`)},
		{TaskID: "task-1", EventID: "call", EventType: "tool.call", Sequence: 4, Timestamp: 500, Data: json.RawMessage(`{"_seq":4,"acpx_turn_index":0,"acpx_event_key":"turn:0:tool.call:tool-1"}`)},
	}

	ordered := orderTaskRecordEvents(events)
	want := []string{"user", "start", "call", "first", "output", "tail", "done"}
	for index, eventID := range want {
		if ordered[index].EventID != eventID {
			t.Fatalf("ordered[%d] = %q, want %q; events=%#v", index, ordered[index].EventID, eventID, ordered)
		}
	}
}

func TestMergedTaskRecordStatusKeepsTerminalAgainstStaleRunningAndAllowsNewTurn(t *testing.T) {
	existing := protocol.TaskRecord{
		TaskID: "task-1", AgentRuntime: "acpx", Status: "completed", UpdatedAt: 200,
		Events: []protocol.TaskEvent{
			{TaskID: "task-1", EventID: "prompt-0", EventType: "user.prompt", Sequence: 1, Timestamp: 100, Data: json.RawMessage(`{"prompt":"old","acpx_turn_index":0,"acpx_event_key":"turn:0:user.prompt:0"}`)},
			{TaskID: "task-1", EventID: "start-0", EventType: "task.started", Sequence: 2, Timestamp: 100, Data: json.RawMessage(`{"_seq":2,"acpx_turn_index":0,"acpx_event_key":"turn:0:task.started:0"}`)},
			{TaskID: "task-1", EventID: "done-0", EventType: "task.completed", Sequence: 10, Timestamp: 101, Data: json.RawMessage(`{"_seq":10,"acpx_turn_index":0,"acpx_event_key":"turn:0:task.completed:0"}`)},
		},
	}
	stale := protocol.TaskRecord{
		TaskID: "task-1", AgentRuntime: "acpx", Status: "running", UpdatedAt: 100,
		Events: []protocol.TaskEvent{
			{TaskID: "task-1", EventID: "stale-start-0", EventType: "task.started", Sequence: 2, Timestamp: 100, Data: json.RawMessage(`{"_seq":2,"acpx_turn_index":0,"acpx_event_key":"turn:0:task.started:0"}`)},
		},
	}
	mergedEvents := mergeDaemonTaskRecordEvents(stale.Events, existing.Events, "acpx")
	if got := mergedTaskRecordStatus(existing, stale, mergedEvents); got != "completed" {
		t.Fatalf("stale running merge status = %q, want completed", got)
	}

	newTurn := protocol.TaskRecord{
		TaskID: "task-1", AgentRuntime: "acpx", Status: "running", UpdatedAt: 201,
		Events: []protocol.TaskEvent{
			{TaskID: "task-1", EventID: "prompt-1", EventType: "user.prompt", Sequence: 11, Timestamp: 201, Data: json.RawMessage(`{"prompt":"new","acpx_turn_index":1,"acpx_event_key":"turn:1:user.prompt:0"}`)},
			{TaskID: "task-1", EventID: "start-1", EventType: "task.started", Sequence: 12, Timestamp: 201, Data: json.RawMessage(`{"_seq":2,"acpx_turn_index":1,"acpx_event_key":"turn:1:task.started:0"}`)},
		},
	}
	mergedEvents = mergeDaemonTaskRecordEvents(newTurn.Events, existing.Events, "acpx")
	if got := mergedTaskRecordStatus(existing, newTurn, mergedEvents); got != "running" {
		t.Fatalf("new turn merge status = %q, want running", got)
	}
}

func TestMergedTaskRecordStatusKeepsQueuedPromptOverStalePreviousTurnHistory(t *testing.T) {
	tests := []struct {
		name      string
		runtime   string
		oldPrompt json.RawMessage
		oldDone   json.RawMessage
		newPrompt json.RawMessage
	}{
		{
			name: "acpx-index", runtime: "acpx",
			oldPrompt: json.RawMessage(`{"prompt":"old","turn_id":"turn-old","acpx_turn_index":0,"acpx_event_key":"turn:0:user.prompt:0"}`),
			oldDone:   json.RawMessage(`{"_seq":10,"turn_id":"turn-old","acpx_turn_index":0,"acpx_event_key":"turn:0:task.completed:0"}`),
			newPrompt: json.RawMessage(`{"prompt":"new","turn_id":"turn-new","acpx_turn_index":1,"acpx_event_key":"turn:1:user.prompt:0"}`),
		},
		{
			name: "direct-turn-id", runtime: "direct_acp",
			oldPrompt: json.RawMessage(`{"prompt":"old","turn_id":"turn-old"}`),
			oldDone:   json.RawMessage(`{"turn_id":"turn-old"}`),
			newPrompt: json.RawMessage(`{"prompt":"new","turn_id":"turn-new"}`),
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			existing := protocol.TaskRecord{
				TaskID: "task-1", AgentRuntime: test.runtime, Status: "queued", UpdatedAt: 201,
				Events: []protocol.TaskEvent{
					{TaskID: "task-1", EventID: "prompt-old", EventType: "user.prompt", Sequence: 1, Timestamp: 100, Data: test.oldPrompt},
					{TaskID: "task-1", EventID: "done-old", EventType: "task.completed", Sequence: 10, Timestamp: 101, Data: test.oldDone},
					{TaskID: "task-1", EventID: "prompt-new", EventType: "user.prompt", Sequence: 11, Timestamp: 201, Data: test.newPrompt},
				},
			}
			stale := protocol.TaskRecord{
				TaskID: "task-1", AgentRuntime: test.runtime, Status: "completed", UpdatedAt: 101,
				Events: []protocol.TaskEvent{
					{TaskID: "task-1", EventID: "history-prompt-old", EventType: "user.prompt", Sequence: 1, Timestamp: 100, Data: test.oldPrompt},
					{TaskID: "task-1", EventID: "history-done-old", EventType: "task.completed", Sequence: 10, Timestamp: 101, Data: test.oldDone},
				},
			}
			mergedEvents := mergeDaemonTaskRecordEvents(stale.Events, existing.Events, test.runtime)
			if got := mergedTaskRecordStatus(existing, stale, mergedEvents); got != "queued" {
				t.Fatalf("merged status = %q, want queued; events=%#v", got, mergedEvents)
			}
		})
	}
}

func TestPrepareDirectACPDispatchKeepsTransportOrderedPromptUnindexed(t *testing.T) {
	h := NewHub(auth.NewOpen(""))
	taskKey := scopedKey(auth.OwnerAdmin, "task-1")
	now := time.Now().Unix()
	h.taskRecords[taskKey] = protocol.TaskRecord{
		TaskID: "task-1", AgentRuntime: "direct_acp", Status: "completed", UpdatedAt: now,
		Events: []protocol.TaskEvent{
			{TaskID: "task-1", EventID: "old-tail", EventType: "assistant.message", Source: "claude_code", Sequence: 14, Timestamp: now, Data: json.RawMessage(`{"text":"old","turn_id":"turn-old"}`)},
			{TaskID: "task-1", EventID: "old-done", EventType: "task.completed", Source: "claude_code", Sequence: 17, Timestamp: now, Data: json.RawMessage(`{"turn_id":"turn-old"}`)},
		},
	}
	prompt := h.prepareTaskDispatchRecordLocked(auth.OwnerAdmin, "dev-1", protocol.TaskDispatch{
		TaskID: "task-1", TurnID: "turn-new", AgentRuntime: "direct_acp", Prompt: "来点马斯克新闻",
	})
	var data map[string]any
	if err := json.Unmarshal(prompt.Data, &data); err != nil {
		t.Fatalf("decode prompt data: %v", err)
	}
	if _, ok := data["acpx_turn_index"]; ok {
		t.Fatalf("direct ACP optimistic prompt unexpectedly indexed: %#v", data)
	}
	newStart := protocol.TaskEvent{
		TaskID: "task-1", EventID: "new-start", EventType: "task.started", Source: "claude_code",
		Sequence: 19, Timestamp: prompt.Timestamp, Data: json.RawMessage(`{"turn_id":"turn-new"}`),
	}
	record := h.taskRecords[taskKey]
	ordered := orderTaskRecordEvents(append(record.Events, newStart))
	want := []string{"old-tail", "old-done", prompt.EventID, "new-start"}
	for index, eventID := range want {
		if ordered[index].EventID != eventID {
			t.Fatalf("ordered[%d] = %q, want %q; events=%#v", index, ordered[index].EventID, eventID, ordered)
		}
	}
	stale := protocol.TaskRecord{
		TaskID: "task-1", AgentRuntime: "direct_acp", Status: "completed", UpdatedAt: now,
		Events: []protocol.TaskEvent{
			{TaskID: "task-1", EventID: "history-tail", EventType: "assistant.message", Source: "claude_code", Sequence: 14, Timestamp: now, Data: json.RawMessage(`{"text":"old","turn_id":"turn-old"}`)},
			{TaskID: "task-1", EventID: "history-done", EventType: "task.completed", Source: "claude_code", Sequence: 17, Timestamp: now, Data: json.RawMessage(`{"turn_id":"turn-old"}`)},
		},
	}
	merged := mergeDaemonTaskRecordEvents(stale.Events, record.Events, "direct_acp")
	if got := mergedTaskRecordStatus(record, stale, merged); got != "queued" {
		t.Fatalf("stale previous-turn history status = %q, want queued; events=%#v", got, merged)
	}
}

func TestMergedDirectACPRestartStatusKeepsRecoveryTurnRunning(t *testing.T) {
	existing := protocol.TaskRecord{
		TaskID: "task-1", AgentRuntime: "direct_acp", Status: "queued", UpdatedAt: 1003,
		Events: []protocol.TaskEvent{
			{TaskID: "task-1", EventID: "old-start", EventType: "task.started", Sequence: 20, Timestamp: 1000, Data: json.RawMessage(`{"_seq":15,"turn_id":"old-turn"}`)},
			{TaskID: "task-1", EventID: "old-failed", EventType: "task.failed", Sequence: 26, Timestamp: 1001, Data: json.RawMessage(`{"turn_id":"old-turn","reason":"interrupted"}`)},
			{TaskID: "task-1", EventID: "recovery-prompt", EventType: "user.prompt", Source: "web", Sequence: 27, Timestamp: 1003, Data: json.RawMessage(`{"prompt":"recover","turn_id":"recovery-turn"}`)},
		},
	}
	incoming := protocol.TaskRecord{
		TaskID: "task-1", AgentRuntime: "direct_acp", Status: "running", UpdatedAt: 1004,
		Events: []protocol.TaskEvent{
			{TaskID: "task-1", EventID: "recovery-start", EventType: "task.started", Sequence: 32, Timestamp: 1004, Data: json.RawMessage(`{"_seq":25,"turn_id":"recovery-turn"}`)},
		},
	}
	merged := mergeDaemonTaskRecordEvents(incoming.Events, existing.Events, "direct_acp")
	if got := mergedTaskRecordStatus(existing, incoming, merged); got != "running" {
		t.Fatalf("Direct ACP restart merge status = %q, want running; events=%#v", got, merged)
	}
}

func TestCompletedHistoryCannotBeDowngradedThenFailedByHeartbeat(t *testing.T) {
	h := NewHub(auth.NewOpen(""))
	taskKey := scopedKey(auth.OwnerAdmin, "task-1")
	existingEvents := []protocol.TaskEvent{
		{TaskID: "task-1", EventID: "start-0", EventType: "task.started", Sequence: 2, Timestamp: 100, Data: json.RawMessage(`{"_seq":2,"acpx_turn_index":0,"acpx_event_key":"turn:0:task.started:0"}`)},
		{TaskID: "task-1", EventID: "done-0", EventType: "task.completed", Sequence: 10, Timestamp: 101, Data: json.RawMessage(`{"_seq":10,"acpx_turn_index":0,"acpx_event_key":"turn:0:task.completed:0"}`)},
	}
	h.taskRecords[taskKey] = protocol.TaskRecord{
		TaskID: "task-1", DeviceID: "dev-1", AgentRuntime: "acpx", Status: "completed",
		UpdatedAt: time.Now().Add(-time.Minute).Unix(), Events: existingEvents,
	}
	h.taskDevices[taskKey] = "dev-1"
	requester := &agentChatConn{userID: auth.OwnerAdmin, taskID: "task-1", send: make(chan protocol.Envelope, 16)}
	h.agentChatHistoryReq["req-1"] = agentChatHistoryRequest{requester: requester, deviceID: "dev-1"}
	dc := &daemonConn{userID: auth.OwnerAdmin, deviceID: "dev-1", send: make(chan protocol.Envelope, 2)}

	h.handleDaemonMessage(dc, protocol.NewEnvelope(protocol.TypeTaskHistoryResult, "daemon", protocol.TaskHistoryResult{
		RequestID: "req-1",
		TaskID:    "task-1",
		Record: &protocol.TaskRecord{
			TaskID: "task-1", DeviceID: "dev-1", AgentRuntime: "acpx", Status: "running", UpdatedAt: 100,
			Events: []protocol.TaskEvent{
				{TaskID: "task-1", EventID: "stale-start", EventType: "task.started", Sequence: 2, Timestamp: 100, Data: json.RawMessage(`{"_seq":2,"acpx_turn_index":0,"acpx_event_key":"turn:0:task.started:0"}`)},
			},
		},
	}))
	if got := h.taskRecords[taskKey].Status; got != "completed" {
		t.Fatalf("status after stale history = %q, want completed", got)
	}

	h.handleDaemonMessage(dc, protocol.NewEnvelope(protocol.TypeDaemonHeartbeat, "daemon", protocol.DaemonHeartbeat{
		DeviceID: "dev-1", RunningTaskIDs: []string{},
	}))
	record := h.taskRecords[taskKey]
	if record.Status != "completed" {
		t.Fatalf("status after heartbeat = %q, want completed", record.Status)
	}
	for _, event := range record.Events {
		if event.EventType == "task.failed" {
			t.Fatalf("heartbeat synthesized failure after completion: %#v", record.Events)
		}
	}
}

func TestMergeTaskRecordEventsRebasesExistingLiveTurnAfterRestoredHistory(t *testing.T) {
	base := []protocol.TaskEvent{
		{
			TaskID:    "task-1",
			EventID:   "history-user",
			EventType: "user.prompt",
			Sequence:  1,
			Data:      json.RawMessage(`{"prompt":"old","acpx_turn_index":0,"acpx_event_key":"turn:0:user.prompt:0"}`),
		},
		{
			TaskID:    "task-1",
			EventID:   "history-assistant",
			EventType: "assistant.message",
			Sequence:  2,
			Data:      json.RawMessage(`{"text":"old reply","acpx_turn_index":0,"acpx_event_key":"turn:0:assistant.message:0"}`),
		},
	}
	extra := []protocol.TaskEvent{
		{
			TaskID:    "task-1",
			EventID:   "live-user",
			EventType: "user.prompt",
			Sequence:  3,
			Data:      json.RawMessage(`{"prompt":"new","acpx_turn_index":0,"acpx_event_key":"turn:0:user.prompt:live"}`),
		},
		{
			TaskID:    "task-1",
			EventID:   "live-assistant",
			EventType: "assistant.message",
			Sequence:  4,
			Data:      json.RawMessage(`{"text":"new reply","acpx_turn_index":0,"acpx_event_key":"turn:0:assistant.message:live"}`),
		},
	}

	merged := mergeTaskRecordEvents(base, extra)
	if len(merged) != 4 {
		t.Fatalf("merged events = %#v, want restored plus rebased live turn", merged)
	}
	var data map[string]any
	if err := json.Unmarshal(merged[2].Data, &data); err != nil {
		t.Fatalf("decode live prompt data: %v", err)
	}
	if data["acpx_event_key"] != "turn:1:user.prompt:live" || data["acpx_turn_index"] != float64(1) {
		t.Fatalf("rebased live prompt data = %#v, want turn 1", data)
	}
}

func TestMergeTaskRecordEventsKeepsRepeatedUserPromptsWithoutTurnID(t *testing.T) {
	data := json.RawMessage(`{"prompt":"again"}`)
	base := []protocol.TaskEvent{
		{TaskID: "task-1", EventID: "evt-user-1", EventType: "user.prompt", Sequence: 1, Data: data},
	}
	extra := []protocol.TaskEvent{
		{TaskID: "task-1", EventID: "evt-user-2", EventType: "user.prompt", Sequence: 2, Data: data},
	}

	merged := mergeTaskRecordEvents(base, extra)
	if len(merged) != 2 {
		t.Fatalf("merged events = %#v, want both repeated user prompts", merged)
	}
}

func TestMergeTaskRecordEventsDeduplicatesSameTurnUserPromptEcho(t *testing.T) {
	base := []protocol.TaskEvent{
		{TaskID: "task-1", EventID: "evt-server", EventType: "user.prompt", Sequence: 1, Data: json.RawMessage(`{"prompt":"again","turn_id":"turn-1"}`)},
	}
	extra := []protocol.TaskEvent{
		{TaskID: "task-1", EventID: "evt-daemon", EventType: "user.prompt", Sequence: 2, Data: json.RawMessage(`{"prompt":"again","turn_id":"turn-1"}`)},
	}

	merged := mergeTaskRecordEvents(base, extra)
	if len(merged) != 1 || merged[0].EventID != "evt-server" {
		t.Fatalf("merged events = %#v, want one same-turn user prompt", merged)
	}
}

func TestMergeTaskRecordEventsDeduplicatesKeyedPromptHistoryByTurnID(t *testing.T) {
	base := []protocol.TaskEvent{
		{TaskID: "task-1", EventID: "evt-daemon", EventType: "user.prompt", Sequence: 2, Data: json.RawMessage(`{"prompt":"again","turn_id":"turn-1","acpx_turn_index":0,"acpx_event_key":"turn:0:user.prompt:0"}`)},
	}
	extra := []protocol.TaskEvent{
		{TaskID: "task-1", EventID: "evt-server", EventType: "user.prompt", Sequence: 1, Data: json.RawMessage(`{"prompt":"again","turn_id":"turn-1"}`)},
	}

	merged := mergeTaskRecordEvents(base, extra)
	if len(merged) != 1 || merged[0].EventID != "evt-daemon" {
		t.Fatalf("merged events = %#v, want one keyed daemon prompt", merged)
	}
}

func TestUpsertTaskRecordEventDeduplicatesKeyedPromptEchoByTurnID(t *testing.T) {
	base := []protocol.TaskEvent{
		{TaskID: "task-1", EventID: "evt-server", EventType: "user.prompt", Sequence: 1, Data: json.RawMessage(`{"prompt":"again","turn_id":"turn-1"}`)},
	}
	echo := protocol.TaskEvent{
		TaskID:    "task-1",
		EventID:   "evt-daemon",
		EventType: "user.prompt",
		Sequence:  2,
		Data:      json.RawMessage(`{"prompt":"again","turn_id":"turn-1","acpx_turn_index":0,"acpx_event_key":"turn:0:user.prompt:0"}`),
	}

	merged, forwarded, shouldForward := upsertOrAppendTaskRecordEvent(base, echo)
	if shouldForward {
		t.Fatalf("shouldForward = true, want keyed prompt echo suppressed")
	}
	if len(merged) != 1 || merged[0].EventID != "evt-server" {
		t.Fatalf("merged events = %#v, want original optimistic prompt only", merged)
	}
	if forwarded.EventID != "evt-server" {
		t.Fatalf("forwarded event = %#v, want existing optimistic prompt", forwarded)
	}
}

func TestTaskEventEnvelopeCarriesNormalizedSequenceAndRawPayload(t *testing.T) {
	raw := json.RawMessage(`{"jsonrpc":"2.0","method":"session/update","params":{"update":{"sessionUpdate":"tool_call_update","toolCallId":"call-1","rawInput":{"command":"df -h"}}}}`)
	event := protocol.TaskEvent{
		TaskID:    "task-1",
		EventID:   "evt-1",
		EventType: "tool.call",
		Sequence:  7,
		Raw:       raw,
	}

	env := taskEventEnvelope(event)
	var got protocol.TaskEvent
	if err := json.Unmarshal(env.Payload, &got); err != nil {
		t.Fatalf("decode payload: %v", err)
	}
	if env.To.TaskID != "task-1" || got.Sequence != 7 || string(got.Raw) != string(raw) {
		t.Fatalf("envelope = %#v, payload = %#v", env, got)
	}
}

func TestHandleDaemonMessageDoesNotBroadcastDuplicateTaskEvent(t *testing.T) {
	h := NewHub(auth.NewOpen(""))
	dc := &daemonConn{userID: auth.OwnerAdmin, deviceID: "device-1"}
	wc := &webConn{userID: auth.OwnerAdmin, send: make(chan protocol.Envelope, 4)}
	h.webs[wc] = struct{}{}

	existing := protocol.TaskEvent{
		TaskID:    "task-1",
		EventID:   "evt-server",
		EventType: "user.prompt",
		Source:    "web",
		Sequence:  1,
		Timestamp: 100,
		Data:      []byte(`{"prompt":"debug duplicate prompt 1781804971820","turn_id":"turn-1"}`),
	}
	h.taskRecords[scopedKey(auth.OwnerAdmin, "task-1")] = protocol.TaskRecord{
		TaskID: "task-1",
		Events: []protocol.TaskEvent{
			existing,
		},
	}

	duplicate := existing
	duplicate.EventID = "evt-daemon"
	duplicate.Sequence = 8
	duplicate.Timestamp = 101
	h.handleDaemonMessage(dc, protocol.NewEnvelope(protocol.TypeTaskEvent, "daemon", duplicate))

	select {
	case got := <-wc.send:
		t.Fatalf("broadcasted duplicate event: %#v", got)
	default:
	}

	record := h.taskRecords[scopedKey(auth.OwnerAdmin, "task-1")]
	if len(record.Events) != 1 || record.Events[0].EventID != "evt-server" {
		t.Fatalf("record events = %#v, want original event only", record.Events)
	}
}

func TestHandleDaemonHistoryResultMergesExistingLiveTurnWithoutDuplication(t *testing.T) {
	h := NewHub(auth.NewOpen(""))
	dc := &daemonConn{userID: auth.OwnerAdmin, deviceID: "device-1"}
	requester := &agentChatConn{userID: auth.OwnerAdmin, taskID: "task-1", send: make(chan protocol.Envelope, 8)}
	h.agentChatHistoryReq["req-1"] = agentChatHistoryRequest{requester: requester, deviceID: "device-1"}
	taskKey := scopedKey(auth.OwnerAdmin, "task-1")
	h.taskRecords[taskKey] = protocol.TaskRecord{
		TaskID: "task-1",
		Events: []protocol.TaskEvent{
			{
				TaskID:    "task-1",
				EventID:   "live-user",
				EventType: "user.prompt",
				Source:    "web",
				Sequence:  1,
				Data:      json.RawMessage(`{"prompt":"你好","turn_id":"turn-live","acpx_turn_index":0,"acpx_event_key":"turn:0:user.prompt:0"}`),
			},
			{
				TaskID:    "task-1",
				EventID:   "live-start",
				EventType: "task.started",
				Source:    "claude_code",
				Sequence:  2,
				Data:      json.RawMessage(`{"turn_id":"turn-live","_seq":2,"_ts":100,"acpx_turn_index":0,"acpx_event_key":"turn:0:task.started:0"}`),
			},
			{
				TaskID:    "task-1",
				EventID:   "live-assistant",
				EventType: "assistant.message",
				Source:    "claude_code",
				Sequence:  3,
				Data:      json.RawMessage(`{"text":"你好，有什么可以帮你？","_seq":3,"_ts":101,"acpx_turn_index":0,"acpx_event_key":"turn:0:assistant.message:0"}`),
			},
			{
				TaskID:    "task-1",
				EventID:   "live-done",
				EventType: "task.completed",
				Source:    "claude_code",
				Sequence:  4,
				Data:      json.RawMessage(`{"exit_code":0,"stop_reason":"end_turn","_seq":4,"_ts":102,"acpx_turn_index":0,"acpx_event_key":"turn:0:task.completed:0"}`),
			},
		},
	}

	h.handleDaemonMessage(dc, protocol.NewEnvelope(protocol.TypeTaskHistoryResult, "daemon", protocol.TaskHistoryResult{
		RequestID: "req-1",
		TaskID:    "task-1",
		Record: &protocol.TaskRecord{
			TaskID:   "task-1",
			Agent:    "qwen",
			Status:   "completed",
			Prompt:   "你好",
			DeviceID: "device-1",
			Events: []protocol.TaskEvent{
				{
					TaskID:    "task-1",
					EventID:   "history-start",
					EventType: "task.started",
					Source:    "acpx",
					Sequence:  1,
					Data:      json.RawMessage(`{"source":"acpx.history","turn_id":"history-turn-0","acpx_turn_index":0,"acpx_event_key":"turn:0:task.started:0"}`),
				},
				{
					TaskID:    "task-1",
					EventID:   "history-user",
					EventType: "user.prompt",
					Source:    "acpx",
					Sequence:  2,
					Data:      json.RawMessage(`{"prompt":"你好","turn_id":"history-turn-0","acpx_turn_index":0,"acpx_event_key":"turn:0:user.prompt:0"}`),
				},
				{
					TaskID:    "task-1",
					EventID:   "history-assistant",
					EventType: "assistant.message",
					Source:    "acpx",
					Sequence:  3,
					Data:      json.RawMessage(`{"text":"你好，有什么可以帮你？","acpx_turn_index":0,"acpx_event_key":"turn:0:assistant.message:0"}`),
				},
				{
					TaskID:    "task-1",
					EventID:   "history-done",
					EventType: "task.completed",
					Source:    "acpx",
					Sequence:  4,
					Data:      json.RawMessage(`{"exit_code":0,"stop_reason":"history","turn_id":"history-turn-0","acpx_turn_index":0,"acpx_event_key":"turn:0:task.completed:0"}`),
				},
			},
		},
		Events: nil,
	}))

	record := h.taskRecords[taskKey]
	if len(record.Events) != 4 {
		t.Fatalf("record events = %#v, want one restored turn without existing duplicate live turn", record.Events)
	}
	wantEventIDs := []string{"live-user", "live-start", "live-assistant", "live-done"}
	for index, event := range record.Events {
		if event.EventID != wantEventIDs[index] {
			t.Fatalf("record event %d id = %q, want preserved live id %q; all events=%#v", index, event.EventID, wantEventIDs[index], record.Events)
		}
	}
	forwarded := make([]protocol.TaskEvent, 0)
	for {
		select {
		case env := <-requester.send:
			if env.Type == protocol.TypeTaskHistoryReady {
				if len(forwarded) != 4 {
					t.Fatalf("forwarded events = %#v, want one restored turn", forwarded)
				}
				for index, event := range forwarded {
					if event.EventID != wantEventIDs[index] {
						t.Fatalf("forwarded event %d id = %q, want %q; events=%#v", index, event.EventID, wantEventIDs[index], forwarded)
					}
				}
				return
			}
			var event protocol.TaskEvent
			if err := json.Unmarshal(env.Payload, &event); err != nil {
				t.Fatalf("decode forwarded event: %v", err)
			}
			forwarded = append(forwarded, event)
		default:
			t.Fatalf("history result did not send ready; forwarded=%#v", forwarded)
		}
	}
}

func TestDirectEndpointMaterializesDaemonWorkspaceProject(t *testing.T) {
	h := NewHub(auth.NewOpen(""))
	h.mu.Lock()
	h.daemons[daemonKey(auth.OwnerAdmin, "dev-1")] = &daemonConn{
		userID:   auth.OwnerAdmin,
		deviceID: "dev-1",
		workspaces: []protocol.Workspace{{
			ID:   "project-1",
			Name: "Project",
			Path: "/workspace",
		}},
		directEndpoint: &protocol.DirectEndpoint{TerminalWebSocketURL: "ws://192.168.1.5:18082/ws/terminal", Token: "secret"},
	}
	h.mu.Unlock()

	project, ok := h.projectByID(auth.OwnerAdmin, "project-1")
	if !ok {
		t.Fatal("projectByID() missing virtual daemon workspace project")
	}
	h.mu.Lock()
	project = h.attachDirectEndpointLocked(project)
	h.projects[scopedKey(auth.OwnerAdmin, project.ID)] = project
	h.mu.Unlock()

	projects := h.listProjectsLocked(auth.OwnerAdmin)
	if len(projects) != 1 {
		t.Fatalf("projects = %#v, want one materialized project", projects)
	}
	if projects[0].DirectEndpoint == nil || projects[0].DirectEndpoint.TerminalWebSocketURL == "" {
		t.Fatalf("materialized project direct endpoint = %#v", projects[0])
	}
	if projects[0].DirectEndpoint.Token == "secret" || projects[0].DirectEndpoint.Token == "" {
		t.Fatalf("direct endpoint token should be a scoped capability, got %#v", projects[0].DirectEndpoint)
	}
	if !protocol.VerifyDirectTerminalToken("secret", "project-1", projects[0].DirectEndpoint.Token, time.Now()) {
		t.Fatalf("direct endpoint token is not valid for project-1: %#v", projects[0].DirectEndpoint)
	}
	if protocol.VerifyDirectTerminalToken("secret", "other-project", projects[0].DirectEndpoint.Token, time.Now()) {
		t.Fatal("direct endpoint token should not validate for another project")
	}
}

func TestDeviceAliasAPIUpdatesDeviceName(t *testing.T) {
	h := NewHub(auth.NewOpen(""))
	send := make(chan protocol.Envelope, 1)
	dc := &daemonConn{
		userID:     auth.OwnerAdmin,
		deviceID:   "dev-1",
		deviceName: "old-name",
		send:       send,
	}
	dc.markSeen(time.Unix(100, 0))
	h.mu.Lock()
	h.daemons[daemonKey(auth.OwnerAdmin, "dev-1")] = dc
	h.mu.Unlock()

	req := httptest.NewRequest(http.MethodPost, "/api/device/alias", strings.NewReader(`{"device_id":"dev-1","alias":"Desk Rig"}`))
	req.Header.Set("Content-Type", "application/json")
	res := httptest.NewRecorder()
	done := make(chan struct{})
	go func() {
		h.ServeAPI(res, req)
		close(done)
	}()

	var forwarded protocol.Envelope
	select {
	case forwarded = <-send:
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for daemon request")
	}
	if forwarded.Type != protocol.TypeDeviceAliasSet || forwarded.To.DeviceID != "dev-1" {
		t.Fatalf("forwarded envelope = %#v", forwarded)
	}
	request, err := protocol.DecodePayload[protocol.DeviceAliasSetRequest](forwarded)
	if err != nil {
		t.Fatalf("decode forwarded payload: %v", err)
	}
	if request.Alias != "Desk Rig" || request.DeviceID != "dev-1" || request.RequestID == "" {
		t.Fatalf("forwarded request = %#v", request)
	}
	h.handleDaemonMessage(h.daemons[daemonKey(auth.OwnerAdmin, "dev-1")], protocol.NewEnvelope(protocol.TypeDeviceAliasSet, "daemon", protocol.DeviceAliasResult{
		RequestID:  request.RequestID,
		DeviceID:   "dev-1",
		DeviceName: "Desk Rig",
		Alias:      "Desk Rig",
	}))

	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for API response")
	}
	if res.Code != http.StatusOK {
		t.Fatalf("status = %d body = %s", res.Code, res.Body.String())
	}
	state := h.stateView(auth.OwnerAdmin)
	if len(state.Devices) != 1 || state.Devices[0].Name != "Desk Rig" {
		t.Fatalf("state devices = %#v, want updated alias", state.Devices)
	}
}
