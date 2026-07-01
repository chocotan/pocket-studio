package protocol

import (
	"testing"
	"time"
)

func TestDirectTerminalTokenIsProjectScopedAndExpires(t *testing.T) {
	expiresAt := time.Unix(2000, 0)
	token := NewDirectTerminalToken("secret", "project-a", expiresAt)
	if token == "" {
		t.Fatal("NewDirectTerminalToken returned empty")
	}
	if !VerifyDirectTerminalToken("secret", "project-a", token, time.Unix(1999, 0)) {
		t.Fatal("valid project token rejected")
	}
	if VerifyDirectTerminalToken("secret", "project-b", token, time.Unix(1999, 0)) {
		t.Fatal("token accepted for different project")
	}
	if VerifyDirectTerminalToken("secret", "project-a", token, time.Unix(2001, 0)) {
		t.Fatal("expired token accepted")
	}
	if VerifyDirectTerminalToken("other", "project-a", token, time.Unix(1999, 0)) {
		t.Fatal("token accepted with different secret")
	}
}
