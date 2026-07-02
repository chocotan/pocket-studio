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
	conn *websocket.Conn
	mu   sync.Mutex
}

var directWebUpgrader = websocket.Upgrader{CheckOrigin: func(r *http.Request) bool { return true }}

const directTerminalWriteTimeout = 2 * time.Second

func (d *Daemon) startDirectWebServer(ctx context.Context) (func(), error) {
	if !d.cfg.DirectWeb.Enabled {
		return func() {}, nil
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/ws/terminal", d.handleDirectTerminalWebSocket)
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
	subscriber := &directTerminalSubscriber{conn: conn}
	d.addDirectTerminalSubscriber(key, subscriber)
	defer d.removeDirectTerminalSubscriber(key, subscriber)

	start := protocol.TerminalStreamStart{
		ProjectID:     projectID,
		TerminalID:    terminalID,
		WorkspacePath: project.WorkspacePath,
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
				d.resizeTerminalStream(protocol.TerminalStreamResize{ProjectID: projectID, TerminalID: terminalID, Cols: control.Cols, Rows: control.Rows})
				continue
			case "exit":
				d.exitTerminalStream(protocol.TerminalStreamExit{ProjectID: projectID, TerminalID: terminalID, CloseSession: control.CloseSession})
				continue
			}
		}
		d.writeTerminalStream(protocol.TerminalStreamData{ProjectID: projectID, TerminalID: terminalID, Data: payload})
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
	u := url.URL{Scheme: "ws", Host: net.JoinHostPort(host, port), Path: "/ws/terminal"}
	return &protocol.DirectEndpoint{TerminalWebSocketURL: u.String(), Token: d.cfg.DirectWeb.Token}
}

func (d *Daemon) projectForDirectTerminal(projectID string) (protocol.Project, bool) {
	d.mu.Lock()
	defer d.mu.Unlock()
	if project, ok := d.projects[projectID]; ok && project.DirectMode {
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

func (d *Daemon) addDirectTerminalSubscriber(key string, subscriber *directTerminalSubscriber) {
	d.termMu.Lock()
	replaced := d.directTerminalConns[key]
	d.directTerminalConns[key] = map[*directTerminalSubscriber]struct{}{
		subscriber: {},
	}
	d.termMu.Unlock()
	for old := range replaced {
		_ = old.writeJSON(map[string]string{
			"type":   "exit",
			"reason": "kick",
		})
		_ = old.conn.Close()
	}
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
