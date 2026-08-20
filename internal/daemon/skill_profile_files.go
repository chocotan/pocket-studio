package daemon

import (
	"bytes"
	"errors"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"remote-agent/internal/protocol"
)

// Web-editable text file API over the two allowed skill roots.
// All operations address files by skill name + relative path; absolute or
// traversing paths are rejected (see resolveSkillFilePath in skill_profile.go).

var (
	errSkillFileTooLarge = errors.New("file exceeds the 1 MiB text edit limit")
	errSkillNotText      = errors.New("file is binary and cannot be edited as text")
	errSkillFileMissing  = errors.New("file not found")
)

// textExtensions: files we allow editing verbatim. Anything else is only
// downloadable/readable as metadata (binary flag), not editable.
var editableExtensions = map[string]bool{
	".md": true, ".markdown": true, ".txt": true,
	".json": true, ".jsonc": true, ".yaml": true, ".yml": true, ".toml": true,
	".js": true, ".mjs": true, ".cjs": true, ".ts": true, ".tsx": true,
	".py": true, ".sh": true, ".bash": true, ".zsh": true, ".rb": true,
	".go": true, ".rs": true, ".java": true, ".kt": true, ".sql": true,
	".html": true, ".css": true, ".scss": true, ".xml": true, ".csv": true,
	".env": true, ".ini": true, ".conf": true, ".cfg": true, ".editorconfig": true,
	".gitignore": true, ".gitattributes": true, ".dockerfile": true,
}

func editableTextFile(path string, content []byte) bool {
	name := strings.ToLower(filepath.Base(path))
	if strings.HasPrefix(name, ".") {
		// Dotfiles like .gitignore are fine; probe content below.
		if !editableExtensions[filepath.Ext(name)] && name != ".gitignore" && name != ".gitattributes" && name != ".editorconfig" && name != ".env" {
			return false
		}
	}
	if editableExtensions[filepath.Ext(name)] {
		return true
	}
	// Extensionless files (Makefile, Dockerfile, LICENSE): allow if valid UTF-8-ish.
	if filepath.Ext(name) == "" {
		return looksLikeText(content)
	}
	return false
}

func looksLikeText(content []byte) bool {
	if len(content) == 0 {
		return true
	}
	if bytes.IndexByte(content, 0) >= 0 {
		return false
	}
	nonPrintable := 0
	limit := len(content)
	if limit > 4096 {
		limit = 4096
	}
	for i := 0; i < limit; i++ {
		b := content[i]
		if b == '\n' || b == '\r' || b == '\t' || b >= 0x20 {
			continue
		}
		// Allow common UTF-8 lead/continuation bytes.
		if b >= 0xC2 {
			continue
		}
		nonPrintable++
		if nonPrintable > 8 {
			return false
		}
	}
	return true
}

func listSkillFiles(name string) (string, []protocol.FileEntry, error) {
	dir, _, err := findSkill(name)
	if err != nil {
		return "", nil, err
	}
	entries := []protocol.FileEntry{}
	_ = filepath.WalkDir(dir, func(path string, entry os.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		if path == dir {
			return nil
		}
		base := entry.Name()
		if base == ".git" && entry.IsDir() {
			return filepath.SkipDir
		}
		if base == "node_modules" && entry.IsDir() {
			return filepath.SkipDir
		}
		rel, relErr := filepath.Rel(dir, path)
		if relErr != nil {
			return nil
		}
		info, infoErr := entry.Info()
		if infoErr != nil {
			return nil
		}
		entries = append(entries, protocol.FileEntry{
			Name:     base,
			Path:     filepath.ToSlash(rel),
			IsDir:    entry.IsDir(),
			Size:     info.Size(),
			Modified: info.ModTime().Unix(),
		})
		return nil
	})
	// Tree order: compare path segment by segment so a directory always sits
	// immediately before its descendants ("a/b" < "a/b.md" < "a/b/c" style
	// grouping via segment-wise comparison). Dirs sort before files within the
	// same directory level.
	sort.Slice(entries, func(i, j int) bool {
		return compareFilePaths(entries[i].Path, entries[j].Path) < 0
	})
	return dir, entries, nil
}

// compareFilePaths orders two slash-separated relative paths in depth-first
// tree order: shared prefixes collapse, shorter (parent) paths come first,
// and directories (paths that are prefixes of the other) precede siblings.
func compareFilePaths(a string, b string) int {
	as := strings.Split(a, "/")
	bs := strings.Split(b, "/")
	n := len(as)
	if len(bs) < n {
		n = len(bs)
	}
	for i := 0; i < n; i++ {
		if as[i] != bs[i] {
			return strings.Compare(strings.ToLower(as[i]), strings.ToLower(bs[i]))
		}
	}
	// All shared segments equal: the shorter path (parent dir) comes first.
	return len(as) - len(bs)
}

func readSkillFile(name string, relative string) (protocol.SkillFileContent, error) {
	result := protocol.SkillFileContent{Name: name, Path: relative}
	target, err := resolveSkillFilePath(name, relative)
	if err != nil {
		return result, err
	}
	info, err := os.Stat(target)
	if err != nil {
		return result, errSkillFileMissing
	}
	if info.IsDir() {
		return result, errors.New("path is a directory")
	}
	if info.Size() > skillFileMaxBytes {
		result.Binary = true
		result.Size = info.Size()
		return result, errSkillFileTooLarge
	}
	content, err := os.ReadFile(target)
	if err != nil {
		return result, err
	}
	if !editableTextFile(target, content) {
		result.Binary = true
		result.Size = info.Size()
		return result, errSkillNotText
	}
	result.Content = string(content)
	result.Revision = contentRevision(content)
	result.Size = info.Size()
	return result, nil
}

