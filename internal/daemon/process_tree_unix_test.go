//go:build linux

package daemon

import (
	"encoding/json"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"
)

const ownedProcessHelperEnv = "GO_WANT_OWNED_PROCESS_HELPER"

func TestOwnedProcessTreeHelper(t *testing.T) {
	mode := os.Getenv(ownedProcessHelperEnv)
	if mode == "" {
		return
	}

	switch mode {
	case "session-parent":
		if _, err := syscall.Setsid(); err != nil {
			os.Exit(20)
		}
		child := exec.Command(os.Args[0], "-test.run=^TestOwnedProcessTreeHelper$")
		child.Env = append(os.Environ(), ownedProcessHelperEnv+"=term-resistant-child")
		child.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
		if err := child.Start(); err != nil {
			os.Exit(21)
		}
		if !waitForFile(os.Getenv("OWNED_CHILD_READY"), 5*time.Second) {
			os.Exit(22)
		}
		owner, ownerOK := captureProcessIdentity(os.Getpid())
		childIdentity, childOK := captureProcessIdentity(child.Process.Pid)
		if !ownerOK || !childOK {
			os.Exit(23)
		}
		payload, _ := json.Marshal(map[string]any{
			"owner_pid":         owner.pid,
			"owner_start_ticks": owner.startTicks,
			"owner_sid":         owner.sessionID,
			"child_pid":         childIdentity.pid,
			"child_pgid":        childIdentity.processGroup,
			"child_sid":         childIdentity.sessionID,
		})
		if err := os.WriteFile(os.Getenv("OWNED_SESSION_READY"), payload, 0o600); err != nil {
			os.Exit(24)
		}
		if !waitForFile(os.Getenv("OWNED_SESSION_RELEASE"), 30*time.Second) {
			os.Exit(25)
		}
		os.Exit(0)
	case "control-parent":
		child := exec.Command(os.Args[0], "-test.run=^TestOwnedProcessTreeHelper$")
		child.Env = append(os.Environ(), ownedProcessHelperEnv+"=term-resistant-child")
		if err := child.Start(); err != nil {
			os.Exit(29)
		}
		if !waitForFile(os.Getenv("OWNED_CONTROL_READY"), 5*time.Second) {
			os.Exit(30)
		}
		os.Exit(0)
	case "term-resistant-child":
		signal.Ignore(syscall.SIGTERM)
		ready := firstNonEmpty(os.Getenv("OWNED_CHILD_READY"), os.Getenv("OWNED_CONTROL_READY"))
		if ready == "" {
			os.Exit(26)
		}
		if err := os.WriteFile(ready, []byte(strconv.Itoa(os.Getpid())), 0o600); err != nil {
			os.Exit(27)
		}
		for {
			time.Sleep(time.Second)
		}
	default:
		os.Exit(28)
	}
}

type detachedSessionFixture struct {
	command    *exec.Cmd
	wait       <-chan error
	owner      processIdentity
	childPID   int
	release    string
	childReady string
}

func startDetachedSessionFixture(t *testing.T) detachedSessionFixture {
	t.Helper()
	dir := t.TempDir()
	ready := filepath.Join(dir, "session-ready.json")
	release := filepath.Join(dir, "release")
	childReady := filepath.Join(dir, "child-ready")
	cmd := exec.Command(os.Args[0], "-test.run=^TestOwnedProcessTreeHelper$")
	cmd.Env = append(os.Environ(),
		ownedProcessHelperEnv+"=session-parent",
		"OWNED_SESSION_READY="+ready,
		"OWNED_SESSION_RELEASE="+release,
		"OWNED_CHILD_READY="+childReady,
	)
	if err := cmd.Start(); err != nil {
		t.Fatalf("start detached session helper: %v", err)
	}
	wait := make(chan error, 1)
	go func() { wait <- cmd.Wait() }()
	t.Cleanup(func() {
		_ = os.WriteFile(release, nil, 0o600)
		if owner, ok := captureProcessSessionLeader(cmd.Process.Pid); ok {
			terminateOwnedProcessSession(owner)
		}
	})
	if !waitForFile(ready, 5*time.Second) {
		t.Fatal("detached session helper did not become ready")
	}
	raw, err := os.ReadFile(ready)
	if err != nil {
		t.Fatalf("read detached session identity: %v", err)
	}
	var payload struct {
		OwnerPID       int    `json:"owner_pid"`
		OwnerStart     uint64 `json:"owner_start_ticks"`
		OwnerSID       int    `json:"owner_sid"`
		ChildPID       int    `json:"child_pid"`
		ChildPGID      int    `json:"child_pgid"`
		ChildSessionID int    `json:"child_sid"`
	}
	if err := json.Unmarshal(raw, &payload); err != nil {
		t.Fatalf("decode detached session identity: %v", err)
	}
	owner, ok := captureProcessSessionLeader(payload.OwnerPID)
	if !ok {
		t.Fatalf("capture session leader pid %d", payload.OwnerPID)
	}
	if owner.startTicks != payload.OwnerStart || owner.sessionID != payload.OwnerSID {
		t.Fatalf("session owner changed before capture: got %#v payload=%+v", owner, payload)
	}
	if payload.ChildPGID == owner.processGroup || payload.ChildSessionID != owner.sessionID {
		t.Fatalf("child did not create a distinct process group in owner SID: owner=%#v payload=%+v", owner, payload)
	}
	return detachedSessionFixture{
		command: cmd, wait: wait, owner: owner, childPID: payload.ChildPID,
		release: release, childReady: childReady,
	}
}

