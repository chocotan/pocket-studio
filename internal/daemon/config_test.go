package daemon

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"remote-agent/internal/protocol"
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

func TestDisplayDeviceNamePrefersAlias(t *testing.T) {
	cfg := DefaultConfig()
	cfg.Device.ID = "dev_test"
	cfg.Device.Name = "host-name"
	cfg.Device.Alias = "  Build Box  "
	cfg.Server.URL = "ws://localhost:18080/ws/daemon"
	cfg.Workspaces = nil

	got, err := NormalizeConfig(cfg)
	if err != nil {
		t.Fatalf("NormalizeConfig() error = %v", err)
	}
	if got.Device.Alias != "Build Box" {
		t.Fatalf("NormalizeConfig() alias = %q, want trimmed alias", got.Device.Alias)
	}
	if got.DisplayDeviceName() != "Build Box" {
		t.Fatalf("DisplayDeviceName() = %q, want alias", got.DisplayDeviceName())
	}
}

func TestSaveConfigFilePersistsDeviceAlias(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("POCKET_STUDIO_DAEMON_CONFIG_DIR", dir)
	cfg := DefaultConfig()
	cfg.Device.ID = "dev_test"
	cfg.Device.Name = "host-name"
	cfg.Device.Alias = "Desk Rig"
	cfg.Server.URL = "ws://localhost:18080/ws/daemon"
	cfg.Workspaces = nil

	got, err := NormalizeConfig(cfg)
	if err != nil {
		t.Fatalf("NormalizeConfig() error = %v", err)
	}
	if err := SaveConfigFile(got); err != nil {
		t.Fatalf("SaveConfigFile() error = %v", err)
	}
	loaded, err := LoadConfigFile()
	if err != nil {
		t.Fatalf("LoadConfigFile() error = %v", err)
	}
	if loaded.Device.Alias != "Desk Rig" {
		t.Fatalf("loaded alias = %q, want persisted alias", loaded.Device.Alias)
	}
}

func TestNormalizeConfigDropsUnreportableDirectWebPublicHost(t *testing.T) {
	cfg := DefaultConfig()
	cfg.Device.ID = "dev_test"
	cfg.Server.URL = "ws://localhost:18080/ws/daemon"
	cfg.DirectWeb.PublicHost = "172.18.0.1"
	cfg.Workspaces = nil

	got, err := NormalizeConfig(cfg)
	if err != nil {
		t.Fatalf("NormalizeConfig() error = %v", err)
	}
	if got.DirectWeb.PublicHost != "" {
		t.Fatalf("NormalizeConfig() public host = %q, want empty fallback", got.DirectWeb.PublicHost)
	}
}

func TestLoadOrCreateDeviceConfigRefreshesAndPersistsStaleDockerName(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("POCKET_STUDIO_DAEMON_CONFIG_DIR", dir)
	stale := DeviceConfig{ID: "dev_test", Name: "xps9500 (172.18.0.1)"}
	raw, err := json.Marshal(stale)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "device.json"), raw, 0o600); err != nil {
		t.Fatal(err)
	}

	got, err := loadOrCreateDeviceConfig("")
	if err != nil {
		t.Fatalf("loadOrCreateDeviceConfig() error = %v", err)
	}
	if got.Name == stale.Name || strings.Contains(got.Name, "172.18.0.1") {
		t.Fatalf("loadOrCreateDeviceConfig() name = %q, want refreshed", got.Name)
	}
	raw, err = os.ReadFile(filepath.Join(dir, "device.json"))
	if err != nil {
		t.Fatal(err)
	}
	var persisted DeviceConfig
	if err := json.Unmarshal(raw, &persisted); err != nil {
		t.Fatal(err)
	}
	if persisted.Name != got.Name {
		t.Fatalf("persisted name = %q, want %q", persisted.Name, got.Name)
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

func TestAgentCapabilitiesOnlyReportInstalledAgents(t *testing.T) {
	dir := t.TempDir()
	for _, name := range []string{"qwen", "cursor-agent", "kilo", "agy"} {
		path := filepath.Join(dir, name)
		if err := os.WriteFile(path, []byte("#!/bin/sh\nexit 0\n"), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	t.Setenv("PATH", dir)

	cfg := DefaultConfig()
	cfg.ACPX.Enabled = true
	cfg.ACPX.Agent = "qwen"
	d := New(cfg)

	got := capabilityNames(d.agentCapabilities())
	want := []string{"qwen", "cursor", "kilocode", "antigravity"}
	if strings.Join(got, ",") != strings.Join(want, ",") {
		t.Fatalf("agentCapabilities() names = %v, want %v", got, want)
	}
}

func TestAgentCapabilitiesReportEmptyListWhenNothingInstalled(t *testing.T) {
	t.Setenv("PATH", t.TempDir())

	cfg := DefaultConfig()
	cfg.ACPX.Enabled = true
	d := New(cfg)

	if got := d.agentCapabilities(); len(got) != 0 {
		t.Fatalf("agentCapabilities() = %v, want empty", got)
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
	if !d.supportsTaskAgentForRuntime("kilo", "acpx") {
		t.Fatal("supportsTaskAgentForRuntime(kilo, acpx) = false, want true with ACPX kilocode support")
	}
}

func capabilityNames(caps []protocol.AgentCapability) []string {
	names := make([]string, 0, len(caps))
	for _, cap := range caps {
		names = append(names, cap.Name)
	}
	return names
}
