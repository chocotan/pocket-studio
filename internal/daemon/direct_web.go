package daemon

import (
	"context"
	"encoding/json"
	"errors"
	"log"
	"math"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"

	"remote-agent/internal/hostinfo"
	"remote-agent/internal/protocol"
)

type directTerminalSubscriber struct {
	conn     *websocket.Conn
	clientID string
	mu       sync.Mutex
}

type directAgentChatSubscriber struct {
	conn *websocket.Conn
	mu   sync.Mutex
}

var directWebUpgrader = websocket.Upgrader{CheckOrigin: func(r *http.Request) bool { return true }}

const directTerminalWriteTimeout = 2 * time.Second
const directAgentChatWriteTimeout = 2 * time.Second

func (d *Daemon) startDirectWebServer(ctx context.Context) (func(), error) {
	if !d.cfg.DirectWeb.Enabled {
		return func() {}, nil
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/ws/terminal", d.handleDirectTerminalWebSocket)
	mux.HandleFunc("/ws/agent", d.handleDirectAgentChatWebSocket)
	listener, err := net.Listen("tcp", d.cfg.DirectWeb.ListenAddr)
	if err != nil {
		return nil, err
	}
	server := &http.Server{Handler: mux}
	go func() {
		<-ctx.Done()
		_ = server.Close()
	}()
	go func() {
		if err := server.Serve(listener); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Printf("direct web server: %v", err)
		}
	}()
	return func() { _ = server.Close() }, nil
}

func (d *Daemon) handleDirectTerminalWebSocket(w http.ResponseWriter, r *http.Request) {
	if !d.cfg.DirectWeb.Enabled {
		http.Error(w, "direct websocket disabled", http.StatusNotFound)
		return
	}
	projectID := strings.TrimSpace(r.URL.Query().Get("project_id"))
	if projectID == "" {
		http.Error(w, "project_id is required", http.StatusBadRequest)
		return
	}
	if !protocol.VerifyDirectTerminalToken(d.cfg.DirectWeb.Token, projectID, r.URL.Query().Get("token"), time.Now()) {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	terminalID := strings.TrimSpace(r.URL.Query().Get("terminal_id"))
	if terminalID == "" {
		terminalID = "default"
	}
	if !safeTerminalID(terminalID) {
		http.Error(w, "invalid terminal_id", http.StatusBadRequest)
		return
	}
	project, ok := d.projectForDirectTerminal(projectID)
	if !ok {
		http.Error(w, "project not found", http.StatusNotFound)
		return
	}
	conn, err := directWebUpgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("upgrade direct terminal websocket: %v", err)
		return
	}
	defer conn.Close()
	enableTCPNoDelay(conn)

	key := terminalKey(projectID, terminalID)
	clientID := protocol.NewID("term-client")
	subscriber := &directTerminalSubscriber{conn: conn, clientID: clientID}
	d.addDirectTerminalSubscriber(key, subscriber)
	defer func() {
		d.removeDirectTerminalSubscriber(key, subscriber)
		d.exitTerminalStream(protocol.TerminalStreamExit{ProjectID: projectID, TerminalID: terminalID, ClientID: clientID})
	}()

	workspacePath := project.WorkspacePath
	if customPath := strings.TrimSpace(r.URL.Query().Get("path")); customPath != "" {
		workspacePath = customPath
	}

	start := protocol.TerminalStreamStart{
		ProjectID:     projectID,
		TerminalID:    terminalID,
		ClientID:      clientID,
		WorkspacePath: workspacePath,
		Command:       r.URL.Query().Get("command"),
		InitialTitle:  initialTerminalTitle(r.URL.Query().Get("command"), ""),
		Cols:          parseDirectTerminalDimension(r.URL.Query().Get("cols")),
		Rows:          parseDirectTerminalDimension(r.URL.Query().Get("rows")),
	}
	// A direct browser socket is only one subscriber. Do not bind the PTY/title
	// watcher lifetime to this request context, otherwise a transient browser
	// reconnect would stop backend title updates for the still-running PTY.
	go d.startTerminalStream(context.Background(), start)

	for {
		msgType, payload, err := conn.ReadMessage()
		if err != nil {
			break
		}
		if msgType != websocket.BinaryMessage && msgType != websocket.TextMessage {
			continue
		}
		var control struct {
			Type         string `json:"type"`
			Cols         uint16 `json:"cols"`
			Rows         uint16 `json:"rows"`
			CloseSession bool   `json:"close_session"`
		}
		if err := json.Unmarshal(payload, &control); err == nil {
			switch control.Type {
			case "ping":
				// Heartbeat to keep connection alive
				continue
			case "resize":
				d.resizeTerminalStream(protocol.TerminalStreamResize{ProjectID: projectID, TerminalID: terminalID, ClientID: clientID, Cols: control.Cols, Rows: control.Rows})
				continue
			case "exit":
				d.exitTerminalStream(protocol.TerminalStreamExit{ProjectID: projectID, TerminalID: terminalID, ClientID: clientID, CloseSession: control.CloseSession})
				continue
			}
		}
		d.writeTerminalStream(protocol.TerminalStreamData{ProjectID: projectID, TerminalID: terminalID, ClientID: clientID, Data: payload})
	}
}

