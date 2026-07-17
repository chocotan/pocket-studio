package daemon

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"remote-agent/internal/protocol"
)

func TestDirectACPSessionListParsesFieldVariants(t *testing.T) {
	raw := json.RawMessage(`{"result":{"sessions":[
		{"sessionId":"camel","cwd":"/work","title":"Camel","updatedAt":"2026-07-16T10:00:00Z"},
		{"session_id":"snake","updated_at":"2026-07-15T10:00:00Z"},
		{"id":"fallback"},
		{"title":"missing id"}
	],"next_cursor":"next"}}`)

	items, cursor := directACPSessionList(raw)
	if cursor != "next" {
		t.Fatalf("cursor = %q, want next", cursor)
	}
	if len(items) != 3 {
		t.Fatalf("items = %#v, want 3 valid sessions", items)
	}
	if items[0].SessionID != "camel" || items[0].CWD != "/work" || items[0].Title != "Camel" || items[0].UpdatedAt != "2026-07-16T10:00:00Z" {
		t.Fatalf("camel session = %#v", items[0])
	}
	if items[1].SessionID != "snake" || items[1].UpdatedAt != "2026-07-15T10:00:00Z" {
		t.Fatalf("snake session = %#v", items[1])
	}
	if items[2].SessionID != "fallback" {
		t.Fatalf("fallback session = %#v", items[2])
	}
}

func TestDirectACPSessionListParamsOmitsEmptyCursor(t *testing.T) {
	params := directACPSessionListParams("/work", "  ")
	if params["cwd"] != "/work" {
		t.Fatalf("cwd = %#v", params["cwd"])
	}
	if _, exists := params["cursor"]; exists {
		t.Fatalf("empty cursor must be omitted: %#v", params)
	}
	params = directACPSessionListParams("/work", " next ")
	if params["cursor"] != "next" {
		t.Fatalf("cursor = %#v, want next", params["cursor"])
	}
}

func TestHasPersistedConversationEvents(t *testing.T) {
	d := New(Config{})
	d.history["metadata-only"] = protocol.TaskRecord{Events: []protocol.TaskEvent{{EventType: "model.list"}}}
	if d.hasPersistedConversationEvents("metadata-only") {
		t.Fatal("metadata-only task reported persisted conversation")
	}
	d.history["with-message"] = protocol.TaskRecord{Events: []protocol.TaskEvent{{EventType: "assistant.message"}}}
	if !d.hasPersistedConversationEvents("with-message") {
		t.Fatal("assistant message was not recognized as persisted conversation")
	}
}

func TestDirectACPSessionListCapabilityVariants(t *testing.T) {
	for name, raw := range map[string]json.RawMessage{
		"camel": json.RawMessage(`{"result":{"agentCapabilities":{"sessionCapabilities":{"list":true}}}}`),
		"snake": json.RawMessage(`{"agent_capabilities":{"session_capabilities":{"list":"true"}}}`),
	} {
		t.Run(name, func(t *testing.T) {
			if !directACPCapabilitiesFromInitialize(raw).List {
				t.Fatalf("list capability not detected from %s", raw)
			}
		})
	}
	if directACPCapabilitiesFromInitialize(json.RawMessage(`{"result":{"agentCapabilities":{}}}`)).List {
		t.Fatal("missing list capability reported as supported")
	}
}

func TestImportedHistoryUserChunkBuildsPocketPrompt(t *testing.T) {
	var text strings.Builder
	var msg map[string]any
	if err := json.Unmarshal([]byte(`{"jsonrpc":"2.0","method":"session/update","params":{"update":{"sessionUpdate":"user_message_chunk","content":{"type":"text","text":"hello "}}}}`), &msg); err != nil {
		t.Fatal(err)
	}
	if !importedHistoryUserChunk(msg, &text) {
		t.Fatal("user history chunk was not recognized")
	}
	if err := json.Unmarshal([]byte(`{"jsonrpc":"2.0","method":"session/update","params":{"update":{"sessionUpdate":"user_message_chunk","content":{"type":"text","text":"world"}}}}`), &msg); err != nil {
		t.Fatal(err)
	}
	if !importedHistoryUserChunk(msg, &text) || text.String() != "hello world" {
		t.Fatalf("imported prompt = %q, want hello world", text.String())
	}
	if importedHistoryUserChunk(map[string]any{"method": "session/update", "params": map[string]any{"update": map[string]any{"sessionUpdate": "agent_message_chunk"}}}, &text) {
		t.Fatal("assistant chunk recognized as imported user history")
	}
}

func TestDirectACPSessionIDIgnoresJSONRPCRequestID(t *testing.T) {
	if got := directACPSessionID(json.RawMessage(`{"jsonrpc":"2.0","id":"2","result":{"models":{}}}`)); got != "" {
		t.Fatalf("session ID = %q, want empty when only JSON-RPC request id exists", got)
	}
	if got := directACPSessionID(json.RawMessage(`{"jsonrpc":"2.0","id":"2","result":{"sessionId":"provider-session"}}`)); got != "provider-session" {
		t.Fatalf("session ID = %q, want provider-session", got)
	}
}

func TestEmitOpenCodeExportHistoryImportsUserAndAssistantText(t *testing.T) {
	d := New(Config{})
	emitter := &taskEmitter{daemon: d, taskID: "task-history"}
	raw := []byte(`{"messages":[
		{"info":{"role":"user"},"parts":[{"type":"text","text":"question"}]},
		{"info":{"role":"assistant"},"parts":[{"type":"reasoning","text":"think"},{"type":"step-start"},{"type":"text","text":"first"}]},
		{"info":{"role":"assistant"},"parts":[{"type":"tool","tool":"bash","callID":"call-1","state":{"status":"completed","title":"Run command","input":{"command":"pwd"},"output":"/work"}}]},
		{"info":{"role":"assistant"},"parts":[{"type":"text","text":"second"},{"type":"tool","tool":"bash"}]}
	]}`)
	if err := emitOpenCodeExportHistory(emitter, raw); err != nil {
		t.Fatal(err)
	}
	events := d.history["task-history"].Events
	if len(events) != 7 {
		t.Fatalf("events = %#v, want 7", events)
	}
	if events[0].EventType != "user.prompt" || textFieldFromEventJSON(events[0].Data, "prompt") != "question" {
		t.Fatalf("user event = %#v", events[0])
	}
	if events[1].EventType != "assistant.thinking" || textFieldFromEventJSON(events[1].Data, "text") != "think" {
		t.Fatalf("thinking event = %#v", events[1])
	}
	if events[2].EventType != "assistant.message" || textFieldFromEventJSON(events[2].Data, "text") != "first" {
		t.Fatalf("first assistant event = %#v", events[2])
	}
	if events[3].EventType != "tool.call" || events[4].EventType != "tool.output" {
		t.Fatalf("tool events = %#v %#v", events[3], events[4])
	}
	if events[5].EventType != "assistant.message" || textFieldFromEventJSON(events[5].Data, "text") != "second" {
		t.Fatalf("second assistant event = %#v", events[5])
	}
}

