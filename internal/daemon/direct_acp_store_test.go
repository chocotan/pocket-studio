package daemon

import (
	"encoding/json"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"remote-agent/internal/protocol"
)

func TestDirectACPStoreDebouncesStreamingWrites(t *testing.T) {
	d := newDirectACPStoreTestDaemon(t, "debounce-task")
	if d.directACPStoreDebounce != time.Second {
		t.Fatalf("default Direct ACP store debounce = %s, want 1s", d.directACPStoreDebounce)
	}
	d.directACPStoreDebounce = 75 * time.Millisecond

	var writes atomic.Int32
	d.directACPStoreWrite = func([]byte) error {
		writes.Add(1)
		return nil
	}

	for index := 0; index < 50; index++ {
		d.emitTaskEventWithNextSequence("debounce-task", "assistant.message", map[string]any{
			"stream_id": "answer-1",
			"replace":   true,
			"text":      string(rune('a' + index%26)),
		}, nil)
	}

	waitForDirectACPStoreWrites(t, &writes, 1)
	time.Sleep(2 * d.directACPStoreDebounce)
	if got := writes.Load(); got != 1 {
		t.Fatalf("Direct ACP store writes = %d, want one coalesced write", got)
	}
}

func TestDirectACPStoreSlowWriteDoesNotBlockLiveEvents(t *testing.T) {
	d := newDirectACPStoreTestDaemon(t, "slow-store-task")
	d.directACPStoreDebounce = 10 * time.Millisecond

	writeStarted := make(chan struct{})
	releaseWrite := make(chan struct{})
	var startOnce sync.Once
	var latestMu sync.Mutex
	var latest []byte
	d.directACPStoreWrite = func(raw []byte) error {
		startOnce.Do(func() { close(writeStarted) })
		<-releaseWrite
		latestMu.Lock()
		latest = append(latest[:0], raw...)
		latestMu.Unlock()
		return nil
	}

	d.emitTaskEventWithNextSequence("slow-store-task", "assistant.message", map[string]any{
		"stream_id": "answer-1",
		"replace":   true,
		"text":      "first",
	}, nil)
	select {
	case <-writeStarted:
	case <-time.After(2 * time.Second):
		t.Fatal("debounced Direct ACP store write did not start")
	}

	emitted := make(chan struct{})
	go func() {
		d.emitTaskEventWithNextSequence("slow-store-task", "assistant.message", map[string]any{
			"stream_id": "answer-1",
			"replace":   true,
			"text":      "second",
		}, nil)
		close(emitted)
	}()
	select {
	case <-emitted:
	case <-time.After(250 * time.Millisecond):
		close(releaseWrite)
		t.Fatal("live event waited for the in-progress Direct ACP store write")
	}

	close(releaseWrite)
	if err := d.flushDirectACPStore(); err != nil {
		t.Fatalf("flush latest Direct ACP store generation: %v", err)
	}
	latestMu.Lock()
	store := decodeDirectACPStore(t, latest)
	latestMu.Unlock()
	if got := directACPStoreEventText(store, "assistant.message"); got != "second" {
		t.Fatalf("persisted assistant text = %q, want latest generation", got)
	}
}

func TestDirectACPTerminalEventFlushesLatestState(t *testing.T) {
	d := newDirectACPStoreTestDaemon(t, "terminal-task")
	d.directACPStoreDebounce = time.Hour

	var writes atomic.Int32
	var savedMu sync.Mutex
	var saved []byte
	d.directACPStoreWrite = func(raw []byte) error {
		writes.Add(1)
		savedMu.Lock()
		saved = append(saved[:0], raw...)
		savedMu.Unlock()
		return nil
	}

	d.emitTaskEventWithNextSequence("terminal-task", "assistant.message", map[string]any{
		"stream_id": "answer-1",
		"replace":   true,
		"text":      "final answer",
	}, json.RawMessage(`{"large":"redundant provider payload"}`))
	if got := writes.Load(); got != 0 {
		t.Fatalf("writes before terminal event = %d, want 0", got)
	}
	d.emitTaskEventWithNextSequence("terminal-task", "task.completed", map[string]any{"exit_code": 0}, nil)
	if got := writes.Load(); got != 1 {
		t.Fatalf("writes after terminal event = %d, want 1", got)
	}

	savedMu.Lock()
	store := decodeDirectACPStore(t, saved)
	savedMu.Unlock()
	if len(store.Tasks) != 1 || store.Tasks[0].Status != "completed" {
		t.Fatalf("persisted task = %#v, want completed task", store.Tasks)
	}
	if got := directACPStoreEventText(store, "assistant.message"); got != "final answer" {
		t.Fatalf("persisted assistant text = %q, want final answer", got)
	}
	for _, event := range store.Tasks[0].Events {
		if event.EventType == "assistant.message" && len(event.Raw) != 0 {
			t.Fatalf("persisted assistant raw payload was not stripped: %s", event.Raw)
		}
	}
}

