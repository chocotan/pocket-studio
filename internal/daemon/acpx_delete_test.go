package daemon

import (
	"context"
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
	if len(lines) != 2 {
		t.Fatalf("fake acpx calls = %v, want cancel and close", lines)
	}
	if !strings.Contains(lines[0], "codex cancel --session chat-1") {
		t.Fatalf("first fake acpx call = %q, want cancel", lines[0])
	}
	if !strings.Contains(lines[1], "codex sessions close chat-1") {
		t.Fatalf("second fake acpx call = %q, want session close", lines[1])
	}
}