func (d *Daemon) handleDirectAgentChatWebSocket(w http.ResponseWriter, r *http.Request) {
	if !d.cfg.DirectWeb.Enabled {
		http.Error(w, "direct websocket disabled", http.StatusNotFound)
		return
	}
	projectID := strings.TrimSpace(r.URL.Query().Get("project_id"))
	if projectID == "" {
		http.Error(w, "project_id is required", http.StatusBadRequest)
		return
	}
	if !protocol.VerifyDirectTerminalToken(d.cfg.DirectWeb.Token, projectID, r.URL.Query().Get("token"), time.Now()) {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	taskID := strings.TrimSpace(r.URL.Query().Get("task_id"))
	if taskID == "" {
		http.Error(w, "task_id is required", http.StatusBadRequest)
		return
	}
	if !safeTerminalID(taskID) {
		http.Error(w, "invalid task_id", http.StatusBadRequest)
		return
	}
	project, ok := d.projectForDirectTerminal(projectID)
	if !ok {
		http.Error(w, "project not found", http.StatusNotFound)
		return
	}
	conn, err := directWebUpgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("upgrade direct agent chat websocket: %v", err)
		return
	}
	defer conn.Close()
	enableTCPNoDelay(conn)

	key := directAgentChatKey(projectID, taskID)
	subscriber := &directAgentChatSubscriber{conn: conn}
	d.addDirectAgentChatSubscriber(projectID, taskID, subscriber)
	defer d.removeDirectAgentChatSubscriber(key, subscriber)

	historyEvents := d.sendDirectTaskHistory(subscriber, taskID, project.WorkspacePath)
	_ = subscriber.writeEnvelope(protocol.NewEnvelope(protocol.TypeTaskHistoryReady, "daemon", protocol.TaskHistoryReady{
		TaskID:    taskID,
		HasEvents: historyEvents > 0,
	}))

	for {
		var env protocol.Envelope
		if err := conn.ReadJSON(&env); err != nil {
			break
		}
		if env.From == "" {
			env.From = "web"
		}
		if env.Type == "ping" {
			_ = subscriber.writeEnvelope(protocol.NewEnvelope("pong", "daemon", nil))
			continue
		}
		if !isDirectAgentChatCommandType(env.Type) {
			_ = subscriber.writeEnvelope(directServerError("unsupported_type", "unsupported agent chat websocket message type", env.ID))
			continue
		}
		if !envelopeMatchesDirectTask(env, taskID) {
			_ = subscriber.writeEnvelope(directServerError("task_mismatch", "message task_id does not match websocket task_id", env.ID))
			continue
		}
		if env.To.DeviceID == "" {
			env.To.DeviceID = d.cfg.Device.ID
		}
		if !d.handleDirectAgentChatEnvelope(env) {
			_ = subscriber.writeEnvelope(directServerError("bad_payload", "invalid agent chat websocket message payload", env.ID))
		}
	}
}

