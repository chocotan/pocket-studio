package daemon

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"remote-agent/internal/protocol"
)

func isACPXRecord(record protocol.TaskRecord) bool {
	return strings.EqualFold(strings.TrimSpace(record.AgentRuntime), "acpx") || record.AgentRuntime == ""
}

func daemonACPXHistoryPath() string {
	return filepath.Join(daemonConfigDir(), "acpx-history.json")
}

type acpxHistoryStore struct {
	Version int                   `json:"version"`
	Tasks   []protocol.TaskRecord `json:"tasks"`
}

func (d *Daemon) saveACPXHistoryStoreLocked() error {
	tasks := make([]protocol.TaskRecord, 0)
	for _, record := range d.history {
		if !isACPXRecord(record) {
			continue
		}
		record.Events = normalizedTaskHistoryEvents(record)
		if record.Status == "running" || record.Status == "stopping" {
			record.Status = "interrupted"
		}
		tasks = append(tasks, record)
	}
	sort.Slice(tasks, func(i, j int) bool {
		return tasks[i].UpdatedAt > tasks[j].UpdatedAt
	})
	if err := os.MkdirAll(daemonConfigDir(), 0o755); err != nil {
		return err
	}
	raw, err := json.MarshalIndent(acpxHistoryStore{Version: 1, Tasks: tasks}, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(daemonACPXHistoryPath(), append(raw, '\n'), 0o600)
}

func (d *Daemon) loadACPXHistoryStore() error {
	raw, err := os.ReadFile(daemonACPXHistoryPath())
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil
		}
		return err
	}
	var store acpxHistoryStore
	if err := json.Unmarshal(raw, &store); err != nil {
		return err
	}
	d.mu.Lock()
	defer d.mu.Unlock()
	for _, record := range store.Tasks {
		if record.TaskID == "" || !isACPXRecord(record) {
			continue
		}
		record.DeviceID = d.cfg.Device.ID
		if record.Status == "running" || record.Status == "stopping" {
			record.Status = "interrupted"
			record.UpdatedAt = protocolNow()
		}
		d.history[record.TaskID] = record
	}
	return nil
}
