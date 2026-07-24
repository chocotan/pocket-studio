package protocol

import (
	"encoding/json"
	"fmt"
	"testing"
)

func TestPaginateTaskHistoryUsesStableBackwardCursor(t *testing.T) {
	events := make([]TaskEvent, 1_000)
	for index := range events {
		events[index] = TaskEvent{EventID: fmt.Sprintf("event-%04d", index), Sequence: int64(index + 1)}
	}

	page, cursor, hasMore := PaginateTaskHistory(events, "", DefaultTaskHistoryLimit)
	if len(page) != DefaultTaskHistoryLimit || page[0].EventID != "event-0800" || page[len(page)-1].EventID != "event-0999" {
		t.Fatalf("tail page = len %d, first %q, last %q", len(page), page[0].EventID, page[len(page)-1].EventID)
	}
	if !hasMore || cursor != "event-0800" {
		t.Fatalf("tail cursor = %q, hasMore=%v", cursor, hasMore)
	}

	older, nextCursor, olderHasMore := PaginateTaskHistory(events, cursor, DefaultTaskHistoryLimit)
	if len(older) != DefaultTaskHistoryLimit || older[0].EventID != "event-0600" || older[len(older)-1].EventID != "event-0799" {
		t.Fatalf("older page = len %d, first %q, last %q", len(older), older[0].EventID, older[len(older)-1].EventID)
	}
	if !olderHasMore || nextCursor != "event-0600" {
		t.Fatalf("older cursor = %q, hasMore=%v", nextCursor, olderHasMore)
	}

	appended := append(append([]TaskEvent(nil), events...), TaskEvent{EventID: "event-1000", Sequence: 1_001})
	stable, _, _ := PaginateTaskHistory(appended, cursor, DefaultTaskHistoryLimit)
	if stable[0].EventID != "event-0600" || stable[len(stable)-1].EventID != "event-0799" {
		t.Fatalf("appending live history shifted cursor page: first %q, last %q", stable[0].EventID, stable[len(stable)-1].EventID)
	}
}

func TestPaginateTaskHistoryBoundsLimitAndRejectsStaleCursor(t *testing.T) {
	events := make([]TaskEvent, MaxTaskHistoryLimit+25)
	for index := range events {
		events[index] = TaskEvent{EventID: fmt.Sprintf("event-%d", index)}
	}
	page, _, _ := PaginateTaskHistory(events, "", MaxTaskHistoryLimit+1_000)
	if len(page) != MaxTaskHistoryLimit {
		t.Fatalf("bounded page len = %d, want %d", len(page), MaxTaskHistoryLimit)
	}
	page, cursor, hasMore := PaginateTaskHistory(events, "missing", DefaultTaskHistoryLimit)
	if len(page) != 0 || cursor != "" || hasMore {
		t.Fatalf("stale cursor page = %#v, cursor=%q, hasMore=%v", page, cursor, hasMore)
	}
}

func TestSanitizeTaskHistoryEventsDropsOnlyMalformedJSONFields(t *testing.T) {
	events := []TaskEvent{
		{EventID: "bad-data", Data: json.RawMessage(`{"text":`), Raw: json.RawMessage(`{"valid":true}`)},
		{EventID: "bad-raw", Data: json.RawMessage(`{"text":"ok"}`), Raw: json.RawMessage(`not-json`)},
	}
	sanitized := SanitizeTaskHistoryEvents(events)
	if sanitized[0].Data != nil || string(sanitized[0].Raw) != `{"valid":true}` {
		t.Fatalf("bad data sanitization = %#v", sanitized[0])
	}
	if string(sanitized[1].Data) != `{"text":"ok"}` || sanitized[1].Raw != nil {
		t.Fatalf("bad raw sanitization = %#v", sanitized[1])
	}
	if len(events[0].Data) == 0 || len(events[1].Raw) == 0 {
		t.Fatal("sanitization mutated source events")
	}
}