func (d *Daemon) directEndpoint() *protocol.DirectEndpoint {
	if !d.cfg.DirectWeb.Enabled {
		return nil
	}
	host := strings.TrimSpace(d.cfg.DirectWeb.PublicHost)
	if hostinfo.IsUnreportableHost(host) {
		log.Printf("direct web public host %q is a container/bridge address; falling back to reachable LAN IP", host)
		host = ""
	}
	if host == "" {
		host = hostinfo.ReachableIPv4()
	}
	if host == "" {
		return nil
	}
	_, port, err := net.SplitHostPort(d.cfg.DirectWeb.ListenAddr)
	if err != nil || port == "" {
		trimmed := strings.TrimPrefix(d.cfg.DirectWeb.ListenAddr, ":")
		if _, err := strconv.Atoi(trimmed); err == nil {
			port = trimmed
		}
	}
	if port == "" {
		return nil
	}
	terminalURL := url.URL{Scheme: "ws", Host: net.JoinHostPort(host, port), Path: "/ws/terminal"}
	return &protocol.DirectEndpoint{TerminalWebSocketURL: terminalURL.String(), Token: d.cfg.DirectWeb.Token}
}

func (d *Daemon) projectForDirectTerminal(projectID string) (protocol.Project, bool) {
	d.mu.Lock()
	defer d.mu.Unlock()
	if project, ok := d.projects[projectID]; ok {
		return project, true
	}
	return protocol.Project{}, false
}

func parseDirectTerminalDimension(value string) uint16 {
	n, err := strconv.Atoi(value)
	if err != nil || n <= 0 || n > math.MaxUint16 {
		return 0
	}
	return uint16(n)
}

func safeTerminalID(id string) bool {
	if id == "" || len(id) > 96 {
		return false
	}
	for _, r := range id {
		if r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' || r == '_' || r == '-' {
			continue
		}
		return false
	}
	return true
}

func terminalKey(projectID string, terminalID string) string {
	return projectID + "::" + terminalID
}

func directAgentChatKey(projectID string, taskID string) string {
	return projectID + "::" + taskID
}

func (d *Daemon) addDirectAgentChatSubscriber(projectID string, taskID string, subscriber *directAgentChatSubscriber) {
	key := directAgentChatKey(projectID, taskID)
	d.termMu.Lock()
	if d.directAgentChatConns[key] == nil {
		d.directAgentChatConns[key] = make(map[*directAgentChatSubscriber]struct{})
	}
	d.directAgentChatConns[key][subscriber] = struct{}{}
	d.directAgentChatProjects[taskID] = projectID
	d.termMu.Unlock()
}

func (d *Daemon) removeDirectAgentChatSubscriber(key string, subscriber *directAgentChatSubscriber) {
	d.termMu.Lock()
	if subscribers := d.directAgentChatConns[key]; subscribers != nil {
		delete(subscribers, subscriber)
		if len(subscribers) == 0 {
			delete(d.directAgentChatConns, key)
			if _, taskID, ok := splitDirectAgentChatKey(key); ok {
				delete(d.directAgentChatProjects, taskID)
			}
		}
	}
	d.termMu.Unlock()
}

func splitDirectAgentChatKey(key string) (string, string, bool) {
	before, after, ok := strings.Cut(key, "::")
	if !ok || before == "" || after == "" {
		return "", "", false
	}
	return before, after, true
}

func (d *Daemon) directAgentChatSubscribers(projectID string, taskID string) []*directAgentChatSubscriber {
	d.termMu.Lock()
	defer d.termMu.Unlock()
	subscribers := d.directAgentChatConns[directAgentChatKey(projectID, taskID)]
	out := make([]*directAgentChatSubscriber, 0, len(subscribers))
	for subscriber := range subscribers {
		out = append(out, subscriber)
	}
	return out
}

