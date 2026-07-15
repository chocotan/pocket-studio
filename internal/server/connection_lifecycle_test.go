package server

import (
	"sync"
	"testing"

	"remote-agent/internal/auth"
	"remote-agent/internal/protocol"
)

func TestClosedACPXRequesterDropsLateHistoryResult(t *testing.T) {
	h := NewHub(auth.NewOpen(""))
	requester := &agentChatConn{
		userID: auth.OwnerAdmin,
		taskID: "task-1",
		send:   make(chan protocol.Envelope, 8),
		done:   make(chan struct{}),
	}
	requester.shutdown()
	h.agentChatHistoryReq["req-late"] = agentChatHistoryRequest{requester: requester, deviceID: "device-1"}
	dc := &daemonConn{userID: auth.OwnerAdmin, deviceID: "device-1"}

	h.handleDaemonMessage(dc, protocol.NewEnvelope(protocol.TypeTaskHistoryResult, "daemon", protocol.TaskHistoryResult{
		RequestID: "req-late",
		TaskID:    "task-1",
		Events: []protocol.TaskEvent{
			{TaskID: "task-1", EventID: "evt-late", EventType: "assistant.message"},
		},
	}))

	if len(requester.send) != 0 {
		t.Fatalf("late history result queued %d envelope(s) for closed requester", len(requester.send))
	}
	if _, ok := h.agentChatHistoryReq["req-late"]; ok {
		t.Fatal("late history request was not removed")
	}
}

func TestWebAndACPXBroadcastRaceWithShutdown(t *testing.T) {
	const iterations = 250
	for index := 0; index < iterations; index++ {
		h := NewHub(auth.NewOpen(""))
		wc := &webConn{
			userID: auth.OwnerAdmin,
			send:   make(chan protocol.Envelope, 8),
			done:   make(chan struct{}),
		}
		ac := &agentChatConn{
			userID: auth.OwnerAdmin,
			taskID: "task-1",
			send:   make(chan protocol.Envelope, 8),
			done:   make(chan struct{}),
		}
		h.webs[wc] = struct{}{}
		h.agentChatConns[scopedKey(auth.OwnerAdmin, "task-1")] = map[*agentChatConn]struct{}{ac: {}}
		env := protocol.NewEnvelope("race", "server", map[string]int{"iteration": index})
		start := make(chan struct{})
		var wg sync.WaitGroup
		wg.Add(4)
		go func() {
			defer wg.Done()
			<-start
			h.broadcastToUser(auth.OwnerAdmin, env)
		}()
		go func() {
			defer wg.Done()
			<-start
			h.broadcastToTask(auth.OwnerAdmin, "task-1", env)
		}()
		go func() {
			defer wg.Done()
			<-start
			wc.shutdown()
		}()
		go func() {
			defer wg.Done()
			<-start
			ac.shutdown()
		}()
		close(start)
		wg.Wait()

		if wc.tryEnqueue(env) {
			t.Fatalf("iteration %d: closed web connection accepted envelope", index)
		}
		if ac.tryEnqueue(env) {
			t.Fatalf("iteration %d: closed ACPX connection accepted envelope", index)
		}
	}
}

func TestClientEnqueueUnblocksOnShutdown(t *testing.T) {
	for _, kind := range []string{"web", "acpx"} {
		t.Run(kind, func(t *testing.T) {
			envelope := protocol.NewEnvelope("blocked", "server", nil)
			result := make(chan bool, 1)
			if kind == "web" {
				conn := &webConn{send: make(chan protocol.Envelope), done: make(chan struct{})}
				go func() { result <- conn.enqueue(envelope) }()
				conn.shutdown()
			} else {
				conn := &agentChatConn{send: make(chan protocol.Envelope), done: make(chan struct{})}
				go func() { result <- conn.enqueue(envelope) }()
				conn.shutdown()
			}
			if accepted := <-result; accepted {
				t.Fatalf("%s enqueue succeeded after shutdown", kind)
			}
		})
	}
}
