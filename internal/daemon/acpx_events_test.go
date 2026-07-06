package daemon

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"remote-agent/internal/protocol"
)

func TestACPXToolUpdatesAreForwardedIndividuallyWithRawPayload(t *testing.T) {
	d := New(Config{})
	emitter := &taskEmitter{daemon: d, taskID: "task-1"}
	adapter := newAgentOutputAdapter(emitter, 0, "")

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

func TestACPXToolUpdateOutputDeltaCarriesAppendMetadata(t *testing.T) {
	d := New(Config{})
	emitter := &taskEmitter{daemon: d, taskID: "task-1"}
	adapter := newAgentOutputAdapter(emitter, 0, "")

	adapter.handle(json.RawMessage(`{"jsonrpc":"2.0","method":"session/update","params":{"update":{"sessionUpdate":"tool_call_update","toolCallId":"subagent-1","title":"Task","status":"running","rawInput":{"description":"inspect bug","subagent_type":"debugger"},"outputDelta":"first chunk\n","stream_id":"subagent-stream-1"}}}`))
	adapter.handle(json.RawMessage(`{"jsonrpc":"2.0","method":"session/update","params":{"update":{"sessionUpdate":"tool_call_update","toolCallId":"subagent-1","title":"Task","status":"running","rawOutputDelta":"second chunk\n","output_stream_id":"subagent-stream-1"}}}`))

	got := drainTaskEvents(d.send)
	if len(got) != 2 {
		t.Fatalf("events len = %d, want 2: %#v", len(got), got)
	}
	for _, event := range got {
		if event.EventType != "tool.output" {
			t.Fatalf("event type = %q, want tool.output", event.EventType)
		}
		var data map[string]any
		if err := json.Unmarshal(event.Data, &data); err != nil {
			t.Fatalf("decode data: %v", err)
		}
		if data["tool_use_id"] != "subagent-1" || data["append"] != true || data["stream_id"] != "subagent-stream-1" {
			t.Fatalf("tool delta data = %#v", data)
		}
		if data["status"] != "running" {
			t.Fatalf("status = %#v, want running", data["status"])
		}
		if strings.TrimSpace(stringField(data, "output")) == "" {
			t.Fatalf("output = %#v, want delta text", data["output"])
		}
	}
}

func TestACPXSessionCreateEmitsModelListFromStatus(t *testing.T) {
	dir := t.TempDir()
	scriptPath := filepath.Join(dir, "fake-acpx")
	script := `#!/bin/sh
case "$*" in
  *" sessions new "*|*" sessions ensure "*)
    printf '{"acpxRecordId":"rec-1","acpxSessionId":"sess-1"}\n'
    ;;
  *" status "*)
    printf '{"acpxRecordId":"rec-1","acpx":{"current_model_id":"model-b","available_models":["model-a","model-b"]}}\n'
    ;;
  *)
    printf '{}\n'
    ;;
esac
`
	if err := os.WriteFile(scriptPath, []byte(script), 0o755); err != nil {
		t.Fatalf("write fake acpx: %v", err)
	}

	cfg := DefaultConfig()
	cfg.ACPX.Enabled = true
	cfg.ACPX.Command = scriptPath
	cfg.ACPX.Args = nil
	cfg.ACPX.TTLSeconds = 0
	cfg.ACPX.Agent = "opencode"
	d := New(cfg)

	d.createSession(context.Background(), protocol.SessionCreate{
		TaskID:        "task-1",
		WorkspacePath: dir,
		Agent:         "opencode",
		AgentRuntime:  "acpx",
		SessionName:   "task-1",
	})

	events := drainTaskEvents(d.send)
	if !hasTaskEvent(events, "model.list") {
		t.Fatalf("ACPX session events missing model.list: %#v", events)
	}
	modelEvent := taskEventOfType(events, "model.list")
	var raw map[string]any
	if err := json.Unmarshal(modelEvent.Raw, &raw); err != nil {
		t.Fatalf("decode model.list raw: %v", err)
	}
	result, _ := raw["result"].(map[string]any)
	models, _ := result["models"].(map[string]any)
	available, _ := models["availableModels"].([]any)
	if models["currentModelId"] != "model-b" || len(available) != 2 {
		t.Fatalf("model.list models = %#v, want current model and available models", models)
	}
}

func TestACPXModelListRawUsesConfigOptions(t *testing.T) {
	raw := acpxModelListRaw(
		map[string]any{"acpxRecordId": "rec-1"},
		map[string]any{
			"config_options": []any{
				map[string]any{
					"id":           "model",
					"category":     "model",
					"currentValue": "model-b",
					"options": []any{
						map[string]any{"value": "model-a", "name": "Model A"},
						map[string]any{"value": "model-b", "name": "Model B"},
					},
				},
			},
		},
	)
	if raw == nil {
		t.Fatal("acpxModelListRaw() = nil, want model list from config_options")
	}
	result, _ := raw["result"].(map[string]any)
	models, _ := result["models"].(map[string]any)
	available, _ := models["availableModels"].([]any)
	if models["currentModelId"] != "model-b" || len(available) != 2 {
		t.Fatalf("model.list models = %#v, want current model and available models", models)
	}
}

func TestACPXPromptArgsUsePromptSubcommandBeforeSessionOption(t *testing.T) {
	cfg := DefaultConfig()
	cfg.ACPX.Args = []string{"--format", "json", "--approve-all"}
	cfg.ACPX.TTLSeconds = 300
	d := New(cfg)

	args := d.buildACPXPromptArgs(protocol.TaskDispatch{
		Agent:       "claude",
		SessionName: "agentbridge",
		Prompt:      "ping",
	}, "/tmp/work")

	want := []string{"--format", "json", "--approve-all", "--ttl", "300", "--cwd", "/tmp/work", "claude", "prompt", "--session", "agentbridge", "ping"}
	if got := strings.Join(args, "\x00"); got != strings.Join(want, "\x00") {
		t.Fatalf("buildACPXPromptArgs() = %#v, want %#v", args, want)
	}
}

func TestACPXPromptArgsNormalizeKiloToKilocode(t *testing.T) {
	cfg := DefaultConfig()
	cfg.ACPX.Args = []string{"--format", "json", "--approve-all"}
	d := New(cfg)

	args := d.buildACPXPromptArgs(protocol.TaskDispatch{
		Agent:       "kilo",
		SessionName: "agentbridge",
		Prompt:      "ping",
	}, "/tmp/work")

	want := []string{"--format", "json", "--approve-all", "--ttl", "300", "--cwd", "/tmp/work", "kilocode", "prompt", "--session", "agentbridge", "ping"}
	if got := strings.Join(args, "\x00"); got != strings.Join(want, "\x00") {
		t.Fatalf("buildACPXPromptArgs() = %#v, want %#v", args, want)
	}
}

func TestACPXPromptArgsKeepCodexAgent(t *testing.T) {
	cfg := DefaultConfig()
	cfg.ACPX.Args = []string{"--format", "json", "--approve-all"}
	d := New(cfg)

	args := d.buildACPXPromptArgs(protocol.TaskDispatch{
		Agent:       "codex",
		SessionName: "agentbridge",
		Prompt:      "ping",
	}, "/tmp/work")

	want := []string{"--format", "json", "--approve-all", "--ttl", "300", "--cwd", "/tmp/work", "codex", "prompt", "--session", "agentbridge", "ping"}
	if got := strings.Join(args, "\x00"); got != strings.Join(want, "\x00") {
		t.Fatalf("buildACPXPromptArgs() = %#v, want %#v", args, want)
	}
}

func TestACPXSessionEnsureTimesOut(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("shell sleep test is unix-specific")
	}
	dir := t.TempDir()
	scriptPath := filepath.Join(dir, "fake-acpx")
	script := "#!/bin/sh\nsleep 5\n"
	if err := os.WriteFile(scriptPath, []byte(script), 0o755); err != nil {
		t.Fatalf("write fake acpx: %v", err)
	}

	cfg := DefaultConfig()
	cfg.ACPX.Command = scriptPath
	cfg.ACPX.Args = nil
	cfg.ACPX.TTLSeconds = 0
	cfg.ACPX.CommandTimeoutSeconds = 1
	d := New(cfg)

	started := time.Now()
	_, _, err := d.ensureACPXSession(context.Background(), protocol.TaskDispatch{
		Agent:       "claude",
		SessionName: "agentbridge",
	}, dir, "task-timeout")
	if err == nil {
		t.Fatal("ensureACPXSession() error = nil, want timeout")
	}
	if !strings.Contains(err.Error(), "acpx session ensure timed out after 1s") {
		t.Fatalf("ensureACPXSession() error = %q, want timeout text", err)
	}
	if elapsed := time.Since(started); elapsed > 3*time.Second {
		t.Fatalf("ensureACPXSession() elapsed = %s, want daemon-side timeout", elapsed)
	}
}