func (d *Daemon) broadcastDirectAgentChatEvent(event protocol.TaskEvent) {
	if event.TaskID == "" {
		return
	}
	projectID := d.projectIDForDirectAgentChatTask(event.TaskID)
	if projectID == "" {
		return
	}
	env := protocol.NewEnvelope(protocol.TypeTaskEvent, "daemon", event)
	for _, subscriber := range d.directAgentChatSubscribers(projectID, event.TaskID) {
		if err := subscriber.writeEnvelope(env); err != nil {
			d.removeDirectAgentChatSubscriber(directAgentChatKey(projectID, event.TaskID), subscriber)
			_ = subscriber.conn.Close()
		}
	}
}

func (d *Daemon) broadcastDirectAgentChatEnvelope(taskID string, env protocol.Envelope) {
	if taskID == "" {
		return
	}
	projectID := d.projectIDForDirectAgentChatTask(taskID)
	if projectID == "" {
		return
	}
	for _, subscriber := range d.directAgentChatSubscribers(projectID, taskID) {
		if err := subscriber.writeEnvelope(env); err != nil {
			d.removeDirectAgentChatSubscriber(directAgentChatKey(projectID, taskID), subscriber)
			_ = subscriber.conn.Close()
		}
	}
}

func (d *Daemon) projectIDForDirectAgentChatTask(taskID string) string {
	d.termMu.Lock()
	projectID := d.directAgentChatProjects[taskID]
	d.termMu.Unlock()
	if projectID != "" {
		return projectID
	}
	return d.projectIDForTask(taskID)
}

func (d *Daemon) projectIDForTask(taskID string) string {
	d.mu.Lock()
	record := d.history[taskID]
	d.mu.Unlock()
	if record.WorkspacePath == "" {
		return ""
	}
	return d.projectIDForWorkspacePath(record.WorkspacePath)
}

func (d *Daemon) sendDirectTaskHistory(subscriber *directAgentChatSubscriber, taskID string, workspacePath string) int {
	record := d.taskHistoryForRequest(taskID, workspacePath)
	if record.TaskID == "" {
		return 0
	}
	record.TaskID = taskID
	for i := range record.Events {
		record.Events[i].TaskID = taskID
	}
	sent := 0
	for _, event := range normalizedTaskHistoryEvents(record) {
		if err := subscriber.writeEnvelope(protocol.NewEnvelope(protocol.TypeTaskEvent, "daemon", event)); err != nil {
			return sent
		}
		sent++
	}
	return sent
}

func (d *Daemon) handleDirectAgentChatEnvelope(env protocol.Envelope) bool {
	switch env.Type {
	case protocol.TypeSessionList:
		request, err := protocol.DecodePayload[protocol.SessionListRequest](env)
		if err != nil {
			return false
		}
		go d.listDirectACPSessions(context.Background(), request)
	case protocol.TypeSessionCreate:
		session, err := protocol.DecodePayload[protocol.SessionCreate](env)
		if err != nil {
			return false
		}
		go d.createSession(context.Background(), session)
	case protocol.TypeTaskDispatch:
		task, err := protocol.DecodePayload[protocol.TaskDispatch](env)
		if err != nil {
			return false
		}
		go d.startTask(context.Background(), task)
	case protocol.TypeTaskStop:
		stop, err := protocol.DecodePayload[protocol.TaskStop](env)
		if err != nil {
			return false
		}
		go d.stopTask(stop.TaskID)
	case protocol.TypeTaskSetModel:
		change, err := protocol.DecodePayload[protocol.TaskSetModel](env)
		if err != nil {
			return false
		}
		go d.setTaskModel(context.Background(), change)
	case protocol.TypeTaskSetConfigOption:
		change, err := protocol.DecodePayload[protocol.TaskSetConfigOption](env)
		if err != nil {
			return false
		}
		go d.setTaskConfigOption(context.Background(), change)
	case protocol.TypeSessionDelete:
		remove, err := protocol.DecodePayload[protocol.SessionDelete](env)
		if err != nil {
			return false
		}
		go d.deleteSession(context.Background(), remove)
	default:
		return false
	}
	return true
}

func isDirectAgentChatCommandType(messageType string) bool {
	switch messageType {
	case protocol.TypeSessionList, protocol.TypeSessionCreate, protocol.TypeTaskDispatch, protocol.TypeTaskStop, protocol.TypeTaskSetModel, protocol.TypeTaskSetConfigOption, protocol.TypeSessionDelete:
		return true
	default:
		return false
	}
}

