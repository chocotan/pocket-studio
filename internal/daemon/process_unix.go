//go:build !windows

package daemon

import (
	"os/exec"
	"os/user"
	"strings"
	"syscall"
)

func setProcessGroup(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
}

func terminateProcess(cmd *exec.Cmd) {
	if cmd == nil || cmd.Process == nil {
		return
	}
	_ = syscall.Kill(-cmd.Process.Pid, syscall.SIGTERM)
}

func killProcess(cmd *exec.Cmd) {
	if cmd == nil || cmd.Process == nil {
		return
	}
	_ = syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
}

func loginShellFromPasswd() string {
	current, err := user.Current()
	if err != nil || current.Username == "" {
		return ""
	}
	raw, err := exec.Command("sh", "-c", "getent passwd \"$1\" 2>/dev/null || dscl . -read \"/Users/$1\" UserShell 2>/dev/null", "sh", current.Username).Output()
	if err != nil || len(raw) == 0 {
		return ""
	}
	fields := strings.Fields(string(raw))
	if len(fields) >= 2 && fields[0] == "UserShell:" {
		return fields[1]
	}
	parts := strings.Split(strings.TrimSpace(string(raw)), ":")
	if len(parts) >= 7 {
		return strings.TrimSpace(parts[6])
	}
	return ""
}
