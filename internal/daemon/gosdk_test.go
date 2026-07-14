package daemon

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	acp "github.com/coder/acp-go-sdk"

	"remote-agent/internal/protocol"
)

func TestGoSDKSessionUpdateAccumulatesAssistantChunks(t *testing.T) {
	daemon := New(Config{})
	const taskID = "gosdk-task"
	daemon.history[taskID] = protocol.TaskRecord{TaskID: taskID, AgentRuntime: "gosdk"}
	client := &goSDKClient{emitter: &taskEmitter{daemon: daemon, taskID: taskID}}
	client.startTurn(2)

	emitGoSDKMessageChunk(t, client, "session-1", "完整")
	emitGoSDKMessageChunk(t, client, "session-1", "回复")

	events := taskEventsOfType(daemon.history[taskID].Events, "assistant.message")
	if len(events) != 1 {
		t.Fatalf("assistant events = %d, want one compacted stream: %#v", len(events), events)
	}
	data := taskEventData(t, events[0])
	if data["text"] != "完整回复" {
		t.Fatalf("assistant text = %#v, want complete accumulated reply", data["text"])
	}
	if data["stream_id"] != "gosdk_stream_assistant_session-1_2" {
		t.Fatalf("stream_id = %#v, want turn-scoped stream", data["stream_id"])
	}
	if data["acpx_event_key"] != "turn:2:assistant.message:0" {
		t.Fatalf("acpx_event_key = %#v, want turn-scoped event key", data["acpx_event_key"])
	}
}

func TestGoSDKSessionUpdateKeepsAssistantRepliesFromDifferentTurns(t *testing.T) {
	daemon := New(Config{})
	const taskID = "gosdk-task"
	daemon.history[taskID] = protocol.TaskRecord{TaskID: taskID, AgentRuntime: "gosdk"}
	client := &goSDKClient{emitter: &taskEmitter{daemon: daemon, taskID: taskID}}

	client.startTurn(0)
	emitGoSDKMessageChunk(t, client, "session-1", "first reply")
	client.startTurn(1)
	emitGoSDKMessageChunk(t, client, "session-1", "second reply")

	events := taskEventsOfType(daemon.history[taskID].Events, "assistant.message")
	if len(events) != 2 {
		t.Fatalf("assistant events = %d, want one reply per turn: %#v", len(events), events)
	}
	first := taskEventData(t, events[0])
	second := taskEventData(t, events[1])
	if first["text"] != "first reply" || second["text"] != "second reply" {
		t.Fatalf("assistant replies = %#v, %#v, want both turns preserved", first["text"], second["text"])
	}
	if first["stream_id"] == second["stream_id"] {
		t.Fatalf("stream IDs must differ across turns: %#v", first["stream_id"])
	}
}

func TestGoSDKSessionUpdatePreservesIncrementalToolCallDetails(t *testing.T) {
	daemon := New(Config{})
	const taskID = "gosdk-task"
	daemon.history[taskID] = protocol.TaskRecord{TaskID: taskID, AgentRuntime: "gosdk"}
	client := &goSDKClient{emitter: &taskEmitter{daemon: daemon, taskID: taskID}}
	client.startTurn(0)

	const toolCallID = acp.ToolCallId("call-disk-space")
	emitGoSDKUpdate(t, client, acp.StartToolCall(
		toolCallID,
		"bash",
		acp.WithStartKind(acp.ToolKindExecute),
		acp.WithStartStatus(acp.ToolCallStatusPending),
		acp.WithStartRawInput(map[string]any{"cwd": "/workspace"}),
	))
	emitGoSDKUpdate(t, client, acp.UpdateToolCall(
		toolCallID,
		acp.WithUpdateTitle("df -h /workspace"),
		acp.WithUpdateKind(acp.ToolKindExecute),
		acp.WithUpdateStatus(acp.ToolCallStatusInProgress),
		acp.WithUpdateLocations([]acp.ToolCallLocation{{Path: "/workspace"}}),
		acp.WithUpdateRawInput(map[string]any{
			"command": "df -h /workspace",
			"cwd":     "/workspace",
		}),
	))
	emitGoSDKUpdate(t, client, acp.UpdateToolCall(
		toolCallID,
		acp.WithUpdateTitle("df -h /workspace"),
		acp.WithUpdateStatus(acp.ToolCallStatusCompleted),
		acp.WithUpdateContent([]acp.ToolCallContent{acp.ToolContent(acp.TextBlock("242G available\n"))}),
		acp.WithUpdateRawOutput(map[string]any{"output": "242G available\n"}),
	))

	callEvents := taskEventsOfType(daemon.history[taskID].Events, "tool.call")
	if len(callEvents) != 1 {
		t.Fatalf("tool.call events = %d, want one: %#v", len(callEvents), callEvents)
	}
	callData := taskEventData(t, callEvents[0])
	if callData["kind"] != "execute" {
		t.Fatalf("tool.call kind = %#v, want execute", callData["kind"])
	}

	outputEvents := taskEventsOfType(daemon.history[taskID].Events, "tool.output")
	if len(outputEvents) != 1 {
		t.Fatalf("tool.output events = %d, want one compacted update: %#v", len(outputEvents), outputEvents)
	}
	outputData := taskEventData(t, outputEvents[0])
	if outputData["name"] != "df -h /workspace" {
		t.Fatalf("tool.output name = %#v, want final command title", outputData["name"])
	}
	if outputData["kind"] != "execute" {
		t.Fatalf("tool.output kind = %#v, want preserved execute kind", outputData["kind"])
	}
	input, ok := outputData["input"].(map[string]any)
	if !ok || input["command"] != "df -h /workspace" {
		t.Fatalf("tool.output input = %#v, want preserved command input", outputData["input"])
	}
	output, ok := outputData["output"].(map[string]any)
	if !ok || output["output"] != "242G available\n" {
		t.Fatalf("tool.output output = %#v, want raw command output", outputData["output"])
	}
	content, ok := outputData["content"].([]any)
	if !ok || len(content) != 1 {
		t.Fatalf("tool.output content = %#v, want final ACP content", outputData["content"])
	}
}

