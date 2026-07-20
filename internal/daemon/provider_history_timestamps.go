package daemon

import (
	"bufio"
	"encoding/json"
	"errors"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"remote-agent/internal/protocol"
)

type providerTurnTiming struct {
	Prompt        string
	StartedAtMS   int64
	CompletedAtMS int64
}

func (d *Daemon) enrichImportedHistoryTimestamps(taskID, agent, sessionID, workspacePath string) {
	if !d.importedHistoryNeedsTimestamps(taskID) {
		return
	}
	timings, err := loadProviderTurnTimings(agent, sessionID, workspacePath)
	if err != nil || len(timings) == 0 {
		return
	}

	d.mu.Lock()
	record := d.history[taskID]
	turnIndex := -1
	searchFrom := 0
	changed := make([]protocol.TaskEvent, 0)
	for index := range record.Events {
		event := &record.Events[index]
		data := taskEventDataMap(*event)
		if event.EventType == "user.prompt" {
			turnIndex = -1
			if data["imported_history"] == true {
				turnIndex = matchingProviderTurnTiming(timings, stringField(data, "prompt"), searchFrom)
			}
			if turnIndex >= 0 {
				searchFrom = turnIndex + 1
			}
		}
		if turnIndex < 0 || turnIndex >= len(timings) {
			continue
		}
		switch event.EventType {
		case "user.prompt", "assistant.message", "assistant.thinking", "tool.call", "tool.output":
		default:
			continue
		}
		timing := timings[turnIndex]
		providerTime := timing.CompletedAtMS
		if event.EventType == "user.prompt" {
			providerTime = timing.StartedAtMS
		}
		if providerTime <= 0 || event.ProviderTimestampMS == providerTime {
			continue
		}
		event.ProviderTimestampMS = providerTime
		changed = append(changed, *event)
	}
	d.history[taskID] = record
	if len(changed) > 0 {
		d.markDirectACPStoreDirtyLocked()
	}
	d.mu.Unlock()

	for _, event := range changed {
		d.sendTaskEvent(event)
	}
}

func matchingProviderTurnTiming(timings []providerTurnTiming, prompt string, searchFrom int) int {
	prompt = strings.TrimSpace(prompt)
	if prompt == "" {
		return -1
	}
	for index := searchFrom; index < len(timings); index++ {
		if strings.TrimSpace(timings[index].Prompt) == prompt {
			return index
		}
	}
	return -1
}

func (d *Daemon) importedHistoryNeedsTimestamps(taskID string) bool {
	d.mu.Lock()
	defer d.mu.Unlock()
	inImportedTurn := false
	for _, event := range d.history[taskID].Events {
		data := taskEventDataMap(event)
		if event.EventType == "user.prompt" {
			inImportedTurn = data["imported_history"] == true
		}
		if !inImportedTurn || event.ProviderTimestampMS > 0 {
			continue
		}
		switch event.EventType {
		case "user.prompt", "assistant.message", "assistant.thinking", "tool.call", "tool.output":
			return true
		}
	}
	return false
}

func taskEventDataMap(event protocol.TaskEvent) map[string]any {
	for _, raw := range []json.RawMessage{event.Data, event.Raw} {
		if len(raw) == 0 {
			continue
		}
		var data map[string]any
		if err := json.Unmarshal(raw, &data); err == nil {
			return data
		}
	}
	return nil
}

func loadProviderTurnTimings(agent, sessionID, workspacePath string) ([]providerTurnTiming, error) {
	switch normalizeAgentName(agent) {
	case "opencode":
		return loadOpenCodeTurnTimings(sessionID, workspacePath)
	case "codex":
		return loadCodexTurnTimings(sessionID)
	case "claude":
		return loadClaudeTurnTimings(sessionID)
	default:
		return nil, nil
	}
}

