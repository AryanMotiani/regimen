package hosts

import (
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"strings"
	"testing"
)

// Ported from the Node.js agent's test/agent.test.js ("hosts file rendering").

const original = "127.0.0.1 localhost\n::1 localhost\n# my own entry\n10.0.0.5 nas.local\n"

func TestAddsManagedBlockWithWwwAndIPv6(t *testing.T) {
	out := Render(original, []string{"youtube.com", "www.reddit.com"}, "\n")
	if !strings.HasPrefix(out, strings.TrimRight(original, "\n")) {
		t.Fatal("original lines must stay first and untouched")
	}
	for _, want := range []string{"0.0.0.0 youtube.com", "0.0.0.0 www.youtube.com", ":: youtube.com"} {
		if !strings.Contains(out, want) {
			t.Errorf("missing %q", want)
		}
	}
	if strings.Contains(out, "www.www.reddit.com") {
		t.Error("www. must not be doubled")
	}
	if got := ManagedDomains(out); !reflect.DeepEqual(got, []string{"www.reddit.com", "www.youtube.com", "youtube.com"}) {
		t.Errorf("managed domains %v", got)
	}
}

func TestReplacesTheBlockAndRemovesItCleanly(t *testing.T) {
	once := Render(original, []string{"a.com"}, "\n")
	twice := Render(once, []string{"b.com"}, "\n")
	if strings.Count(twice, MarkerStart) != 1 {
		t.Fatal("block must be replaced, not stacked")
	}
	if strings.Contains(twice, "a.com") {
		t.Fatal("old domains must go")
	}
	if Render(twice, nil, "\n") != original {
		t.Fatal("removing the block must restore the original file")
	}
}

func TestPreservesCRLF(t *testing.T) {
	win := strings.ReplaceAll(original, "\n", "\r\n")
	out := Render(win, []string{"x.com"}, "\r\n")
	if !strings.Contains(out, "\r\n0.0.0.0 x.com\r\n") {
		t.Fatal("CRLF lines expected")
	}
	if strings.Join(StripManaged(out), "\r\n")+"\r\n" != win {
		t.Fatal("stripping must give back the original CRLF file")
	}
}

func TestApplyWritesOnlyOnChange(t *testing.T) {
	f := filepath.Join(t.TempDir(), "hosts")
	if err := os.WriteFile(f, []byte(original), 0o644); err != nil {
		t.Fatal(err)
	}
	t.Setenv("REGIMEN_HOSTS", f)
	changed, err := Apply([]string{"x.com"})
	if err != nil || !changed {
		t.Fatalf("first apply: changed=%v err=%v", changed, err)
	}
	changed, err = Apply([]string{"x.com"})
	if err != nil || changed {
		t.Fatalf("second apply should be a no-op: changed=%v err=%v", changed, err)
	}
	if entries, _ := os.ReadDir(filepath.Dir(f)); len(entries) != 1 {
		t.Fatalf("temp file left behind: %v", entries)
	}
	if _, err := Apply(nil); err != nil {
		t.Fatal(err)
	}
	b, _ := os.ReadFile(f)
	if string(b) != strings.ReplaceAll(original, "\n", EOL()) && string(b) != original {
		t.Fatalf("clean file expected, got %q", b)
	}
}

func TestMissingHostsFileReadsEmpty(t *testing.T) {
	s, err := Read(filepath.Join(t.TempDir(), "nope"))
	if err != nil || s != "" {
		t.Fatalf("got %q, %v", s, err)
	}
}

func TestValidDomain(t *testing.T) {
	good := []string{"youtube.com", "www.reddit.com", "a.b", "x-y.co.uk", "123.example.com", "xn--bcher-kva.de", strings.Repeat("a", 63) + ".com"}
	bad := []string{
		"", "localhost", "com", ".com", "a..com", "a.com.", "-a.com", "a-.com", "YouTube.com",
		"you tube.com", "a.com\n0.0.0.0 bank.com", "a.com\r\n", "a.com\t", "a\x00.com", "a.com#", "*.a.com",
		"a_b.com", "127.0.0.1", "::1", "a/b.com", "a.com:80",
		strings.Repeat("a", 64) + ".com",
		strings.Repeat("abcdefghi.", 26) + "com", // 263 characters
	}
	for _, d := range good {
		if !ValidDomain(d) {
			t.Errorf("%q should be valid", d)
		}
	}
	for _, d := range bad {
		if ValidDomain(d) {
			t.Errorf("%q must be refused", d)
		}
	}
}

