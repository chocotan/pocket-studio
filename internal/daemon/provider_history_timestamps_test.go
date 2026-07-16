package daemon

import (
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"testing"

	"remote-agent/internal/protocol"
)

func TestLoadOpenCodeTurnTimings(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("shell fixture")
	}
	bin := t.TempDir()
	command := filepath.Join(bin, "opencode")
	writeHistoryFixture(t, command, `#!/bin/sh
printf '%s' '{"messages":[{"info":{"role":"user","time":{"created":1767225600000}},"parts":[{"type":"text","text":"hello"}]},{"info":{"role":"assistant","time":{"completed":1767225607250}},"parts":[{"type":"text","text":"hi","time":{"start":1767225601000,"end":1767225607250}}]}]}'
`)
	if err := os.Chmod(command, 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", bin)

	timings, err := loadOpenCodeTurnTimings("session-opencode", t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if len(timings) != 1 || timings[0].Prompt != "hello" || timings[0].CompletedAtMS != 1767225607250 {
		t.Fatalf("timings = %#v", timings)
	}
}

func TestLoadCodexTurnTimings(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	path := filepath.Join(home, ".codex", "sessions", "2026", "01", "01", "rollout-session-codex.jsonl")
	writeHistoryFixture(t, path, `
{"timestamp":"2026-01-01T00:00:00.000Z","type":"event_msg","payload":{"type":"task_started","turn_id":"turn-1","started_at":1767225600}}
{"timestamp":"2026-01-01T00:00:07.250Z","type":"event_msg","payload":{"type":"task_complete","turn_id":"turn-1","completed_at":1767225607}}
`)

	timings, err := loadCodexTurnTimings("session-codex")
	if err != nil {
		t.Fatal(err)
	}
	if len(timings) != 1 || timings[0].StartedAtMS != 1767225600000 || timings[0].CompletedAtMS != 1767225607000 {
		t.Fatalf("timings = %#v", timings)
	}
}

func TestLoadClaudeTurnTimings(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	path := filepath.Join(home, ".claude", "projects", "project", "session-claude.jsonl")
	writeHistoryFixture(t, path, `
{"type":"user","timestamp":"2026-01-01T00:00:00.000Z","message":{"content":[{"type":"text","text":"hello"}]}}
{"type":"assistant","timestamp":"2026-01-01T00:00:04.500Z","message":{"content":[{"type":"text","text":"hi"}]}}
{"type":"user","timestamp":"2026-01-01T00:00:05.000Z","message":{"content":[{"type":"tool_result","content":"done"}]}}
`)

	timings, err := loadClaudeTurnTimings("session-claude")
	if err != nil {
		t.Fatal(err)
	}
	if len(timings) != 1 || timings[0].CompletedAtMS != 1767225605000 {
		t.Fatalf("timings = %#v", timings)
	}
}

func TestMatchingProviderTurnTimingSkipsProviderOnlyTurns(t *testing.T) {
	timings := []providerTurnTiming{
		{Prompt: "provider-only"},
		{Prompt: "saved prompt"},
	}
	if got := matchingProviderTurnTiming(timings, "saved prompt", 0); got != 1 {
		t.Fatalf("matchingProviderTurnTiming() = %d", got)
	}
}

func TestImportedHistoryNeedsTimestampsIncludesUnmarkedAssistantReplay(t *testing.T) {
	importedData, _ := json.Marshal(map[string]any{"prompt": "hello", "imported_history": true})
	assistantData, _ := json.Marshal(map[string]any{"text": "hi"})
	d := &Daemon{history: map[string]protocol.TaskRecord{
		"task": {Events: []protocol.TaskEvent{
			{EventType: "user.prompt", ProviderTimestampMS: 1767225600000, Data: importedData},
			{EventType: "assistant.message", Data: assistantData},
		}},
	}}
	if !d.importedHistoryNeedsTimestamps("task") {
		t.Fatal("unmarked assistant event inside an imported turn must still receive provider time")
	}
}

func writeHistoryFixture(t *testing.T, path, contents string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(contents), 0o600); err != nil {
		t.Fatal(err)
	}
}
