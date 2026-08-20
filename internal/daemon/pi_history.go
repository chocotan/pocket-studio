package daemon

import (
	"bufio"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
)

type piImportedHistoryEvent struct {
	EventType           string
	Data                map[string]any
	ProviderTimestampMS int64
}

func loadPiImportedHistory(sessionID string) ([]piImportedHistoryEvent, error) {
	sessionID = strings.TrimSpace(sessionID)
	if sessionID == "" {
		return nil, errors.New("Pi session id is empty")
	}
	path, err := findSessionHistoryFile(piSessionHistoryRoots(), sessionID)
	if err != nil {
		return nil, err
	}
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer file.Close()

	events := make([]piImportedHistoryEvent, 0)
	scanner := bufio.NewScanner(file)
	scanner.Buffer(make([]byte, 0, 64*1024), 64*1024*1024)
	for scanner.Scan() {
		var row map[string]any
		if json.Unmarshal(scanner.Bytes(), &row) != nil || stringField(row, "type") != "message" {
			continue
		}
		message, _ := row["message"].(map[string]any)
		if message == nil {
			continue
		}
		timestampMS := parseTimestampMilliseconds(row["timestamp"])
		if timestampMS == 0 {
			timestampMS = epochMilliseconds(message["timestamp"])
		}
		switch stringField(message, "role") {
		case "user":
			if text := piHistoryMessageText(message["content"]); text != "" {
				events = append(events, piImportedHistoryEvent{
					EventType: "user.prompt",
					Data: map[string]any{
						"prompt":           text,
						"imported_history": true,
					},
					ProviderTimestampMS: timestampMS,
				})
			}
		case "assistant":
			content, _ := message["content"].([]any)
			for _, value := range content {
				part, _ := value.(map[string]any)
				switch stringField(part, "type") {
				case "thinking":
					if text := strings.TrimSpace(stripANSIControlSequences(stringField(part, "thinking", "text"))); text != "" {
						events = append(events, piImportedHistoryEvent{
							EventType: "assistant.thinking",
							Data: map[string]any{
								"text":             text,
								"replace":          false,
								"imported_history": true,
							},
							ProviderTimestampMS: timestampMS,
						})
					}
				case "text":
					if text := strings.TrimSpace(stripANSIControlSequences(stringField(part, "text"))); text != "" {
						events = append(events, piImportedHistoryEvent{
							EventType: "assistant.message",
							Data: map[string]any{
								"text":             text,
								"replace":          false,
								"imported_history": true,
							},
							ProviderTimestampMS: timestampMS,
						})
					}
				case "toolCall":
					toolID := stringField(part, "id", "toolCallId", "tool_call_id")
					if toolID == "" {
						continue
					}
					name := stringField(part, "name", "toolName", "tool")
					events = append(events, piImportedHistoryEvent{
						EventType: "tool.call",
						Data: map[string]any{
							"id":               toolID,
							"tool_call_id":     toolID,
							"tool_use_id":      toolID,
							"name":             name,
							"title":            name,
							"kind":             piHistoryToolKind(name),
							"input":            part["arguments"],
							"status":           "pending",
							"imported_history": true,
						},
						ProviderTimestampMS: timestampMS,
					})
				}
			}
		case "toolResult":
			toolID := stringField(message, "toolCallId", "tool_call_id", "id")
			if toolID == "" {
				continue
			}
			name := stringField(message, "toolName", "name", "tool")
			isError, _ := message["isError"].(bool)
			status := "completed"
			if isError {
				status = "failed"
			}
			events = append(events, piImportedHistoryEvent{
				EventType: "tool.output",
				Data: map[string]any{
					"id":               toolID,
					"tool_call_id":     toolID,
					"tool_use_id":      toolID,
					"name":             name,
					"title":            name,
					"kind":             piHistoryToolKind(name),
					"output":           message,
					"status":           status,
					"is_error":         isError,
					"imported_history": true,
				},
				ProviderTimestampMS: timestampMS,
			})
		}
	}
	if err := scanner.Err(); err != nil {
		return nil, err
	}
	if len(events) == 0 {
		return nil, errors.New("Pi session history contains no conversation events")
	}
	return events, nil
}

func emitPiImportedHistory(emitter *taskEmitter, events []piImportedHistoryEvent) {
	if emitter == nil {
		return
	}
	for _, event := range events {
		emitter.emitAt(event.EventType, event.Data, nil, event.ProviderTimestampMS)
	}
}

func piSessionHistoryRoots() []string {
	agentDir := strings.TrimSpace(os.Getenv("PI_CODING_AGENT_DIR"))
	if agentDir == "" {
		agentDir = filepath.Join(userHomeDir(), ".pi", "agent")
	} else if absolute, err := filepath.Abs(agentDir); err == nil {
		agentDir = absolute
	}
	sessionsDir := filepath.Join(agentDir, "sessions")
	settingsRaw, err := os.ReadFile(filepath.Join(agentDir, "settings.json"))
	if err == nil {
		var settings map[string]any
		if json.Unmarshal(settingsRaw, &settings) == nil {
			if configured := strings.TrimSpace(stringField(settings, "sessionDir")); configured != "" {
				if filepath.IsAbs(configured) {
					sessionsDir = configured
				} else {
					sessionsDir = filepath.Join(agentDir, configured)
				}
			}
		}
	}
	return []string{sessionsDir}
}

func piHistoryMessageText(content any) string {
	if text, ok := content.(string); ok {
		return strings.TrimSpace(text)
	}
	return historyMessageText(content)
}

func piHistoryToolKind(name string) string {
	switch strings.ToLower(strings.TrimSpace(name)) {
	case "read":
		return "read"
	case "write", "edit":
		return "edit"
	default:
		return "other"
	}
}
