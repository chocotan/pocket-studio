package server

import (
	"testing"
	"time"

	"remote-agent/internal/auth"
	"remote-agent/internal/protocol"
)

// seedRunningTask registers a task on a device with the given status and
// updatedAt, mirroring how the hub tracks live tasks.
func seedRunningTask(h *Hub, taskID, deviceID, status string, updatedAt int64) {
	key := scopedKey(auth.OwnerAdmin, taskID)
	h.taskDevices[key] = deviceID
	h.taskRecords[key] = protocol.TaskRecord{
		TaskID:    taskID,
		DeviceID:  deviceID,
		Status:    status,
		UpdatedAt: updatedAt,
	}
}

func recordStatus(h *Hub, taskID string) string {
	return h.taskRecords[scopedKey(auth.OwnerAdmin, taskID)].Status
}

func lastEventType(h *Hub, taskID string) string {
	events := h.taskRecords[scopedKey(auth.OwnerAdmin, taskID)].Events
	if len(events) == 0 {
		return ""
	}
	return events[len(events)-1].EventType
}

func TestReconcileClearsTaskDaemonNoLongerRuns(t *testing.T) {
	h := NewHub(auth.NewOpen(""))
	old := time.Now().Unix() - 60
	seedRunningTask(h, "task-1", "dev-1", "running", old)

	// Daemon heartbeat reports an empty running set → task-1 must be interrupted.
	envs := h.reconcileRunningTasks(auth.OwnerAdmin, "dev-1", []string{}, 20*time.Second)

	if len(envs) != 1 {
		t.Fatalf("expected 1 synthesized event, got %d", len(envs))
	}
	if got := recordStatus(h, "task-1"); got != "failed" {
		t.Fatalf("status = %q, want failed", got)
	}
	if got := lastEventType(h, "task-1"); got != "task.failed" {
		t.Fatalf("last event = %q, want task.failed", got)
	}
}

func TestReconcileKeepsTaskStillRunning(t *testing.T) {
	h := NewHub(auth.NewOpen(""))
	old := time.Now().Unix() - 60
	seedRunningTask(h, "task-1", "dev-1", "running", old)

	// Daemon still reports task-1 as running → leave it alone.
	envs := h.reconcileRunningTasks(auth.OwnerAdmin, "dev-1", []string{"task-1"}, 20*time.Second)

	if len(envs) != 0 {
		t.Fatalf("expected no synthesized events, got %d", len(envs))
	}
	if got := recordStatus(h, "task-1"); got != "running" {
		t.Fatalf("status = %q, want running", got)
	}
}

func TestReconcileGraceWindowProtectsFreshDispatch(t *testing.T) {
	h := NewHub(auth.NewOpen(""))
	fresh := time.Now().Unix() // just dispatched
	seedRunningTask(h, "task-1", "dev-1", "running", fresh)

	// Daemon's first heartbeat after dispatch hasn't reported task-1 yet, but it
	// is within the grace window → must NOT be interrupted.
	envs := h.reconcileRunningTasks(auth.OwnerAdmin, "dev-1", []string{}, 20*time.Second)

	if len(envs) != 0 {
		t.Fatalf("expected no events for fresh task, got %d", len(envs))
	}
	if got := recordStatus(h, "task-1"); got != "running" {
		t.Fatalf("status = %q, want running", got)
	}
}

func TestReconcileDisconnectClearsAllActive(t *testing.T) {
	h := NewHub(auth.NewOpen(""))
	fresh := time.Now().Unix()
	seedRunningTask(h, "task-1", "dev-1", "running", fresh)
	seedRunningTask(h, "task-2", "dev-1", "stopping", fresh)
	seedRunningTask(h, "task-3", "dev-2", "running", fresh) // other device, untouched

	// Disconnect: nil running set + zero grace window = mark all active on dev-1.
	envs := h.reconcileRunningTasks(auth.OwnerAdmin, "dev-1", nil, 0)

	if len(envs) != 2 {
		t.Fatalf("expected 2 synthesized events, got %d", len(envs))
	}
	if got := recordStatus(h, "task-1"); got != "failed" {
		t.Fatalf("task-1 status = %q, want failed", got)
	}
	if got := recordStatus(h, "task-2"); got != "failed" {
		t.Fatalf("task-2 status = %q, want failed", got)
	}
	if got := recordStatus(h, "task-3"); got != "running" {
		t.Fatalf("task-3 (other device) status = %q, want running", got)
	}
}

func TestReconcileLeavesTerminalTasksUntouched(t *testing.T) {
	h := NewHub(auth.NewOpen(""))
	old := time.Now().Unix() - 60
	seedRunningTask(h, "task-1", "dev-1", "completed", old)

	envs := h.reconcileRunningTasks(auth.OwnerAdmin, "dev-1", []string{}, 0)

	if len(envs) != 0 {
		t.Fatalf("expected no events for terminal task, got %d", len(envs))
	}
	if got := recordStatus(h, "task-1"); got != "completed" {
		t.Fatalf("status = %q, want completed", got)
	}
}
