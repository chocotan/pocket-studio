package daemon

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strings"

	"remote-agent/internal/protocol"
)

// Skill registry and profile storage.
//
// Design invariants (docs/skill-profiles-plan.md):
//   - Registry scans exactly two roots: ~/.agents/skills ("shared-global") and
//     <userConfigDir>/pocket-studio/skill-store ("store"). Agent-private dirs
//     (~/.pi/agent/skills, ~/.claude/skills, ...) are never scanned, edited,
//     or written by this feature.
//   - Store skills only become visible to agents when a profile referencing
//     them is launched; plain sessions never discover them.
//   - File APIs accept skill name + relative path only, never arbitrary
//     absolute paths, and must defend against traversal/symlink escapes.

const (
	skillSourceShared = "shared-global"
	skillSourceStore  = "store"
	skillStoreDirname = "skill-store"
	customAgentsFile  = "custom-agents.json"
	skillFileName     = "SKILL.md"
	// 1 MiB read/write limit for text editing via the web UI.
	skillFileMaxBytes = 1 << 20
)

var (
	errSkillNotFound     = errors.New("skill not found")
	errSkillPathEscape   = errors.New("path escapes skill directory")
	errSkillNameInvalid  = errors.New("invalid skill name")
	errSkillExists       = errors.New("skill already exists")
	errSkillNotManaged   = errors.New("skill is not managed by the store")
)

// skillNamePattern follows the Agent Skills open standard name rules.
var skillNamePattern = regexp.MustCompile(`^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$`)

func skillSharedRoot() string {
	home, err := os.UserHomeDir()
	if err != nil || home == "" {
		return ""
	}
	return filepath.Join(home, ".agents", "skills")
}

func skillStoreRoot() string {
	return filepath.Join(userConfigDir(), "pocket-studio", skillStoreDirname)
}

func customAgentsPath() string {
	return filepath.Join(userConfigDir(), "pocket-studio", customAgentsFile)
}

func skillAllowedRoots() []string {
	roots := []string{}
	if shared := skillSharedRoot(); shared != "" {
		roots = append(roots, shared)
	}
	roots = append(roots, skillStoreRoot())
	return roots
}

// skillRootForSource maps a catalog source label back to its directory.
func skillRootForSource(source string) string {
	if source == skillSourceShared {
		return skillSharedRoot()
	}
	return skillStoreRoot()
}

// skillRootLabel reports which allowed root (if any) contains dir.
func skillRootLabel(dir string) (root string, source string, ok bool) {
	clean, err := filepath.EvalSymlinks(dir)
	if err != nil {
		clean = filepath.Clean(dir)
	}
	for _, candidate := range skillAllowedRoots() {
		candClean, err := filepath.EvalSymlinks(candidate)
		if err != nil {
			candClean = filepath.Clean(candidate)
		}
		if clean == candClean {
			return candidate, sourceForRoot(candidate), true
		}
	}
	return "", "", false
}

func sourceForRoot(root string) string {
	if root == skillStoreRoot() {
		return skillSourceStore
	}
	return skillSourceShared
}

// ---------------------------------------------------------------------------
// SKILL.md frontmatter parsing (minimal YAML: name + description)
// ---------------------------------------------------------------------------

type skillFrontmatter struct {
	Name        string
	Description string
}

var skillNameRe = regexp.MustCompile(`(?m)^name:\s*(.+)$`)
var skillDescRe = regexp.MustCompile(`(?m)^description:\s*(.+)$`)

func parseSkillFrontmatter(content []byte) skillFrontmatter {
	var fm skillFrontmatter
	text := string(content)
	// Strip code fences so embedded examples do not shadow the real values.
	if idx := strings.Index(text, "```"); idx >= 0 {
		text = text[:idx]
	}
	if m := skillNameRe.FindStringSubmatch(text); len(m) > 1 {
		fm.Name = strings.Trim(strings.TrimSpace(m[1]), `"'`)
	}
	if m := skillDescRe.FindStringSubmatch(text); len(m) > 1 {
		fm.Description = strings.Trim(strings.TrimSpace(m[1]), `"'`)
	}
	return fm
}