func TestDirectACPReaderSuppressesSplitPiStartupInfoAndKeepsSuffix(t *testing.T) {
	d := New(Config{})
	const taskID = "direct-startup-info"
	d.history[taskID] = protocol.TaskRecord{TaskID: taskID, AgentRuntime: "direct_acp"}
	client := &directACPClient{
		cmd:     &exec.Cmd{Path: "fake-pi-acp"},
		emitter: &taskEmitter{daemon: d, taskID: taskID},
	}
	output := strings.Join([]string{
		`{"jsonrpc":"2.0","id":1,"result":{"sessionId":"session-1","_meta":{"piAcp":{"startupInfo":"Pi startup\n"}}}}`,
		`{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"session-1","update":{"sessionUpdate":"agent_message_chunk","content":{"text":"Pi star"}}}}`,
		`{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"session-1","update":{"sessionUpdate":"agent_message_chunk","content":{"text":"tup\nkept suffix"}}}}`,
	}, "\n") + "\n"

	client.readStdout(strings.NewReader(output))

	messages := taskEventsOfType(d.history[taskID].Events, "assistant.message")
	if len(messages) != 1 || taskEventData(t, messages[0])["text"] != "kept suffix" {
		t.Fatalf("assistant messages = %#v, want only kept suffix", messages)
	}
}

func TestDirectACPSessionPromptEmitsAssistantMessage(t *testing.T) {
	dir := t.TempDir()
	scriptPath := filepath.Join(dir, "fake-direct-acp")
	script := `#!/bin/sh
node -e '
const readline = require("readline");
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.method === "initialize") {
    console.log(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "1" } }));
  } else if (msg.method === "session/new") {
    console.log(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "fake-session" } }));
  } else if (msg.method === "session/prompt") {
    console.log(JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hello direct acp" } } } }));
    console.log(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } }));
  }
});
'
`
	if err := os.WriteFile(scriptPath, []byte(script), 0o755); err != nil {
		t.Fatalf("write fake direct acp: %v", err)
	}

	cfg := DefaultConfig()
	cfg.DirectACP.Enabled = true
	cfg.DirectACP.Agents = map[string]DirectACPAgentConfig{
		"codex": {Command: scriptPath},
	}
	d := New(cfg)

	task := protocol.TaskDispatch{
		TaskID:        "task-1",
		WorkspacePath: dir,
		Agent:         "codex",
		AgentRuntime:  "direct_acp",
		SessionName:   "task-1",
		Prompt:        "say hello",
	}
	d.startDirectACPTask(context.Background(), task, protocol.Workspace{ID: "w", Path: dir})
	defer d.deleteDirectACPSession("task-1")

	got := drainTaskEvents(d.send)
	if !hasTaskEvent(got, "user.prompt") {
		t.Fatalf("direct ACP events missing user.prompt: %#v", got)
	}
	if !hasTaskEvent(got, "assistant.message") {
		t.Fatalf("direct ACP events missing assistant.message: %#v", got)
	}
	if !hasTaskEvent(got, "turn.completed") {
		t.Fatalf("direct ACP events missing turn.completed: %#v", got)
	}
	record := d.history["task-1"]
	if !historyHasUserPrompt(record.Events, "say hello") {
		t.Fatalf("history missing persisted user prompt: %#v", record.Events)
	}
}

func TestDirectACPPromptContentIncludesWorkspaceImage(t *testing.T) {
	dir := t.TempDir()
	imageData := []byte("\x89PNG\r\n\x1a\nimage")
	if err := os.WriteFile(filepath.Join(dir, "pasted.png"), imageData, 0o644); err != nil {
		t.Fatal(err)
	}
	client := &directACPClient{workspace: dir}
	prompt, err := directACPPromptContent(client, protocol.TaskDispatch{
		Prompt: "describe this",
		Attachments: []protocol.TaskAttachment{{
			Type: "image", Name: "pasted.png", Path: "pasted.png", MimeType: "image/png",
		}},
	})
	if err != nil {
		t.Fatalf("directACPPromptContent() error = %v", err)
	}
	if len(prompt) != 2 || prompt[0]["type"] != "text" || prompt[0]["text"] != "describe this" {
		t.Fatalf("prompt text block = %#v", prompt)
	}
	if prompt[1]["type"] != "image" || prompt[1]["mimeType"] != "image/png" {
		t.Fatalf("prompt image block = %#v", prompt[1])
	}
	wantData := base64.StdEncoding.EncodeToString(imageData)
	if prompt[1]["data"] != wantData {
		t.Fatalf("prompt image data = %q, want %q", prompt[1]["data"], wantData)
	}
}

