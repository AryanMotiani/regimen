package policies

import (
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"regimen/agent/internal/paths"
)

func TestChromiumPolicy(t *testing.T) {
	b, _ := json.Marshal(Chromium(Options{}))
	if string(b) != `{"DnsOverHttpsMode":"off","IncognitoModeAvailability":1,"BrowserGuestModeEnabled":false,"BrowserAddPersonEnabled":false}` {
		t.Fatalf("got %s", b)
	}
	strict := Chromium(OptionsFromConfig(paths.Config{Strict: true, ChromeExtensionID: "abc"}))
	b, _ = json.Marshal(strict)
	for _, want := range []string{`"URLBlocklist":["chrome://extensions"`, `"DeveloperToolsAvailability":2`, `"ExtensionInstallForcelist":["abc;https://clients2.google.com/service/update2/crx"]`} {
		if !strings.Contains(string(b), want) {
			t.Errorf("missing %s in %s", want, b)
		}
	}
}

func TestFirefoxPolicyAndMerge(t *testing.T) {
	ff := Firefox(Options{Strict: true, FirefoxXpiURL: "https://example.com/x.xpi"})
	merged := MergeFirefox([]byte(`{"policies":{"Homepage":{"URL":"https://example.org"}},"other":1}`), ff)
	var doc map[string]any
	if err := json.Unmarshal(merged, &doc); err != nil {
		t.Fatal(err)
	}
	p := doc["policies"].(map[string]any)
	if p["Homepage"] == nil || p["DisablePrivateBrowsing"] != true || p["BlockAboutAddons"] != true || doc["other"] == nil {
		t.Fatalf("merge lost or missed entries: %s", merged)
	}
	if !strings.Contains(string(merged), `"regimen@aryanmotiani.github.io"`) || !strings.Contains(string(merged), `"force_installed"`) {
		t.Fatalf("force install missing: %s", merged)
	}
	if !strings.Contains(string(MergeFirefox([]byte("not json"), ff)), "DNSOverHTTPS") {
		t.Fatal("a broken policies.json is replaced")
	}
}

func TestPlist(t *testing.T) {
	out := ToPlist(Chromium(Options{Strict: true}))
	for _, want := range []string{"<key>DnsOverHttpsMode</key>\n  <string>off</string>", "<key>IncognitoModeAvailability</key>\n  <integer>1</integer>", "<false/>", "<array>\n    <string>chrome://extensions</string>"} {
		if !strings.Contains(out, want) {
			t.Errorf("missing %q in\n%s", want, out)
		}
	}
}

func TestFirefoxMacPlist(t *testing.T) {
	out := ToPlist(FirefoxMac(Options{Strict: true, FirefoxXpiURL: "https://example.com/x.xpi?a=1&b=2"}))
	for _, want := range []string{
		"<key>EnterprisePoliciesEnabled</key>\n  <true/>",
		"<key>DNSOverHTTPS</key>\n  <dict>\n    <key>Enabled</key>\n    <false/>",
		"<key>DisablePrivateBrowsing</key>\n  <true/>",
		"<key>regimen@aryanmotiani.github.io</key>",
		"<string>https://example.com/x.xpi?a=1&amp;b=2</string>",
	} {
		if !strings.Contains(out, want) {
			t.Errorf("missing %q in\n%s", want, out)
		}
	}
}

func TestBackupAndWriteRefusesLinksAndKeepsPrivateBackups(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("symlinks need extra rights on Windows")
	}
	t.Setenv("REGIMEN_DATA", t.TempDir())
	dir := filepath.Join(t.TempDir(), "managed")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	_ = os.Chmod(dir, 0o755)
	f := filepath.Join(dir, "policies.json")
	if err := os.WriteFile(f, []byte(`{"policies":{"Homepage":{}}}`), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := backupAndWrite(f, []byte("new")); err != nil {
		t.Fatal(err)
	}
	st, err := os.Stat(f + backupSuffix)
	if err != nil || st.Mode().Perm() != 0o600 {
		t.Fatalf("backup must exist with mode 0600: %v %v", st, err)
	}
	if err := restoreOrRemove(f); err != nil {
		t.Fatal(err)
	}
	b, _ := os.ReadFile(f)
	st, _ = os.Stat(f)
	if string(b) != `{"policies":{"Homepage":{}}}` || st.Mode().Perm() != 0o644 {
		t.Fatalf("restore: %q %v", b, st.Mode())
	}
	if exists(f + backupSuffix) {
		t.Fatal("backup must be gone after restore")
	}

	// A link at the policy path is refused and its target is untouched.
	victim := filepath.Join(t.TempDir(), "victim")
	_ = os.WriteFile(victim, []byte("keep"), 0o600)
	link := filepath.Join(dir, "linked.json")
	if err := os.Symlink(victim, link); err != nil {
		t.Fatal(err)
	}
	if _, err := backupAndWrite(link, []byte("pwned")); err == nil {
		t.Fatal("writing through a link must be refused")
	}
	// A link at the backup path is refused too.
	g := filepath.Join(dir, "other.json")
	_ = os.WriteFile(g, []byte("orig"), 0o644)
	if err := os.Symlink(victim, g+backupSuffix); err != nil {
		t.Fatal(err)
	}
	if _, err := backupAndWrite(g, []byte("pwned")); err == nil {
		t.Fatal("a linked backup path must be refused")
	}
	if b, _ := os.ReadFile(victim); string(b) != "keep" {
		t.Fatalf("victim changed: %q", b)
	}

	// A folder other users can write to is refused.
	open := filepath.Join(t.TempDir(), "open")
	_ = os.MkdirAll(open, 0o777)
	_ = os.Chmod(open, 0o777)
	if _, err := backupAndWrite(filepath.Join(open, "policies.json"), []byte("x")); err == nil {
		t.Fatal("a world-writable folder must be refused")
	}
}
