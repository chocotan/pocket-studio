package main

import (
	"os"
	"path/filepath"
	"testing"

	"remote-agent/internal/daemon"
)

func TestConfigFromArgsLoadsAliasFromConfigFile(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("POCKET_STUDIO_DAEMON_CONFIG_DIR", dir)
	raw := `{
  "device": {
    "id": "dev_config",
    "name": "host-name",
    "alias": "Office Workstation"
  },
  "server": {
    "url": "ws://localhost:18080/ws/daemon"
  },
  "workspaces": [
    {
      "id": "workspace",
      "name": "Workspace",
      "path": "` + filepath.ToSlash(dir) + `"
    }
  ]
}`
	if err := os.WriteFile(filepath.Join(dir, daemon.ConfigFileName), []byte(raw), 0o600); err != nil {
		t.Fatal(err)
	}

	cfg, err := configFromArgs(nil)
	if err != nil {
		t.Fatalf("configFromArgs() error = %v", err)
	}
	if cfg.Device.Alias != "Office Workstation" {
		t.Fatalf("configFromArgs() alias = %q, want config alias", cfg.Device.Alias)
	}
	if cfg.DisplayDeviceName() != "Office Workstation" {
		t.Fatalf("DisplayDeviceName() = %q, want config alias", cfg.DisplayDeviceName())
	}
}

func TestConfigFromArgsAllowsAliasFlagOverride(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("POCKET_STUDIO_DAEMON_CONFIG_DIR", dir)
	raw := `{
  "device": {
    "id": "dev_config",
    "name": "host-name",
    "alias": "Office Workstation"
  },
  "server": {
    "url": "ws://localhost:18080/ws/daemon"
  },
  "workspaces": [
    {
      "id": "workspace",
      "name": "Workspace",
      "path": "` + filepath.ToSlash(dir) + `"
    }
  ]
}`
	if err := os.WriteFile(filepath.Join(dir, daemon.ConfigFileName), []byte(raw), 0o600); err != nil {
		t.Fatal(err)
	}

	cfg, err := configFromArgs([]string{"-daemon.device.alias", "Laptop"})
	if err != nil {
		t.Fatalf("configFromArgs() error = %v", err)
	}
	if cfg.Device.Alias != "Laptop" {
		t.Fatalf("configFromArgs() alias = %q, want flag alias", cfg.Device.Alias)
	}
}
