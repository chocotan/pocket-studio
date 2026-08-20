package daemon

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"remote-agent/internal/protocol"
)

func TestListSkillFilesTreeOrder(t *testing.T) {
	withSkillTestEnv(t, func(home string, configDir string) {
		dir := filepath.Join(skillStoreRoot(), "demo")
		for _, rel := range []string{
			"SKILL.md", "agents", "agents/novel.md", "agents/sub", "agents/sub/deep.md",
			"docs", "docs/a.md", "zz-file.md", "agents/a-first.md",
		} {
			full := filepath.Join(dir, rel)
			if strings.HasSuffix(rel, ".md") || rel == "SKILL.md" {
				if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(full, []byte("x"), 0o644); err != nil {
					t.Fatal(err)
				}
			} else if err := os.MkdirAll(full, 0o755); err != nil {
				t.Fatal(err)
			}
		}

		// Reuse the real finder: catalog lists the frontmatter name "demo".
		_ = protocol.SkillSummary{}
		_, entries, err := listSkillFiles("demo")
		if err != nil {
			t.Fatal(err)
		}
		var order []string
		for _, e := range entries {
			order = append(order, e.Path)
		}
		want := []string{
			"agents",
			"agents/a-first.md",
			"agents/novel.md",
			"agents/sub",
			"agents/sub/deep.md",
			"docs",
			"docs/a.md",
			"SKILL.md",
			"zz-file.md",
		}
		if len(order) != len(want) {
			t.Fatalf("count mismatch: %v", order)
		}
		for i := range want {
			if order[i] != want[i] {
				t.Fatalf("order[%d]=%s want %s (full: %v)", i, order[i], want[i], order)
			}
		}
	})
}
