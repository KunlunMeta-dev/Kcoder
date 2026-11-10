package main

import (
	"bufio"
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/pbkdf2"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"io/fs"
	"log"
	"mime"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"
)

const cookieName = "__Secure-kcoder-design-atlas-v1"
const passwordIterations = 150000

type authConfig struct {
	Key          string `json:"key"`
	Salt         string `json:"salt"`
	PasswordHash string `json:"passwordHash"`
	Origin       string `json:"origin"`
	Prefix       string `json:"prefix"`
}
type claims struct {
	Purpose  string `json:"purpose"`
	Audience string `json:"audience"`
	Expires  int64  `json:"expires"`
}
type asset struct {
	body        []byte
	contentType string
}
type atlasServer struct {
	config authConfig
	aead   cipher.AEAD
	assets map[string]asset
	now    func() time.Time
}

func cryptor(c authConfig) (cipher.AEAD, error) {
	key, err := base64.RawURLEncoding.DecodeString(c.Key)
	if err != nil || len(key) != 32 {
		return nil, errors.New("invalid atlas key")
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	return cipher.NewGCM(block)
}
func seal(c authConfig, purpose string, expires time.Time) (string, error) {
	aead, err := cryptor(c)
	if err != nil {
		return "", err
	}
	nonce := make([]byte, aead.NonceSize())
	if _, err = rand.Read(nonce); err != nil {
		return "", err
	}
	plain, err := json.Marshal(claims{purpose, c.Prefix, expires.Unix()})
	if err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(aead.Seal(nonce, nonce, plain, []byte(c.Prefix))), nil
}
func (s *atlasServer) validToken(token, purpose string) bool {
	if len(token) > 2048 {
		return false
	}
	raw, err := base64.RawURLEncoding.DecodeString(token)
	if err != nil || len(raw) < s.aead.NonceSize()+s.aead.Overhead() {
		return false
	}
	plain, err := s.aead.Open(nil, raw[:s.aead.NonceSize()], raw[s.aead.NonceSize():], []byte(s.config.Prefix))
	if err != nil {
		return false
	}
	var payload claims
	return json.Unmarshal(plain, &payload) == nil && payload.Purpose == purpose && payload.Audience == s.config.Prefix && payload.Expires > s.now().Unix()
}
func (s *atlasServer) validPassword(password string) bool {
	if len(password) == 0 || len(password) > 128 {
		return false
	}
	salt, err := hex.DecodeString(s.config.Salt)
	if err != nil {
		return false
	}
	want, err := hex.DecodeString(s.config.PasswordHash)
	if err != nil || len(want) != 32 {
		return false
	}
	got, err := pbkdf2.Key(sha256.New, password, salt, passwordIterations, 32)
	return err == nil && subtle.ConstantTimeCompare(got, want) == 1
}
func newAtlasServer(root string, c authConfig) (*atlasServer, error) {
	parsed, err := url.Parse(c.Origin)
	if err != nil || parsed.Scheme != "https" || parsed.Host == "" || parsed.Path != "" || parsed.User != nil {
		return nil, errors.New("an exact HTTPS origin is required")
	}
	if c.Prefix != "/fixtures/mobile-design-atlas-v1" {
		return nil, errors.New("unexpected atlas mount")
	}
	aead, err := cryptor(c)
	if err != nil {
		return nil, err
	}
	s := &atlasServer{config: c, aead: aead, assets: make(map[string]asset), now: time.Now}
	err = filepath.WalkDir(root, func(path string, d fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if d.Type()&os.ModeSymlink != 0 {
			return errors.New("symlinks are not allowed in the immutable atlas")
		}
		if d.IsDir() {
			return nil
		}
		info, err := d.Info()
		if err != nil {
			return err
		}
		if !info.Mode().IsRegular() {
			return errors.New("non-regular atlas asset")
		}
		rel, err := filepath.Rel(root, path)
		if err != nil {
			return err
		}
		body, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		kind := mime.TypeByExtension(filepath.Ext(path))
		if kind == "" {
			kind = "application/octet-stream"
		}
		if filepath.Ext(path) == ".md" {
			kind = "text/plain; charset=utf-8"
		}
		s.assets["/"+filepath.ToSlash(rel)] = asset{body, kind}
		return nil
	})
	if err != nil {
		return nil, err
	}
	if _, ok := s.assets["/index.html"]; !ok {
		return nil, errors.New("atlas index missing")
	}
	return s, nil
}
func (s *atlasServer) headers(w http.ResponseWriter) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Referrer-Policy", "no-referrer")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("X-Frame-Options", "DENY")
	w.Header().Set("Vary", "Cookie")
	w.Header().Set("Content-Security-Policy", "default-src 'none'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'")
}
func (s *atlasServer) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	s.headers(w)
	if r.URL.Path == s.config.Prefix {
		http.Redirect(w, r, s.config.Prefix+"/", http.StatusSeeOther)
		return
	}
	if !strings.HasPrefix(r.URL.Path, s.config.Prefix+"/") {
		http.NotFound(w, r)
		return
	}
	path := strings.TrimPrefix(r.URL.Path, s.config.Prefix)
	if path == "/session" {
		s.session(w, r)
		return
	}
	if path == "/login" && r.Method == http.MethodGet {
		s.login(w, http.StatusOK)
		return
	}
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	cookie, err := r.Cookie(cookieName)
	if err != nil || !s.validToken(cookie.Value, "session") {
		if path == "/" || path == "/index.html" {
			s.login(w, http.StatusUnauthorized)
		} else {
			http.Error(w, "Authentication required", http.StatusUnauthorized)
		}
		return
	}
	if path == "/" {
		path = "/index.html"
	}
	item, ok := s.assets[path]
	if !ok {
		http.NotFound(w, r)
		return
	}
	w.Header().Set("Content-Type", item.contentType)
	if strings.HasSuffix(path, ".zip") {
		w.Header().Set("Content-Disposition", `attachment; filename="kcoder-design-atlas-v1.zip"`)
	}
	w.Header().Set("Content-Length", fmt.Sprint(len(item.body)))
	if r.Method == http.MethodGet {
		_, _ = w.Write(item.body)
	}
}
func (s *atlasServer) session(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	if r.Header.Get("Origin") != s.config.Origin {
		http.Error(w, "Origin not allowed", http.StatusForbidden)
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, 4096)
	var input struct {
		Token    string `json:"token"`
		Password string `json:"password"`
	}
	if json.NewDecoder(r.Body).Decode(&input) != nil {
		http.Error(w, "Invalid request", http.StatusBadRequest)
		return
	}
	if !s.validToken(input.Token, "link") && !s.validPassword(input.Password) {
		http.Error(w, "口令或链接无效，请重试。", http.StatusUnauthorized)
		return
	}
	expires := s.now().Add(30 * 24 * time.Hour)
	token, err := seal(s.config, "session", expires)
	if err != nil {
		http.Error(w, "Unable to create session", http.StatusInternalServerError)
		return
	}
	http.SetCookie(w, &http.Cookie{Name: cookieName, Value: token, Path: s.config.Prefix + "/", Secure: true, HttpOnly: true, SameSite: http.SameSiteStrictMode, MaxAge: 30 * 24 * 3600, Expires: expires})
	w.Header().Set("Content-Type", "application/json")
	_, _ = io.WriteString(w, `{"ok":true}`)
}
func (s *atlasServer) login(w http.ResponseWriter, status int) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.WriteHeader(status)
	page := `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="icon" href="data:,"><title>KCoder 设计图册 · 登录</title><style>body{font:15px/1.7 system-ui,sans-serif;background:#f4f6fb;color:#263248;display:grid;place-items:center;min-height:95vh;margin:0}main{width:min(340px,82vw);background:white;padding:32px;border:1px solid #e2e7ef;border-radius:16px}small{color:#2858cb;letter-spacing:.12em}h1{font-size:23px;margin:8px 0}p{color:#68758b;font-size:13px}label{display:block;margin:20px 0 6px}input,button{box-sizing:border-box;width:100%;font:inherit;border-radius:9px;padding:11px}input{border:1px solid #cbd5e3}button{border:0;background:#2858cb;color:white;margin-top:14px;cursor:pointer}#status{min-height:24px}</style></head><body><main><small>KCODER / DESIGN ATLAS</small><h1>移动端界面状态图册</h1><p>使用访问口令，或通过带令牌的专用链接进入。</p><form id="form"><label for="password">访问口令</label><input id="password" type="password" autocomplete="current-password" required><button id="submit">打开图册</button></form><p id="status" role="status"></p></main><script>(()=>{const base=__ATLAS_PREFIX__;const status=document.getElementById('status');const button=document.getElementById('submit');async function login(body){button.disabled=true;status.textContent='正在验证访问权限…';try{const r=await fetch(base+'/session',{method:'POST',headers:{'Content-Type':'application/json'},credentials:'same-origin',body:JSON.stringify(body)});if(!r.ok)throw Error('口令或链接无效，请重试。');location.replace(base+'/');}catch(e){status.textContent=e.message;button.disabled=false;}}document.getElementById('form').addEventListener('submit',e=>{e.preventDefault();login({password:document.getElementById('password').value});});const token=new URLSearchParams(location.hash.slice(1)).get('token');if(token){history.replaceState(null,'',location.pathname);login({token});}})();</script></body></html>`
	// Root unauthorized responses use the same login script at the mount itself.
	page = strings.ReplaceAll(page, "__ATLAS_PREFIX__", strconvJSON(s.config.Prefix))
	_, _ = io.WriteString(w, page)
}
func strconvJSON(text string) string { value, _ := json.Marshal(text); return string(value) }

