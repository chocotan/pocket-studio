//go:build !windows

package main

import (
	"errors"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"
)

func TestProcessGroupCleanupKillsChildProcess(t *testing.T) {
	dir := t.TempDir()
	childPIDPath := dir + "/child.pid"
	cmd := exec.Command("sh", "-c", `sleep 30 & echo $! > "$1"; wait`, "sh", childPIDPath)
	configureQualificationProcess(cmd)
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	cleanup := processGroupCleanup(cmd)
	t.Cleanup(cleanup)

	var childPID int
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		raw, err := os.ReadFile(childPIDPath)
		if err == nil {
			childPID, _ = strconv.Atoi(strings.TrimSpace(string(raw)))
			if childPID > 0 {
				break
			}
		}
		time.Sleep(10 * time.Millisecond)
	}
	if childPID == 0 {
		t.Fatal("child process did not start")
	}

	cleanup()
	deadline = time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		err := syscall.Kill(childPID, 0)
		if errors.Is(err, syscall.ESRCH) {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("child process %d survived process-group cleanup", childPID)
}
