package daemon

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/gorilla/websocket"

	"remote-agent/internal/protocol"
)

func TestRunOncePrioritizesHelloAndSnapshotAheadOfQueuedTraffic(t *testing.T) {
	received := make(chan protocol.Envelope, 3)
	upgrader := websocket.Upgrader{CheckOrigin: func(*http.Request) bool { return true }}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer conn.Close()
		for range 3 {
			var env protocol.Envelope
			if err := conn.ReadJSON(&env); err != nil {
				return
			}
			received <- env
		}
	}))
	t.Cleanup(server.Close)

	cfg := DefaultConfig()
	cfg.Device.ID = "device-priority"
	cfg.Server.URL = "ws" + strings.TrimPrefix(server.URL, "http")
	cfg.DirectWeb.Enabled = false
	d := New(cfg)
	d.send <- protocol.NewEnvelope("queued.before.reconnect", "daemon", nil)

	runDone := make(chan error, 1)
	go func() { runDone <- d.runOnce(context.Background()) }()

	first := receiveDaemonEnvelope(t, received)
	second := receiveDaemonEnvelope(t, received)
	third := receiveDaemonEnvelope(t, received)
	if first.Type != protocol.TypeDaemonHello {
		t.Fatalf("first reconnect frame = %q, want %q", first.Type, protocol.TypeDaemonHello)
	}
	if second.Type != protocol.TypeTaskSnapshot {
		t.Fatalf("second reconnect frame = %q, want %q", second.Type, protocol.TypeTaskSnapshot)
	}
	if third.Type != "queued.before.reconnect" {
		t.Fatalf("third reconnect frame = %q, want queued traffic", third.Type)
	}
	select {
	case <-runDone:
	case <-time.After(time.Second):
		t.Fatal("runOnce did not exit after test peer closed")
	}
}

func TestDaemonRunReconnectsAfterPeerStopsAnsweringPings(t *testing.T) {
	t.Setenv("POCKET_STUDIO_DAEMON_CONFIG_DIR", t.TempDir())
	connected := make(chan int, 4)
	var connectionCount atomic.Int32
	upgrader := websocket.Upgrader{CheckOrigin: func(*http.Request) bool { return true }}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer conn.Close()
		index := int(connectionCount.Add(1))
		if index == 1 {
			conn.SetPingHandler(func(string) error { return nil })
		}
		var hello protocol.Envelope
		if err := conn.ReadJSON(&hello); err != nil || hello.Type != protocol.TypeDaemonHello {
			return
		}
		connected <- index
		for {
			if _, _, err := conn.ReadMessage(); err != nil {
				return
			}
		}
	}))
	t.Cleanup(server.Close)

	cfg := DefaultConfig()
	cfg.Device.ID = "device-reconnect"
	cfg.Server.URL = "ws" + strings.TrimPrefix(server.URL, "http")
	cfg.DirectWeb.Enabled = false
	d := New(cfg)
	d.connectionTimings = daemonConnectionTimings{
		handshakeTimeout:  time.Second,
		writeTimeout:      250 * time.Millisecond,
		pongTimeout:       120 * time.Millisecond,
		heartbeatInterval: 30 * time.Millisecond,
	}

	ctx, cancel := context.WithCancel(context.Background())
	runDone := make(chan error, 1)
	go func() { runDone <- d.Run(ctx) }()

	deadline := time.After(3 * time.Second)
	for {
		select {
		case index := <-connected:
			if index >= 2 {
				cancel()
				select {
				case err := <-runDone:
					if !errors.Is(err, context.Canceled) {
						t.Fatalf("Daemon.Run() error = %v, want context canceled", err)
					}
				case <-time.After(time.Second):
					t.Fatal("Daemon.Run did not stop after reconnect test cancellation")
				}
				return
			}
		case <-deadline:
			cancel()
			t.Fatalf("daemon opened %d connection(s), want a reconnect after missing pong", connectionCount.Load())
		}
	}
}

func receiveDaemonEnvelope(t *testing.T, received <-chan protocol.Envelope) protocol.Envelope {
	t.Helper()
	select {
	case env := <-received:
		return env
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for daemon websocket frame")
		return protocol.Envelope{}
	}
}
