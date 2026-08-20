package daemon

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestFindSkillByFrontmatterName(t *testing.T) {
	withSkillTestEnv(t, func(home string, configDir string) {
		// Git-installed skill: dir name differs from frontmatter name.
		dir := filepath.Join(skillStoreRoot(), "awesome-novel-agent")
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatal(err)
		}
		content := "---\nname: awesome-novel\ndescription: test\n---\nbody"
		if err := os.WriteFile(filepath.Join(dir, "SKILL.md"), []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}

		// Catalog lists the frontmatter name.
		catalog := listSkillCatalog()
		found := false
		for _, s := range catalog {
			if s.Name == "awesome-novel" {
				found = true
			}
		}
		if !found {
			t.Fatal("catalog must list frontmatter name awesome-novel")
		}

		// findSkill resolves by frontmatter name (fallback) and by dir name.
		if d, _, err := findSkill("awesome-novel"); err != nil || !strings.HasSuffix(d, "awesome-novel-agent") {
			t.Fatalf("frontmatter lookup failed: %v %s", err, d)
		}
		if d, _, err := findSkill("awesome-novel-agent"); err != nil || !strings.HasSuffix(d, "awesome-novel-agent") {
			t.Fatalf("dir lookup failed: %v %s", err, d)
		}

		// File APIs work with the frontmatter name.
		if target, err := resolveSkillFilePath("awesome-novel", "SKILL.md"); err != nil {
			t.Fatalf("resolve by frontmatter name failed: %v", err)
		} else if _, err := os.Stat(target); err != nil {
			t.Fatalf("resolved path missing: %v", err)
		}
	})
}
