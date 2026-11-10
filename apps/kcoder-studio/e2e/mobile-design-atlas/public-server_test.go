package main

import (
	"crypto/pbkdf2"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func testServer(t *testing.T) *atlasServer {
	t.Helper()
	salt := []byte("synthetic-test-salt")
	hash, err := pbkdf2.Key(sha256.New, "review-test-password", salt, passwordIterations, 32)
	if err != nil {
		t.Fatal(err)
	}
	c := authConfig{base64.RawURLEncoding.EncodeToString(make([]byte, 32)), hex.EncodeToString(salt), hex.EncodeToString(hash), "https://design.example.test:8451", "/fixtures/mobile-design-atlas-v1"}
	root := t.TempDir()
	if err = os.WriteFile(filepath.Join(root, "index.html"), []byte("PRIVATE_ATLAS_CONTENT"), 0600); err != nil {
		t.Fatal(err)
	}
	if err = os.Mkdir(filepath.Join(root, "images"), 0700); err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(filepath.Join(root, "images", "test.png"), []byte("private-image"), 0600); err != nil {
		t.Fatal(err)
	}
	s, err := newAtlasServer(root, c)
	if err != nil {
		t.Fatal(err)
	}
	return s
}
func request(s *atlasServer, method, path, body string, cookie *http.Cookie, origin string) *httptest.ResponseRecorder {
	r := httptest.NewRequest(method, s.config.Origin+s.config.Prefix+path, strings.NewReader(body))
	if cookie != nil {
		r.AddCookie(cookie)
	}
	if origin != "" {
		r.Header.Set("Origin", origin)
	}
	w := httptest.NewRecorder()
	s.ServeHTTP(w, r)
	return w
}
func TestEncryptedTokenBoundaries(t *testing.T) {
	s := testServer(t)
	token, err := seal(s.config, "link", time.Now().Add(time.Hour))
	if err != nil {
		t.Fatal(err)
	}
	if !s.validToken(token, "link") {
		t.Fatal("valid encrypted link rejected")
	}
	if s.validToken(token, "session") {
		t.Fatal("link cannot be a session cookie")
	}
	raw, _ := base64.RawURLEncoding.DecodeString(token)
	raw[len(raw)-1] ^= 1
	if s.validToken(base64.RawURLEncoding.EncodeToString(raw), "link") {
		t.Fatal("tampered ciphertext accepted")
	}
	expired, _ := seal(s.config, "link", time.Now().Add(-time.Hour))
	if s.validToken(expired, "link") {
		t.Fatal("expired token accepted")
	}
	other := s.config
	other.Prefix += "-other"
	wrongAudience, _ := seal(other, "link", time.Now().Add(time.Hour))
	if s.validToken(wrongAudience, "link") {
		t.Fatal("cross-mount token accepted")
	}
}
func TestEveryAssetRequiresSession(t *testing.T) {
	s := testServer(t)
	for _, path := range []string{"/", "/index.html", "/images/test.png", "/catalog.json", "/kcoder-design-atlas-v1.zip"} {
		w := request(s, http.MethodGet, path, "", nil, "")
		if w.Code != http.StatusUnauthorized || strings.Contains(w.Body.String(), "PRIVATE_ATLAS_CONTENT") {
			t.Fatalf("unauthorized asset leaked: %s (%d)", path, w.Code)
		}
	}
	w := request(s, http.MethodGet, "/", "", nil, "")
	if !strings.Contains(w.Body.String(), "const base=\"/fixtures/mobile-design-atlas-v1\";") {
		t.Fatal("root login must retain its exact mount")
	}
}
func TestPasswordLoginAndCookieScope(t *testing.T) {
	s := testServer(t)
	if request(s, http.MethodPost, "/session", `{"password":"wrong"}`, nil, s.config.Origin).Code != 401 {
		t.Fatal("wrong password accepted")
	}
	w := request(s, http.MethodPost, "/session", `{"password":"review-test-password"}`, nil, s.config.Origin)
	if w.Code != 200 {
		t.Fatalf("password login failed: %d", w.Code)
	}
	cookies := w.Result().Cookies()
	if len(cookies) != 1 {
		t.Fatal("session cookie missing")
	}
	c := cookies[0]
	if !c.Secure || !c.HttpOnly || c.SameSite != http.SameSiteStrictMode || c.Path != s.config.Prefix+"/" {
		t.Fatal("cookie scope or flags incorrect")
	}
	if !s.validToken(c.Value, "session") {
		t.Fatal("invalid session cookie")
	}
	if request(s, http.MethodGet, "/images/test.png", "", c, "").Code != 200 {
		t.Fatal("authorized image not served")
	}
	if request(s, http.MethodGet, "/../../auth.json", "", c, "").Code != 404 {
		t.Fatal("path traversal was not rejected")
	}
}
func TestEncryptedLoginAndOriginFence(t *testing.T) {
	s := testServer(t)
	token, _ := seal(s.config, "link", time.Now().Add(time.Hour))
	body := `{"token":"` + token + `"}`
	if request(s, http.MethodPost, "/session", body, nil, "https://other.example.test").Code != 403 {
		t.Fatal("cross-origin login accepted")
	}
	w := request(s, http.MethodPost, "/session", body, nil, s.config.Origin)
	if w.Code != 200 || len(w.Result().Cookies()) != 1 {
		t.Fatal("encrypted one-click login failed")
	}
	if strings.Contains(w.Body.String(), token) {
		t.Fatal("login echoed encrypted credential")
	}
}
func TestSymlinksAreNotPublished(t *testing.T) {
	s := testServer(t)
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "index.html"), []byte("index"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink("/etc/passwd", filepath.Join(root, "leak.txt")); err != nil {
		t.Fatal(err)
	}
	if _, err := newAtlasServer(root, s.config); err == nil {
		t.Fatal("symlink accepted into published atlas")
	}
}