func TestACPXClaudeAuthenticationErrorFallsBackToClaudeCLI(t *testing.T) {
	dir := t.TempDir()
	acpxPath := filepath.Join(dir, "fake-acpx")
	acpxScript := `#!/bin/sh
case "$*" in
  *" sessions ensure "*)
    printf '{"acpxRecordId":"rec-1","acpxSessionId":"sess-1","name":"agentbridge"}\n'
    ;;
  *" status "*)
    printf '{"action":"status_snapshot","status":"idle","availableModels":["sonnet"],"model":"sonnet"}\n'
    ;;
  *" prompt "*)
    printf '{"jsonrpc":"2.0","id":3,"error":{"code":-32000,"message":"Authentication required"}}\n'
    exit 1
    ;;
  *)
    printf '{}\n'
    ;;
esac
`
	if err := os.WriteFile(acpxPath, []byte(acpxScript), 0o755); err != nil {
		t.Fatalf("write fake acpx: %v", err)
	}

	claudePath := filepath.Join(dir, "fake-claude")
	claudeScript := `#!/bin/sh
printf '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"fallback ok"}]}}\n'
printf '{"type":"result","subtype":"success","is_error":false,"stop_reason":"end_turn"}\n'
`
	if err := os.WriteFile(claudePath, []byte(claudeScript), 0o755); err != nil {
		t.Fatalf("write fake claude: %v", err)
	}

	cfg := DefaultConfig()
	cfg.ACPX.Command = acpxPath
	cfg.ACPX.Args = nil
	cfg.ACPX.TTLSeconds = 0
	cfg.ACPX.Agent = "claude"
	cfg.Claude.Command = claudePath
	cfg.Claude.Args = []string{"--output-format", "stream-json", "--verbose"}
	d := New(cfg)

	d.startTask(context.Background(), protocol.TaskDispatch{
		TaskID:        "task-auth-fallback",
		WorkspacePath: dir,
		Agent:         "claude",
		AgentRuntime:  "acpx",
		SessionName:   "agentbridge",
		Prompt:        "ping",
	})

	events := drainTaskEvents(d.send)
	if !hasTaskEvent(events, "task.fallback") {
		t.Fatalf("events missing task.fallback: %#v", events)
	}
	if !hasTaskEvent(events, "assistant.message") {
		t.Fatalf("events missing fallback assistant.message: %#v", events)
	}
	if !hasTaskEvent(events, "task.completed") {
		t.Fatalf("events missing task.completed: %#v", events)
	}
	if hasTaskEvent(events, "task.failed") {
		t.Fatalf("events contain task.failed despite fallback: %#v", events)
	}
}

