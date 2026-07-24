package server

import (
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"

	"remote-agent/internal/auth"
	"remote-agent/internal/protocol"
)

func TestDaemonReplacementInterruptsRunningTaskBeforeNewSnapshot(t *testing.T) {
	h := NewHub(auth.NewOpen(""))
	seedRunningTask(h, "task-1", "dev-1", "running", time.Now().Unix())
	h.daemons[daemonKey(auth.OwnerAdmin, "dev-1")] = &daemonConn{
		userID:   auth.OwnerAdmin,
		deviceID: "dev-1",
		send:     make(chan protocol.Envelope, 1),
	}

	replacement := &daemonConn{userID: auth.OwnerAdmin, send: make(chan protocol.Envelope, 4)}
	h.handleDaemonMessage(replacement, protocol.NewEnvelope(protocol.TypeDaemonHello, "daemon", protocol.DaemonHello{
		DeviceID: "dev-1",
	}))

	if got := recordStatus(h, "task-1"); got != "failed" {
		t.Fatalf("task status after daemon replacement = %q, want failed", got)
	}
	if got := lastEventType(h, "task-1"); got != "task.failed" {
		t.Fatalf("last event after daemon replacement = %q, want task.failed", got)
	}
}

func TestDaemonReplacementRetriesPendingACPXHistoryRequest(t *testing.T) {
	h := NewHub(auth.NewOpen(""))
	old := &daemonConn{
		userID:   auth.OwnerAdmin,
		deviceID: "dev-1",
		send:     make(chan protocol.Envelope, 2),
	}
	h.daemons[daemonKey(auth.OwnerAdmin, "dev-1")] = old
	taskKey := scopedKey(auth.OwnerAdmin, "task-1")
	h.taskDevices[taskKey] = "dev-1"
	h.taskRecords[taskKey] = protocol.TaskRecord{
		TaskID:        "task-1",
		DeviceID:      "dev-1",
		WorkspacePath: "/workspace",
	}
	requester := &agentChatConn{
		userID: auth.OwnerAdmin,
		taskID: "task-1",
		send:   make(chan protocol.Envelope, 4),
	}
	h.requestTaskHistoryForAgentChat(requester)
	original := <-old.send

	replacement := &daemonConn{userID: auth.OwnerAdmin, send: make(chan protocol.Envelope, 4)}
	h.handleDaemonMessage(replacement, protocol.NewEnvelope(protocol.TypeDaemonHello, "daemon", protocol.DaemonHello{
		DeviceID: "dev-1",
	}))

	select {
	case retried := <-replacement.send:
		if retried.Type != protocol.TypeTaskHistoryGet || retried.ID != original.ID {
			t.Fatalf("retried history request = %#v, want original envelope %#v", retried, original)
		}
	case <-time.After(time.Second):
		t.Fatal("replacement daemon did not receive pending history request")
	}
}

func TestReplacedDaemonDeferredDisconnectDoesNotInterruptNewFollowUp(t *testing.T) {
	h := NewHub(auth.NewOpen(""))
	seedRunningTask(h, "old-turn", "dev-1", "running", time.Now().Add(-time.Minute).Unix())
	old := &daemonConn{
		userID:   auth.OwnerAdmin,
		deviceID: "dev-1",
		send:     make(chan protocol.Envelope, 2),
	}
	h.daemons[daemonKey(auth.OwnerAdmin, "dev-1")] = old

	replacement := &daemonConn{userID: auth.OwnerAdmin, send: make(chan protocol.Envelope, 4)}
	h.handleDaemonMessage(replacement, protocol.NewEnvelope(protocol.TypeDaemonHello, "daemon", protocol.DaemonHello{
		DeviceID: "dev-1",
	}))
	if got := recordStatus(h, "old-turn"); got != "failed" {
		t.Fatalf("old turn after replacement hello = %q, want failed", got)
	}

	// The new daemon starts a follow-up before the old read loop reaches its
	// deferred cleanup. That cleanup must no longer reconcile this device.
	seedRunningTask(h, "new-follow-up", "dev-1", "running", time.Now().Unix())
	h.disconnectDaemon(old)

	if got := recordStatus(h, "new-follow-up"); got != "running" {
		t.Fatalf("new follow-up after old deferred disconnect = %q, want running", got)
	}
	if got := h.daemons[daemonKey(auth.OwnerAdmin, "dev-1")]; got != replacement {
		t.Fatalf("current daemon after old deferred disconnect = %p, want replacement %p", got, replacement)
	}
}

