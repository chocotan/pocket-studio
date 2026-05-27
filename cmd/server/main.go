package main

import (
	"flag"
	"log"
	"net/http"
	"os"
	"path/filepath"

	"remote-agent/internal/server"
)

func main() {
	addr := flag.String("addr", ":8080", "HTTP listen address")
	flag.Parse()

	hub := server.NewHub()
	mux := http.NewServeMux()
	if _, err := os.Stat(filepath.Join("web", "dist", "index.html")); err == nil {
		mux.Handle("/", spaHandler(http.Dir(filepath.Join("web", "dist"))))
	} else {
		mux.HandleFunc("/", server.ServeIndex)
	}
	mux.HandleFunc("/ws/web", hub.ServeWebSocket)
	mux.HandleFunc("/ws/daemon", hub.ServeDaemonSocket)
	mux.HandleFunc("/api/", hub.ServeAPI)

	log.Printf("PocketStudio server listening on http://localhost%s", *addr)
	if err := http.ListenAndServe(*addr, mux); err != nil {
		log.Fatal(err)
	}
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
