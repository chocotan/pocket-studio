package daemon

import (
	"path/filepath"
	"testing"

	"remote-agent/internal/protocol"
)

func TestProjectForDirectTerminalFallsBackToWorkspaceMapping(t *testing.T) {
	withSkillTestEnv(t, func(home string, configDir string) {
		d := &Daemon{
			cfg: Config{Device: DeviceConfig{ID: "dev_test"}},
			projects: map[string]protocol.Project{
				"ws_real": {ID: "ws_real", WorkspacePath: filepath.Join(home, "mapped")},
			},
		}
		// ws_mapped exists only in the workspace→ID map (never ProjectCreate'd).
		mapped := filepath.Join(home, "mapped-unopened")
		if err := saveWorkspaceProjectIDs(map[string]string{mapped: "ws_mapped_only"}); err != nil {
			t.Fatal(err)
		}

		if _, ok := d.projectForDirectTerminal("ws_missing"); ok {
			t.Fatal("unknown id must not resolve")
		}
		if _, ok := d.projectForDirectTerminal("ws_real"); !ok {
			t.Fatal("registered project must resolve")
		}
		project, ok := d.projectForDirectTerminal("ws_mapped_only")
		if !ok {
			t.Fatal("workspace-mapped id must resolve via fallback")
		}
		if project.WorkspacePath != mapped || !project.DirectMode {
			t.Fatalf("unexpected fallback project: %+v", project)
		}
	})
}
