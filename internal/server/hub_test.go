package server

import (
	"encoding/json"
	"testing"

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

func TestPrepareTaskDispatchRecordAddsUserPromptEvent(t *testing.T) {
	h := NewHub(auth.NewOpen(""))
	task := protocol.TaskDispatch{
		TaskID:        "task-1",
		WorkspaceID:   "project-1",
		WorkspacePath: "/workspace",
		Agent:         "codex",
		SessionName:   "agent-task-1",
		Prompt:        "hello",
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
	h.prepareTaskDispatchRecordLocked(auth.OwnerAdmin, "device-1", task)
	record = h.taskRecords[scopedKey(auth.OwnerAdmin, "task-1")]
	if len(record.Events) != 2 || record.Events[1].EventType != "user.prompt" || record.Events[1].Sequence != 2 {
		t.Fatalf("repeated prompt should append another user event, got %#v", record.Events)
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
		Data:      []byte(`{"prompt":"debug duplicate prompt 1781804971820"}`),
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
