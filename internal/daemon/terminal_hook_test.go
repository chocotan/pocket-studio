package daemon

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"remote-agent/internal/protocol"
)

func TestTerminalHookAlertDeduplicatesBriefRepeats(t *testing.T) {
	d := New(Config{})
	event := terminalHookEvent{
		ProjectID:  "project",
		TerminalID: "terminal",
		Agent:      "opencode",
		Event:      "done",
	}

	first := d.terminalHookAlert(event)
	if first == nil {
		t.Fatal("terminalHookAlert() first event = nil, want alert")
	}
	if first.Reason != "agent_done" || first.Message != "任务已完成" || first.Agent != "opencode" {
		t.Fatalf("terminalHookAlert() = %#v, want opencode completion alert", first)
	}
	if second := d.terminalHookAlert(event); second != nil {
		t.Fatalf("terminalHookAlert() duplicate = %#v, want nil", second)
	}
}

func TestAgentCompletionAlertMapsTaskToSavedAgentTab(t *testing.T) {
	workspace := t.TempDir()
	cfg := Config{Device: DeviceConfig{ID: "device-1"}}
	d := New(cfg)
	projectID := d.projectIDForWorkspacePath(workspace)
	d.projectStates[projectID] = json.RawMessage(`{
		"layoutTree": {
			"type": "panel",
			"id": "panel-1",
			"tabs": [
				{
					"id": "chat-1",
					"kind": "agent_chat",
					"agentSessionId": "acpx-task-1",
					"agentRuntime": "acpx",
					"agentKind": "opencode"
				}
			]
		}
	}`)

	d.history["acpx-task-1"] = protocol.TaskRecord{
		TaskID:        "acpx-task-1",
		WorkspacePath: workspace,
		Agent:         "opencode",
		AgentRuntime:  "acpx",
		SessionName:   "acpx-task-1",
	}
	d.emitTaskEvent("acpx-task-1", "task.completed", 0, map[string]any{"exit_code": 0}, nil)

	events := drainEnvelopes(d.send)
	var alert protocol.TerminalStreamAlert
	for _, env := range events {
		if env.Type != protocol.TypeTerminalStreamAlert {
			continue
		}
		if err := json.Unmarshal(env.Payload, &alert); err != nil {
			t.Fatalf("decode alert: %v", err)
		}
	}
	if alert.ProjectID != projectID || alert.TerminalID != "chat-1" || alert.Reason != "agent_done" || alert.Message != "任务已完成" {
		t.Fatalf("agent completion alert = %#v, want saved chat tab completion", alert)
	}
	if alert.HostProjectID != projectID || alert.PanelID != "panel-1" {
		t.Fatalf("alert host = %q panel = %q, want project %q panel-1", alert.HostProjectID, alert.PanelID, projectID)
	}
	if alert.Title != "ACPX会话 (opencode)" {
		t.Fatalf("alert title = %q, want ACPX title", alert.Title)
	}
}

func TestAgentCompletionAlertMapsCrossProjectTaskToHostLayout(t *testing.T) {
	workspace := t.TempDir()
	cfg := Config{Device: DeviceConfig{ID: "device-1"}}
	d := New(cfg)
	taskProjectID := d.projectIDForWorkspacePath(workspace)
	hostProjectID := "host-project"
	d.projectStates[hostProjectID] = json.RawMessage(`{
		"layoutTree": {
			"type": "panel",
			"id": "panel-host",
			"tabs": [
				{
					"id": "chat-host",
					"kind": "agent_chat",
					"agentSessionId": "acpx-task-cross",
					"agentRuntime": "acpx",
					"agentKind": "opencode",
					"projectId": "` + taskProjectID + `"
				}
			]
		}
	}`)

	d.history["acpx-task-cross"] = protocol.TaskRecord{
		TaskID:        "acpx-task-cross",
		WorkspacePath: workspace,
		Agent:         "opencode",
		AgentRuntime:  "acpx",
		SessionName:   "acpx-task-cross",
	}
	d.emitTaskEvent("acpx-task-cross", "task.completed", 0, map[string]any{"exit_code": 0}, nil)

	events := drainEnvelopes(d.send)
	var alert protocol.TerminalStreamAlert
	for _, env := range events {
		if env.Type != protocol.TypeTerminalStreamAlert {
			continue
		}
		if err := json.Unmarshal(env.Payload, &alert); err != nil {
			t.Fatalf("decode alert: %v", err)
		}
	}
	if alert.ProjectID != taskProjectID || alert.HostProjectID != hostProjectID || alert.PanelID != "panel-host" || alert.TerminalID != "chat-host" {
		t.Fatalf("agent completion alert = %#v, want task project with host layout target", alert)
	}
}

