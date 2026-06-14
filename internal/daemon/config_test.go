package daemon

import (
	"strings"
	"testing"
)

func TestNormalizeConfigRequiresServerURLAndToken(t *testing.T) {
	cfg := DefaultConfig()
	cfg.Device.ID = "dev_test"
	cfg.Workspaces = nil

	if _, err := NormalizeConfig(cfg); err == nil || !strings.Contains(err.Error(), "daemon.server.url") {
		t.Fatalf("NormalizeConfig() without server URL error = %v, want daemon.server.url error", err)
	}

	cfg.Server.URL = "ws://localhost:18080/ws/daemon"
	if _, err := NormalizeConfig(cfg); err == nil || !strings.Contains(err.Error(), "daemon.server.token") {
		t.Fatalf("NormalizeConfig() without server token error = %v, want daemon.server.token error", err)
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