func TestDaemonReadLoopDisconnectSerializesFollowUpDispatch(t *testing.T) {
	h := NewHub(auth.NewOpen(""))
	server := httptest.NewServer(http.HandlerFunc(h.ServeDaemonSocket))
	t.Cleanup(server.Close)
	wsURL := "ws" + strings.TrimPrefix(server.URL, "http")
	client, _, err := websocket.DefaultDialer.Dial(wsURL, nil)
	if err != nil {
		t.Fatalf("dial daemon websocket: %v", err)
	}
	if err := client.WriteJSON(protocol.NewEnvelope(protocol.TypeDaemonHello, "daemon", protocol.DaemonHello{DeviceID: "dev-1"})); err != nil {
		t.Fatalf("write daemon hello: %v", err)
	}
	waitForServerTest(t, func() bool {
		h.mu.RLock()
		defer h.mu.RUnlock()
		return h.daemons[daemonKey(auth.OwnerAdmin, "dev-1")] != nil
	})
	h.mu.Lock()
	seedRunningTask(h, "shared-task", "dev-1", "running", time.Now().Add(-time.Minute).Unix())
	h.mu.Unlock()

	entered := make(chan struct{})
	release := make(chan struct{})
	h.mu.Lock()
	h.daemonSwitchHook = func(stage string) {
		if stage == "disconnect-current" {
			close(entered)
			<-release
		}
	}
	h.mu.Unlock()
	if err := client.Close(); err != nil {
		t.Fatalf("close daemon websocket: %v", err)
	}
	select {
	case <-entered:
	case <-time.After(time.Second):
		t.Fatal("readDaemonLoop defer did not enter disconnect critical section")
	}

	dispatched := make(chan struct{})
	go func() {
		h.mu.Lock()
		h.daemons[daemonKey(auth.OwnerAdmin, "dev-1")] = &daemonConn{userID: auth.OwnerAdmin, deviceID: "dev-1", send: make(chan protocol.Envelope, 1)}
		seedRunningTask(h, "shared-task", "dev-1", "running", time.Now().Unix())
		h.mu.Unlock()
		close(dispatched)
	}()
	select {
	case <-dispatched:
		t.Fatal("follow-up dispatch entered daemon disconnect critical section")
	case <-time.After(50 * time.Millisecond):
	}
	close(release)
	select {
	case <-dispatched:
	case <-time.After(time.Second):
		t.Fatal("follow-up dispatch did not resume after daemon disconnect")
	}
	if got := recordStatus(h, "shared-task"); got != "running" {
		t.Fatalf("follow-up after serialized disconnect = %q, want running", got)
	}
}

func TestDaemonReplacementSerializesFollowUpDispatch(t *testing.T) {
	h := NewHub(auth.NewOpen(""))
	seedRunningTask(h, "shared-task", "dev-1", "running", time.Now().Add(-time.Minute).Unix())
	h.daemons[daemonKey(auth.OwnerAdmin, "dev-1")] = &daemonConn{
		userID:   auth.OwnerAdmin,
		deviceID: "dev-1",
		send:     make(chan protocol.Envelope, 1),
	}
	entered := make(chan struct{})
	release := make(chan struct{})
	h.mu.Lock()
	h.daemonSwitchHook = func(stage string) {
		if stage == "replacement" {
			close(entered)
			<-release
		}
	}
	h.mu.Unlock()
	replacement := &daemonConn{userID: auth.OwnerAdmin, send: make(chan protocol.Envelope, 2)}
	replaced := make(chan struct{})
	go func() {
		h.handleDaemonMessage(replacement, protocol.NewEnvelope(protocol.TypeDaemonHello, "daemon", protocol.DaemonHello{DeviceID: "dev-1"}))
		close(replaced)
	}()
	select {
	case <-entered:
	case <-time.After(time.Second):
		t.Fatal("replacement did not enter daemon switch critical section")
	}

	dispatched := make(chan struct{})
	go func() {
		h.mu.Lock()
		seedRunningTask(h, "shared-task", "dev-1", "running", time.Now().Unix())
		h.mu.Unlock()
		close(dispatched)
	}()
	select {
	case <-dispatched:
		t.Fatal("follow-up dispatch entered daemon replacement critical section")
	case <-time.After(50 * time.Millisecond):
	}
	close(release)
	select {
	case <-replaced:
	case <-time.After(time.Second):
		t.Fatal("daemon replacement did not finish")
	}
	select {
	case <-dispatched:
	case <-time.After(time.Second):
		t.Fatal("follow-up dispatch did not resume after daemon replacement")
	}
	if got := recordStatus(h, "shared-task"); got != "running" {
		t.Fatalf("follow-up after serialized replacement = %q, want running", got)
	}
}

