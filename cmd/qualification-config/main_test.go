package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestQualificationConfigListIsSanitizedAndExecAppliesEnvironment(t *testing.T) {
	dir := t.TempDir()
	config := `{
		"direct_acp": {
			"agents": {
				"codex": {
					"command": "/bin/sh",
					"args": ["-c", "printf %s \"$QUALIFICATION_SECRET\""],
					"env": {"QUALIFICATION_SECRET": "persisted-secret"}
				}
			}
		}
	}`
	if err := os.WriteFile(filepath.Join(dir, "agentbridge.daemon.json"), []byte(config), 0o600); err != nil {
		t.Fatal(err)
	}
	env := append(os.Environ(),
		"POCKET_STUDIO_DAEMON_CONFIG_DIR="+dir,
		"QUALIFICATION_SECRET=parent-secret",
	)

	list := exec.Command("go", "run", ".")
	list.Env = env
	output, err := list.CombinedOutput()
	if err != nil {
		t.Fatalf("qualification config list error = %v: %s", err, output)
	}
	if strings.Contains(string(output), "persisted-secret") || !strings.Contains(string(output), "QUALIFICATION_SECRET") {
		t.Fatalf("qualification config list must contain env key but not value: %s", output)
	}

	run := exec.Command("go", "run", ".", "--exec-agent", "codex")
	run.Env = env
	output, err = run.CombinedOutput()
	if err != nil {
		t.Fatalf("qualification config exec error = %v: %s", err, output)
	}
	if got := string(output); got != "persisted-secret" {
		t.Fatalf("qualification config exec output = %q, want persisted-secret", got)
	}
}