func contentRevision(content []byte) string {
	sum := sha256.Sum256(content)
	return hex.EncodeToString(sum[:12])
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

// scanSkillDir discovers skills (directories containing SKILL.md) under one
// root. Shared root follows the agentskills convention: only directories with
// SKILL.md. Nested directories containing SKILL.md also count.
func scanSkillRoot(root string, source string) []protocol.SkillSummary {
	skills := []protocol.SkillSummary{}
	_ = filepath.WalkDir(root, func(path string, entry fs.DirEntry, err error) error {
		if err != nil || !entry.IsDir() {
			return nil
		}
		if path != root {
			// Skip heavy/irrelevant subtrees.
			name := entry.Name()
			if name == ".git" || name == "node_modules" {
				return filepath.SkipDir
			}
		}
		skillMD := filepath.Join(path, skillFileName)
		info, statErr := os.Stat(skillMD)
		if statErr != nil || info.IsDir() {
			return nil
		}
		rel, relErr := filepath.Rel(root, path)
		if relErr != nil || rel == "." {
			return nil
		}
		summary := protocol.SkillSummary{
			Path:     path,
			Source:   source,
			Managed:  source == skillSourceStore,
			Writable: writablePath(path),
		}
		if content, readErr := os.ReadFile(skillMD); readErr == nil && info.Size() <= skillFileMaxBytes {
			fm := parseSkillFrontmatter(content)
			summary.Name = fm.Name
			summary.Description = fm.Description
			summary.Revision = contentRevision(content)
			if summary.Name == "" {
				// Fall back to directory name when frontmatter omits name.
				summary.Name = filepath.Base(path)
			}
			if issue := validateSkillMeta(summary.Name, fm.Description, rel); issue != "" {
				summary.Valid = false
				summary.Issue = issue
			} else {
				summary.Valid = true
			}
		} else {
			summary.Name = filepath.Base(path)
			summary.Valid = false
			summary.Issue = "SKILL.md missing or unreadable"
		}
		skills = append(skills, summary)
		return nil
	})
	return skills
}

func validateSkillMeta(name string, description string, dirName string) string {
	if name == "" {
		return "frontmatter name is required"
	}
	if len(name) > 64 || !skillNamePattern.MatchString(name) {
		return "name must be 1-64 chars of lowercase letters, digits, hyphens"
	}
	if description == "" {
		return "frontmatter description is required"
	}
	if len(description) > 1024 {
		return "description exceeds 1024 characters"
	}
	if dirName != "" && dirName != name && !strings.EqualFold(filepath.Base(dirName), name) {
		// The standard wants dir == name; we keep lenient (Pi-style) but warn.
		return "directory name does not match frontmatter name (recommended)"
	}
	return ""
}

func writablePath(path string) bool {
	info, err := os.Stat(path)
	if err != nil {
		return false
	}
	if info.IsDir() {
		// Probe writability with a temp file.
		tmp, err := os.CreateTemp(path, ".probe-*")
		if err != nil {
			return false
		}
		name := tmp.Name()
		_ = tmp.Close()
		_ = os.Remove(name)
		return true
	}
	return info.Mode().Perm()&0o200 != 0
}

func listSkillCatalog() []protocol.SkillSummary {
	skills := scanSkillRoot(skillStoreRoot(), skillSourceStore)
	if shared := skillSharedRoot(); shared != "" {
		skills = append(skills, scanSkillRoot(shared, skillSourceShared)...)
	}
	sort.Slice(skills, func(i, j int) bool {
		if skills[i].Source != skills[j].Source {
			return skills[i].Source == skillSourceStore
		}
		return strings.ToLower(skills[i].Name) < strings.ToLower(skills[j].Name)
	})
	return skills
}

// findSkill locates a skill directory by its directory name under either
// allowed root. Store wins on collision.
func findSkill(name string) (dir string, source string, err error) {
	if !validSkillDirName(name) {
		return "", "", errSkillNameInvalid
	}
	for _, root := range []string{skillStoreRoot(), skillSharedRoot()} {
		candidate := filepath.Join(root, name)
		if info, statErr := os.Stat(candidate); statErr == nil && info.IsDir() {
			return candidate, sourceForRoot(root), nil
		}
	}
	// Frontmatter names may differ from directory names (e.g. git-installed
	// skills whose SKILL.md declares its own name; the catalog lists the
	// frontmatter name). Fall back to a catalog lookup so such skills stay
	// addressable by the name shown in the UI.
	for _, summary := range listSkillCatalog() {
		if summary.Name == name {
			return summary.Path, summary.Source, nil
		}
	}
	return "", "", errSkillNotFound
}

// validSkillDirName guards directory creation/lookup under allowed roots.
func validSkillDirName(name string) bool {
	if name == "" || len(name) > 64 {
		return false
	}
	if name == "." || name == ".." || strings.ContainsAny(name, `/\`) {
		return false
	}
	if strings.Contains(name, "..") || strings.HasPrefix(name, ".") {
		return false
	}
	for _, r := range name {
		if (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') || r == '-' || r == '_' {
			continue
		}
		return false
	}
	return true
}

// resolveSkillFilePath validates name+relative path and returns the absolute
// file path inside the skill directory, defending against traversal and
// symlink escapes out of the allowed roots.
func resolveSkillFilePath(name string, relative string) (string, error) {
	dir, _, err := findSkill(name)
	if err != nil {
		return "", err
	}
	// Defense in depth: reject suspicious inputs outright instead of relying
	// only on Clean+Join anchoring.
	if strings.HasPrefix(relative, "/") || strings.Contains(relative, "..") || strings.Contains(relative, "\\") {
		return "", errSkillPathEscape
	}
	cleanRel := filepath.Clean(relative)
	if cleanRel == "." || cleanRel == "" {
		return "", errSkillPathEscape
	}
	if base := filepath.Base(cleanRel); strings.HasPrefix(base, ".") && base != ".gitignore" && base != ".gitattributes" && base != ".editorconfig" && base != ".env" {
		return "", errSkillPathEscape
	}
	target := filepath.Join(dir, cleanRel)
	// EvalSymlinks on the deepest existing ancestor catches symlink escapes.
	probe := target
	for {
		if resolved, err := filepath.EvalSymlinks(probe); err == nil {
			if _, _, ok := skillRootLabel(resolved); !ok && !withinAllowedRoots(resolved) {
				return "", errSkillPathEscape
			}
			break
		}
		parent := filepath.Dir(probe)
		if parent == probe {
			break
		}
		probe = parent
	}
	return target, nil
}

func withinAllowedRoots(path string) bool {
	for _, root := range skillAllowedRoots() {
		rootAbs, err := filepath.Abs(root)
		if err != nil {
			continue
		}
		abs, err := filepath.Abs(path)
		if err != nil {
			continue
		}
		if abs == rootAbs || strings.HasPrefix(abs, rootAbs+string(filepath.Separator)) {
			return true
		}
	}
	return false
}

// ---------------------------------------------------------------------------
// Custom agent storage
// ---------------------------------------------------------------------------

type customAgentStore struct {
	Version int                    `json:"version"`
	Agents  []protocol.CustomAgent `json:"agents"`
}

func loadCustomAgents() customAgentStore {
	store := customAgentStore{Version: 1}
	data, err := os.ReadFile(customAgentsPath())
	if err == nil {
		_ = json.Unmarshal(data, &store)
	}
	if store.Version == 0 {
		store.Version = 1
	}
	if store.Agents == nil {
		store.Agents = []protocol.CustomAgent{}
	}
	return store
}

func saveCustomAgents(store customAgentStore) error {
	if store.Version == 0 {
		store.Version = 1
	}
	data, err := json.MarshalIndent(store, "", "  ")
	if err != nil {
		return err
	}
	return writeFileAtomic(customAgentsPath(), data, 0o600)
}

var customAgentIDPattern = regexp.MustCompile(`^[a-z0-9][a-z0-9_-]{1,63}$`)

func normalizeCustomAgent(agent protocol.CustomAgent) (protocol.CustomAgent, error) {
	agent.ID = strings.ToLower(strings.TrimSpace(agent.ID))
	agent.Name = strings.TrimSpace(agent.Name)
	agent.BaseAgent = normalizeAgentName(strings.TrimSpace(agent.BaseAgent))
	if agent.Name == "" {
		return agent, errors.New("agent name is required")
	}
	if len(agent.Name) > 64 {
		return agent, errors.New("agent name too long (max 64)")
	}
	if !skillProfileSupportedAgents[agent.BaseAgent] {
		return agent, fmt.Errorf("base agent %q does not support custom agents", agent.BaseAgent)
	}
	if agent.ID == "" {
		agent.ID = "agent_" + guessSkillNameFromRef(agent.Name)
		existing := map[string]bool{}
		for _, other := range loadCustomAgents().Agents {
			existing[other.ID] = true
		}
		if existing[agent.ID] {
			agent.ID += "_" + contentRevision([]byte(fmt.Sprintf("%s-%d", agent.Name, os.Getpid())))[:6]
		}
	}
	if !customAgentIDPattern.MatchString(agent.ID) {
		return agent, fmt.Errorf("invalid agent id %q", agent.ID)
	}
	for i := range agent.Skills {
		agent.Skills[i].Name = strings.TrimSpace(agent.Skills[i].Name)
		agent.Skills[i].Path = strings.TrimSpace(agent.Skills[i].Path)
	}
	// Resolve skill refs to canonical absolute paths so definitions survive
	// home-dir moves; every ref must live under an allowed root.
	for i, ref := range agent.Skills {
		if ref.Path == "" {
			dir, _, err := findSkill(ref.Name)
			if err != nil {
				return agent, fmt.Errorf("skill %q: %w", ref.Name, err)
			}
			agent.Skills[i].Path = dir
			continue
		}
		expanded := expandHomePath(ref.Path)
		if !withinAllowedRoots(expanded) {
			return agent, fmt.Errorf("skill path %q is outside the allowed skill roots", ref.Path)
		}
		if _, err := os.Stat(expanded); err != nil {
			return agent, fmt.Errorf("skill path %q not found", ref.Path)
		}
	}
	return agent, nil
}

func expandHomePath(path string) string {
	if path == "~" || strings.HasPrefix(path, "~/") {
		if home, err := os.UserHomeDir(); err == nil && home != "" {
			return filepath.Join(home, strings.TrimPrefix(strings.TrimPrefix(path, "~"), "/"))
		}
	}
	return path
}

// upsertCustomAgent inserts or updates by ID and persists atomically.
func upsertCustomAgent(agent protocol.CustomAgent) (protocol.CustomAgent, error) {
	agent, err := normalizeCustomAgent(agent)
	if err != nil {
		return agent, err
	}
	store := loadCustomAgents()
	replaced := false
	for i := range store.Agents {
		if store.Agents[i].ID == agent.ID {
			store.Agents[i] = agent
			replaced = true
			break
		}
	}
	if !replaced {
		store.Agents = append(store.Agents, agent)
	}
	if err := saveCustomAgents(store); err != nil {
		return agent, err
	}
	return agent, nil
}

func deleteCustomAgent(id string) error {
	store := loadCustomAgents()
	kept := store.Agents[:0]
	found := false
	for _, agent := range store.Agents {
		if agent.ID == id {
			found = true
			continue
		}
		kept = append(kept, agent)
	}
	if !found {
		return errors.New("custom agent not found")
	}
	store.Agents = kept
	return saveCustomAgents(store)
}

func lookupCustomAgent(id string) (protocol.CustomAgent, bool) {
	store := loadCustomAgents()
	for _, agent := range store.Agents {
		if agent.ID == id {
			return agent, true
		}
	}
	return protocol.CustomAgent{}, false
}

func listCustomAgents() []protocol.CustomAgent {
	return loadCustomAgents().Agents
}

// ---------------------------------------------------------------------------
// Skill creation & store install
// ---------------------------------------------------------------------------

const skillTemplate = `---
name: %s
description: %s
---

# %s

Describe what this skill does and when the agent should use it.

## Usage

Add instructions, scripts under scripts/, and references under references/.
`

func createSkill(name string, description string, location string) (protocol.SkillSummary, error) {
	if !validSkillDirName(name) {
		return protocol.SkillSummary{}, errSkillNameInvalid
	}
	if issue := validateSkillMeta(name, description, name); issue != "" && !strings.Contains(issue, "directory name") {
		return protocol.SkillSummary{}, errors.New(issue)
	}
	root := skillStoreRoot()
	if location == "shared" {
		root = skillSharedRoot()
		if root == "" {
			return protocol.SkillSummary{}, errors.New("shared skill root unavailable")
		}
	}
	dir := filepath.Join(root, name)
	if _, err := os.Stat(dir); err == nil {
		return protocol.SkillSummary{}, errSkillExists
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return protocol.SkillSummary{}, err
	}
	content := fmt.Sprintf(skillTemplate, name, description, name)
	if err := writeFileAtomic(filepath.Join(dir, skillFileName), []byte(content), 0o644); err != nil {
		return protocol.SkillSummary{}, err
	}
	return protocol.SkillSummary{
		Name:        name,
		Description: description,
		Path:        dir,
		Source:      sourceForRoot(root),
		Managed:     sourceForRoot(root) == skillSourceStore,
		Writable:    true,
		Revision:    contentRevision([]byte(content)),
		Valid:       true,
	}, nil
}

// installSkillFromGit clones --depth 1 into the store.
func installSkillFromGit(url string, nameOverride string) (protocol.SkillSummary, error) {
	if strings.TrimSpace(url) == "" {
		return protocol.SkillSummary{}, errors.New("git url is required")
	}
	name := strings.TrimSpace(nameOverride)
	if name == "" {
		name = guessSkillNameFromRef(url)
	}
	if !validSkillDirName(name) {
		return protocol.SkillSummary{}, fmt.Errorf("%w: %q", errSkillNameInvalid, name)
	}
	dir := filepath.Join(skillStoreRoot(), name)
	if _, err := os.Stat(dir); err == nil {
		// Idempotent install: an existing directory is returned as-is so the
	// UI shows the skill (under its frontmatter name) instead of an error.
		if summary, sumErr := summarizeSkillDir(dir, skillSourceStore); sumErr == nil {
			return summary, nil
		}
		return protocol.SkillSummary{}, errSkillExists
	}
	if err := os.MkdirAll(skillStoreRoot(), 0o755); err != nil {
		return protocol.SkillSummary{}, err
	}
	cmd := exec.Command("git", "clone", "--depth", "1", url, dir)
	cmd.Env = append(os.Environ(), "GIT_TERMINAL_PROMPT=0")
	if out, err := cmd.CombinedOutput(); err != nil {
		_ = os.RemoveAll(dir)
		return protocol.SkillSummary{}, fmt.Errorf("git clone failed: %s: %w", strings.TrimSpace(string(out)), err)
	}
	return summarizeSkillDir(dir, skillSourceStore)
}

// installSkillFromLocal copies a local skill directory into the store after
// validating it contains a SKILL.md.
func installSkillFromLocal(srcPath string, nameOverride string) (protocol.SkillSummary, error) {
	src := expandHomePath(strings.TrimSpace(srcPath))
	if src == "" {
		return protocol.SkillSummary{}, errors.New("local path is required")
	}
	info, err := os.Stat(src)
	if err != nil {
		return protocol.SkillSummary{}, fmt.Errorf("source not found: %w", err)
	}
	if !info.IsDir() {
		return protocol.SkillSummary{}, errors.New("source must be a skill directory containing SKILL.md")
	}
	if _, err := os.Stat(filepath.Join(src, skillFileName)); err != nil {
		return protocol.SkillSummary{}, errors.New("source directory has no SKILL.md")
	}
	name := strings.TrimSpace(nameOverride)
	if name == "" {
		name = filepath.Base(strings.TrimRight(src, "/"))
	}
	if !validSkillDirName(name) {
		return protocol.SkillSummary{}, fmt.Errorf("%w: %q", errSkillNameInvalid, name)
	}
	dest := filepath.Join(skillStoreRoot(), name)
	if _, err := os.Stat(dest); err == nil {
		return protocol.SkillSummary{}, errSkillExists
	}
	if err := copySkillTree(src, dest); err != nil {
		_ = os.RemoveAll(dest)
		return protocol.SkillSummary{}, err
	}
	return summarizeSkillDir(dest, skillSourceStore)
}

func guessSkillNameFromRef(ref string) string {
	base := filepath.Base(strings.TrimRight(strings.TrimSpace(ref), "/"))
	base = strings.TrimSuffix(base, ".git")
	base = strings.ToLower(base)
	var b strings.Builder
	lastDash := false
	for _, r := range base {
		ok := (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') || r == '-'
		if ok {
			b.WriteRune(r)
			lastDash = r == '-'
		} else if !lastDash && b.Len() > 0 {
			b.WriteRune('-')
			lastDash = true
		}
	}
	name := strings.Trim(b.String(), "-")
	if len(name) > 64 {
		name = name[:64]
	}
	return name
}

func copySkillTree(src string, dest string) error {
	return filepath.WalkDir(src, func(path string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, relErr := filepath.Rel(src, path)
		if relErr != nil {
			return relErr
		}
		if rel == "." {
			return os.MkdirAll(dest, 0o755)
		}
		target := filepath.Join(dest, rel)
		if entry.IsDir() {
			return os.MkdirAll(target, 0o755)
		}
		if entry.Type()&fs.ModeSymlink != 0 {
			// Preserve symlinks only if they resolve inside the skill tree.
			resolved, err := filepath.EvalSymlinks(path)
			if err != nil || !strings.HasPrefix(resolved, src+string(filepath.Separator)) {
				return nil
			}
			return os.Symlink(resolved, target)
		}
		data, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		info, err := entry.Info()
		if err != nil {
			return err
		}
		return writeFileAtomic(target, data, info.Mode().Perm())
	})
}

func summarizeSkillDir(dir string, source string) (protocol.SkillSummary, error) {
	skillMD := filepath.Join(dir, skillFileName)
	content, err := os.ReadFile(skillMD)
	if err != nil {
		return protocol.SkillSummary{}, fmt.Errorf("cloned skill has no readable SKILL.md")
	}
	fm := parseSkillFrontmatter(content)
	name := fm.Name
	if name == "" {
		name = filepath.Base(dir)
	}
	summary := protocol.SkillSummary{
		Name:        name,
		Description: fm.Description,
		Path:        dir,
		Source:      source,
		Managed:     source == skillSourceStore,
		Writable:    writablePath(dir),
		Revision:    contentRevision(content),
	}
	if issue := validateSkillMeta(name, fm.Description, filepath.Base(dir)); issue != "" {
		summary.Issue = issue
	} else {
		summary.Valid = true
	}
	return summary, nil
}

func removeStoreSkill(name string) error {
	dir, source, err := findSkill(name)
	if err != nil {
		return err
	}
	if source != skillSourceStore {
		return errSkillNotManaged
	}
	return os.RemoveAll(dir)
}

// upgradeStoreSkill pulls latest for a git-installed store skill.
func upgradeStoreSkill(name string, force bool) (protocol.SkillSummary, error) {
	dir, source, err := findSkill(name)
	if err != nil {
		return protocol.SkillSummary{}, err
	}
	if source != skillSourceStore {
		return protocol.SkillSummary{}, errSkillNotManaged
	}
	if _, err := os.Stat(filepath.Join(dir, ".git")); err != nil {
		return protocol.SkillSummary{}, errors.New("skill was not installed from git")
	}
	if !force {
		if dirty, dirtyErr := gitWorktreeDirty(dir); dirtyErr == nil && dirty {
			return protocol.SkillSummary{}, errors.New("skill has local edits; pass force to discard them")
		}
	}
	pull := exec.Command("git", "-C", dir, "pull", "--ff-only")
	pull.Env = append(os.Environ(), "GIT_TERMINAL_PROMPT=0")
	if out, err := pull.CombinedOutput(); err != nil {
		return protocol.SkillSummary{}, fmt.Errorf("git pull failed: %s", strings.TrimSpace(string(out)))
	}
	return summarizeSkillDir(dir, skillSourceStore)
}

func gitWorktreeDirty(dir string) (bool, error) {
	cmd := exec.Command("git", "-C", dir, "status", "--porcelain")
	out, err := cmd.Output()
	if err != nil {
		return false, err
	}
	return strings.TrimSpace(string(out)) != "", nil
}
