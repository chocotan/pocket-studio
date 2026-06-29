package daemon

import (
	"encoding/json"
	"testing"
)

// The exact assistant/tool_use shape claude stream-json emits via acpx — the
// tool_use fields are buried in message.content[]. Verify we surface flat
// name/input/tool_use_id so the frontend tool card renders.
func TestClaudeToolEventDataExtractsToolUse(t *testing.T) {
	raw := json.RawMessage(`{
		"type": "assistant",
		"message": {
			"model": "claude-sonnet-4-6",
			"role": "assistant",
			"content": [
				{
					"type": "tool_use",
					"id": "toolu_016CPEngna6hKjvoutq1RUr6",
					"name": "WebSearch",
					"input": {"query": "马斯克最新新闻 2026年6月"}
				}
			]
		},
		"session_id": "ebb8ada6-f706-4eda-9660-f256908e27d5"
	}`)

	if got := classifyClaudeEvent(raw); got != "tool.call" {
		t.Fatalf("classifyClaudeEvent = %q, want tool.call", got)
	}

	data := claudeToolEventData(raw)
	if data == nil {
		t.Fatal("claudeToolEventData = nil, want extracted tool payload")
	}
	if data["tool_use_id"] != "toolu_016CPEngna6hKjvoutq1RUr6" {
		t.Fatalf("tool_use_id = %v", data["tool_use_id"])
	}
	if data["name"] != "WebSearch" {
		t.Fatalf("name = %v, want WebSearch", data["name"])
	}
	input, ok := data["input"].(map[string]any)
	if !ok || input["query"] != "马斯克最新新闻 2026年6月" {
		t.Fatalf("input = %v", data["input"])
	}
	if data["status"] != "running" {
		t.Fatalf("status = %v, want running", data["status"])
	}
}

func TestClaudeToolEventDataExtractsToolResult(t *testing.T) {
	raw := json.RawMessage(`{
		"type": "user",
		"message": {
			"role": "user",
			"content": [
				{
					"type": "tool_result",
					"tool_use_id": "toolu_016CPEngna6hKjvoutq1RUr6",
					"content": "search results here",
					"is_error": false
				}
			]
		}
	}`)

	if got := classifyClaudeEvent(raw); got != "tool.output" {
		t.Fatalf("classifyClaudeEvent = %q, want tool.output", got)
	}
	data := claudeToolEventData(raw)
	if data == nil {
		t.Fatal("claudeToolEventData = nil, want extracted tool result")
	}
	if data["tool_use_id"] != "toolu_016CPEngna6hKjvoutq1RUr6" {
		t.Fatalf("tool_use_id = %v", data["tool_use_id"])
	}
	if data["output"] != "search results here" {
		t.Fatalf("output = %v", data["output"])
	}
	if data["status"] != "completed" {
		t.Fatalf("status = %v, want completed", data["status"])
	}
}

func TestClaudeToolEventDataToolResultError(t *testing.T) {
	raw := json.RawMessage(`{
		"type": "user",
		"message": {"role": "user", "content": [
			{"type": "tool_result", "tool_use_id": "t1", "content": "boom", "is_error": true}
		]}
	}`)
	data := claudeToolEventData(raw)
	if data == nil || data["status"] != "failed" || data["is_error"] != true {
		t.Fatalf("error tool_result = %v, want status=failed is_error=true", data)
	}
}

// A plain assistant text message has no tool block → nil (caller emits raw).
func TestClaudeToolEventDataNilForPlainMessage(t *testing.T) {
	raw := json.RawMessage(`{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"hi"}]}}`)
	if data := claudeToolEventData(raw); data != nil {
		t.Fatalf("claudeToolEventData = %v, want nil for plain text", data)
	}
}
