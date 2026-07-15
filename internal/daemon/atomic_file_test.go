package daemon

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"remote-agent/internal/protocol"
)

func TestWriteFileAtomicReplacesCompleteFileWithPrivateMode(t *testing.T) {
	path := filepath.Join(t.TempDir(), "nested", "store.json")
	if err := writeFileAtomic(path, []byte("{\"version\":1}\n"), 0o600); err != nil {
		t.Fatalf("first writeFileAtomic() error = %v", err)
	}
	if err := writeFileAtomic(path, []byte("{\"version\":2}\n"), 0o600); err != nil {
		t.Fatalf("second writeFileAtomic() error = %v", err)
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read atomic target: %v", err)
	}
	if got := strings.TrimSpace(string(raw)); got != `{"version":2}` {
		t.Fatalf("atomic target = %q, want complete replacement", got)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatalf("stat atomic target: %v", err)
	}
	if got := info.Mode().Perm(); got != 0o600 {
		t.Fatalf("atomic target mode = %o, want 600", got)
	}
}

func TestCorruptConversationStoresAreNotOverwritten(t *testing.T) {
	tests := []struct {
		name string
		path func() string
		load func(*Daemon) error
		save func(*Daemon) error
		seed func(*Daemon)
	}{
		{
			name: "direct ACP",
			path: daemonDirectACPSessionsPath,
			load: (*Daemon).loadDirectACPStore,
			save: (*Daemon).saveDirectACPStoreLocked,
			seed: func(d *Daemon) {
				d.history["direct-task"] = protocol.TaskRecord{TaskID: "direct-task", AgentRuntime: "direct_acp"}
			},
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			dir := t.TempDir()
			t.Setenv("POCKET_STUDIO_DAEMON_CONFIG_DIR", dir)
			partial := []byte(`{"version":1,"tasks":[`)
			if err := os.WriteFile(test.path(), partial, 0o600); err != nil {
				t.Fatalf("write corrupt store: %v", err)
			}

			d := New(DefaultConfig())
			if err := test.load(d); err == nil || !strings.Contains(err.Error(), "decode") {
				t.Fatalf("load corrupt store error = %v, want decode error", err)
			}
			d.mu.Lock()
			test.seed(d)
			err := test.save(d)
			d.mu.Unlock()
			if err == nil || !strings.Contains(err.Error(), "refusing to overwrite") {
				t.Fatalf("save after corrupt load error = %v, want overwrite refusal", err)
			}
			raw, readErr := os.ReadFile(test.path())
			if readErr != nil {
				t.Fatalf("read preserved corrupt store: %v", readErr)
			}
			if !bytes.Equal(raw, partial) {
				t.Fatalf("corrupt store changed from %q to %q", partial, raw)
			}
		})
	}
}

func TestConversationStoreRestartIgnoresOrphanedPartialTempFile(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("POCKET_STUDIO_DAEMON_CONFIG_DIR", dir)
	cfg := DefaultConfig()
	cfg.Device.ID = "device-1"

	live := New(cfg)
	live.history["task-1"] = protocol.TaskRecord{
		TaskID:       "task-1",
		AgentRuntime: "direct_acp",
		SessionID:    "provider-session",
		Status:       "completed",
	}
	live.mu.Lock()
	if err := live.saveDirectACPStoreLocked(); err != nil {
		live.mu.Unlock()
		t.Fatalf("save valid store: %v", err)
	}
	live.mu.Unlock()

	orphan := filepath.Join(dir, ".direct-acp-sessions.json.tmp-crash")
	if err := os.WriteFile(orphan, []byte(`{"version":1,"tasks":[`), 0o600); err != nil {
		t.Fatalf("write orphaned partial temp: %v", err)
	}

	restarted := New(cfg)
	if err := restarted.loadDirectACPStore(); err != nil {
		t.Fatalf("restart load with orphaned temp error = %v", err)
	}
	if got := restarted.history["task-1"].SessionID; got != "provider-session" {
		t.Fatalf("restored session = %q, want provider-session", got)
	}
	raw, err := os.ReadFile(daemonDirectACPSessionsPath())
	if err != nil {
		t.Fatalf("read target store: %v", err)
	}
	var store directACPStore
	if err := json.Unmarshal(raw, &store); err != nil {
		t.Fatalf("target store became partial JSON: %v", err)
	}
}
