package server

import (
	"crypto/sha1"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"math"
	"mime"
	"net"
	"net/http"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/gorilla/websocket"

	"remote-agent/internal/auth"
	"remote-agent/internal/hostinfo"
	"remote-agent/internal/protocol"
)

var (
	safeTerminalIDPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{1,96}$`)
)

const terminalRelayWriteTimeout = 2 * time.Second

type Project struct {
	ID             string                   `json:"id"`
	Name           string                   `json:"name"`
	DeviceID       string                   `json:"device_id"`
	WorkspacePath  string                   `json:"workspace_path"`
	AgentIDs       []string                 `json:"agent_ids"`
	TmuxIDs        []string                 `json:"tmux_ids"`
	StudioState    json.RawMessage          `json:"studio_state,omitempty"`
	DirectMode     bool                     `json:"direct_mode,omitempty"`
	DirectEndpoint *protocol.DirectEndpoint `json:"direct_endpoint,omitempty"`
	UserID         string                   `json:"-"`
}

func projectFromProtocol(project protocol.Project) Project {
	return Project{
		ID:             project.ID,
		Name:           project.Name,
		DeviceID:       project.DeviceID,
		WorkspacePath:  project.WorkspacePath,
		AgentIDs:       project.AgentIDs,
		TmuxIDs:        project.TmuxIDs,
		StudioState:    project.StudioState,
		DirectMode:     project.DirectMode,
		DirectEndpoint: project.DirectEndpoint,
	}
}

func protocolProjectFromProject(project Project) protocol.Project {
	return protocol.Project{
		ID:             project.ID,
		Name:           project.Name,
		DeviceID:       project.DeviceID,
		WorkspacePath:  project.WorkspacePath,
		AgentIDs:       project.AgentIDs,
		TmuxIDs:        project.TmuxIDs,
		StudioState:    project.StudioState,
		DirectMode:     project.DirectMode,
		DirectEndpoint: project.DirectEndpoint,
	}
}

type Hub struct {
	auth                *auth.Manager
	mu                  sync.RWMutex
	daemons             map[string]*daemonConn
	webs                map[*webConn]struct{}
	taskAliases         map[string]string
	taskDevices         map[string]string
	taskEvents          map[string][]protocol.Envelope
	taskRecords         map[string]protocol.TaskRecord
	pending             map[string]chan protocol.Envelope
	projects            map[string]Project
	termMu              sync.RWMutex
	terminalConns       map[string]map[*terminalConn]struct{}
	agentChatConns      map[string]map[*agentChatConn]struct{}
	agentChatHistoryReq map[string]agentChatHistoryRequest
	daemonSwitchHook    func(stage string)
}

type agentChatHistoryRequest struct {
	requester *agentChatConn
	deviceID  string
	envelope  protocol.Envelope
}

type daemonConn struct {
	userID         string
	deviceID       string
	deviceName     string
	agent          string
	agentLabel     string
	agents         []protocol.AgentCapability
	workspaces     []protocol.Workspace
	conn           *websocket.Conn
	send           chan protocol.Envelope
	done           chan struct{}
	closeOnce      sync.Once
	closed         atomic.Bool
	mu             sync.Mutex
	terminalBinary bool
	directEndpoint *protocol.DirectEndpoint
	lastSeen       time.Time
}

func (dc *daemonConn) enqueue(env protocol.Envelope) bool {
	if dc == nil || dc.send == nil || dc.closed.Load() {
		return false
	}
	if dc.done == nil {
		dc.send <- env
		return !dc.closed.Load()
	}
	select {
	case dc.send <- env:
		return !dc.closed.Load()
	case <-dc.done:
		return false
	}
}

func (dc *daemonConn) shutdown() {
	dc.closeOnce.Do(func() {
		dc.closed.Store(true)
		if dc.done != nil {
			close(dc.done)
		}
		if dc.conn != nil {
			_ = dc.conn.Close()
		}
	})
}

func (dc *daemonConn) writeEnvelopeDirect(env protocol.Envelope) bool {
	if dc == nil || dc.conn == nil || dc.closed.Load() {
		return false
	}
	dc.mu.Lock()
	defer dc.mu.Unlock()
	if dc.closed.Load() {
		return false
	}
	return writeEnvelope(dc.conn, env) == nil
}

func (dc *daemonConn) writeMessageDirect(messageType int, data []byte) bool {
	if dc == nil || dc.conn == nil || dc.closed.Load() {
		return false
	}
	dc.mu.Lock()
	defer dc.mu.Unlock()
	if dc.closed.Load() {
		return false
	}
	return dc.conn.WriteMessage(messageType, data) == nil
}

type webConn struct {
	userID    string
	conn      *websocket.Conn
	send      chan protocol.Envelope
	done      chan struct{}
	closeOnce sync.Once
	closed    atomic.Bool
}

type terminalConn struct {
	conn *websocket.Conn
	mu   sync.Mutex
}

type agentChatConn struct {
	userID    string
	taskID    string
	projectID string
	conn      *websocket.Conn
	send      chan protocol.Envelope
	done      chan struct{}
	closeOnce sync.Once
	closed    atomic.Bool
}

func enqueueClientEnvelope(send chan protocol.Envelope, done <-chan struct{}, closed *atomic.Bool, env protocol.Envelope, wait bool) bool {
	if send == nil || closed.Load() {
		return false
	}
	if done == nil {
		if wait {
			send <- env
			return !closed.Load()
		}
		select {
		case send <- env:
			return !closed.Load()
		default:
			return false
		}
	}
	if wait {
		select {
		case send <- env:
			return !closed.Load()
		case <-done:
			return false
		}
	}
	select {
	case send <- env:
		return !closed.Load()
	case <-done:
		return false
	default:
		return false
	}
}

func (wc *webConn) enqueue(env protocol.Envelope) bool {
	if wc == nil {
		return false
	}
	return enqueueClientEnvelope(wc.send, wc.done, &wc.closed, env, true)
}

func (wc *webConn) tryEnqueue(env protocol.Envelope) bool {
	if wc == nil {
		return false
	}
	return enqueueClientEnvelope(wc.send, wc.done, &wc.closed, env, false)
}

func (wc *webConn) shutdown() {
	if wc == nil {
		return
	}
	wc.closeOnce.Do(func() {
		wc.closed.Store(true)
		if wc.done != nil {
			close(wc.done)
		}
		if wc.conn != nil {
			_ = wc.conn.Close()
		}
	})
}

func (ac *agentChatConn) enqueue(env protocol.Envelope) bool {
	if ac == nil {
		return false
	}
	return enqueueClientEnvelope(ac.send, ac.done, &ac.closed, env, true)
}

func (ac *agentChatConn) tryEnqueue(env protocol.Envelope) bool {
	if ac == nil {
		return false
	}
	return enqueueClientEnvelope(ac.send, ac.done, &ac.closed, env, false)
}

func (ac *agentChatConn) shutdown() {
	if ac == nil {
		return
	}
	ac.closeOnce.Do(func() {
		ac.closed.Store(true)
		if ac.done != nil {
			close(ac.done)
		}
		if ac.conn != nil {
			_ = ac.conn.Close()
		}
	})
}

type DeviceView struct {
	ID         string                     `json:"id"`
	Name       string                     `json:"name"`
	Status     string                     `json:"status"`
	Agent      string                     `json:"agent,omitempty"`
	AgentLabel string                     `json:"agent_label,omitempty"`
	Agents     []protocol.AgentCapability `json:"agents"`
	LastSeenAt int64                      `json:"last_seen_at"`
	Workspaces []protocol.Workspace       `json:"workspaces"`
	Features   []string                   `json:"features,omitempty"`
}

type StateView struct {
	Devices []DeviceView          `json:"devices"`
	Tasks   []protocol.TaskRecord `json:"tasks"`
}

func NewHub(authManager *auth.Manager) *Hub {
	h := &Hub{
		auth:                authManager,
		daemons:             make(map[string]*daemonConn),
		webs:                make(map[*webConn]struct{}),
		taskAliases:         make(map[string]string),
		taskDevices:         make(map[string]string),
		taskEvents:          make(map[string][]protocol.Envelope),
		taskRecords:         make(map[string]protocol.TaskRecord),
		pending:             make(map[string]chan protocol.Envelope),
		projects:            make(map[string]Project),
		terminalConns:       make(map[string]map[*terminalConn]struct{}),
		agentChatConns:      make(map[string]map[*agentChatConn]struct{}),
		agentChatHistoryReq: make(map[string]agentChatHistoryRequest),
	}
	return h
}

func scopedKey(userID string, id string) string {
	if userID == "" {
		userID = auth.OwnerAdmin
	}
	return userID + "\x00" + id
}

func (h *Hub) resolveTaskIDLocked(userID string, taskID string) string {
	resolved := h.taskAliases[scopedKey(userID, taskID)]
	if resolved == "" {
		return taskID
	}
	return resolved
}

func (h *Hub) deleteTaskStateLocked(userID, taskID, deviceID string) (string, bool) {
	taskID = strings.TrimSpace(taskID)
	if taskID == "" {
		return "", false
	}
	canonicalID := h.resolveTaskIDLocked(userID, taskID)
	taskKey := scopedKey(userID, taskID)
	canonicalKey := scopedKey(userID, canonicalID)
	ownerDeviceID := h.taskDevices[canonicalKey]
	if ownerDeviceID == "" {
		ownerDeviceID = h.taskDevices[taskKey]
	}
	if ownerDeviceID == "" {
		ownerDeviceID = h.taskRecords[canonicalKey].DeviceID
	}
	if ownerDeviceID == "" {
		ownerDeviceID = h.taskRecords[taskKey].DeviceID
	}
	if deviceID != "" && ownerDeviceID != "" && ownerDeviceID != deviceID {
		return canonicalID, false
	}
	keys := map[string]struct{}{
		taskKey:      {},
		canonicalKey: {},
	}
	userPrefix := scopedKey(userID, "")
	for aliasKey, targetID := range h.taskAliases {
		if strings.HasPrefix(aliasKey, userPrefix) && (targetID == taskID || targetID == canonicalID) {
			keys[aliasKey] = struct{}{}
		}
	}
	for key := range keys {
		delete(h.taskDevices, key)
		delete(h.taskRecords, key)
		delete(h.taskEvents, key)
		delete(h.taskAliases, key)
	}
	return canonicalID, true
}

func taskRecordExplicitlyDeleted(record protocol.TaskRecord, deletedIDs map[string]struct{}) bool {
	for _, id := range []string{record.TaskID, record.SessionName, record.SessionID} {
		if _, deleted := deletedIDs[strings.TrimSpace(id)]; deleted {
			return true
		}
	}
	return false
}

func taskAliasIDs(record protocol.TaskRecord) []string {
	ids := make([]string, 0, 3)
	for _, id := range []string{record.SessionName, record.SessionID} {
		id = strings.TrimSpace(id)
		if id == "" || id == record.TaskID {
			continue
		}
		ids = append(ids, id)
	}
	return ids
}

func daemonKey(userID string, deviceID string) string {
	return scopedKey(userID, deviceID)
}

func terminalKey(userID string, projectID string, terminalID string) string {
	return userID + "\x00" + projectID + "\x00" + terminalID
}

func (h *Hub) projectByID(userID string, projectID string) (Project, bool) {
	if projectID == "" {
		return Project{}, false
	}
	h.mu.RLock()
	project, ok := h.projects[scopedKey(userID, projectID)]
	if !ok {
		project, ok = h.daemonWorkspaceProjectByIDLocked(userID, projectID)
	}
	h.mu.RUnlock()
	return project, ok
}

func daemonWorkspaceProjectID(deviceID string, workspace protocol.Workspace) string {
	if id := strings.TrimSpace(workspace.ID); id != "" {
		return id
	}
	sum := sha1.Sum([]byte(deviceID + "\x00" + workspace.Path))
	return "ws_" + fmt.Sprintf("%x", sum[:8])
}

func projectNameForWorkspace(workspace protocol.Workspace) string {
	if name := strings.TrimSpace(workspace.Name); name != "" {
		return name
	}
	if base := filepath.Base(workspace.Path); base != "." && base != "/" && base != "" {
		return base
	}
	return workspace.Path
}

func projectFromDaemonWorkspace(userID string, deviceID string, workspace protocol.Workspace) Project {
	return Project{
		ID:            daemonWorkspaceProjectID(deviceID, workspace),
		Name:          projectNameForWorkspace(workspace),
		DeviceID:      deviceID,
		WorkspacePath: workspace.Path,
		AgentIDs:      []string{},
		TmuxIDs:       []string{},
		UserID:        userID,
	}
}

func (h *Hub) attachDirectEndpointLocked(project Project) Project {
	project.DirectEndpoint = nil
	if dc := h.daemons[daemonKey(project.UserID, project.DeviceID)]; dc != nil && dc.directEndpoint != nil {
		endpoint := *dc.directEndpoint
		expiry := time.Now().Add(15 * time.Minute).Truncate(5 * time.Minute)
		endpoint.Token = protocol.NewDirectTerminalToken(endpoint.Token, project.ID, expiry)
		if endpoint.Token != "" {
			project.DirectEndpoint = &endpoint
		}
	}
	return project
}

func (h *Hub) daemonWorkspaceProjectByIDLocked(userID string, projectID string) (Project, bool) {
	for _, dc := range h.daemons {
		if dc.userID != userID {
			continue
		}
		for _, workspace := range dc.workspaces {
			project := projectFromDaemonWorkspace(userID, dc.deviceID, workspace)
			if project.ID == projectID {
				return h.attachDirectEndpointLocked(project), true
			}
		}
	}
	return Project{}, false
}

func (h *Hub) listProjectsLocked(userID string) []Project {
	list := make([]Project, 0, len(h.projects))
	seen := make(map[string]bool)
	for _, project := range h.projects {
		if project.UserID != userID {
			continue
		}
		list = append(list, h.attachDirectEndpointLocked(project))
		seen[project.DeviceID+"\x00"+project.WorkspacePath] = true
	}
	for _, dc := range h.daemons {
		if dc.userID != userID {
			continue
		}
		for _, workspace := range dc.workspaces {
			if workspace.Path == "" {
				continue
			}
			key := dc.deviceID + "\x00" + workspace.Path
			if seen[key] {
				continue
			}
			project := projectFromDaemonWorkspace(userID, dc.deviceID, workspace)
			list = append(list, h.attachDirectEndpointLocked(project))
			seen[key] = true
		}
	}
	return list
}

func (h *Hub) projectHasOnlineDaemonLocked(project Project) bool {
	return h.daemons[daemonKey(project.UserID, project.DeviceID)] != nil
}

type notificationTabTarget struct {
	hostProjectID string
	panelID       string
	tabID         string
}

func (h *Hub) cacheProjectState(userID string, project Project, state json.RawMessage) {
	if len(state) == 0 {
		return
	}
	project.UserID = userID
	project.StudioState = append(json.RawMessage(nil), state...)
	project.TmuxIDs = collectTerminalTabIDsFromRawState(state)
	h.mu.Lock()
	if existing, ok := h.projects[scopedKey(userID, project.ID)]; ok {
		project.Name = firstNonEmpty(project.Name, existing.Name)
		project.DeviceID = firstNonEmpty(project.DeviceID, existing.DeviceID)
		project.WorkspacePath = firstNonEmpty(project.WorkspacePath, existing.WorkspacePath)
		if project.AgentIDs == nil {
			project.AgentIDs = existing.AgentIDs
		}
		project.DirectMode = existing.DirectMode
	}
	h.projects[scopedKey(userID, project.ID)] = project
	h.mu.Unlock()
}

func projectStateRequestSucceeded(env protocol.Envelope, err error) bool {
	if err != nil {
		return false
	}
	result, decodeErr := protocol.DecodePayload[protocol.ProjectResult](env)
	return decodeErr == nil && result.Error == ""
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return value
		}
	}
	return ""
}

func collectTerminalTabIDsFromRawState(raw json.RawMessage) []string {
	var state struct {
		LayoutTree any `json:"layoutTree"`
	}
	if len(raw) == 0 || json.Unmarshal(raw, &state) != nil {
		return nil
	}
	return collectTerminalTabIDs(state.LayoutTree)
}

func (h *Hub) enrichTerminalStreamAlert(userID string, alert protocol.TerminalStreamAlert) (protocol.TerminalStreamAlert, bool) {
	if strings.TrimSpace(alert.HostProjectID) != "" && strings.TrimSpace(alert.PanelID) != "" {
		return alert, true
	}
	projectID := strings.TrimSpace(alert.ProjectID)
	terminalID := strings.TrimSpace(alert.TerminalID)
	if projectID == "" || terminalID == "" {
		return alert, true
	}
	h.mu.RLock()
	states := make(map[string]json.RawMessage, len(h.projects))
	for key, project := range h.projects {
		if project.UserID != userID || len(project.StudioState) == 0 {
			continue
		}
		_, id, ok := strings.Cut(key, "\x00")
		if !ok || id == "" {
			id = project.ID
		}
		states[id] = append(json.RawMessage(nil), project.StudioState...)
	}
	h.mu.RUnlock()
	for _, hostProjectID := range orderedProjectStateIDs(states, firstNonEmpty(alert.HostProjectID, projectID)) {
		target := tabTargetFromProjectState(states[hostProjectID], projectID, terminalID, hostProjectID == projectID)
		if target.tabID == "" {
			continue
		}
		alert.HostProjectID = hostProjectID
		alert.PanelID = target.panelID
		alert.TerminalID = target.tabID
		return alert, true
	}
	if alert.HostProjectID == "" {
		alert.HostProjectID = projectID
	}
	return alert, true
}

func orderedProjectStateIDs(states map[string]json.RawMessage, preferred string) []string {
	ids := make([]string, 0, len(states))
	if preferred != "" {
		if _, ok := states[preferred]; ok {
			ids = append(ids, preferred)
		}
	}
	rest := make([]string, 0, len(states))
	for id := range states {
		if id == "" || id == preferred {
			continue
		}
		rest = append(rest, id)
	}
	sort.Strings(rest)
	return append(ids, rest...)
}

func tabTargetFromProjectState(raw json.RawMessage, projectID string, terminalID string, allowMissingProjectID bool) notificationTabTarget {
	if len(raw) == 0 || terminalID == "" {
		return notificationTabTarget{}
	}
	var state struct {
		LayoutTree any `json:"layoutTree"`
	}
	if json.Unmarshal(raw, &state) != nil {
		return notificationTabTarget{}
	}
	var found notificationTabTarget
	var walk func(any)
	walk = func(value any) {
		if found.tabID != "" {
			return
		}
		obj, ok := value.(map[string]any)
		if !ok {
			return
		}
		typ, _ := obj["type"].(string)
		if typ == "panel" {
			tabs, _ := obj["tabs"].([]any)
			for _, tabValue := range tabs {
				tab, ok := tabValue.(map[string]any)
				if !ok {
					continue
				}
				if !tabBelongsToProject(tab, projectID, allowMissingProjectID) || !tabMatchesNotificationID(tab, terminalID) {
					continue
				}
				found.panelID, _ = obj["id"].(string)
				found.tabID, _ = tab["id"].(string)
				return
			}
			return
		}
		children, _ := obj["children"].([]any)
		for _, child := range children {
			walk(child)
		}
	}
	walk(state.LayoutTree)
	return found
}

func tabBelongsToProject(tab map[string]any, projectID string, allowMissingProjectID bool) bool {
	tabProjectID, _ := tab["projectId"].(string)
	if strings.TrimSpace(tabProjectID) == "" {
		return allowMissingProjectID
	}
	return strings.TrimSpace(projectID) == "" || tabProjectID == projectID
}

func tabMatchesNotificationID(tab map[string]any, terminalID string) bool {
	if matchesStringField(tab, "id", terminalID) {
		return true
	}
	if kind, _ := tab["kind"].(string); kind != "agent_chat" {
		return false
	}
	return matchesStringField(tab, "agentSessionId", terminalID) || matchesStringField(tab, "agentSessionName", terminalID)
}

func matchesStringField(obj map[string]any, key string, value string) bool {
	field, _ := obj[key].(string)
	return strings.TrimSpace(field) != "" && strings.TrimSpace(field) == strings.TrimSpace(value)
}

func collectTerminalTabIDs(node any) []string {
	var ids []string
	var walk func(any)
	walk = func(value any) {
		obj, ok := value.(map[string]any)
		if !ok {
			return
		}
		typ, _ := obj["type"].(string)
		if typ == "panel" {
			tabs, _ := obj["tabs"].([]any)
			for _, tabValue := range tabs {
				tab, ok := tabValue.(map[string]any)
				if !ok {
					continue
				}
				if kind, _ := tab["kind"].(string); kind != "" && kind != "terminal" {
					continue
				}
				if id, _ := tab["id"].(string); id != "" {
					ids = append(ids, id)
				}
			}
			return
		}
		if typ == "pane" {
			if id, _ := obj["id"].(string); id != "" {
				ids = append(ids, id)
			}
			return
		}
		children, _ := obj["children"].([]any)
		for _, child := range children {
			walk(child)
		}
	}
	walk(node)
	return ids
}

func cleanStudioState(value any) {
	obj, ok := value.(map[string]any)
	if !ok {
		return
	}
	if layout, ok := obj["layoutTree"]; ok {
		cleanStudioLayout(layout)
	}
}

func cleanStudioLayout(value any) {
	obj, ok := value.(map[string]any)
	if !ok {
		return
	}
	if title, ok := obj["title"].(string); ok {
		obj["title"] = title
	}
	if tabs, ok := obj["tabs"].([]any); ok {
		for _, tabValue := range tabs {
			tab, ok := tabValue.(map[string]any)
			if !ok {
				continue
			}
			if title, ok := tab["title"].(string); ok {
				tab["title"] = title
			}
		}
	}
	if children, ok := obj["children"].([]any); ok {
		for _, child := range children {
			cleanStudioLayout(child)
		}
	}
}

var upgrader = websocket.Upgrader{
	CheckOrigin: func(r *http.Request) bool { return true },
}

func (h *Hub) authenticate(w http.ResponseWriter, r *http.Request) (string, bool) {
	userID, err := h.auth.AuthenticateRequest(r)
	if err != nil {
		writeJSON(w, http.StatusUnauthorized, protocol.ServerError{Code: "unauthorized", Message: "invalid or missing token"})
		return "", false
	}
	return userID, true
}

func (h *Hub) ServeWebSocket(w http.ResponseWriter, r *http.Request) {
	userID, ok := h.authenticate(w, r)
	if !ok {
		return
	}
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("upgrade web: %v", err)
		return
	}
	wc := &webConn{userID: userID, conn: conn, send: make(chan protocol.Envelope, 64), done: make(chan struct{})}
	h.mu.Lock()
	h.webs[wc] = struct{}{}
	h.mu.Unlock()

	go func() {
		writeLoop(conn, wc.send, wc.done)
		wc.shutdown()
	}()
	if !wc.enqueue(protocol.NewEnvelope("server.state", "server", h.stateView(userID))) {
		h.mu.Lock()
		delete(h.webs, wc)
		h.mu.Unlock()
		wc.shutdown()
		return
	}
	h.readWebLoop(wc)
}

func (h *Hub) ServeDaemonSocket(w http.ResponseWriter, r *http.Request) {
	userID, ok := h.authenticate(w, r)
	if !ok {
		return
	}
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("upgrade daemon: %v", err)
		return
	}
	enableTCPNoDelay(conn)

	dc := &daemonConn{userID: userID, conn: conn, send: make(chan protocol.Envelope, 64), done: make(chan struct{}), lastSeen: time.Now()}
	go writeDaemonLoop(dc)
	h.readDaemonLoop(dc)
}

func (h *Hub) ServeAgentChatWebSocket(w http.ResponseWriter, r *http.Request) {
	userID, ok := h.authenticate(w, r)
	if !ok {
		return
	}
	taskID := strings.TrimSpace(r.URL.Query().Get("task_id"))
	if taskID == "" {
		writeJSON(w, http.StatusBadRequest, protocol.ServerError{Code: "bad_request", Message: "task_id is required"})
		return
	}
	projectID := strings.TrimSpace(r.URL.Query().Get("project_id"))
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("upgrade agent chat: %v", err)
		return
	}
	ac := &agentChatConn{userID: userID, taskID: taskID, projectID: projectID, conn: conn, send: make(chan protocol.Envelope, 128), done: make(chan struct{})}
	key := scopedKey(userID, taskID)
	h.mu.Lock()
	if h.agentChatConns[key] == nil {
		h.agentChatConns[key] = make(map[*agentChatConn]struct{})
	}
	h.agentChatConns[key][ac] = struct{}{}
	h.mu.Unlock()

	go func() {
		writeLoop(conn, ac.send, ac.done)
		ac.shutdown()
	}()
	h.requestTaskHistoryForAgentChat(ac)
	h.readAgentChatLoop(ac)
}

func (h *Hub) ServeAPI(w http.ResponseWriter, r *http.Request) {
	userID, ok := h.authenticate(w, r)
	if !ok {
		return
	}
	r = r.WithContext(auth.WithUserID(r.Context(), userID))
	if r.URL.Path == "/api/state" && r.Method == http.MethodGet {
		writeJSON(w, http.StatusOK, h.stateView(userID))
		return
	}
	if r.URL.Path == "/api/project/list" && r.Method == http.MethodGet {
		h.mu.RLock()
		list := h.listProjectsLocked(userID)
		h.mu.RUnlock()

		sort.Slice(list, func(i, j int) bool {
			return list[i].Name < list[j].Name
		})

		writeJSON(w, http.StatusOK, list)
		return
	}
	if r.URL.Path == "/api/project/create" && r.Method == http.MethodPost {
		var req Project
		if !decodeJSON(w, r, &req) {
			return
		}
		if req.Name == "" || req.DeviceID == "" || req.WorkspacePath == "" {
			writeJSON(w, http.StatusBadRequest, protocol.ServerError{Code: "bad_request", Message: "name, device_id, and workspace_path are required"})
			return
		}
		requestID := protocol.NewID("req")
		env, err := h.requestDaemonForDevice(r, req.DeviceID, protocol.TypeProjectCreate, req.WorkspacePath, requestID, protocol.ProjectCreateRequest{
			RequestID:     requestID,
			Name:          req.Name,
			DeviceID:      req.DeviceID,
			WorkspacePath: req.WorkspacePath,
		})
		writeProjectResult(w, env, err, true, func(project *Project) {
			project.UserID = userID
			h.mu.Lock()
			*project = h.attachDirectEndpointLocked(*project)
			h.projects[scopedKey(userID, project.ID)] = *project
			h.mu.Unlock()
		})
		return
	}
	if r.URL.Path == "/api/project/delete" && r.Method == http.MethodPost {
		var req struct {
			ProjectID string `json:"project_id"`
		}
		if !decodeJSON(w, r, &req) {
			return
		}
		if req.ProjectID == "" {
			writeJSON(w, http.StatusBadRequest, protocol.ServerError{Code: "bad_request", Message: "project_id is required"})
			return
		}
		project, ok := h.projectByID(userID, req.ProjectID)
		if !ok {
			writeJSON(w, http.StatusNotFound, protocol.ServerError{Code: "not_found", Message: "project not found"})
			return
		}
		requestID := protocol.NewID("req")
		env, err := h.requestDaemonForDevice(r, project.DeviceID, protocol.TypeProjectDelete, project.WorkspacePath, requestID, protocol.ProjectDeleteRequest{
			RequestID: requestID,
			ProjectID: req.ProjectID,
		})
		writeProjectResult(w, env, err, false, nil)
		if err == nil {
			if result, decodeErr := protocol.DecodePayload[protocol.ProjectResult](env); decodeErr == nil && result.Error == "" {
				h.mu.Lock()
				delete(h.projects, scopedKey(userID, req.ProjectID))
				h.mu.Unlock()
				h.broadcastToUser(userID, protocol.NewEnvelope("server.state", "server", h.stateView(userID)))
			}
		}
		return
	}
	if r.URL.Path == "/api/device/alias" && r.Method == http.MethodPost {
		var req struct {
			DeviceID string `json:"device_id"`
			Alias    string `json:"alias"`
		}
		if !decodeJSON(w, r, &req) {
			return
		}
		if strings.TrimSpace(req.DeviceID) == "" {
			writeJSON(w, http.StatusBadRequest, protocol.ServerError{Code: "bad_request", Message: "device_id is required"})
			return
		}
		requestID := protocol.NewID("req")
		env, err := h.requestDaemonForDevice(r, req.DeviceID, protocol.TypeDeviceAliasSet, "", requestID, protocol.DeviceAliasSetRequest{
			RequestID: requestID,
			DeviceID:  req.DeviceID,
			Alias:     req.Alias,
		})
		if writeDeviceAliasResult(w, env, err, func(result protocol.DeviceAliasResult) {
			h.mu.Lock()
			if dc := h.daemons[daemonKey(userID, req.DeviceID)]; dc != nil {
				dc.deviceName = result.DeviceName
				dc.lastSeen = time.Now()
			}
			h.mu.Unlock()
		}) {
			h.broadcastToUser(userID, protocol.NewEnvelope("server.state", "server", h.stateView(userID)))
		}
		return
	}
	if r.URL.Path == "/api/project/state" {
		if r.Method == http.MethodGet {
			projID := r.URL.Query().Get("project_id")
			if projID == "" {
				writeJSON(w, http.StatusBadRequest, protocol.ServerError{Code: "bad_request", Message: "project_id is required"})
				return
			}
			project, ok := h.projectByID(userID, projID)
			if !ok {
				writeJSON(w, http.StatusNotFound, protocol.ServerError{Code: "not_found", Message: "project not found"})
				return
			}
			requestID := protocol.NewID("req")
			env, err := h.requestDaemonForDevice(r, project.DeviceID, protocol.TypeProjectStateGet, project.WorkspacePath, requestID, protocol.ProjectStateGetRequest{
				RequestID:     requestID,
				ProjectID:     project.ID,
				WorkspacePath: project.WorkspacePath,
			})
			writeProjectStateResult(w, env, err, func(state json.RawMessage) {
				h.cacheProjectState(userID, project, state)
			})
			return
		} else if r.Method == http.MethodPost {
			var req struct {
				ProjectID string `json:"project_id"`
				State     any    `json:"state"`
			}
			if !decodeJSON(w, r, &req) {
				return
			}
			if req.ProjectID == "" {
				writeJSON(w, http.StatusBadRequest, protocol.ServerError{Code: "bad_request", Message: "project_id is required"})
				return
			}

			cleanStudioState(req.State)
			rawState, err := json.Marshal(req.State)
			if err != nil {
				writeJSON(w, http.StatusBadRequest, protocol.ServerError{Code: "bad_payload", Message: err.Error()})
				return
			}
			project, ok := h.projectByID(userID, req.ProjectID)
			if !ok {
				writeJSON(w, http.StatusNotFound, protocol.ServerError{Code: "not_found", Message: "project not found"})
				return
			}
			requestID := protocol.NewID("req")
			env, err := h.requestDaemonForDevice(r, project.DeviceID, protocol.TypeProjectStateSet, project.WorkspacePath, requestID, protocol.ProjectStateSetRequest{
				RequestID:     requestID,
				ProjectID:     project.ID,
				WorkspacePath: project.WorkspacePath,
				State:         rawState,
			})
			if projectStateRequestSucceeded(env, err) {
				h.cacheProjectState(userID, project, rawState)
			}
			writeProjectResult(w, env, err, false, nil)
			return
		}
	}
	if r.URL.Path == "/api/project/files" && r.Method == http.MethodPost {
		var req struct {
			ProjectID string `json:"project_id"`
			Path      string `json:"path,omitempty"`
		}
		if !decodeJSON(w, r, &req) {
			return
		}
		if req.ProjectID == "" {
			writeJSON(w, http.StatusBadRequest, protocol.ServerError{Code: "bad_request", Message: "project_id is required"})
			return
		}
		project, ok := h.projectByID(userID, req.ProjectID)
		if !ok {
			writeJSON(w, http.StatusNotFound, protocol.ServerError{Code: "not_found", Message: "project not found"})
			return
		}
		requestID := protocol.NewID("req")
		env, err := h.requestDaemonForDevice(r, project.DeviceID, protocol.TypeWorkspaceList, project.WorkspacePath, requestID, protocol.WorkspaceListRequest{
			RequestID:     requestID,
			WorkspacePath: project.WorkspacePath,
			Path:          req.Path,
		})
		writeAPIEnvelope(w, env, err)
		return
	}
	if r.URL.Path == "/api/project/search-files" && r.Method == http.MethodPost {
		var req struct {
			ProjectID string `json:"project_id"`
			Query     string `json:"query"`
			Limit     int    `json:"limit,omitempty"`
		}
		if !decodeJSON(w, r, &req) {
			return
		}
		_, ok := h.projectByID(userID, req.ProjectID)
		if !ok {
			writeJSON(w, http.StatusNotFound, protocol.ServerError{Code: "not_found", Message: "project not found"})
			return
		}
		writeJSON(w, http.StatusBadRequest, protocol.ServerError{Code: "unsupported", Message: "file search is not supported by the daemon protocol yet"})
		return
	}
	if r.URL.Path == "/api/project/file/read" && r.Method == http.MethodPost {
		var req struct {
			ProjectID string `json:"project_id"`
			Path      string `json:"path"`
		}
		if !decodeJSON(w, r, &req) {
			return
		}
		project, ok := h.projectByID(userID, req.ProjectID)
		if !ok {
			writeJSON(w, http.StatusNotFound, protocol.ServerError{Code: "not_found", Message: "project not found"})
			return
		}
		requestID := protocol.NewID("req")
		env, err := h.requestDaemonForDevice(r, project.DeviceID, protocol.TypeWorkspaceRead, project.WorkspacePath, requestID, protocol.WorkspaceReadRequest{
			RequestID:     requestID,
			WorkspacePath: project.WorkspacePath,
			Path:          req.Path,
		})
		writeProjectFileReadEnvelope(w, req.Path, env, err)
		return
	}
	if r.URL.Path == "/api/project/file/write" && r.Method == http.MethodPost {
		var req struct {
			ProjectID string `json:"project_id"`
			Path      string `json:"path"`
			Content   string `json:"content"`
		}
		if !decodeJSON(w, r, &req) {
			return
		}
		project, ok := h.projectByID(userID, req.ProjectID)
		if !ok {
			writeJSON(w, http.StatusNotFound, protocol.ServerError{Code: "not_found", Message: "project not found"})
			return
		}
		requestID := protocol.NewID("req")
		env, err := h.requestDaemonForDevice(r, project.DeviceID, protocol.TypeWorkspaceWrite, project.WorkspacePath, requestID, protocol.WorkspaceWriteRequest{
			RequestID:     requestID,
			WorkspacePath: project.WorkspacePath,
			Path:          req.Path,
			Content:       req.Content,
		})
		writeProjectFileReadEnvelope(w, req.Path, env, err)
		return
	}
	if r.URL.Path == "/api/project/file/action" && r.Method == http.MethodPost {
		var req struct {
			ProjectID string `json:"project_id"`
			Action    string `json:"action"`
			Path      string `json:"path"`
			Target    string `json:"target,omitempty"`
		}
		if !decodeJSON(w, r, &req) {
			return
		}
		_, ok := h.projectByID(userID, req.ProjectID)
		if !ok {
			writeJSON(w, http.StatusNotFound, protocol.ServerError{Code: "not_found", Message: "project not found"})
			return
		}
		writeJSON(w, http.StatusBadRequest, protocol.ServerError{Code: "unsupported", Message: "file actions are not supported by the daemon protocol yet"})
		return
	}
	if r.URL.Path == "/api/workspace/list" && r.Method == http.MethodPost {
		var req protocol.WorkspaceListRequest
		if !decodeJSON(w, r, &req) {
			return
		}
		env, err := h.requestDaemon(r, protocol.TypeWorkspaceList, req.WorkspacePath, req.RequestID, req)
		writeAPIEnvelope(w, env, err)
		return
	}
	if r.URL.Path == "/api/workspace/read" && r.Method == http.MethodPost {
		var req protocol.WorkspaceReadRequest
		if !decodeJSON(w, r, &req) {
			return
		}
		env, err := h.requestDaemon(r, protocol.TypeWorkspaceRead, req.WorkspacePath, req.RequestID, req)
		writeAPIEnvelope(w, env, err)
		return
	}
	if r.URL.Path == "/api/workspace/write" && r.Method == http.MethodPost {
		var req protocol.WorkspaceWriteRequest
		if !decodeJSON(w, r, &req) {
			return
		}
		env, err := h.requestDaemon(r, protocol.TypeWorkspaceWrite, req.WorkspacePath, req.RequestID, req)
		writeAPIEnvelope(w, env, err)
		return
	}
	if r.URL.Path == "/api/terminal/run" && r.Method == http.MethodPost {
		var req protocol.TerminalRunRequest
		if !decodeJSON(w, r, &req) {
			return
		}
		env, err := h.requestDaemon(r, protocol.TypeTerminalRun, req.WorkspacePath, req.RequestID, req)
		writeAPIEnvelope(w, env, err)
		return
	}
	if r.URL.Path == "/api/terminal/close" && r.Method == http.MethodPost {
		var req struct {
			ProjectID  string `json:"project_id"`
			TerminalID string `json:"terminal_id"`
		}
		if !decodeJSON(w, r, &req) {
			return
		}
		if req.ProjectID == "" || req.TerminalID == "" {
			writeJSON(w, http.StatusBadRequest, protocol.ServerError{Code: "bad_request", Message: "project_id and terminal_id are required"})
			return
		}
		h.closeTerminal(userID, req.ProjectID, req.TerminalID)
		writeJSON(w, http.StatusOK, map[string]any{"success": true})
		return
	}
	http.NotFound(w, r)
}

func (h *Hub) forwardAgentChatCommand(userID string, env protocol.Envelope) (protocol.Envelope, bool) {
	switch env.Type {
	case protocol.TypeSessionCreate:
		session, err := protocol.DecodePayload[protocol.SessionCreate](env)
		if err != nil {
			return serverErrorForEnvelope(env, "bad_payload", err.Error()), false
		}
		deviceID := env.To.DeviceID
		if deviceID == "" {
			return serverErrorForSessionCreate(session, "missing_device", "session.create requires to.device_id"), false
		}
		h.mu.Lock()
		dc := h.daemons[daemonKey(userID, deviceID)]
		if dc != nil {
			h.taskDevices[scopedKey(userID, session.TaskID)] = deviceID
			now := time.Now().Unix()
			record := h.taskRecords[scopedKey(userID, session.TaskID)]
			if record.TaskID == "" {
				record.TaskID = session.TaskID
				record.StartedAt = now
				record.Status = "created"
			}
			record.DeviceID = deviceID
			record.WorkspaceID = session.WorkspaceID
			record.WorkspacePath = session.WorkspacePath
			record.Agent = session.Agent
			record.AgentRuntime = session.AgentRuntime
			record.SessionName = session.SessionName
			record.UpdatedAt = now
			h.taskRecords[scopedKey(userID, session.TaskID)] = record
		}
		h.mu.Unlock()
		if dc == nil {
			return serverErrorForSessionCreate(session, "device_offline", "target device is offline"), false
		}
		forward := env
		forward.From = "server"
		if forward.ID == "" {
			forward.ID = protocol.NewID("msg")
		}
		if !dc.enqueue(forward) {
			return serverErrorForSessionCreate(session, "device_offline", "target device is offline"), false
		}
		return protocol.Envelope{}, true
	case protocol.TypeTaskDispatch:
		task, err := protocol.DecodePayload[protocol.TaskDispatch](env)
		if err != nil {
			return serverErrorForEnvelope(env, "bad_payload", err.Error()), false
		}
		if task.TurnID == "" {
			task.TurnID = protocol.NewID("turn")
		}
		deviceID := env.To.DeviceID
		if deviceID == "" {
			return serverErrorForTaskDispatch(task, "missing_device", "task.dispatch requires to.device_id"), false
		}
		var userPromptEvent protocol.TaskEvent
		h.mu.Lock()
		dc := h.daemons[daemonKey(userID, deviceID)]
		if dc != nil {
			userPromptEvent = h.prepareTaskDispatchRecordLocked(userID, deviceID, task)
		}
		h.mu.Unlock()
		if dc == nil {
			return serverErrorForTaskDispatch(task, "device_offline", "target device is offline"), false
		}
		if userPromptEvent.TaskID != "" {
			forwardEvent := taskEventEnvelope(userPromptEvent)
			h.broadcastToUser(userID, forwardEvent)
			h.broadcastToTask(userID, task.TaskID, forwardEvent)
		}
		forward := env
		forward.Payload = MarshalPayload(task)
		forward.From = "server"
		if forward.ID == "" {
			forward.ID = protocol.NewID("msg")
		}
		if !dc.enqueue(forward) {
			return serverErrorForTaskDispatch(task, "device_offline", "target device is offline"), false
		}
		return protocol.Envelope{}, true
	case protocol.TypeTaskStop:
		stop, err := protocol.DecodePayload[protocol.TaskStop](env)
		if err != nil {
			return serverErrorForEnvelope(env, "bad_payload", err.Error()), false
		}
		h.mu.RLock()
		deviceID := h.taskDevices[scopedKey(userID, stop.TaskID)]
		dc := h.daemons[daemonKey(userID, deviceID)]
		h.mu.RUnlock()
		if dc == nil {
			return serverErrorForTaskStop(stop, "task_not_routable", "task has no connected daemon"), false
		}
		forward := env
		forward.From = "server"
		if !dc.enqueue(forward) {
			return serverErrorForTaskStop(stop, "task_not_routable", "task has no connected daemon"), false
		}
		return protocol.Envelope{}, true
	case protocol.TypeTaskSetModel:
		change, err := protocol.DecodePayload[protocol.TaskSetModel](env)
		if err != nil {
			return serverErrorForEnvelope(env, "bad_payload", err.Error()), false
		}
		if change.TaskID == "" || change.ModelID == "" {
			return serverErrorForTaskSetModel(change, "bad_payload", "task.set_model requires task_id and model_id"), false
		}
		h.mu.RLock()
		deviceID := h.taskDevices[scopedKey(userID, change.TaskID)]
		dc := h.daemons[daemonKey(userID, deviceID)]
		h.mu.RUnlock()
		if dc == nil {
			return serverErrorForTaskSetModel(change, "task_not_routable", "task has no connected daemon"), false
		}
		forward := env
		forward.From = "server"
		if !dc.enqueue(forward) {
			return serverErrorForTaskSetModel(change, "task_not_routable", "task has no connected daemon"), false
		}
		return protocol.Envelope{}, true
	case protocol.TypeTaskSetConfigOption:
		change, err := protocol.DecodePayload[protocol.TaskSetConfigOption](env)
		if err != nil {
			return serverErrorForEnvelope(env, "bad_payload", err.Error()), false
		}
		if change.TaskID == "" || change.ConfigID == "" {
			return serverErrorForTaskSetConfigOption(change, "bad_payload", "task.set_config_option requires task_id and config_id"), false
		}
		h.mu.RLock()
		deviceID := h.taskDevices[scopedKey(userID, change.TaskID)]
		dc := h.daemons[daemonKey(userID, deviceID)]
		h.mu.RUnlock()
		if dc == nil {
			return serverErrorForTaskSetConfigOption(change, "task_not_routable", "task has no connected daemon"), false
		}
		forward := env
		forward.From = "server"
		if !dc.enqueue(forward) {
			return serverErrorForTaskSetConfigOption(change, "task_not_routable", "task has no connected daemon"), false
		}
		return protocol.Envelope{}, true
	case protocol.TypeSessionDelete:
		remove, err := protocol.DecodePayload[protocol.SessionDelete](env)
		if err != nil {
			return serverErrorForEnvelope(env, "bad_payload", err.Error()), false
		}
		if remove.TaskID == "" {
			return serverErrorForSessionDelete(remove, "bad_payload", "session.delete requires task_id"), false
		}
		h.mu.RLock()
		deviceID := env.To.DeviceID
		if deviceID == "" {
			deviceID = h.taskDevices[scopedKey(userID, remove.TaskID)]
		}
		dc := h.daemons[daemonKey(userID, deviceID)]
		h.mu.RUnlock()
		if dc == nil {
			return serverErrorForSessionDelete(remove, "task_not_routable", "session has no connected daemon"), false
		}
		forward := env
		forward.From = "server"
		if !dc.enqueue(forward) {
			return serverErrorForSessionDelete(remove, "task_not_routable", "session has no connected daemon"), false
		}
		return protocol.Envelope{}, true
	default:
		return serverError("unsupported_type", "unsupported agent chat command type"), false
	}
}

func (h *Hub) prepareTaskDispatchRecordLocked(userID string, deviceID string, task protocol.TaskDispatch) protocol.TaskEvent {
	h.taskDevices[scopedKey(userID, task.TaskID)] = deviceID
	now := time.Now().Unix()
	record := h.taskRecords[scopedKey(userID, task.TaskID)]
	if record.TaskID == "" {
		record.TaskID = task.TaskID
		record.StartedAt = now
	}
	record.DeviceID = deviceID
	record.WorkspaceID = task.WorkspaceID
	record.WorkspacePath = task.WorkspacePath
	record.Agent = task.Agent
	record.AgentRuntime = task.AgentRuntime
	record.SessionName = task.SessionName
	record.ModelID = task.ModelID
	record.Prompt = task.Prompt
	record.ParentTaskID = task.ParentTaskID
	if task.ResumeSessionID != "" {
		record.SessionID = task.ResumeSessionID
	}
	record.Status = "queued"
	record.UpdatedAt = now
	data := map[string]any{"prompt": task.Prompt, "turn_id": task.TurnID}
	userEvent := protocol.TaskEvent{
		TaskID:    task.TaskID,
		EventID:   protocol.NewID("evt"),
		EventType: "user.prompt",
		Source:    "web",
		Sequence:  nextTaskEventSequence(record.Events, 0),
		Timestamp: now,
		Data:      MarshalPayload(data),
	}
	record.Events = append(record.Events, userEvent)
	h.taskRecords[scopedKey(userID, task.TaskID)] = record
	return userEvent
}

func (h *Hub) readWebLoop(wc *webConn) {
	defer func() {
		h.mu.Lock()
		delete(h.webs, wc)
		h.mu.Unlock()
		wc.shutdown()
	}()

	for {
		var env protocol.Envelope
		if err := wc.conn.ReadJSON(&env); err != nil {
			return
		}
		switch env.Type {
		case "ping":
			if !wc.enqueue(protocol.NewEnvelope("pong", "server", nil)) {
				return
			}
		case protocol.TypeSessionCreate, protocol.TypeTaskDispatch, protocol.TypeTaskStop, protocol.TypeTaskSetModel, protocol.TypeSessionDelete:
			if !wc.enqueue(serverError("unsupported_type", "agent chat commands require /ws/agent")) {
				return
			}
		case protocol.TypeWorkspaceList, protocol.TypeWorkspaceRead, protocol.TypeWorkspaceWrite, protocol.TypeTerminalRun:
			deviceID := env.To.DeviceID
			if deviceID == "" {
				if !wc.enqueue(serverError("missing_device", env.Type+" requires to.device_id")) {
					return
				}
				continue
			}
			h.mu.RLock()
			dc := h.daemons[daemonKey(wc.userID, deviceID)]
			h.mu.RUnlock()
			if dc == nil {
				if !wc.enqueue(serverError("device_offline", "target device is offline")) {
					return
				}
				continue
			}
			forward := env
			forward.From = "server"
			if forward.ID == "" {
				forward.ID = protocol.NewID("msg")
			}
			if !dc.enqueue(forward) {
				if !wc.enqueue(serverError("device_offline", "target device is offline")) {
					return
				}
			}
		default:
			if !wc.enqueue(serverError("unsupported_type", "unsupported web message type")) {
				return
			}
		}
	}
}

func (h *Hub) readAgentChatLoop(ac *agentChatConn) {
	defer func() {
		key := scopedKey(ac.userID, ac.taskID)
		h.mu.Lock()
		if conns := h.agentChatConns[key]; conns != nil {
			delete(conns, ac)
			if len(conns) == 0 {
				delete(h.agentChatConns, key)
			}
		}
		for requestID, request := range h.agentChatHistoryReq {
			if request.requester == ac {
				delete(h.agentChatHistoryReq, requestID)
			}
		}
		h.mu.Unlock()
		ac.shutdown()
	}()

	for {
		var env protocol.Envelope
		if err := ac.conn.ReadJSON(&env); err != nil {
			return
		}
		if env.From == "" {
			env.From = "web"
		}
		if env.Type == "ping" {
			if !ac.enqueue(protocol.NewEnvelope("pong", "server", nil)) {
				return
			}
			continue
		}
		if !isAgentChatCommandType(env.Type) {
			if !ac.enqueue(serverError("unsupported_type", "unsupported agent chat websocket message type")) {
				return
			}
			continue
		}
		if !envelopeMatchesTask(env, ac.taskID) {
			if !ac.enqueue(serverError("task_mismatch", "message task_id does not match websocket task_id")) {
				return
			}
			continue
		}
		if errEnv, ok := h.forwardAgentChatCommand(ac.userID, env); !ok {
			if !ac.enqueue(errEnv) {
				return
			}
		}
	}
}

func (h *Hub) requestTaskHistoryForAgentChat(ac *agentChatConn) {
	h.mu.RLock()
	resolvedTaskID := h.resolveTaskIDLocked(ac.userID, ac.taskID)
	record := h.taskRecords[scopedKey(ac.userID, resolvedTaskID)]
	deviceID := record.DeviceID
	workspacePath := record.WorkspacePath
	if deviceID == "" {
		deviceID = h.taskDevices[scopedKey(ac.userID, resolvedTaskID)]
	}
	if deviceID == "" && ac.projectID != "" {
		if project, ok := h.projects[scopedKey(ac.userID, ac.projectID)]; ok {
			deviceID = project.DeviceID
			workspacePath = project.WorkspacePath
		} else if project, ok := h.daemonWorkspaceProjectByIDLocked(ac.userID, ac.projectID); ok {
			deviceID = project.DeviceID
			workspacePath = project.WorkspacePath
		}
	}
	dc := h.daemons[daemonKey(ac.userID, deviceID)]
	h.mu.RUnlock()

	if dc == nil {
		sent := 0
		for _, event := range h.taskHistory(ac.userID, ac.taskID) {
			if !ac.enqueue(taskEventEnvelope(event)) {
				return
			}
			sent++
		}
		ac.enqueue(protocol.NewEnvelope(protocol.TypeTaskHistoryReady, "server", protocol.TaskHistoryReady{
			TaskID:    ac.taskID,
			HasEvents: sent > 0,
		}))
		return
	}

	requestID := protocol.NewID("req")
	env := protocol.NewEnvelope(protocol.TypeTaskHistoryGet, "server", protocol.TaskHistoryGet{
		RequestID:     requestID,
		TaskID:        ac.taskID,
		WorkspacePath: workspacePath,
	})
	env.To.TaskID = ac.taskID
	h.mu.Lock()
	h.agentChatHistoryReq[requestID] = agentChatHistoryRequest{requester: ac, deviceID: deviceID, envelope: env}
	h.mu.Unlock()
	if !dc.enqueue(env) {
		h.mu.Lock()
		delete(h.agentChatHistoryReq, requestID)
		h.mu.Unlock()
		sent := 0
		for _, event := range h.taskHistory(ac.userID, ac.taskID) {
			if !ac.enqueue(taskEventEnvelope(event)) {
				return
			}
			sent++
		}
		ac.enqueue(protocol.NewEnvelope(protocol.TypeTaskHistoryReady, "server", protocol.TaskHistoryReady{
			TaskID:    ac.taskID,
			HasEvents: sent > 0,
		}))
	}
}

func (h *Hub) pendingAgentChatHistoryRequests(userID, deviceID string) []protocol.Envelope {
	h.mu.RLock()
	defer h.mu.RUnlock()
	requests := make([]protocol.Envelope, 0)
	for _, request := range h.agentChatHistoryReq {
		if request.requester == nil || request.requester.userID != userID || request.deviceID != deviceID {
			continue
		}
		requests = append(requests, request.envelope)
	}
	return requests
}

func (h *Hub) closeTerminal(userID string, projectID string, terminalID string) {
	key := terminalKey(userID, projectID, terminalID)
	conns := h.terminalSubscribers(key)
	h.termMu.Lock()
	delete(h.terminalConns, key)
	h.termMu.Unlock()
	for _, wc := range conns {
		_ = wc.conn.Close()
	}

	h.mu.RLock()
	project, ok := h.projects[scopedKey(userID, projectID)]
	if !ok {
		project, ok = h.daemonWorkspaceProjectByIDLocked(userID, projectID)
	}
	var dc *daemonConn
	if ok {
		dc = h.daemons[daemonKey(userID, project.DeviceID)]
	}
	h.mu.RUnlock()

	if dc != nil {
		dc.enqueue(protocol.NewEnvelope(protocol.TypeTerminalStreamExit, "server", protocol.TerminalStreamExit{
			ProjectID:    projectID,
			TerminalID:   terminalID,
			CloseSession: true,
		}))
		return
	}
}

func (h *Hub) readDaemonLoop(dc *daemonConn) {
	defer h.disconnectDaemon(dc)

	for {
		msgType, raw, err := dc.conn.ReadMessage()
		if err != nil {
			return
		}
		if msgType == websocket.BinaryMessage {
			streamData, ok, err := protocol.UnmarshalTerminalStreamDataBinary(raw)
			if err != nil {
				log.Printf("daemon %s sent invalid terminal binary frame: %v", dc.deviceID, err)
				continue
			}
			if ok {
				h.forwardTerminalStreamData(dc.userID, streamData)
				continue
			}
		}
		if msgType != websocket.TextMessage && msgType != websocket.BinaryMessage {
			continue
		}
		var env protocol.Envelope
		if err := json.Unmarshal(raw, &env); err != nil {
			log.Printf("daemon %s sent invalid json frame: %v", dc.deviceID, err)
			continue
		}
		h.handleDaemonMessage(dc, env)
	}
}

func (h *Hub) disconnectDaemon(dc *daemonConn) {
	current := false
	var reconciled []protocol.Envelope
	h.mu.Lock()
	if dc.deviceID != "" && h.daemons[daemonKey(dc.userID, dc.deviceID)] == dc {
		reconciled = h.reconcileRunningTasksLocked(dc.userID, dc.deviceID, nil, 0)
		delete(h.daemons, daemonKey(dc.userID, dc.deviceID))
		current = true
		if h.daemonSwitchHook != nil {
			h.daemonSwitchHook("disconnect-current")
		}
	}
	h.mu.Unlock()

	if current {
		// Only the connection that still owns this device may reconcile its
		// active tasks. A replaced connection can finish its read loop after the
		// new daemon has already started another turn.
		h.broadcastReconciled(dc.userID, reconciled)
		h.broadcastToUser(dc.userID, protocol.NewEnvelope("server.state", "server", h.stateView(dc.userID)))
	}
	dc.shutdown()
}

func (h *Hub) handleDaemonMessage(dc *daemonConn, env protocol.Envelope) {
	switch env.Type {
	case protocol.TypeDaemonHello:
		hello, err := protocol.DecodePayload[protocol.DaemonHello](env)
		if err != nil {
			dc.enqueue(serverError("bad_payload", err.Error()))
			return
		}
		dc.deviceID = hello.DeviceID
		dc.deviceName = hostinfo.ResolveDeviceName(hello.DeviceName)
		dc.agent = hello.Agent
		dc.agentLabel = hello.AgentLabel
		dc.agents = hello.Agents
		dc.workspaces = hello.Workspaces
		dc.terminalBinary = hasFeature(hello.Features, protocol.FeatureTerminalBinaryV1)
		dc.directEndpoint = hello.DirectEndpoint
		dc.lastSeen = time.Now()
		h.mu.Lock()
		key := daemonKey(dc.userID, hello.DeviceID)
		old := h.daemons[key]
		var reconciled []protocol.Envelope
		if old != nil && old != dc {
			reconciled = h.reconcileRunningTasksLocked(dc.userID, hello.DeviceID, nil, 0)
		}
		h.daemons[key] = dc
		if old != nil && old != dc && h.daemonSwitchHook != nil {
			h.daemonSwitchHook("replacement")
		}
		h.mu.Unlock()
		if old != nil && old != dc {
			old.shutdown()
			h.broadcastReconciled(dc.userID, reconciled)
		}
		for _, request := range h.pendingAgentChatHistoryRequests(dc.userID, hello.DeviceID) {
			dc.enqueue(request)
		}
		if dc.terminalBinary {
			dc.enqueue(protocol.NewEnvelope(protocol.TypeServerHello, "server", protocol.ServerHello{
				Features: []string{protocol.FeatureTerminalBinaryV1},
			}))
		}
		h.broadcastToUser(dc.userID, protocol.NewEnvelope("server.state", "server", h.stateView(dc.userID)))
	case protocol.TypeDaemonHeartbeat, protocol.TypeDaemonSnapshot:
		dc.lastSeen = time.Now()
		// The daemon's heartbeat carries the authoritative set of task ids it is
		// actually still running (process-level liveness, opcode-style). Use it
		// to clear any task the server still thinks is running but the daemon no
		// longer is — e.g. it died mid-run without a terminal event. A grace
		// window avoids racing a just-dispatched task whose first heartbeat has
		// not landed yet.
		var reconciled []protocol.Envelope
		if hb, err := protocol.DecodePayload[protocol.DaemonHeartbeat](env); err == nil && dc.deviceID != "" {
			running := hb.RunningTaskIDs
			if running == nil {
				running = []string{} // explicit empty: nothing running
			}
			reconciled = h.reconcileRunningTasks(dc.userID, dc.deviceID, running, 20*time.Second)
		}
		h.broadcastReconciled(dc.userID, reconciled)
		h.broadcastToUser(dc.userID, protocol.NewEnvelope("server.state", "server", h.stateView(dc.userID)))
	case protocol.TypeTaskSnapshot:
		snapshot, err := protocol.DecodePayload[protocol.TaskSnapshot](env)
		if err != nil {
			dc.enqueue(serverError("bad_payload", err.Error()))
			return
		}
		snapshotDeviceID := dc.deviceID
		if snapshotDeviceID == "" {
			snapshotDeviceID = snapshot.DeviceID
		}
		if snapshot.DeviceID != "" && snapshotDeviceID != "" && snapshot.DeviceID != snapshotDeviceID {
			return
		}
		h.mu.Lock()
		if current := h.daemons[daemonKey(dc.userID, snapshotDeviceID)]; current != nil && current != dc {
			h.mu.Unlock()
			return
		}
		deletedIDs := make(map[string]struct{}, len(snapshot.DeletedTaskIDs)*2)
		for _, taskID := range snapshot.DeletedTaskIDs {
			canonicalID, removed := h.deleteTaskStateLocked(dc.userID, taskID, snapshotDeviceID)
			if removed {
				deletedIDs[strings.TrimSpace(taskID)] = struct{}{}
				deletedIDs[strings.TrimSpace(canonicalID)] = struct{}{}
			}
		}
		seen := make(map[string]struct{}, len(snapshot.Tasks))
		for _, record := range snapshot.Tasks {
			if taskRecordExplicitlyDeleted(record, deletedIDs) {
				continue
			}
			taskKey := scopedKey(dc.userID, record.TaskID)
			seen[taskKey] = struct{}{}
			h.taskDevices[taskKey] = snapshotDeviceID
			record.DeviceID = snapshotDeviceID
			for _, aliasID := range taskAliasIDs(record) {
				aliasKey := scopedKey(dc.userID, aliasID)
				h.taskAliases[aliasKey] = record.TaskID
				if existing, ok := h.taskRecords[aliasKey]; ok {
					incoming := record
					if len(existing.Events) > 0 {
						record.Events = mergeDaemonTaskRecordEvents(record.Events, existing.Events, record.AgentRuntime)
					}
					record.Status = mergedTaskRecordStatus(existing, incoming, record.Events)
					if existing.UpdatedAt > record.UpdatedAt {
						record.UpdatedAt = existing.UpdatedAt
					}
					if record.ModelID == "" {
						record.ModelID = existing.ModelID
					}
					if record.Prompt == "" {
						record.Prompt = existing.Prompt
					}
				}
				h.taskDevices[aliasKey] = snapshotDeviceID
				seen[aliasKey] = struct{}{}
			}
			if existing, ok := h.taskRecords[taskKey]; ok {
				incoming := record
				if len(existing.Events) > 0 {
					record.Events = mergeDaemonTaskRecordEvents(record.Events, existing.Events, record.AgentRuntime)
				}
				record.Status = mergedTaskRecordStatus(existing, incoming, record.Events)
				if existing.UpdatedAt > record.UpdatedAt {
					record.UpdatedAt = existing.UpdatedAt
				}
				if record.SessionID == "" {
					record.SessionID = existing.SessionID
				}
				if record.ModelID == "" {
					record.ModelID = existing.ModelID
				}
			}
			h.taskRecords[taskKey] = record
		}
		for taskID, deviceID := range h.taskDevices {
			if !strings.HasPrefix(taskID, dc.userID+"\x00") {
				continue
			}
			if deviceID != snapshotDeviceID {
				continue
			}
			if _, ok := seen[taskID]; ok {
				continue
			}
			if canonical := h.taskAliases[taskID]; canonical != "" {
				if _, ok := seen[scopedKey(dc.userID, canonical)]; ok {
					seen[taskID] = struct{}{}
					continue
				}
			}
			existing := h.taskRecords[taskID]
			if isActiveTaskStatus(existing.Status) && existing.UpdatedAt > time.Now().Add(-20*time.Second).Unix() {
				continue
			}
			delete(h.taskDevices, taskID)
			delete(h.taskRecords, taskID)
			delete(h.taskEvents, taskID)
			delete(h.taskAliases, taskID)
		}
		h.mu.Unlock()
		h.broadcastToUser(dc.userID, protocol.NewEnvelope("server.state", "server", h.stateView(dc.userID)))
	case protocol.TypeTaskEvent:
		taskEvent, err := protocol.DecodePayload[protocol.TaskEvent](env)
		forward := env
		shouldForward := true
		if err == nil && taskEvent.TaskID != "" {
			h.mu.Lock()
			taskKey := scopedKey(dc.userID, taskEvent.TaskID)
			if dc.deviceID != "" {
				h.taskDevices[taskKey] = dc.deviceID
			}
			h.taskEvents[taskKey] = append(h.taskEvents[taskKey], env)
			record := h.taskRecords[taskKey]
			record.TaskID = taskEvent.TaskID
			if sessionID := extractSessionID(taskEvent); sessionID != "" {
				record.SessionID = sessionID
			}
			if dc.deviceID != "" {
				record.DeviceID = dc.deviceID
			}
			if modelID := extractModelID(taskEvent); modelID != "" {
				record.ModelID = modelID
			}
			record.Status = statusFromEvent(taskEvent.EventType, record.Status)
			record.UpdatedAt = time.Now().Unix()
			if taskEvent.Timestamp == 0 {
				taskEvent.Timestamp = record.UpdatedAt
			}
			taskEvent.Sequence = nextTaskEventSequence(record.Events, taskEvent.Sequence)
			record.Events, taskEvent, shouldForward = upsertOrAppendTaskRecordEvent(record.Events, taskEvent)
			h.taskRecords[taskKey] = record
			h.mu.Unlock()
			forward = taskEventEnvelope(taskEvent)
		}
		if !shouldForward {
			return
		}
		forward.From = "server"
		h.broadcastToUser(dc.userID, forward)
		if taskEvent.TaskID != "" {
			h.broadcastToTask(dc.userID, taskEvent.TaskID, forward)
		}
	case protocol.TypeTaskHistoryResult:
		result, err := protocol.DecodePayload[protocol.TaskHistoryResult](env)
		if err == nil && result.TaskID != "" {
			eventsToForward := result.Events
			if result.Record != nil {
				h.mu.Lock()
				taskKey := scopedKey(dc.userID, result.TaskID)
				record := *result.Record
				if existing, ok := h.taskRecords[taskKey]; ok {
					incoming := record
					if len(existing.Events) > 0 {
						record.Events = mergeDaemonTaskRecordEvents(record.Events, existing.Events, record.AgentRuntime)
					}
					record.Status = mergedTaskRecordStatus(existing, incoming, record.Events)
					if existing.UpdatedAt > record.UpdatedAt {
						record.UpdatedAt = existing.UpdatedAt
					}
					if record.SessionID == "" {
						record.SessionID = existing.SessionID
					}
					if record.ModelID == "" {
						record.ModelID = existing.ModelID
					}
					if record.Prompt == "" {
						record.Prompt = existing.Prompt
					}
				}
				if dc.deviceID != "" {
					record.DeviceID = dc.deviceID
					h.taskDevices[taskKey] = dc.deviceID
				}
				h.taskRecords[taskKey] = record
				eventsToForward = append([]protocol.TaskEvent(nil), record.Events...)
				h.mu.Unlock()
			}
			h.mu.Lock()
			requester := h.agentChatHistoryReq[result.RequestID].requester
			delete(h.agentChatHistoryReq, result.RequestID)
			h.mu.Unlock()
			for _, event := range eventsToForward {
				forward := taskEventEnvelope(event)
				forward.From = "server"
				if requester != nil {
					requester.tryEnqueue(forward)
				} else {
					h.broadcastToTask(dc.userID, result.TaskID, forward)
				}
			}
			if requester != nil {
				ready := protocol.NewEnvelope(protocol.TypeTaskHistoryReady, "server", protocol.TaskHistoryReady{
					RequestID: result.RequestID,
					TaskID:    result.TaskID,
					HasEvents: len(eventsToForward) > 0,
				})
				requester.tryEnqueue(ready)
			}
		}
	case protocol.TypeTerminalStreamData:
		streamData, err := protocol.DecodePayload[protocol.TerminalStreamData](env)
		if err == nil {
			h.forwardTerminalStreamData(dc.userID, streamData)
		}
	case protocol.TypeTerminalStreamTitle:
		streamTitle, err := protocol.DecodePayload[protocol.TerminalStreamTitle](env)
		if err == nil {
			key := terminalKey(dc.userID, streamTitle.ProjectID, streamTitle.TerminalID)
			for _, wc := range h.terminalSubscribers(key) {
				if err := wc.writeJSON(map[string]string{
					"type":       "title",
					"title":      streamTitle.Title,
					"full_title": streamTitle.FullTitle,
					"command":    streamTitle.Command,
				}); err != nil {
					h.removeTerminalSubscriber(key, wc)
					_ = wc.conn.Close()
				}
			}
		}
	case protocol.TypeTerminalStreamAlert:
		alert, err := protocol.DecodePayload[protocol.TerminalStreamAlert](env)
		if err == nil {
			if enriched, ok := h.enrichTerminalStreamAlert(dc.userID, alert); ok {
				env.Payload, _ = json.Marshal(enriched)
			}
			forward := env
			forward.From = "server"
			h.broadcastToUser(dc.userID, forward)
		}
	case protocol.TypeTerminalStreamExit:
		streamExit, err := protocol.DecodePayload[protocol.TerminalStreamExit](env)
		if err == nil {
			key := terminalKey(dc.userID, streamExit.ProjectID, streamExit.TerminalID)
			conns := h.terminalSubscribers(key)
			h.termMu.Lock()
			delete(h.terminalConns, key)
			h.termMu.Unlock()
			for _, wc := range conns {
				_ = wc.conn.Close()
			}
		}
	case protocol.TypeWorkspaceResult, protocol.TypeTerminalResult, protocol.TypeProjectResult, protocol.TypeDeviceAliasSet:
		if h.resolvePending(dc.userID, env) {
			return
		}
		forward := env
		forward.From = "server"
		h.broadcastToUser(dc.userID, forward)
	case protocol.TypeServerError:
		if h.resolvePending(dc.userID, env) {
			return
		}
		forward := env
		forward.From = "server"
		h.broadcastToUser(dc.userID, forward)
	default:
		log.Printf("daemon %s sent unsupported type %s", dc.deviceID, env.Type)
	}
}

func deviceFeatures(dc *daemonConn) []string {
	features := make([]string, 0, 2)
	if dc.terminalBinary {
		features = append(features, protocol.FeatureTerminalBinaryV1)
	}
	if dc.directEndpoint != nil {
		features = append(features, protocol.FeatureDirectTerminalV1)
	}
	return features
}

func (h *Hub) stateView(userID string) StateView {
	h.mu.RLock()
	defer h.mu.RUnlock()
	devices := make([]DeviceView, 0, len(h.daemons))
	for _, dc := range h.daemons {
		if dc.userID != userID {
			continue
		}
		devices = append(devices, DeviceView{
			ID:         dc.deviceID,
			Name:       dc.deviceName,
			Status:     "online",
			Agent:      dc.agent,
			AgentLabel: dc.agentLabel,
			Agents:     dc.agents,
			LastSeenAt: dc.lastSeen.Unix(),
			Workspaces: dc.workspaces,
			Features:   deviceFeatures(dc),
		})
	}

	tasks := make([]protocol.TaskRecord, 0, len(h.taskRecords))
	prefix := userID + "\x00"
	for key, record := range h.taskRecords {
		if !strings.HasPrefix(key, prefix) {
			continue
		}
		record.Events = nil // Omit events in state view to prevent massive bandwidth usage (since stateView is broadcast on every heartbeat)
		tasks = append(tasks, record)
	}
	sort.Slice(tasks, func(i, j int) bool {
		return tasks[i].UpdatedAt > tasks[j].UpdatedAt
	})
	return StateView{Devices: devices, Tasks: tasks}
}

func (h *Hub) taskHistory(userID string, taskID string) []protocol.TaskEvent {
	h.mu.RLock()
	resolvedTaskID := h.resolveTaskIDLocked(userID, taskID)
	record := h.taskRecords[scopedKey(userID, resolvedTaskID)]
	h.mu.RUnlock()
	if record.TaskID == "" {
		return nil
	}
	events := make([]protocol.TaskEvent, len(record.Events))
	copy(events, record.Events)
	if resolvedTaskID != taskID {
		record.TaskID = taskID
		for idx := range events {
			events[idx].TaskID = taskID
		}
	}
	if strings.TrimSpace(record.Prompt) != "" && !hasUserPromptEvent(events) {
		promptEvent := taskRecordPromptEvent(record)
		insertAt := promptEventInsertIndex(events)
		events = append(events, protocol.TaskEvent{})
		copy(events[insertAt+1:], events[insertAt:])
		events[insertAt] = promptEvent
	}
	return events
}

func hasUserPromptEvent(events []protocol.TaskEvent) bool {
	for _, event := range events {
		if event.EventType == "user.prompt" {
			return true
		}
	}
	return false
}

func taskRecordPromptEvent(record protocol.TaskRecord) protocol.TaskEvent {
	timestamp := record.StartedAt
	if timestamp == 0 {
		timestamp = record.UpdatedAt
	}
	turnID := taskRecordPromptTurnID(record)
	data := map[string]any{"prompt": record.Prompt, "turn_id": turnID}
	return protocol.TaskEvent{
		TaskID:    record.TaskID,
		EventID:   "history-user-prompt-" + record.TaskID,
		EventType: "user.prompt",
		Source:    "server",
		Sequence:  0,
		Timestamp: timestamp,
		Data:      MarshalPayload(data),
	}
}

func taskRecordPromptTurnID(record protocol.TaskRecord) string {
	turnID := ""
	for index := len(record.Events) - 1; index >= 0; index-- {
		event := record.Events[index]
		if event.EventType != "task.started" {
			continue
		}
		turnID = taskEventTurnID(event)
		break
	}
	if turnID == "" {
		turnID = "history-turn-0"
	}
	return turnID
}

func promptEventInsertIndex(events []protocol.TaskEvent) int {
	lastTaskStarted := -1
	for idx, event := range events {
		if event.EventType == "task.started" {
			lastTaskStarted = idx
		}
	}
	if lastTaskStarted >= 0 {
		return lastTaskStarted
	}
	return 0
}

func taskEventEnvelope(event protocol.TaskEvent) protocol.Envelope {
	env := protocol.NewEnvelope(protocol.TypeTaskEvent, "server", event)
	env.To.TaskID = event.TaskID
	return env
}

// reconcileRunningTasks treats the daemon's process-level liveness as the
// source of truth for whether a task is still executing. Any task that the
// server still believes is active (running/stopping/queued) on this device but
// that the daemon no longer reports as running is considered interrupted (the
// daemon restarted, the connection dropped, or the agent process died without
// emitting a terminal event). For each such task we synthesize a `task.failed`
// terminal event so that both live web clients and a freshly reloaded page see
// the task as finished instead of being stuck on "Working" forever.
//
// runningIDs is the authoritative set of task ids the daemon reports as still
// running; pass nil to treat every active task on the device as interrupted
// (used on daemon disconnect / reconnect). graceWindow protects the race where
// a task was just dispatched but the daemon's first heartbeat after it has not
// yet arrived: tasks updated within the window are left alone.
//
// Caller must NOT hold h.mu. Returns the envelopes to broadcast.
func (h *Hub) reconcileRunningTasks(userID, deviceID string, runningIDs []string, graceWindow time.Duration) []protocol.Envelope {
	h.mu.Lock()
	envs := h.reconcileRunningTasksLocked(userID, deviceID, runningIDs, graceWindow)
	h.mu.Unlock()
	return envs
}

// reconcileRunningTasksLocked performs the state transition while the caller
// holds h.mu. Daemon replacement/disconnect uses this to make reconciliation
// and connection ownership changes one indivisible operation with respect to
// task dispatch.
func (h *Hub) reconcileRunningTasksLocked(userID, deviceID string, runningIDs []string, graceWindow time.Duration) []protocol.Envelope {
	if deviceID == "" {
		return nil
	}
	var live map[string]struct{}
	if runningIDs != nil {
		live = make(map[string]struct{}, len(runningIDs))
		for _, id := range runningIDs {
			live[id] = struct{}{}
		}
	}
	now := time.Now().Unix()
	cutoff := now - int64(graceWindow.Seconds())

	var synthesized []protocol.TaskEvent
	for taskKey, record := range h.taskRecords {
		if !strings.HasPrefix(taskKey, userID+"\x00") {
			continue
		}
		if h.taskDevices[taskKey] != deviceID {
			continue
		}
		// Only genuinely-executing tasks can be "interrupted". Statuses like
		// "created"/"queued"/"pending" belong to restored session records the
		// daemon re-advertises on reconnect — they were never running, so
		// reconciling them would spuriously mark history as failed.
		if !isRunningTaskStatus(record.Status) {
			continue
		}
		if live != nil {
			if _, ok := live[record.TaskID]; ok {
				continue // daemon still running it
			}
		}
		if graceWindow > 0 && record.UpdatedAt > cutoff {
			continue // too fresh; daemon may not have reported it yet
		}

		failureData := map[string]any{
			"error":  "task interrupted: daemon no longer running this task",
			"reason": "interrupted",
		}
		if turnID := latestUserPromptTurnID(record.Events); turnID != "" {
			failureData["turn_id"] = turnID
		}
		evt := protocol.TaskEvent{
			TaskID:    record.TaskID,
			EventID:   protocol.NewID("evt"),
			EventType: "task.failed",
			Source:    "server",
			Timestamp: now,
			Data:      MarshalPayload(failureData),
		}
		evt.Sequence = nextTaskEventSequence(record.Events, 0)
		record.Status = statusFromEvent(evt.EventType, record.Status)
		record.UpdatedAt = now
		record.Events = append(record.Events, evt)
		h.taskRecords[taskKey] = record
		h.taskEvents[taskKey] = append(h.taskEvents[taskKey], taskEventEnvelope(evt))
		synthesized = append(synthesized, evt)
	}
	if len(synthesized) == 0 {
		return nil
	}
	envs := make([]protocol.Envelope, 0, len(synthesized))
	for _, evt := range synthesized {
		envs = append(envs, taskEventEnvelope(evt))
	}
	return envs
}

// broadcastReconciled emits the synthesized interruption events to both the
// per-user state stream and the per-task subscribers, then refreshes state.
func (h *Hub) broadcastReconciled(userID string, envs []protocol.Envelope) {
	if len(envs) == 0 {
		return
	}
	for _, env := range envs {
		env.From = "server"
		h.broadcastToUser(userID, env)
		if env.To.TaskID != "" {
			h.broadcastToTask(userID, env.To.TaskID, env)
		}
	}
	h.broadcastToUser(userID, protocol.NewEnvelope("server.state", "server", h.stateView(userID)))
}

func isActiveTaskStatus(status string) bool {
	switch strings.ToLower(status) {
	case "queued", "pending", "running", "stopping", "created":
		return true
	default:
		return false
	}
}

// isRunningTaskStatus reports whether a task is actively executing (has emitted
// task.started and not yet terminated). Unlike isActiveTaskStatus it excludes
// "created"/"queued"/"pending", which are session/queue records that were never
// actually running and must not be reconciled as interrupted.
func isRunningTaskStatus(status string) bool {
	switch strings.ToLower(status) {
	case "running", "stopping":
		return true
	default:
		return false
	}
}

func isTerminalTaskStatus(status string) bool {
	switch strings.ToLower(status) {
	case "completed", "failed", "killed", "cancelled", "stopped", "closed", "interrupted":
		return true
	default:
		return false
	}
}

type taskLifecycleState struct {
	status     string
	turn       int
	hasTurn    bool
	order      int64
	hasOrder   bool
	timestamp  int64
	sequence   int64
	eventIndex int
}

func mergedTaskRecordStatus(existing, incoming protocol.TaskRecord, mergedEvents []protocol.TaskEvent) string {
	merged, hasMerged := latestTaskLifecycleState(mergedEvents)
	existingLifecycle, hasExistingLifecycle := latestTaskLifecycleState(existing.Events)
	incomingLifecycle, hasIncomingLifecycle := latestTaskLifecycleState(incoming.Events)
	if !hasMerged && latestTaskTurnHasPrompt(mergedEvents) {
		if isActiveTaskStatus(existing.Status) {
			return existing.Status
		}
		if isActiveTaskStatus(incoming.Status) {
			return incoming.Status
		}
	}

	if isTerminalTaskStatus(existing.Status) {
		if hasIncomingLifecycle && taskLifecycleStartsNewTurn(incomingLifecycle, existingLifecycle, hasExistingLifecycle, existing.UpdatedAt) {
			if hasMerged {
				return merged.status
			}
			return incoming.Status
		}
		return existing.Status
	}
	if hasMerged {
		return merged.status
	}
	if isRunningTaskStatus(existing.Status) {
		return existing.Status
	}
	if incoming.Status != "" {
		return incoming.Status
	}
	return existing.Status
}

func taskLifecycleStartsNewTurn(incoming, existing taskLifecycleState, hasExisting bool, existingUpdatedAt int64) bool {
	if hasExisting {
		if incoming.hasTurn && existing.hasTurn {
			return incoming.turn > existing.turn
		}
		if incoming.timestamp != existing.timestamp {
			return incoming.timestamp > existing.timestamp
		}
		if incoming.sequence != existing.sequence {
			return incoming.sequence > existing.sequence
		}
		return false
	}
	return incoming.timestamp > 0 && incoming.timestamp > existingUpdatedAt
}

func latestTaskLifecycleState(events []protocol.TaskEvent) (taskLifecycleState, bool) {
	ordered := orderTaskRecordEvents(events)
	turn, hasTurn := latestTaskTurn(ordered)
	var latest taskLifecycleState
	found := false
	for index, event := range ordered {
		status, ok := taskLifecycleStatus(event.EventType)
		if !ok {
			continue
		}
		if hasTurn && !taskEventMatchesTurn(event, index, turn) {
			continue
		}
		state := taskLifecycleState{
			status:     status,
			timestamp:  event.Timestamp,
			sequence:   event.Sequence,
			eventIndex: index,
		}
		state.turn, state.hasTurn = taskEventACPXTurnIndex(event)
		state.order, state.hasOrder = taskEventLogicalSequence(event)
		if !found || taskLifecycleAfter(state, latest) {
			latest = state
			found = true
		}
	}
	return latest, found
}

type taskTurn struct {
	index      int
	hasIndex   bool
	id         string
	startIndex int
	hasPrompt  bool
}

func latestTaskTurn(ordered []protocol.TaskEvent) (taskTurn, bool) {
	maxTurn := -1
	lastExplicitIndex := -1
	for index, event := range ordered {
		if turn, ok := taskEventACPXTurnIndex(event); ok {
			if turn > maxTurn {
				maxTurn = turn
				lastExplicitIndex = index
			} else if turn == maxTurn {
				lastExplicitIndex = index
			}
		}
	}
	if maxTurn >= 0 {
		selected := taskTurn{index: maxTurn, hasIndex: true, startIndex: lastExplicitIndex}
		for index, event := range ordered {
			if event.EventType == "user.prompt" {
				if turn, ok := taskEventACPXTurnIndex(event); ok && turn == maxTurn {
					selected.id = taskEventTurnID(event)
					selected.hasPrompt = true
				}
				if _, ok := taskEventACPXTurnIndex(event); !ok && index > lastExplicitIndex {
					selected = taskTurn{id: taskEventTurnID(event), startIndex: index, hasPrompt: true}
					lastExplicitIndex = index
				}
			}
		}
		return selected, true
	}
	for index := len(ordered) - 1; index >= 0; index-- {
		if ordered[index].EventType == "user.prompt" {
			return taskTurn{id: taskEventTurnID(ordered[index]), startIndex: index, hasPrompt: true}, true
		}
	}
	return taskTurn{}, false
}

func taskEventMatchesTurn(event protocol.TaskEvent, eventIndex int, turn taskTurn) bool {
	if turn.hasIndex {
		if index, ok := taskEventACPXTurnIndex(event); ok {
			return index == turn.index
		}
	}
	if turn.id != "" {
		return taskEventTurnID(event) == turn.id
	}
	return eventIndex >= turn.startIndex
}

func latestTaskTurnHasPrompt(events []protocol.TaskEvent) bool {
	turn, ok := latestTaskTurn(orderTaskRecordEvents(events))
	return ok && turn.hasPrompt
}

func taskLifecycleAfter(left, right taskLifecycleState) bool {
	if left.hasOrder && right.hasOrder && left.order != right.order {
		return left.order > right.order
	}
	if left.timestamp != right.timestamp {
		return left.timestamp > right.timestamp
	}
	if left.sequence != right.sequence {
		return left.sequence > right.sequence
	}
	return left.eventIndex > right.eventIndex
}

func taskLifecycleStatus(eventType string) (string, bool) {
	switch eventType {
	case "task.started":
		return "running", true
	case "task.stopping":
		return "stopping", true
	case "task.completed", "turn.completed":
		return "completed", true
	case "task.failed", "turn.failed", "task.error":
		return "failed", true
	case "task.killed":
		return "killed", true
	case "task.stopped":
		return "stopped", true
	default:
		return "", false
	}
}

func (h *Hub) forwardTerminalStreamData(userID string, streamData protocol.TerminalStreamData) {
	key := terminalKey(userID, streamData.ProjectID, streamData.TerminalID)
	for _, wc := range h.terminalSubscribers(key) {
		if err := wc.writeMessage(websocket.BinaryMessage, streamData.Data); err != nil {
			h.removeTerminalSubscriber(key, wc)
			_ = wc.conn.Close()
		}
	}
}

func (h *Hub) removeTerminalSubscriber(key string, wc *terminalConn) {
	h.termMu.Lock()
	if subscribers := h.terminalConns[key]; subscribers != nil {
		delete(subscribers, wc)
		if len(subscribers) == 0 {
			delete(h.terminalConns, key)
		}
	}
	h.termMu.Unlock()
}

func (wc *terminalConn) writeMessage(messageType int, data []byte) error {
	wc.mu.Lock()
	defer wc.mu.Unlock()
	_ = wc.conn.SetWriteDeadline(time.Now().Add(terminalRelayWriteTimeout))
	err := wc.conn.WriteMessage(messageType, data)
	_ = wc.conn.SetWriteDeadline(time.Time{})
	return err
}

func (wc *terminalConn) writeJSON(value any) error {
	wc.mu.Lock()
	defer wc.mu.Unlock()
	_ = wc.conn.SetWriteDeadline(time.Now().Add(terminalRelayWriteTimeout))
	err := wc.conn.WriteJSON(value)
	_ = wc.conn.SetWriteDeadline(time.Time{})
	return err
}

func (h *Hub) terminalSubscribers(key string) []*terminalConn {
	h.termMu.RLock()
	subscribers := h.terminalConns[key]
	conns := make([]*terminalConn, 0, len(subscribers))
	for wc := range subscribers {
		conns = append(conns, wc)
	}
	h.termMu.RUnlock()
	return conns
}

func (h *Hub) requestDaemon(r *http.Request, messageType string, workspacePath string, requestID string, payload any) (protocol.Envelope, error) {
	return h.requestDaemonForDevice(r, r.URL.Query().Get("device_id"), messageType, workspacePath, requestID, payload)
}

func (h *Hub) requestDaemonForDevice(r *http.Request, deviceID string, messageType string, workspacePath string, requestID string, payload any) (protocol.Envelope, error) {
	userID := auth.UserIDFromContext(r.Context())
	if requestID == "" {
		requestID = protocol.NewID("req")
		switch typed := payload.(type) {
		case protocol.WorkspaceListRequest:
			typed.RequestID = requestID
			payload = typed
		case protocol.WorkspaceReadRequest:
			typed.RequestID = requestID
			payload = typed
		case protocol.WorkspaceWriteRequest:
			typed.RequestID = requestID
			payload = typed
		case protocol.ProjectCreateRequest:
			typed.RequestID = requestID
			payload = typed
		case protocol.DeviceAliasSetRequest:
			typed.RequestID = requestID
			payload = typed
		case protocol.ProjectStateGetRequest:
			typed.RequestID = requestID
			payload = typed
		case protocol.ProjectStateSetRequest:
			typed.RequestID = requestID
			payload = typed
		case protocol.TerminalRunRequest:
			typed.RequestID = requestID
			payload = typed
		}
	}
	h.mu.RLock()
	if deviceID == "" {
		for _, dc := range h.daemons {
			if dc.userID != userID {
				continue
			}
			if workspacePath == "" || daemonHasWorkspace(dc, workspacePath) {
				deviceID = dc.deviceID
				break
			}
		}
	}
	dc := h.daemons[daemonKey(userID, deviceID)]
	h.mu.RUnlock()
	if dc == nil {
		return protocol.Envelope{}, errors.New("target device is offline")
	}
	response := make(chan protocol.Envelope, 1)
	h.mu.Lock()
	h.pending[scopedKey(userID, requestID)] = response
	h.mu.Unlock()
	defer func() {
		h.mu.Lock()
		delete(h.pending, scopedKey(userID, requestID))
		h.mu.Unlock()
	}()
	env := protocol.NewEnvelope(messageType, "server", payload)
	env.To.DeviceID = deviceID
	if !dc.enqueue(env) {
		return protocol.Envelope{}, errors.New("target device is offline")
	}
	select {
	case result := <-response:
		return result, nil
	case <-r.Context().Done():
		return protocol.Envelope{}, r.Context().Err()
	case <-time.After(30 * time.Second):
		return protocol.Envelope{}, errors.New("daemon request timed out")
	}
}

func (h *Hub) resolvePending(userID string, env protocol.Envelope) bool {
	requestID := requestIDFromEnvelope(env)
	if requestID == "" {
		return false
	}
	h.mu.RLock()
	ch := h.pending[scopedKey(userID, requestID)]
	h.mu.RUnlock()
	if ch == nil {
		return false
	}
	select {
	case ch <- env:
	default:
	}
	return true
}

func requestIDFromEnvelope(env protocol.Envelope) string {
	var obj map[string]any
	if err := json.Unmarshal(env.Payload, &obj); err != nil {
		return ""
	}
	requestID, _ := obj["request_id"].(string)
	return requestID
}

func daemonHasWorkspace(dc *daemonConn, workspacePath string) bool {
	for _, workspace := range dc.workspaces {
		if workspace.Path == workspacePath {
			return true
		}
	}
	return false
}

func hasFeature(features []string, target string) bool {
	for _, feature := range features {
		if feature == target {
			return true
		}
	}
	return false
}

func (h *Hub) broadcastToUser(userID string, env protocol.Envelope) {
	h.mu.RLock()
	webs := make([]*webConn, 0, len(h.webs))
	for wc := range h.webs {
		if wc.userID != userID {
			continue
		}
		webs = append(webs, wc)
	}
	h.mu.RUnlock()
	for _, wc := range webs {
		wc.tryEnqueue(env)
	}
}

func (h *Hub) broadcastToTask(userID string, taskID string, env protocol.Envelope) {
	key := scopedKey(userID, taskID)
	h.mu.RLock()
	conns := make([]*agentChatConn, 0, len(h.agentChatConns[key]))
	for conn := range h.agentChatConns[key] {
		conns = append(conns, conn)
	}
	h.mu.RUnlock()
	for _, conn := range conns {
		conn.tryEnqueue(env)
	}
}

func writeLoop(conn *websocket.Conn, ch <-chan protocol.Envelope, done <-chan struct{}, writeMu ...*sync.Mutex) {
	for {
		var env protocol.Envelope
		select {
		case <-done:
			return
		case env = <-ch:
		}
		if len(writeMu) > 0 && writeMu[0] != nil {
			writeMu[0].Lock()
		}
		err := writeEnvelope(conn, env)
		if len(writeMu) > 0 && writeMu[0] != nil {
			writeMu[0].Unlock()
		}
		if err != nil {
			return
		}
	}
}

func writeDaemonLoop(dc *daemonConn) {
	defer dc.shutdown()
	for {
		select {
		case <-dc.done:
			return
		case env := <-dc.send:
			dc.mu.Lock()
			err := writeEnvelope(dc.conn, env)
			dc.mu.Unlock()
			if err != nil {
				return
			}
		}
	}
}

func writeEnvelope(conn *websocket.Conn, env protocol.Envelope) error {
	if env.Version == 0 {
		env.Version = 1
	}
	if env.Timestamp == 0 {
		env.Timestamp = time.Now().Unix()
	}
	if env.ID == "" {
		env.ID = protocol.NewID("msg")
	}
	return conn.WriteJSON(env)
}

func enableTCPNoDelay(conn *websocket.Conn) {
	if tcp, ok := conn.UnderlyingConn().(*net.TCPConn); ok {
		_ = tcp.SetNoDelay(true)
	}
}

func isAgentChatCommandType(messageType string) bool {
	switch messageType {
	case protocol.TypeSessionCreate, protocol.TypeTaskDispatch, protocol.TypeTaskStop, protocol.TypeTaskSetModel, protocol.TypeTaskSetConfigOption, protocol.TypeSessionDelete:
		return true
	default:
		return false
	}
}

func envelopeMatchesTask(env protocol.Envelope, taskID string) bool {
	if env.To.TaskID != "" && env.To.TaskID != taskID {
		return false
	}
	if len(env.Payload) == 0 {
		return true
	}
	var payload struct {
		TaskID string `json:"task_id"`
	}
	if err := json.Unmarshal(env.Payload, &payload); err != nil {
		return true
	}
	return payload.TaskID == "" || payload.TaskID == taskID
}

func serverError(code, message string) protocol.Envelope {
	return protocol.NewEnvelope(protocol.TypeServerError, "server", protocol.ServerError{Code: code, Message: message})
}

func serverErrorForEnvelope(env protocol.Envelope, code, message string) protocol.Envelope {
	err := protocol.ServerError{Code: code, Message: message}
	var obj map[string]any
	if json.Unmarshal(env.Payload, &obj) == nil {
		err.RequestID, _ = obj["request_id"].(string)
		err.TaskID, _ = obj["task_id"].(string)
		err.SessionID, _ = obj["session_id"].(string)
		err.Agent, _ = obj["agent"].(string)
	}
	return protocol.NewEnvelope(protocol.TypeServerError, "server", err)
}

func serverErrorForSessionCreate(session protocol.SessionCreate, code, message string) protocol.Envelope {
	return protocol.NewEnvelope(protocol.TypeServerError, "server", protocol.ServerError{
		Code:      code,
		Message:   message,
		RequestID: session.RequestID,
		TaskID:    session.TaskID,
		Agent:     session.Agent,
	})
}

func serverErrorForTaskDispatch(task protocol.TaskDispatch, code, message string) protocol.Envelope {
	return protocol.NewEnvelope(protocol.TypeServerError, "server", protocol.ServerError{
		Code:      code,
		Message:   message,
		RequestID: task.RequestID,
		TaskID:    task.TaskID,
		SessionID: task.ResumeSessionID,
		Agent:     task.Agent,
	})
}

func serverErrorForTaskStop(stop protocol.TaskStop, code, message string) protocol.Envelope {
	return protocol.NewEnvelope(protocol.TypeServerError, "server", protocol.ServerError{
		Code:      code,
		Message:   message,
		RequestID: stop.RequestID,
		TaskID:    stop.TaskID,
	})
}

func serverErrorForTaskSetModel(change protocol.TaskSetModel, code, message string) protocol.Envelope {
	return protocol.NewEnvelope(protocol.TypeServerError, "server", protocol.ServerError{
		Code:      code,
		Message:   message,
		RequestID: change.RequestID,
		TaskID:    change.TaskID,
	})
}

func serverErrorForTaskSetConfigOption(change protocol.TaskSetConfigOption, code, message string) protocol.Envelope {
	return protocol.NewEnvelope(protocol.TypeServerError, "server", protocol.ServerError{
		Code:      code,
		Message:   message,
		RequestID: change.RequestID,
		TaskID:    change.TaskID,
	})
}

func serverErrorForSessionDelete(remove protocol.SessionDelete, code, message string) protocol.Envelope {
	return protocol.NewEnvelope(protocol.TypeServerError, "server", protocol.ServerError{
		Code:      code,
		Message:   message,
		RequestID: remove.RequestID,
		TaskID:    remove.TaskID,
		Agent:     remove.Agent,
	})
}

func decodeJSON(w http.ResponseWriter, r *http.Request, out any) bool {
	defer r.Body.Close()
	if err := json.NewDecoder(r.Body).Decode(out); err != nil {
		writeJSON(w, http.StatusBadRequest, protocol.ServerError{Code: "bad_payload", Message: err.Error()})
		return false
	}
	return true
}

func writeAPIEnvelope(w http.ResponseWriter, env protocol.Envelope, err error) {
	if err != nil {
		writeJSON(w, http.StatusBadGateway, protocol.ServerError{Code: "daemon_request_failed", Message: err.Error()})
		return
	}
	if len(env.Payload) == 0 {
		writeJSON(w, http.StatusOK, map[string]any{})
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(env.Payload)
}

type projectFileReadResult struct {
	Path     string `json:"path"`
	Name     string `json:"name"`
	Kind     string `json:"kind"`
	Content  string `json:"content,omitempty"`
	DataURL  string `json:"data_url,omitempty"`
	MimeType string `json:"mime_type,omitempty"`
	Size     int64  `json:"size,omitempty"`
	Error    string `json:"error,omitempty"`
}

func writeProjectFileReadEnvelope(w http.ResponseWriter, requestedPath string, env protocol.Envelope, err error) {
	if err != nil {
		writeJSON(w, http.StatusBadGateway, protocol.ServerError{Code: "daemon_request_failed", Message: err.Error()})
		return
	}
	result, decodeErr := protocol.DecodePayload[protocol.WorkspaceResult](env)
	if decodeErr != nil {
		writeJSON(w, http.StatusBadGateway, protocol.ServerError{Code: "bad_daemon_payload", Message: decodeErr.Error()})
		return
	}
	if result.Error != "" {
		writeJSON(w, http.StatusOK, projectFileReadResult{Path: requestedPath, Name: filepath.Base(requestedPath), Error: result.Error})
		return
	}
	path := result.Path
	if path == "" {
		path = requestedPath
	}
	content := []byte(result.Content)
	mimeType := mime.TypeByExtension(strings.ToLower(filepath.Ext(path)))
	if mimeType == "" {
		mimeType = http.DetectContentType(content)
	}
	response := projectFileReadResult{
		Path:     filepath.ToSlash(path),
		Name:     filepath.Base(path),
		Kind:     "text",
		Content:  result.Content,
		MimeType: mimeType,
		Size:     int64(len(content)),
	}
	if strings.HasPrefix(mimeType, "image/") {
		response.Kind = "image"
		response.Content = ""
		response.DataURL = "data:" + mimeType + ";base64," + base64.StdEncoding.EncodeToString(content)
	}
	writeJSON(w, http.StatusOK, response)
}

func writeProjectResult(w http.ResponseWriter, env protocol.Envelope, err error, includeProject bool, onProject func(*Project)) {
	if err != nil {
		writeJSON(w, http.StatusBadGateway, protocol.ServerError{Code: "daemon_request_failed", Message: err.Error()})
		return
	}
	result, decodeErr := protocol.DecodePayload[protocol.ProjectResult](env)
	if decodeErr != nil {
		writeJSON(w, http.StatusBadGateway, protocol.ServerError{Code: "bad_daemon_payload", Message: decodeErr.Error()})
		return
	}
	if result.Error != "" {
		writeJSON(w, http.StatusBadRequest, protocol.ServerError{Code: "project_request_failed", Message: result.Error})
		return
	}
	if includeProject {
		if result.Project == nil {
			writeJSON(w, http.StatusBadGateway, protocol.ServerError{Code: "bad_daemon_payload", Message: "project result is missing project"})
			return
		}
		project := projectFromProtocol(*result.Project)
		if onProject != nil {
			onProject(&project)
		}
		writeJSON(w, http.StatusOK, project)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"success": true})
}

func writeDeviceAliasResult(w http.ResponseWriter, env protocol.Envelope, err error, onResult func(protocol.DeviceAliasResult)) bool {
	if err != nil {
		writeJSON(w, http.StatusBadGateway, protocol.ServerError{Code: "daemon_request_failed", Message: err.Error()})
		return false
	}
	result, decodeErr := protocol.DecodePayload[protocol.DeviceAliasResult](env)
	if decodeErr != nil {
		writeJSON(w, http.StatusBadGateway, protocol.ServerError{Code: "bad_daemon_payload", Message: decodeErr.Error()})
		return false
	}
	if result.Error != "" {
		writeJSON(w, http.StatusBadRequest, protocol.ServerError{Code: "device_alias_failed", Message: result.Error})
		return false
	}
	if onResult != nil {
		onResult(result)
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"success":     true,
		"device_id":   result.DeviceID,
		"device_name": result.DeviceName,
		"alias":       result.Alias,
	})
	return true
}

func writeProjectStateResult(w http.ResponseWriter, env protocol.Envelope, err error, onState func(json.RawMessage)) {
	if err != nil {
		writeJSON(w, http.StatusBadGateway, protocol.ServerError{Code: "daemon_request_failed", Message: err.Error()})
		return
	}
	result, decodeErr := protocol.DecodePayload[protocol.ProjectResult](env)
	if decodeErr != nil {
		writeJSON(w, http.StatusBadGateway, protocol.ServerError{Code: "bad_daemon_payload", Message: decodeErr.Error()})
		return
	}
	if result.Error != "" {
		writeJSON(w, http.StatusBadRequest, protocol.ServerError{Code: "project_request_failed", Message: result.Error})
		return
	}
	if len(result.State) == 0 {
		writeJSON(w, http.StatusOK, defaultStudioState())
		return
	}
	if onState != nil {
		onState(result.State)
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(result.State)
}

func defaultStudioState() map[string]any {
	return map[string]any{
		"layoutTree":      nil,
		"focusedId":       "",
		"newTerminalType": "bash",
	}
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}

func appendBounded[T any](items []T, item T, max int) []T {
	items = append(items, item)
	if len(items) <= max {
		return items
	}
	return append([]T(nil), items[len(items)-max:]...)
}

func nextTaskEventSequence(events []protocol.TaskEvent, requested int64) int64 {
	if requested > 0 && !taskEventSequenceExists(events, requested) {
		return requested
	}
	var maxSequence int64
	for _, event := range events {
		if event.Sequence > maxSequence {
			maxSequence = event.Sequence
		}
	}
	return maxSequence + 1
}

func taskEventSequenceExists(events []protocol.TaskEvent, sequence int64) bool {
	for _, event := range events {
		if event.Sequence == sequence {
			return true
		}
	}
	return false
}

func mergeTaskRecordEvents(base []protocol.TaskEvent, extra []protocol.TaskEvent) []protocol.TaskEvent {
	if len(base) == 0 {
		return orderTaskRecordEvents(append([]protocol.TaskEvent(nil), extra...))
	}
	extra = rebaseACPXEventsAfterBase(base, extra)
	merged := append([]protocol.TaskEvent(nil), base...)
	seen := make(map[string]struct{}, len(merged))
	for _, event := range merged {
		for _, signature := range taskEventSignatures(event) {
			seen[signature] = struct{}{}
		}
	}
	for _, event := range extra {
		signatures := taskEventSignatures(event)
		duplicate := false
		for _, signature := range signatures {
			if _, ok := seen[signature]; ok {
				duplicate = true
				break
			}
		}
		if duplicate {
			if updated, ok := replaceExistingTaskRecordEventByStableKey(merged, event); ok {
				merged = updated
			}
			continue
		}
		merged = append(merged, event)
		for _, signature := range signatures {
			seen[signature] = struct{}{}
		}
	}
	return orderTaskRecordEvents(merged)
}

func mergeDaemonTaskRecordEvents(daemonEvents, serverEvents []protocol.TaskEvent, agentRuntime string) []protocol.TaskEvent {
	return mergeTaskRecordEvents(serverEvents, daemonEvents)
}

func replaceExistingTaskRecordEventByStableKey(events []protocol.TaskEvent, event protocol.TaskEvent) ([]protocol.TaskEvent, bool) {
	if key := taskEventACPXEventKey(event); key != "" {
		for index, existing := range events {
			if taskEventACPXEventKey(existing) != key {
				continue
			}
			replacement, replace := preferredMergedACPXKeyedEvent(existing, event)
			if !replace {
				return events, false
			}
			replacement.EventID = existing.EventID
			replacement.Sequence = existing.Sequence
			replacement.Timestamp = existing.Timestamp
			next := append([]protocol.TaskEvent(nil), events...)
			next[index] = replacement
			return next, true
		}
	}
	return events, false
}

func preferredMergedACPXKeyedEvent(existing, incoming protocol.TaskEvent) (protocol.TaskEvent, bool) {
	if assistantStreamVersionsCompatible(existing, incoming) {
		existingText := taskEventComparableText(existing)
		incomingText := taskEventComparableText(incoming)
		if len(incomingText) > len(existingText) {
			return incoming, true
		}
		return existing, false
	}
	if shouldReplaceACPXKeyedEvent(incoming) {
		return incoming, true
	}
	return existing, false
}

func rebaseACPXEventsAfterBase(base []protocol.TaskEvent, extra []protocol.TaskEvent) []protocol.TaskEvent {
	if len(base) == 0 || len(extra) == 0 {
		return extra
	}
	if !hasACPXEventKeyedEvents(base) || !hasACPXTurnZero(extra) {
		return extra
	}
	if hasSharedACPXEventKey(base, extra) && !hasConflictingSharedACPXEventKey(base, extra) {
		return extra
	}
	offset := maxACPXTurnIndex(base) + 1
	if offset <= 0 {
		return extra
	}
	rebased := make([]protocol.TaskEvent, len(extra))
	for i, event := range extra {
		rebased[i] = rebaseACPXEvent(event, offset)
	}
	return rebased
}

func hasACPXEventKeyedEvents(events []protocol.TaskEvent) bool {
	for _, event := range events {
		if taskEventACPXEventKey(event) != "" {
			return true
		}
	}
	return false
}

func hasACPXTurnZero(events []protocol.TaskEvent) bool {
	for _, event := range events {
		if turnIndex, ok := taskEventACPXTurnIndex(event); ok && turnIndex == 0 {
			return true
		}
	}
	return false
}

func hasSharedACPXEventKey(left []protocol.TaskEvent, right []protocol.TaskEvent) bool {
	keys := make(map[string]struct{})
	for _, event := range left {
		if key := taskEventACPXEventKey(event); key != "" {
			keys[key] = struct{}{}
		}
	}
	for _, event := range right {
		if key := taskEventACPXEventKey(event); key != "" {
			if _, ok := keys[key]; ok {
				return true
			}
		}
	}
	return false
}

func hasConflictingSharedACPXEventKey(left []protocol.TaskEvent, right []protocol.TaskEvent) bool {
	byKey := make(map[string]protocol.TaskEvent)
	for _, event := range left {
		if key := taskEventACPXEventKey(event); key != "" {
			byKey[key] = event
		}
	}
	for _, event := range right {
		key := taskEventACPXEventKey(event)
		if key == "" {
			continue
		}
		existing, ok := byKey[key]
		if !ok {
			continue
		}
		if !sameACPXKeyedEvent(existing, event) {
			return true
		}
	}
	return false
}

func sameACPXKeyedEvent(left protocol.TaskEvent, right protocol.TaskEvent) bool {
	if left.EventType != right.EventType {
		return false
	}
	leftText := taskEventComparableText(left)
	rightText := taskEventComparableText(right)
	if leftText != "" && rightText != "" {
		return leftText == rightText || assistantStreamVersionsCompatible(left, right)
	}
	return true
}

func assistantStreamVersionsCompatible(left protocol.TaskEvent, right protocol.TaskEvent) bool {
	if left.EventType != right.EventType || (left.EventType != "assistant.message" && left.EventType != "assistant.thinking") {
		return false
	}
	leftText := taskEventComparableText(left)
	rightText := taskEventComparableText(right)
	if leftText == "" || rightText == "" {
		return false
	}
	if !taskEventHasAssistantStreamID(left) && !taskEventHasAssistantStreamID(right) {
		return false
	}
	return strings.HasPrefix(leftText, rightText) || strings.HasPrefix(rightText, leftText)
}

func taskEventHasAssistantStreamID(event protocol.TaskEvent) bool {
	data := taskEventDataMap(event)
	return stringFromMap(data, "stream_id", "streamId") != ""
}

func taskEventComparableText(event protocol.TaskEvent) string {
	switch event.EventType {
	case "user.prompt":
		if text := textFieldFromEventJSON(event.Data, "prompt"); text != "" {
			return text
		}
		return textFieldFromEventJSON(event.Raw, "prompt")
	case "assistant.message", "assistant.thinking":
		if text := textFieldFromEventJSON(event.Data, "text", "content"); text != "" {
			return text
		}
		return textFieldFromEventJSON(event.Raw, "text", "content")
	default:
		return ""
	}
}

func textFieldFromEventJSON(raw json.RawMessage, keys ...string) string {
	if len(raw) == 0 {
		return ""
	}
	var data map[string]any
	if err := json.Unmarshal(raw, &data); err != nil {
		return ""
	}
	return strings.Join(strings.Fields(stringFromMap(data, keys...)), " ")
}

func maxACPXTurnIndex(events []protocol.TaskEvent) int {
	maxTurn := -1
	for _, event := range events {
		if turnIndex, ok := taskEventACPXTurnIndex(event); ok && turnIndex > maxTurn {
			maxTurn = turnIndex
		}
	}
	return maxTurn
}

func rebaseACPXEvent(event protocol.TaskEvent, offset int) protocol.TaskEvent {
	for _, target := range []*json.RawMessage{&event.Data, &event.Raw} {
		if target == nil || len(*target) == 0 {
			continue
		}
		var data map[string]any
		if err := json.Unmarshal(*target, &data); err != nil {
			continue
		}
		turnIndex, ok := intFromMap(data, "acpx_turn_index", "acpxTurnIndex")
		if !ok {
			continue
		}
		newTurnIndex := turnIndex + offset
		data["acpx_turn_index"] = newTurnIndex
		if eventKey := stringFromMap(data, "acpx_event_key", "acpxEventKey"); eventKey != "" {
			data["acpx_event_key"] = rebaseACPXEventKey(eventKey, newTurnIndex)
			delete(data, "acpxEventKey")
		}
		if raw, err := json.Marshal(data); err == nil {
			*target = raw
		}
	}
	return event
}

func rebaseACPXEventKey(eventKey string, turnIndex int) string {
	parts := strings.Split(eventKey, ":")
	if len(parts) >= 4 && parts[0] == "turn" {
		parts[1] = strconv.Itoa(turnIndex)
		return strings.Join(parts, ":")
	}
	return eventKey
}

func orderTaskRecordEvents(events []protocol.TaskEvent) []protocol.TaskEvent {
	ordered := append([]protocol.TaskEvent(nil), events...)
	sort.SliceStable(ordered, func(i, j int) bool {
		turnI, hasTurnI := taskEventACPXTurnIndex(ordered[i])
		turnJ, hasTurnJ := taskEventACPXTurnIndex(ordered[j])
		if hasTurnI && hasTurnJ && turnI != turnJ {
			return turnI < turnJ
		}
		if (!hasTurnI && !hasTurnJ) || (hasTurnI && hasTurnJ) {
			orderI, hasOrderI := taskEventLogicalSequence(ordered[i])
			orderJ, hasOrderJ := taskEventLogicalSequence(ordered[j])
			if hasOrderI && hasOrderJ && orderI != orderJ {
				return orderI < orderJ
			}
		}
		if ordered[i].Timestamp != ordered[j].Timestamp {
			if ordered[i].Timestamp == 0 {
				return false
			}
			if ordered[j].Timestamp == 0 {
				return true
			}
			return ordered[i].Timestamp < ordered[j].Timestamp
		}
		if ordered[i].Sequence != ordered[j].Sequence {
			return ordered[i].Sequence < ordered[j].Sequence
		}
		return ordered[i].EventID < ordered[j].EventID
	})
	return ordered
}

func hasTaskEventSignature(events []protocol.TaskEvent, event protocol.TaskEvent) bool {
	if !isContentEvent(event.EventType) {
		for _, existing := range events {
			if existing.EventType == event.EventType && existing.Sequence == event.Sequence {
				return true
			}
		}
		return false
	}
	signatures := taskEventSignatures(event)
	for _, existing := range events {
		existingSignatures := taskEventSignatures(existing)
		for _, signature := range signatures {
			for _, existingSignature := range existingSignatures {
				if signature == existingSignature {
					return true
				}
			}
		}
	}
	return false
}

func upsertOrAppendTaskRecordEvent(events []protocol.TaskEvent, event protocol.TaskEvent) ([]protocol.TaskEvent, protocol.TaskEvent, bool) {
	if event.EventType == "user.prompt" {
		if turnID := taskEventTurnID(event); turnID != "" {
			for _, existing := range events {
				if existing.EventType == "user.prompt" && taskEventTurnID(existing) == turnID {
					return events, existing, false
				}
			}
		}
	}
	if key := taskEventACPXEventKey(event); key != "" && shouldReplaceACPXKeyedEvent(event) {
		for index, existing := range events {
			if taskEventACPXEventKey(existing) != key {
				continue
			}
			event.EventID = existing.EventID
			event.Sequence = existing.Sequence
			event.Timestamp = existing.Timestamp
			next := append([]protocol.TaskEvent(nil), events...)
			next[index] = event
			return next, event, true
		}
	}
	if hasTaskEventSignature(events, event) {
		return events, event, false
	}
	return append(events, event), event, true
}

func shouldReplaceACPXKeyedEvent(event protocol.TaskEvent) bool {
	switch event.EventType {
	case "assistant.message", "assistant.thinking":
		data := taskEventDataMap(event)
		if streamID := stringFromMap(data, "stream_id", "streamId"); streamID == "" {
			return false
		}
		return true
	case "tool.call", "tool.output":
		return true
	default:
		return false
	}
}

func taskEventDataMap(event protocol.TaskEvent) map[string]any {
	for _, raw := range []json.RawMessage{event.Data, event.Raw} {
		if len(raw) == 0 {
			continue
		}
		var data map[string]any
		if err := json.Unmarshal(raw, &data); err == nil {
			return data
		}
	}
	return nil
}

func isContentEvent(eventType string) bool {
	return eventType == "user.prompt" ||
		eventType == "assistant.message" ||
		eventType == "assistant.thinking" ||
		eventType == "tool.call" ||
		eventType == "tool.output"
}

func taskEventSignature(event protocol.TaskEvent) string {
	return taskEventSignatures(event)[0]
}

func taskEventSignatures(event protocol.TaskEvent) []string {
	if event.EventType == "user.prompt" {
		signatures := make([]string, 0, 2)
		if turnID := taskEventTurnID(event); turnID != "" {
			signatures = append(signatures, event.EventType+":turn:"+turnID)
		}
		if eventKey := taskEventACPXEventKey(event); eventKey != "" {
			signatures = append(signatures, "acpx:"+eventKey)
		}
		if len(signatures) > 0 {
			return signatures
		}
		if event.EventID != "" {
			return []string{event.EventType + ":id:" + event.EventID}
		}
	}
	if eventKey := taskEventACPXEventKey(event); eventKey != "" {
		return []string{"acpx:" + eventKey}
	}
	if len(event.Data) > 0 {
		return []string{event.EventType + ":" + string(event.Data)}
	}
	if len(event.Raw) > 0 {
		return []string{event.EventType + ":" + string(event.Raw)}
	}
	return []string{fmt.Sprintf("%s:%d:%s", event.EventType, event.Sequence, event.EventID)}
}

func taskEventACPXEventKey(event protocol.TaskEvent) string {
	for _, raw := range []json.RawMessage{event.Data, event.Raw} {
		if len(raw) == 0 {
			continue
		}
		var data map[string]any
		if err := json.Unmarshal(raw, &data); err != nil {
			continue
		}
		if key := stringFromMap(data, "acpx_event_key", "acpxEventKey"); key != "" {
			return key
		}
	}
	return ""
}

func acpxEventKey(turnIndex int, eventType string, ordinal int) string {
	if turnIndex < 0 {
		turnIndex = 0
	}
	if ordinal < 0 {
		ordinal = 0
	}
	return fmt.Sprintf("turn:%d:%s:%d", turnIndex, eventType, ordinal)
}

func nextACPXTurnIndex(events []protocol.TaskEvent) int {
	maxTurn := -1
	promptCount := 0
	for _, event := range events {
		if turnIndex, ok := taskEventACPXTurnIndex(event); ok && turnIndex > maxTurn {
			maxTurn = turnIndex
		}
		if event.EventType == "user.prompt" {
			promptCount++
		}
	}
	if maxTurn >= 0 {
		return maxTurn + 1
	}
	return promptCount
}

func taskEventACPXTurnIndex(event protocol.TaskEvent) (int, bool) {
	for _, raw := range []json.RawMessage{event.Data, event.Raw} {
		if len(raw) == 0 {
			continue
		}
		var data map[string]any
		if err := json.Unmarshal(raw, &data); err != nil {
			continue
		}
		if turnIndex, ok := intFromMap(data, "acpx_turn_index", "acpxTurnIndex"); ok {
			return turnIndex, true
		}
	}
	return 0, false
}

func taskEventLogicalSequence(event protocol.TaskEvent) (int64, bool) {
	for _, raw := range []json.RawMessage{event.Data, event.Raw} {
		if len(raw) == 0 {
			continue
		}
		var data map[string]any
		if err := json.Unmarshal(raw, &data); err != nil {
			continue
		}
		if sequence, ok := intFromMap(data, "_seq"); ok {
			return int64(sequence), true
		}
	}
	if _, ok := taskEventACPXTurnIndex(event); ok {
		switch event.EventType {
		case "user.prompt":
			if strings.EqualFold(event.Source, "web") {
				return 1, true
			}
		case "task.stopping":
			return 1<<60 - 1, true
		case "task.completed", "turn.completed", "task.failed", "turn.failed", "task.error", "task.killed", "task.stopped":
			return 1 << 60, true
		}
	}
	if event.Sequence > 0 {
		return event.Sequence, true
	}
	return 0, false
}

func intFromMap(source map[string]any, keys ...string) (int, bool) {
	for _, key := range keys {
		switch value := source[key].(type) {
		case int:
			return value, true
		case int64:
			return int(value), true
		case float64:
			return int(value), true
		case json.Number:
			if parsed, err := value.Int64(); err == nil {
				return int(parsed), true
			}
		case string:
			if parsed, err := strconv.Atoi(strings.TrimSpace(value)); err == nil {
				return parsed, true
			}
		}
	}
	return 0, false
}

func taskEventTurnID(event protocol.TaskEvent) string {
	for _, raw := range []json.RawMessage{event.Data, event.Raw} {
		if len(raw) == 0 {
			continue
		}
		var data map[string]any
		if err := json.Unmarshal(raw, &data); err != nil {
			continue
		}
		if turnID := stringFromMap(data, "turn_id", "turnId"); turnID != "" {
			return turnID
		}
	}
	return ""
}

func latestUserPromptTurnID(events []protocol.TaskEvent) string {
	var selected protocol.TaskEvent
	found := false
	for _, event := range events {
		if event.EventType != "user.prompt" || taskEventTurnID(event) == "" {
			continue
		}
		if !found || event.Sequence > selected.Sequence ||
			(event.Sequence == selected.Sequence && event.Timestamp >= selected.Timestamp) {
			selected = event
			found = true
		}
	}
	return taskEventTurnID(selected)
}

func stringFromMap(source map[string]any, keys ...string) string {
	for _, key := range keys {
		if value, ok := source[key].(string); ok && strings.TrimSpace(value) != "" {
			return strings.TrimSpace(value)
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
			return "created"
		}
		return fallback
	}
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

func extractModelID(event protocol.TaskEvent) string {
	for _, raw := range []json.RawMessage{event.Raw, event.Data} {
		if len(raw) == 0 {
			continue
		}
		var obj map[string]any
		if err := json.Unmarshal(raw, &obj); err != nil {
			continue
		}
		for _, key := range []string{"model_id", "modelId"} {
			if modelID, _ := obj[key].(string); modelID != "" {
				return modelID
			}
		}
	}
	return ""
}

func MarshalPayload(v any) json.RawMessage {
	raw, _ := json.Marshal(v)
	return raw
}

func (h *Hub) ServeTerminalWebSocket(w http.ResponseWriter, r *http.Request) {
	userID, ok := h.authenticate(w, r)
	if !ok {
		return
	}
	projID := r.URL.Query().Get("project_id")
	if projID == "" {
		http.Error(w, "project_id is required", http.StatusBadRequest)
		return
	}
	terminalID := r.URL.Query().Get("terminal_id")
	if terminalID == "" {
		terminalID = "default"
	}
	if !safeTerminalIDPattern.MatchString(terminalID) {
		http.Error(w, "invalid terminal_id", http.StatusBadRequest)
		return
	}
	command := r.URL.Query().Get("command")
	initialCols := parseTerminalDimension(r.URL.Query().Get("cols"))
	initialRows := parseTerminalDimension(r.URL.Query().Get("rows"))

	proj, ok := h.projectByID(userID, projID)
	if !ok {
		http.Error(w, "project not found", http.StatusNotFound)
		return
	}
	workspacePath := proj.WorkspacePath
	if customPath := strings.TrimSpace(r.URL.Query().Get("path")); customPath != "" {
		workspacePath = customPath
	}
	deviceID := proj.DeviceID

	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("upgrade terminal websocket: %v", err)
		return
	}
	defer conn.Close()
	enableTCPNoDelay(conn)

	h.mu.RLock()
	dc := h.daemons[daemonKey(userID, deviceID)]
	h.mu.RUnlock()

	if dc == nil {
		_ = conn.WriteJSON(map[string]string{"type": "error", "message": "target device is offline"})
		return
	}

	key := terminalKey(userID, projID, terminalID)
	terminal := &terminalConn{conn: conn}
	h.termMu.Lock()
	replaced := h.terminalConns[key]
	h.terminalConns[key] = map[*terminalConn]struct{}{
		terminal: {},
	}
	h.termMu.Unlock()
	for old := range replaced {
		_ = old.writeJSON(map[string]string{
			"type":   "exit",
			"reason": "kick",
		})
		_ = old.conn.Close()
	}
	defer func() {
		h.termMu.Lock()
		if subscribers := h.terminalConns[key]; subscribers != nil {
			delete(subscribers, terminal)
			if len(subscribers) == 0 {
				delete(h.terminalConns, key)
			}
		}
		h.termMu.Unlock()
	}()

	startPayload := protocol.TerminalStreamStart{
		ProjectID:     projID,
		TerminalID:    terminalID,
		WorkspacePath: workspacePath,
		Command:       command,
		InitialTitle:  initialTerminalTitle(command),
		Cols:          initialCols,
		Rows:          initialRows,
	}
	startEnv := protocol.NewEnvelope(protocol.TypeTerminalStreamStart, "server", startPayload)
	if !dc.writeEnvelopeDirect(startEnv) {
		_ = terminal.writeJSON(map[string]string{"type": "exit", "reason": "device_offline"})
		return
	}
	for {
		msgType, payload, err := conn.ReadMessage()
		if err != nil {
			break
		}
		if msgType == websocket.BinaryMessage || msgType == websocket.TextMessage {
			var controlMsg struct {
				Type         string `json:"type"`
				Cols         uint16 `json:"cols"`
				Rows         uint16 `json:"rows"`
				CloseSession bool   `json:"close_session"`
			}
			if err := json.Unmarshal(payload, &controlMsg); err == nil {
				switch controlMsg.Type {
				case "ping":
					// Heartbeat, keep connection alive without forwarding to shell
					continue
				case "resize":
					resizePayload := protocol.TerminalStreamResize{
						ProjectID:  projID,
						TerminalID: terminalID,
						Cols:       controlMsg.Cols,
						Rows:       controlMsg.Rows,
					}
					if !dc.enqueue(protocol.NewEnvelope(protocol.TypeTerminalStreamResize, "server", resizePayload)) {
						_ = terminal.writeJSON(map[string]string{"type": "exit", "reason": "device_offline"})
						return
					}
					continue
				case "exit":
					exitPayload := protocol.TerminalStreamExit{
						ProjectID:    projID,
						TerminalID:   terminalID,
						CloseSession: controlMsg.CloseSession,
					}
					if !dc.enqueue(protocol.NewEnvelope(protocol.TypeTerminalStreamExit, "server", exitPayload)) {
						_ = terminal.writeJSON(map[string]string{"type": "exit", "reason": "device_offline"})
						return
					}
					continue
				}
			}
			{
				dataPayload := protocol.TerminalStreamData{
					ProjectID:  projID,
					TerminalID: terminalID,
					Data:       payload,
				}
				if dc.terminalBinary {
					frame, err := protocol.MarshalTerminalStreamDataBinary(dataPayload)
					if err != nil {
						if !dc.enqueue(protocol.NewEnvelope(protocol.TypeTerminalStreamData, "server", dataPayload)) {
							_ = terminal.writeJSON(map[string]string{"type": "exit", "reason": "device_offline"})
							return
						}
						continue
					}
					if !dc.writeMessageDirect(websocket.BinaryMessage, frame) {
						_ = terminal.writeJSON(map[string]string{"type": "exit", "reason": "device_offline"})
						return
					}
					continue
				}
				if !dc.enqueue(protocol.NewEnvelope(protocol.TypeTerminalStreamData, "server", dataPayload)) {
					_ = terminal.writeJSON(map[string]string{"type": "exit", "reason": "device_offline"})
					return
				}
			}
		}
	}
}

func parseTerminalDimension(value string) uint16 {
	n, err := strconv.Atoi(value)
	if err != nil || n <= 0 || n > math.MaxUint16 {
		return 0
	}
	return uint16(n)
}

func initialTerminalTitle(command string) string {
	command = strings.TrimSpace(command)
	if command == "" || command == "bash" || command == "zsh" || command == "sh" {
		return "Shell"
	}
	switch {
	case command == "online" || command == "acpx" || strings.HasPrefix(command, "acpx "):
		return "ACPX"
	case strings.Contains(command, "claude"):
		return "Claude Code"
	case strings.Contains(command, "codex"):
		return "Codex"
	case command == "qwen" || strings.HasPrefix(command, "qwen "):
		return "Qwen Code"
	case command == "kimi" || strings.HasPrefix(command, "kimi "):
		return "Kimi"
	case command == "copilot" || strings.HasPrefix(command, "copilot "):
		return "GitHub Copilot"
	case command == "cursor-agent" || strings.HasPrefix(command, "cursor-agent ") || command == "cursor" || strings.HasPrefix(command, "cursor "):
		return "Cursor Agent"
	case strings.Contains(command, "openclaw"):
		return "OpenClaw"
	case strings.Contains(command, "opencode"):
		return "OpenCode"
	case strings.Contains(command, "kilo"):
		return "Kilo Code"
	case command == "pi" || strings.HasPrefix(command, "pi "):
		return "Pi"
	case command == "agy" || strings.Contains(command, "antigravity"):
		return "Antigravity"
	default:
		return command
	}
}
