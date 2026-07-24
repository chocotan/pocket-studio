package daemon

import (
	"encoding/json"
	"fmt"
	"testing"

	"remote-agent/internal/protocol"
)

func TestSendTaskHistoryReturnsBoundedSanitizedPage(t *testing.T) {
	d := New(DefaultConfig())
	events := make([]protocol.TaskEvent, 1_000)
	for index := range events {
		events[index] = protocol.TaskEvent{
			TaskID:    "task-1",
			EventID:   fmt.Sprintf("event-%04d", index),
			EventType: "assistant.message",
			Sequence:  int64(index + 1),
			Data:      json.RawMessage(`{"text":"ok"}`),
		}
	}
	events[len(events)-1].Data = json.RawMessage(`{"text":`)
	events[len(events)-1].Raw = json.RawMessage(`{"text":"fallback"}`)
	d.history["task-1"] = protocol.TaskRecord{
		TaskID:       "task-1",
		AgentRuntime: "direct_acp",
		Status:       "completed",
		Events:       events,
	}

	d.sendTaskHistory(protocol.TaskHistoryGet{
		RequestID: "request-1",
		TaskID:    "task-1",
		Limit:     protocol.DefaultTaskHistoryLimit,
	})
	resultEnvelope := <-d.send
	result, err := protocol.DecodePayload[protocol.TaskHistoryResult](resultEnvelope)
	if err != nil {
		t.Fatalf("decode paginated history: %v", err)
	}
	if !result.Paginated || !result.HasMore || result.NextCursor != "event-0800" {
		t.Fatalf("page metadata = paginated %v, hasMore %v, cursor %q", result.Paginated, result.HasMore, result.NextCursor)
	}
	if len(result.Events) != protocol.DefaultTaskHistoryLimit || result.Events[0].EventID != "event-0800" || result.Events[len(result.Events)-1].EventID != "event-0999" {
		t.Fatalf("page bounds = len %d, first %q, last %q", len(result.Events), result.Events[0].EventID, result.Events[len(result.Events)-1].EventID)
	}
	if result.Record == nil || len(result.Record.Events) != 0 {
		t.Fatalf("paginated record retained events: %#v", result.Record)
	}
	last := result.Events[len(result.Events)-1]
	if last.Data != nil || string(last.Raw) != `{"text":"fallback"}` {
		t.Fatalf("malformed event was not isolated: %#v", last)
	}
	if len(d.history["task-1"].Events) != 1_000 || len(d.history["task-1"].Events[999].Data) == 0 {
		t.Fatal("history paging mutated the persisted record")
	}
}

func TestTaskSnapshotOmitsConversationEvents(t *testing.T) {
	d := New(DefaultConfig())
	d.history["task-1"] = protocol.TaskRecord{
		TaskID: "task-1",
		Status: "completed",
		Events: []protocol.TaskEvent{{TaskID: "task-1", EventID: "event-1"}},
	}

	snapshotEnvelope := d.taskSnapshotEnvelope(nil)
	snapshot, err := protocol.DecodePayload[protocol.TaskSnapshot](snapshotEnvelope)
	if err != nil {
		t.Fatalf("decode task snapshot: %v", err)
	}
	if len(snapshot.Tasks) != 1 || snapshot.Tasks[0].TaskID != "task-1" {
		t.Fatalf("snapshot tasks = %#v", snapshot.Tasks)
	}
	if len(snapshot.Tasks[0].Events) != 0 {
		t.Fatalf("snapshot contains %d conversation events", len(snapshot.Tasks[0].Events))
	}
}
