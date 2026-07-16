package daemon

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"slices"
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
	claudeAgent, ok := cfg.DirectACP.Agents["claude"]
	if !ok {
		t.Fatalf("DefaultConfig() direct ACP agents missing 'claude'")
	}
	piAgent, ok := cfg.DirectACP.Agents["pi"]
	if !ok {
		t.Fatalf("DefaultConfig() direct ACP agents missing 'pi'")
	}
	qwenAgent, ok := cfg.DirectACP.Agents["qwen"]
	if !ok {
		t.Fatalf("DefaultConfig() direct ACP agents missing 'qwen'")
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
		if strings.Join(codexAgent.Args, " ") != "-y @agentclientprotocol/codex-acp@latest" {
			t.Errorf("codex Agent Args = %v, want official codex-acp fallback", codexAgent.Args)
		}
	}

	if path, err := exec.LookPath("kilo"); err == nil {
		if kiloAgent.Command != path {
			t.Errorf("kilo Agent Command = %q, want resolved path %q", kiloAgent.Command, path)
		}
	} else if kiloAgent.Command != "kilo" {
		t.Errorf("kilo Agent Command = %q, want \"kilo\"", kiloAgent.Command)
	}
	if strings.Join(kiloAgent.Args, " ") != "acp --pure" {
		t.Errorf("kilo Agent Args = %v, want [\"acp\", \"--pure\"]", kiloAgent.Args)
	}

	assertDirectACPAdapter(t, "claude", claudeAgent, "claude-agent-acp", []string{"-y", "@agentclientprotocol/claude-agent-acp@latest"})
	assertDirectACPAdapter(t, "pi", piAgent, "pi-acp", []string{"-y", "pi-acp@latest"})
	if path, err := exec.LookPath("qwen"); err == nil {
		if qwenAgent.Command != path || strings.Join(qwenAgent.Args, " ") != "--acp" {
			t.Errorf("qwen Agent = %q %v, want %q [--acp]", qwenAgent.Command, qwenAgent.Args, path)
		}
	} else if qwenAgent.Command != "npx" || strings.Join(qwenAgent.Args, " ") != "-y @qwen-code/qwen-code@latest --acp" {
		t.Errorf("qwen Agent = %q %v, want qwen-code npx fallback", qwenAgent.Command, qwenAgent.Args)
	}
}

func TestLoadQualificationAgentConfigsLabelsPersistedAndDefaultAgents(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("POCKET_STUDIO_DAEMON_CONFIG_DIR", dir)
	raw := []byte(`{
		"direct_acp": {
			"agents": {
				"codex": {
					"command": "/opt/custom/codex-acp",
					"args": ["serve", "--custom"],
					"env": {"QUALIFICATION_SECRET": "not-for-reporting"}
				}
			}
		}
	}`)
	if err := os.WriteFile(filepath.Join(dir, ConfigFileName), raw, 0o600); err != nil {
		t.Fatal(err)
	}

	agents, err := LoadQualificationAgentConfigs()
	if err != nil {
		t.Fatalf("LoadQualificationAgentConfigs() error = %v", err)
	}
	codex := agents["codex"]
	if codex.Command != "/opt/custom/codex-acp" || strings.Join(codex.Args, " ") != "serve --custom" {
		t.Fatalf("codex config = %#v, want persisted command and args", codex)
	}
	if codex.Source != "normalized_persisted_config" || codex.Env["QUALIFICATION_SECRET"] != "not-for-reporting" {
		t.Fatalf("codex qualification metadata = %#v", codex)
	}
	encoded, err := json.Marshal(agents)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(encoded), "not-for-reporting") || !strings.Contains(string(encoded), "QUALIFICATION_SECRET") {
		t.Fatalf("serialized qualification config must contain env key but not value: %s", encoded)
	}
	if got := agents["qwen"].Source; got != "built_in_default" {
		t.Fatalf("qwen source = %q, want built_in_default", got)
	}
}

