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

func TestACPXAssistantRawMessageCarriesReadableText(t *testing.T) {
	d := New(Config{})
	emitter := &taskEmitter{daemon: d, taskID: "task-1"}
	adapter := newAgentOutputAdapter(emitter, 0, "")

	adapter.handle(json.RawMessage(`{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"final reply"}]}}`))

	got := drainTaskEvents(d.send)
	if len(got) != 1 {
		t.Fatalf("events len = %d, want 1: %#v", len(got), got)
	}
	if got[0].EventType != "assistant.message" {
		t.Fatalf("event type = %q, want assistant.message", got[0].EventType)
	}
	var data map[string]any
	if err := json.Unmarshal(got[0].Data, &data); err != nil {
		t.Fatalf("decode data: %v", err)
	}
	if data["text"] != "final reply" {
		t.Fatalf("assistant data = %#v, want text", data)
	}
}

func TestACPXClaudeSignedEmptyThinkingIsNotRenderedAsJSON(t *testing.T) {
	d := New(Config{})
	emitter := &taskEmitter{daemon: d, taskID: "task-1"}
	adapter := newAgentOutputAdapter(emitter, 0, "")

	adapter.handle(json.RawMessage(`{"type":"assistant","message":{"role":"assistant","content":[{"type":"thinking","thinking":"","signature":"signed-payload"}]}}`))
	adapter.handle(json.RawMessage(`{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"final reply"}]}}`))

	got := drainTaskEvents(d.send)
	if len(got) != 1 {
		t.Fatalf("events len = %d, want only final assistant text: %#v", len(got), got)
	}
	if got[0].EventType != "assistant.message" {
		t.Fatalf("event type = %q, want assistant.message", got[0].EventType)
	}
	var data map[string]any
	if err := json.Unmarshal(got[0].Data, &data); err != nil {
		t.Fatalf("decode data: %v", err)
	}
	if data["text"] != "final reply" {
		t.Fatalf("assistant data = %#v, want final reply only", data)
	}
}

func TestACPXClaudeSignedThinkingBlockEmitsThoughtText(t *testing.T) {
	d := New(Config{})
	emitter := &taskEmitter{daemon: d, taskID: "task-1"}
	adapter := newAgentOutputAdapter(emitter, 0, "")

	adapter.handle(json.RawMessage(`{"type":"assistant","message":{"role":"assistant","content":[{"type":"thinking","thinking":"real thought","signature":"signed-payload"},{"type":"text","text":"final reply"}]}}`))

	got := drainTaskEvents(d.send)
	if len(got) != 2 {
		t.Fatalf("events len = %d, want thought plus final text: %#v", len(got), got)
	}
	if got[0].EventType != "assistant.thinking" || got[1].EventType != "assistant.message" {
		t.Fatalf("event types = %q, %q; want thinking/message", got[0].EventType, got[1].EventType)
	}
	var thought map[string]any
	if err := json.Unmarshal(got[0].Data, &thought); err != nil {
		t.Fatalf("decode thought data: %v", err)
	}
	if thought["text"] != "real thought" {
		t.Fatalf("thought data = %#v, want real thought", thought)
	}
	var message map[string]any
	if err := json.Unmarshal(got[1].Data, &message); err != nil {
		t.Fatalf("decode message data: %v", err)
	}
	if message["text"] != "final reply" {
		t.Fatalf("message data = %#v, want final reply", message)
	}
}

func TestACPXClaudeSignedThinkingHistoryIsNotRenderedAsJSON(t *testing.T) {
	events := acpxSessionHistoryEvents("task-1", map[string]any{
		"acpxRecordId": "rec-1",
		"messages": []any{
			map[string]any{"User": map[string]any{"content": []any{map[string]any{"Text": "hello"}}}},
			map[string]any{"Agent": map[string]any{"content": []any{
				map[string]any{"Thinking": map[string]any{"type": "thinking", "thinking": "", "signature": "signed-payload"}},
				map[string]any{"Text": "final reply"},
			}}},
		},
	}, 100, 120)

	for _, event := range events {
		if event.EventType != "assistant.thinking" {
			continue
		}
		t.Fatalf("unexpected thinking event from signed empty thinking block: %#v", event)
	}
	messages := make([]protocol.TaskEvent, 0)
	for _, event := range events {
		if event.EventType == "assistant.message" {
			messages = append(messages, event)
		}
	}
	if len(messages) != 1 {
		t.Fatalf("assistant messages = %#v, want one final reply", messages)
	}
	var data map[string]any
	if err := json.Unmarshal(messages[0].Data, &data); err != nil {
		t.Fatalf("decode data: %v", err)
	}
	if data["text"] != "final reply" {
		t.Fatalf("assistant data = %#v, want final reply only", data)
	}
}

