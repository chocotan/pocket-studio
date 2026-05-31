package auth

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	_ "github.com/mattn/go-sqlite3"
	"golang.org/x/crypto/bcrypt"
)

const (
	OwnerAdmin = "admin"
	ContextKey = contextKey("auth_user_id")
)

type contextKey string

type Mode struct {
	Enabled    bool
	AdminToken string
}

type Manager struct {
	mode Mode
	db   *sql.DB
}

type User struct {
	ID        string `json:"id"`
	Username  string `json:"username"`
	CreatedAt int64  `json:"created_at"`
}

type Token struct {
	ID         string `json:"id"`
	UserID     string `json:"user_id"`
	Name       string `json:"name"`
	Prefix     string `json:"prefix"`
	Value      string `json:"value,omitempty"`
	CreatedAt  int64  `json:"created_at"`
	LastUsedAt int64  `json:"last_used_at,omitempty"`
	RevokedAt  int64  `json:"revoked_at,omitempty"`
}

type Session struct {
	ID        string
	UserID    string
	ExpiresAt int64
}

func NewOpen(adminToken string) *Manager {
	return &Manager{mode: Mode{Enabled: false, AdminToken: strings.TrimSpace(adminToken)}}
}

func NewSQLite(dbPath string, adminToken string) (*Manager, error) {
	if err := os.MkdirAll(filepath.Dir(dbPath), 0o755); err != nil {
		return nil, err
	}
	db, err := sql.Open("sqlite3", dbPath+"?_foreign_keys=on&_busy_timeout=5000")
	if err != nil {
		return nil, err
	}
	manager := &Manager{mode: Mode{Enabled: true, AdminToken: strings.TrimSpace(adminToken)}, db: db}
	if err := manager.migrate(); err != nil {
		_ = db.Close()
		return nil, err
	}
	return manager, nil
}

func (m *Manager) Close() error {
	if m == nil || m.db == nil {
		return nil
	}
	return m.db.Close()
}

func (m *Manager) Enabled() bool {
	return m != nil && m.mode.Enabled
}

func (m *Manager) AuthenticateRequest(r *http.Request) (string, error) {
	return m.AuthenticateToken(extractBearerToken(r))
}

func (m *Manager) AuthenticateToken(token string) (string, error) {
	token = strings.TrimSpace(token)
	if m == nil {
		return OwnerAdmin, nil
	}
	if !m.mode.Enabled {
		if m.mode.AdminToken == "" || token == m.mode.AdminToken {
			return OwnerAdmin, nil
		}
		return "", ErrUnauthorized
	}
	if m.mode.AdminToken != "" && token == m.mode.AdminToken {
		return OwnerAdmin, nil
	}
	if token == "" {
		return "", ErrUnauthorized
	}
	return m.userIDForAccessToken(token)
}

func (m *Manager) UserIDFromSession(r *http.Request) (string, error) {
	if m == nil || !m.mode.Enabled {
		return OwnerAdmin, nil
	}
	cookie, err := r.Cookie("pocket_studio_session")
	if err != nil || cookie.Value == "" {
		return "", ErrUnauthorized
	}
	return m.userIDForSession(cookie.Value)
}

func UserIDFromContext(ctx context.Context) string {
	if userID, _ := ctx.Value(ContextKey).(string); userID != "" {
		return userID
	}
	return OwnerAdmin
}

func WithUserID(ctx context.Context, userID string) context.Context {
	if strings.TrimSpace(userID) == "" {
		userID = OwnerAdmin
	}
	return context.WithValue(ctx, ContextKey, userID)
}

func TokenFromRequest(r *http.Request) string {
	return extractBearerToken(r)
}

var (
	ErrUnauthorized = errors.New("unauthorized")
	ErrConflict     = errors.New("conflict")
)

func extractBearerToken(r *http.Request) string {
	if r == nil {
		return ""
	}
	authz := strings.TrimSpace(r.Header.Get("Authorization"))
	if strings.HasPrefix(strings.ToLower(authz), "bearer ") {
		return strings.TrimSpace(authz[len("bearer "):])
	}
	return strings.TrimSpace(r.URL.Query().Get("token"))
}

