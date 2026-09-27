package daemon

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"regimen/agent/internal/hosts"
	"regimen/agent/internal/paths"
)

const extOrigin = "chrome-extension://abcdefghijklmnopabcdefghijklmnop"

type env struct {
	t     *testing.T
	agent *Agent
	hosts string
	now   int64
}

func setup(t *testing.T, cfg paths.Config) *env {
	t.Helper()
	dir := t.TempDir()
	t.Setenv("REGIMEN_DATA", filepath.Join(dir, "data"))
	hostsFile := filepath.Join(dir, "hosts")
	t.Setenv("REGIMEN_HOSTS", hostsFile)
	if err := os.WriteFile(hostsFile, []byte("127.0.0.1 localhost\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	e := &env{t: t, hosts: hostsFile, now: time.Date(2026, 9, 21, 22, 0, 0, 0, time.Local).UnixMilli()}
	if cfg.PairCode != nil && cfg.PairExpiresAt == 0 {
		cfg.PairExpiresAt = e.now + 30*60_000 // what install and pair give a new code
	}
	if err := paths.WriteJSON("config.json", cfg); err != nil {
		t.Fatal(err)
	}
	e.agent = New()
	e.agent.now = func() int64 { return e.now }
	return e
}

func (e *env) do(method, path, origin, auth, body string) (int, map[string]any) {
	e.t.Helper()
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	req.Host = "127.0.0.1:47621"
	if origin != "" {
		req.Header.Set("Origin", origin)
	}
	if auth != "" {
		req.Header.Set("Authorization", "Bearer "+auth)
	}
	rec := httptest.NewRecorder()
	e.agent.ServeHTTP(rec, req)
	if ct := rec.Header().Get("content-type"); ct != "application/json" {
		e.t.Fatalf("content-type %q", ct)
	}
	var out map[string]any
	b, _ := io.ReadAll(rec.Body)
	_ = json.Unmarshal(b, &out)
	return rec.Code, out
}

func code(s string) *string { return &s }

func (e *env) pairOK(c string) string {
	e.t.Helper()
	status, body := e.do("POST", "/v1/pair", extOrigin, "", `{"code":"`+c+`"}`)
	if status != 200 || body["ok"] != true {
		e.t.Fatalf("pair: %d %v", status, body)
	}
	return body["secret"].(string)
}

const lockedSnapshot = `{"sentAt":%d,"rules":[{"id":"L","name":"Night","mode":"hard","siteIds":["youtube"],"days":[1],"start":1260,"end":1380,"failsafe":false}],"tasks":[],"overrides":[],"focus":{"active":null},"customSites":[]}`

func sprintf(format string, v int64) string {
	return strings.Replace(format, "%d", jsonInt(v), 1)
}

func jsonInt(v int64) string {
	b, _ := json.Marshal(v)
	return string(b)
}

func TestHealth(t *testing.T) {
	e := setup(t, paths.Config{PairCode: code("AAAA-BBBB-CCCC-DDDD-EEEE")})
	status, body := e.do("GET", "/health", "", "", "")
	if status != 200 || body["ok"] != true || body["failOpen"] != false || body["blocking"] != float64(0) {
		t.Fatalf("%d %v", status, body)
	}
	if status, _ := e.do("GET", "/health?x=1", "", "", ""); status != 404 {
		t.Fatalf("exact path only, got %d", status)
	}
}

func TestRefusesWebPagesAndForeignHosts(t *testing.T) {
	e := setup(t, paths.Config{PairCode: code("AAAA-BBBB-CCCC-DDDD-EEEE")})
	if status, body := e.do("GET", "/health", "https://evil.example", "", ""); status != 403 || body["error"] != "Forbidden origin" {
		t.Fatalf("%d %v", status, body)
	}
	if status, _ := e.do("GET", "/health", "moz-extension://1234", "", ""); status != 200 {
		t.Fatalf("Firefox extension origin should be allowed, got %d", status)
	}
	req := httptest.NewRequest("GET", "/health", nil)
	req.Host = "rebind.example:47621"
	rec := httptest.NewRecorder()
	e.agent.ServeHTTP(rec, req)
	if rec.Code != 403 {
		t.Fatalf("foreign Host header must be refused, got %d", rec.Code)
	}
}

func TestPairingIsOneTime(t *testing.T) {
	e := setup(t, paths.Config{PairCode: code("AAAA-BBBB-CCCC-DDDD-EEEE")})
	if status, _ := e.do("POST", "/v1/pair", "", "", `{"code":"AAAA-BBBB-CCCC-DDDD-EEEE"}`); status != 403 {
		t.Fatalf("pairing without an extension origin must fail, got %d", status)
	}
	if status, body := e.do("POST", "/v1/pair", extOrigin, "", `{"code":"WRONG"}`); status != 401 || body["error"] != "Wrong pairing code" {
		t.Fatalf("%d %v", status, body)
	}
	if status, _ := e.do("POST", "/v1/pair", extOrigin, "", `not json`); status != 400 {
		t.Fatalf("bad JSON: %d", status)
	}
	secret := e.pairOK(" aaaa-bbbb-cccc-dddd-eeee ") // case and spaces are forgiven, like the JS agent
	if len(secret) != 64 {
		t.Fatalf("secret %q", secret)
	}
	cfg, _ := paths.ReadConfig()
	if cfg.PairCode != nil || paths.Val(cfg.SecretHash) != SHA256(secret) || cfg.PairedAt == "" {
		t.Fatalf("config after pairing: %+v", cfg)
	}
	if status, _ := e.do("POST", "/v1/pair", extOrigin, "", `{"code":"AAAA-BBBB-CCCC-DDDD-EEEE"}`); status != 409 {
		t.Fatalf("second pairing must be refused, got %d", status)
	}
	st, err := os.Stat(paths.File("config.json"))
	if err != nil {
		t.Fatal(err)
	}
	if st.Mode().Perm()&0o077 != 0 && os.PathSeparator == '/' {
		t.Fatalf("config.json must be private, mode %v", st.Mode())
	}
}

func TestPairingLinkCodeExpiresAndIsSingleUse(t *testing.T) {
	e := setup(t, paths.Config{PairCode: code("AAAA-BBBB-CCCC-DDDD-EEEE"), LinkCode: code("LINK-LINK-LINK-LINK-LINK")})
	cfg, _ := paths.ReadConfig()
	cfg.LinkExpiresAt = e.now + 60_000
	_ = paths.WriteJSON("config.json", cfg)

	e.now += 120_000 // expired
	if status, _ := e.do("POST", "/v1/pair", extOrigin, "", `{"code":"LINK-LINK-LINK-LINK-LINK"}`); status != 401 {
		t.Fatalf("expired link code must fail, got %d", status)
	}
	e.now -= 120_000
	e.pairOK("LINK-LINK-LINK-LINK-LINK")
	cfg, _ = paths.ReadConfig()
	if cfg.LinkCode != nil || cfg.PairCode != nil {
		t.Fatalf("both codes must be spent: %+v", cfg)
	}
	if status, _ := e.do("POST", "/v1/pair", extOrigin, "", `{"code":"LINK-LINK-LINK-LINK-LINK"}`); status != 409 {
		t.Fatalf("link code must be single use, got %d", status)
	}
}

func TestLinkCodeAloneAllowsPairingUntilItExpires(t *testing.T) {
	e := setup(t, paths.Config{SecretHash: code(SHA256("old")), LinkCode: code("LINK-LINK-LINK-LINK-LINK")})
	cfg, _ := paths.ReadConfig()
	cfg.LinkExpiresAt = e.now + 60_000
	_ = paths.WriteJSON("config.json", cfg)
	e.now += 61_000
	if status, _ := e.do("POST", "/v1/pair", extOrigin, "", `{"code":"LINK-LINK-LINK-LINK-LINK"}`); status != 409 {
		t.Fatalf("no live code: want 409, got %d", status)
	}
}

func TestSyncEnforcesAndKeepsLockedRules(t *testing.T) {
	e := setup(t, paths.Config{PairCode: code("AAAA-BBBB-CCCC-DDDD-EEEE")})
	if status, _ := e.do("POST", "/v1/sync", extOrigin, "nope", `{}`); status != 401 {
		t.Fatalf("unpaired sync: %d", status)
	}
	secret := e.pairOK("AAAA-BBBB-CCCC-DDDD-EEEE")
	if status, _ := e.do("POST", "/v1/sync", extOrigin, "wrong", `{}`); status != 401 {
		t.Fatalf("wrong secret: %d", status)
	}
	if status, _ := e.do("POST", "/v1/sync", extOrigin, secret, `{`); status != 400 {
		t.Fatalf("bad JSON: %d", status)
	}
	if status, body := e.do("POST", "/v1/sync", extOrigin, secret, `{"rules":"x"}`); status != 400 || body["error"] != "Snapshot.rules must be an array." {
		t.Fatalf("invalid snapshot: %d %v", status, body)
	}

	status, body := e.do("POST", "/v1/sync", extOrigin, secret, sprintf(lockedSnapshot, 1000))
	if status != 200 || body["ok"] != true {
		t.Fatalf("sync: %d %v", status, body)
	}
	if body["lockedUntil"] != float64(time.Date(2026, 9, 21, 23, 0, 0, 0, time.Local).UnixMilli()) {
		t.Fatalf("lockedUntil %v", body["lockedUntil"])
	}
	content, _ := hosts.Read(e.hosts)
	if !strings.Contains(content, "0.0.0.0 youtube.com") || !strings.Contains(content, "127.0.0.1 localhost") {
		t.Fatalf("hosts not updated:\n%s", content)
	}

	// The extension tries to delete the running no-failsafe rule: the agent keeps it.
	empty := `{"sentAt":2000,"rules":[],"tasks":[],"overrides":[],"focus":{"active":null},"customSites":[]}`
	status, body = e.do("POST", "/v1/sync", extOrigin, secret, empty)
	if status != 200 || len(body["kept"].([]any)) != 1 {
		t.Fatalf("locked rule not kept: %d %v", status, body)
	}
	content, _ = hosts.Read(e.hosts)
	if !strings.Contains(content, "youtube.com") {
		t.Fatal("block must survive while locked")
	}

	// Out-of-order requests are dropped.
	status, body = e.do("POST", "/v1/sync", extOrigin, secret, sprintf(lockedSnapshot, 1500))
	if status != 200 || body["stale"] != true {
		t.Fatalf("stale: %d %v", status, body)
	}

	// After the window the empty snapshot wins and the hosts file is cleaned.
	e.now = time.Date(2026, 9, 21, 23, 30, 0, 0, time.Local).UnixMilli()
	empty3 := strings.Replace(empty, "2000", "3000", 1)
	status, body = e.do("POST", "/v1/sync", extOrigin, secret, empty3)
	if status != 200 || body["lockedUntil"] != nil {
		t.Fatalf("after window: %d %v", status, body)
	}
	content, _ = hosts.Read(e.hosts)
	if strings.Contains(content, "youtube.com") {
		t.Fatalf("hosts must be clean after the window:\n%s", content)
	}
	if _, body = e.do("GET", "/health", "", "", ""); body["blocking"] != float64(0) {
		t.Fatalf("health blocking %v", body["blocking"])
	}
}

func TestTickRestoresRemovedBlock(t *testing.T) {
	e := setup(t, paths.Config{PairCode: code("AAAA-BBBB-CCCC-DDDD-EEEE")})
	secret := e.pairOK("AAAA-BBBB-CCCC-DDDD-EEEE")
	e.do("POST", "/v1/sync", extOrigin, secret, sprintf(lockedSnapshot, 1000))
	if err := os.WriteFile(e.hosts, []byte("127.0.0.1 localhost\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	e.agent.Tick()
	content, _ := hosts.Read(e.hosts)
	if !strings.Contains(content, "youtube.com") {
		t.Fatal("tick must restore a block that was removed by hand")
	}
}

func TestCrashLoopFailsOpenButNotWhileLocked(t *testing.T) {
	e := setup(t, paths.Config{PairCode: code("AAAA-BBBB-CCCC-DDDD-EEEE")})
	now := time.Now().UnixMilli()
	_ = paths.WriteJSON("crashes.json", []int64{now - 1000, now - 2000, now - 3000})
	_ = paths.WriteJSON("run-state.json", map[string]bool{"clean": false})
	e.agent.now = func() int64 { return now }
	e.agent.crashGuard()
	if e.agent.failOpenUntil <= now {
		t.Fatal("4 crashes in 2 minutes must fail open")
	}

	e2 := setup(t, paths.Config{PairCode: code("AAAA-BBBB-CCCC-DDDD-EEEE")})
	var snap map[string]any
	d := json.NewDecoder(strings.NewReader(sprintf(lockedSnapshot, 1)))
	d.UseNumber()
	_ = d.Decode(&snap)
	e2.agent.snapshot = snap
	locked := e2.now
	_ = paths.WriteJSON("crashes.json", []int64{locked - 1000, locked - 2000, locked - 3000})
	_ = paths.WriteJSON("run-state.json", map[string]bool{"clean": false})
	e2.agent.crashGuard()
	if e2.agent.failOpenUntil != 0 {
		t.Fatal("must never fail open while a no-failsafe rule runs")
	}
}

func TestBodyLimit(t *testing.T) {
	e := setup(t, paths.Config{PairCode: code("AAAA-BBBB-CCCC-DDDD-EEEE")})
	secret := e.pairOK("AAAA-BBBB-CCCC-DDDD-EEEE")
	big := `{"rules":[],"x":"` + strings.Repeat("a", maxBodyBytes+10) + `"}`
	if status, _ := e.do("POST", "/v1/sync", extOrigin, secret, big); status != 400 {
		t.Fatalf("oversized body: %d", status)
	}
}

func TestUnusedPairCodeExpires(t *testing.T) {
	e := setup(t, paths.Config{PairCode: code("AAAA-BBBB-CCCC-DDDD-EEEE")})
	e.now += 31 * 60_000
	status, body := e.do("POST", "/v1/pair", extOrigin, "", `{"code":"AAAA-BBBB-CCCC-DDDD-EEEE"}`)
	if status != 409 || !strings.Contains(body["error"].(string), "expired") {
		t.Fatalf("expired pair code: %d %v", status, body)
	}
	// A code from before codes had an expiry counts as expired.
	e2 := setup(t, paths.Config{PairCode: code("AAAA-BBBB-CCCC-DDDD-EEEE"), PairExpiresAt: 1})
	if status, _ := e2.do("POST", "/v1/pair", extOrigin, "", `{"code":"AAAA-BBBB-CCCC-DDDD-EEEE"}`); status != 409 {
		t.Fatalf("legacy code without expiry: %d", status)
	}
	// Already paired and no live code: the old message.
	e3 := setup(t, paths.Config{SecretHash: code(SHA256("x"))})
	if status, body := e3.do("POST", "/v1/pair", extOrigin, "", `{}`); status != 409 || !strings.Contains(body["error"].(string), "Already paired") {
		t.Fatalf("paired: %d %v", status, body)
	}
}

func TestPairBodyIsSmall(t *testing.T) {
	e := setup(t, paths.Config{PairCode: code("AAAA-BBBB-CCCC-DDDD-EEEE")})
	big := `{"code":"AAAA-BBBB-CCCC-DDDD-EEEE","x":"` + strings.Repeat("a", maxPairBytes) + `"}`
	if status, _ := e.do("POST", "/v1/pair", extOrigin, "", big); status != 400 {
		t.Fatalf("oversized pair body: %d", status)
	}
	e.pairOK("AAAA-BBBB-CCCC-DDDD-EEEE")
}

// stall opens a raw connection, sends request headers that promise a body, and
// then sends nothing, like a local process trying to hold the agent's lock.
func stall(t *testing.T, addr, path, extra string) net.Conn {
	t.Helper()
	c, err := net.Dial("tcp", addr)
	if err != nil {
		t.Fatal(err)
	}
	fmt.Fprintf(c, "POST %s HTTP/1.1\r\nHost: 127.0.0.1:47621\r\nOrigin: %s\r\nContent-Type: application/json\r\nContent-Length: 1000\r\n%s\r\n{", path, extOrigin, extra)
	return c
}

func TestSlowBodyDoesNotBlockTick(t *testing.T) {
	old := bodyReadTimeout
	bodyReadTimeout = 700 * time.Millisecond
	t.Cleanup(func() { bodyReadTimeout = old })

	// Windows TCP scheduling is slower than Linux/macOS; use wider margins so
	// the test stays meaningful without flaking on the CI runner.
	sleepMs := 100 * time.Millisecond
	tickDeadline := 300 * time.Millisecond
	if runtime.GOOS == "windows" {
		sleepMs = 300 * time.Millisecond
		tickDeadline = 900 * time.Millisecond
	}

	e := setup(t, paths.Config{PairCode: code("AAAA-BBBB-CCCC-DDDD-EEEE"), LinkCode: code("LINK-LINK-LINK-LINK-LINK")})
	cfg, _ := paths.ReadConfig()
	cfg.LinkExpiresAt = e.now + 60_000
	_ = paths.WriteJSON("config.json", cfg)
	srv := httptest.NewServer(e.agent)
	defer srv.Close()
	addr := strings.TrimPrefix(srv.URL, "http://")

	pairConn := stall(t, addr, "/v1/pair", "")
	defer pairConn.Close()
	time.Sleep(sleepMs) // the handler is now waiting for the body

	done := make(chan struct{})
	go func() { e.agent.Tick(); close(done) }()
	select {
	case <-done:
	case <-time.After(tickDeadline):
		t.Fatal("Tick waited for a stalled /v1/pair body")
	}
	// Other requests keep working too, including a real pairing.
	secret := e.pairOK("LINK-LINK-LINK-LINK-LINK")

	// The stalled request is cut off after the read deadline.
	_ = pairConn.SetReadDeadline(time.Now().Add(3 * time.Second))
	res, err := http.ReadResponse(bufio.NewReader(pairConn), nil)
	if err != nil {
		t.Fatalf("stalled request was not answered: %v", err)
	}
	// Pairing already happened meanwhile, so either answer is fine, just not a hang.
	if res.StatusCode != 400 && res.StatusCode != 409 {
		t.Fatalf("stalled pair: %d", res.StatusCode)
	}

	// The same for an authenticated sync that never sends its body.
	syncConn := stall(t, addr, "/v1/sync", "Authorization: Bearer "+secret+"\r\n")
	defer syncConn.Close()
	time.Sleep(sleepMs)
	done = make(chan struct{})
	go func() { e.agent.Tick(); close(done) }()
	select {
	case <-done:
	case <-time.After(tickDeadline):
		t.Fatal("Tick waited for a stalled /v1/sync body")
	}
	_ = syncConn.SetReadDeadline(time.Now().Add(3 * time.Second))
	res, err = http.ReadResponse(bufio.NewReader(syncConn), nil)
	if err != nil || res.StatusCode != 400 {
		t.Fatalf("stalled sync: %v %v", res, err)
	}
}
