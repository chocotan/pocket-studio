package daemon

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/url"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/gorilla/websocket"

	"remote-agent/internal/protocol"
)

type Daemon struct {
	cfg Config

	mu      sync.Mutex
	tasks   map[string]*runningTask
	history map[string]protocol.TaskRecord
	send    chan protocol.Envelope
}

type runningTask struct {
	id        string
	cmd       *exec.Cmd
	cancel    context.CancelFunc
	done      chan struct{}
	workspace string
	acpx      bool
	mu        sync.Mutex
	stopping  bool
}

func New(cfg Config) *Daemon {
	return &Daemon{
		cfg:     cfg,
		tasks:   make(map[string]*runningTask),
		history: make(map[string]protocol.TaskRecord),
		send:    make(chan protocol.Envelope, 128),
	}
}

func (d *Daemon) Run(ctx context.Context) error {
	for {
		if err := d.runOnce(ctx); err != nil {
			log.Printf("daemon connection closed: %v", err)
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(2 * time.Second):
		}
	}
}

func (d *Daemon) runOnce(ctx context.Context) error {
	u, err := url.Parse(d.cfg.Server.URL)
	if err != nil {
		return err
	}
	conn, _, err := websocket.DefaultDialer.DialContext(ctx, u.String(), nil)
	if err != nil {
		return err
	}
	defer conn.Close()

	writeDone := make(chan error, 1)
	go func() {
		for {
			select {
			case <-ctx.Done():
				writeDone <- ctx.Err()
				return
			case env := <-d.send:
				if err := writeEnvelope(conn, env); err != nil {
					writeDone <- err
					return
				}
			}
		}
	}()

	d.send <- protocol.NewEnvelope(protocol.TypeDaemonHello, "daemon", protocol.DaemonHello{
		DeviceID:      d.cfg.Device.ID,
		DeviceName:    d.cfg.Device.Name,
		DaemonVersion: "0.1.0",
		Agent:         d.agentName(),
		AgentLabel:    d.agentLabel(),
		Workspaces:    d.cfg.Workspaces,
	})
	d.sendSnapshot()

	go func() {
		ticker := time.NewTicker(15 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				d.send <- protocol.NewEnvelope(protocol.TypeDaemonHeartbeat, "daemon", protocol.DaemonHeartbeat{
					DeviceID:       d.cfg.Device.ID,
					Status:         "online",
					RunningTaskIDs: d.runningTaskIDs(),
					DaemonVersion:  "0.1.0",
				})
			}
		}
	}()

	readErr := make(chan error, 1)
	go func() {
		for {
			var env protocol.Envelope
			if err := conn.ReadJSON(&env); err != nil {
				readErr <- err
				return
			}
			d.handleEnvelope(ctx, env)
		}
	}()

	select {
	case err := <-readErr:
		return err
	case err := <-writeDone:
		return err
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (d *Daemon) agentName() string {
	if d.cfg.ACPX.Enabled {
		return d.cfg.ACPX.Agent
	}
	return "claude_code"
}

func (d *Daemon) agentLabel() string {
	return agentDisplayName(d.agentName())
}

func agentDisplayName(agent string) string {
	switch strings.ToLower(strings.TrimSpace(agent)) {
	case "claude", "claude_code", "claude-code":
		return "Claude Code"
	case "codex":
		return "Codex"
	case "gemini":
		return "Gemini"
	case "cursor":
		return "Cursor Agent"
	case "copilot":
		return "GitHub Copilot"
	case "openclaw":
		return "OpenClaw"
	case "pi":
		return "Pi"
	case "droid", "factory-droid", "factorydroid":
		return "Factory Droid"
	case "qwen":
		return "Qwen Code"
	case "opencode":
		return "OpenCode"
	default:
		if agent == "" {
			return "Agent"
		}
		return agent
	}
}

func (d *Daemon) handleEnvelope(ctx context.Context, env protocol.Envelope) {
	switch env.Type {
	case protocol.TypeTaskDispatch:
		task, err := protocol.DecodePayload[protocol.TaskDispatch](env)
		if err != nil {
			d.emitError("", "bad_payload", err.Error())
			return
		}
		go d.startTask(ctx, task)
	case protocol.TypeTaskStop:
		stop, err := protocol.DecodePayload[protocol.TaskStop](env)
		if err != nil {
			d.emitError("", "bad_payload", err.Error())
			return
		}
		d.stopTask(stop.TaskID)
	}
}

func (d *Daemon) startTask(parent context.Context, task protocol.TaskDispatch) {
	if task.TaskID == "" {
		task.TaskID = protocol.NewID("tsk")
	}
	workspace, err := d.resolveWorkspace(task)
	if err != nil {
		d.emitError(task.TaskID, "workspace_denied", err.Error())
		return
	}
	if !d.supportsTaskAgent(task.Agent) {
		d.emitError(task.TaskID, "unsupported_agent", "unsupported agent")
		return
	}

	ctx, cancel := context.WithCancel(parent)
	command, args, source := d.buildAgentCommand(task, workspace.Path)
	if d.cfg.ACPX.Enabled {
		if err := d.ensureACPXSession(ctx, workspace.Path, task.TaskID); err != nil {
			cancel()
			d.emitError(task.TaskID, "session_ensure_failed", err.Error())
			return
		}
	}

	cmd := exec.CommandContext(ctx, command, args...)
	cmd.Dir = workspace.Path
	setProcessGroup(cmd)

	stdout, err := cmd.StdoutPipe()
	if err != nil {
		cancel()
		d.emitError(task.TaskID, "stdout_pipe_failed", err.Error())
		return
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		cancel()
		d.emitError(task.TaskID, "stderr_pipe_failed", err.Error())
		return
	}
	if err := cmd.Start(); err != nil {
		cancel()
		d.emitError(task.TaskID, "start_failed", err.Error())
		return
	}

	rt := &runningTask{id: task.TaskID, cmd: cmd, cancel: cancel, done: make(chan struct{}), workspace: workspace.Path, acpx: d.cfg.ACPX.Enabled}
	d.mu.Lock()
	d.tasks[task.TaskID] = rt
	now := time.Now().Unix()
	record := d.history[task.TaskID]
	if record.TaskID == "" {
		record.TaskID = task.TaskID
		record.StartedAt = now
	}
	record.WorkspaceID = workspace.ID
	record.WorkspacePath = workspace.Path
	record.Prompt = task.Prompt
	record.ParentTaskID = task.ParentTaskID
	if task.ResumeSessionID != "" {
		record.SessionID = task.ResumeSessionID
	}
	record.Status = "running"
	record.UpdatedAt = now
	userEvent := protocol.TaskEvent{
		TaskID:    task.TaskID,
		EventID:   protocol.NewID("evt"),
		EventType: "user.prompt",
		Source:    "web",
		Sequence:  int64(len(record.Events) + 1),
		Data:      mustJSON(map[string]string{"prompt": task.Prompt}),
	}
	record.Events = appendBounded(record.Events, userEvent, 1000)
	d.history[task.TaskID] = record
	d.mu.Unlock()

	emitter := &taskEmitter{daemon: d, taskID: task.TaskID}
	emitter.emit("task.started", map[string]any{
		"workspace": workspace.Path,
		"command":   command,
		"args":      args,
		"agent":     source,
	}, nil)

	var wg sync.WaitGroup
	wg.Add(2)
	go func() {
		defer wg.Done()
		d.scanOutput(stdout, "stdout", emitter)
	}()
	go func() {
		defer wg.Done()
		d.scanTextOutput(stderr, "stderr", emitter)
	}()

	waitErr := cmd.Wait()
	wg.Wait()
	close(rt.done)
	cancel()

	d.mu.Lock()
	delete(d.tasks, task.TaskID)
	d.mu.Unlock()

	if waitErr != nil {
		if rt.isStopping() {
			emitter.emit("task.killed", map[string]any{"reason": "user_requested"}, nil)
			return
		}
		if emitter.completedNormally() {
			emitter.emit("task.completed", map[string]any{"exit_code": exitCodeFromError(waitErr), "stop_reason": "end_turn"}, nil)
			return
		}
		emitter.emit("task.failed", map[string]any{"error": waitErr.Error()}, nil)
		return
	}
	emitter.emit("task.completed", map[string]any{"exit_code": 0}, nil)
}

func (d *Daemon) supportsTaskAgent(agent string) bool {
	agent = strings.ToLower(strings.TrimSpace(agent))
	if agent == "" || agent == "claude_code" || agent == "acpx" {
		return true
	}
	if d.cfg.ACPX.Enabled {
		return agent == strings.ToLower(strings.TrimSpace(d.cfg.ACPX.Agent))
	}
	return false
}

func (d *Daemon) buildClaudeArgs(task protocol.TaskDispatch) []string {
	args := append([]string{}, d.cfg.Claude.Args...)
	if len(args) == 0 {
		args = append(args, "--output-format", "stream-json")
	}
	args = ensureClaudeStreamJSONVerbose(args)
	if task.ResumeSessionID != "" {
		args = append(args, "--resume", task.ResumeSessionID)
	}
	args = append(args, "-p", task.Prompt)
	if len(task.Options.AllowedTools) > 0 {
		allowedTools := allowedToolsForTask(task)
		if len(allowedTools) > 0 {
			args = append(args, "--allowedTools", strings.Join(allowedTools, ","))
		}
	}
	return args
}

func (d *Daemon) buildAgentCommand(task protocol.TaskDispatch, workspacePath string) (string, []string, string) {
	if d.cfg.ACPX.Enabled {
		return d.cfg.ACPX.Command, d.buildACPXPromptArgs(task, workspacePath), d.cfg.ACPX.Agent
	}
	return d.cfg.Claude.Command, d.buildClaudeArgs(task), "claude_code"
}

func (d *Daemon) buildACPXPromptArgs(task protocol.TaskDispatch, workspacePath string) []string {
	args := d.buildACPXPromptGlobalArgs(task, workspacePath)
	args = append(args, d.cfg.ACPX.Agent)
	if d.cfg.ACPX.SessionName != "" {
		args = append(args, "-s", d.cfg.ACPX.SessionName)
	}
	args = append(args, task.Prompt)
	return args
}

func (d *Daemon) buildACPXSessionArgs(workspacePath string, command string) []string {
	args := d.buildACPXGlobalArgs(workspacePath)
	args = append(args, d.cfg.ACPX.Agent, "sessions", command)
	if d.cfg.ACPX.SessionName != "" {
		args = append(args, "--name", d.cfg.ACPX.SessionName)
	}
	return args
}

func (d *Daemon) buildACPXCancelArgs(workspacePath string) []string {
	args := d.buildACPXGlobalArgs(workspacePath)
	args = append(args, d.cfg.ACPX.Agent, "cancel")
	if d.cfg.ACPX.SessionName != "" {
		args = append(args, "-s", d.cfg.ACPX.SessionName)
	}
	return args
}

func (d *Daemon) buildACPXGlobalArgs(workspacePath string) []string {
	args := append([]string{}, d.cfg.ACPX.Args...)
	args = ensureACPXJSONFormat(args)
	args = append(args, "--cwd", workspacePath)
	return args
}

func (d *Daemon) buildACPXPromptGlobalArgs(task protocol.TaskDispatch, workspacePath string) []string {
	args := append([]string{}, d.cfg.ACPX.Args...)
	args = withoutACPXPermissionMode(args)
	args = append(args, "--approve-all")
	args = ensureACPXJSONFormat(args)
	args = append(args, "--cwd", workspacePath)
	return args
}

func ensureACPXJSONFormat(args []string) []string {
	for i, arg := range args {
		if arg == "--format" && i+1 < len(args) {
			return args
		}
		if strings.HasPrefix(arg, "--format=") {
			return args
		}
	}
	return append([]string{"--format", "json"}, args...)
}

func withoutACPXPermissionMode(args []string) []string {
	next := args[:0]
	for _, arg := range args {
		switch arg {
		case "--approve-all", "--approve-reads", "--deny-all":
			continue
		default:
			next = append(next, arg)
		}
	}
	return next
}

func ensureClaudeStreamJSONVerbose(args []string) []string {
	hasStreamJSON := false
	hasVerbose := false
	for i, arg := range args {
		if arg == "--verbose" {
			hasVerbose = true
		}
		if arg == "--output-format" && i+1 < len(args) && args[i+1] == "stream-json" {
			hasStreamJSON = true
		}
		if strings.HasPrefix(arg, "--output-format=") && strings.TrimPrefix(arg, "--output-format=") == "stream-json" {
			hasStreamJSON = true
		}
	}
	if hasStreamJSON && !hasVerbose {
		args = append(args, "--verbose")
	}
	return args
}

func allowedToolsForTask(task protocol.TaskDispatch) []string {
	tools := make([]string, 0, len(task.Options.AllowedTools))
	for _, tool := range task.Options.AllowedTools {
		normalized := strings.ToLower(strings.TrimSpace(tool))
		if normalized == "" {
			continue
		}
		if !task.Options.AutoShell && (normalized == "bash" || normalized == "shell") {
			continue
		}
		tools = append(tools, tool)
	}
	return tools
}

type taskEmitter struct {
	mu       sync.Mutex
	sequence int64
	daemon   *Daemon
	taskID   string
	endTurn  bool
}

func (e *taskEmitter) emit(eventType string, data any, raw json.RawMessage) {
	e.mu.Lock()
	e.sequence++
	sequence := e.sequence
	e.mu.Unlock()
	e.daemon.emitTaskEvent(e.taskID, eventType, sequence, data, raw)
}

func (e *taskEmitter) markEndTurn() {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.endTurn = true
}

func (e *taskEmitter) completedNormally() bool {
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.endTurn
}

func (d *Daemon) scanOutput(r io.Reader, stream string, emitter *taskEmitter) {
	scanner := bufio.NewScanner(r)
	scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	adapter := newAgentOutputAdapter(emitter)
	defer adapter.flush()
	for scanner.Scan() {
		line := scanner.Bytes()
		var raw json.RawMessage
		if json.Valid(line) {
			raw = append(raw, line...)
			adapter.handle(raw)
			continue
		}
		adapter.flush()
		emitter.emit("tool.output", map[string]string{
			"stream": stream,
			"text":   string(line),
		}, nil)
	}
}

func (d *Daemon) ensureACPXSession(ctx context.Context, workspacePath string, taskID string) error {
	args := d.buildACPXSessionArgs(workspacePath, "ensure")
	cmd := exec.CommandContext(ctx, d.cfg.ACPX.Command, args...)
	cmd.Dir = workspacePath
	var stdout bytes.Buffer
	var stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	err := cmd.Run()
	if err != nil {
		text := strings.TrimSpace(stderr.String())
		if text == "" {
			text = strings.TrimSpace(stdout.String())
		}
		if text == "" {
			text = err.Error()
		}
		return fmt.Errorf("%s: %s", err, text)
	}
	var raw json.RawMessage
	output := bytes.TrimSpace(stdout.Bytes())
	if json.Valid(output) {
		raw = append(raw, output...)
		data := map[string]any{
			"agent":        d.cfg.ACPX.Agent,
			"session_name": d.cfg.ACPX.SessionName,
		}
		var session map[string]any
		if err := json.Unmarshal(raw, &session); err == nil {
			for _, key := range []string{"acpxRecordId", "acpxSessionId", "agentSessionId", "name"} {
				if value, ok := session[key]; ok {
					data[key] = value
				}
			}
		}
		d.emitTaskEvent(taskID, "acpx.session", 0, data, raw)
	}
	return nil
}

func (d *Daemon) scanTextOutput(r io.Reader, stream string, emitter *taskEmitter) {
	scanner := bufio.NewScanner(r)
	scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	for scanner.Scan() {
		text := scanner.Text()
		if d.cfg.ACPX.Enabled && isACPXStatusLine(text) {
			emitter.emit("acpx.raw", map[string]string{
				"stream": stream,
				"text":   text,
			}, nil)
			continue
		}
		emitter.emit("tool.output", map[string]string{
			"stream": stream,
			"text":   text,
		}, nil)
	}
}

func isACPXStatusLine(text string) bool {
	return strings.HasPrefix(strings.TrimSpace(text), "[acpx] ")
}

type agentOutputAdapter struct {
	emitter         *taskEmitter
	assistantText   strings.Builder
	assistantRaw    json.RawMessage
	thinkingText    strings.Builder
	thinkingRaw     json.RawMessage
	toolRawByID     map[string]json.RawMessage
	toolNameByID    map[string]string
	toolInputByID   map[string]any
	toolEmittedByID map[string]bool
}

func newAgentOutputAdapter(emitter *taskEmitter) *agentOutputAdapter {
	return &agentOutputAdapter{
		emitter:         emitter,
		toolRawByID:     make(map[string]json.RawMessage),
		toolNameByID:    make(map[string]string),
		toolInputByID:   make(map[string]any),
		toolEmittedByID: make(map[string]bool),
	}
}

func (a *agentOutputAdapter) handle(raw json.RawMessage) {
	if a.handleACPXJSONRPC(raw) {
		return
	}
	a.flush()
	a.emitter.emit(classifyClaudeEvent(raw), nil, raw)
}

func (a *agentOutputAdapter) flush() {
	a.flushThinking()
	a.flushAssistant()
}

func (a *agentOutputAdapter) flushAssistant() {
	if a.assistantText.Len() == 0 {
		return
	}
	text := a.assistantText.String()
	raw := a.assistantRaw
	a.assistantText.Reset()
	a.assistantRaw = nil
	a.emitter.emit("assistant.message", map[string]string{"text": text}, raw)
}

func (a *agentOutputAdapter) flushThinking() {
	text := strings.TrimSpace(a.thinkingText.String())
	if text == "" {
		a.thinkingText.Reset()
		a.thinkingRaw = nil
		return
	}
	raw := a.thinkingRaw
	a.thinkingText.Reset()
	a.thinkingRaw = nil
	a.emitter.emit("assistant.thinking", map[string]string{"text": text}, raw)
}

func (a *agentOutputAdapter) handleACPXJSONRPC(raw json.RawMessage) bool {
	var msg map[string]any
	if err := json.Unmarshal(raw, &msg); err != nil {
		return false
	}
	if msg["jsonrpc"] != "2.0" {
		return false
	}
	method, _ := msg["method"].(string)
	if method != "session/update" {
		if _, ok := msg["result"]; ok {
			if result, _ := msg["result"].(map[string]any); stringField(result, "stopReason") == "end_turn" {
				a.emitter.markEndTurn()
			}
			a.flush()
			a.emitter.emit("metric.updated", nil, raw)
		}
		return true
	}
	params, _ := msg["params"].(map[string]any)
	update, _ := params["update"].(map[string]any)
	updateType, _ := update["sessionUpdate"].(string)
	switch updateType {
	case "agent_message_chunk":
		a.flushThinking()
		a.appendAssistantChunk(update, raw)
	case "agent_thought_chunk":
		a.appendThinkingChunk(update, raw)
	case "user_message_chunk", "available_commands_update", "current_mode_update", "config_option_update", "session_info_update":
		a.flush()
		a.emitter.emit("acpx.raw", nil, raw)
	case "usage_update":
		a.flush()
		a.emitter.emit("metric.updated", nil, raw)
	case "tool_call", "tool_call_update":
		a.flush()
		a.emitToolUpdate(update, raw)
	default:
		a.flush()
		a.emitter.emit("acpx.raw", nil, raw)
	}
	return true
}

func (a *agentOutputAdapter) appendAssistantChunk(update map[string]any, raw json.RawMessage) {
	text := textFromACPXContent(update["content"])
	if text == "" {
		return
	}
	a.assistantText.WriteString(text)
	a.assistantRaw = raw
}

func (a *agentOutputAdapter) appendThinkingChunk(update map[string]any, raw json.RawMessage) {
	text := textFromACPXContent(update["content"])
	if text == "" {
		return
	}
	a.thinkingText.WriteString(text)
	a.thinkingRaw = raw
}

func (a *agentOutputAdapter) emitToolUpdate(update map[string]any, raw json.RawMessage) {
	id := stringField(update, "toolCallId", "tool_call_id", "id")
	if id == "" {
		id = protocol.NewID("tool")
	}
	if name := stringField(update, "title", "kind", "name"); name != "" {
		a.toolNameByID[id] = name
	}
	if input, ok := update["rawInput"]; ok {
		a.toolInputByID[id] = input
	}
	if !a.toolEmittedByID[id] && (hasNonEmptyInput(update) || hasAnyKey(update, "rawOutput")) {
		a.toolEmittedByID[id] = true
		call := map[string]any{
			"type":  "tool_use",
			"id":    id,
			"name":  valueOrDefault(a.toolNameByID[id], "tool_call"),
			"input": valueOrDefaultAny(a.toolInputByID[id], map[string]any{}),
		}
		normalized := map[string]any{
			"type": "assistant",
			"message": map[string]any{
				"role":    "assistant",
				"content": []any{call},
			},
		}
		callRaw := mustJSON(normalized)
		a.toolRawByID[id] = callRaw
		a.emitter.emit("tool.call", nil, callRaw)
	}
	if hasAnyKey(update, "rawOutput", "status") {
		if !hasAnyKey(update, "rawOutput") && strings.EqualFold(stringField(update, "status"), "pending") {
			a.emitter.emit("acpx.raw", nil, raw)
			return
		}
		result := map[string]any{
			"tool_use_id": id,
			"type":        "tool_result",
			"content":     acpxToolOutput(update),
			"is_error":    statusIndicatesError(stringField(update, "status")),
		}
		normalized := map[string]any{
			"type": "user",
			"message": map[string]any{
				"role":    "user",
				"content": []any{result},
			},
		}
		a.emitter.emit("tool.output", nil, mustJSON(normalized))
		return
	}
	a.toolRawByID[id] = raw
}

func hasNonEmptyInput(update map[string]any) bool {
	value, ok := update["rawInput"]
	if !ok || value == nil {
		return false
	}
	if object, ok := value.(map[string]any); ok {
		return len(object) > 0
	}
	if text, ok := value.(string); ok {
		return strings.TrimSpace(text) != ""
	}
	return true
}

func textFromACPXContent(value any) string {
	switch content := value.(type) {
	case string:
		return content
	case map[string]any:
		return stringField(content, "text", "content")
	default:
		return ""
	}
}

func acpxToolOutput(update map[string]any) string {
	if output, ok := update["rawOutput"]; ok {
		return stringifyValue(output)
	}
	if status := stringField(update, "status"); status != "" {
		return status
	}
	return ""
}

func stringifyValue(value any) string {
	switch typed := value.(type) {
	case nil:
		return ""
	case string:
		return typed
	case map[string]any:
		if text := stringField(typed, "text", "content", "stdout", "stderr", "output"); text != "" {
			return text
		}
		raw, _ := json.MarshalIndent(typed, "", "  ")
		return string(raw)
	default:
		raw, err := json.MarshalIndent(typed, "", "  ")
		if err == nil {
			return string(raw)
		}
		return fmt.Sprint(typed)
	}
}

func stringField(source map[string]any, keys ...string) string {
	for _, key := range keys {
		if value, ok := source[key].(string); ok {
			return value
		}
	}
	return ""
}

func hasAnyKey(source map[string]any, keys ...string) bool {
	for _, key := range keys {
		if _, ok := source[key]; ok {
			return true
		}
	}
	return false
}

func valueOrDefault(value, fallback string) string {
	if value == "" {
		return fallback
	}
	return value
}

func valueOrDefaultAny(value any, fallback any) any {
	if value == nil {
		return fallback
	}
	return value
}

func statusIndicatesError(status string) bool {
	normalized := strings.ToLower(status)
	return strings.Contains(normalized, "error") || strings.Contains(normalized, "fail")
}

func exitCodeFromError(err error) int {
	var exitErr *exec.ExitError
	if errors.As(err, &exitErr) {
		return exitErr.ExitCode()
	}
	return -1
}

func classifyClaudeEvent(raw json.RawMessage) string {
	var obj map[string]any
	if err := json.Unmarshal(raw, &obj); err != nil {
		return "tool.output"
	}
	t, _ := obj["type"].(string)
	if containsToolResult(obj) {
		return "tool.output"
	}
	if t == "assistant" || t == "message" {
		if containsToolUse(obj) {
			return "tool.call"
		}
	}
	switch t {
	case "assistant", "message", "text":
		return "assistant.message"
	case "tool_use", "tool_call":
		return "tool.call"
	case "tool_result":
		return "tool.output"
	case "result", "done":
		return "metric.updated"
	default:
		return "claude.raw"
	}
}

func containsToolResult(obj map[string]any) bool {
	if _, ok := obj["tool_use_result"]; ok {
		return true
	}
	message, _ := obj["message"].(map[string]any)
	content, _ := message["content"].([]any)
	for _, item := range content {
		part, _ := item.(map[string]any)
		if partType, _ := part["type"].(string); partType == "tool_result" {
			return true
		}
	}
	return false
}

func containsToolUse(obj map[string]any) bool {
	message, _ := obj["message"].(map[string]any)
	content, _ := message["content"].([]any)
	for _, item := range content {
		part, _ := item.(map[string]any)
		if partType, _ := part["type"].(string); partType == "tool_use" {
			return true
		}
	}
	return false
}

func (d *Daemon) stopTask(taskID string) {
	d.mu.Lock()
	rt := d.tasks[taskID]
	d.mu.Unlock()
	if rt == nil {
		d.emitError(taskID, "task_not_found", "task is not running")
		return
	}
	rt.markStopping()
	d.emitTaskEvent(taskID, "task.stopping", 0, map[string]string{"reason": "user_requested"}, nil)
	if rt.acpx {
		d.cancelACPXTask(rt)
	}
	terminateProcess(rt.cmd)
	select {
	case <-rt.done:
	case <-time.After(5 * time.Second):
		killProcess(rt.cmd)
	}
}

func (d *Daemon) cancelACPXTask(rt *runningTask) {
	if rt.workspace == "" {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, d.cfg.ACPX.Command, d.buildACPXCancelArgs(rt.workspace)...)
	cmd.Dir = rt.workspace
	_ = cmd.Run()
}

func (rt *runningTask) markStopping() {
	rt.mu.Lock()
	defer rt.mu.Unlock()
	rt.stopping = true
}

func (rt *runningTask) isStopping() bool {
	rt.mu.Lock()
	defer rt.mu.Unlock()
	return rt.stopping
}

func (d *Daemon) resolveWorkspace(task protocol.TaskDispatch) (protocol.Workspace, error) {
	for _, ws := range d.cfg.Workspaces {
		if task.WorkspaceID != "" && ws.ID == task.WorkspaceID {
			return ws, nil
		}
		if task.WorkspacePath != "" {
			real, err := filepath.EvalSymlinks(task.WorkspacePath)
			if err != nil {
				return protocol.Workspace{}, err
			}
			if real == ws.Path {
				return ws, nil
			}
		}
	}
	return protocol.Workspace{}, fmt.Errorf("workspace is not in daemon allowlist")
}

func (d *Daemon) runningTaskIDs() []string {
	d.mu.Lock()
	defer d.mu.Unlock()
	ids := make([]string, 0, len(d.tasks))
	for id := range d.tasks {
		ids = append(ids, id)
	}
	return ids
}

func (d *Daemon) sendSnapshot() {
	d.mu.Lock()
	tasks := make([]protocol.TaskRecord, 0, len(d.history))
	for _, record := range d.history {
		tasks = append(tasks, record)
	}
	d.mu.Unlock()
	d.send <- protocol.NewEnvelope(protocol.TypeTaskSnapshot, "daemon", protocol.TaskSnapshot{
		DeviceID: d.cfg.Device.ID,
		Tasks:    tasks,
	})
}

func (d *Daemon) emitError(taskID, code, message string) {
	if taskID == "" {
		d.send <- protocol.NewEnvelope(protocol.TypeServerError, "daemon", protocol.ServerError{Code: code, Message: message})
		return
	}
	d.emitTaskEvent(taskID, "task.failed", 0, map[string]string{"code": code, "message": message}, nil)
}

func (d *Daemon) emitTaskEvent(taskID, eventType string, sequence int64, data any, raw json.RawMessage) {
	var dataRaw json.RawMessage
	if data != nil {
		dataRaw, _ = json.Marshal(data)
	}
	event := protocol.TaskEvent{
		TaskID:    taskID,
		EventID:   protocol.NewID("evt"),
		EventType: eventType,
		Source:    "claude_code",
		Sequence:  sequence,
		Data:      dataRaw,
		Raw:       raw,
	}
	d.recordTaskEvent(event)
	d.send <- protocol.NewEnvelope(protocol.TypeTaskEvent, "daemon", event)
}

func (d *Daemon) recordTaskEvent(event protocol.TaskEvent) {
	d.mu.Lock()
	defer d.mu.Unlock()
	record := d.history[event.TaskID]
	record.TaskID = event.TaskID
	if sessionID := extractSessionID(event); sessionID != "" {
		record.SessionID = sessionID
	}
	record.Status = statusFromEvent(event.EventType, record.Status)
	now := time.Now().Unix()
	if record.StartedAt == 0 {
		record.StartedAt = now
	}
	record.UpdatedAt = now
	record.Events = appendBounded(record.Events, event, 1000)
	d.history[event.TaskID] = record
}

func extractSessionID(event protocol.TaskEvent) string {
	for _, raw := range []json.RawMessage{event.Raw, event.Data} {
		if len(raw) == 0 {
			continue
		}
		var obj map[string]any
		if err := json.Unmarshal(raw, &obj); err != nil {
			continue
		}
		if sessionID, _ := obj["session_id"].(string); sessionID != "" {
			return sessionID
		}
		for _, key := range []string{"sessionId", "acpxRecordId", "acpxSessionId", "agentSessionId"} {
			if sessionID, _ := obj[key].(string); sessionID != "" {
				return sessionID
			}
		}
		if message, ok := obj["message"].(map[string]any); ok {
			if sessionID, _ := message["session_id"].(string); sessionID != "" {
				return sessionID
			}
		}
	}
	return ""
}

func statusFromEvent(eventType, fallback string) string {
	switch eventType {
	case "task.started":
		return "running"
	case "task.stopping":
		return "stopping"
	case "task.completed":
		return "completed"
	case "task.failed":
		return "failed"
	case "task.killed":
		return "killed"
	default:
		if fallback == "" {
			return "running"
		}
		return fallback
	}
}

func appendBounded[T any](items []T, item T, max int) []T {
	items = append(items, item)
	if len(items) <= max {
		return items
	}
	return append([]T(nil), items[len(items)-max:]...)
}

func writeEnvelope(conn *websocket.Conn, env protocol.Envelope) error {
	if env.ID == "" {
		env.ID = protocol.NewID("msg")
	}
	if env.Version == 0 {
		env.Version = 1
	}
	if env.Timestamp == 0 {
		env.Timestamp = time.Now().Unix()
	}
	return conn.WriteJSON(env)
}

func mustJSON(value any) json.RawMessage {
	raw, _ := json.Marshal(value)
	return raw
}

func setProcessGroup(cmd *exec.Cmd) {
	if runtime.GOOS == "windows" {
		return
	}
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
}

func terminateProcess(cmd *exec.Cmd) {
	if cmd == nil || cmd.Process == nil {
		return
	}
	if runtime.GOOS == "windows" {
		_ = cmd.Process.Kill()
		return
	}
	_ = syscall.Kill(-cmd.Process.Pid, syscall.SIGTERM)
}

func killProcess(cmd *exec.Cmd) {
	if cmd == nil || cmd.Process == nil {
		return
	}
	if runtime.GOOS == "windows" {
		_ = cmd.Process.Kill()
		return
	}
	_ = syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
}
