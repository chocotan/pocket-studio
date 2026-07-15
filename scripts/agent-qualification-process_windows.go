//go:build windows

package main

import (
	"os/exec"
	"strconv"
	"sync"
	"time"
)

func configureQualificationProcess(_ *exec.Cmd) {}

func processGroupCleanup(cmd *exec.Cmd) func() {
	var once sync.Once
	return func() {
		once.Do(func() {
			if cmd.Process == nil {
				return
			}
			if err := exec.Command("taskkill", "/PID", strconv.Itoa(cmd.Process.Pid), "/T", "/F").Run(); err != nil {
				_ = cmd.Process.Kill()
			}
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