func loadOpenCodeTurnTimings(sessionID, workspacePath string) ([]providerTurnTiming, error) {
	command, err := exec.LookPath("opencode")
	if err != nil {
		return nil, err
	}
	cmd := exec.Command(command, "export", sessionID)
	cmd.Dir = workspacePath
	raw, err := cmd.Output()
	if err != nil {
		return nil, err
	}
	var export struct {
		Messages []struct {
			Info  map[string]any   `json:"info"`
			Parts []map[string]any `json:"parts"`
		} `json:"messages"`
	}
	if err := json.Unmarshal(raw, &export); err != nil {
		return nil, err
	}
	timings := make([]providerTurnTiming, 0)
	for _, message := range export.Messages {
		role := stringField(message.Info, "role")
		messageTime, _ := message.Info["time"].(map[string]any)
		if role == "user" {
			parts := make([]string, 0)
			for _, part := range message.Parts {
				if stringField(part, "type") == "text" {
					parts = append(parts, stringField(part, "text"))
				}
			}
			timings = append(timings, providerTurnTiming{
				Prompt:      strings.TrimSpace(strings.Join(parts, "\n")),
				StartedAtMS: firstPositiveInt64(messageTime["created"], messageTime["completed"]),
			})
			continue
		}
		if role != "assistant" || len(timings) == 0 {
			continue
		}
		completedAt := firstPositiveInt64(messageTime["completed"], messageTime["created"])
		for _, part := range message.Parts {
			partTime, _ := part["time"].(map[string]any)
			completedAt = maxInt64(completedAt, firstPositiveInt64(partTime["end"], partTime["start"]))
		}
		if completedAt > 0 {
			timings[len(timings)-1].CompletedAtMS = completedAt
		}
	}
	return normalizedTurnTimings(timings), nil
}

func loadCodexTurnTimings(sessionID string) ([]providerTurnTiming, error) {
	path, err := findSessionHistoryFile([]string{
		filepath.Join(userHomeDir(), ".codex", "sessions"),
		filepath.Join(userHomeDir(), ".codex", "archived_sessions"),
	}, sessionID)
	if err != nil {
		return nil, err
	}
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer file.Close()

	timings := make([]providerTurnTiming, 0)
	turnIndexes := make(map[string]int)
	scanner := bufio.NewScanner(file)
	scanner.Buffer(make([]byte, 0, 64*1024), 4*1024*1024)
	for scanner.Scan() {
		var row map[string]any
		if json.Unmarshal(scanner.Bytes(), &row) != nil {
			continue
		}
		payload, _ := row["payload"].(map[string]any)
		if stringField(row, "type") == "response_item" && stringField(payload, "type") == "message" && stringField(payload, "role") == "user" {
			metadata, _ := payload["internal_chat_message_metadata_passthrough"].(map[string]any)
			turnID := stringField(metadata, "turn_id")
			if index, ok := turnIndexes[turnID]; ok {
				timings[index].Prompt = historyMessageText(payload["content"])
			}
			continue
		}
		if stringField(row, "type") != "event_msg" {
			continue
		}
		turnID := stringField(payload, "turn_id")
		switch stringField(payload, "type") {
		case "task_started":
			startedAt := epochMilliseconds(payload["started_at"])
			if startedAt == 0 {
				startedAt = parseTimestampMilliseconds(row["timestamp"])
			}
			turnIndexes[turnID] = len(timings)
			timings = append(timings, providerTurnTiming{StartedAtMS: startedAt})
		case "task_complete":
			index, ok := turnIndexes[turnID]
			if !ok {
				continue
			}
			completedAt := epochMilliseconds(payload["completed_at"])
			if completedAt == 0 {
				completedAt = parseTimestampMilliseconds(row["timestamp"])
			}
			timings[index].CompletedAtMS = completedAt
		}
	}
	return normalizedTurnTimings(timings), scanner.Err()
}

