package daemon

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestUpsertDshProfileHookPatchPreservesUserRows(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "cordis.patch.yml")
	existing := "# user comment\n- id: agent-loop\n  config:\n    agents:\n      - id: main\n        provider: newapi\n        model: deepseek-v4-flash\n        cwd: !!js process.cwd()\n"
	if err := os.WriteFile(path, []byte(existing), 0o644); err != nil {
		t.Fatal(err)
	}
	patch := dshProfileHookPatch("/tmp/hooks.json")
	if err := upsertDshProfileHookPatch(path, patch); err != nil {
		t.Fatal(err)
	}
	raw, _ := os.ReadFile(path)
	content := string(raw)
	if !strings.Contains(content, "provider: newapi") {
		t.Fatalf("user rows lost:\n%s", content)
	}
	if !strings.Contains(content, "pocket-studio-hooks") {
		t.Fatalf("managed block missing:\n%s", content)
	}
	if strings.Count(content, "- insert:") != 1 {
		t.Fatalf("unexpected insert count:\n%s", content)
	}
	// idempotent re-run
	if err := upsertDshProfileHookPatch(path, patch); err != nil {
		t.Fatal(err)
	}
	raw2, _ := os.ReadFile(path)
	if string(raw2) != content {
		t.Fatalf("not idempotent:\n%s\n---\n%s", content, raw2)
	}
	// replaces an older managed block with a different configPath
	patch2 := dshProfileHookPatch("/tmp/other-hooks.json")
	if err := upsertDshProfileHookPatch(path, patch2); err != nil {
		t.Fatal(err)
	}
	raw3, _ := os.ReadFile(path)
	if strings.Count(string(raw3), "Managed by Pocket Studio") != 1 {
		t.Fatalf("old managed block not replaced:\n%s", raw3)
	}
	if !strings.Contains(string(raw3), "/tmp/other-hooks.json") {
		t.Fatalf("new configPath missing:\n%s", raw3)
	}
}

func TestUpsertDshProfileHookPatchOnMissingFile(t *testing.T) {
	path := filepath.Join(t.TempDir(), "nested", "cordis.patch.yml")
	if err := upsertDshProfileHookPatch(path, dshProfileHookPatch("/tmp/h.json")); err != nil {
		t.Fatal(err)
	}
	raw, _ := os.ReadFile(path)
	if !strings.Contains(string(raw), "pocket-studio-hooks") {
		t.Fatalf("content:\n%s", raw)
	}
}

func TestNormalizeDshACPConfigRepairsUnpinnedEntry(t *testing.T) {
	fresh := normalizeDshACPConfig(DirectACPAgentConfig{
		Command: "npx",
		Args:    []string{"-y", "@deepseek-ai/dsh-acp-demo@latest", "--config", "/old/cordis.yml"},
	})
	if strings.Contains(strings.Join(fresh.Args, " "), "@latest") {
		t.Fatalf("unpinned entry not repaired: %v", fresh.Args)
	}
	if !strings.Contains(strings.Join(fresh.Args, " "), dshACPPluginVersion) {
		t.Fatalf("pinned version missing: %v", fresh.Args)
	}

	custom := normalizeDshACPConfig(DirectACPAgentConfig{
		Command: "/usr/local/bin/dsh-acp-demo",
		Args:    []string{"--config", "/custom/cordis.yml"},
	})
	if custom.Command != "/usr/local/bin/dsh-acp-demo" || len(custom.Args) != 2 {
		t.Fatalf("custom entry should stay untouched: %+v", custom)
	}
}

func TestEnsureDshACPCordisConfigWritesTree(t *testing.T) {
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	if err := ensureDshACPCordisConfig(); err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile(dshACPCordisPath())
	if err != nil {
		t.Fatal(err)
	}
	content := string(raw)
	for _, want := range []string{
		"@deepseek-ai/dsh-llm-deepseek",
		"@deepseek-ai/dsh-sandbox-policy",
		"@deepseek-ai/dsh-bash-sandbox",
		"@deepseek-ai/dsh-acp-demo",
		"deepseek-v4-pro",
		"persona: |",
	} {
		if !strings.Contains(content, want) {
			t.Fatalf("cordis.yml missing %q:\n%s", want, content)
		}
	}
	// idempotent
	if err := ensureDshACPCordisConfig(); err != nil {
		t.Fatal(err)
	}
	raw2, _ := os.ReadFile(dshACPCordisPath())
	if string(raw2) != content {
		t.Fatalf("ensureDshACPCordisConfig not idempotent")
	}
}
