//go:build !windows

package daemon

import (
	"fmt"
	"os"
	"strconv"
	"strings"
	"syscall"
	"time"
)

const ownedProcessCleanupGrace = 250 * time.Millisecond

type processIdentity struct {
	pid          int
	parentPID    int
	processGroup int
	sessionID    int
	startTicks   uint64
	state        byte
	valid        bool
}

func readProcessIdentity(pid int) (processIdentity, bool) {
	if pid <= 1 {
		return processIdentity{}, false
	}
	raw, err := os.ReadFile(fmt.Sprintf("/proc/%d/stat", pid))
	if err != nil {
		return processIdentity{}, false
	}
	text := string(raw)
	end := strings.LastIndex(text, ") ")
	if end < 0 {
		return processIdentity{}, false
	}
	fields := strings.Fields(text[end+2:])
	if len(fields) < 20 || len(fields[0]) != 1 {
		return processIdentity{}, false
	}
	parentPID, err := strconv.Atoi(fields[1])
	if err != nil {
		return processIdentity{}, false
	}
	processGroup, err := strconv.Atoi(fields[2])
	if err != nil {
		return processIdentity{}, false
	}
	sessionID, err := strconv.Atoi(fields[3])
	if err != nil {
		return processIdentity{}, false
	}
	startTicks, err := strconv.ParseUint(fields[19], 10, 64)
	if err != nil {
		return processIdentity{}, false
	}
	return processIdentity{
		pid:          pid,
		parentPID:    parentPID,
		processGroup: processGroup,
		sessionID:    sessionID,
		startTicks:   startTicks,
		state:        fields[0][0],
		valid:        true,
	}, true
}

func captureProcessIdentity(pid int) (processIdentity, bool) {
	identity, ok := readProcessIdentity(pid)
	if !ok || identity.state == 'Z' {
		return processIdentity{}, false
	}
	return identity, true
}

func captureStartedProcessIdentity(pid int) (processIdentity, bool) {
	identity, ok := readProcessIdentity(pid)
	if !ok || identity.startTicks == 0 || identity.pid != identity.processGroup {
		return processIdentity{}, false
	}
	current, ok := captureProcessIdentity(os.Getpid())
	if !ok || identity.processGroup == current.processGroup {
		return processIdentity{}, false
	}
	return identity, true
}

func captureProcessSessionLeader(pid int) (processIdentity, bool) {
	identity, ok := captureProcessIdentity(pid)
	if !ok || identity.pid != identity.processGroup || identity.pid != identity.sessionID {
		return processIdentity{}, false
	}
	current, ok := captureProcessIdentity(os.Getpid())
	if !ok || identity.sessionID == current.sessionID {
		return processIdentity{}, false
	}
	return identity, true
}

func terminateOwnedProcessGroup(owner processIdentity) bool {
	if !owner.valid || owner.pid <= 1 || owner.pid != owner.processGroup || owner.startTicks == 0 {
		return false
	}
	current, ok := captureProcessIdentity(os.Getpid())
	if !ok || owner.processGroup == current.processGroup {
		return false
	}
	return terminateOwnedProcesses(owner, func(identity processIdentity) bool {
		return identity.processGroup == owner.processGroup
	})
}

func terminateOwnedProcessSession(owner processIdentity) bool {
	if !owner.valid || owner.pid <= 1 || owner.pid != owner.processGroup || owner.pid != owner.sessionID || owner.startTicks == 0 {
		return false
	}
	current, ok := captureProcessIdentity(os.Getpid())
	if !ok || owner.sessionID == current.sessionID {
		return false
	}
	return terminateOwnedProcesses(owner, func(identity processIdentity) bool {
		return identity.sessionID == owner.sessionID
	})
}

func terminateOwnedProcesses(owner processIdentity, matches func(processIdentity) bool) bool {
	if liveOwner, ok := readProcessIdentity(owner.pid); ok && liveOwner.state != 'Z' {
		if liveOwner.startTicks != owner.startTicks || !matches(liveOwner) {
			return false
		}
	}

	targets := matchingProcessIdentities(owner, matches)
	for _, target := range targets {
		signalMatchingProcess(target, matches, syscall.SIGTERM)
	}
	if waitForOwnedProcesses(owner, matches, ownedProcessCleanupGrace) {
		return true
	}
	for _, target := range matchingProcessIdentities(owner, matches) {
		signalMatchingProcess(target, matches, syscall.SIGKILL)
	}
	return waitForOwnedProcesses(owner, matches, ownedProcessCleanupGrace)
}

func signalMatchingProcess(target processIdentity, matches func(processIdentity) bool, signal syscall.Signal) {
	current, ok := readProcessIdentity(target.pid)
	if !ok || current.state == 'Z' || current.startTicks != target.startTicks || !matches(current) {
		return
	}
	_ = syscall.Kill(target.pid, signal)
}

func waitForOwnedProcesses(owner processIdentity, matches func(processIdentity) bool, timeout time.Duration) bool {
	deadline := time.Now().Add(timeout)
	for {
		if len(matchingProcessIdentities(owner, matches)) == 0 {
			return true
		}
		if time.Now().After(deadline) {
			return false
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func matchingProcessIdentities(owner processIdentity, matches func(processIdentity) bool) []processIdentity {
	files, err := os.ReadDir("/proc")
	if err != nil {
		return nil
	}
	currentPID := os.Getpid()
	identities := make([]processIdentity, 0)
	for _, file := range files {
		if !file.IsDir() {
			continue
		}
		pid, err := strconv.Atoi(file.Name())
		if err != nil || pid <= 1 || pid == currentPID {
			continue
		}
		identity, ok := readProcessIdentity(pid)
		if !ok || identity.state == 'Z' || identity.startTicks < owner.startTicks || !matches(identity) {
			continue
		}
		identities = append(identities, identity)
	}
	return identities
}

func killProcessesRecursively(parentPID int) {
	parentToChildren := make(map[int][]int)
	files, err := os.ReadDir("/proc")
	if err == nil {
		for _, file := range files {
			if !file.IsDir() {
				continue
			}
			pid, err := strconv.Atoi(file.Name())
			if err != nil {
				continue
			}
			if parent := getParentPID(pid); parent > 0 {
				parentToChildren[parent] = append(parentToChildren[parent], pid)
			}
		}
	}

	var descendants []int
	var collect func(int)
	collect = func(pid int) {
		for _, child := range parentToChildren[pid] {
			descendants = append(descendants, child)
			collect(child)
		}
	}
	collect(parentPID)
	for i := len(descendants) - 1; i >= 0; i-- {
		_ = syscall.Kill(descendants[i], syscall.SIGKILL)
	}
	_ = syscall.Kill(-parentPID, syscall.SIGKILL)
	_ = syscall.Kill(parentPID, syscall.SIGKILL)
}

func getParentPID(pid int) int {
	identity, ok := readProcessIdentity(pid)
	if !ok {
		return 0
	}
	return identity.parentPID
}
