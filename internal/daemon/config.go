package daemon

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	"remote-agent/internal/hostinfo"
	"remote-agent/internal/protocol"
)

type Config struct {
	Device     DeviceConfig         `json:"device"`
	Server     ServerConfig         `json:"server"`
	ACPX       ACPXConfig           `json:"acpx"`
	DirectACP  DirectACPConfig      `json:"direct_acp"`
	DirectWeb  DirectWebConfig      `json:"direct_web"`
	Claude     ClaudeConfig         `json:"claude"`
	Workspaces []protocol.Workspace `json:"workspaces"`
}

type DeviceConfig struct {
	ID    string `json:"id"`
	Name  string `json:"name"`
	Alias string `json:"alias,omitempty"`
}

type ServerConfig struct {
	URL   string `json:"url"`
	Token string `json:"token,omitempty"`
}

type ClaudeConfig struct {
	Command string   `json:"command"`
	Args    []string `json:"args"`
}

type ACPXConfig struct {
	Enabled               bool     `json:"enabled"`
	Command               string   `json:"command"`
	Agent                 string   `json:"agent"`
	SessionName           string   `json:"session_name"`
	TTLSeconds            int      `json:"ttl_seconds"`
	CommandTimeoutSeconds int      `json:"command_timeout_seconds"`
	Args                  []string `json:"args"`
}

type DirectACPConfig struct {
	Enabled bool                            `json:"enabled"`
	Agents  map[string]DirectACPAgentConfig `json:"agents"`
}

type DirectACPAgentConfig struct {
	Command string            `json:"command"`
	Args    []string          `json:"args"`
	Env     map[string]string `json:"env"`
}

type DirectWebConfig struct {
	Enabled    bool   `json:"enabled"`
	ListenAddr string `json:"listen_addr"`
	PublicHost string `json:"public_host,omitempty"`
	Token      string `json:"token,omitempty"`
}

const ConfigFileName = "agentbridge.daemon.json"

func NormalizeConfig(cfg Config) (Config, error) {
	if strings.TrimSpace(cfg.Device.ID) == "" {
		device, err := loadOrCreateDeviceConfig(cfg.Device.Name)
		if err != nil {
			return cfg, err
		}
		device.Alias = cfg.Device.Alias
		cfg.Device = device
	}
	cfg.Device.Alias = strings.TrimSpace(cfg.Device.Alias)
	cfg.Device.Name = hostinfo.ResolveDeviceName(cfg.Device.Name)
	if strings.TrimSpace(cfg.Server.URL) == "" {
		return cfg, fmt.Errorf("daemon.server.url is required")
	}
	cfg.Server.URL = strings.TrimSpace(cfg.Server.URL)
	// The token is intentionally NOT required here. In local desktop mode the
	// bundled server runs with an empty admin token (open auth) and accepts an
	// empty daemon token; requiring one would make the daemon crash-loop on
	// startup. When the server has auth enabled, an empty/incorrect token is
	// rejected at the WebSocket handshake instead — the correct layer for it.
	cfg.Server.Token = strings.TrimSpace(cfg.Server.Token)
	if cfg.Claude.Command == "" {
		cfg.Claude.Command = "claude"
	}
	if cfg.ACPX.Command == "" {
		cfg.ACPX.Command = "acpx"
	}
	if cfg.ACPX.Agent == "" {
		cfg.ACPX.Agent = "claude"
	}
	if cfg.ACPX.TTLSeconds < 0 {
		return cfg, fmt.Errorf("acpx.ttl_seconds must be >= 0")
	}
	if cfg.ACPX.CommandTimeoutSeconds < 0 {
		return cfg, fmt.Errorf("acpx.command_timeout_seconds must be >= 0")
	}
	cfg.DirectACP.Agents = normalizeDirectACPAgents(cfg.DirectACP.Agents)
	if cfg.DirectWeb.ListenAddr == "" {
		cfg.DirectWeb.ListenAddr = ":18082"
	}
	cfg.DirectWeb.PublicHost = strings.TrimSpace(cfg.DirectWeb.PublicHost)
	if hostinfo.IsUnreportableHost(cfg.DirectWeb.PublicHost) {
		cfg.DirectWeb.PublicHost = ""
	}
	cfg.DirectWeb.Token = strings.TrimSpace(cfg.DirectWeb.Token)
	if len(cfg.Workspaces) == 0 {
		home, _ := os.UserHomeDir()
		cfg.Workspaces = []protocol.Workspace{{
			ID:   "agent-root",
			Name: "Agent",
			Path: filepath.Join(home, "Agent"),
		}}
	}
	for i := range cfg.Workspaces {
		if cfg.Workspaces[i].ID == "" {
			cfg.Workspaces[i].ID = cfg.Workspaces[i].Name
		}
		if cfg.Workspaces[i].Name == "" {
			cfg.Workspaces[i].Name = filepath.Base(cfg.Workspaces[i].Path)
		}
		if err := os.MkdirAll(cfg.Workspaces[i].Path, 0o755); err != nil {
			return cfg, fmt.Errorf("workspace %s: %w", cfg.Workspaces[i].Path, err)
		}
		real, err := filepath.EvalSymlinks(cfg.Workspaces[i].Path)
		if err != nil {
			return cfg, fmt.Errorf("workspace %s: %w", cfg.Workspaces[i].Path, err)
		}
		cfg.Workspaces[i].Path = real
	}
	return cfg, nil
}