func TestACPXClaudeLowercaseHistoryRestoresAssistantMessage(t *testing.T) {
	events := acpxSessionHistoryEvents("task-1", map[string]any{
		"acpxRecordId": "rec-1",
		"messages": []any{
			map[string]any{"User": map[string]any{"content": []any{map[string]any{"Text": "hello"}}}},
			map[string]any{"Agent": map[string]any{"content": []any{
				map[string]any{"type": "thinking", "thinking": "", "signature": "signed-payload"},
				map[string]any{"type": "text", "text": "final reply"},
				map[string]any{"type": "tool_use", "id": "call-1", "name": "Read", "input": map[string]any{"file_path": "README.md"}},
			}}},
		},
	}, 100, 120)

	if taskEventOfType(events, "assistant.thinking").EventType != "" {
		t.Fatalf("unexpected empty thinking event: %#v", events)
	}
	message := taskEventOfType(events, "assistant.message")
	if message.EventType == "" {
		t.Fatalf("missing assistant message: %#v", events)
	}
	var data map[string]any
	if err := json.Unmarshal(message.Data, &data); err != nil {
		t.Fatalf("decode message data: %v", err)
	}
	if data["text"] != "final reply" {
		t.Fatalf("assistant data = %#v, want final reply", data)
	}
	tool := taskEventOfType(events, "tool.call")
	if tool.EventType == "" {
		t.Fatalf("missing lowercase tool call: %#v", events)
	}
	var toolData map[string]any
	if err := json.Unmarshal(tool.Data, &toolData); err != nil {
		t.Fatalf("decode tool data: %v", err)
	}
	if toolData["tool_use_id"] != "call-1" || toolData["name"] != "Read" {
		t.Fatalf("tool data = %#v, want restored call-1 Read", toolData)
	}
}

func TestACPXClaudeToolUseWrapperHistoryRestoresToolCall(t *testing.T) {
	events := acpxSessionHistoryEvents("task-1", map[string]any{
		"acpxRecordId": "rec-1",
		"messages": []any{
			map[string]any{"User": map[string]any{"content": []any{map[string]any{"Text": "disk"}}}},
			map[string]any{"Agent": map[string]any{"content": []any{
				map[string]any{"ToolUse": map[string]any{
					"id":                "call_4dc21bc5d85d4935a904cb04",
					"name":              "Shell: df -h (查看磁盘剩余空间)",
					"is_input_complete": true,
					"raw_input":         `{"command":"df -h","description":"查看磁盘剩余空间"}`,
				}},
			}}},
		},
	}, 100, 120)

	if message := taskEventOfType(events, "assistant.message"); message.EventType != "" {
		t.Fatalf("unexpected assistant JSON message for ToolUse wrapper: %#v", message)
	}
	tool := taskEventOfType(events, "tool.call")
	if tool.EventType == "" {
		t.Fatalf("missing tool.call for ToolUse wrapper: %#v", events)
	}
	var data map[string]any
	if err := json.Unmarshal(tool.Data, &data); err != nil {
		t.Fatalf("decode tool data: %v", err)
	}
	if data["tool_use_id"] != "call_4dc21bc5d85d4935a904cb04" || data["name"] != "Shell: df -h (查看磁盘剩余空间)" {
		t.Fatalf("tool data = %#v, want restored shell call", data)
	}
	input, _ := data["input"].(map[string]any)
	if input["command"] != "df -h" || input["description"] != "查看磁盘剩余空间" {
		t.Fatalf("tool input = %#v, want parsed raw_input", input)
	}
}

