package daemon

import (
	"context"
	"net"
	"net/http"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"

	"remote-agent/internal/protocol"
)

func TestDirectEndpointAdvertisesConfiguredHostAndToken(t *testing.T) {
	cfg := DefaultConfig()
	cfg.DirectWeb.Enabled = true
	cfg.DirectWeb.ListenAddr = ":19082"
	cfg.DirectWeb.PublicHost = "192.168.1.50"
	cfg.DirectWeb.Token = "secret"
	d := New(cfg)

	endpoint := d.directEndpoint()
	if endpoint == nil {
		t.Fatal("directEndpoint() = nil")
	}
	if endpoint.TerminalWebSocketURL != "ws://192.168.1.50:19082/ws/terminal" || endpoint.Token != "secret" {
		t.Fatalf("direct endpoint = %#v", endpoint)
	}
}

func TestDirectEndpointIgnoresConfiguredContainerBridgeHost(t *testing.T) {
	cfg := DefaultConfig()
	cfg.DirectWeb.Enabled = true
	cfg.DirectWeb.ListenAddr = ":19082"
	cfg.DirectWeb.PublicHost = "172.18.0.1"
	cfg.DirectWeb.Token = "secret"
	d := New(cfg)

	endpoint := d.directEndpoint()
	if endpoint == nil {
		t.Fatal("directEndpoint() = nil")
	}
	if strings.Contains(endpoint.TerminalWebSocketURL, "172.18.0.1") {
		t.Fatalf("direct endpoint used unreportable host: %#v", endpoint)
	}
}

func TestDirectTerminalSubscribersReceiveDataTitleAndExit(t *testing.T) {
	cfg := DefaultConfig()
	d := New(cfg)
	server := http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := directWebUpgrader.Upgrade(w, r, nil)
		if err != nil {
			t.Errorf("upgrade: %v", err)
			return
		}
		d.addDirectTerminalSubscriber("project::term", &directTerminalSubscriber{conn: conn})
	})}
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer server.Close()
	go server.Serve(ln)

	ws, _, err := websocket.DefaultDialer.Dial("ws://"+ln.Addr().String(), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer ws.Close()
	ws.SetReadDeadline(time.Now().Add(2 * time.Second))

	d.broadcastDirectTerminalData(protocol.TerminalStreamData{ProjectID: "project", TerminalID: "term", Data: []byte("hello")})
	msgType, data, err := ws.ReadMessage()
	if err != nil {
		t.Fatal(err)
	}
	if msgType != websocket.BinaryMessage || string(data) != "hello" {
		t.Fatalf("data frame = type %d %q", msgType, data)
	}

	d.broadcastDirectTerminalTitle(protocol.TerminalStreamTitle{ProjectID: "project", TerminalID: "term", Title: "Codex", Command: "codex"})
	var title map[string]string
	if err := ws.ReadJSON(&title); err != nil {
		t.Fatal(err)
	}
	if title["type"] != "title" || title["title"] != "Codex" || title["command"] != "codex" {
		t.Fatalf("title = %#v", title)
	}

	d.broadcastDirectTerminalExit(protocol.TerminalStreamExit{ProjectID: "project", TerminalID: "term"})
}

