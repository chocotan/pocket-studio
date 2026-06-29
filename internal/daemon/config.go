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
	Claude     ClaudeConfig         `json:"claude"`
	Workspaces []protocol.Workspace `json:"workspaces"`
}

type DeviceConfig struct {
	ID   string `json:"id"`
	Name string `json:"name"`
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

func NormalizeConfig(cfg Config) (Config, error) {
	if strings.TrimSpace(cfg.Device.ID) == "" {
		device, err := loadOrCreateDeviceConfig(cfg.Device.Name)
		if err != nil {
			return cfg, err
		}
		cfg.Device = device
	}
	cfg.Device.Name = hostinfo.ResolveDeviceName(cfg.Device.Name)
	if strings.TrimSpace(cfg.Server.URL) == "" {
		return cfg, fmt.Errorf("daemon.server.url is required")
	}
	cfg.Server.URL = strings.TrimSpace(cfg.Server.URL)
	if strings.TrimSpace(cfg.Server.Token) == "" {
		return cfg, fmt.Errorf("daemon.server.token is required")
	}
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
			if strings.TrimSpace(name) != "" {
				device.Name = name
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
	if err := os.MkdirAll(filepath.Dir(daemonDevicePath()), 0o755); err != nil {
		return DeviceConfig{}, err
	}
	raw, err := json.MarshalIndent(device, "", "  ")
	if err != nil {
		return DeviceConfig{}, err
	}
	if err := os.WriteFile(daemonDevicePath(), append(raw, '\n'), 0o600); err != nil {
		return DeviceConfig{}, err
	}
	return device, nil
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