func TestACPXLiveEventsCarryStableTurnKeys(t *testing.T) {
	d := New(Config{})
	emitter := &taskEmitter{daemon: d, taskID: "task-1", acpx: true, acpxTurn: 2}
	emitter.emit("task.started", map[string]any{"turn_id": "turn-live"}, nil)
	adapter := newAgentOutputAdapter(emitter, 0, "")
	adapter.handle(json.RawMessage(`{"jsonrpc":"2.0","method":"session/update","params":{"update":{"sessionUpdate":"agent_message_chunk","content":{"text":"hello"}}}}`))
	adapter.handle(json.RawMessage(`{"jsonrpc":"2.0","method":"session/update","params":{"update":{"sessionUpdate":"agent_message_chunk","content":{"text":" world"}}}}`))
	adapter.handle(json.RawMessage(`{"jsonrpc":"2.0","id":1,"result":{"stopReason":"end_turn"}}`))

	got := drainTaskEvents(d.send)
	wantKeys := []string{
		"turn:2:task.started:0",
		"turn:2:assistant.message:0",
		"turn:2:assistant.message:0",
		"turn:2:turn.completed:0",
	}
	keyed := make([]protocol.TaskEvent, 0, len(got))
	for _, event := range got {
		if event.EventType == "metric.updated" {
			continue
		}
		keyed = append(keyed, event)
	}
	if len(keyed) != len(wantKeys) {
		t.Fatalf("keyed events len = %d, want %d: all=%#v keyed=%#v", len(keyed), len(wantKeys), got, keyed)
	}
	for i, event := range keyed {
		var data map[string]any
		if err := json.Unmarshal(event.Data, &data); err != nil {
			t.Fatalf("decode event %d data: %v", i, err)
		}
		if data["acpx_event_key"] != wantKeys[i] {
			t.Fatalf("event %d key = %#v, want %q; event=%#v data=%#v", i, data["acpx_event_key"], wantKeys[i], event, data)
		}
		if data["acpx_turn_index"] != float64(2) {
			t.Fatalf("event %d turn = %#v, want 2; data=%#v", i, data["acpx_turn_index"], data)
		}
	}
}

