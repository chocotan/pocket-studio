package daemon

import (
	"os"
	"os/exec"
	"testing"

	"remote-agent/internal/protocol"
)

func TestExitTerminalStreamKillsTmuxWhenClosingSession(t *testing.T) {
	d := New(DefaultConfig())
	ptyFile, err := os.Open(os.DevNull)
	if err != nil {
		t.Fatalf("open dev null: %v", err)
	}
	defer ptyFile.Close()

	d.terminalPTYs["project-1::term-1"] = &runningPTY{
		projectID:   "project-1",
		terminalID:  "term-1",
		sessionName: "session-1",
		usesTmux:    true,
		ptyFile:     ptyFile,
		cmd:         exec.Command("true"),
	}

	var killed []string
	originalKillTmuxSession := killTmuxSession
	killTmuxSession = func(sessionName string) error {
		killed = append(killed, sessionName)
		return nil
	}
	defer func() {
		killTmuxSession = originalKillTmuxSession
	}()

	d.exitTerminalStream(protocol.TerminalStreamExit{
		ProjectID:    "project-1",
		TerminalID:   "term-1",
		CloseSession: true,
	})

	if len(killed) != 1 || killed[0] != "session-1" {
		t.Fatalf("killed tmux sessions = %#v, want session-1", killed)
	}
}

func TestExitTerminalStreamKeepsTmuxOnConnectionClose(t *testing.T) {
	d := New(DefaultConfig())
	ptyFile, err := os.Open(os.DevNull)
	if err != nil {
		t.Fatalf("open dev null: %v", err)
	}
	defer ptyFile.Close()

	d.terminalPTYs["project-1::term-1"] = &runningPTY{
		projectID:   "project-1",
		terminalID:  "term-1",
		sessionName: "session-1",
		usesTmux:    true,
		ptyFile:     ptyFile,
		cmd:         exec.Command("true"),
	}

	var killed []string
	originalKillTmuxSession := killTmuxSession
	killTmuxSession = func(sessionName string) error {
		killed = append(killed, sessionName)
		return nil
	}
	defer func() {
		killTmuxSession = originalKillTmuxSession
	}()

	d.exitTerminalStream(protocol.TerminalStreamExit{
		ProjectID:  "project-1",
		TerminalID: "term-1",
	})

	if len(killed) != 0 {
		t.Fatalf("killed tmux sessions = %#v, want none", killed)
	}
}
