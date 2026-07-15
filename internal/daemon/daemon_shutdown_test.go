package daemon

import (
	"bufio"
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"

	"remote-agent/internal/protocol"
)

func TestDaemonRunCancellationClosesPersistentACPAdapters(t *testing.T) {
	for _, state := range []string{"idle", "active_request", "initializing"} {
		t.Run(state, func(t *testing.T) {
			t.Setenv("POCKET_STUDIO_DAEMON_CONFIG_DIR", t.TempDir())
			t.Setenv("SHELL", "/bin/sh")
			dir := t.TempDir()
			exitMarker := filepath.Join(dir, "adapter-exited")
			activityMarker := filepath.Join(dir, "adapter-received-request")
			agentConfig := DirectACPAgentConfig{
				Command: os.Args[0],
				Args:    []string{"-test.run=^TestDaemonShutdownACPHelperProcess$"},
				Env: map[string]string{
					"GO_WANT_DAEMON_SHUTDOWN_ACP_HELPER": "1",
					"ACP_EXIT_MARKER":                    exitMarker,
					"ACP_ACTIVITY_MARKER":                activityMarker,
				},
			}

			serverURL, connected := daemonRunTestWebSocketServer(t)
			cfg := DefaultConfig()
			cfg.Server.URL = serverURL
			cfg.DirectWeb.Enabled = false
			cfg.DirectACP.Agents = map[string]DirectACPAgentConfig{"shutdown-helper": agentConfig}
			d := New(cfg)

			ctx, cancel := context.WithCancel(context.Background())
			runDone := make(chan error, 1)
			go func() { runDone <- d.Run(ctx) }()
			select {
			case <-connected:
			case <-time.After(2 * time.Second):
				cancel()
				t.Fatal("daemon did not connect to test server")
			}

			task := protocol.TaskDispatch{
				TaskID:        "shutdown-task",
				Agent:         "shutdown-helper",
				AgentRuntime:  "direct_acp",
				SessionName:   "shutdown-task",
				WorkspacePath: dir,
			}
			var clientDone <-chan struct{}
			var requestDone <-chan error
			var ensureDone <-chan error

			if state == "initializing" {
				result := make(chan error, 1)
				ensureDone = result
				go func() {
					result <- d.ensureDirectACPSession(ctx, task, dir, task.TaskID)
				}()
				waitForDaemonShutdownMarker(t, activityMarker)
			} else {
				client, err := startDirectACPClient(context.Background(), agentConfig, dir, &taskEmitter{daemon: d, taskID: task.TaskID})
				if err != nil {
					cancel()
					t.Fatalf("start direct ACP helper: %v", err)
				}
				clientDone = client.done
				d.mu.Lock()
				d.directACP[task.TaskID] = &directACPSession{taskID: task.TaskID, client: client}
				d.mu.Unlock()
				if state == "active_request" {
					requestCtx, cancelRequest := context.WithCancel(context.Background())
					result := make(chan error, 1)
					requestDone = result
					d.mu.Lock()
					d.tasks[task.TaskID] = &runningTask{id: task.TaskID, cancel: cancelRequest, done: make(chan struct{})}
					d.mu.Unlock()
					go func() {
						_, requestErr := client.request(requestCtx, "session/prompt", map[string]any{"sessionId": task.TaskID})
						result <- requestErr
					}()
					waitForDaemonShutdownMarker(t, activityMarker)
				}
			}

			shutdownStarted := time.Now()
			cancel()
			select {
			case err := <-runDone:
				if !errors.Is(err, context.Canceled) {
					t.Fatalf("Daemon.Run() error = %v, want context canceled", err)
				}
			case <-time.After(5 * time.Second):
				t.Fatal("Daemon.Run() did not finish bounded adapter shutdown")
			}
			if elapsed := time.Since(shutdownStarted); elapsed >= 2500*time.Millisecond {
				t.Fatalf("Daemon.Run() adapter shutdown took %s, want less than 2.5s", elapsed)
			}

			if _, err := os.Stat(exitMarker); err != nil {
				t.Fatalf("adapter had not exited before Daemon.Run returned: %v", err)
			}
			if clientDone != nil {
				select {
				case <-clientDone:
				default:
					t.Fatal("adapter client done channel is still open after Daemon.Run returned")
				}
			}
			if requestDone != nil {
				select {
				case <-requestDone:
				case <-time.After(time.Second):
					t.Fatal("active adapter request did not stop")
				}
			}
			if ensureDone != nil {
				select {
				case err := <-ensureDone:
					if !errors.Is(err, context.Canceled) {
						t.Fatalf("initializing adapter error = %v, want context canceled", err)
					}
				case <-time.After(time.Second):
					t.Fatal("initializing adapter did not stop")
				}
			}
			d.mu.Lock()
			defer d.mu.Unlock()
			if len(d.tasks) != 0 || len(d.directACP) != 0 || len(d.directACPStarts) != 0 || len(d.startingTasks) != 0 {
				t.Fatalf("daemon runtime maps not cleared: tasks=%d direct=%d direct_starts=%d starting=%d", len(d.tasks), len(d.directACP), len(d.directACPStarts), len(d.startingTasks))
			}
		})
	}
}

func TestDaemonShutdownACPHelperProcess(t *testing.T) {
	if os.Getenv("GO_WANT_DAEMON_SHUTDOWN_ACP_HELPER") != "1" {
		return
	}
	activityMarker := os.Getenv("ACP_ACTIVITY_MARKER")
	scanner := bufio.NewScanner(os.Stdin)
	for scanner.Scan() {
		if activityMarker != "" {
			_ = os.WriteFile(activityMarker, []byte("request received\n"), 0o600)
			activityMarker = ""
		}
	}
	if marker := os.Getenv("ACP_EXIT_MARKER"); marker != "" {
		_ = os.WriteFile(marker, []byte("stdin closed\n"), 0o600)
	}
	os.Exit(0)
}

func daemonRunTestWebSocketServer(t *testing.T) (string, <-chan struct{}) {
	t.Helper()
	connected := make(chan struct{}, 1)
	upgrader := websocket.Upgrader{CheckOrigin: func(*http.Request) bool { return true }}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer conn.Close()
		select {
		case connected <- struct{}{}:
		default:
		}
		for {
			if _, _, err := conn.ReadMessage(); err != nil {
				return
			}
		}
	}))
	t.Cleanup(server.Close)
	return "ws" + strings.TrimPrefix(server.URL, "http"), connected
}

func waitForDaemonShutdownMarker(t *testing.T, path string) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if _, err := os.Stat(path); err == nil {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for helper activity marker %q", path)
}