func envelopeMatchesDirectTask(env protocol.Envelope, taskID string) bool {
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

func directServerError(code, message string, requestID string) protocol.Envelope {
	return protocol.NewEnvelope(protocol.TypeServerError, "daemon", protocol.ServerError{Code: code, Message: message, RequestID: requestID})
}

func (d *Daemon) addDirectTerminalSubscriber(key string, subscriber *directTerminalSubscriber) {
	d.termMu.Lock()
	if d.directTerminalConns[key] == nil {
		d.directTerminalConns[key] = make(map[*directTerminalSubscriber]struct{})
	}
	d.directTerminalConns[key][subscriber] = struct{}{}
	d.termMu.Unlock()
}

func (d *Daemon) removeDirectTerminalSubscriber(key string, subscriber *directTerminalSubscriber) {
	d.termMu.Lock()
	if subscribers := d.directTerminalConns[key]; subscribers != nil {
		delete(subscribers, subscriber)
		if len(subscribers) == 0 {
			delete(d.directTerminalConns, key)
		}
	}
	d.termMu.Unlock()
}

func (d *Daemon) directTerminalSubscribers(key string) []*directTerminalSubscriber {
	d.termMu.Lock()
	subscribers := d.directTerminalConns[key]
	out := make([]*directTerminalSubscriber, 0, len(subscribers))
	for subscriber := range subscribers {
		out = append(out, subscriber)
	}
	d.termMu.Unlock()
	return out
}

func (d *Daemon) broadcastDirectTerminalData(data protocol.TerminalStreamData) {
	key := terminalKey(data.ProjectID, data.TerminalID)
	for _, subscriber := range d.directTerminalSubscribers(key) {
		if data.ClientID != "" && subscriber.clientID != data.ClientID {
			continue
		}
		if err := subscriber.writeMessage(websocket.BinaryMessage, data.Data); err != nil {
			d.removeDirectTerminalSubscriber(key, subscriber)
			_ = subscriber.conn.Close()
		}
	}
}

func (d *Daemon) broadcastDirectTerminalTitle(title protocol.TerminalStreamTitle) {
	key := terminalKey(title.ProjectID, title.TerminalID)
	msg := map[string]string{"type": "title", "title": title.Title, "full_title": title.FullTitle, "command": title.Command}
	for _, subscriber := range d.directTerminalSubscribers(key) {
		if err := subscriber.writeJSON(msg); err != nil {
			d.removeDirectTerminalSubscriber(key, subscriber)
			_ = subscriber.conn.Close()
		}
	}
}

func (d *Daemon) broadcastDirectTerminalExit(exit protocol.TerminalStreamExit) {
	key := terminalKey(exit.ProjectID, exit.TerminalID)
	for _, subscriber := range d.directTerminalSubscribers(key) {
		if exit.ClientID != "" && subscriber.clientID != exit.ClientID {
			continue
		}
		_ = subscriber.writeJSON(map[string]string{"type": "exit"})
		_ = subscriber.conn.Close()
		d.removeDirectTerminalSubscriber(key, subscriber)
	}
}

func (s *directTerminalSubscriber) writeMessage(messageType int, data []byte) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	_ = s.conn.SetWriteDeadline(time.Now().Add(directTerminalWriteTimeout))
	err := s.conn.WriteMessage(messageType, data)
	_ = s.conn.SetWriteDeadline(time.Time{})
	return err
}

func (s *directTerminalSubscriber) writeJSON(value any) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	_ = s.conn.SetWriteDeadline(time.Now().Add(directTerminalWriteTimeout))
	err := s.conn.WriteJSON(value)
	_ = s.conn.SetWriteDeadline(time.Time{})
	return err
}

func (s *directAgentChatSubscriber) writeEnvelope(env protocol.Envelope) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	_ = s.conn.SetWriteDeadline(time.Now().Add(directAgentChatWriteTimeout))
	err := writeEnvelope(s.conn, env)
	_ = s.conn.SetWriteDeadline(time.Time{})
	return err
}
