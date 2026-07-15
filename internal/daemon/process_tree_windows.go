//go:build windows

package daemon

import (
	"os"
	"os/exec"
	"strconv"
)

type processIdentity struct {
	pid          int
	parentPID    int
	processGroup int
	sessionID    int
	startTicks   uint64
	state        byte
	valid        bool
}

func captureProcessIdentity(pid int) (processIdentity, bool) {
	if pid <= 1 {
		return processIdentity{}, false
	}
	return processIdentity{pid: pid, processGroup: pid, sessionID: pid, startTicks: 1, valid: true}, true
}

func captureStartedProcessIdentity(pid int) (processIdentity, bool) {
	return captureProcessIdentity(pid)
}

func captureProcessSessionLeader(pid int) (processIdentity, bool) {
	return captureProcessIdentity(pid)
}

func terminateOwnedProcessGroup(owner processIdentity) bool {
	return terminateWindowsProcessTree(owner)
}

func terminateOwnedProcessSession(owner processIdentity) bool {
	return terminateWindowsProcessTree(owner)
}

func terminateWindowsProcessTree(owner processIdentity) bool {
	if !owner.valid || owner.pid <= 1 || owner.pid == os.Getpid() {
		return false
	}
	return exec.Command("taskkill", "/PID", strconv.Itoa(owner.pid), "/T", "/F").Run() == nil
}

func killProcessesRecursively(parentPID int) {
	if err := exec.Command("taskkill", "/PID", strconv.Itoa(parentPID), "/T", "/F").Run(); err == nil {
		return
	}
	process, err := os.FindProcess(parentPID)
	if err == nil {
		_ = process.Kill()
	}
}