func loadClaudeTurnTimings(sessionID string) ([]providerTurnTiming, error) {
	path, err := findSessionHistoryFile([]string{filepath.Join(userHomeDir(), ".claude", "projects")}, sessionID)
	if err != nil {
		return nil, err
	}
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer file.Close()

	timings := make([]providerTurnTiming, 0)
	scanner := bufio.NewScanner(file)
	scanner.Buffer(make([]byte, 0, 64*1024), 4*1024*1024)
	for scanner.Scan() {
		var row map[string]any
		if json.Unmarshal(scanner.Bytes(), &row) != nil || row["isSidechain"] == true {
			continue
		}
		timestamp := parseTimestampMilliseconds(row["timestamp"])
		switch stringField(row, "type") {
		case "user":
			if claudeHistoryUserIsToolResult(row) {
				if len(timings) > 0 {
					timings[len(timings)-1].CompletedAtMS = maxInt64(timings[len(timings)-1].CompletedAtMS, timestamp)
				}
				continue
			}
			message, _ := row["message"].(map[string]any)
			timings = append(timings, providerTurnTiming{
				Prompt:      historyMessageText(message["content"]),
				StartedAtMS: timestamp,
			})
		case "assistant":
			if len(timings) > 0 {
				timings[len(timings)-1].CompletedAtMS = maxInt64(timings[len(timings)-1].CompletedAtMS, timestamp)
			}
		}
	}
	return normalizedTurnTimings(timings), scanner.Err()
}

func historyMessageText(content any) string {
	parts, _ := content.([]any)
	texts := make([]string, 0, len(parts))
	for _, value := range parts {
		part, _ := value.(map[string]any)
		switch stringField(part, "type") {
		case "input_text", "output_text", "text":
			if text := stringField(part, "text"); text != "" {
				texts = append(texts, text)
			}
		}
	}
	return strings.TrimSpace(strings.Join(texts, "\n"))
}

func claudeHistoryUserIsToolResult(row map[string]any) bool {
	message, _ := row["message"].(map[string]any)
	content, _ := message["content"].([]any)
	for _, value := range content {
		part, _ := value.(map[string]any)
		if stringField(part, "type") == "tool_result" {
			return true
		}
	}
	return false
}

func findSessionHistoryFile(roots []string, sessionID string) (string, error) {
	for _, root := range roots {
		var match string
		_ = filepath.WalkDir(root, func(path string, entry fs.DirEntry, err error) error {
			if err != nil || entry.IsDir() || !strings.HasSuffix(entry.Name(), ".jsonl") {
				return nil
			}
			if strings.Contains(entry.Name(), sessionID) {
				match = path
				return fs.SkipAll
			}
			return nil
		})
		if match != "" {
			return match, nil
		}
	}
	return "", errors.New("provider history file not found")
}

func userHomeDir() string {
	home, _ := os.UserHomeDir()
	return home
}

func parseTimestampMilliseconds(value any) int64 {
	text, _ := value.(string)
	parsed, err := time.Parse(time.RFC3339Nano, strings.TrimSpace(text))
	if err != nil {
		return 0
	}
	return parsed.UnixMilli()
}

func epochMilliseconds(value any) int64 {
	result := firstPositiveInt64(value)
	if result > 0 && result < 1_000_000_000_000 {
		return result * 1000
	}
	return result
}

func firstPositiveInt64(values ...any) int64 {
	for _, value := range values {
		var number int64
		switch typed := value.(type) {
		case float64:
			number = int64(typed)
		case int64:
			number = typed
		case json.Number:
			number, _ = typed.Int64()
		}
		if number > 0 {
			return number
		}
	}
	return 0
}

func normalizedTurnTimings(timings []providerTurnTiming) []providerTurnTiming {
	out := timings[:0]
	for _, timing := range timings {
		if timing.StartedAtMS <= 0 {
			continue
		}
		if timing.CompletedAtMS < timing.StartedAtMS {
			timing.CompletedAtMS = timing.StartedAtMS
		}
		out = append(out, timing)
	}
	return out
}

func maxInt64(left, right int64) int64 {
	if right > left {
		return right
	}
	return left
}
