package daemon

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"remote-agent/internal/protocol"
)

func TestLoadPiImportedHistoryPreservesToolCallsAndProviderTime(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("PI_CODING_AGENT_DIR", "")
	const sessionID = "019f9d4f-536e-703f-8e61-ef812676d15e"
	path := filepath.Join(home, ".pi", "agent", "sessions", "workspace", "history_"+sessionID+".jsonl")
	writeHistoryFixture(t, path, `
{"type":"message","timestamp":"2026-01-01T00:00:00.000Z","message":{"role":"user","content":[{"type":"text","text":"inspect"}]}}
{"type":"message","timestamp":"2026-01-01T00:00:05.250Z","message":{"role":"assistant","content":[{"type":"thinking","thinking":"check files"},{"type":"text","text":"running"},{"type":"toolCall","id":"call-1","name":"bash","arguments":{"command":"pwd"}}]}}
{"type":"message","timestamp":"2026-01-01T00:00:06.500Z","message":{"role":"toolResult","toolCallId":"call-1","toolName":"bash","content":[{"type":"text","text":"/workspace"}],"isError":false}}
`)

	events, err := loadPiImportedHistory(sessionID)
	if err != nil {
		t.Fatal(err)
	}
	wantTypes := []string{"user.prompt", "assistant.thinking", "assistant.message", "tool.call", "tool.output"}
	if len(events) != len(wantTypes) {
		t.Fatalf("Pi history events = %#v, want %d events", events, len(wantTypes))
	}
	for index, want := range wantTypes {
		if events[index].EventType != want {
			t.Fatalf("Pi history event %d type = %q, want %q", index, events[index].EventType, want)
		}
	}
	if events[1].ProviderTimestampMS != 1767225605250 || events[4].ProviderTimestampMS != 1767225606500 {
		t.Fatalf("Pi provider timestamps = %d, %d", events[1].ProviderTimestampMS, events[4].ProviderTimestampMS)
	}
	callInput, _ := events[3].Data["input"].(map[string]any)
	if events[3].Data["name"] != "bash" || callInput["command"] != "pwd" {
		t.Fatalf("Pi tool call = %#v", events[3].Data)
	}
	if events[4].Data["status"] != "completed" || events[4].Data["tool_use_id"] != "call-1" {
		t.Fatalf("Pi tool output = %#v", events[4].Data)
	}

	d := New(Config{})
	d.history["task-pi-history"] = protocol.TaskRecord{TaskID: "task-pi-history", AgentRuntime: "direct_acp"}
	emitPiImportedHistory(&taskEmitter{daemon: d, taskID: "task-pi-history"}, events)
	stored := d.history["task-pi-history"].Events
	if len(stored) != len(events) || stored[1].ProviderTimestampMS != events[1].ProviderTimestampMS {
		t.Fatalf("stored Pi history = %#v", stored)
	}
	if status := d.history["task-pi-history"].Status; status != "created" {
		t.Fatalf("stored Pi history status = %q, want created", status)
	}
}

func TestPiImportedHistoryStripsANSIFromThinking(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("PI_CODING_AGENT_DIR", "")
	const sessionID = "019f9d4f-536e-703f-8e61-ef812676d15f"
	path := filepath.Join(home, ".pi", "agent", "sessions", "workspace", "history_"+sessionID+".jsonl")
	writeHistoryFixture(t, path, "\n{\"type\":\"message\",\"timestamp\":\"2026-01-01T00:00:00.000Z\",\"message\":{\"role\":\"user\",\"content\":[{\"type\":\"text\",\"text\":\"go\"}]}}\n{\"type\":\"message\",\"timestamp\":\"2026-01-01T00:00:05.250Z\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"thinking\",\"thinking\":\"\\u001b[38;2;138;190;183mThinking:\\u001b[39m \\u001b[38;2;128;128;128mLet me look.\\u001b[39m\"},{\"type\":\"text\",\"text\":\"\\u001b[31mred reply\\u001b[39m\"}]}}\n")

	events, err := loadPiImportedHistory(sessionID)
	if err != nil {
		t.Fatal(err)
	}
	for _, event := range events {
		text := stringField(event.Data, "text")
		if strings.ContainsRune(text, 0x1b) {
			t.Fatalf("imported event %s still carries ANSI: %q", event.EventType, text)
		}
	}
	wantThinking := "Thinking: Let me look."
	if events[1].Data["text"] != wantThinking {
		t.Fatalf("thinking text = %q, want %q", events[1].Data["text"], wantThinking)
	}
	if events[2].Data["text"] != "red reply" {
		t.Fatalf("assistant text = %q, want %q", events[2].Data["text"], "red reply")
	}
}

