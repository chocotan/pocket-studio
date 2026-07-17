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

func TestExitTerminalStreamKeepsTmuxWhenLastClientDisconnects(t *testing.T) {
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
	if len(d.terminalPTYs) != 0 {
		t.Fatalf("terminal PTYs = %d, want none", len(d.terminalPTYs))
	}
}

func TestExitTerminalStreamDisconnectsAllClientsWithoutKillingTmux(t *testing.T) {
	d := New(DefaultConfig())
	firstFile, err := os.Open(os.DevNull)
	if err != nil {
		t.Fatalf("open first dev null: %v", err)
	}
	defer firstFile.Close()
	secondFile, err := os.Open(os.DevNull)
	if err != nil {
		t.Fatalf("open second dev null: %v", err)
	}
	defer secondFile.Close()

	d.terminalPTYs[terminalPTYKey("project-1", "term-1", "client-1")] = &runningPTY{
		projectID: "project-1", terminalID: "term-1", clientID: "client-1",
		sessionName: "session-1", usesTmux: true, ptyFile: firstFile, cmd: exec.Command("true"),
	}
	d.terminalPTYs[terminalPTYKey("project-1", "term-1", "client-2")] = &runningPTY{
		projectID: "project-1", terminalID: "term-1", clientID: "client-2",
		sessionName: "session-1", usesTmux: true, ptyFile: secondFile, cmd: exec.Command("true"),
	}

	var killed []string
	originalKillTmuxSession := killTmuxSession
	killTmuxSession = func(sessionName string) error {
		killed = append(killed, sessionName)
		return nil
	}
	defer func() { killTmuxSession = originalKillTmuxSession }()

	d.exitTerminalStream(protocol.TerminalStreamExit{
		ProjectID: "project-1", TerminalID: "term-1", ClientID: "client-1",
	})
	if len(killed) != 0 {
		t.Fatalf("tmux killed while another client remained: %#v", killed)
	}
	if len(d.terminalPTYs) != 1 {
		t.Fatalf("terminal PTYs after first close = %d, want 1", len(d.terminalPTYs))
	}

	d.exitTerminalStream(protocol.TerminalStreamExit{
		ProjectID: "project-1", TerminalID: "term-1", ClientID: "client-2",
	})
	if len(killed) != 0 {
		t.Fatalf("killed tmux sessions after all clients disconnected = %#v, want none", killed)
	}
	if len(d.terminalPTYs) != 0 {
		t.Fatalf("terminal PTYs after last close = %d, want none", len(d.terminalPTYs))
	}
}