func TestDirectACPCompletionAlertUsesTaskIDWhenNoSavedTab(t *testing.T) {
	workspace := t.TempDir()
	cfg := Config{Device: DeviceConfig{ID: "device-1"}}
	d := New(cfg)
	projectID := d.projectIDForWorkspacePath(workspace)
	d.history["direct-task-1"] = protocol.TaskRecord{
		TaskID:        "direct-task-1",
		WorkspacePath: workspace,
		Agent:         "codex",
		AgentRuntime:  "direct_acp",
		SessionName:   "direct-task-1",
	}
	d.emitTaskEvent("direct-task-1", "task.failed", 0, map[string]any{"error": "boom"}, nil)

	events := drainEnvelopes(d.send)
	var alert protocol.TerminalStreamAlert
	for _, env := range events {
		if env.Type != protocol.TypeTerminalStreamAlert {
			continue
		}
		if err := json.Unmarshal(env.Payload, &alert); err != nil {
			t.Fatalf("decode alert: %v", err)
		}
	}
	if alert.ProjectID != projectID || alert.TerminalID != "direct-task-1" || alert.Message != "任务执行失败" {
		t.Fatalf("direct ACP alert = %#v, want fallback task id failure alert", alert)
	}
	if alert.Title != "Direct ACP对话 (codex)" {
		t.Fatalf("alert title = %q, want Direct ACP title", alert.Title)
	}
}

func TestTerminalHookAlertMapsCrossProjectTerminalToHostLayout(t *testing.T) {
	d := New(Config{})
	d.projectStates["host-project"] = json.RawMessage(`{
		"layoutTree": {
			"type": "panel",
			"id": "panel-host",
			"tabs": [
				{
					"id": "term-cross",
					"kind": "terminal",
					"projectId": "task-project"
				}
			]
		}
	}`)

	alert := d.terminalHookAlert(terminalHookEvent{
		ProjectID:  "task-project",
		TerminalID: "term-cross",
		Agent:      "codex",
		Event:      "done",
	})
	if alert == nil {
		t.Fatal("terminalHookAlert() = nil, want alert")
	}
	if alert.ProjectID != "task-project" || alert.HostProjectID != "host-project" || alert.PanelID != "panel-host" || alert.TerminalID != "term-cross" {
		t.Fatalf("terminal hook alert = %#v, want cross-project host target", alert)
	}
}

func TestPrepareTerminalAgentHooksWritesPluginAndEnvForPluginAgents(t *testing.T) {
	d := New(Config{})
	d.hookURL = "http://127.0.0.1:1/terminal-event"
	d.hookToken = "token"
	workspace := t.TempDir()
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	t.Setenv("CLAUDE_CONFIG_DIR", t.TempDir())
	t.Setenv("CODEX_HOME", t.TempDir())

	hooks := d.prepareTerminalAgentHooks(workspace, "project", "terminal", "opencode")
	if len(hooks.env) == 0 {
		t.Fatal("prepareTerminalAgentHooks() env is empty, want hook env")
	}
	if _, err := os.Stat(filepath.Join(os.Getenv("XDG_CONFIG_HOME"), "opencode", "plugins", "pocket-studio.ts")); err != nil {
		t.Fatalf("opencode plugin was not written: %v", err)
	}
}