func TestExecuteToolCallWithTitleCommandSynthesizesInput(t *testing.T) {
	d := New(Config{})
	const taskID = "task-execute-title"
	d.history[taskID] = protocol.TaskRecord{TaskID: taskID, AgentRuntime: "direct_acp"}
	adapter := newAgentOutputAdapter(&taskEmitter{daemon: d, taskID: taskID}, 0, "")
	// pi's bash adapter emits kind=execute with the full command in title
	// and no rawInput at all.
	adapter.handle(json.RawMessage(`{"jsonrpc":"2.0","method":"session/update","params":{"update":{"sessionUpdate":"tool_call","toolCallId":"call-exec-1","title":"git status --short && git log --oneline -3","kind":"execute","status":"completed"}}}`))

	events := d.history[taskID].Events
	if len(events) != 1 || events[0].EventType != "tool.call" {
		t.Fatalf("execute tool events = %#v", events)
	}
	call := taskEventData(t, events[0])
	input, _ := call["input"].(map[string]any)
	if input["command"] != "git status --short && git log --oneline -3" {
		t.Fatalf("synthesized execute input = %#v", call)
	}
	if call["kind"] != "execute" {
		t.Fatalf("execute kind = %v, want execute", call["kind"])
	}
	if call["title"] != "git status --short && git log --oneline -3" {
		t.Fatalf("execute title = %v", call["title"])
	}
}

func TestInlineToolOutputStillEmitsCanonicalCallBeforeOutput(t *testing.T) {
	d := New(Config{})
	const taskID = "task-inline-tool"
	d.history[taskID] = protocol.TaskRecord{TaskID: taskID, AgentRuntime: "direct_acp"}
	adapter := newAgentOutputAdapter(&taskEmitter{daemon: d, taskID: taskID}, 0, "")
	adapter.handle(json.RawMessage(`{"jsonrpc":"2.0","method":"session/update","params":{"update":{"sessionUpdate":"tool_call","toolCallId":"call-1","title":"bash","kind":"other","status":"completed","rawInput":{"command":"pwd"},"rawOutput":{"content":[{"type":"text","text":"/workspace"}]}}}}`))

	events := d.history[taskID].Events
	if len(events) != 2 || events[0].EventType != "tool.call" || events[1].EventType != "tool.output" {
		t.Fatalf("inline tool events = %#v, want call followed by output", events)
	}
	call := taskEventData(t, events[0])
	input, _ := call["input"].(map[string]any)
	if call["tool_use_id"] != "call-1" || input["command"] != "pwd" {
		t.Fatalf("inline tool call = %#v", call)
	}
}

func TestPiSessionLoadPrefersNativeHistoryOverDegradedACPReplay(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("PI_CODING_AGENT_DIR", "")
	const sessionID = "019f9d4f-536e-703f-8e61-ef812676d15e"
	historyPath := filepath.Join(home, ".pi", "agent", "sessions", "workspace", "history_"+sessionID+".jsonl")
	writeHistoryFixture(t, historyPath, `
{"type":"message","timestamp":"2026-01-01T00:00:00.000Z","message":{"role":"user","content":[{"type":"text","text":"inspect"}]}}
{"type":"message","timestamp":"2026-01-01T00:00:05.250Z","message":{"role":"assistant","content":[{"type":"thinking","thinking":"check files"},{"type":"text","text":"native reply"},{"type":"toolCall","id":"call-native","name":"bash","arguments":{"command":"pwd"}}]}}
{"type":"message","timestamp":"2026-01-01T00:00:06.500Z","message":{"role":"toolResult","toolCallId":"call-native","toolName":"bash","content":[{"type":"text","text":"/workspace"}],"isError":false}}
`)

	workspace := t.TempDir()
	scriptPath := filepath.Join(workspace, "fake-pi-acp")
	script := `#!/bin/sh
node -e '
const readline = require("readline");
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.method === "initialize") {
    console.log(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: {
      protocolVersion: 1, agentCapabilities: { loadSession: true }
    } }));
  } else if (msg.method === "session/load") {
    console.log(JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: {
      sessionId: msg.params.sessionId,
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "degraded replay" } }
    } }));
    console.log(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { sessionId: msg.params.sessionId } }));
  } else if (msg.id !== undefined) {
    console.log(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: {} }));
  }
});
'
`
	if err := os.WriteFile(scriptPath, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}

	cfg := DefaultConfig()
	cfg.DirectACP.Enabled = true
	cfg.DirectACP.Agents = map[string]DirectACPAgentConfig{"pi": {Command: scriptPath}}
	d := New(cfg)
	task := protocol.TaskDispatch{
		TaskID:          "task-pi-native-history",
		WorkspacePath:   workspace,
		Agent:           "pi",
		AgentRuntime:    "direct_acp",
		SessionName:     "Pi history",
		ResumeSessionID: sessionID,
		ImportHistory:   true,
	}
	if err := d.createDirectACPSession(context.Background(), task, workspace, task.TaskID); err != nil {
		t.Fatal(err)
	}
	defer d.deleteDirectACPSession(task.TaskID)

	messages := taskEventsOfType(d.history[task.TaskID].Events, "assistant.message")
	if len(messages) != 1 || taskEventData(t, messages[0])["text"] != "native reply" {
		t.Fatalf("Pi assistant history = %#v, want native reply only", messages)
	}
	calls := taskEventsOfType(d.history[task.TaskID].Events, "tool.call")
	if len(calls) != 1 {
		t.Fatalf("Pi tool calls = %#v, want one native call", calls)
	}
	input, _ := taskEventData(t, calls[0])["input"].(map[string]any)
	if input["command"] != "pwd" || calls[0].ProviderTimestampMS != 1767225605250 {
		t.Fatalf("Pi native tool call = %#v", calls[0])
	}
}
