package server

import (
	"fmt"
	"testing"

	"remote-agent/internal/auth"
	"remote-agent/internal/protocol"
)

func TestAgentChatHistoryRequestUsesBoundedTailPage(t *testing.T) {
	h := NewHub(auth.NewOpen(""))
	dc := &daemonConn{
		userID:   auth.OwnerAdmin,
		deviceID: "device-1",
		send:     make(chan protocol.Envelope, 1),
	}
	h.daemons[daemonKey(auth.OwnerAdmin, "device-1")] = dc
	h.taskRecords[scopedKey(auth.OwnerAdmin, "task-1")] = protocol.TaskRecord{
		TaskID:        "task-1",
		DeviceID:      "device-1",
		WorkspacePath: "/workspace",
	}
	requester := &agentChatConn{userID: auth.OwnerAdmin, taskID: "task-1", historyPaging: true, send: make(chan protocol.Envelope, 1)}

	h.requestTaskHistoryForAgentChat(requester)
	envelope := <-dc.send
	request, err := protocol.DecodePayload[protocol.TaskHistoryGet](envelope)
	if err != nil {
		t.Fatalf("decode task history request: %v", err)
	}
	if request.TaskID != "task-1" || request.WorkspacePath != "/workspace" || request.Limit != protocol.DefaultTaskHistoryLimit || request.Cursor != "" {
		t.Fatalf("history request = %#v", request)
	}
}

func TestAgentChatHistoryRequestPreservesLegacyFullHistoryMode(t *testing.T) {
	h := NewHub(auth.NewOpen(""))
	dc := &daemonConn{
		userID:   auth.OwnerAdmin,
		deviceID: "device-1",
		send:     make(chan protocol.Envelope, 1),
	}
	h.daemons[daemonKey(auth.OwnerAdmin, "device-1")] = dc
	h.taskRecords[scopedKey(auth.OwnerAdmin, "task-1")] = protocol.TaskRecord{
		TaskID:   "task-1",
		DeviceID: "device-1",
	}
	requester := &agentChatConn{userID: auth.OwnerAdmin, taskID: "task-1", send: make(chan protocol.Envelope, 1)}

	h.requestTaskHistoryForAgentChat(requester)
	envelope := <-dc.send
	request, err := protocol.DecodePayload[protocol.TaskHistoryGet](envelope)
	if err != nil {
		t.Fatalf("decode legacy task history request: %v", err)
	}
	if request.Limit != 0 || request.Cursor != "" {
		t.Fatalf("legacy history request unexpectedly enabled paging: %#v", request)
	}
}

func TestLegacyFullHistoryResultIsBoundedBeforeAgentChatDelivery(t *testing.T) {
	h := NewHub(auth.NewOpen(""))
	dc := &daemonConn{userID: auth.OwnerAdmin, deviceID: "device-1"}
	events := make([]protocol.TaskEvent, 1_000)
	for index := range events {
		events[index] = protocol.TaskEvent{
			TaskID:    "task-1",
			EventID:   fmt.Sprintf("event-%04d", index),
			EventType: "assistant.message",
			Sequence:  int64(index + 1),
		}
	}
	requester := &agentChatConn{
		userID: auth.OwnerAdmin,
		taskID: "task-1",
		send:   make(chan protocol.Envelope, protocol.DefaultTaskHistoryLimit+1),
	}
	request := protocol.TaskHistoryGet{
		RequestID: "request-1",
		TaskID:    "task-1",
		Limit:     protocol.DefaultTaskHistoryLimit,
	}
	h.agentChatHistoryReq[request.RequestID] = agentChatHistoryRequest{
		requester: requester,
		deviceID:  "device-1",
		envelope:  protocol.NewEnvelope(protocol.TypeTaskHistoryGet, "server", request),
	}

	h.handleDaemonMessage(dc, protocol.NewEnvelope(protocol.TypeTaskHistoryResult, "daemon", protocol.TaskHistoryResult{
		RequestID: request.RequestID,
		TaskID:    "task-1",
		Record: &protocol.TaskRecord{
			TaskID: "task-1",
			Status: "completed",
			Events: events,
		},
		Events: events,
	}))

	for index := 800; index < 1_000; index++ {
		envelope := <-requester.send
		if envelope.Type != protocol.TypeTaskEvent {
			t.Fatalf("history envelope %d type = %q", index, envelope.Type)
		}
		event, err := protocol.DecodePayload[protocol.TaskEvent](envelope)
		if err != nil {
			t.Fatalf("decode history event %d: %v", index, err)
		}
		wantID := fmt.Sprintf("event-%04d", index)
		if event.EventID != wantID {
			t.Fatalf("history event %d id = %q, want %q", index, event.EventID, wantID)
		}
	}
	readyEnvelope := <-requester.send
	ready, err := protocol.DecodePayload[protocol.TaskHistoryReady](readyEnvelope)
	if err != nil {
		t.Fatalf("decode history ready: %v", err)
	}
	if readyEnvelope.Type != protocol.TypeTaskHistoryReady || !ready.HasEvents || !ready.HasMore || ready.NextCursor != "event-0800" {
		t.Fatalf("history ready = %#v", ready)
	}
	if len(requester.send) != 0 {
		t.Fatalf("history delivery queued %d unexpected envelopes", len(requester.send))
	}
	if got := len(h.taskRecords[scopedKey(auth.OwnerAdmin, "task-1")].Events); got != 1_000 {
		t.Fatalf("server cache retained %d events, want 1000", got)
	}
}
