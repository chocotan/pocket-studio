package main

import (
	"embed"
	"flag"
	"io/fs"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"

	"remote-agent/internal/auth"
	"remote-agent/internal/server"
)

//go:embed embedded/studio
var embeddedStudio embed.FS

//go:embed embedded/user
var embeddedUser embed.FS

type serverConfig struct {
	addr              string
	adminToken        string
	authEnabled       bool
	authDB            string
	authAllowRegister bool
}

func main() {
	cfg := serverConfig{}
	flag.StringVar(&cfg.addr, "server.addr", ":8080", "HTTP listen address")
	flag.StringVar(&cfg.adminToken, "server.admin-token", "", "admin token for open/admin mode")
	flag.BoolVar(&cfg.authEnabled, "server.auth.enabled", false, "enable user registration/login and token auth")
	flag.StringVar(&cfg.authDB, "server.auth.db", defaultAuthDBPath(), "auth sqlite database path")
	flag.BoolVar(&cfg.authAllowRegister, "server.auth.allow-register", true, "allow user registration when auth is enabled")
	flag.Parse()

	authManager, err := newAuthManager(cfg)
	if err != nil {
		log.Fatal(err)
	}
	defer authManager.Close()

	hub := server.NewHub(authManager)
	mux := http.NewServeMux()
	if studioFS, ok := findWebDist(); ok {
		mux.Handle("/studio/", http.StripPrefix("/studio", spaHandler(studioFS)))
	} else {
		log.Fatal("studio-frontend/dist not found; run `cd studio-frontend && npm run build` before starting the server")
	}
	if userFS, ok := findUserWebDist(); ok {
		mux.Handle("/user/", http.StripPrefix("/user", spaHandler(userFS)))
		mux.Handle("/", spaHandler(userFS))
	}
	authHTTP := auth.HTTP{Manager: authManager, AllowRegister: cfg.authAllowRegister}
	mux.Handle("/api/auth/", authHTTP)
	mux.Handle("/api/tokens", authHTTP)
	mux.Handle("/api/tokens/", authHTTP)
	mux.HandleFunc("/ws/web", hub.ServeWebSocket)
	mux.HandleFunc("/ws/daemon", hub.ServeDaemonSocket)
	mux.HandleFunc("/ws/acpx", hub.ServeACPXWebSocket)
	mux.HandleFunc("/ws/terminal", hub.ServeTerminalWebSocket)
	mux.HandleFunc("/api/", hub.ServeAPI)

	handler := corsMiddleware(mux)
	ln, err := net.Listen("tcp", cfg.addr)
	if err != nil {
		log.Fatal(err)
	}
	log.Printf("PocketStudio server listening on http://%s", ln.Addr().String())
	if err := http.Serve(ln, handler); err != nil {
		log.Fatal(err)
	}
}

func newAuthManager(cfg serverConfig) (*auth.Manager, error) {
	if cfg.authEnabled {
		return auth.NewSQLite(cfg.authDB, cfg.adminToken)
	}
	return auth.NewOpen(cfg.adminToken), nil
}

func defaultAuthDBPath() string {
	if dir := strings.TrimSpace(os.Getenv("POCKET_STUDIO_AUTH_DIR")); dir != "" {
		return filepath.Join(dir, "server-auth.sqlite")
	}
	if dir := strings.TrimSpace(os.Getenv("POCKET_STUDIO_CONFIG_DIR")); dir != "" {
		return filepath.Join(dir, "server-auth.sqlite")
	}
	if dir, err := os.UserConfigDir(); err == nil && dir != "" {
		return filepath.Join(dir, "pocket-studio", "server-auth.sqlite")
	}
	if home, err := os.UserHomeDir(); err == nil && home != "" {
		return filepath.Join(home, ".config", "pocket-studio", "server-auth.sqlite")
	}
	return filepath.Join(".pocket-studio", "server-auth.sqlite")
}

func corsMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		origin := r.Header.Get("Origin")
		if allowedOrigin(origin) {
			w.Header().Set("Access-Control-Allow-Origin", origin)
			w.Header().Set("Vary", "Origin")
			w.Header().Set("Access-Control-Allow-Methods", "GET,POST,OPTIONS")
			w.Header().Set("Access-Control-Allow-Headers", "Content-Type,Authorization")
			w.Header().Set("Access-Control-Allow-Credentials", "true")
		}
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func allowedOrigin(origin string) bool {
	if origin == "" {
		return false
	}
	if origin == "pocket-studio://app" {
		return true
	}
	u, err := url.Parse(origin)
	if err != nil {
		return false
	}
	if u.Scheme != "http" && u.Scheme != "https" {
		return false
	}
	host := u.Hostname()
	if host == "localhost" {
		return true
	}
	ip := net.ParseIP(host)
	if ip == nil {
		return false
	}
	return ip.IsLoopback() || ip.IsPrivate()
}

func findUserWebDist() (http.FileSystem, bool) {
	if embedded, ok := embeddedWebFS(embeddedUser, "embedded/user"); ok {
		return embedded, true
	}
	candidates := []string{filepath.Join("user-frontend", "dist")}
	if exe, err := os.Executable(); err == nil {
		dir := filepath.Dir(exe)
		candidates = append(candidates,
			filepath.Join(dir, "..", "user-ui", "dist"),
			filepath.Join(dir, "user-ui", "dist"),
			filepath.Join(dir, "..", "..", "user-ui", "dist"),
			filepath.Join(dir, "..", "resources", "user-ui", "dist"),
			filepath.Join(dir, "..", "..", "resources", "user-ui", "dist"),
		)
	}
	for _, dir := range candidates {
		if _, err := os.Stat(filepath.Join(dir, "index.html")); err == nil {
			return http.Dir(dir), true
		}
	}
	return nil, false
}

func findWebDist() (http.FileSystem, bool) {
	if embedded, ok := embeddedWebFS(embeddedStudio, "embedded/studio"); ok {
		return embedded, true
	}
	candidates := []string{filepath.Join("studio-frontend", "dist")}
	if exe, err := os.Executable(); err == nil {
		dir := filepath.Dir(exe)
		candidates = append(candidates,
			filepath.Join(dir, "..", "ui", "dist"),
			filepath.Join(dir, "ui", "dist"),
			filepath.Join(dir, "..", "..", "ui", "dist"),
			filepath.Join(dir, "..", "resources", "ui", "dist"),
			filepath.Join(dir, "..", "..", "resources", "ui", "dist"),
		)
	}
	for _, dir := range candidates {
		if _, err := os.Stat(filepath.Join(dir, "index.html")); err == nil {
			return http.Dir(dir), true
		}
	}
	return nil, false
}

func embeddedWebFS(root embed.FS, dir string) (http.FileSystem, bool) {
	if _, err := root.Open(filepath.ToSlash(filepath.Join(dir, "index.html"))); err != nil {
		return nil, false
	}
	sub, err := fs.Sub(root, filepath.ToSlash(dir))
	if err != nil {
		return nil, false
	}
	return http.FS(sub), true
}

func spaHandler(root http.FileSystem) http.Handler {
	fileServer := http.FileServer(root)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/" {
			fileServer.ServeHTTP(w, r)
			return
		}
		path := filepath.Clean(r.URL.Path)
		if file, err := root.Open(path); err == nil {
			_ = file.Close()
			fileServer.ServeHTTP(w, r)
			return
		}
		r.URL.Path = "/"
		fileServer.ServeHTTP(w, r)
	})
}