func TestCaptureStartedProcessIdentityAcceptsZombieOwner(t *testing.T) {
	dir := t.TempDir()
	ready := filepath.Join(dir, "zombie-owner-child-ready")
	cmd := exec.Command(os.Args[0], "-test.run=^TestOwnedProcessTreeHelper$")
	cmd.Env = append(os.Environ(),
		ownedProcessHelperEnv+"=control-parent",
		"OWNED_CONTROL_READY="+ready,
	)
	setProcessGroup(cmd)
	if err := cmd.Start(); err != nil {
		t.Fatalf("start zombie owner helper: %v", err)
	}
	cleaned := false
	t.Cleanup(func() {
		if cleaned {
			return
		}
		if owner, ok := captureStartedProcessIdentity(cmd.Process.Pid); ok {
			terminateOwnedProcessGroup(owner)
		}
		_ = cmd.Wait()
	})
	if !waitForFile(ready, 5*time.Second) {
		t.Fatal("zombie owner child did not become ready")
	}
	deadline := time.Now().Add(5 * time.Second)
	for {
		identity, ok := readProcessIdentity(cmd.Process.Pid)
		if ok && identity.state == 'Z' {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("control owner did not become a zombie before Wait: %#v", identity)
		}
		time.Sleep(10 * time.Millisecond)
	}
	if _, ok := captureProcessIdentity(cmd.Process.Pid); ok {
		t.Fatal("general live-process capture accepted zombie owner")
	}
	owner, ok := captureStartedProcessIdentity(cmd.Process.Pid)
	if !ok || owner.state != 'Z' {
		t.Fatalf("started-process capture rejected zombie owner: %#v", owner)
	}
	childPID := readPIDFile(t, ready)
	if !terminateOwnedProcessGroup(owner) {
		t.Fatal("zombie-owner process group cleanup failed")
	}
	if err := cmd.Wait(); err != nil {
		t.Fatalf("reap zombie owner: %v", err)
	}
	if processIsAlive(childPID) {
		t.Fatalf("zombie-owner child %d remains alive", childPID)
	}
	cleaned = true
}

func TestTerminateOwnedProcessSessionCleansReparentedDistinctGroupAndRejectsPIDReuse(t *testing.T) {
	fixture := startDetachedSessionFixture(t)
	staleOwner := fixture.owner
	staleOwner.startTicks++
	if terminateOwnedProcessSession(staleOwner) {
		t.Fatal("cleanup accepted a reused owner PID with mismatched start ticks")
	}
	if !processIsAlive(fixture.childPID) {
		t.Fatal("PID-reuse safety check killed the real session child")
	}

	if err := os.WriteFile(fixture.release, nil, 0o600); err != nil {
		t.Fatalf("release session leader: %v", err)
	}
	select {
	case err := <-fixture.wait:
		if err != nil {
			t.Fatalf("session leader exit: %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("session leader did not exit")
	}
	waitForProcessParent(t, fixture.childPID, 1)

	if !terminateOwnedProcessSession(fixture.owner) {
		t.Fatal("cleanup did not remove orphaned session members")
	}
	if processIsAlive(fixture.childPID) {
		t.Fatalf("orphaned distinct-group child %d remains alive", fixture.childPID)
	}
}

func TestTerminateOwnedProcessSessionRejectsCurrentDaemonSession(t *testing.T) {
	current, ok := captureProcessIdentity(os.Getpid())
	if !ok {
		t.Fatal("capture current process identity")
	}
	unsafeOwner := processIdentity{
		pid:          current.sessionID,
		processGroup: current.sessionID,
		sessionID:    current.sessionID,
		startTicks:   1,
		valid:        true,
	}
	if terminateOwnedProcessSession(unsafeOwner) {
		t.Fatal("cleanup accepted the daemon's current session")
	}
}

func waitForFile(path string, timeout time.Duration) bool {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if _, err := os.Stat(path); err == nil {
			return true
		}
		time.Sleep(10 * time.Millisecond)
	}
	return false
}

func readPIDFile(t *testing.T, path string) int {
	t.Helper()
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read PID file: %v", err)
	}
	pid, err := strconv.Atoi(strings.TrimSpace(string(raw)))
	if err != nil {
		t.Fatalf("decode PID file: %v", err)
	}
	return pid
}

func processIsAlive(pid int) bool {
	identity, ok := readProcessIdentity(pid)
	return ok && identity.state != 'Z'
}

func waitForProcessParent(t *testing.T, pid int, parentPID int) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		identity, ok := readProcessIdentity(pid)
		if ok && identity.state != 'Z' && identity.parentPID == parentPID {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	identity, _ := readProcessIdentity(pid)
	t.Fatalf("process %d was not reparented to %d: %#v", pid, parentPID, identity)
}
