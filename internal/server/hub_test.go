package server

import (
	"encoding/json"
	"strings"
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

func TestTaskEventsAfterIsScopedByUserTaskAndCursor(t *testing.T) {
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

	events, record, ok := h.taskEventsAfter(auth.OwnerAdmin, "task-1", 1, 20)
	if !ok || record.TaskID != "task-1" {
		t.Fatalf("taskEventsAfter record = %#v, ok=%v", record, ok)
	}
	if len(events) != 1 || events[0].EventID != "evt-2" {
		t.Fatalf("taskEventsAfter events = %#v, want only evt-2", events)
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

func TestWriteSSEEnvelopeUsesEnvelopeEventType(t *testing.T) {
	var out strings.Builder
	env := taskEventEnvelope(protocol.TaskEvent{
		TaskID:    "task-1",
		EventID:   "evt-1",
		EventType: "tool.output",
		Sequence:  1,
	})
	if err := writeSSEEnvelope(&out, env); err != nil {
		t.Fatalf("writeSSEEnvelope: %v", err)
	}
	got := out.String()
	if !strings.HasPrefix(got, "event: task.event\n") || !strings.Contains(got, `"task_id":"task-1"`) {
		t.Fatalf("SSE frame = %q", got)
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
