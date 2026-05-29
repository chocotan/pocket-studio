package daemon

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"

	"remote-agent/internal/hostinfo"
	"remote-agent/internal/protocol"
)

type Config struct {
	Device     DeviceConfig         `json:"device"`
	Server     ServerConfig         `json:"server"`
	ACPX       ACPXConfig           `json:"acpx"`
	Claude     ClaudeConfig         `json:"claude"`
	Workspaces []protocol.Workspace `json:"workspaces"`
}

type DeviceConfig struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

type ServerConfig struct {
	URL string `json:"url"`
}

type ClaudeConfig struct {
	Command string   `json:"command"`
	Args    []string `json:"args"`
}

type ACPXConfig struct {
	Enabled     bool     `json:"enabled"`
	Command     string   `json:"command"`
	Agent       string   `json:"agent"`
	SessionName string   `json:"session_name"`
	TTLSeconds  int      `json:"ttl_seconds"`
	Args        []string `json:"args"`
}

func LoadConfig(path string) (Config, error) {
	var cfg Config
	data, err := os.ReadFile(path)
	if err != nil {
		return cfg, err
	}
	if err := json.Unmarshal(data, &cfg); err != nil {
		return cfg, err
	}
	if cfg.Device.ID == "" {
		return cfg, fmt.Errorf("device.id is required")
	}
	cfg.Device.Name = hostinfo.ResolveDeviceName(cfg.Device.Name)
	if cfg.Server.URL == "" {
		cfg.Server.URL = "ws://localhost:8080/ws/daemon"
	}
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

func ExampleConfig() Config {
	home, _ := os.UserHomeDir()
	return Config{
		Device: DeviceConfig{
			ID:   "dev_local",
			Name: hostinfo.DisplayName(),
		},
		Server: ServerConfig{
			URL: "ws://localhost:8080/ws/daemon",
		},
		Claude: ClaudeConfig{
			Command: "claude",
			Args:    []string{"--output-format", "stream-json", "--verbose"},
		},
		ACPX: ACPXConfig{
			Enabled:    true,
			Command:    "acpx",
			Agent:      "claude",
			TTLSeconds: 300,
			Args:       []string{"--format", "json", "--approve-all"},
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

func WriteExampleConfig(path string) error {
	cfg := ExampleConfig()
	data, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, append(data, '\n'), 0o600)
}
