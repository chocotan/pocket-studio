package daemon

import (
	"context"
	"net"
	"net/http"
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

func TestDirectTerminalSubscriberReplacementClosesStaleSocket(t *testing.T) {
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

	if _, _, err := first.ReadMessage(); err == nil {
		t.Fatal("first stale direct terminal socket stayed open after replacement")
	}

	d.broadcastDirectTerminalData(protocol.TerminalStreamData{ProjectID: "project", TerminalID: "term", Data: []byte("only-latest")})
	msgType, data, err := second.ReadMessage()
	if err != nil {
		t.Fatal(err)
	}
	if msgType != websocket.BinaryMessage || string(data) != "only-latest" {
		t.Fatalf("second socket data frame = type %d %q", msgType, data)
	}
}

func TestDirectTerminalWebSocketRequiresProjectDirectMode(t *testing.T) {
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
	_, resp, err := websocket.DefaultDialer.Dial("ws://"+ln.Addr().String()+"/ws/terminal?project_id=project&terminal_id=term&token="+token, nil)
	if err == nil {
		t.Fatal("Dial for direct-mode disabled project succeeded")
	}
	if resp == nil || resp.StatusCode != http.StatusNotFound {
		t.Fatalf("direct-mode disabled response = %#v err=%v", resp, err)
	}
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
