package daemon

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"remote-agent/internal/protocol"
)

// withSkillTestEnv redirects the skill roots into a temp home/config so tests
// never touch the real ~/.agents/skills or the real config dir.
func withSkillTestEnv(t *testing.T, fn func(home string, configDir string)) {
	t.Helper()
	home := t.TempDir()
	configDir := filepath.Join(home, ".config")
	t.Setenv("HOME", home)
	t.Setenv("XDG_CONFIG_HOME", configDir)
	// os.UserHomeDir caches nothing on Linux (reads $HOME), so this is safe.
	fn(home, configDir)
}

func writeTestSkill(t *testing.T, root string, name string, description string) string {
	t.Helper()
	dir := filepath.Join(root, name)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	content := "---\nname: " + name + "\ndescription: " + description + "\n---\n\n# " + name + "\n"
	if err := os.WriteFile(filepath.Join(dir, "SKILL.md"), []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
	return dir
}

func TestScanSkillRootDiscoversBothSources(t *testing.T) {
	withSkillTestEnv(t, func(home string, configDir string) {
		shared := filepath.Join(home, ".agents", "skills")
		store := skillStoreRoot()
		writeTestSkill(t, shared, "pdf-tools", "PDF processing")
		writeTestSkill(t, store, "novel-toolkit", "Novel writing")

		catalog := listSkillCatalog()
		if len(catalog) != 2 {
			t.Fatalf("expected 2 skills, got %d: %+v", len(catalog), catalog)
		}
		sources := map[string]string{}
		for _, s := range catalog {
			sources[s.Name] = s.Source
		}
		if sources["pdf-tools"] != skillSourceShared {
			t.Errorf("pdf-tools should be shared-global, got %s", sources["pdf-tools"])
		}
		if sources["novel-toolkit"] != skillSourceStore {
			t.Errorf("novel-toolkit should be store, got %s", sources["novel-toolkit"])
		}
		for _, s := range catalog {
			if !s.Valid {
				t.Errorf("skill %s should validate, issue: %s", s.Name, s.Issue)
			}
		}
	})
}

func TestScanSkipsInvalidFrontmatter(t *testing.T) {
	withSkillTestEnv(t, func(home string, configDir string) {
		shared := filepath.Join(home, ".agents", "skills")
		// missing description
		dir := filepath.Join(shared, "broken")
		os.MkdirAll(dir, 0o755)
		os.WriteFile(filepath.Join(dir, "SKILL.md"), []byte("---\nname: broken\n---\nbody"), 0o644)
		writeTestSkill(t, shared, "good-one", "works")

		catalog := listSkillCatalog()
		if len(catalog) != 2 {
			t.Fatalf("expected 2 discovered skills (broken still listed), got %d", len(catalog))
		}
		for _, s := range catalog {
			if s.Name == "broken" && s.Valid {
				t.Error("broken skill must be invalid")
			}
		}
	})
}

func TestResolveSkillFilePathBlocksTraversal(t *testing.T) {
	withSkillTestEnv(t, func(home string, configDir string) {
		shared := filepath.Join(home, ".agents", "skills")
		dir := writeTestSkill(t, shared, "safe-skill", "desc")
		os.WriteFile(filepath.Join(dir, "notes.md"), []byte("hi"), 0o644)

		if _, err := resolveSkillFilePath("safe-skill", "notes.md"); err != nil {
			t.Errorf("legit relative path rejected: %v", err)
		}
		for _, bad := range []string{"../other/secret", "/etc/passwd", "../../.ssh/id_rsa", "sub/../../.."} {
			if _, err := resolveSkillFilePath("safe-skill", bad); err == nil {
				t.Errorf("traversal path %q must be rejected", bad)
			}
		}
		if _, err := resolveSkillFilePath("missing-skill", "x.md"); err == nil {
			t.Error("missing skill must fail")
		}
	})
}

func TestResolveSkillFilePathBlocksSymlinkEscape(t *testing.T) {
	withSkillTestEnv(t, func(home string, configDir string) {
		shared := filepath.Join(home, ".agents", "skills")
		dir := writeTestSkill(t, shared, "linked", "desc")
		outside := filepath.Join(home, "outside-secret.txt")
		os.WriteFile(outside, []byte("secret"), 0o644)
		if err := os.Symlink(outside, filepath.Join(dir, "leak.txt")); err != nil {
			t.Skip("symlinks unavailable")
		}
		if _, err := resolveSkillFilePath("linked", "leak.txt"); err == nil {
			t.Error("symlink escape outside skill roots must be rejected")
		}
	})
}

func TestCustomAgentCRUD(t *testing.T) {
	withSkillTestEnv(t, func(home string, configDir string) {
		writeTestSkill(t, skillStoreRoot(), "novel-toolkit", "Novel writing")

		agent := protocol.CustomAgent{
			Name:        "小说创作",
			BaseAgent:   "pi",
			Description: "novel agent",
			Skills:      []protocol.SkillRef{{Name: "novel-toolkit"}},
		}
		saved, err := upsertCustomAgent(agent)
		if err != nil {
			t.Fatalf("save failed: %v", err)
		}
		if saved.ID == "" {
			t.Fatal("expected generated id")
		}
		if len(saved.Skills) != 1 || saved.Skills[0].Path == "" {
			t.Fatalf("skill path should be resolved, got %+v", saved.Skills)
		}
		if !strings.HasPrefix(saved.Skills[0].Path, skillStoreRoot()) {
			t.Errorf("resolved path should be in store, got %s", saved.Skills[0].Path)
		}

		if _, err := lookupCustomAgent(saved.ID); err != false {
			_ = err
		}
		got, ok := lookupCustomAgent(saved.ID)
		if !ok {
			t.Fatal("lookup failed after save")
		}
		if got.Name != "小说创作" {
			t.Errorf("name mismatch: %s", got.Name)
		}

		if err := deleteCustomAgent(saved.ID); err != nil {
			t.Fatalf("delete failed: %v", err)
		}
		if _, ok := lookupCustomAgent(saved.ID); ok {
			t.Error("agent should be gone")
		}
	})
}

func TestNormalizeCustomAgentRejectsUnsupportedBaseAndOutsidePath(t *testing.T) {
	withSkillTestEnv(t, func(home string, configDir string) {
		if _, err := normalizeCustomAgent(protocol.CustomAgent{Name: "X", BaseAgent: "qwen"}); err == nil {
			t.Error("qwen must be rejected as base agent")
		}
		if _, err := normalizeCustomAgent(protocol.CustomAgent{Name: "X", BaseAgent: "gemini"}); err == nil {
			t.Error("gemini must be rejected as base agent")
		}
		outside := filepath.Join(home, "elsewhere")
		os.MkdirAll(outside, 0o755)
		if _, err := normalizeCustomAgent(protocol.CustomAgent{
			Name: "Y", BaseAgent: "pi",
			Skills: []protocol.SkillRef{{Name: "x", Path: outside}},
		}); err == nil {
			t.Error("skill path outside allowed roots must be rejected")
		}
	})
}

func TestBuildSkillLaunchPlanPiWhitelist(t *testing.T) {
	withSkillTestEnv(t, func(home string, configDir string) {
		skillA := writeTestSkill(t, skillStoreRoot(), "novel-toolkit", "d1")
		agent := protocol.CustomAgent{
			ID: "agent_novel", Name: "Novel", BaseAgent: "pi",
			Skills: []protocol.SkillRef{{Name: "novel-toolkit", Path: skillA}},
		}
		plan, err := buildSkillLaunchPlan("pi", agent)
		if err != nil {
			t.Fatalf("plan failed: %v", err)
		}
		joined := strings.Join(plan.Args, " ")
		if !strings.Contains(joined, "--no-skills") {
			t.Errorf("pi plan must disable discovery: %s", joined)
		}
		if !strings.Contains(joined, "--skill "+skillA) {
			t.Errorf("pi plan must include skill path: %s", joined)
		}

		// Prompt-only agent (no selected skills) must STILL isolate: --no-skills
		// with no --skill args. This is the regression case for "custom pi agent
		// still auto-loads global skills".
		promptOnly := protocol.CustomAgent{
			ID: "agent_prompt", Name: "PromptOnly", BaseAgent: "pi",
			SystemPrompt: "你是小说助手",
		}
		plan2, err := buildSkillLaunchPlan("pi", promptOnly)
		if err != nil {
			t.Fatalf("prompt-only plan failed: %v", err)
		}
		joined2 := strings.Join(plan2.Args, " ")
		if joined2 != "--no-skills" {
			t.Errorf("prompt-only pi plan must be exactly --no-skills, got %q", joined2)
		}

		// Completely empty agent keeps stock behavior (no args at all).
		empty := protocol.CustomAgent{ID: "agent_empty", Name: "Empty", BaseAgent: "pi"}
		plan3, err := buildSkillLaunchPlan("pi", empty)
		if err != nil {
			t.Fatalf("empty plan failed: %v", err)
		}
		if len(plan3.Args) != 0 {
			t.Errorf("empty agent must keep stock behavior, got %v", plan3.Args)
		}
	})
}

func TestBuildSkillLaunchPlanUnsupportedAgent(t *testing.T) {
	if _, err := buildSkillLaunchPlan("qwen", protocol.CustomAgent{Name: "Q", BaseAgent: "qwen"}); err == nil {
		t.Error("qwen must not be supported")
	}
}

func TestApplyCustomAgentOverridesCommandAndAgent(t *testing.T) {
	withSkillTestEnv(t, func(home string, configDir string) {
		skillA := writeTestSkill(t, skillStoreRoot(), "novel-toolkit", "d1")
		saved, err := upsertCustomAgent(protocol.CustomAgent{
			Name: "Novel", BaseAgent: "pi", SystemPrompt: "你是小说写作助手",
			Skills: []protocol.SkillRef{{Name: "novel-toolkit", Path: skillA}},
		})
		if err != nil {
			t.Fatal(err)
		}
		command, env, base, err := applyCustomAgentToTerminalCommand("bash", saved.ID, nil)
		if err != nil {
			t.Fatalf("apply failed: %v", err)
		}
		if base != "pi" {
			t.Errorf("expected base pi, got %s", base)
		}
		if !strings.HasPrefix(command, "pi ") {
			t.Errorf("command should start with pi: %q", command)
		}
		if !strings.Contains(command, "--no-skills") || !strings.Contains(command, "--skill") {
			t.Errorf("command should carry skill args: %q", command)
		}
		if !strings.Contains(command, "你是小说写作助手") {
			t.Errorf("command should carry system prompt: %q", command)
		}
		if len(env) != 0 {
			t.Errorf("pi plan should not need env, got %v", env)
		}

		// Empty ID is a no-op.
		c2, e2, b2, err2 := applyCustomAgentToTerminalCommand("claude", "", nil)
		if err2 != nil || c2 != "claude" || b2 != "" || e2 != nil {
			t.Errorf("empty agent id must be a no-op: %q %v %v %v", c2, b2, e2, err2)
		}
	})
}

func TestApplyCustomAgentOpenCodeEnv(t *testing.T) {
	withSkillTestEnv(t, func(home string, configDir string) {
		skillA := writeTestSkill(t, skillStoreRoot(), "novel-toolkit", "d1")
		saved, err := upsertCustomAgent(protocol.CustomAgent{
			Name: "Novel", BaseAgent: "opencode",
			Skills: []protocol.SkillRef{{Name: "novel-toolkit", Path: skillA}},
		})
		if err != nil {
			t.Fatal(err)
		}
		command, env, base, err := applyCustomAgentToTerminalCommand("bash", saved.ID, nil)
		if err != nil {
			t.Fatalf("apply failed: %v", err)
		}
		if base != "opencode" {
			t.Errorf("expected opencode base, got %s", base)
		}
		found := false
		for _, kv := range env {
			if strings.HasPrefix(kv, "OPENCODE_CONFIG_CONTENT=") {
				found = true
				if !strings.Contains(kv, "novel-toolkit") || !strings.Contains(kv, `"*":"deny"`) {
					t.Errorf("opencode env config wrong: %s", kv)
				}
			}
		}
		if !found {
			t.Error("opencode plan must set OPENCODE_CONFIG_CONTENT")
		}
		if strings.Contains(command, "--") {
			t.Errorf("opencode command should stay bare, got %q", command)
		}
	})
}

func TestMergeKiloConfigContentEnv(t *testing.T) {
	existing := `{"plugin":["/path/plugin.ts"]}`
	incoming := `{"skills":{"paths":["/dir"]}}`
	merged, err := mergeKiloConfigContentEnv([]string{"KILO_CONFIG_CONTENT=" + existing}, incoming)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(merged, "plugin") || !strings.Contains(merged, "skills") {
		t.Errorf("merge must keep both keys: %s", merged)
	}
	// No existing value -> incoming as-is.
	direct, _ := mergeKiloConfigContentEnv(nil, incoming)
	if direct != incoming {
		t.Errorf("expected passthrough, got %s", direct)
	}
}

func TestStoreInstallFromLocalRejectsNonSkill(t *testing.T) {
	withSkillTestEnv(t, func(home string, configDir string) {
		notSkill := filepath.Join(home, "plain-dir")
		os.MkdirAll(notSkill, 0o755)
		if _, err := installSkillFromLocal(notSkill, ""); err == nil {
			t.Error("directory without SKILL.md must be rejected")
		}
		src := writeTestSkill(t, filepath.Join(home, "src-skills"), "portable-skill", "works")
		summary, err := installSkillFromLocal(src, "")
		if err != nil {
			t.Fatalf("local install failed: %v", err)
		}
		if summary.Name != "portable-skill" || !summary.Managed {
			t.Errorf("summary wrong: %+v", summary)
		}
		if _, err := installSkillFromLocal(src, ""); err == nil {
			t.Error("duplicate install must fail")
		}
	})
}

func TestCreateSkillLocations(t *testing.T) {
	withSkillTestEnv(t, func(home string, configDir string) {
		storeSkill, err := createSkill("store-made", "in store", "store")
		if err != nil {
			t.Fatal(err)
		}
		if !strings.HasPrefix(storeSkill.Path, skillStoreRoot()) {
			t.Errorf("store skill path wrong: %s", storeSkill.Path)
		}
		sharedSkill, err := createSkill("shared-made", "in shared", "shared")
		if err != nil {
			t.Fatal(err)
		}
		if !strings.HasPrefix(sharedSkill.Path, filepath.Join(home, ".agents", "skills")) {
			t.Errorf("shared skill path wrong: %s", sharedSkill.Path)
		}
		if _, err := createSkill("Bad_Name", "x", "store"); err == nil {
			t.Error("invalid name must be rejected")
		}
		if _, err := createSkill("store-made", "dup", "store"); err == nil {
			t.Error("duplicate must be rejected")
		}
	})
}

func TestWriteSkillFileConflictDetection(t *testing.T) {
	withSkillTestEnv(t, func(home string, configDir string) {
		dir := writeTestSkill(t, skillStoreRoot(), "edit-me", "d")
		notes := filepath.Join(dir, "notes.md")
		os.WriteFile(notes, []byte("v1"), 0o644)
		rev1 := contentRevision([]byte("v1"))

		if _, err := writeSkillFile(protocol.SkillFileWriteRequest{Name: "edit-me", Path: "notes.md", Content: "v2", ExpectedRevision: rev1}); err != nil {
			t.Fatalf("write with correct revision failed: %v", err)
		}
		if _, err := writeSkillFile(protocol.SkillFileWriteRequest{Name: "edit-me", Path: "notes.md", Content: "v3", ExpectedRevision: rev1}); err == nil {
			t.Error("stale revision must conflict")
		}
		// SKILL.md cannot be deleted via file API.
		if _, err := deleteSkillFile(protocol.SkillFileDeleteRequest{Name: "edit-me", Path: "SKILL.md"}); err == nil {
			t.Error("deleting SKILL.md must be blocked")
		}
	})
}

func TestSkillCatalogNeverScansAgentPrivateDirs(t *testing.T) {
	withSkillTestEnv(t, func(home string, configDir string) {
		// Simulate an agent-private dir with a skill.
		private := filepath.Join(home, ".pi", "agent", "skills")
		writeTestSkill(t, private, "private-skill", "should not appear")
		catalog := listSkillCatalog()
		for _, s := range catalog {
			if s.Name == "private-skill" {
				t.Error("agent-private skill leaked into catalog")
			}
		}
	})
}