func (m *Manager) migrate() error {
	statements := []string{
		`CREATE TABLE IF NOT EXISTS users (
			id TEXT PRIMARY KEY,
			username TEXT NOT NULL UNIQUE,
			password_hash TEXT NOT NULL,
			created_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL
		)`,
		`CREATE TABLE IF NOT EXISTS tokens (
			id TEXT PRIMARY KEY,
			user_id TEXT NOT NULL,
			name TEXT NOT NULL,
			token_hash TEXT NOT NULL UNIQUE,
			token_prefix TEXT NOT NULL,
			token_value TEXT,
			created_at INTEGER NOT NULL,
			last_used_at INTEGER,
			revoked_at INTEGER,
			FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
		)`,
		`CREATE INDEX IF NOT EXISTS idx_tokens_user ON tokens(user_id)`,
		`CREATE TABLE IF NOT EXISTS sessions (
			id TEXT PRIMARY KEY,
			user_id TEXT NOT NULL,
			session_hash TEXT NOT NULL UNIQUE,
			created_at INTEGER NOT NULL,
			expires_at INTEGER NOT NULL,
			FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
		)`,
		`CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id)`,
	}
	for _, statement := range statements {
		if _, err := m.db.Exec(statement); err != nil {
			return err
		}
	}
	if err := m.ensureColumn("tokens", "token_value", "TEXT"); err != nil {
		return err
	}
	return nil
}

func (m *Manager) ensureColumn(table string, column string, columnType string) error {
	rows, err := m.db.Query(`PRAGMA table_info(` + table + `)`)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var cid int
		var name string
		var typ string
		var notNull int
		var defaultValue any
		var pk int
		if err := rows.Scan(&cid, &name, &typ, &notNull, &defaultValue, &pk); err != nil {
			return err
		}
		if name == column {
			return nil
		}
	}
	if err := rows.Err(); err != nil {
		return err
	}
	_, err = m.db.Exec(`ALTER TABLE ` + table + ` ADD COLUMN ` + column + ` ` + columnType)
	return err
}