func TestNewlineInjectionNeverReachesTheFile(t *testing.T) {
	evil := "evil.com\n# <<< REGIMEN-MANAGED-END\n1.2.3.4 bank.example"
	valid, dropped := Sanitize([]string{"YouTube.com", evil, "youtube.com", "a.com\r0.0.0.0 x.com"})
	if len(valid) != 1 || valid[0] != "youtube.com" || len(dropped) != 2 {
		t.Fatalf("valid %q dropped %q", valid, dropped)
	}
	out := Render(original, []string{"youtube.com", evil}, "\n")
	if strings.Contains(out, "bank.example") || strings.Contains(out, "evil.com") || strings.Count(out, MarkerEnd) != 1 {
		t.Fatalf("injected lines reached the hosts file:\n%s", out)
	}
	f := filepath.Join(t.TempDir(), "hosts")
	if err := os.WriteFile(f, []byte(original), 0o644); err != nil {
		t.Fatal(err)
	}
	t.Setenv("REGIMEN_DATA", t.TempDir())
	if _, err := ApplyTo(f, []string{evil}); err != nil {
		t.Fatal(err)
	}
	if b, _ := os.ReadFile(f); string(b) != original {
		t.Fatalf("only invalid domains: file must stay untouched, got %q", b)
	}
}

func TestReplaceSwapsALinkInsteadOfWritingThroughIt(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("symlinks need extra rights on Windows")
	}
	dir := t.TempDir()
	target := filepath.Join(dir, "elsewhere")
	if err := os.WriteFile(target, []byte(original), 0o644); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(dir, "hosts")
	if err := os.Symlink(target, link); err != nil {
		t.Fatal(err)
	}
	if _, err := ApplyTo(link, []string{"x.com"}); err != nil {
		t.Fatal(err)
	}
	if b, _ := os.ReadFile(target); string(b) != original {
		t.Fatal("the link target must not be written")
	}
	if st, _ := os.Lstat(link); !st.Mode().IsRegular() {
		t.Fatal("the link is replaced by a regular file")
	}
}

// A block written by the agent before the rename to Regimen (FocusGateway, up to v1.2.0).
const legacyBlock = "\n# >>> FOCUSGATEWAY-MANAGED-START (do not edit; run `focusgateway-agent recover` if stuck)\n" +
	"0.0.0.0 old.com\n:: old.com\n0.0.0.0 www.old.com\n:: www.old.com\n# <<< FOCUSGATEWAY-MANAGED-END\n"

func TestLegacyFocusGatewayBlockIsReplacedAndRemoved(t *testing.T) {
	upgraded := strings.TrimRight(original, "\n") + "\n" + legacyBlock
	if got := ManagedDomains(upgraded); !reflect.DeepEqual(got, []string{"old.com", "www.old.com"}) {
		t.Fatalf("the old block counts as ours, got %v", got)
	}
	out := Render(upgraded, []string{"new.com"}, "\n")
	if strings.Contains(out, "FOCUSGATEWAY") || strings.Contains(out, "old.com") {
		t.Fatalf("an upgrade must drop the old block, got\n%s", out)
	}
	if strings.Count(out, MarkerStart) != 1 || !strings.Contains(out, "0.0.0.0 new.com") {
		t.Fatalf("exactly one new block expected, got\n%s", out)
	}
	if Render(upgraded, nil, "\n") != original {
		t.Fatal("recover and uninstall must clean an old block too")
	}
	both := Render(upgraded, []string{"new.com"}, "\n") + legacyBlock
	if Render(both, nil, "\n") != original {
		t.Fatal("old and new blocks together are both removed")
	}
}