func TestDirectAgentChatEndpointRoutesHistoryAndLiveEvents(t *testing.T) {
	cfg := DefaultConfig()
	cfg.Device.ID = "dev"
	cfg.DirectWeb.Enabled = true
	cfg.DirectWeb.Token = "secret"
	workspacePath := t.TempDir()
	cfg.Workspaces = []protocol.Workspace{{ID: "project", Name: "Project", Path: workspacePath}}
	d := New(cfg)
	d.mu.Lock()
	d.projects["project"] = protocol.Project{ID: "project", Name: "Project", DeviceID: "dev", WorkspacePath: workspacePath, DirectMode: true}
	d.history["rec-1"] = protocol.TaskRecord{
		TaskID:        "rec-1",
		SessionID:     "task",
		WorkspacePath: workspacePath,
		Status:        "created",
		Events: []protocol.TaskEvent{{
			TaskID:    "rec-1",
			EventID:   "evt-history",
			EventType: "session.created",
			Source:    "claude_code",
			Sequence:  1,
		}},
	}
	d.mu.Unlock()

	mux := http.NewServeMux()
	mux.HandleFunc("/ws/agent", d.handleDirectAgentChatWebSocket)
	server := http.Server{Handler: mux}
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer server.Close()
	go server.Serve(ln)

	token := protocol.NewDirectTerminalToken("secret", "project", time.Now().Add(time.Minute))
	ws, _, err := websocket.DefaultDialer.Dial("ws://"+ln.Addr().String()+"/ws/agent?project_id=project&task_id=task&token="+token, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer ws.Close()
	ws.SetReadDeadline(time.Now().Add(2 * time.Second))

	var history protocol.Envelope
	if err := ws.ReadJSON(&history); err != nil {
		t.Fatal(err)
	}
	event, err := protocol.DecodePayload[protocol.TaskEvent](history)
	if err != nil {
		t.Fatalf("decode history event: %v", err)
	}
	if history.Type != protocol.TypeTaskEvent || event.EventID != "evt-history" || event.TaskID != "task" {
		t.Fatalf("history envelope = %#v event=%#v", history, event)
	}

	var ready protocol.Envelope
	if err := ws.ReadJSON(&ready); err != nil {
		t.Fatal(err)
	}
	readyPayload, err := protocol.DecodePayload[protocol.TaskHistoryReady](ready)
	if err != nil {
		t.Fatalf("decode history ready: %v", err)
	}
	if ready.Type != protocol.TypeTaskHistoryReady || readyPayload.TaskID != "task" || !readyPayload.HasEvents {
		t.Fatalf("history ready envelope = %#v payload=%#v", ready, readyPayload)
	}

	d.emitTaskEvent("task", "model.list", 0, map[string]any{"models": []string{"a"}}, nil)
	var live protocol.Envelope
	if err := ws.ReadJSON(&live); err != nil {
		t.Fatal(err)
	}
	event, err = protocol.DecodePayload[protocol.TaskEvent](live)
	if err != nil {
		t.Fatalf("decode live event: %v", err)
	}
	if live.Type != protocol.TypeTaskEvent || event.EventType != "model.list" {
		t.Fatalf("live envelope = %#v event=%#v", live, event)
	}
}

func TestDirectAgentChatEndpointLoadsOlderHistoryPage(t *testing.T) {
	cfg := DefaultConfig()
	cfg.Device.ID = "dev"
	cfg.DirectWeb.Enabled = true
	cfg.DirectWeb.Token = "secret"
	workspacePath := t.TempDir()
	cfg.Workspaces = []protocol.Workspace{{ID: "project", Name: "Project", Path: workspacePath}}
	d := New(cfg)
	events := make([]protocol.TaskEvent, 250)
	for index := range events {
		events[index] = protocol.TaskEvent{
			TaskID:    "task",
			EventID:   "event-" + strconv.Itoa(index),
			EventType: "assistant.message",
			Sequence:  int64(index + 1),
		}
	}
	d.mu.Lock()
	d.projects["project"] = protocol.Project{ID: "project", Name: "Project", DeviceID: "dev", WorkspacePath: workspacePath, DirectMode: true}
	d.history["task"] = protocol.TaskRecord{
		TaskID:        "task",
		WorkspacePath: workspacePath,
		Status:        "completed",
		Events:        events,
	}
	d.mu.Unlock()

	mux := http.NewServeMux()
	mux.HandleFunc("/ws/agent", d.handleDirectAgentChatWebSocket)
	server := http.Server{Handler: mux}
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer server.Close()
	go server.Serve(listener)

	token := protocol.NewDirectTerminalToken("secret", "project", time.Now().Add(time.Minute))
	ws, _, err := websocket.DefaultDialer.Dial("ws://"+listener.Addr().String()+"/ws/agent?project_id=project&task_id=task&history_paging=1&token="+token, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer ws.Close()
	ws.SetReadDeadline(time.Now().Add(2 * time.Second))

	readEvent := func(wantID string) {
		t.Helper()
		var envelope protocol.Envelope
		if err := ws.ReadJSON(&envelope); err != nil {
			t.Fatalf("read %s: %v", wantID, err)
		}
		event, err := protocol.DecodePayload[protocol.TaskEvent](envelope)
		if err != nil || envelope.Type != protocol.TypeTaskEvent || event.EventID != wantID {
			t.Fatalf("history event = %#v payload=%#v err=%v, want %s", envelope, event, err, wantID)
		}
	}
	readReady := func() protocol.TaskHistoryReady {
		t.Helper()
		var envelope protocol.Envelope
		if err := ws.ReadJSON(&envelope); err != nil {
			t.Fatalf("read history ready: %v", err)
		}
		ready, err := protocol.DecodePayload[protocol.TaskHistoryReady](envelope)
		if err != nil || envelope.Type != protocol.TypeTaskHistoryReady {
			t.Fatalf("history ready = %#v payload=%#v err=%v", envelope, ready, err)
		}
		return ready
	}

	for index := 50; index < 250; index++ {
		readEvent("event-" + strconv.Itoa(index))
	}
	ready := readReady()
	if !ready.HasMore || ready.NextCursor != "event-50" {
		t.Fatalf("initial ready = %#v", ready)
	}

	requestID := "older-request"
	if err := ws.WriteJSON(protocol.NewEnvelope(protocol.TypeTaskHistoryGet, "web", protocol.TaskHistoryGet{
		RequestID: requestID,
		TaskID:    "task",
		Cursor:    ready.NextCursor,
		Limit:     protocol.DefaultTaskHistoryLimit,
	})); err != nil {
		t.Fatalf("request older history: %v", err)
	}
	for index := 0; index < 50; index++ {
		readEvent("event-" + strconv.Itoa(index))
	}
	olderReady := readReady()
	if olderReady.RequestID != requestID || olderReady.HasMore || olderReady.NextCursor != "" {
		t.Fatalf("older ready = %#v", olderReady)
	}
}

func TestDirectAgentChatWebSocketRejectsBadToken(t *testing.T) {
	cfg := DefaultConfig()
	cfg.Device.ID = "dev"
	cfg.DirectWeb.Enabled = true
	cfg.DirectWeb.Token = "secret"
	workspacePath := t.TempDir()
	d := New(cfg)
	d.mu.Lock()
	d.projects["project"] = protocol.Project{ID: "project", Name: "Project", DeviceID: "dev", WorkspacePath: workspacePath, DirectMode: true}
	d.mu.Unlock()

	mux := http.NewServeMux()
	mux.HandleFunc("/ws/agent", d.handleDirectAgentChatWebSocket)
	server := http.Server{Handler: mux}
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer server.Close()
	go server.Serve(ln)

	_, resp, err := websocket.DefaultDialer.Dial("ws://"+ln.Addr().String()+"/ws/agent?project_id=project&task_id=task&token=bad", nil)
	if err == nil {
		t.Fatal("Dial with bad token succeeded")
	}
	if resp == nil || resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("bad token response = %#v err=%v", resp, err)
	}
}

func TestDirectAgentChatCommandTypesIncludeSessionList(t *testing.T) {
	if !isDirectAgentChatCommandType(protocol.TypeSessionList) {
		t.Fatal("direct agent chat websocket rejects session.list")
	}
}

func TestDirectAgentChatWebSocketAllowsProjectWithoutDirectModeFlag(t *testing.T) {
	cfg := DefaultConfig()
	cfg.Device.ID = "dev"
	cfg.DirectWeb.Enabled = true
	cfg.DirectWeb.Token = "secret"
	workspacePath := t.TempDir()
	d := New(cfg)
	d.mu.Lock()
	d.projects["project"] = protocol.Project{ID: "project", Name: "Project", DeviceID: "dev", WorkspacePath: workspacePath, DirectMode: false}
	d.mu.Unlock()

	mux := http.NewServeMux()
	mux.HandleFunc("/ws/agent", d.handleDirectAgentChatWebSocket)
	server := http.Server{Handler: mux}
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer server.Close()
	go server.Serve(ln)

	token := protocol.NewDirectTerminalToken("secret", "project", time.Now().Add(time.Minute))
	ws, _, err := websocket.DefaultDialer.Dial("ws://"+ln.Addr().String()+"/ws/agent?project_id=project&task_id=task&token="+token, nil)
	if err != nil {
		t.Fatalf("Dial for project without direct-mode flag failed: %v", err)
	}
	defer ws.Close()
}

func TestDirectTerminalSubscribersReceiveSameTerminalOutput(t *testing.T) {
	cfg := DefaultConfig()
	d := New(cfg)
	server := http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := directWebUpgrader.Upgrade(w, r, nil)
		if err != nil {
			t.Errorf("upgrade: %v", err)
			return
		}
		d.addDirectTerminalSubscriber("project::term", &directTerminalSubscriber{conn: conn})
	})}
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer server.Close()
	go server.Serve(ln)

	first, _, err := websocket.DefaultDialer.Dial("ws://"+ln.Addr().String(), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer first.Close()
	first.SetReadDeadline(time.Now().Add(2 * time.Second))

	second, _, err := websocket.DefaultDialer.Dial("ws://"+ln.Addr().String(), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer second.Close()
	second.SetReadDeadline(time.Now().Add(2 * time.Second))

	d.broadcastDirectTerminalData(protocol.TerminalStreamData{ProjectID: "project", TerminalID: "term", Data: []byte("shared")})
	_, firstData, err := first.ReadMessage()
	if err != nil {
		t.Fatal(err)
	}
	msgType, data, err := second.ReadMessage()
	if err != nil {
		t.Fatal(err)
	}
	if string(firstData) != "shared" || msgType != websocket.BinaryMessage || string(data) != "shared" {
		t.Fatalf("second socket data frame = type %d %q", msgType, data)
	}
}

func TestDirectTerminalWebSocketAllowsProjectWithoutDirectModeFlag(t *testing.T) {
	cfg := DefaultConfig()
	cfg.Device.ID = "dev"
	cfg.DirectWeb.Enabled = true
	cfg.DirectWeb.Token = "secret"
	cfg.Workspaces = []protocol.Workspace{{ID: "project", Name: "Project", Path: t.TempDir()}}
	d := New(cfg)
	d.mu.Lock()
	d.projects["project"] = protocol.Project{ID: "project", Name: "Project", DeviceID: "dev", WorkspacePath: cfg.Workspaces[0].Path, DirectMode: false}
	d.mu.Unlock()

	mux := http.NewServeMux()
	mux.HandleFunc("/ws/terminal", d.handleDirectTerminalWebSocket)
	server := http.Server{Handler: mux}
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer server.Close()
	go server.Serve(ln)

	token := protocol.NewDirectTerminalToken("secret", "project", time.Now().Add(time.Minute))
	ws, _, err := websocket.DefaultDialer.Dial("ws://"+ln.Addr().String()+"/ws/terminal?project_id=project&terminal_id=term&token="+token, nil)
	if err != nil {
		t.Fatalf("Dial for project without direct-mode flag failed: %v", err)
	}
	defer ws.Close()
}

func TestDirectTerminalWebSocketRejectsBadToken(t *testing.T) {
	cfg := DefaultConfig()
	cfg.Device.ID = "dev"
	cfg.DirectWeb.Enabled = true
	cfg.DirectWeb.Token = "secret"
	cfg.Workspaces = []protocol.Workspace{{ID: "project", Name: "Project", Path: t.TempDir()}}
	d := New(cfg)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	mux := http.NewServeMux()
	mux.HandleFunc("/ws/terminal", d.handleDirectTerminalWebSocket)
	server := http.Server{Handler: mux}
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer server.Close()
	go server.Serve(ln)
	go func() { <-ctx.Done(); server.Close() }()

	_, resp, err := websocket.DefaultDialer.Dial("ws://"+ln.Addr().String()+"/ws/terminal?project_id=project&terminal_id=term&token=bad", nil)
	if err == nil {
		t.Fatal("Dial with bad token succeeded")
	}
	if resp == nil || resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("bad token response = %#v err=%v", resp, err)
	}

	_, resp, err = websocket.DefaultDialer.Dial("ws://"+ln.Addr().String()+"/ws/terminal?project_id=project&terminal_id=term&token=secret", nil)
	if err == nil {
		t.Fatal("Dial with raw daemon secret succeeded")
	}
	if resp == nil || resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("raw secret response = %#v err=%v", resp, err)
	}

	validToken := protocol.NewDirectTerminalToken("secret", "project", time.Now().Add(time.Minute))
	_, resp, err = websocket.DefaultDialer.Dial("ws://"+ln.Addr().String()+"/ws/terminal?project_id=project&terminal_id=bad/slash&token="+validToken, nil)
	if err == nil || resp == nil || resp.StatusCode != http.StatusBadRequest || !strings.Contains(err.Error(), "bad handshake") {
		t.Fatalf("invalid terminal id response = %#v err=%v", resp, err)
	}
}