func TestPrepareTerminalAgentHooksConfiguresKiloPlugin(t *testing.T) {
	d := New(Config{})
	d.hookURL = "http://127.0.0.1:1/terminal-event"
	d.hookToken = "token"
	configHome := t.TempDir()
	t.Setenv("XDG_CONFIG_HOME", configHome)

	hooks := d.prepareTerminalAgentHooks(t.TempDir(), "project", "terminal", "kilo")
	if len(hooks.env) == 0 {
		t.Fatal("prepareTerminalAgentHooks() env is empty, want hook env for kilo")
	}
	pluginPath := filepath.Join(configHome, "kilo", "plugin", "pocket-studio.ts")
	if _, err := os.Stat(pluginPath); err != nil {
		t.Fatalf("kilo plugin was not written: %v", err)
	}
	configEnv := envValue(hooks.env, "KILO_CONFIG_CONTENT")
	if configEnv == "" {
		t.Fatalf("prepareTerminalAgentHooks() env missing KILO_CONFIG_CONTENT: %#v", hooks.env)
	}
	var cfg struct {
		Plugin []string `json:"plugin"`
	}
	if err := json.Unmarshal([]byte(configEnv), &cfg); err != nil {
		t.Fatalf("KILO_CONFIG_CONTENT is not JSON: %v\n%s", err, configEnv)
	}
	if len(cfg.Plugin) != 1 || cfg.Plugin[0] != pluginPath {
		t.Fatalf("KILO_CONFIG_CONTENT plugin = %#v, want %q", cfg.Plugin, pluginPath)
	}
}

func TestPrepareTerminalAgentHooksConfiguresPiExtension(t *testing.T) {
	d := New(Config{})
	d.hookURL = "http://127.0.0.1:1/terminal-event"
	d.hookToken = "token"
	piDir := t.TempDir()
	t.Setenv("PI_CODING_AGENT_DIR", piDir)

	hooks := d.prepareTerminalAgentHooks(t.TempDir(), "project", "terminal", "pi")
	if len(hooks.env) == 0 {
		t.Fatal("prepareTerminalAgentHooks() env is empty, want hook env for pi")
	}
	extensionPath := filepath.Join(piDir, "extensions", "pocket-studio.ts")
	if _, err := os.Stat(extensionPath); err != nil {
		t.Fatalf("pi extension was not written: %v", err)
	}
	if got := envValue(hooks.env, "POCKET_STUDIO_PI_EXTENSION"); got != extensionPath {
		t.Fatalf("POCKET_STUDIO_PI_EXTENSION = %q, want %q", got, extensionPath)
	}
}

func TestOpenCodePluginUsesExportedPluginFunctionShape(t *testing.T) {
	plugin := pocketStudioOpenCodePlugin()
	if !strings.Contains(plugin, `export const PocketStudio = async () => ({`) {
		t.Fatalf("pocketStudioOpenCodePlugin() missing exported plugin function:\n%s", plugin)
	}
	if strings.Contains(plugin, "export default") {
		t.Fatalf("pocketStudioOpenCodePlugin() uses default module shape, want exported plugin function:\n%s", plugin)
	}
}

func TestOpenCodePluginPostsSessionIdleCompletion(t *testing.T) {
	plugin := pocketStudioOpenCodePlugin()
	for _, want := range []string{
		`event.type !== "session.idle"`,
		`process.env.POCKET_STUDIO_HOOK_URL`,
		`process.env.POCKET_STUDIO_PROJECT_ID`,
		`process.env.POCKET_STUDIO_TERMINAL_ID`,
		`event: "done"`,
		`message: "任务已完成"`,
	} {
		if !strings.Contains(plugin, want) {
			t.Fatalf("pocketStudioOpenCodePlugin() missing %q:\n%s", want, plugin)
		}
	}
}

func TestKiloPluginPostsSessionIdleCompletion(t *testing.T) {
	plugin := pocketStudioKiloPlugin()
	for _, want := range []string{
		`export default async () => ({`,
		`event.type !== "session.idle"`,
		`process.env.POCKET_STUDIO_HOOK_URL`,
		`process.env.POCKET_STUDIO_PROJECT_ID`,
		`process.env.POCKET_STUDIO_TERMINAL_ID`,
		`process.env.POCKET_STUDIO_AGENT || "kilo"`,
		`event: "done"`,
		`message: "任务已完成"`,
	} {
		if !strings.Contains(plugin, want) {
			t.Fatalf("pocketStudioKiloPlugin() missing %q:\n%s", want, plugin)
		}
	}
}