func waitForServerTest(t *testing.T, condition func() bool) {
	t.Helper()
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		if condition() {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatal("condition did not become true")
}

func TestDirectACPHistoryReplayPreservesOptimisticPromptIdentity(t *testing.T) {
	h := NewHub(auth.NewOpen(""))
	taskKey := scopedKey(auth.OwnerAdmin, "task-1")
	optimistic := protocol.TaskEvent{
		TaskID:    "task-1",
		EventID:   "evt-optimistic",
		EventType: "user.prompt",
		Source:    "web",
		Sequence:  7,
		Data:      []byte(`{"prompt":"来点马斯克新闻","turn_id":"turn-1"}`),
	}
	h.taskRecords[taskKey] = protocol.TaskRecord{
		TaskID:       "task-1",
		AgentRuntime: "direct_acp",
		Events:       []protocol.TaskEvent{optimistic},
	}
	requester := &agentChatConn{userID: auth.OwnerAdmin, taskID: "task-1", send: make(chan protocol.Envelope, 4)}
	h.agentChatHistoryReq["req-1"] = agentChatHistoryRequest{requester: requester, deviceID: "dev-1"}
	dc := &daemonConn{userID: auth.OwnerAdmin, deviceID: "dev-1"}
	daemonEcho := protocol.TaskEvent{
		TaskID:    "task-1",
		EventID:   "evt-daemon",
		EventType: "user.prompt",
		Source:    "web",
		Sequence:  2,
		Data:      []byte(`{"prompt":"来点马斯克新闻","turn_id":"turn-1","acpx_turn_index":0,"acpx_event_key":"turn:0:user.prompt:0"}`),
	}
	h.handleDaemonMessage(dc, protocol.NewEnvelope(protocol.TypeTaskHistoryResult, "daemon", protocol.TaskHistoryResult{
		RequestID: "req-1",
		TaskID:    "task-1",
		Record: &protocol.TaskRecord{
			TaskID:       "task-1",
			AgentRuntime: "direct_acp",
			Events:       []protocol.TaskEvent{daemonEcho},
		},
	}))

	forwarded := <-requester.send
	event, err := protocol.DecodePayload[protocol.TaskEvent](forwarded)
	if err != nil {
		t.Fatalf("decode replayed task event: %v", err)
	}
	if event.EventID != optimistic.EventID {
		t.Fatalf("replayed prompt event id = %q, want optimistic identity %q", event.EventID, optimistic.EventID)
	}
	record := h.taskRecords[taskKey]
	if len(record.Events) != 1 || record.Events[0].EventID != optimistic.EventID {
		t.Fatalf("merged Direct ACP record events = %#v, want one optimistic prompt identity", record.Events)
	}
}

func TestDirectACPSnapshotBetweenOptimisticPromptAndEchoKeepsTurnDeduplication(t *testing.T) {
	h := NewHub(auth.NewOpen(""))
	taskKey := scopedKey(auth.OwnerAdmin, "task-1")
	optimistic := protocol.TaskEvent{
		TaskID:    "task-1",
		EventID:   "evt-optimistic",
		EventType: "user.prompt",
		Sequence:  7,
		Data:      []byte(`{"prompt":"来点马斯克新闻","turn_id":"turn-1"}`),
	}
	h.taskDevices[taskKey] = "dev-1"
	h.taskRecords[taskKey] = protocol.TaskRecord{
		TaskID:       "task-1",
		AgentRuntime: "direct_acp",
		Status:       "queued",
		UpdatedAt:    time.Now().Unix(),
		Events:       []protocol.TaskEvent{optimistic},
	}
	dc := &daemonConn{userID: auth.OwnerAdmin, deviceID: "dev-1"}
	h.handleDaemonMessage(dc, protocol.NewEnvelope(protocol.TypeTaskSnapshot, "daemon", protocol.TaskSnapshot{
		DeviceID: "dev-1",
		Tasks:    nil,
	}))
	if _, ok := h.taskRecords[taskKey]; !ok {
		t.Fatal("fresh optimistic dispatch was deleted by an earlier empty daemon snapshot")
	}

	echo := optimistic
	echo.EventID = "evt-daemon"
	echo.Sequence = 2
	echo.Data = []byte(`{"prompt":"来点马斯克新闻","turn_id":"turn-1","acpx_turn_index":0,"acpx_event_key":"turn:0:user.prompt:0"}`)
	h.handleDaemonMessage(dc, protocol.NewEnvelope(protocol.TypeTaskEvent, "daemon", echo))

	record := h.taskRecords[taskKey]
	if len(record.Events) != 1 || record.Events[0].EventID != optimistic.EventID {
		t.Fatalf("events after snapshot and keyed echo = %#v, want one optimistic prompt", record.Events)
	}
}

func TestSessionCreateDoesNotDowngradeRunningServerRecord(t *testing.T) {
	h := NewHub(auth.NewOpen(""))
	dc := &daemonConn{userID: auth.OwnerAdmin, deviceID: "dev-1", send: make(chan protocol.Envelope, 2)}
	h.daemons[daemonKey(auth.OwnerAdmin, "dev-1")] = dc
	taskKey := scopedKey(auth.OwnerAdmin, "task-1")
	h.taskDevices[taskKey] = "dev-1"
	h.taskRecords[taskKey] = protocol.TaskRecord{
		TaskID:       "task-1",
		DeviceID:     "dev-1",
		AgentRuntime: "direct_acp",
		Prompt:       "磁盘剩余空间多少",
		Status:       "running",
	}
	env := protocol.NewEnvelope(protocol.TypeSessionCreate, "web", protocol.SessionCreate{
		TaskID:       "task-1",
		Agent:        "opencode",
		AgentRuntime: "direct_acp",
		SessionName:  "task-1",
	})
	env.To.DeviceID = "dev-1"
	if response, forwarded := h.forwardAgentChatCommand(auth.OwnerAdmin, env); !forwarded {
		t.Fatalf("session create was not forwarded: %#v", response)
	}

	record := h.taskRecords[taskKey]
	if record.Status != "running" || record.Prompt != "磁盘剩余空间多少" {
		t.Fatalf("session create downgraded server record: %#v", record)
	}
}

func TestTerminalWebSocketExitsWhenItsDaemonDisconnects(t *testing.T) {
	tests := map[string]func(*websocket.Conn) error{
		"resize": func(conn *websocket.Conn) error {
			return conn.WriteJSON(map[string]any{"type": "resize", "cols": 120, "rows": 40})
		},
		"data": func(conn *websocket.Conn) error {
			return conn.WriteMessage(websocket.BinaryMessage, []byte("echo still-open\n"))
		},
	}

	for name, sendTerminalMessage := range tests {
		t.Run(name, func(t *testing.T) {
			h := NewHub(auth.NewOpen(""))
			h.projects[scopedKey(auth.OwnerAdmin, "project-1")] = Project{
				ID:            "project-1",
				DeviceID:      "dev-1",
				WorkspacePath: "/workspace",
			}
			mux := http.NewServeMux()
			mux.HandleFunc("/ws/daemon", h.ServeDaemonSocket)
			mux.HandleFunc("/ws/terminal", h.ServeTerminalWebSocket)
			server := httptest.NewServer(mux)
			t.Cleanup(server.Close)
			wsURL := "ws" + strings.TrimPrefix(server.URL, "http")

			daemon, _, err := websocket.DefaultDialer.Dial(wsURL+"/ws/daemon", nil)
			if err != nil {
				t.Fatalf("dial daemon websocket: %v", err)
			}
			t.Cleanup(func() { _ = daemon.Close() })
			if err := daemon.WriteJSON(protocol.NewEnvelope(protocol.TypeDaemonHello, "daemon", protocol.DaemonHello{DeviceID: "dev-1"})); err != nil {
				t.Fatalf("write daemon hello: %v", err)
			}
			waitForServerTest(t, func() bool {
				h.mu.RLock()
				defer h.mu.RUnlock()
				return h.daemons[daemonKey(auth.OwnerAdmin, "dev-1")] != nil
			})

			terminal, _, err := websocket.DefaultDialer.Dial(wsURL+"/ws/terminal?project_id=project-1&terminal_id=terminal-1", nil)
			if err != nil {
				t.Fatalf("dial terminal websocket: %v", err)
			}
			t.Cleanup(func() { _ = terminal.Close() })
			_ = daemon.SetReadDeadline(time.Now().Add(time.Second))
			var start protocol.Envelope
			if err := daemon.ReadJSON(&start); err != nil {
				t.Fatalf("read terminal start at daemon: %v", err)
			}
			if start.Type != protocol.TypeTerminalStreamStart {
				t.Fatalf("daemon received %q, want %q", start.Type, protocol.TypeTerminalStreamStart)
			}

			h.mu.RLock()
			disconnected := h.daemons[daemonKey(auth.OwnerAdmin, "dev-1")]
			h.mu.RUnlock()
			if err := daemon.Close(); err != nil {
				t.Fatalf("close daemon websocket: %v", err)
			}
			waitForServerTest(t, func() bool {
				h.mu.RLock()
				defer h.mu.RUnlock()
				return h.daemons[daemonKey(auth.OwnerAdmin, "dev-1")] == nil && disconnected.closed.Load()
			})

			if err := sendTerminalMessage(terminal); err != nil {
				t.Fatalf("send terminal %s after daemon disconnect: %v", name, err)
			}
			_ = terminal.SetReadDeadline(time.Now().Add(time.Second))
			var exit map[string]string
			if err := terminal.ReadJSON(&exit); err != nil {
				t.Fatalf("read terminal offline exit after %s: %v", name, err)
			}
			if exit["type"] != "exit" || exit["reason"] != "device_offline" {
				t.Fatalf("terminal offline response after %s = %#v", name, exit)
			}
		})
	}
}

func TestTerminalWebSocketsForSameTerminalRemainConnected(t *testing.T) {
	h := NewHub(auth.NewOpen(""))
	h.projects[scopedKey(auth.OwnerAdmin, "project-1")] = Project{
		ID: "project-1", DeviceID: "dev-1", WorkspacePath: "/workspace",
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/ws/daemon", h.ServeDaemonSocket)
	mux.HandleFunc("/ws/terminal", h.ServeTerminalWebSocket)
	server := httptest.NewServer(mux)
	t.Cleanup(server.Close)
	wsURL := "ws" + strings.TrimPrefix(server.URL, "http")

	daemon, _, err := websocket.DefaultDialer.Dial(wsURL+"/ws/daemon", nil)
	if err != nil {
		t.Fatalf("dial daemon websocket: %v", err)
	}
	t.Cleanup(func() { _ = daemon.Close() })
	if err := daemon.WriteJSON(protocol.NewEnvelope(protocol.TypeDaemonHello, "daemon", protocol.DaemonHello{DeviceID: "dev-1"})); err != nil {
		t.Fatalf("write daemon hello: %v", err)
	}
	waitForServerTest(t, func() bool {
		h.mu.RLock()
		defer h.mu.RUnlock()
		return h.daemons[daemonKey(auth.OwnerAdmin, "dev-1")] != nil
	})

	dialTerminal := func() *websocket.Conn {
		conn, _, dialErr := websocket.DefaultDialer.Dial(wsURL+"/ws/terminal?project_id=project-1&terminal_id=terminal-1", nil)
		if dialErr != nil {
			t.Fatalf("dial terminal websocket: %v", dialErr)
		}
		t.Cleanup(func() { _ = conn.Close() })
		return conn
	}
	readStart := func() protocol.TerminalStreamStart {
		_ = daemon.SetReadDeadline(time.Now().Add(time.Second))
		var env protocol.Envelope
		if readErr := daemon.ReadJSON(&env); readErr != nil {
			t.Fatalf("read terminal start: %v", readErr)
		}
		start, decodeErr := protocol.DecodePayload[protocol.TerminalStreamStart](env)
		if decodeErr != nil {
			t.Fatalf("decode terminal start: %v", decodeErr)
		}
		return start
	}

	first := dialTerminal()
	firstStart := readStart()
	second := dialTerminal()
	secondStart := readStart()
	if firstStart.ClientID == "" || secondStart.ClientID == "" || firstStart.ClientID == secondStart.ClientID {
		t.Fatalf("terminal client IDs = %q and %q, want distinct non-empty IDs", firstStart.ClientID, secondStart.ClientID)
	}

	writeOutput := func(clientID, value string) {
		if err := daemon.WriteJSON(protocol.NewEnvelope(protocol.TypeTerminalStreamData, "daemon", protocol.TerminalStreamData{
			ProjectID: "project-1", TerminalID: "terminal-1", ClientID: clientID, Data: []byte(value),
		})); err != nil {
			t.Fatalf("write daemon terminal output: %v", err)
		}
	}
	readOutput := func(conn *websocket.Conn, want string) {
		_ = conn.SetReadDeadline(time.Now().Add(time.Second))
		messageType, data, readErr := conn.ReadMessage()
		if readErr != nil {
			t.Fatalf("read terminal output %q: %v", want, readErr)
		}
		if messageType != websocket.BinaryMessage || string(data) != want {
			t.Fatalf("terminal output = type %d %q, want binary %q", messageType, data, want)
		}
	}

	writeOutput(secondStart.ClientID, "second-still-open")
	readOutput(second, "second-still-open")
	writeOutput(firstStart.ClientID, "first-still-open")
	readOutput(first, "first-still-open")
}

func TestDaemonWriteFailureShutsDownAndRemovesConnection(t *testing.T) {
	h := NewHub(auth.NewOpen(""))
	server := httptest.NewServer(http.HandlerFunc(h.ServeDaemonSocket))
	t.Cleanup(server.Close)
	wsURL := "ws" + strings.TrimPrefix(server.URL, "http")
	client, _, err := websocket.DefaultDialer.Dial(wsURL, nil)
	if err != nil {
		t.Fatalf("dial daemon websocket: %v", err)
	}
	t.Cleanup(func() { _ = client.Close() })
	if err := client.WriteJSON(protocol.NewEnvelope(protocol.TypeDaemonHello, "daemon", protocol.DaemonHello{DeviceID: "dev-write-failure"})); err != nil {
		t.Fatalf("write daemon hello: %v", err)
	}

	var dc *daemonConn
	waitForServerTest(t, func() bool {
		h.mu.RLock()
		defer h.mu.RUnlock()
		dc = h.daemons[daemonKey(auth.OwnerAdmin, "dev-write-failure")]
		return dc != nil
	})
	tcp, ok := dc.conn.UnderlyingConn().(*net.TCPConn)
	if !ok {
		t.Fatalf("daemon websocket transport = %T, want *net.TCPConn", dc.conn.UnderlyingConn())
	}
	if err := tcp.CloseWrite(); err != nil {
		t.Fatalf("close daemon TCP write side: %v", err)
	}
	if !dc.enqueue(protocol.NewEnvelope("force-write-failure", "server", nil)) {
		t.Fatal("enqueue before forced write failure returned false")
	}

	waitForServerTest(t, func() bool {
		h.mu.RLock()
		defer h.mu.RUnlock()
		return h.daemons[daemonKey(auth.OwnerAdmin, "dev-write-failure")] == nil && dc.closed.Load()
	})
	select {
	case <-dc.done:
	default:
		t.Fatal("daemon done channel remained open after writer failure")
	}
}
