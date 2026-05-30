package main

import (
	"flag"
	"log"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"remote-agent/internal/server"
)

func main() {
	addr := flag.String("addr", ":8080", "HTTP listen address")
	flag.Parse()

	hub := server.NewHub()
	mux := http.NewServeMux()
	if distDir, ok := findWebDist(); ok {
		mux.Handle("/", spaHandler(http.Dir(distDir)))
	} else {
		mux.HandleFunc("/", server.ServeIndex)
	}
	mux.HandleFunc("/ws/web", hub.ServeWebSocket)
	mux.HandleFunc("/ws/daemon", hub.ServeDaemonSocket)
	mux.HandleFunc("/ws/terminal", hub.ServeTerminalWebSocket)
	mux.HandleFunc("/api/", hub.ServeAPI)

	handler := corsMiddleware(mux)
	ln, err := net.Listen("tcp", *addr)
	if err != nil {
		log.Fatal(err)
	}
	log.Printf("PocketStudio server listening on http://%s", ln.Addr().String())
	if err := http.Serve(ln, handler); err != nil {
		log.Fatal(err)
	}
}

func corsMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		origin := r.Header.Get("Origin")
		if allowedOrigin(origin) {
			w.Header().Set("Access-Control-Allow-Origin", origin)
			w.Header().Set("Vary", "Origin")
			w.Header().Set("Access-Control-Allow-Methods", "GET,POST,OPTIONS")
			w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
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
	return strings.HasPrefix(origin, "http://127.0.0.1:") ||
		strings.HasPrefix(origin, "http://localhost:") ||
		strings.HasPrefix(origin, "http://[::1]:")
}

func findWebDist() (string, bool) {
	candidates := []string{filepath.Join("web", "dist")}
	if exe, err := os.Executable(); err == nil {
		dir := filepath.Dir(exe)
		candidates = append(candidates,
			filepath.Join(dir, "..", "web", "dist"),
			filepath.Join(dir, "web", "dist"),
			filepath.Join(dir, "..", "..", "web", "dist"),
			filepath.Join(dir, "..", "resources", "web", "dist"),
			filepath.Join(dir, "..", "..", "resources", "web", "dist"),
		)
	}
	for _, dir := range candidates {
		if _, err := os.Stat(filepath.Join(dir, "index.html")); err == nil {
			return dir, true
		}
	}
	return "", false
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