func TestEnsureGoSDKSessionCoalescesConcurrentCreates(t *testing.T) {
	dir := t.TempDir()
	startsPath := filepath.Join(dir, "starts")
	scriptPath := filepath.Join(dir, "fake-gosdk-acp")
	script := `#!/bin/sh
printf 'start\n' >> "$GOSDK_STARTS_PATH"
node -e '
const readline = require("readline");
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    setTimeout(() => console.log(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: 1, agentCapabilities: {} } })), 200);
  } else if (message.method === "session/new") {
    console.log(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { sessionId: "shared-session" } }));
  } else if (message.id !== undefined) {
    console.log(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: {} }));
  }
});
'
`
	if err := os.WriteFile(scriptPath, []byte(script), 0o755); err != nil {
		t.Fatalf("write fake GoSDK agent: %v", err)
	}

	cfg := DefaultConfig()
	cfg.DirectACP.Agents = map[string]DirectACPAgentConfig{
		"opencode": {Command: scriptPath, Env: map[string]string{"GOSDK_STARTS_PATH": startsPath}},
	}
	daemon := New(cfg)
	task := protocol.TaskDispatch{TaskID: "task-1", Agent: "opencode", AgentRuntime: "gosdk"}

	start := make(chan struct{})
	errors := make(chan error, 2)
	var ready sync.WaitGroup
	ready.Add(2)
	for range 2 {
		go func() {
			ready.Done()
			<-start
			errors <- daemon.ensureGoSDKSession(context.Background(), task, dir, task.TaskID)
		}()
	}
	ready.Wait()
	close(start)
	for range 2 {
		if err := <-errors; err != nil {
			t.Fatalf("ensureGoSDKSession() error = %v", err)
		}
	}
	t.Cleanup(func() { daemon.deleteGoSDKSession(task.TaskID) })

	raw, err := os.ReadFile(startsPath)
	if err != nil {
		t.Fatalf("read agent starts: %v", err)
	}
	if starts := strings.Count(string(raw), "start\n"); starts != 1 {
		t.Fatalf("agent starts = %d, want one shared session; log=%q", starts, raw)
	}
}

func emitGoSDKMessageChunk(t *testing.T, client *goSDKClient, sessionID, text string) {
	t.Helper()
	emitGoSDKNotification(t, client, acp.SessionNotification{
		SessionId: acp.SessionId(sessionID),
		Update:    acp.UpdateAgentMessageText(text),
	})
}

func emitGoSDKUpdate(t *testing.T, client *goSDKClient, update acp.SessionUpdate) {
	t.Helper()
	emitGoSDKNotification(t, client, acp.SessionNotification{
		SessionId: "session-1",
		Update:    update,
	})
}

func emitGoSDKNotification(t *testing.T, client *goSDKClient, notification acp.SessionNotification) {
	t.Helper()
	if err := client.SessionUpdate(context.Background(), notification); err != nil {
		t.Fatalf("SessionUpdate(%#v): %v", notification.Update, err)
	}
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

func taskEventData(t *testing.T, event protocol.TaskEvent) map[string]any {
	t.Helper()
	var data map[string]any
	if err := json.Unmarshal(event.Data, &data); err != nil {
		t.Fatalf("decode event data: %v", err)
	}
	return data
}
