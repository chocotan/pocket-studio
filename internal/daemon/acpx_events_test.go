package daemon

import (
	"encoding/json"
	"testing"

	"remote-agent/internal/protocol"
)

func TestACPXToolUpdatesAreForwardedIndividuallyWithRawPayload(t *testing.T) {
	d := New(Config{})
	emitter := &taskEmitter{daemon: d, taskID: "task-1"}
	adapter := newAgentOutputAdapter(emitter)

	adapter.handle(json.RawMessage(`{"jsonrpc":"2.0","method":"session/update","params":{"update":{"sessionUpdate":"tool_call","toolCallId":"call-1","title":"bash","status":"pending","rawInput":{"cwd":"/tmp"}}}}`))
	adapter.handle(json.RawMessage(`{"jsonrpc":"2.0","method":"session/update","params":{"update":{"sessionUpdate":"tool_call_update","toolCallId":"call-1","title":"bash","status":"pending","rawInput":{"cwd":"/tmp","command":"df -h"}}}}`))
	adapter.handle(json.RawMessage(`{"jsonrpc":"2.0","method":"session/update","params":{"update":{"sessionUpdate":"tool_call_update","toolCallId":"call-1","title":"bash","status":"completed","rawOutput":"Filesystem Size Used"}}}`))

	got := drainTaskEvents(d.send)
	if len(got) != 3 {
		t.Fatalf("events len = %d, want 3: %#v", len(got), got)
	}
	if got[0].EventType != "tool.call" || got[1].EventType != "tool.call" || got[2].EventType != "tool.output" {
		t.Fatalf("event types = %q, %q, %q", got[0].EventType, got[1].EventType, got[2].EventType)
	}
	for _, event := range got {
		if len(event.Raw) == 0 || !json.Valid(event.Raw) {
			t.Fatalf("event %s raw = %q, want valid raw JSON-RPC payload", event.EventID, event.Raw)
		}
		var data map[string]any
		if err := json.Unmarshal(event.Data, &data); err != nil {
			t.Fatalf("decode data: %v", err)
		}
		if data["tool_use_id"] != "call-1" || data["name"] != "bash" {
			t.Fatalf("tool data = %#v", data)
		}
	}

	var secondRaw map[string]any
	if err := json.Unmarshal(got[1].Raw, &secondRaw); err != nil {
		t.Fatalf("decode second raw: %v", err)
	}
	params, _ := secondRaw["params"].(map[string]any)
	update, _ := params["update"].(map[string]any)
	rawInput, _ := update["rawInput"].(map[string]any)
	if rawInput["command"] != "df -h" {
		t.Fatalf("second rawInput = %#v, want command", rawInput)
	}
}

func drainTaskEvents(ch <-chan protocol.Envelope) []protocol.TaskEvent {
	var events []protocol.TaskEvent
	for {
		select {
		case env := <-ch:
			var event protocol.TaskEvent
			if json.Unmarshal(env.Payload, &event) == nil {
				events = append(events, event)
			}
		default:
			return events
		}
	}
}