func (cfg Config) DisplayDeviceName() string {
	if alias := strings.TrimSpace(cfg.Device.Alias); alias != "" {
		return alias
	}
	return hostinfo.ResolveDeviceName(cfg.Device.Name)
}

func DefaultConfig() Config {
	home, _ := os.UserHomeDir()
	return Config{
		Device: DeviceConfig{
			Name: hostinfo.DisplayName(),
		},
		Claude: ClaudeConfig{
			Command: "claude",
			Args:    []string{"--output-format", "stream-json", "--verbose"},
		},
		ACPX: ACPXConfig{
			Enabled:               true,
			Command:               "acpx",
			Agent:                 "claude",
			TTLSeconds:            300,
			CommandTimeoutSeconds: 1800,
			Args:                  []string{"--format", "json", "--approve-all"},
		},
		DirectACP: DirectACPConfig{
			Enabled: true,
			Agents:  normalizeDirectACPAgents(nil),
		},
		DirectWeb: DirectWebConfig{
			Enabled:    true,
			ListenAddr: ":18082",
		},
		Workspaces: []protocol.Workspace{
			{
				ID:   "agent-root",
				Name: "Agent",
				Path: filepath.Join(home, "Agent"),
			},
		},
	}
}

func normalizeDirectACPAgents(agents map[string]DirectACPAgentConfig) map[string]DirectACPAgentConfig {
	out := make(map[string]DirectACPAgentConfig)
	for key, value := range agents {
		normalized := strings.ToLower(strings.TrimSpace(key))
		if normalized == "" {
			continue
		}
		out[normalized] = value
	}
	if _, ok := out["codex"]; !ok {
		if path, err := exec.LookPath("codex-acp"); err == nil {
			out["codex"] = DirectACPAgentConfig{Command: path, Args: []string{}}
		} else {
			out["codex"] = DirectACPAgentConfig{Command: "npx", Args: []string{"@zed-industries/codex-acp@latest"}}
		}
	}
	if _, ok := out["opencode"]; !ok {
		if path, err := exec.LookPath("opencode"); err == nil {
			out["opencode"] = DirectACPAgentConfig{Command: path, Args: []string{"acp"}}
		} else {
			out["opencode"] = DirectACPAgentConfig{Command: "npx", Args: []string{"opencode-ai@latest", "acp"}}
		}
	}
	if _, ok := out["kilo"]; !ok {
		if path, err := exec.LookPath("kilo"); err == nil {
			out["kilo"] = DirectACPAgentConfig{Command: path, Args: []string{"acp"}}
		} else {
			out["kilo"] = DirectACPAgentConfig{Command: "kilo", Args: []string{"acp"}}
		}
	}
	return out
}

func daemonDevicePath() string {
	return filepath.Join(daemonConfigDir(), "device.json")
}

func loadOrCreateDeviceConfig(name string) (DeviceConfig, error) {
	if raw, err := os.ReadFile(daemonDevicePath()); err == nil {
		var device DeviceConfig
		if err := json.Unmarshal(raw, &device); err != nil {
			return DeviceConfig{}, err
		}
		if strings.TrimSpace(device.ID) != "" {
			changed := false
			if strings.TrimSpace(name) != "" {
				nextName := hostinfo.ResolveDeviceName(name)
				if device.Name != nextName {
					device.Name = nextName
					changed = true
				}
			} else if strings.TrimSpace(device.Name) == "" || hostinfo.HasEmbeddedUnreportableIPv4(device.Name) {
				device.Name = hostinfo.DisplayName()
				changed = true
			}
			if changed {
				if err := saveDeviceConfig(device); err != nil {
					return DeviceConfig{}, err
				}
			}
			return device, nil
		}
	} else if !os.IsNotExist(err) {
		return DeviceConfig{}, err
	}

	device := DeviceConfig{
		ID:   randomDeviceID(),
		Name: name,
	}
	if strings.TrimSpace(device.Name) == "" {
		device.Name = hostinfo.DisplayName()
	}
	device.Name = hostinfo.ResolveDeviceName(device.Name)
	if err := saveDeviceConfig(device); err != nil {
		return DeviceConfig{}, err
	}
	return device, nil
}

func saveDeviceConfig(device DeviceConfig) error {
	if err := os.MkdirAll(filepath.Dir(daemonDevicePath()), 0o755); err != nil {
		return err
	}
	raw, err := json.MarshalIndent(device, "", "  ")
	if err != nil {
		return err
	}
	if err := os.WriteFile(daemonDevicePath(), append(raw, '\n'), 0o600); err != nil {
		return err
	}
	return nil
}

func ConfigFilePath() string {
	return filepath.Join(daemonConfigDir(), ConfigFileName)
}

func LoadConfigFile() (Config, error) {
	cfg := DefaultConfig()
	path := ConfigFilePath()
	raw, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return cfg, nil
		}
		return cfg, err
	}
	if err := json.Unmarshal(raw, &cfg); err != nil {
		return cfg, fmt.Errorf("%s: %w", path, err)
	}
	return cfg, nil
}

func SaveConfigFile(cfg Config) error {
	path := ConfigFilePath()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	raw, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, append(raw, '\n'), 0o600)
}

func randomDeviceID() string {
	var buf [8]byte
	if _, err := rand.Read(buf[:]); err != nil {
		sum := hex.EncodeToString([]byte(hostinfo.DisplayName() + "-" + fmt.Sprint(os.Getpid())))
		if len(sum) > 16 {
			sum = sum[:16]
		}
		return "dev_" + sum
	}
	return "dev_" + hex.EncodeToString(buf[:])
}
