package daemon

import "testing"

// The daemon must strip host-terminal fingerprint variables (KITTY_WINDOW_ID,
// WEZTERM_PANE, GHOSTTY_RESOURCES_DIR, TMUX, TMUX_PANE) from the environment it
// injects into PTY children. CLIs like pi sniff them to choose a terminal
// graphics protocol: with KITTY_WINDOW_ID inherited from a kitty-launched
// daemon, pi emits kitty APC graphics that the web xterm renderer cannot
// display, breaking inline images even on plain-PTY (use_tmux=0) terminals.
func TestTerminalEnvStripsHostTerminalFingerprints(t *testing.T) {
	t.Setenv("KITTY_WINDOW_ID", "1")
	t.Setenv("WEZTERM_PANE", "7")
	t.Setenv("GHOSTTY_RESOURCES_DIR", "/opt/ghostty")
	t.Setenv("TMUX", "/tmp/tmux-1000/default,123,0")
	t.Setenv("TMUX_PANE", "%158")

	env := terminalEnv()

	for _, key := range []string{"KITTY_WINDOW_ID", "WEZTERM_PANE", "GHOSTTY_RESOURCES_DIR", "TMUX", "TMUX_PANE"} {
		for _, item := range env {
			if len(item) > len(key) && item[:len(key)+1] == key+"=" {
				t.Errorf("terminalEnv leaked %s: %q", key, item)
			}
		}
	}

	// The web client protocol selector must stay present.
	assertEnvValue(t, env, "ITERM_SESSION_ID", "pocket-studio")
	assertEnvValue(t, env, "TERM_PROGRAM", "PocketStudio")
}

// tmuxProcessEnv builds on terminalEnv and must inherit the same filtering.
func TestTmuxProcessEnvStripsHostTerminalFingerprints(t *testing.T) {
	t.Setenv("KITTY_WINDOW_ID", "1")
	t.Setenv("TMUX", "/tmp/tmux-1000/default,123,0")

	for _, item := range tmuxProcessEnv() {
		if len(item) > len("KITTY_WINDOW_ID") && item[:len("KITTY_WINDOW_ID")+1] == "KITTY_WINDOW_ID=" {
			t.Errorf("tmuxProcessEnv leaked KITTY_WINDOW_ID: %q", item)
		}
		if len(item) > len("TMUX") && item[:len("TMUX")+1] == "TMUX=" {
			t.Errorf("tmuxProcessEnv leaked TMUX: %q", item)
		}
	}
}

func assertEnvValue(t *testing.T, env []string, key, want string) {
	t.Helper()
	prefix := key + "="
	for _, item := range env {
		if len(item) > len(prefix) && item[:len(prefix)] == prefix {
			if got := item[len(prefix):]; got != want {
				t.Errorf("%s = %q, want %q", key, got, want)
			}
			return
		}
	}
	t.Errorf("%s missing from env", key)
}
