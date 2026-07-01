package protocol

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"fmt"
	"strconv"
	"strings"
	"time"
)

const directTerminalTokenVersion = "v1"

func NewDirectTerminalToken(secret string, projectID string, expiresAt time.Time) string {
	secret = strings.TrimSpace(secret)
	projectID = strings.TrimSpace(projectID)
	if secret == "" || projectID == "" || expiresAt.IsZero() {
		return ""
	}
	expiry := expiresAt.Unix()
	payload := directTerminalTokenPayload(projectID, expiry)
	mac := hmac.New(sha256.New, []byte(secret))
	_, _ = mac.Write([]byte(payload))
	sig := base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
	return fmt.Sprintf("%s:%d:%s", directTerminalTokenVersion, expiry, sig)
}

func VerifyDirectTerminalToken(secret string, projectID string, token string, now time.Time) bool {
	secret = strings.TrimSpace(secret)
	projectID = strings.TrimSpace(projectID)
	token = strings.TrimSpace(token)
	if secret == "" || projectID == "" || token == "" {
		return false
	}
	parts := strings.Split(token, ":")
	if len(parts) != 3 || parts[0] != directTerminalTokenVersion {
		return false
	}
	expiry, err := strconv.ParseInt(parts[1], 10, 64)
	if err != nil || expiry <= 0 {
		return false
	}
	if now.IsZero() {
		now = time.Now()
	}
	if now.Unix() > expiry {
		return false
	}
	expected := NewDirectTerminalToken(secret, projectID, time.Unix(expiry, 0))
	return hmac.Equal([]byte(expected), []byte(token))
}

func directTerminalTokenPayload(projectID string, expiry int64) string {
	return strings.TrimSpace(projectID) + "\n" + strconv.FormatInt(expiry, 10)
}