func TestExtractACPXErrorTextIncludesDetailCode(t *testing.T) {
	got := extractACPXErrorText(`{"jsonrpc":"2.0","id":null,"error":{"code":-32000,"message":"Authentication required","data":{"acpxCode":"RUNTIME","detailCode":"AUTH_REQUIRED"}}}`)
	if got != "Authentication required (AUTH_REQUIRED)" {
		t.Fatalf("extractACPXErrorText() = %q", got)
	}
}

func TestACPXSessionRecordsUseSnakeCaseTimesAndKeepRepeatedPrompts(t *testing.T) {
	dir := t.TempDir()
	scriptPath := filepath.Join(dir, "fake-acpx")
	script := `#!/bin/sh
case "$*" in
  *" sessions list "*)
    printf '[{"acpx_record_id":"rec-1","name":"acpx-repeat","cwd":"%s","created_at":"2026-07-03T09:25:16.020Z","last_used_at":"2026-07-06T02:01:20.612Z","messages":[{"User":{"content":[{"Text":"again"}]}},{"Agent":{"content":[{"Text":"first reply"}]}},{"User":{"content":[{"Text":"again"}]}},{"Agent":{"content":[{"Text":"second reply"}]}}]}]' "$PWD"
    ;;
  *)
    printf '{}\n'
    ;;
esac
`
	if err := os.WriteFile(scriptPath, []byte(script), 0o755); err != nil {
		t.Fatalf("write fake acpx: %v", err)
	}

	cfg := DefaultConfig()
	cfg.Workspaces = []protocol.Workspace{{ID: "w", Path: dir}}
	cfg.ACPX.Enabled = true
	cfg.ACPX.Command = scriptPath
	cfg.ACPX.Args = nil
	cfg.ACPX.TTLSeconds = 0
	cfg.ACPX.Agent = "opencode"
	d := New(cfg)

	records, err := d.acpxSessionRecords(context.Background(), d.cfg.ACPX.Agent)
	if err != nil {
		t.Fatalf("acpxSessionRecords() error = %v", err)
	}
	if len(records) != 1 {
		t.Fatalf("records len = %d, want 1: %#v", len(records), records)
	}
	events := records[0].Events
	if len(events) != 4 {
		t.Fatalf("events len = %d, want 4: %#v", len(events), events)
	}
	wantTypes := []string{"user.prompt", "assistant.message", "user.prompt", "assistant.message"}
	for i, want := range wantTypes {
		if events[i].EventType != want {
			t.Fatalf("event %d type = %q, want %q: %#v", i, events[i].EventType, want, events)
		}
		if events[i].Sequence != int64(i+1) {
			t.Fatalf("event %d sequence = %d, want %d", i, events[i].Sequence, i+1)
		}
		if events[i].Timestamp == 0 {
			t.Fatalf("event %d timestamp = 0, want parsed snake_case timestamp: %#v", i, events[i])
		}
	}
}

