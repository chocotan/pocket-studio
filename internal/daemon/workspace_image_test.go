package daemon

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"remote-agent/internal/protocol"
)

func TestWorkspaceFileReadLimitAllowsACPImagePreview(t *testing.T) {
	if got := workspaceFileReadLimit("chat_image.png"); got != 20<<20 {
		t.Fatalf("image read limit = %d, want %d", got, 20<<20)
	}
	if got := workspaceFileReadLimit("notes.txt"); got != 1<<20 {
		t.Fatalf("text read limit = %d, want %d", got, 1<<20)
	}
}

func TestWriteWorkspaceFileTemporaryUsesSystemTempDirectory(t *testing.T) {
	temporaryRoot := t.TempDir()
	t.Setenv("TMPDIR", temporaryRoot)
	t.Setenv("TMP", temporaryRoot)
	t.Setenv("TEMP", temporaryRoot)
	workspace := t.TempDir()
	cfg := DefaultConfig()
	cfg.Workspaces = []protocol.Workspace{{ID: "project", Name: "Project", Path: workspace}}
	d := New(cfg)

	d.writeWorkspaceFile(protocol.WorkspaceWriteRequest{
		RequestID:     "write-temp-image",
		WorkspacePath: workspace,
		Path:          "pasted_image.png",
		Content:       "data:image/png;base64,aW1hZ2UtYnl0ZXM=",
		Temporary:     true,
	})

	envelope := <-d.send
	result, err := protocol.DecodePayload[protocol.WorkspaceResult](envelope)
	if err != nil {
		t.Fatal(err)
	}
	if result.Error != "" {
		t.Fatalf("temporary workspace write error = %q", result.Error)
	}
	target := filepath.FromSlash(result.Path)
	relativeToTemp, err := filepath.Rel(temporaryRoot, target)
	if err != nil || relativeToTemp == ".." || strings.HasPrefix(relativeToTemp, ".."+string(filepath.Separator)) {
		t.Fatalf("temporary image path = %q, want a path under %q", target, temporaryRoot)
	}
	if filepath.Base(target) != "pasted_image.png" {
		t.Fatalf("temporary image filename = %q", filepath.Base(target))
	}
	content, err := os.ReadFile(target)
	if err != nil {
		t.Fatal(err)
	}
	if string(content) != "image-bytes" {
		t.Fatalf("temporary image content = %q", content)
	}
	if _, err := os.Stat(filepath.Join(workspace, "pasted_image.png")); !os.IsNotExist(err) {
		t.Fatalf("workspace image should not exist, stat error = %v", err)
	}
}

func TestWriteWorkspaceFileDefaultsToWorkspace(t *testing.T) {
	workspace := t.TempDir()
	cfg := DefaultConfig()
	cfg.Workspaces = []protocol.Workspace{{ID: "project", Name: "Project", Path: workspace}}
	d := New(cfg)

	d.writeWorkspaceFile(protocol.WorkspaceWriteRequest{
		RequestID:     "write-workspace-file",
		WorkspacePath: workspace,
		Path:          "notes.txt",
		Content:       "workspace content",
	})

	envelope := <-d.send
	result, err := protocol.DecodePayload[protocol.WorkspaceResult](envelope)
	if err != nil {
		t.Fatal(err)
	}
	if result.Error != "" {
		t.Fatalf("workspace write error = %q", result.Error)
	}
	if result.Path != "notes.txt" {
		t.Fatalf("workspace write path = %q, want notes.txt", result.Path)
	}
	content, err := os.ReadFile(filepath.Join(workspace, "notes.txt"))
	if err != nil {
		t.Fatal(err)
	}
	if string(content) != "workspace content" {
		t.Fatalf("workspace file content = %q", content)
	}
}