func TestNormalizeDirectACPAgentsMigratesLegacyCodexNpxPackage(t *testing.T) {
	t.Setenv("PATH", t.TempDir())
	tests := []struct {
		name    string
		command string
		args    []string
		want    []string
	}{
		{"npx unversioned", "npx", []string{"@zed-industries/codex-acp"}, []string{"-y", "@agentclientprotocol/codex-acp@latest"}},
		{"npx latest", "npx", []string{"@zed-industries/codex-acp@latest"}, []string{"-y", "@agentclientprotocol/codex-acp@latest"}},
		{"npx yes unversioned", "npx", []string{"-y", "@zed-industries/codex-acp"}, []string{"-y", "@agentclientprotocol/codex-acp@latest"}},
		{"npx yes latest", "npx", []string{"-y", "@zed-industries/codex-acp@latest"}, []string{"-y", "@agentclientprotocol/codex-acp@latest"}},
		{"npx.cmd long yes", "npx.cmd", []string{"--yes", "@zed-industries/codex-acp"}, []string{"-y", "@agentclientprotocol/codex-acp@latest"}},
		{"npx.cmd long yes latest", "npx.cmd", []string{"--yes", "@zed-industries/codex-acp@latest"}, []string{"-y", "@agentclientprotocol/codex-acp@latest"}},
		{"pinned version", "npx.cmd", []string{"-y", "@zed-industries/codex-acp@0.16.0"}, []string{"-y", "@zed-industries/codex-acp@0.16.0"}},
		{"custom trailing flag", "npx", []string{"-y", "@zed-industries/codex-acp", "--flag"}, []string{"-y", "@zed-industries/codex-acp", "--flag"}},
		{"custom leading flag", "npx", []string{"--quiet", "@zed-industries/codex-acp"}, []string{"--quiet", "@zed-industries/codex-acp"}},
		{"official package", "npx", []string{"-y", "@agentclientprotocol/codex-acp@latest"}, []string{"-y", "@agentclientprotocol/codex-acp@latest"}},
		{"custom command", "codex-acp", []string{"@zed-industries/codex-acp@latest"}, []string{"@zed-industries/codex-acp@latest"}},
		{"similar package", "npx", []string{"@zed-industries/codex-acp-helper"}, []string{"@zed-industries/codex-acp-helper"}},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			env := map[string]string{"CODEX_ENV": "preserved"}
			agents := normalizeDirectACPAgents(map[string]DirectACPAgentConfig{
				" Codex ": {Command: tc.command, Args: tc.args, Env: env},
			})
			got := agents["codex"]
			if strings.Join(got.Args, "\x00") != strings.Join(tc.want, "\x00") {
				t.Fatalf("normalized args = %#v, want %#v", got.Args, tc.want)
			}
			if got.Command != tc.command || got.Env["CODEX_ENV"] != "preserved" {
				t.Fatalf("normalized config = %#v, want command and Env preserved", got)
			}
		})
	}
}

