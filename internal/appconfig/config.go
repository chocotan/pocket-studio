package appconfig

import (
	"encoding/json"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"strings"
)

const (
	DefaultServerURL = "http://127.0.0.1:18080"
	configFileName   = "client.json"
)

type Config struct {
	ServerURL string `json:"server_url"`
	LocalMode bool   `json:"local_mode"`
}

func Default() Config {
	return Config{
		ServerURL: DefaultServerURL,
		LocalMode: true,
	}
}

func Load(path string) (Config, error) {
	cfg := Default()
	if path == "" {
		path = DefaultPath()
	}
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return cfg, nil
		}
		return cfg, err
	}
	if err := json.Unmarshal(data, &cfg); err != nil {
		return cfg, err
	}
	cfg.ServerURL = strings.TrimRight(strings.TrimSpace(cfg.ServerURL), "/")
	if cfg.ServerURL == "" {
		cfg.ServerURL = DefaultServerURL
	}
	return cfg, nil
}

func Save(path string, cfg Config) error {
	if path == "" {
		path = DefaultPath()
	}
	cfg.ServerURL = strings.TrimRight(strings.TrimSpace(cfg.ServerURL), "/")
	if cfg.ServerURL == "" {
		cfg.ServerURL = DefaultServerURL
	}
	data, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	return os.WriteFile(path, append(data, '\n'), 0o600)
}

func DefaultPath() string {
	if dir := os.Getenv("POCKET_STUDIO_CONFIG_DIR"); dir != "" {
		return filepath.Join(dir, configFileName)
	}
	if home, err := os.UserHomeDir(); err == nil && home != "" {
		return filepath.Join(home, ".config", "pocket-studio", configFileName)
	}
	return configFileName
}

func DaemonWebSocketURL(serverURL string) (string, error) {
	base, err := parseServerURL(serverURL)
	if err != nil {
		return "", err
	}
	switch base.Scheme {
	case "http":
		base.Scheme = "ws"
	case "https":
		base.Scheme = "wss"
	case "ws", "wss":
	default:
		return "", fmt.Errorf("unsupported server URL scheme %q", base.Scheme)
	}
	base.Path = joinURLPath(base.Path, "/ws/daemon")
	base.RawQuery = ""
	base.Fragment = ""
	return base.String(), nil
}

func parseServerURL(raw string) (*url.URL, error) {
	value := strings.TrimRight(strings.TrimSpace(raw), "/")
	if value == "" {
		value = DefaultServerURL
	}
	if !strings.Contains(value, "://") {
		value = "http://" + value
	}
	parsed, err := url.Parse(value)
	if err != nil {
		return nil, err
	}
	if parsed.Host == "" {
		return nil, fmt.Errorf("server URL must include a host")
	}
	return parsed, nil
}

func joinURLPath(basePath string, suffix string) string {
	basePath = strings.TrimRight(basePath, "/")
	if basePath == "" {
		return suffix
	}
	return basePath + suffix
}
