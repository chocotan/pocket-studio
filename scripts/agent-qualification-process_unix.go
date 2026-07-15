//go:build !windows

package main

import (
	"os/exec"
	"sync"
	"syscall"
	"time"
)

func configureQualificationProcess(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
}

func processGroupCleanup(cmd *exec.Cmd) func() {
	var once sync.Once
	return func() {
		once.Do(func() {
			if cmd.Process == nil {
				return
			}
			_ = syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
			waitForQualificationProcess(cmd)
		})
	}
}

func waitForQualificationProcess(cmd *exec.Cmd) {
	done := make(chan struct{})
	go func() {
		_ = cmd.Wait()
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
	}
}