func TestNormalizeDirectACPAgentsPrefersInstalledOfficialCodexAdapter(t *testing.T) {
	dir := t.TempDir()
	adapter := filepath.Join(dir, "codex-acp")
	if err := os.WriteFile(adapter, []byte("#!/bin/sh\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", dir)
	env := map[string]string{"CODEX_ENV": "preserved"}
	agent := normalizeDirectACPAgents(map[string]DirectACPAgentConfig{
		"codex": {Command: "npx", Args: []string{"@agentclientprotocol/codex-acp@latest"}, Env: env},
	})["codex"]
	if agent.Command != adapter || len(agent.Args) != 0 {
		t.Fatalf("codex adapter = %q %#v, want installed adapter %q", agent.Command, agent.Args, adapter)
	}
	if agent.Env["CODEX_ENV"] != "preserved" {
		t.Fatalf("codex env = %#v, want preserved", agent.Env)
	}
}

func TestNormalizeDirectACPAgentsCodexFallbackIsNoninteractiveWithoutInstalledAdapter(t *testing.T) {
	t.Setenv("PATH", t.TempDir())
	agent := normalizeDirectACPAgents(nil)["codex"]
	if agent.Command != "npx" || strings.Join(agent.Args, " ") != "-y @agentclientprotocol/codex-acp@latest" {
		t.Fatalf("codex fallback = %q %#v, want noninteractive official npx fallback", agent.Command, agent.Args)
	}
}

func TestNormalizeDirectACPAgentsMigratesLegacyKiloACPCommand(t *testing.T) {
	tests := []struct {
		name    string
		command string
		args    []string
		want    []string
	}{
		{"absolute kilo", "/opt/kilo/bin/kilo", []string{"acp"}, []string{"acp", "--pure"}},
		{"windows kilocode", `C:\\Tools\\kilocode.cmd`, []string{"acp"}, []string{"acp", "--pure"}},
		{"already pure", "kilo", []string{"acp", "--pure"}, []string{"acp", "--pure"}},
		{"custom flags", "kilo", []string{"acp", "--port", "4321"}, []string{"acp", "--port", "4321"}},
		{"custom wrapper", "/opt/bin/company-kilo", []string{"acp"}, []string{"acp"}},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			env := map[string]string{"KILO_ENV": "preserved"}
			agents := normalizeDirectACPAgents(map[string]DirectACPAgentConfig{
				"kilo": {Command: tc.command, Args: tc.args, Env: env},
			})
			got := agents["kilo"]
			if strings.Join(got.Args, "\x00") != strings.Join(tc.want, "\x00") {
				t.Fatalf("normalized args = %#v, want %#v", got.Args, tc.want)
			}
			if got.Command != tc.command || got.Env["KILO_ENV"] != "preserved" {
				t.Fatalf("normalized config = %#v, want command and Env preserved", got)
			}
		})
	}
}

func assertDirectACPAdapter(t *testing.T, agent string, got DirectACPAgentConfig, executable string, fallbackArgs []string) {
	t.Helper()
	if path, err := exec.LookPath(executable); err == nil {
		if got.Command != path || len(got.Args) != 0 {
			t.Errorf("%s Agent = %q %v, want %q with no args", agent, got.Command, got.Args, path)
		}
		return
	}
	if got.Command != "npx" || strings.Join(got.Args, " ") != strings.Join(fallbackArgs, " ") {
		t.Errorf("%s Agent = %q %v, want npx %v", agent, got.Command, got.Args, fallbackArgs)
	}
}

func TestSupportsTaskAgentForRuntimeUsesDirectACPConfig(t *testing.T) {
	cfg := DefaultConfig()
	cfg.DirectACP.Enabled = true
	cfg.DirectACP.Agents = map[string]DirectACPAgentConfig{
		"kilo": {Command: "kilo", Args: []string{"acp"}},
	}
	d := New(cfg)

	if !d.supportsTaskAgentForRuntime("kilo", "direct_acp") {
		t.Fatal("supportsTaskAgentForRuntime(kilo, direct_acp) = false, want true")
	}
}

func capabilityNames(caps []protocol.AgentCapability) []string {
	names := make([]string, 0, len(caps))
	for _, cap := range caps {
		names = append(names, cap.Name)
	}
	return names
}

func TestAgentCapabilitiesIncludeInstalledAntigravityTerminal(t *testing.T) {
	bin := t.TempDir()
	executable := filepath.Join(bin, "agy")
	if runtime.GOOS == "windows" {
		executable += ".exe"
	}
	if err := os.WriteFile(executable, []byte(""), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", bin)
	d := New(Config{DirectACP: DirectACPConfig{Agents: map[string]DirectACPAgentConfig{}}})
	if !slices.Contains(capabilityNames(d.agentCapabilities()), "antigravity") {
		t.Fatalf("agent capabilities = %#v, want antigravity", d.agentCapabilities())
	}
}