func TestDirectACPPromptContentRejectsImageSymlinkOutsideWorkspace(t *testing.T) {
	dir := t.TempDir()
	outside := filepath.Join(t.TempDir(), "outside.png")
	if err := os.WriteFile(outside, []byte("image"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(dir, "linked.png")); err != nil {
		t.Fatal(err)
	}
	client := &directACPClient{workspace: dir}
	_, err := directACPPromptContent(client, protocol.TaskDispatch{
		Attachments: []protocol.TaskAttachment{{Type: "image", Path: "linked.png", MimeType: "image/png"}},
	})
	if err == nil || !strings.Contains(err.Error(), "outside workspace") {
		t.Fatalf("directACPPromptContent() error = %v, want outside workspace", err)
	}
}

func TestDeleteDirectACPSessionFlushesCloseBeforeProcessExit(t *testing.T) {
	dir := t.TempDir()
	logPath := filepath.Join(dir, "close.log")
	scriptPath := filepath.Join(dir, "fake-direct-acp-close")
	script := `#!/bin/sh
node -e '
const fs = require("fs");
const readline = require("readline");
const rl = readline.createInterface({ input: process.stdin });
rl.on("close", () => fs.appendFileSync(process.env.ACP_CLOSE_LOG, "eof\n"));
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  const kind = msg.id === undefined ? "notify" : "request";
  fs.appendFileSync(process.env.ACP_CLOSE_LOG, String(msg.method || "") + ":" + kind + "\n");
  if (msg.id !== undefined) {
    console.log(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: {} }));
  }
});
'
`
	if err := os.WriteFile(scriptPath, []byte(script), 0o755); err != nil {
		t.Fatalf("write fake direct acp: %v", err)
	}

	d := New(DefaultConfig())
	client, err := startDirectACPClient(context.Background(), DirectACPAgentConfig{
		Command: scriptPath,
		Env:     map[string]string{"ACP_CLOSE_LOG": logPath},
	}, dir, &taskEmitter{daemon: d, taskID: "task-close"})
	if err != nil {
		t.Fatalf("startDirectACPClient() error = %v", err)
	}
	client.session = "session-close"
	d.directACP["task-close"] = &directACPSession{taskID: "task-close", client: client}
	d.history["task-close"] = protocol.TaskRecord{TaskID: "task-close", AgentRuntime: "direct_acp"}

	if !d.deleteDirectACPSession("task-close") {
		t.Fatal("deleteDirectACPSession() = false")
	}
	var closeWG sync.WaitGroup
	closeWG.Add(2)
	for range 2 {
		go func() {
			defer closeWG.Done()
			client.close()
		}()
	}
	closeWG.Wait()
	raw, err := os.ReadFile(logPath)
	if err != nil {
		t.Fatalf("read close log: %v", err)
	}
	if got, want := string(raw), "session/cancel:notify\nsession/close:request\neof\n"; got != want {
		t.Fatalf("close notifications = %q, want %q", got, want)
	}
	if d.directACP["task-close"] != nil {
		t.Fatal("direct ACP session still registered after delete")
	}
	if _, ok := d.history["task-close"]; ok {
		t.Fatal("direct ACP history still registered after delete")
	}
}

func TestDirectACPHistoryPersistsAndLoadsInterrupted(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("POCKET_STUDIO_DAEMON_CONFIG_DIR", dir)
	cfg := DefaultConfig()
	cfg.Device.ID = "device-1"
	d := New(cfg)

	event := protocol.TaskEvent{
		TaskID:    "task-1",
		EventID:   "evt-1",
		EventType: "assistant.message",
		Sequence:  1,
		Timestamp: 123,
	}
	d.mu.Lock()
	d.history["task-1"] = protocol.TaskRecord{
		TaskID:        "task-1",
		DeviceID:      "device-1",
		WorkspacePath: dir,
		Agent:         "opencode",
		AgentRuntime:  "direct_acp",
		SessionName:   "task-1",
		SessionID:     "agent-session-1",
		Status:        "running",
		StartedAt:     100,
		UpdatedAt:     120,
		Events:        []protocol.TaskEvent{event},
	}
	if err := d.saveDirectACPStoreLocked(); err != nil {
		t.Fatalf("saveDirectACPStoreLocked() error = %v", err)
	}
	d.mu.Unlock()

	restored := New(cfg)
	if err := restored.loadDirectACPStore(); err != nil {
		t.Fatalf("loadDirectACPStore() error = %v", err)
	}
	record := restored.history["task-1"]
	if record.TaskID != "task-1" || record.SessionID != "agent-session-1" {
		t.Fatalf("restored record = %#v, want persisted direct ACP task", record)
	}
	if record.Status != "interrupted" {
		t.Fatalf("restored status = %q, want interrupted", record.Status)
	}
	if len(record.Events) != 2 || record.Events[0].EventID != "evt-1" || record.Events[1].EventType != "task.failed" {
		t.Fatalf("restored events = %#v, want persisted event followed by restart interruption", record.Events)
	}
	interruptedData := taskEventData(t, record.Events[1])
	if interruptedData["reason"] != "interrupted" {
		t.Fatalf("restart terminal data = %#v, want interrupted reason", interruptedData)
	}

	raw, err := os.ReadFile(daemonDirectACPSessionsPath())
	if err != nil {
		t.Fatalf("read direct ACP store: %v", err)
	}
	var store directACPStore
	if err := json.Unmarshal(raw, &store); err != nil {
		t.Fatalf("decode direct ACP store: %v", err)
	}
	if len(store.Tasks) != 1 || store.Tasks[0].Status != "interrupted" {
		t.Fatalf("stored tasks = %#v, want interrupted direct ACP task", store.Tasks)
	}
	if taskEventOfType(store.Tasks[0].Events, "task.failed").EventType == "" {
		t.Fatalf("stored interrupted task missing terminal event: %#v", store.Tasks[0].Events)
	}
}

func TestDirectACPRestoresWithResumeCapability(t *testing.T) {
	dir := t.TempDir()
	orderPath := filepath.Join(dir, "restore-order")
	scriptPath := filepath.Join(dir, "fake-direct-acp-resume")
	script := `#!/bin/sh
node -e '
const fs = require("fs");
const readline = require("readline");
const orderPath = process.env.ACP_ORDER_PATH;
const rl = readline.createInterface({ input: process.stdin });
function record(value) { fs.appendFileSync(orderPath, value + "\n"); }
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.method === "initialize") {
    console.log(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: {
      protocolVersion: 1,
      agentCapabilities: { sessionCapabilities: { resume: true } }
    } }));
  } else if (msg.method === "session/resume") {
    record("resume:" + msg.params.sessionId);
    console.log(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { sessionId: msg.params.sessionId } }));
  } else if (msg.method === "session/new") {
    record("new");
    console.log(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "new-session" } }));
  }
});
'
`
	if err := os.WriteFile(scriptPath, []byte(script), 0o755); err != nil {
		t.Fatalf("write fake direct acp: %v", err)
	}

	cfg := DefaultConfig()
	cfg.DirectACP.Enabled = true
	cfg.DirectACP.Agents = map[string]DirectACPAgentConfig{
		"opencode": {Command: scriptPath, Env: map[string]string{"ACP_ORDER_PATH": orderPath}},
	}
	d := New(cfg)
	d.history["task-1"] = protocol.TaskRecord{
		TaskID:        "task-1",
		WorkspacePath: dir,
		Agent:         "opencode",
		AgentRuntime:  "direct_acp",
		SessionName:   "task-1",
		SessionID:     "old-session",
	}

	task := protocol.TaskDispatch{
		TaskID:        "task-1",
		WorkspacePath: dir,
		Agent:         "opencode",
		AgentRuntime:  "direct_acp",
		SessionName:   "task-1",
	}
	if err := d.createDirectACPSession(context.Background(), task, dir, task.TaskID); err != nil {
		t.Fatalf("createDirectACPSession() error = %v", err)
	}
	defer d.deleteDirectACPSession("task-1")

	raw, err := os.ReadFile(orderPath)
	if err != nil {
		t.Fatalf("read restore order: %v", err)
	}
	if got, want := string(raw), "resume:old-session\n"; got != want {
		t.Fatalf("direct ACP restore calls = %q, want %q", got, want)
	}
}

func TestDirectACPResumeDoesNotImportProviderHistoryIntoTimeline(t *testing.T) {
	dir := t.TempDir()
	scriptPath := filepath.Join(dir, "fake-direct-acp-history-replay")
	script := `#!/bin/sh
node -e '
const readline = require("readline");
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.method === "initialize") {
    console.log(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: {
      protocolVersion: 1,
      agentCapabilities: { sessionCapabilities: { resume: true } }
    } }));
  } else if (msg.method === "session/resume") {
    console.log(JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: {
      sessionId: msg.params.sessionId,
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "provider history must stay hidden" } }
    } }));
    console.log(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { sessionId: msg.params.sessionId } }));
  }
});
'
`
	if err := os.WriteFile(scriptPath, []byte(script), 0o755); err != nil {
		t.Fatalf("write fake direct acp: %v", err)
	}

	cfg := DefaultConfig()
	cfg.DirectACP.Enabled = true
	cfg.DirectACP.Agents = map[string]DirectACPAgentConfig{"opencode": {Command: scriptPath}}
	d := New(cfg)
	original := protocol.TaskEvent{TaskID: "task-1", EventID: "saved", EventType: "assistant.message", Data: json.RawMessage(`{"text":"saved timeline"}`)}
	d.history["task-1"] = protocol.TaskRecord{
		TaskID: "task-1", WorkspacePath: dir, Agent: "opencode", AgentRuntime: "direct_acp",
		SessionName: "task-1", SessionID: "provider-session", Events: []protocol.TaskEvent{original},
	}
	task := protocol.TaskDispatch{TaskID: "task-1", WorkspacePath: dir, Agent: "opencode", AgentRuntime: "direct_acp", SessionName: "task-1"}
	if err := d.createDirectACPSession(context.Background(), task, dir, task.TaskID); err != nil {
		t.Fatalf("createDirectACPSession() error = %v", err)
	}
	defer d.deleteDirectACPSession("task-1")

	messages := taskEventsOfType(d.history["task-1"].Events, "assistant.message")
	if len(messages) != 1 || messages[0].EventID != original.EventID || textFieldFromEventJSON(messages[0].Data, "text") != "saved timeline" {
		t.Fatalf("provider history changed Pocket Studio messages: %#v", messages)
	}
}

func TestRestoreInterruptedDirectACPUsesPromptTurnWithoutToolIndex(t *testing.T) {
	record := protocol.TaskRecord{
		TaskID: "task-1", AgentRuntime: "direct_acp", Status: "running",
		Events: []protocol.TaskEvent{
			{EventType: "user.prompt", Sequence: 1, Data: json.RawMessage(`{"prompt":"disk","turn_id":"direct-turn-0"}`)},
			{EventType: "task.started", Sequence: 7, Data: json.RawMessage(`{"_seq":4,"turn_id":"direct-turn-0"}`)},
			{EventType: "tool.call", Sequence: 10, Data: json.RawMessage(`{"_seq":7,"acpx_turn_index":0,"acpx_event_key":"turn:0:tool.call:tool-1"}`)},
		},
	}

	restored, changed := restoreInterruptedTaskRecord(record)
	if !changed || len(restored.Events) != 4 {
		t.Fatalf("restore result = %#v, changed=%v", restored, changed)
	}
	data := taskEventData(t, restored.Events[3])
	if data["turn_id"] != "direct-turn-0" {
		t.Fatalf("Direct restore turn_id = %#v, want direct-turn-0", data["turn_id"])
	}
	if _, ok := data["acpx_turn_index"]; ok {
		t.Fatalf("Direct restore inherited tool index: %#v", data)
	}
	if _, ok := data["acpx_event_key"]; ok {
		t.Fatalf("Direct restore inherited ACPX key: %#v", data)
	}
}

func TestDirectACPIgnoresTaskIDResumeSessionIDWhenRestoring(t *testing.T) {
	dir := t.TempDir()
	orderPath := filepath.Join(dir, "restore-order")
	scriptPath := filepath.Join(dir, "fake-direct-acp-resume-task-id")
	script := `#!/bin/sh
node -e '
const fs = require("fs");
const readline = require("readline");
const orderPath = process.env.ACP_ORDER_PATH;
const rl = readline.createInterface({ input: process.stdin });
function record(value) { fs.appendFileSync(orderPath, value + "\n"); }
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.method === "initialize") {
    console.log(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: {
      protocolVersion: 1,
      agentCapabilities: { sessionCapabilities: { resume: true } }
    } }));
  } else if (msg.method === "session/resume") {
    record("resume:" + msg.params.sessionId);
    console.log(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { sessionId: msg.params.sessionId } }));
  } else if (msg.method === "session/new") {
    record("new");
    console.log(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "new-session" } }));
  } else if (msg.method === "session/prompt") {
    record("prompt:" + msg.params.sessionId);
    console.log(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } }));
  }
});
'
`
	if err := os.WriteFile(scriptPath, []byte(script), 0o755); err != nil {
		t.Fatalf("write fake direct acp: %v", err)
	}

	cfg := DefaultConfig()
	cfg.DirectACP.Enabled = true
	cfg.DirectACP.Agents = map[string]DirectACPAgentConfig{
		"opencode": {Command: scriptPath, Env: map[string]string{"ACP_ORDER_PATH": orderPath}},
	}
	d := New(cfg)
	d.history["task-1"] = protocol.TaskRecord{
		TaskID:        "task-1",
		WorkspacePath: dir,
		Agent:         "opencode",
		AgentRuntime:  "direct_acp",
		SessionName:   "task-1",
		SessionID:     "old-session",
	}

	task := protocol.TaskDispatch{
		TaskID:          "task-1",
		WorkspacePath:   dir,
		Agent:           "opencode",
		AgentRuntime:    "direct_acp",
		SessionName:     "task-1",
		ResumeSessionID: "task-1",
		Prompt:          "continue",
	}
	d.startDirectACPTask(context.Background(), task, protocol.Workspace{ID: "w", Path: dir})
	defer d.deleteDirectACPSession("task-1")

	raw, err := os.ReadFile(orderPath)
	if err != nil {
		t.Fatalf("read restore order: %v", err)
	}
	if got, want := string(raw), "resume:old-session\nprompt:old-session\n"; got != want {
		t.Fatalf("direct ACP restore calls = %q, want %q", got, want)
	}
	if got := d.history["task-1"].SessionID; got != "old-session" {
		t.Fatalf("record SessionID = %q, want provider session id", got)
	}
}

func TestDirectACPSessionSurvivesCreateRequestContext(t *testing.T) {
	dir := t.TempDir()
	scriptPath := filepath.Join(dir, "fake-direct-acp-session")
	script := `#!/bin/sh
node -e '
const readline = require("readline");
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.method === "initialize") {
    console.log(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1 } }));
  } else if (msg.method === "session/new") {
    console.log(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "fake-session" } }));
  } else if (msg.method === "session/prompt") {
    console.log(JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "still alive" } } } }));
    console.log(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } }));
  }
});
'
`
	if err := os.WriteFile(scriptPath, []byte(script), 0o755); err != nil {
		t.Fatalf("write fake direct acp: %v", err)
	}

	cfg := DefaultConfig()
	cfg.DirectACP.Enabled = true
	cfg.DirectACP.Agents = map[string]DirectACPAgentConfig{
		"opencode": {Command: scriptPath},
	}
	d := New(cfg)

	createCtx, cancelCreate := context.WithCancel(context.Background())
	session := protocol.SessionCreate{
		TaskID:        "task-1",
		WorkspacePath: dir,
		Agent:         "opencode",
		AgentRuntime:  "direct_acp",
		SessionName:   "task-1",
	}
	d.createSession(createCtx, session)
	cancelCreate()

	task := protocol.TaskDispatch{
		TaskID:        "task-1",
		WorkspacePath: dir,
		Agent:         "opencode",
		AgentRuntime:  "direct_acp",
		SessionName:   "task-1",
		Prompt:        "say hello",
	}
	d.startDirectACPTask(context.Background(), task, protocol.Workspace{ID: "w", Path: dir})
	defer d.deleteDirectACPSession("task-1")

	got := drainTaskEvents(d.send)
	if !hasTaskEvent(got, "assistant.message") {
		t.Fatalf("direct ACP session did not survive create context cancellation: %#v", got)
	}
	if hasTaskEvent(got, "task.failed") {
		t.Fatalf("direct ACP task failed after create context cancellation: %#v", got)
	}
}

func TestDirectACPStartingSessionIsReportedAsRunning(t *testing.T) {
	cfg := DefaultConfig()
	d := New(cfg)

	start := &directACPStart{done: make(chan struct{})}
	d.mu.Lock()
	d.directACPStarts["task-1"] = start
	d.startingTasks["task-1"] = struct{}{}
	d.mu.Unlock()

	if got := d.runningTaskIDs(); !stringSliceContains(got, "task-1") {
		t.Fatalf("runningTaskIDs() = %#v, want starting direct ACP task", got)
	}

	d.mu.Lock()
	delete(d.directACPStarts, "task-1")
	delete(d.startingTasks, "task-1")
	d.mu.Unlock()

	if got := d.runningTaskIDs(); stringSliceContains(got, "task-1") {
		t.Fatalf("runningTaskIDs() = %#v, want starting task removed", got)
	}
}

func TestDirectACPDispatchSetsRequestedModelBeforePrompt(t *testing.T) {
	dir := t.TempDir()
	orderPath := filepath.Join(dir, "order")
	scriptPath := filepath.Join(dir, "fake-direct-acp-model")
	script := `#!/bin/sh
node -e '
const fs = require("fs");
const readline = require("readline");
const orderPath = process.env.ACP_ORDER_PATH;
const rl = readline.createInterface({ input: process.stdin });
function record(value) { fs.appendFileSync(orderPath, value + "\n"); }
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.method === "initialize") {
    console.log(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1 } }));
  } else if (msg.method === "session/new") {
    console.log(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: {
      sessionId: "fake-session",
      configOptions: [{ id: "model", type: "select", currentValue: "model-a", options: [{ value: "model-a", name: "A" }, { value: "model-b", name: "B" }] }]
    } }));
  } else if (msg.method === "session/set_config_option" || msg.method === "session/setConfigOption") {
    record("model:" + msg.params.value);
    console.log(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: {
      configOptions: [{ id: "model", type: "select", currentValue: msg.params.value, options: [{ value: "model-a", name: "A" }, { value: "model-b", name: "B" }] }]
    } }));
  } else if (msg.method === "session/prompt") {
    record("prompt");
    console.log(JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "ok" } } } }));
    console.log(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } }));
  }
});
'
`
	if err := os.WriteFile(scriptPath, []byte(script), 0o755); err != nil {
		t.Fatalf("write fake direct acp: %v", err)
	}

	cfg := DefaultConfig()
	cfg.DirectACP.Enabled = true
	cfg.DirectACP.Agents = map[string]DirectACPAgentConfig{
		"opencode": {Command: scriptPath, Env: map[string]string{"ACP_ORDER_PATH": orderPath}},
	}
	d := New(cfg)

	task := protocol.TaskDispatch{
		TaskID:        "task-1",
		WorkspacePath: dir,
		Agent:         "opencode",
		AgentRuntime:  "direct_acp",
		SessionName:   "task-1",
		ModelID:       "model-b",
		Prompt:        "say ok",
	}
	d.startDirectACPTask(context.Background(), task, protocol.Workspace{ID: "w", Path: dir})
	defer d.deleteDirectACPSession("task-1")

	raw, err := os.ReadFile(orderPath)
	if err != nil {
		t.Fatalf("read order: %v", err)
	}
	if got, want := string(raw), "model:model-b\nprompt\n"; got != want {
		t.Fatalf("ACP call order = %q, want %q", got, want)
	}

	events := drainTaskEvents(d.send)
	if !hasTaskEvent(events, "model.updated") {
		t.Fatalf("direct ACP events missing model.updated: %#v", events)
	}
	if !hasTaskEvent(events, "assistant.message") {
		t.Fatalf("direct ACP events missing assistant.message: %#v", events)
	}
}

func TestDirectACPUsesModelListFromInitialize(t *testing.T) {
	dir := t.TempDir()
	orderPath := filepath.Join(dir, "init-model-order")
	scriptPath := filepath.Join(dir, "fake-direct-acp-init-model")
	script := `#!/bin/sh
node -e '
const fs = require("fs");
const readline = require("readline");
const orderPath = process.env.ACP_ORDER_PATH;
const rl = readline.createInterface({ input: process.stdin });
function record(value) { fs.appendFileSync(orderPath, value + "\n"); }
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.method === "initialize") {
    console.log(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: {
      protocolVersion: 1,
      configOptions: [{ id: "model", type: "select", currentValue: "model-a", options: [{ value: "model-a", name: "A" }, { value: "model-b", name: "B" }] }]
    } }));
  } else if (msg.method === "session/new") {
    console.log(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "fake-session" } }));
  } else if (msg.method === "session/set_config_option" || msg.method === "session/setConfigOption") {
    record("model:" + msg.params.configId + ":" + msg.params.value);
    console.log(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: {
      configOptions: [{ id: "model", type: "select", currentValue: msg.params.value, options: [{ value: "model-a", name: "A" }, { value: "model-b", name: "B" }] }]
    } }));
  } else if (msg.method === "session/prompt") {
    record("prompt");
    console.log(JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "ok" } } } }));
    console.log(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } }));
  }
});
'
`
	if err := os.WriteFile(scriptPath, []byte(script), 0o755); err != nil {
		t.Fatalf("write fake direct acp: %v", err)
	}

	cfg := DefaultConfig()
	cfg.DirectACP.Enabled = true
	cfg.DirectACP.Agents = map[string]DirectACPAgentConfig{
		"opencode": {Command: scriptPath, Env: map[string]string{"ACP_ORDER_PATH": orderPath}},
	}
	d := New(cfg)

	task := protocol.TaskDispatch{
		TaskID:        "task-1",
		WorkspacePath: dir,
		Agent:         "opencode",
		AgentRuntime:  "direct_acp",
		SessionName:   "task-1",
		ModelID:       "model-b",
		Prompt:        "say ok",
	}
	d.startDirectACPTask(context.Background(), task, protocol.Workspace{ID: "w", Path: dir})
	defer d.deleteDirectACPSession("task-1")

	raw, err := os.ReadFile(orderPath)
	if err != nil {
		t.Fatalf("read order: %v", err)
	}
	if got, want := string(raw), "model:model:model-b\nprompt\n"; got != want {
		t.Fatalf("ACP init model order = %q, want %q", got, want)
	}

	events := drainTaskEvents(d.send)
	if !hasTaskEvent(events, "model.list") {
		t.Fatalf("direct ACP events missing initialize model.list: %#v", events)
	}
	if !hasTaskEvent(events, "model.updated") {
		t.Fatalf("direct ACP events missing model.updated: %#v", events)
	}
}

func TestDirectACPSessionCreateAndDispatchShareInFlightStart(t *testing.T) {
	dir := t.TempDir()
	countPath := filepath.Join(dir, "starts")
	scriptPath := filepath.Join(dir, "fake-direct-acp-slow")
	script := `#!/bin/sh
printf x >> "$ACP_START_COUNT"
node -e '
const readline = require("readline");
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.method === "initialize") {
    console.log(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1 } }));
  } else if (msg.method === "session/new") {
    setTimeout(() => {
      console.log(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "fake-session" } }));
    }, 200);
  } else if (msg.method === "session/prompt") {
    console.log(JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "ok" } } } }));
    console.log(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } }));
  }
});
'
`
	if err := os.WriteFile(scriptPath, []byte(script), 0o755); err != nil {
		t.Fatalf("write fake direct acp: %v", err)
	}

	cfg := DefaultConfig()
	cfg.DirectACP.Enabled = true
	cfg.DirectACP.Agents = map[string]DirectACPAgentConfig{
		"opencode": {Command: scriptPath, Env: map[string]string{"ACP_START_COUNT": countPath}},
	}
	d := New(cfg)

	task := protocol.TaskDispatch{
		TaskID:        "task-1",
		WorkspacePath: dir,
		Agent:         "opencode",
		AgentRuntime:  "direct_acp",
		SessionName:   "task-1",
		Prompt:        "say ok",
	}

	var wg sync.WaitGroup
	wg.Add(2)
	go func() {
		defer wg.Done()
		session := protocol.SessionCreate{
			TaskID:        task.TaskID,
			WorkspacePath: task.WorkspacePath,
			Agent:         task.Agent,
			AgentRuntime:  task.AgentRuntime,
			SessionName:   task.SessionName,
		}
		d.createSession(context.Background(), session)
	}()
	go func() {
		defer wg.Done()
		d.startDirectACPTask(context.Background(), task, protocol.Workspace{ID: "w", Path: dir})
	}()
	wg.Wait()
	defer d.deleteDirectACPSession("task-1")

	raw, err := os.ReadFile(countPath)
	if err != nil {
		t.Fatalf("read start count: %v", err)
	}
	if got := len(raw); got != 1 {
		t.Fatalf("direct ACP process starts = %d, want 1", got)
	}

	events := drainTaskEvents(d.send)
	if !hasTaskEvent(events, "assistant.message") {
		t.Fatalf("direct ACP events missing assistant.message: %#v", events)
	}
	if !hasTaskEvent(events, "task.completed") {
		t.Fatalf("direct ACP events missing task.completed: %#v", events)
	}
}

func TestDirectACPDispatchesSameSessionSequentially(t *testing.T) {
	dir := t.TempDir()
	orderPath := filepath.Join(dir, "prompt-order")
	scriptPath := filepath.Join(dir, "fake-direct-acp-queue")
	script := `#!/bin/sh
node -e '
const fs = require("fs");
const readline = require("readline");
const orderPath = process.env.ACP_ORDER_PATH;
const rl = readline.createInterface({ input: process.stdin });
function promptText(msg) {
  return (((msg.params || {}).prompt || [])[0] || {}).text || "";
}
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.method === "initialize") {
    console.log(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1 } }));
  } else if (msg.method === "session/new") {
    console.log(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "fake-session" } }));
  } else if (msg.method === "session/prompt") {
    const text = promptText(msg);
    fs.appendFileSync(orderPath, text + "\n");
    const finish = () => {
      console.log(JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: text + " done" } } } }));
      console.log(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } }));
    };
    if (text === "first") {
      setTimeout(finish, 200);
    } else {
      finish();
    }
  }
});
'
`
	if err := os.WriteFile(scriptPath, []byte(script), 0o755); err != nil {
		t.Fatalf("write fake direct acp: %v", err)
	}

	cfg := DefaultConfig()
	cfg.DirectACP.Enabled = true
	cfg.DirectACP.Agents = map[string]DirectACPAgentConfig{
		"opencode": {Command: scriptPath, Env: map[string]string{"ACP_ORDER_PATH": orderPath}},
	}
	d := New(cfg)

	baseTask := protocol.TaskDispatch{
		TaskID:        "task-1",
		WorkspacePath: dir,
		Agent:         "opencode",
		AgentRuntime:  "direct_acp",
		SessionName:   "task-1",
	}

	var wg sync.WaitGroup
	wg.Add(2)
	go func() {
		defer wg.Done()
		task := baseTask
		task.Prompt = "first"
		d.startDirectACPTask(context.Background(), task, protocol.Workspace{ID: "w", Path: dir})
	}()
	time.Sleep(50 * time.Millisecond)
	go func() {
		defer wg.Done()
		task := baseTask
		task.Prompt = "second"
		d.startDirectACPTask(context.Background(), task, protocol.Workspace{ID: "w", Path: dir})
	}()
	wg.Wait()
	defer d.deleteDirectACPSession("task-1")

	raw, err := os.ReadFile(orderPath)
	if err != nil {
		t.Fatalf("read prompt order: %v", err)
	}
	if got, want := string(raw), "first\nsecond\n"; got != want {
		t.Fatalf("ACP prompt order = %q, want %q", got, want)
	}
}

func TestDirectACPStopThenDispatchResumesWithoutStaleTerminal(t *testing.T) {
	dir := t.TempDir()
	orderPath := filepath.Join(dir, "prompt-order")
	scriptPath := filepath.Join(dir, "fake-direct-acp-stop-resume")
	script := `#!/bin/sh
node -e '
const fs = require("fs");
const readline = require("readline");
const orderPath = process.env.ACP_ORDER_PATH;
const rl = readline.createInterface({ input: process.stdin });
function promptText(msg) {
  return (((msg.params || {}).prompt || [])[0] || {}).text || "";
}
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.method === "initialize") {
    console.log(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: {
      protocolVersion: 1,
      agentCapabilities: { sessionCapabilities: { resume: true } }
    } }));
  } else if (msg.method === "session/new") {
    console.log(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "provider-session" } }));
  } else if (msg.method === "session/resume") {
    fs.appendFileSync(orderPath, "resume:" + msg.params.sessionId + "\n");
    console.log(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { sessionId: msg.params.sessionId } }));
  } else if (msg.method === "session/prompt") {
    const text = promptText(msg);
    fs.appendFileSync(orderPath, "prompt:" + msg.params.sessionId + ":" + text + "\n");
    if (text === "first") {
      return;
    }
    console.log(JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: text + " done" } } } }));
    console.log(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } }));
  } else if (msg.method === "session/cancel") {
    fs.appendFileSync(orderPath, "cancel:" + msg.params.sessionId + "\n");
  }
});
'
`
	if err := os.WriteFile(scriptPath, []byte(script), 0o755); err != nil {
		t.Fatalf("write fake direct acp: %v", err)
	}

	cfg := DefaultConfig()
	cfg.DirectACP.Enabled = true
	cfg.DirectACP.Agents = map[string]DirectACPAgentConfig{
		"opencode": {Command: scriptPath, Env: map[string]string{"ACP_ORDER_PATH": orderPath}},
	}
	d := New(cfg)

	baseTask := protocol.TaskDispatch{
		TaskID:        "task-1",
		WorkspacePath: dir,
		Agent:         "opencode",
		AgentRuntime:  "direct_acp",
		SessionName:   "task-1",
	}

	firstDone := make(chan struct{})
	go func() {
		defer close(firstDone)
		task := baseTask
		task.Prompt = "first"
		d.startDirectACPTask(context.Background(), task, protocol.Workspace{ID: "w", Path: dir})
	}()
	waitForFileContains(t, orderPath, "prompt:provider-session:first", time.Second)
	d.stopDirectACPTask("task-1")
	d.mu.Lock()
	activeAfterStop := d.directACP["task-1"]
	runningAfterStop := d.tasks["task-1"]
	d.mu.Unlock()
	if activeAfterStop != nil || runningAfterStop != nil {
		t.Fatalf("direct ACP stop left active session/task: session=%#v task=%#v", activeAfterStop, runningAfterStop)
	}

	task := baseTask
	task.ResumeSessionID = "task-1"
	task.Prompt = "second"
	d.startDirectACPTask(context.Background(), task, protocol.Workspace{ID: "w", Path: dir})
	defer d.deleteDirectACPSession("task-1")

	select {
	case <-firstDone:
	case <-time.After(time.Second):
		t.Fatalf("first direct ACP dispatch did not exit after stop")
	}

	raw, err := os.ReadFile(orderPath)
	if err != nil {
		t.Fatalf("read prompt order: %v", err)
	}
	logText := string(raw)
	for _, want := range []string{
		"prompt:provider-session:first\n",
		"prompt:provider-session:second\n",
	} {
		if !strings.Contains(logText, want) {
			t.Fatalf("direct ACP log = %q, missing %q", logText, want)
		}
	}
	if strings.Contains(logText, "resume:provider-session\n") {
		t.Fatalf("interrupted unpersisted session must not be resumed: %q", logText)
	}

	events := drainTaskEvents(d.send)
	if !hasTaskEvent(events, "task.killed") {
		t.Fatalf("direct ACP events missing stopped turn task.killed: %#v", events)
	}
	if !hasTaskEvent(events, "task.completed") {
		t.Fatalf("direct ACP events missing second task.completed: %#v", events)
	}
	completedIndex := -1
	staleTerminalAfterCompleted := false
	for idx, event := range events {
		if event.EventType == "task.completed" {
			completedIndex = idx
			continue
		}
		if completedIndex >= 0 && (event.EventType == "task.killed" || event.EventType == "task.failed") {
			staleTerminalAfterCompleted = true
		}
	}
	if staleTerminalAfterCompleted {
		t.Fatalf("stale terminal event arrived after resumed completion: %#v", events)
	}
	if got := d.history["task-1"].SessionID; got != "provider-session" {
		t.Fatalf("record SessionID = %q, want provider session id", got)
	}
}

func TestDirectACPResumeSessionIDFallsBackToLatestCodexRollout(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	validID := "019f6897-d804-78c3-8807-bcdea4913246"
	invalidID := "019f6a5d-ad4b-78d2-9c12-755a37b2a428"
	rollout := filepath.Join(home, ".codex", "sessions", "2026", "07", "16", "rollout-"+validID+".jsonl")
	if err := os.MkdirAll(filepath.Dir(rollout), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(rollout, []byte("{}\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	data, _ := json.Marshal(map[string]any{"agentSessionId": validID})
	d := New(DefaultConfig())
	d.history["task"] = protocol.TaskRecord{
		TaskID:    "task",
		SessionID: invalidID,
		Events:    []protocol.TaskEvent{{EventType: "acp.session", Data: data}},
	}
	got := d.directACPResumeSessionID(protocol.TaskDispatch{
		TaskID:          "task",
		Agent:           "codex",
		ResumeSessionID: invalidID,
	})
	if got != validID {
		t.Fatalf("directACPResumeSessionID() = %q, want %q", got, validID)
	}
}

func TestProviderResumeSessionIDIgnoresTaskIDFromStoredHistory(t *testing.T) {
	task := protocol.TaskDispatch{
		TaskID:      "task-1",
		SessionName: "task-1",
	}
	if got := providerResumeSessionID(task, "task-1"); got != "" {
		t.Fatalf("providerResumeSessionID() = %q, want empty for task-id history value", got)
	}
	task.ResumeSessionID = "task-1"
	if got := providerResumeSessionID(task, "provider-session"); got != "provider-session" {
		t.Fatalf("providerResumeSessionID() = %q, want restored provider session", got)
	}
	task.ResumeSessionID = "explicit-provider-session"
	if got := providerResumeSessionID(task, "provider-session"); got != "explicit-provider-session" {
		t.Fatalf("providerResumeSessionID() = %q, want explicit provider session", got)
	}
}

func TestDirectACPRespondsToAgentSessionUpdateRequest(t *testing.T) {
	dir := t.TempDir()
	scriptPath := filepath.Join(dir, "fake-direct-acp-request")
	script := `#!/bin/sh
node -e '
const readline = require("readline");
const rl = readline.createInterface({ input: process.stdin });
let promptResponseId = null;
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.method === "initialize") {
    console.log(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "1" } }));
  } else if (msg.method === "session/new") {
    console.log(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "fake-session" } }));
  } else if (msg.method === "session/prompt") {
    promptResponseId = msg.id;
    console.log(JSON.stringify({
      jsonrpc: "2.0",
      id: "agent-request-1",
      method: "session/update",
      params: {
        sessionId: "fake-session",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "request response ok" }
        }
      }
    }));
  } else if (msg.id === "agent-request-1" && msg.result && promptResponseId) {
    console.log(JSON.stringify({ jsonrpc: "2.0", id: promptResponseId, result: { stopReason: "end_turn" } }));
  }
});
'
`
	if err := os.WriteFile(scriptPath, []byte(script), 0o755); err != nil {
		t.Fatalf("write fake direct acp: %v", err)
	}

	cfg := DefaultConfig()
	cfg.DirectACP.Enabled = true
	cfg.DirectACP.Agents = map[string]DirectACPAgentConfig{
		"opencode": {Command: scriptPath},
	}
	d := New(cfg)

	task := protocol.TaskDispatch{
		TaskID:        "task-1",
		WorkspacePath: dir,
		Agent:         "opencode",
		AgentRuntime:  "direct_acp",
		SessionName:   "task-1",
		Prompt:        "say hello",
	}
	d.startDirectACPTask(context.Background(), task, protocol.Workspace{ID: "w", Path: dir})
	defer d.deleteDirectACPSession("task-1")

	got := drainTaskEvents(d.send)
	if !hasTaskEvent(got, "assistant.message") {
		t.Fatalf("direct ACP request events missing assistant.message: %#v", got)
	}
	if !hasTaskEvent(got, "turn.completed") {
		t.Fatalf("direct ACP request events missing turn.completed: %#v", got)
	}
}

func TestDirectACPEmitsAndUpdatesGenericConfigOptions(t *testing.T) {
	dir := t.TempDir()
	orderPath := filepath.Join(dir, "config-order")
	scriptPath := filepath.Join(dir, "fake-direct-acp-config")
	script := `#!/bin/sh
node -e '
const fs = require("fs");
const readline = require("readline");
const orderPath = process.env.ACP_ORDER_PATH;
const rl = readline.createInterface({ input: process.stdin });
function record(value) { fs.appendFileSync(orderPath, value + "\n"); }
function options(mode) {
  return [
    { id: "model", category: "model", type: "select", currentValue: "model-a", options: [{ value: "model-a", name: "A" }] },
    { id: "mode", category: "mode", type: "select", currentValue: mode, options: [{ value: "build", name: "Build" }, { value: "plan", name: "Plan" }] }
  ];
}
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.method === "initialize") {
    console.log(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1 } }));
  } else if (msg.method === "session/new") {
    console.log(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "fake-session", configOptions: options("build") } }));
  } else if (msg.method === "session/set_config_option" || msg.method === "session/setConfigOption") {
    record(msg.params.configId + ":" + msg.params.value);
    console.log(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { configOptions: options(msg.params.value) } }));
  }
});
'
`
	if err := os.WriteFile(scriptPath, []byte(script), 0o755); err != nil {
		t.Fatalf("write fake direct acp: %v", err)
	}

	cfg := DefaultConfig()
	cfg.DirectACP.Enabled = true
	cfg.DirectACP.Agents = map[string]DirectACPAgentConfig{
		"opencode": {Command: scriptPath, Env: map[string]string{"ACP_ORDER_PATH": orderPath}},
	}
	d := New(cfg)
	task := protocol.TaskDispatch{
		TaskID:        "task-1",
		WorkspacePath: dir,
		Agent:         "opencode",
		AgentRuntime:  "direct_acp",
		SessionName:   "task-1",
	}
	if err := d.createDirectACPSession(context.Background(), task, dir, task.TaskID); err != nil {
		t.Fatalf("createDirectACPSession() error = %v", err)
	}
	defer d.deleteDirectACPSession("task-1")

	events := drainTaskEvents(d.send)
	if !hasTaskEvent(events, "config.options") {
		t.Fatalf("direct ACP events missing config.options: %#v", events)
	}
	if !d.setDirectACPConfigOption(context.Background(), protocol.TaskSetConfigOption{
		TaskID:   "task-1",
		ConfigID: "mode",
		Value:    "plan",
	}) {
		t.Fatal("setDirectACPConfigOption() = false")
	}
	raw, err := os.ReadFile(orderPath)
	if err != nil {
		t.Fatalf("read config order: %v", err)
	}
	if got, want := string(raw), "mode:plan\n"; got != want {
		t.Fatalf("ACP config call = %q, want %q", got, want)
	}
	events = drainTaskEvents(d.send)
	if !hasTaskEvent(events, "config.updated") || !hasTaskEvent(events, "config.options") {
		t.Fatalf("direct ACP config update events missing: %#v", events)
	}
}

func hasTaskEvent(events []protocol.TaskEvent, eventType string) bool {
	for _, event := range events {
		if event.EventType == eventType {
			return true
		}
	}
	return false
}

func waitForFileContains(t *testing.T, path string, text string, timeout time.Duration) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		raw, err := os.ReadFile(path)
		if err == nil && strings.Contains(string(raw), text) {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	raw, _ := os.ReadFile(path)
	t.Fatalf("%s did not contain %q before timeout; got %q", path, text, string(raw))
}

func stringSliceContains(values []string, target string) bool {
	for _, value := range values {
		if value == target {
			return true
		}
	}
	return false
}

func historyHasUserPrompt(events []protocol.TaskEvent, prompt string) bool {
	for _, event := range events {
		if event.EventType != "user.prompt" {
			continue
		}
		var data map[string]string
		if err := json.Unmarshal(event.Data, &data); err != nil {
			continue
		}
		if data["prompt"] == prompt {
			return true
		}
	}
	return false
}
