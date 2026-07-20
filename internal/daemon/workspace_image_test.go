package daemon

import "testing"

func TestWorkspaceFileReadLimitAllowsACPImagePreview(t *testing.T) {
	if got := workspaceFileReadLimit("chat_image.png"); got != 20<<20 {
		t.Fatalf("image read limit = %d, want %d", got, 20<<20)
	}
	if got := workspaceFileReadLimit("notes.txt"); got != 1<<20 {
		t.Fatalf("text read limit = %d, want %d", got, 1<<20)
	}
}