func TestACPXSessionRecordsUseSessionNameForRestore(t *testing.T) {
	dir := t.TempDir()
	scriptPath := filepath.Join(dir, "fake-acpx")
	script := `#!/bin/sh
case "$*" in
  *" sessions list "*)
    printf '[{"acpxRecordId":"rec-1","name":"acpx-mqrestore123","cwd":"%s","closed":true,"createdAt":"2026-01-01T00:00:00Z","lastUsedAt":"2026-01-01T00:00:10Z","messages":[{"User":{"content":[{"Text":"hello restored"}]}},{"Agent":{"content":[{"Text":"restored answer"}]}}]},{"acpxRecordId":"rec-2","name":"external-session","cwd":"%s","closed":true,"messages":[]}]' "$PWD" "$PWD"
    ;;
  *)
    printf '{}\n'
    ;;
esac
`
	if err := os.WriteFile(scriptPath, []byte(script), 0o755); err != nil {
		t.Fatalf("write fake acpx: %v", err)
	}

	cfg := DefaultConfig()
	cfg.Workspaces = []protocol.Workspace{{ID: "w", Path: dir}}
	cfg.ACPX.Enabled = true
	cfg.ACPX.Command = scriptPath
	cfg.ACPX.Args = nil
	cfg.ACPX.TTLSeconds = 0
	cfg.ACPX.Agent = "opencode"
	d := New(cfg)

	records, err := d.acpxSessionRecords(context.Background(), d.cfg.ACPX.Agent)
	if err != nil {
		t.Fatalf("acpxSessionRecords() error = %v", err)
	}
	if len(records) != 2 {
		t.Fatalf("records len = %d, want 2: %#v", len(records), records)
	}
	var record protocol.TaskRecord
	for _, item := range records {
		if item.TaskID == "rec-1" {
			record = item
			break
		}
	}
	if record.TaskID == "" {
		t.Fatalf("missing rec-1 record: %#v", records)
	}
	if record.SessionID != "rec-1" {
		t.Fatalf("SessionID = %q, want acpx record id", record.SessionID)
	}
	if record.AgentRuntime != "acpx" {
		t.Fatalf("AgentRuntime = %q, want acpx", record.AgentRuntime)
	}
	if record.Status != "closed" {
		t.Fatalf("Status = %q, want closed", record.Status)
	}
	if len(record.Events) != 2 {
		t.Fatalf("events len = %d, want restored user and assistant events: %#v", len(record.Events), record.Events)
	}
	if record.Events[0].TaskID != record.TaskID || record.Events[1].TaskID != record.TaskID {
		t.Fatalf("event task ids = %q, %q, want %q", record.Events[0].TaskID, record.Events[1].TaskID, record.TaskID)
	}
}

func TestMergeTaskEventsDeduplicatesSameEventDataWithDifferentRaw(t *testing.T) {
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

	merged := mergeTaskEvents(base, extra)
	if len(merged) != 1 || merged[0].EventID != "evt-history" {
		t.Fatalf("merged events = %#v, want one history event", merged)
	}
}

func TestMergeTaskEventsKeepsRepeatedUserPromptsWithoutTurnID(t *testing.T) {
	data := json.RawMessage(`{"prompt":"again"}`)
	base := []protocol.TaskEvent{
		{TaskID: "task-1", EventID: "evt-user-1", EventType: "user.prompt", Sequence: 1, Data: data},
	}
	extra := []protocol.TaskEvent{
		{TaskID: "task-1", EventID: "evt-user-2", EventType: "user.prompt", Sequence: 2, Data: data},
	}

	merged := mergeTaskEvents(base, extra)
	if len(merged) != 2 {
		t.Fatalf("merged events = %#v, want both repeated user prompts", merged)
	}
}

func TestMergeTaskEventsDeduplicatesSameTurnUserPromptEcho(t *testing.T) {
	base := []protocol.TaskEvent{
		{TaskID: "task-1", EventID: "evt-server", EventType: "user.prompt", Sequence: 1, Data: json.RawMessage(`{"prompt":"again","turn_id":"turn-1"}`)},
	}
	extra := []protocol.TaskEvent{
		{TaskID: "task-1", EventID: "evt-daemon", EventType: "user.prompt", Sequence: 2, Data: json.RawMessage(`{"prompt":"again","turn_id":"turn-1"}`)},
	}

	merged := mergeTaskEvents(base, extra)
	if len(merged) != 1 || merged[0].EventID != "evt-server" {
		t.Fatalf("merged events = %#v, want one same-turn user prompt", merged)
	}
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