func TestDirectACPStreamUpdatesStayBoundedInHistory(t *testing.T) {
	d := newDirectACPStoreTestDaemon(t, "bounded-task")
	d.directACPStoreDebounce = time.Hour

	for index := 1; index <= 100; index++ {
		d.emitTaskEventWithNextSequence("bounded-task", "assistant.message", map[string]any{
			"stream_id": "answer-1",
			"replace":   true,
			"text":      index,
		}, nil)
	}
	for _, output := range []string{"one", " two", " three"} {
		d.emitTaskEventWithNextSequence("bounded-task", "tool.output", map[string]any{
			"tool_use_id": "tool-1",
			"stream_id":   "tool-1",
			"append":      true,
			"output":      output,
		}, nil)
	}

	d.mu.Lock()
	events := append([]protocol.TaskEvent(nil), d.history["bounded-task"].Events...)
	d.mu.Unlock()
	if len(events) != 2 {
		t.Fatalf("in-memory events = %d, want one assistant stream and one tool stream", len(events))
	}
	if events[0].Sequence != 100 || events[1].Sequence != 103 {
		t.Fatalf("compacted event sequences = %d, %d; want monotonic latest sequences 100, 103", events[0].Sequence, events[1].Sequence)
	}
	assistant := taskEventDataMap(events[0])
	if got := assistant["text"]; got != float64(100) {
		t.Fatalf("latest assistant stream value = %#v, want 100", got)
	}
	tool := taskEventDataMap(events[1])
	if got := tool["output"]; got != "one two three" {
		t.Fatalf("compacted tool output = %#v, want concatenated output", got)
	}
	if appendValue, _ := tool["append"].(bool); appendValue {
		t.Fatal("compacted tool output still marked as a delta")
	}
}

func TestDirectACPStoreFlushesDuringShutdown(t *testing.T) {
	d := newDirectACPStoreTestDaemon(t, "shutdown-task")
	d.directACPStoreDebounce = time.Hour
	var writes atomic.Int32
	d.directACPStoreWrite = func([]byte) error {
		writes.Add(1)
		return nil
	}

	d.emitTaskEventWithNextSequence("shutdown-task", "assistant.message", map[string]any{
		"stream_id": "answer-1",
		"replace":   true,
		"text":      "pending",
	}, nil)
	d.shutdownPersistentSessions()
	if got := writes.Load(); got != 1 {
		t.Fatalf("shutdown Direct ACP store writes = %d, want 1", got)
	}
}

func newDirectACPStoreTestDaemon(t *testing.T, taskID string) *Daemon {
	t.Helper()
	d := New(Config{})
	d.history[taskID] = protocol.TaskRecord{
		TaskID:        taskID,
		WorkspacePath: t.TempDir(),
		Agent:         "codex",
		AgentRuntime:  "direct_acp",
		Status:        "running",
		StartedAt:     1,
		UpdatedAt:     1,
	}
	t.Cleanup(func() {
		d.mu.Lock()
		d.cancelDirectACPStoreTimerLocked()
		d.directACPStoreSavedGeneration = d.directACPStoreGeneration
		d.mu.Unlock()
	})
	return d
}

func waitForDirectACPStoreWrites(t *testing.T, writes *atomic.Int32, want int32) {
	t.Helper()
	deadline := time.NewTimer(2 * time.Second)
	ticker := time.NewTicker(5 * time.Millisecond)
	defer deadline.Stop()
	defer ticker.Stop()
	for {
		if writes.Load() >= want {
			return
		}
		select {
		case <-deadline.C:
			t.Fatalf("Direct ACP store writes = %d, want at least %d", writes.Load(), want)
		case <-ticker.C:
		}
	}
}

func decodeDirectACPStore(t *testing.T, raw []byte) directACPStore {
	t.Helper()
	var store directACPStore
	if err := json.Unmarshal(raw, &store); err != nil {
		t.Fatalf("decode Direct ACP store: %v", err)
	}
	return store
}

func directACPStoreEventText(store directACPStore, eventType string) string {
	for _, task := range store.Tasks {
		for _, event := range task.Events {
			if event.EventType != eventType {
				continue
			}
			text, _ := taskEventDataMap(event)["text"].(string)
			return text
		}
	}
	return ""
}
