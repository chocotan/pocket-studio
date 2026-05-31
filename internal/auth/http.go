package auth

import (
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"
)

type HTTP struct {
	Manager       *Manager
	AllowRegister bool
}

func (h HTTP) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if h.Manager == nil || !h.Manager.Enabled() {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "auth is not enabled"})
		return
	}
	switch {
	case r.URL.Path == "/api/auth/register" && r.Method == http.MethodPost:
		h.register(w, r)
	case r.URL.Path == "/api/auth/login" && r.Method == http.MethodPost:
		h.login(w, r)
	case r.URL.Path == "/api/auth/logout" && r.Method == http.MethodPost:
		h.logout(w, r)
	case r.URL.Path == "/api/auth/me" && r.Method == http.MethodGet:
		h.me(w, r)
	case r.URL.Path == "/api/tokens" && r.Method == http.MethodGet:
		h.listTokens(w, r)
	case r.URL.Path == "/api/tokens" && r.Method == http.MethodPost:
		h.createToken(w, r)
	case r.URL.Path == "/api/tokens/revoke" && r.Method == http.MethodPost:
		h.revokeToken(w, r)
	default:
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "not found"})
	}
}

func (h HTTP) register(w http.ResponseWriter, r *http.Request) {
	if !h.AllowRegister {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "registration is disabled"})
		return
	}
	var req struct {
		Username string `json:"username"`
		Password string `json:"password"`
	}
	if !decodeJSON(w, r, &req) {
		return
	}
	user, err := h.Manager.Register(req.Username, req.Password)
	if errors.Is(err, ErrConflict) {
		writeJSON(w, http.StatusConflict, map[string]string{"error": "username already exists"})
		return
	}
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"user": user})
}

func (h HTTP) login(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Username string `json:"username"`
		Password string `json:"password"`
	}
	if !decodeJSON(w, r, &req) {
		return
	}
	user, sessionToken, err := h.Manager.Login(req.Username, req.Password)
	if errors.Is(err, ErrUnauthorized) {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "invalid username or password"})
		return
	}
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	http.SetCookie(w, sessionCookie(sessionToken, 14*24*time.Hour))
	writeJSON(w, http.StatusOK, map[string]any{"user": user})
}

func (h HTTP) logout(w http.ResponseWriter, r *http.Request) {
	if cookie, err := r.Cookie("pocket_studio_session"); err == nil {
		_ = h.Manager.Logout(cookie.Value)
	}
	http.SetCookie(w, sessionCookie("", -time.Hour))
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (h HTTP) me(w http.ResponseWriter, r *http.Request) {
	userID, err := h.Manager.UserIDFromSession(r)
	if err != nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}
	user, err := h.Manager.CurrentUser(userID)
	if err != nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"user": user})
}

func (h HTTP) listTokens(w http.ResponseWriter, r *http.Request) {
	userID, ok := h.sessionUser(w, r)
	if !ok {
		return
	}
	tokens, err := h.Manager.ListAccessTokens(userID)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"tokens": tokens})
}

func (h HTTP) createToken(w http.ResponseWriter, r *http.Request) {
	userID, ok := h.sessionUser(w, r)
	if !ok {
		return
	}
	var req struct {
		Name string `json:"name"`
	}
	if !decodeJSON(w, r, &req) {
		return
	}
	token, raw, err := h.Manager.CreateAccessToken(userID, req.Name)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"token": token, "secret": raw})
}

func (h HTTP) revokeToken(w http.ResponseWriter, r *http.Request) {
	userID, ok := h.sessionUser(w, r)
	if !ok {
		return
	}
	var req struct {
		ID string `json:"id"`
	}
	if !decodeJSON(w, r, &req) {
		return
	}
	if strings.TrimSpace(req.ID) == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "id is required"})
		return
	}
	if err := h.Manager.RevokeAccessToken(userID, req.ID); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (h HTTP) sessionUser(w http.ResponseWriter, r *http.Request) (string, bool) {
	userID, err := h.Manager.UserIDFromSession(r)
	if err != nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return "", false
	}
	return userID, true
}

func sessionCookie(value string, maxAge time.Duration) *http.Cookie {
	age := int(maxAge / time.Second)
	return &http.Cookie{
		Name:     "pocket_studio_session",
		Value:    value,
		Path:     "/",
		MaxAge:   age,
		HttpOnly: true,
		SameSite: http.SameSiteLaxMode,
		Secure:   false,
	}
}

func decodeJSON(w http.ResponseWriter, r *http.Request, out any) bool {
	defer r.Body.Close()
	if err := json.NewDecoder(r.Body).Decode(out); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return false
	}
	return true
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}