func writeSkillFile(req protocol.SkillFileWriteRequest) (protocol.SkillFileOperationResult, error) {
	result := protocol.SkillFileOperationResult{Name: req.Name, Path: req.Path}
	target, err := resolveSkillFilePath(req.Name, req.Path)
	if err != nil {
		return result, err
	}
	if len(req.Content) > skillFileMaxBytes {
		return result, errSkillFileTooLarge
	}
	info, statErr := os.Stat(target)
	if statErr == nil && info.IsDir() {
		return result, errors.New("path is a directory")
	}
	if statErr == nil && req.ExpectedRevision != "" {
		existing, readErr := os.ReadFile(target)
		if readErr != nil {
			return result, readErr
		}
		if contentRevision(existing) != req.ExpectedRevision {
			result.Conflict = true
			return result, errors.New("file changed since read (conflict)")
		}
	}
	if statErr != nil && !errors.Is(statErr, os.ErrNotExist) {
		return result, statErr
	}
	content := []byte(req.Content)
	if err := writeFileAtomic(target, content, 0o644); err != nil {
		return result, err
	}
	result.Revision = contentRevision(content)
	return result, nil
}

func createSkillFile(req protocol.SkillFileCreateRequest) (protocol.SkillFileOperationResult, error) {
	result := protocol.SkillFileOperationResult{Name: req.Name, Path: req.Path}
	if req.Path == "" || req.Path == "." || strings.Contains(req.Path, "..") {
		return result, errSkillPathEscape
	}
	if strings.HasPrefix(filepath.Base(filepath.Clean("/"+req.Path)), ".") && filepath.Base(req.Path) != ".gitignore" {
		return result, errSkillPathEscape
	}
	dir, _, err := findSkill(req.Name)
	if err != nil {
		return result, err
	}
	target := filepath.Join(dir, filepath.Clean("/"+req.Path))
	if !withinAllowedRoots(target) {
		return result, errSkillPathEscape
	}
	if _, err := os.Stat(target); err == nil {
		return result, errSkillExists
	}
	if req.IsDir {
		if err := os.MkdirAll(target, 0o755); err != nil {
			return result, err
		}
		return result, nil
	}
	if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
		return result, err
	}
	if err := writeFileAtomic(target, nil, 0o644); err != nil {
		return result, err
	}
	return result, nil
}

func renameSkillFile(req protocol.SkillFileRenameRequest) (protocol.SkillFileOperationResult, error) {
	result := protocol.SkillFileOperationResult{Name: req.Name, Path: req.NewPath}
	src, err := resolveSkillFilePath(req.Name, req.Path)
	if err != nil {
		return result, err
	}
	if req.NewPath == "" || strings.Contains(req.NewPath, "..") {
		return result, errSkillPathEscape
	}
	dir, _, err := findSkill(req.Name)
	if err != nil {
		return result, err
	}
	dst := filepath.Join(dir, filepath.Clean("/"+req.NewPath))
	if !withinAllowedRoots(dst) {
		return result, errSkillPathEscape
	}
	if _, err := os.Stat(dst); err == nil {
		return result, errSkillExists
	}
	if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
		return result, err
	}
	if err := os.Rename(src, dst); err != nil {
		return result, err
	}
	return result, nil
}

func deleteSkillFile(req protocol.SkillFileDeleteRequest) (protocol.SkillFileOperationResult, error) {
	result := protocol.SkillFileOperationResult{Name: req.Name, Path: req.Path}
	target, err := resolveSkillFilePath(req.Name, req.Path)
	if err != nil {
		return result, err
	}
	// Never allow deleting SKILL.md itself via the file API — a skill without
	// SKILL.md becomes invalid; users should delete the whole skill instead.
	if filepath.Base(target) == skillFileName {
		return result, errors.New("cannot delete SKILL.md; delete the skill instead")
	}
	info, err := os.Stat(target)
	if err != nil {
		return result, errSkillFileMissing
	}
	if info.IsDir() {
		// Only allow deleting empty directories to stay conservative.
		entries, readErr := os.ReadDir(target)
		if readErr != nil {
			return result, readErr
		}
		if len(entries) > 0 {
			return result, errors.New("directory not empty")
		}
	}
	return result, os.Remove(target)
}

// validateSkill re-parses the SKILL.md of a skill and reports issues.
func validateSkill(name string) (protocol.SkillFileOperationResult, error) {
	result := protocol.SkillFileOperationResult{Name: name}
	dir, _, err := findSkill(name)
	if err != nil {
		return result, err
	}
	content, err := os.ReadFile(filepath.Join(dir, skillFileName))
	if err != nil {
		result.Error = "SKILL.md missing or unreadable"
		return result, nil
	}
	fm := parseSkillFrontmatter(content)
	if issue := validateSkillMeta(fm.Name, fm.Description, filepath.Base(dir)); issue != "" {
		result.Error = issue
		return result, nil
	}
	result.Revision = contentRevision(content)
	return result, nil
}
