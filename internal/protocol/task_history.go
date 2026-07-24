package protocol

import (
	"encoding/json"
	"strings"
)

func SanitizeTaskHistoryEvents(events []TaskEvent) []TaskEvent {
	if len(events) == 0 {
		return nil
	}
	sanitized := append([]TaskEvent(nil), events...)
	for index := range sanitized {
		if len(sanitized[index].Data) > 0 && !json.Valid(sanitized[index].Data) {
			sanitized[index].Data = nil
		}
		if len(sanitized[index].Raw) > 0 && !json.Valid(sanitized[index].Raw) {
			sanitized[index].Raw = nil
		}
	}
	return sanitized
}

// PaginateTaskHistory returns the newest page before cursor. The cursor is the
// first event ID from the previous page, so appending live events cannot shift it.
func PaginateTaskHistory(events []TaskEvent, cursor string, limit int) ([]TaskEvent, string, bool) {
	if len(events) == 0 {
		return nil, "", false
	}
	if limit <= 0 {
		return append([]TaskEvent(nil), events...), "", false
	}
	if limit > MaxTaskHistoryLimit {
		limit = MaxTaskHistoryLimit
	}

	end := len(events)
	cursor = strings.TrimSpace(cursor)
	if cursor != "" {
		end = -1
		for index := len(events) - 1; index >= 0; index-- {
			if events[index].EventID == cursor {
				end = index
				break
			}
		}
		if end < 0 {
			return nil, "", false
		}
	}

	start := end - limit
	if start < 0 {
		start = 0
	}
	page := append([]TaskEvent(nil), events[start:end]...)
	hasMore := start > 0
	if !hasMore || len(page) == 0 || strings.TrimSpace(page[0].EventID) == "" {
		return page, "", false
	}
	return page, page[0].EventID, true
}
