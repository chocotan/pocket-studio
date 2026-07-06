package daemon

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestDeleteACPXSessionCancelsRunningTaskBeforeClosingSession(t *testing.T) {
	dir := t.TempDir()
	logPath := filepath.Join(dir, "acpx.log")
	scriptPath := filepath.Join(dir, "fake-acpx")
	script := "#!/bin/sh\nprintf '%s\\n' \"$*\" >> \"$ACPX_LOG\"\n"
	if err := os.WriteFile(scriptPath, []byte(script), 0o755); err != nil {
		t.Fatalf("write fake acpx: %v", err)
	}
	t.Setenv("ACPX_LOG", logPath)

	cfg := DefaultConfig()
	cfg.ACPX.Command = scriptPath
	cfg.ACPX.Args = nil
	cfg.ACPX.TTLSeconds = 0
	d := New(cfg)

	cancelled := false
	rt := &runningTask{
		acpx:      true,
		workspace: dir,
		agent:     "codex",
		session:   "chat-1",
		cancel: func() {
			cancelled = true
		},
	}

	if err := d.deleteACPXSession(context.Background(), rt, dir, "codex", "chat-1"); err != nil {
		t.Fatalf("deleteACPXSession() error = %v", err)
	}
	if !cancelled {
		t.Fatalf("deleteACPXSession() did not cancel running task context")
	}

	raw, err := os.ReadFile(logPath)
	if err != nil {
		t.Fatalf("read fake acpx log: %v", err)
	}
	lines := strings.Split(strings.TrimSpace(string(raw)), "\n")
	if len(lines) < 2 {
		t.Fatalf("fake acpx calls = %v, want at least cancel and close", lines)
	}
	if !strings.Contains(lines[0], "codex cancel --session chat-1") {
		t.Fatalf("first fake acpx call = %q, want cancel", lines[0])
	}
	for i := 1; i < len(lines); i++ {
		if !strings.Contains(lines[i], "codex sessions close chat-1") {
			t.Fatalf("subsequent fake acpx call %d = %q, want session close", i, lines[i])
		}
	}
}

func TestCancelACPXTaskKeepsSessionOpenForResume(t *testing.T) {
	dir := t.TempDir()
	logPath := filepath.Join(dir, "acpx.log")
	scriptPath := filepath.Join(dir, "fake-acpx")
	script := "#!/bin/sh\nprintf '%s\\n' \"$*\" >> \"$ACPX_LOG\"\n"
	if err := os.WriteFile(scriptPath, []byte(script), 0o755); err != nil {
		t.Fatalf("write fake acpx: %v", err)
	}
	t.Setenv("ACPX_LOG", logPath)

	cfg := DefaultConfig()
	cfg.ACPX.Command = scriptPath
	cfg.ACPX.Args = nil
	cfg.ACPX.TTLSeconds = 0
	d := New(cfg)

	d.cancelACPXTask(&runningTask{
		acpx:      true,
		workspace: dir,
		agent:     "codex",
		session:   "chat-1",
	})

	raw, err := os.ReadFile(logPath)
	if err != nil {
		t.Fatalf("read fake acpx log: %v", err)
	}
	lines := strings.Split(strings.TrimSpace(string(raw)), "\n")
	if len(lines) != 1 {
		t.Fatalf("fake acpx calls = %v, want only cancel", lines)
	}
	if !strings.Contains(lines[0], "codex cancel --session chat-1") {
		t.Fatalf("fake acpx call = %q, want cancel", lines[0])
	}
	if strings.Contains(lines[0], "sessions close") {
		t.Fatalf("cancelACPXTask closed session: %q", lines[0])
	}
}

func TestCancelACPXTaskDoesNotForceKillQueueOwner(t *testing.T) {
	dir := t.TempDir()
	home := t.TempDir()
	t.Setenv("HOME", home)
	logPath := filepath.Join(dir, "acpx.log")
	scriptPath := filepath.Join(dir, "fake-acpx")
	script := "#!/bin/sh\nprintf '%s\\n' \"$*\" >> \"$ACPX_LOG\"\n"
	if err := os.WriteFile(scriptPath, []byte(script), 0o755); err != nil {
		t.Fatalf("write fake acpx: %v", err)
	}
	t.Setenv("ACPX_LOG", logPath)

	sessionDir := filepath.Join(home, ".acpx", "sessions")
	if err := os.MkdirAll(sessionDir, 0o755); err != nil {
		t.Fatalf("mkdir acpx sessions: %v", err)
	}
	lockPath := filepath.Join(sessionDir, "rec-1.stream.lock")
	raw, _ := json.Marshal(map[string]int{"pid": -1})
	if err := os.WriteFile(lockPath, raw, 0o644); err != nil {
		t.Fatalf("write lock: %v", err)
	}

	cfg := DefaultConfig()
	cfg.ACPX.Command = scriptPath
	cfg.ACPX.Args = nil
	cfg.ACPX.TTLSeconds = 0
	d := New(cfg)

	d.cancelACPXTask(&runningTask{
		acpx:      true,
		recordID:  "rec-1",
		workspace: dir,
		agent:     "codex",
		session:   "chat-1",
	})

	if _, err := os.Stat(lockPath); err != nil {
		t.Fatalf("cancelACPXTask removed stream lock, want force-kill fallback deferred: %v", err)
	}
}