func TestPiExtensionPostsAgentEndCompletion(t *testing.T) {
	extension := pocketStudioPiExtension()
	for _, want := range []string{
		`pi.on("agent_end"`,
		`event?.willRetry`,
		`process.env.POCKET_STUDIO_HOOK_URL`,
		`process.env.POCKET_STUDIO_PROJECT_ID`,
		`process.env.POCKET_STUDIO_TERMINAL_ID`,
		`process.env.POCKET_STUDIO_AGENT || "pi"`,
		`event: "done"`,
		`message: "任务已完成"`,
	} {
		if !strings.Contains(extension, want) {
			t.Fatalf("pocketStudioPiExtension() missing %q:\n%s", want, extension)
		}
	}
}

func TestTerminalNotifyScriptPostsCompletionAndRunsPreviousNotify(t *testing.T) {
	previousPath := filepath.Join(t.TempDir(), "previous.json")
	script := pocketStudioTerminalNotifyScript(&previousPath)
	for _, want := range []string{
		`process.env.POCKET_STUDIO_HOOK_URL`,
		`process.env.POCKET_STUDIO_PROJECT_ID`,
		`process.env.POCKET_STUDIO_TERMINAL_ID`,
		`process.env.POCKET_STUDIO_AGENT || "agent"`,
		`event: "done"`,
		`message: messageFromPayload(payload)`,
		`runPreviousNotify(payloadArg)`,
		previousPath,
	} {
		if !strings.Contains(script, want) {
			t.Fatalf("pocketStudioTerminalNotifyScript() missing %q:\n%s", want, script)
		}
	}
}

func TestPrepareTerminalAgentHooksWritesClaudeStopHook(t *testing.T) {
	d := New(Config{})
	d.hookURL = "http://127.0.0.1:1/terminal-event"
	d.hookToken = "token"
	configHome := t.TempDir()
	claudeDir := t.TempDir()
	t.Setenv("XDG_CONFIG_HOME", configHome)
	t.Setenv("CLAUDE_CONFIG_DIR", claudeDir)

	hooks := d.prepareTerminalAgentHooks(t.TempDir(), "project", "terminal", "claude")
	if len(hooks.env) == 0 {
		t.Fatal("prepareTerminalAgentHooks() env is empty, want hook env for claude")
	}
	scriptPath := filepath.Join(configHome, "pocket-studio", "hooks", "claude-stop.js")
	if raw, err := os.ReadFile(scriptPath); err != nil {
		t.Fatalf("claude hook script was not written: %v", err)
	} else if !strings.Contains(string(raw), "POCKET_STUDIO_HOOK_URL") {
		t.Fatalf("claude hook script missing Pocket Studio hook post:\n%s", raw)
	}
	settingsPath := filepath.Join(claudeDir, "settings.json")
	raw, err := os.ReadFile(settingsPath)
	if err != nil {
		t.Fatalf("claude settings were not written: %v", err)
	}
	if !strings.Contains(string(raw), `"Stop"`) || !strings.Contains(string(raw), scriptPath) {
		t.Fatalf("claude settings missing Stop hook script path:\n%s", raw)
	}
}

func envValue(env []string, key string) string {
	prefix := key + "="
	for _, item := range env {
		if strings.HasPrefix(item, prefix) {
			return strings.TrimPrefix(item, prefix)
		}
	}
	return ""
}