func prepareAuth(path, accessOut, origin, prefix string, days int) error {
	if days < 1 || days > 90 {
		return errors.New("link lifetime must be between 1 and 90 days")
	}
	reader := bufio.NewScanner(io.LimitReader(os.Stdin, 256))
	if !reader.Scan() || reader.Text() == "" {
		return errors.New("access password required on stdin")
	}
	password := reader.Text()
	if len(password) > 128 {
		return errors.New("access password too long")
	}
	key, salt := make([]byte, 32), make([]byte, 16)
	if _, err := rand.Read(key); err != nil {
		return err
	}
	if _, err := rand.Read(salt); err != nil {
		return err
	}
	hash, err := pbkdf2.Key(sha256.New, password, salt, passwordIterations, 32)
	if err != nil {
		return err
	}
	c := authConfig{base64.RawURLEncoding.EncodeToString(key), hex.EncodeToString(salt), hex.EncodeToString(hash), origin, prefix}
	if err = os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return err
	}
	file, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		return err
	}
	if err = json.NewEncoder(file).Encode(c); err != nil {
		_ = file.Close()
		return err
	}
	if err = file.Close(); err != nil {
		return err
	}
	expires := time.Now().Add(time.Duration(days) * 24 * time.Hour)
	token, err := seal(c, "link", expires)
	if err != nil {
		return err
	}
	access := map[string]string{"url": origin + prefix + "/login#token=" + token, "expiresAt": expires.UTC().Format(time.RFC3339)}
	file, err = os.OpenFile(accessOut, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		return err
	}
	defer file.Close()
	return json.NewEncoder(file).Encode(access)
}
func main() {
	root := flag.String("root", "", "immutable atlas directory")
	configPath := flag.String("config", "", "private auth config")
	listen := flag.String("listen", "127.0.0.1:18673", "loopback listener")
	prepare := flag.Bool("prepare-auth", false, "generate private access files; read password from stdin")
	accessOut := flag.String("access-out", "", "private encrypted-link output")
	origin := flag.String("origin", "", "public HTTPS origin")
	prefix := flag.String("prefix", "/fixtures/mobile-design-atlas-v1", "dedicated URL mount")
	days := flag.Int("days", 30, "encrypted-link lifetime")
	flag.Parse()
	if *prepare {
		if err := prepareAuth(*configPath, *accessOut, *origin, *prefix, *days); err != nil {
			log.Fatal(err)
		}
		fmt.Println("Private atlas access files created")
		return
	}
	if !strings.HasPrefix(*listen, "127.0.0.1:") {
		log.Fatal("loopback listener required")
	}
	bytes, err := os.ReadFile(*configPath)
	if err != nil {
		log.Fatal(err)
	}
	var config authConfig
	if err = json.Unmarshal(bytes, &config); err != nil {
		log.Fatal("invalid atlas auth configuration")
	}
	handler, err := newAtlasServer(*root, config)
	if err != nil {
		log.Fatal(err)
	}
	server := &http.Server{Addr: *listen, Handler: handler, ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 10 * time.Second, WriteTimeout: 30 * time.Second, IdleTimeout: 30 * time.Second, MaxHeaderBytes: 16384}
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGINT)
	defer stop()
	go func() {
		<-ctx.Done()
		timeout, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = server.Shutdown(timeout)
	}()
	log.Printf("Dedicated atlas service listening on %s; %d immutable assets", *listen, len(handler.assets))
	if err = server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Fatal(err)
	}
}