func TestACPXAdapterSkipsSameTextHistoricalPromptUntilNewPromptOrdinal(t *testing.T) {
	d := New(Config{})
	emitter := &taskEmitter{daemon: d, taskID: "task-1", acpx: true, acpxTurn: 1}
	adapter := newAgentOutputAdapter(emitter, 1, "你好")

	adapter.handle(json.RawMessage(`{"jsonrpc":"2.0","method":"session/update","params":{"update":{"sessionUpdate":"user_message_chunk","content":{"text":"你好"}}}}`))
	adapter.handle(json.RawMessage(`{"jsonrpc":"2.0","method":"session/update","params":{"update":{"sessionUpdate":"agent_message_chunk","content":{"text":"old answer should be skipped"}}}}`))
	adapter.handle(json.RawMessage(`{"jsonrpc":"2.0","method":"session/update","params":{"update":{"sessionUpdate":"user_message_chunk","content":{"text":"你好"}}}}`))
	adapter.handle(json.RawMessage(`{"jsonrpc":"2.0","method":"session/update","params":{"update":{"sessionUpdate":"agent_message_chunk","content":{"text":"new answer"}}}}`))

	got := drainTaskEvents(d.send)
	messages := make([]protocol.TaskEvent, 0)
	for _, event := range got {
		if event.EventType == "assistant.message" {
			messages = append(messages, event)
		}
	}
	if len(messages) != 1 {
		t.Fatalf("assistant messages = %#v, want only new prompt response", messages)
	}
	var data map[string]any
	if err := json.Unmarshal(messages[0].Data, &data); err != nil {
		t.Fatalf("decode assistant data: %v", err)
	}
	if data["text"] != "new answer" {
		t.Fatalf("assistant text = %#v, want new answer; all events=%#v", data["text"], got)
	}
	if data["acpx_event_key"] != "turn:1:assistant.message:0" {
		t.Fatalf("assistant key = %#v, want turn 1 first assistant message", data["acpx_event_key"])
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
cmd=""
last=""
for arg in "$@"; do
  if [ "$last" = "sessions" ] && [ "$arg" = "ensure" ]; then
    cmd="sessions ensure"
  fi
  if [ "$last" = "claude" ] && [ "$arg" = "status" ]; then
    cmd="claude status"
  fi
  if [ "$last" = "claude" ] && [ "$arg" = "prompt" ]; then
    cmd="claude prompt"
  fi
  last="$arg"
done
if [ "$cmd" = "sessions ensure" ]; then
  printf '{"acpxRecordId":"rec-1","acpxSessionId":"sess-1","name":"agentbridge"}\n'
  exit 0
fi
if [ "$cmd" = "claude status" ]; then
  printf '{"action":"status_snapshot","status":"idle","availableModels":["sonnet"],"model":"sonnet"}\n'
  exit 0
fi
if [ "$cmd" = "claude prompt" ]; then
  printf '{"jsonrpc":"2.0","id":3,"error":{"code":-32000,"message":"Authentication required"}}\n'
  exit 1
fi
printf '{}\n'
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
	if len(events) != 8 {
		t.Fatalf("events len = %d, want 8 with restored turn boundaries: %#v", len(events), events)
	}
	wantTypes := []string{"task.started", "user.prompt", "assistant.message", "task.completed", "task.started", "user.prompt", "assistant.message", "task.completed"}
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
	wantKeys := map[int]string{
		1: "turn:0:user.prompt:0",
		2: "turn:0:assistant.message:0",
		5: "turn:1:user.prompt:0",
		6: "turn:1:assistant.message:0",
	}
	for index, wantKey := range wantKeys {
		var data map[string]any
		if err := json.Unmarshal(events[index].Data, &data); err != nil {
			t.Fatalf("decode event %d data: %v", index, err)
		}
		if data["acpx_event_key"] != wantKey {
			t.Fatalf("event %d acpx_event_key = %#v, want %q; data=%#v", index, data["acpx_event_key"], wantKey, data)
		}
		wantTurn := float64(0)
		if strings.HasPrefix(wantKey, "turn:1:") {
			wantTurn = 1
		}
		if data["acpx_turn_index"] != wantTurn {
			t.Fatalf("event %d acpx_turn_index = %#v, want %#v; data=%#v", index, data["acpx_turn_index"], wantTurn, data)
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
	if len(record.Events) != 4 {
		t.Fatalf("events len = %d, want restored turn, user, assistant, completion events: %#v", len(record.Events), record.Events)
	}
	for _, event := range record.Events {
		if event.TaskID != record.TaskID {
			t.Fatalf("event task id = %q, want %q: %#v", event.TaskID, record.TaskID, record.Events)
		}
	}
}

func TestTaskHistoryRestoresACPXRecordBySessionID(t *testing.T) {
	d := New(Config{})
	d.mu.Lock()
	d.history["rec-1"] = protocol.TaskRecord{
		TaskID:       "rec-1",
		SessionName:  "acpx-mqrestore123",
		SessionID:    "ui-task-1",
		AgentRuntime: "acpx",
		Events: []protocol.TaskEvent{{
			TaskID:    "rec-1",
			EventID:   "evt-restored",
			EventType: "assistant.message",
			Sequence:  1,
			Timestamp: 100,
		}},
	}
	d.mu.Unlock()

	d.sendTaskHistory(protocol.TaskHistoryGet{RequestID: "req-1", TaskID: "ui-task-1"})
	env := <-d.send
	if env.Type != protocol.TypeTaskHistoryResult {
		t.Fatalf("env type = %q, want task.history.result", env.Type)
	}
	result, err := protocol.DecodePayload[protocol.TaskHistoryResult](env)
	if err != nil {
		t.Fatalf("decode history result: %v", err)
	}
	if result.Record == nil || result.Record.TaskID != "ui-task-1" {
		t.Fatalf("record = %#v, want restored task id ui-task-1", result.Record)
	}
	if len(result.Events) != 1 || result.Events[0].TaskID != "ui-task-1" || result.Events[0].EventID != "evt-restored" {
		t.Fatalf("events = %#v, want restored event rewritten to ui-task-1", result.Events)
	}
}

func TestTaskHistoryRestoresACPXRecordFromLocalSessionsBySessionName(t *testing.T) {
	defaultDir := t.TempDir()
	projectDir := t.TempDir()
	otherDir := t.TempDir()
	scriptPath := filepath.Join(defaultDir, "fake-acpx")
	script := `#!/bin/sh
case "$*" in
  *" qwen sessions list "*)
    case "$PWD" in
      "$POCKET_TEST_PROJECT_DIR")
        printf '[{"acpxRecordId":"rec-empty","name":"acpx-ui-task","cwd":"%s","createdAt":"2026-01-01T00:00:00Z","lastUsedAt":"2026-01-01T00:00:20Z","messages":[]},{"acpxRecordId":"rec-1","name":"acpx-ui-task","cwd":"%s","createdAt":"2026-01-01T00:00:00Z","lastUsedAt":"2026-01-01T00:00:10Z","messages":[{"User":{"content":[{"Text":"hello restored"}]}},{"Agent":{"content":[{"Text":"restored answer"}]}}]},{"acpxRecordId":"rec-other","name":"acpx-ui-task","cwd":"%s","createdAt":"2026-01-01T00:00:00Z","lastUsedAt":"2026-01-01T00:00:30Z","messages":[{"User":{"content":[{"Text":"wrong project"}]}}]}]' "$PWD" "$PWD" "$POCKET_TEST_OTHER_DIR"
        ;;
      *)
        printf '[]'
        ;;
    esac
    ;;
  *" sessions list "*)
    printf '[]'
    ;;
  *)
    printf '{}\n'
    ;;
esac
`
	if err := os.WriteFile(scriptPath, []byte(script), 0o755); err != nil {
		t.Fatalf("write fake acpx: %v", err)
	}
	t.Setenv("POCKET_TEST_PROJECT_DIR", projectDir)
	t.Setenv("POCKET_TEST_OTHER_DIR", otherDir)

	cfg := DefaultConfig()
	cfg.Workspaces = []protocol.Workspace{{ID: "default", Path: defaultDir}, {ID: "project", Path: projectDir}, {ID: "other", Path: otherDir}}
	cfg.ACPX.Enabled = true
	cfg.ACPX.Command = scriptPath
	cfg.ACPX.Args = []string{"--project-dir", projectDir}
	cfg.ACPX.TTLSeconds = 0
	cfg.ACPX.Agent = "opencode"
	d := New(cfg)

	d.sendTaskHistory(protocol.TaskHistoryGet{RequestID: "req-1", TaskID: "acpx-ui-task", WorkspacePath: projectDir})
	env := <-d.send
	if env.Type != protocol.TypeTaskHistoryResult {
		t.Fatalf("env type = %q, want task.history.result", env.Type)
	}
	result, err := protocol.DecodePayload[protocol.TaskHistoryResult](env)
	if err != nil {
		t.Fatalf("decode history result: %v", err)
	}
	if result.Record == nil || result.Record.TaskID != "acpx-ui-task" {
		t.Fatalf("record = %#v, want restored task id acpx-ui-task", result.Record)
	}
	if result.Record.SessionID != "rec-1" || result.Record.SessionName != "acpx-ui-task" {
		t.Fatalf("record session = (%q, %q), want rec-1/acpx-ui-task", result.Record.SessionID, result.Record.SessionName)
	}
	if result.Record.Agent != "qwen" {
		t.Fatalf("record agent = %q, want qwen restored even when configured agent is opencode", result.Record.Agent)
	}
	if len(result.Events) != 4 {
		t.Fatalf("events len = %d, want restored turn boundary and message events: %#v", len(result.Events), result.Events)
	}
	for _, event := range result.Events {
		if event.TaskID != "acpx-ui-task" {
			t.Fatalf("event task id = %q, want acpx-ui-task: %#v", event.TaskID, result.Events)
		}
	}
	if taskEventOfType(result.Events, "task.started").EventType == "" || taskEventOfType(result.Events, "task.completed").EventType == "" {
		t.Fatalf("events missing restored run boundary events: %#v", result.Events)
	}
	if got := d.history["acpx-ui-task"]; got.TaskID != "acpx-ui-task" || len(got.Events) != 4 {
		t.Fatalf("cached alias record = %#v, want restored history cached under ui task id", got)
	}
}

func TestTaskHistoryMergesRestoredACPXRecordWithExistingTurnEvents(t *testing.T) {
	defaultDir := t.TempDir()
	projectDir := t.TempDir()
	scriptPath := filepath.Join(defaultDir, "fake-acpx")
	script := `#!/bin/sh
case "$*" in
  *" qwen sessions list "*)
    printf '[{"acpxRecordId":"rec-old","name":"acpx-ui-task","cwd":"%s","createdAt":"2026-01-01T00:00:00Z","lastUsedAt":"2026-01-01T00:00:10Z","messages":[{"User":{"content":[{"Text":"old prompt"}]}},{"Agent":{"content":[{"Text":"old answer"}]}}]}]' "$PWD"
    ;;
  *" sessions list "*)
    printf '[]'
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
	cfg.Workspaces = []protocol.Workspace{{ID: "default", Path: defaultDir}, {ID: "project", Path: projectDir}}
	cfg.ACPX.Enabled = true
	cfg.ACPX.Command = scriptPath
	cfg.ACPX.Args = []string{"--project-dir", projectDir}
	cfg.ACPX.TTLSeconds = 0
	cfg.ACPX.Agent = "opencode"
	d := New(cfg)

	d.mu.Lock()
	d.history["acpx-ui-task"] = protocol.TaskRecord{
		TaskID:        "acpx-ui-task",
		WorkspacePath: projectDir,
		AgentRuntime:  "acpx",
		Prompt:        "new prompt",
		Status:        "running",
		UpdatedAt:     20,
		Events: []protocol.TaskEvent{
			userPromptTaskEvent("acpx-ui-task", "turn-new", "new prompt", 20, 1, 0),
		},
	}
	d.mu.Unlock()

	d.sendTaskHistory(protocol.TaskHistoryGet{RequestID: "req-1", TaskID: "acpx-ui-task", WorkspacePath: projectDir})
	env := <-d.send
	if env.Type != protocol.TypeTaskHistoryResult {
		t.Fatalf("env type = %q, want task.history.result", env.Type)
	}
	result, err := protocol.DecodePayload[protocol.TaskHistoryResult](env)
	if err != nil {
		t.Fatalf("decode history result: %v", err)
	}
	if result.Record == nil {
		t.Fatal("record is nil, want merged history")
	}
	var prompts []string
	for _, event := range result.Events {
		if event.EventType != "user.prompt" {
			continue
		}
		var data map[string]any
		if err := json.Unmarshal(event.Data, &data); err != nil {
			t.Fatalf("decode prompt data: %v", err)
		}
		prompts = append(prompts, stringField(data, "prompt"))
	}
	if !containsString(prompts, "old prompt") || !containsString(prompts, "new prompt") {
		t.Fatalf("prompts = %#v, want restored old prompt and existing new prompt; events=%#v", prompts, result.Events)
	}
	for _, event := range result.Events {
		if event.EventType != "user.prompt" {
			continue
		}
		var data map[string]any
		if err := json.Unmarshal(event.Data, &data); err != nil {
			t.Fatalf("decode prompt data: %v", err)
		}
		if data["prompt"] == "new prompt" && data["acpx_event_key"] != "turn:1:user.prompt:0" {
			t.Fatalf("new prompt key = %#v, want turn:1:user.prompt:0; data=%#v events=%#v", data["acpx_event_key"], data, result.Events)
		}
	}
	if taskEventOfType(result.Events, "task.completed").EventType == "" {
		t.Fatalf("events missing restored task.completed for historical turn: %#v", result.Events)
	}
	if got := d.history["acpx-ui-task"]; len(got.Events) < 5 {
		t.Fatalf("cached history events = %d, want restored + existing events: %#v", len(got.Events), got.Events)
	}
}

func TestTaskHistoryRestoresClaudeACPXAssistantFromLocalStore(t *testing.T) {
	defaultDir := t.TempDir()
	projectDir := t.TempDir()
	t.Setenv("POCKET_STUDIO_DAEMON_CONFIG_DIR", defaultDir)
	scriptPath := filepath.Join(defaultDir, "fake-acpx")
	script := `#!/bin/sh
case "$*" in
  *" claude sessions list "*)
    printf '[{"acpxRecordId":"rec-claude","name":"acpx-ui-task","cwd":"%s","createdAt":"2026-01-01T00:00:00Z","lastUsedAt":"2026-01-01T00:00:10Z","messages":[{"User":{"content":[{"Text":"hello"}]}}]}]' "$PWD"
    ;;
  *" sessions list "*)
    printf '[]'
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
	cfg.Workspaces = []protocol.Workspace{{ID: "default", Path: defaultDir}, {ID: "project", Path: projectDir}}
	cfg.ACPX.Enabled = true
	cfg.ACPX.Command = scriptPath
	cfg.ACPX.Args = []string{"--project-dir", projectDir}
	cfg.ACPX.TTLSeconds = 0
	cfg.ACPX.Agent = "claude"

	live := New(cfg)
	live.mu.Lock()
	live.history["rec-claude"] = protocol.TaskRecord{
		TaskID:        "rec-claude",
		DeviceID:      "device-1",
		WorkspacePath: projectDir,
		Agent:         "claude",
		AgentRuntime:  "acpx",
		SessionName:   "acpx-ui-task",
		SessionID:     "rec-claude",
		Prompt:        "hello",
		Status:        "running",
		StartedAt:     100,
		UpdatedAt:     110,
		Events: []protocol.TaskEvent{
			userPromptTaskEvent("rec-claude", "turn-1", "hello", 100, 1, 0),
			{
				TaskID:    "rec-claude",
				EventID:   "evt-assistant",
				EventType: "assistant.message",
				Source:    "claude_code",
				Sequence:  2,
				Timestamp: 105,
				Data:      json.RawMessage(`{"text":"claude answer","acpx_turn_index":0,"acpx_event_key":"turn:0:assistant.message:0"}`),
			},
		},
	}
	if err := live.saveACPXHistoryStoreLocked(); err != nil {
		t.Fatalf("saveACPXHistoryStoreLocked() error = %v", err)
	}
	live.mu.Unlock()

	restored := New(cfg)
	if err := restored.loadACPXHistoryStore(); err != nil {
		t.Fatalf("loadACPXHistoryStore() error = %v", err)
	}
	restored.sendTaskHistory(protocol.TaskHistoryGet{RequestID: "req-1", TaskID: "rec-claude", WorkspacePath: projectDir})
	env := <-restored.send
	if env.Type != protocol.TypeTaskHistoryResult {
		t.Fatalf("env type = %q, want task.history.result", env.Type)
	}
	result, err := protocol.DecodePayload[protocol.TaskHistoryResult](env)
	if err != nil {
		t.Fatalf("decode history result: %v", err)
	}
	if result.Record == nil {
		t.Fatal("record is nil, want restored Claude history")
	}
	message := taskEventOfType(result.Events, "assistant.message")
	if message.EventType == "" {
		t.Fatalf("missing restored assistant message: %#v", result.Events)
	}
	var data map[string]any
	if err := json.Unmarshal(message.Data, &data); err != nil {
		t.Fatalf("decode assistant data: %v", err)
	}
	if data["text"] != "claude answer" {
		t.Fatalf("assistant data = %#v, want claude answer", data)
	}
	if result.Record.Status != "interrupted" {
		t.Fatalf("record status = %q, want interrupted from local store", result.Record.Status)
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

func TestMergeTaskEventsDeduplicatesRestoredACPXEventsByStableKey(t *testing.T) {
	base := []protocol.TaskEvent{
		{
			TaskID:    "task-1",
			EventID:   "history-start",
			EventType: "task.started",
			Source:    "acpx",
			Sequence:  1,
			Data:      json.RawMessage(`{"source":"acpx.history","turn_id":"history-turn-0","acpx_turn_index":0,"acpx_event_key":"turn:0:task.started:0"}`),
		},
		{
			TaskID:    "task-1",
			EventID:   "history-user",
			EventType: "user.prompt",
			Source:    "acpx",
			Sequence:  2,
			Data:      json.RawMessage(`{"prompt":"你好","turn_id":"history-turn-0","acpx_turn_index":0,"acpx_event_key":"turn:0:user.prompt:0"}`),
		},
		{
			TaskID:    "task-1",
			EventID:   "history-assistant",
			EventType: "assistant.message",
			Source:    "acpx",
			Sequence:  3,
			Data:      json.RawMessage(`{"text":"你好，有什么可以帮你？","acpx_turn_index":0,"acpx_event_key":"turn:0:assistant.message:0"}`),
		},
		{
			TaskID:    "task-1",
			EventID:   "history-done",
			EventType: "task.completed",
			Source:    "acpx",
			Sequence:  4,
			Data:      json.RawMessage(`{"exit_code":0,"stop_reason":"history","turn_id":"history-turn-0","acpx_turn_index":0,"acpx_event_key":"turn:0:task.completed:0"}`),
		},
	}
	extra := []protocol.TaskEvent{
		{
			TaskID:    "task-1",
			EventID:   "live-user",
			EventType: "user.prompt",
			Source:    "web",
			Sequence:  5,
			Data:      json.RawMessage(`{"prompt":"你好","turn_id":"turn-live","acpx_turn_index":0,"acpx_event_key":"turn:0:user.prompt:0"}`),
		},
		{
			TaskID:    "task-1",
			EventID:   "live-start",
			EventType: "task.started",
			Source:    "claude_code",
			Sequence:  6,
			Data:      json.RawMessage(`{"turn_id":"turn-live","_seq":6,"_ts":100,"acpx_turn_index":0,"acpx_event_key":"turn:0:task.started:0"}`),
		},
		{
			TaskID:    "task-1",
			EventID:   "live-assistant",
			EventType: "assistant.message",
			Source:    "claude_code",
			Sequence:  7,
			Data:      json.RawMessage(`{"text":"你好，有什么可以帮你？","stream_id":"stream-1","replace":true,"_seq":7,"_ts":101,"acpx_turn_index":0,"acpx_event_key":"turn:0:assistant.message:0"}`),
		},
		{
			TaskID:    "task-1",
			EventID:   "live-done",
			EventType: "task.completed",
			Source:    "claude_code",
			Sequence:  8,
			Data:      json.RawMessage(`{"exit_code":0,"stop_reason":"end_turn","_seq":8,"_ts":102,"acpx_turn_index":0,"acpx_event_key":"turn:0:task.completed:0"}`),
		},
	}

	merged := mergeTaskEvents(base, extra)
	if len(merged) != len(base) {
		t.Fatalf("merged events = %#v, want only restored turn", merged)
	}
	for i, event := range merged {
		if event.EventID != base[i].EventID {
			t.Fatalf("merged[%d] = %q, want %q; events=%#v", i, event.EventID, base[i].EventID, merged)
		}
	}
}

func TestMergeTaskEventsKeepsRepeatedACPXPromptTurnsWithDifferentStableKeys(t *testing.T) {
	base := []protocol.TaskEvent{
		{
			TaskID:    "task-1",
			EventID:   "history-user-0",
			EventType: "user.prompt",
			Sequence:  1,
			Data:      json.RawMessage(`{"prompt":"你好","acpx_turn_index":0,"acpx_event_key":"turn:0:user.prompt:0"}`),
		},
		{
			TaskID:    "task-1",
			EventID:   "history-assistant-0",
			EventType: "assistant.message",
			Sequence:  2,
			Data:      json.RawMessage(`{"text":"你好！","acpx_turn_index":0,"acpx_event_key":"turn:0:assistant.message:0"}`),
		},
	}
	extra := []protocol.TaskEvent{
		{
			TaskID:    "task-1",
			EventID:   "history-user-1",
			EventType: "user.prompt",
			Sequence:  3,
			Data:      json.RawMessage(`{"prompt":"你好","acpx_turn_index":1,"acpx_event_key":"turn:1:user.prompt:0"}`),
		},
		{
			TaskID:    "task-1",
			EventID:   "history-assistant-1",
			EventType: "assistant.message",
			Sequence:  4,
			Data:      json.RawMessage(`{"text":"你好！","acpx_turn_index":1,"acpx_event_key":"turn:1:assistant.message:0"}`),
		},
	}

	merged := mergeTaskEvents(base, extra)
	if len(merged) != 4 {
		t.Fatalf("merged events = %#v, want both repeated prompt turns", merged)
	}
}

func TestOrderTaskEventsUsesACPXTurnStructureBeforeTimestamps(t *testing.T) {
	events := []protocol.TaskEvent{
		{
			TaskID:    "task-1",
			EventID:   "assistant-first-by-time",
			EventType: "assistant.message",
			Sequence:  1,
			Timestamp: 100,
			Data:      json.RawMessage(`{"text":"answer","acpx_turn_index":0,"acpx_event_key":"turn:0:assistant.message:0"}`),
		},
		{
			TaskID:    "task-1",
			EventID:   "completed-earliest-by-time",
			EventType: "task.completed",
			Sequence:  2,
			Timestamp: 50,
			Data:      json.RawMessage(`{"exit_code":0,"acpx_turn_index":0,"acpx_event_key":"turn:0:task.completed:0"}`),
		},
		{
			TaskID:    "task-1",
			EventID:   "user-latest-by-time",
			EventType: "user.prompt",
			Sequence:  3,
			Timestamp: 200,
			Data:      json.RawMessage(`{"prompt":"hello","acpx_turn_index":0,"acpx_event_key":"turn:0:user.prompt:0"}`),
		},
		{
			TaskID:    "task-1",
			EventID:   "started-last-by-sequence",
			EventType: "task.started",
			Sequence:  4,
			Timestamp: 150,
			Data:      json.RawMessage(`{"acpx_turn_index":0,"acpx_event_key":"turn:0:task.started:0"}`),
		},
	}

	ordered := orderTaskEvents(events)
	wantTypes := []string{"task.started", "user.prompt", "assistant.message", "task.completed"}
	for i, want := range wantTypes {
		if ordered[i].EventType != want {
			t.Fatalf("ordered[%d] = %q, want %q; events=%#v", i, ordered[i].EventType, want, ordered)
		}
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

func containsString(values []string, needle string) bool {
	for _, value := range values {
		if value == needle {
			return true
		}
	}
	return false
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