func (m *Manager) Register(username string, password string) (User, error) {
	username = normalizeUsername(username)
	if username == "" || len(password) < 8 {
		return User{}, fmt.Errorf("username and password of at least 8 chars are required")
	}
	hash, err := bcrypt.GenerateFromPassword([]byte(password), bcrypt.DefaultCost)
	if err != nil {
		return User{}, err
	}
	now := time.Now().Unix()
	user := User{ID: newID("usr"), Username: username, CreatedAt: now}
	_, err = m.db.Exec(
		`INSERT INTO users (id, username, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
		user.ID, user.Username, string(hash), now, now,
	)
	if isUniqueErr(err) {
		return User{}, ErrConflict
	}
	return user, err
}

func (m *Manager) Login(username string, password string) (User, string, error) {
	username = normalizeUsername(username)
	var user User
	var passwordHash string
	err := m.db.QueryRow(`SELECT id, username, created_at, password_hash FROM users WHERE username = ?`, username).
		Scan(&user.ID, &user.Username, &user.CreatedAt, &passwordHash)
	if errors.Is(err, sql.ErrNoRows) {
		return User{}, "", ErrUnauthorized
	}
	if err != nil {
		return User{}, "", err
	}
	if bcrypt.CompareHashAndPassword([]byte(passwordHash), []byte(password)) != nil {
		return User{}, "", ErrUnauthorized
	}
	sessionToken, err := randomToken("pss")
	if err != nil {
		return User{}, "", err
	}
	now := time.Now().Unix()
	_, err = m.db.Exec(
		`INSERT INTO sessions (id, user_id, session_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?)`,
		newID("ses"), user.ID, hashSecret(sessionToken), now, now+int64((14*24*time.Hour)/time.Second),
	)
	return user, sessionToken, err
}

func (m *Manager) CurrentUser(userID string) (User, error) {
	var user User
	err := m.db.QueryRow(`SELECT id, username, created_at FROM users WHERE id = ?`, userID).
		Scan(&user.ID, &user.Username, &user.CreatedAt)
	return user, err
}

func (m *Manager) Logout(sessionToken string) error {
	sessionToken = strings.TrimSpace(sessionToken)
	if sessionToken == "" {
		return nil
	}
	_, err := m.db.Exec(`DELETE FROM sessions WHERE session_hash = ?`, hashSecret(sessionToken))
	return err
}

func (m *Manager) CreateAccessToken(userID string, name string) (Token, string, error) {
	name = strings.TrimSpace(name)
	if name == "" {
		name = "Token"
	}
	rawToken, err := randomToken("ps")
	if err != nil {
		return Token{}, "", err
	}
	now := time.Now().Unix()
	token := Token{
		ID:        newID("tok"),
		UserID:    userID,
		Name:      name,
		Prefix:    tokenPrefix(rawToken),
		Value:     rawToken,
		CreatedAt: now,
	}
	_, err = m.db.Exec(
		`INSERT INTO tokens (id, user_id, name, token_hash, token_prefix, token_value, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
		token.ID, token.UserID, token.Name, hashSecret(rawToken), token.Prefix, rawToken, now,
	)
	return token, rawToken, err
}

func (m *Manager) ListAccessTokens(userID string) ([]Token, error) {
	rows, err := m.db.Query(
		`SELECT id, user_id, name, token_prefix, COALESCE(token_value, ''), created_at, COALESCE(last_used_at, 0), COALESCE(revoked_at, 0)
		 FROM tokens WHERE user_id = ? ORDER BY created_at DESC`,
		userID,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var tokens []Token
	for rows.Next() {
		var token Token
		if err := rows.Scan(&token.ID, &token.UserID, &token.Name, &token.Prefix, &token.Value, &token.CreatedAt, &token.LastUsedAt, &token.RevokedAt); err != nil {
			return nil, err
		}
		tokens = append(tokens, token)
	}
	return tokens, rows.Err()
}

func (m *Manager) RevokeAccessToken(userID string, tokenID string) error {
	_, err := m.db.Exec(`UPDATE tokens SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL`, time.Now().Unix(), tokenID, userID)
	return err
}

func (m *Manager) userIDForAccessToken(token string) (string, error) {
	var tokenID string
	var userID string
	err := m.db.QueryRow(`SELECT id, user_id FROM tokens WHERE token_hash = ? AND revoked_at IS NULL`, hashSecret(token)).
		Scan(&tokenID, &userID)
	if errors.Is(err, sql.ErrNoRows) {
		return "", ErrUnauthorized
	}
	if err != nil {
		return "", err
	}
	_, _ = m.db.Exec(`UPDATE tokens SET last_used_at = ? WHERE id = ?`, time.Now().Unix(), tokenID)
	return userID, nil
}

func (m *Manager) userIDForSession(sessionToken string) (string, error) {
	var session Session
	err := m.db.QueryRow(`SELECT id, user_id, expires_at FROM sessions WHERE session_hash = ?`, hashSecret(sessionToken)).
		Scan(&session.ID, &session.UserID, &session.ExpiresAt)
	if errors.Is(err, sql.ErrNoRows) {
		return "", ErrUnauthorized
	}
	if err != nil {
		return "", err
	}
	if session.ExpiresAt < time.Now().Unix() {
		_, _ = m.db.Exec(`DELETE FROM sessions WHERE id = ?`, session.ID)
		return "", ErrUnauthorized
	}
	return session.UserID, nil
}

func normalizeUsername(username string) string {
	return strings.ToLower(strings.TrimSpace(username))
}

func hashSecret(secret string) string {
	sum := sha256.Sum256([]byte(secret))
	return hex.EncodeToString(sum[:])
}

func randomToken(prefix string) (string, error) {
	raw := make([]byte, 32)
	if _, err := rand.Read(raw); err != nil {
		return "", err
	}
	return prefix + "_" + base64.RawURLEncoding.EncodeToString(raw), nil
}

func newID(prefix string) string {
	raw := make([]byte, 16)
	if _, err := rand.Read(raw); err != nil {
		return fmt.Sprintf("%s_%d", prefix, time.Now().UnixNano())
	}
	return prefix + "_" + base64.RawURLEncoding.EncodeToString(raw)
}

func tokenPrefix(token string) string {
	if len(token) <= 12 {
		return token
	}
	return token[:12]
}

func isUniqueErr(err error) bool {
	return err != nil && strings.Contains(strings.ToLower(err.Error()), "unique")
}
