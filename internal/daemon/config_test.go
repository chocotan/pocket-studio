package daemon

import (
	"os/exec"
	"strings"
	"testing"
)

func TestNormalizeConfigRequiresServerURL(t *testing.T) {
	cfg := DefaultConfig()
	cfg.Device.ID = "dev_test"
	cfg.Workspaces = nil

	if _, err := NormalizeConfig(cfg); err == nil || !strings.Contains(err.Error(), "daemon.server.url") {
		t.Fatalf("NormalizeConfig() without server URL error = %v, want daemon.server.url error", err)
	}

	// A token is intentionally NOT required: local desktop mode runs an
	// open-auth server and connects with an empty token. Auth is enforced
	// server-side at the WebSocket handshake, not here.
	cfg.Server.URL = "ws://localhost:18080/ws/daemon"
	if _, err := NormalizeConfig(cfg); err != nil {
		t.Fatalf("NormalizeConfig() with empty token error = %v, want nil", err)
	}
}

func TestNormalizeConfigTrimsServerCredentials(t *testing.T) {
	cfg := DefaultConfig()
	cfg.Device.ID = "dev_test"
	cfg.Server.URL = "  ws://localhost:18080/ws/daemon  "
	cfg.Server.Token = "  ps_test  "
	cfg.Workspaces = nil

	got, err := NormalizeConfig(cfg)
	if err != nil {
		t.Fatalf("NormalizeConfig() error = %v", err)
	}
	if got.Server.URL != "ws://localhost:18080/ws/daemon" {
		t.Fatalf("NormalizeConfig() server URL = %q, want trimmed URL", got.Server.URL)
	}
	if got.Server.Token != "ps_test" {
		t.Fatalf("NormalizeConfig() server token = %q, want trimmed token", got.Server.Token)
	}
}

func TestNormalizeDirectACPAgentsLocalFallback(t *testing.T) {
	cfg := DefaultConfig()
	opencodeAgent, ok := cfg.DirectACP.Agents["opencode"]
	if !ok {
		t.Fatalf("DefaultConfig() direct ACP agents missing 'opencode'")
	}
	codexAgent, ok := cfg.DirectACP.Agents["codex"]
	if !ok {
		t.Fatalf("DefaultConfig() direct ACP agents missing 'codex'")
	}
	kiloAgent, ok := cfg.DirectACP.Agents["kilo"]
	if !ok {
		t.Fatalf("DefaultConfig() direct ACP agents missing 'kilo'")
	}

	if path, err := exec.LookPath("opencode"); err == nil {
		if opencodeAgent.Command != path {
			t.Errorf("opencode Agent Command = %q, want resolved path %q", opencodeAgent.Command, path)
		}
		if len(opencodeAgent.Args) != 1 || opencodeAgent.Args[0] != "acp" {
			t.Errorf("opencode Agent Args = %v, want [\"acp\"]", opencodeAgent.Args)
		}
	} else {
		if opencodeAgent.Command != "npx" {
			t.Errorf("opencode Agent Command = %q, want \"npx\"", opencodeAgent.Command)
		}
	}

	if path, err := exec.LookPath("codex-acp"); err == nil {
		if codexAgent.Command != path {
			t.Errorf("codex Agent Command = %q, want resolved path %q", codexAgent.Command, path)
		}
		if len(codexAgent.Args) != 0 {
			t.Errorf("codex Agent Args = %v, want empty args", codexAgent.Args)
		}
	} else {
		if codexAgent.Command != "npx" {
			t.Errorf("codex Agent Command = %q, want \"npx\"", codexAgent.Command)
		}
	}

	if path, err := exec.LookPath("kilo"); err == nil {
		if kiloAgent.Command != path {
			t.Errorf("kilo Agent Command = %q, want resolved path %q", kiloAgent.Command, path)
		}
	} else if kiloAgent.Command != "kilo" {
		t.Errorf("kilo Agent Command = %q, want \"kilo\"", kiloAgent.Command)
	}
	if len(kiloAgent.Args) != 1 || kiloAgent.Args[0] != "acp" {
		t.Errorf("kilo Agent Args = %v, want [\"acp\"]", kiloAgent.Args)
	}
}

func TestSupportsTaskAgentForRuntimeUsesDirectACPConfig(t *testing.T) {
	cfg := DefaultConfig()
	cfg.ACPX.Enabled = true
	cfg.DirectACP.Enabled = true
	cfg.DirectACP.Agents = map[string]DirectACPAgentConfig{
		"kilo": {Command: "kilo", Args: []string{"acp"}},
	}
	d := New(cfg)

	if !d.supportsTaskAgentForRuntime("kilo", "direct_acp") {
		t.Fatal("supportsTaskAgentForRuntime(kilo, direct_acp) = false, want true")
	}
	if d.supportsTaskAgentForRuntime("kilo", "acpx") {
		t.Fatal("supportsTaskAgentForRuntime(kilo, acpx) = true, want false without ACPX kilocode support")
	}
}