func TestPrepareTerminalAgentHooksWrapsCodexNotify(t *testing.T) {
	d := New(Config{})
	d.hookURL = "http://127.0.0.1:1/terminal-event"
	d.hookToken = "token"
	configHome := t.TempDir()
	codexHome := t.TempDir()
	t.Setenv("XDG_CONFIG_HOME", configHome)
	t.Setenv("CODEX_HOME", codexHome)
	configPath := filepath.Join(codexHome, "config.toml")
	if err := os.WriteFile(configPath, []byte("notify = [\"node\", \"/opt/omx/notify-hook.js\"]\nmodel = \"gpt\"\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	hooks := d.prepareTerminalAgentHooks(t.TempDir(), "project", "terminal", "codex")
	if len(hooks.env) == 0 {
		t.Fatal("prepareTerminalAgentHooks() env is empty, want hook env for codex")
	}
	scriptPath := filepath.Join(configHome, "pocket-studio", "hooks", "codex-notify.js")
	if raw, err := os.ReadFile(scriptPath); err != nil {
		t.Fatalf("codex notify script was not written: %v", err)
	} else if !strings.Contains(string(raw), "POCKET_STUDIO_HOOK_URL") || !strings.Contains(string(raw), "previousNotifyPath") {
		t.Fatalf("codex notify script missing hook post or previous notify support:\n%s", raw)
	}
	rawConfig, err := os.ReadFile(configPath)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(rawConfig), scriptPath) || !strings.Contains(string(rawConfig), `model = "gpt"`) {
		t.Fatalf("codex config did not preserve settings and install wrapper:\n%s", rawConfig)
	}
	previousPath := filepath.Join(configHome, "pocket-studio", "hooks", "codex-notify-previous.json")
	rawPrevious, err := os.ReadFile(previousPath)
	if err != nil {
		t.Fatalf("codex previous notify file was not written: %v", err)
	}
	if !strings.Contains(string(rawPrevious), "/opt/omx/notify-hook.js") {
		t.Fatalf("codex previous notify was not preserved:\n%s", rawPrevious)
	}
}

func TestPrepareTerminalAgentHooksWritesAntigravityStopHook(t *testing.T) {
	d := New(Config{})
	d.hookURL = "http://127.0.0.1:1/terminal-event"
	d.hookToken = "token"
	configHome := t.TempDir()
	antigravityDir := t.TempDir()
	t.Setenv("XDG_CONFIG_HOME", configHome)
	t.Setenv("ANTIGRAVITY_CONFIG_DIR", antigravityDir)

	hooks := d.prepareTerminalAgentHooks(t.TempDir(), "project", "terminal", "antigravity")
	if len(hooks.env) == 0 {
		t.Fatal("prepareTerminalAgentHooks() env is empty, want hook env for antigravity")
	}
	scriptPath := filepath.Join(configHome, "pocket-studio", "hooks", "antigravity-stop.js")
	if raw, err := os.ReadFile(scriptPath); err != nil {
		t.Fatalf("antigravity hook script was not written: %v", err)
	} else if !strings.Contains(string(raw), "POCKET_STUDIO_HOOK_URL") {
		t.Fatalf("antigravity hook script missing Pocket Studio hook post:\n%s", raw)
	}
	settingsPath := filepath.Join(antigravityDir, "settings.json")
	raw, err := os.ReadFile(settingsPath)
	if err != nil {
		t.Fatalf("antigravity settings were not written: %v", err)
	}
	if !strings.Contains(string(raw), `"Stop"`) || !strings.Contains(string(raw), scriptPath) {
		t.Fatalf("antigravity settings missing Stop hook script path:\n%s", raw)
	}
}

func TestPrepareTerminalAgentHooksSkipsUnknownAgents(t *testing.T) {
	d := New(Config{})
	d.hookURL = "http://127.0.0.1:1/terminal-event"
	d.hookToken = "token"

	hooks := d.prepareTerminalAgentHooks(t.TempDir(), "project", "terminal", "bash")
	if len(hooks.env) != 0 {
		t.Fatalf("prepareTerminalAgentHooks() env = %#v, want none for unknown agent", hooks.env)
	}
}

func TestOnlineTerminalCommandMapsToACPX(t *testing.T) {
	d := New(Config{
		ACPX: ACPXConfig{
			Command: "acpx",
			Agent:   "claude",
		},
	})
	if got := d.normalizeTerminalCommand("online"); got != "acpx claude" {
		t.Fatalf("normalizeTerminalCommand() = %q, want acpx claude", got)
	}
	if got := d.normalizeTerminalCommand("acpx"); got != "acpx" {
		t.Fatalf("normalizeTerminalCommand(acpx) = %q, want explicit command preserved", got)
	}
	if got := d.normalizeTerminalCommand("acpx codex"); got != "acpx codex" {
		t.Fatalf("normalizeTerminalCommand(acpx codex) = %q, want explicit command preserved", got)
	}
	if got := initialTerminalTitle("acpx claude", ""); got != "ACPX" {
		t.Fatalf("initialTerminalTitle(acpx claude) = %q, want ACPX", got)
	}
	if got := agentTerminalCommand("acpx claude"); got != "acpx" {
		t.Fatalf("agentTerminalCommand(acpx claude) = %q, want acpx", got)
	}
	if got := agentDisplayName("acpx"); got != "ACPX" {
		t.Fatalf("agentDisplayName(acpx) = %q, want ACPX", got)
	}
	if supportsPluginTerminalAgent("acpx") {
		t.Fatal("supportsPluginTerminalAgent(acpx) = true, want false")
	}
}

func TestKnownTerminalTitlesForAdditionalAgents(t *testing.T) {
	tests := []struct {
		command string
		title   string
		agent   string
	}{
		{command: "qwen --acp", title: "Qwen Code", agent: "qwen"},
		{command: "kimi acp", title: "Kimi", agent: "kimi"},
		{command: "copilot --acp --stdio", title: "GitHub Copilot", agent: "copilot"},
		{command: "cursor-agent acp", title: "Cursor Agent", agent: "cursor"},
		{command: "openclaw acp", title: "OpenClaw", agent: "openclaw"},
	}
	for _, tt := range tests {
		t.Run(tt.agent, func(t *testing.T) {
			if got := initialTerminalTitle(tt.command, ""); got != tt.title {
				t.Fatalf("initialTerminalTitle(%q) = %q, want %q", tt.command, got, tt.title)
			}
			if got := terminalTitleFromPaneInfo("Shell", "/repo", tt.command); got != tt.title {
				t.Fatalf("terminalTitleFromPaneInfo(Shell, %q) = %q, want %q", tt.command, got, tt.title)
			}
			if got := agentTerminalCommand(tt.command); got != tt.agent {
				t.Fatalf("agentTerminalCommand(%q) = %q, want %q", tt.command, got, tt.agent)
			}
		})
	}
}

func TestTerminalTitleFromPaneInfoUsesRuntimePaneFields(t *testing.T) {
	if got := terminalTitleFromPaneInfo("nvim", "/repo", "nvim"); got != "nvim" {
		t.Fatalf("terminalTitleFromPaneInfo() = %q, want pane title", got)
	}
	if got := terminalTitleFromPaneInfo("", "/repo", "zsh"); got != "zsh" {
		t.Fatalf("terminalTitleFromPaneInfo(empty pane title) = %q, want current command", got)
	}
	if got := terminalTitleFromPaneInfo("Shell", "/repo", "claude"); got != "Claude Code" {
		t.Fatalf("terminalTitleFromPaneInfo(initial shell title, claude command) = %q, want Claude Code", got)
	}
	if got := terminalTitleFromPaneInfo("Shell", "/repo", "codex"); got != "Codex" {
		t.Fatalf("terminalTitleFromPaneInfo(initial shell title, codex command) = %q, want Codex", got)
	}
	if got := terminalTitleFromPaneInfo("Claude Code", "/repo", "bash"); got != "Shell" {
		t.Fatalf("terminalTitleFromPaneInfo(stale claude title, bash command) = %q, want Shell", got)
	}
	if got := terminalTitleFromPaneInfo("Claude Code", "/repo", "node"); got != "Claude Code" {
		t.Fatalf("terminalTitleFromPaneInfo(agent title, unknown runtime command) = %q, want Claude Code", got)
	}
	if got := terminalTitleFromPaneInfo("xterm", "/repo", "claude"); got != "Claude Code" {
		t.Fatalf("terminalTitleFromPaneInfo(xterm title, claude command) = %q, want Claude Code", got)
	}
	if got := terminalTitleFromPaneInfo("xterm-256color", "/repo", "codex"); got != "Codex" {
		t.Fatalf("terminalTitleFromPaneInfo(xterm-256color title, codex command) = %q, want Codex", got)
	}
	home, err := os.UserHomeDir()
	if err != nil || home == "" {
		t.Skip("home directory is not available")
	}
	currentPath := filepath.Join(home, "work")
	if got := terminalTitleFromPaneInfo("~/work", currentPath, "zsh"); got != "~/work" {
		t.Fatalf("terminalTitleFromPaneInfo(short path) = %q, want ~/work", got)
	}
}

func TestTmuxNewSessionCommandInjectsHookEnv(t *testing.T) {
	cmd, err := tmuxNewSessionCommand("session", "OpenCode", t.TempDir(), "opencode", []string{
		"POCKET_STUDIO_HOOK_URL=http://127.0.0.1:1/terminal-event",
		"POCKET_STUDIO_TERMINAL_ID=terminal",
	})
	if err != nil {
		t.Fatalf("tmuxNewSessionCommand() error = %v", err)
	}
	args := strings.Join(cmd.Args, "\x00")
	for _, want := range []string{
		"-e\x00POCKET_STUDIO_HOOK_URL=http://127.0.0.1:1/terminal-event",
		"-e\x00POCKET_STUDIO_TERMINAL_ID=terminal",
	} {
		if !strings.Contains(args, want) {
			t.Fatalf("tmuxNewSessionCommand() args missing %q in %#v", want, cmd.Args)
		}
	}
}

func TestPocketStudioTmuxConfigDoesNotRewriteHomeEnd(t *testing.T) {
	config := pocketStudioTmuxConfig("/bin/zsh")
	for _, want := range []string{
		`set-option -g default-terminal "tmux-256color"`,
		"set-option -g xterm-keys on",
		"unbind-key -n Home",
		"unbind-key -n End",
	} {
		if !strings.Contains(config, want) {
			t.Fatalf("pocketStudioTmuxConfig() missing %q in:\n%s", want, config)
		}
	}
	for _, wrong := range []string{
		"bind-key -n Home send-keys C-a",
		"bind-key -n End send-keys C-e",
	} {
		if strings.Contains(config, wrong) {
			t.Fatalf("pocketStudioTmuxConfig() still has unconditional binding %q in:\n%s", wrong, config)
		}
	}
}

func TestTmuxNewSessionCommandDoesNotOverridePaneTerm(t *testing.T) {
	cmd, err := tmuxNewSessionCommand("session", "Shell", t.TempDir(), "", nil)
	if err != nil {
		t.Fatalf("tmuxNewSessionCommand() error = %v", err)
	}
	args := strings.Join(cmd.Args, "\x00")
	if strings.Contains(args, "TERM=xterm-256color") {
		t.Fatalf("tmuxNewSessionCommand() should not override pane TERM in %#v", cmd.Args)
	}
	if !strings.Contains(args, "env -u TMUX ") {
		t.Fatalf("tmuxNewSessionCommand() should still clear nested TMUX in %#v", cmd.Args)
	}
}

func TestTerminalAgentCommandWithHooksAddsPiExtension(t *testing.T) {
	command := terminalAgentCommandWithHooks("pi", "pi", []string{
		"POCKET_STUDIO_PI_EXTENSION=/tmp/pocket-studio.ts",
	})
	if command != "pi --extension /tmp/pocket-studio.ts" {
		t.Fatalf("terminalAgentCommandWithHooks() = %q, want pi extension flag", command)
	}
	if got := terminalAgentCommandWithHooks(command, "pi", []string{
		"POCKET_STUDIO_PI_EXTENSION=/tmp/pocket-studio.ts",
	}); got != command {
		t.Fatalf("terminalAgentCommandWithHooks() duplicated extension: %q", got)
	}
}

func drainEnvelopes(ch <-chan protocol.Envelope) []protocol.Envelope {
	var events []protocol.Envelope
	for {
		select {
		case env := <-ch:
			events = append(events, env)
		default:
			return events
		}
	}
}
