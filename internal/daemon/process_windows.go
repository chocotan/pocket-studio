//go:build windows

package daemon

import "os/exec"

func setProcessGroup(_ *exec.Cmd) {}

func terminateProcess(cmd *exec.Cmd) {
	if cmd == nil || cmd.Process == nil {
		return
	}
	_ = cmd.Process.Kill()
}

func killProcess(cmd *exec.Cmd) {
	if cmd == nil || cmd.Process == nil {
		return
	}
	_ = cmd.Process.Kill()
}

func loginShellFromPasswd() string {
	return ""
}
