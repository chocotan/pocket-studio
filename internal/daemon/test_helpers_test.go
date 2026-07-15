package daemon

import (
	"encoding/json"
	"testing"

	"remote-agent/internal/protocol"
)

func taskEventData(t *testing.T, event protocol.TaskEvent) map[string]any {
	t.Helper()
	var data map[string]any
	if err := json.Unmarshal(event.Data, &data); err != nil {
		t.Fatalf("decode event data: %v", err)
	}
	return data
}

func taskEventsOfType(events []protocol.TaskEvent, eventType string) []protocol.TaskEvent {
	result := make([]protocol.TaskEvent, 0, len(events))
	for _, event := range events {
		if event.EventType == eventType {
			result = append(result, event)
		}
	}
	return result
}

func taskEventOfType(events []protocol.TaskEvent, eventType string) protocol.TaskEvent {
	for _, event := range events {
		if event.EventType == eventType {
			return event
		}
	}
	return protocol.TaskEvent{}
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
