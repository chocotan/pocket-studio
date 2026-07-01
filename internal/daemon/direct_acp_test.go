package daemon

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"remote-agent/internal/protocol"
)

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
	if len(record.Events) != 1 || record.Events[0].EventID != "evt-1" {
		t.Fatalf("restored events = %#v, want persisted event", record.Events)
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

func TestDirectACPHistoryNotOverwrittenByACPXSessionRecords(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("POCKET_STUDIO_DAEMON_CONFIG_DIR", dir)
	cfg := DefaultConfig()
	cfg.Device.ID = "device-1"
	cfg.ACPX.Enabled = true
	d := New(cfg)

	// Inject a direct ACP session history with multiple messages
	taskID := "acpx-chat-1"
	event1 := protocol.TaskEvent{
		TaskID:    taskID,
		EventID:   "evt-1",
		EventType: "user.prompt",
		Sequence:  1,
		Timestamp: 100,
		Data:      []byte(`{"prompt":"hello"}`),
	}
	event2 := protocol.TaskEvent{
		TaskID:    taskID,
		EventID:   "evt-2",
		EventType: "user.prompt",
		Sequence:  2,
		Timestamp: 110,
		Data:      []byte(`{"prompt":"subsequent"}`),
	}

	d.mu.Lock()
	d.history[taskID] = protocol.TaskRecord{
		TaskID:        taskID,
		DeviceID:      "device-1",
		WorkspacePath: dir,
		Agent:         "opencode",
		AgentRuntime:  "direct_acp",
		SessionName:   taskID,
		SessionID:     "agent-session-1",
		Status:        "running",
		StartedAt:     100,
		UpdatedAt:     120,
		Events:        []protocol.TaskEvent{event1, event2},
	}
	d.mu.Unlock()

	scriptPath := filepath.Join(dir, "fake-acpx")
	scriptContent := `#!/bin/sh
printf '[{"acpxRecordId":"agent-session-1","name":"acpx-chat-1","cwd":"%s","createdAt":"2026-06-18T14:00:00Z","lastUsedAt":"2026-06-18T14:00:00Z","messages":[{"User":{"content":"hello"}}]}]\n'
`
	scriptContent = fmt.Sprintf(scriptContent, dir)
	if err := os.WriteFile(scriptPath, []byte(scriptContent), 0o755); err != nil {
		t.Fatalf("write fake acpx: %v", err)
	}
	cfg.ACPX.Command = scriptPath

	// Trigger sendSnapshot. Inside, it calls acpxSessionRecords and merges.
	// Since we fixed it, it should skip the record.
	d.send = make(chan protocol.Envelope, 10)
	d.sendSnapshot()

	d.mu.Lock()
	record := d.history[taskID]
	d.mu.Unlock()

	if record.AgentRuntime != "direct_acp" {
		t.Errorf("AgentRuntime = %q, want direct_acp", record.AgentRuntime)
	}
	if len(record.Events) != 2 {
		t.Errorf("len(Events) = %d, want 2", len(record.Events))
	}
	if !historyHasUserPrompt(record.Events, "subsequent") {
		t.Errorf("lost subsequent user prompt: %#v", record.Events)
	}
}
