package cli

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
	"time"

	"regimen/agent/internal/paths"
)

func TestPairingCodeFormat(t *testing.T) {
	re := regexp.MustCompile(`^[A-HJ-NP-Z2-9]{4}(-[A-HJ-NP-Z2-9]{4}){4}$`)
	seen := map[string]bool{}
	for i := 0; i < 200; i++ {
		c := PairingCode()
		if !re.MatchString(c) {
			t.Fatalf("bad code %q", c)
		}
		if seen[c] {
			t.Fatal("codes must not repeat")
		}
		seen[c] = true
	}
}

func TestPairingLinkKeepsTheCodeInTheHash(t *testing.T) {
	t.Setenv("REGIMEN_APP_URL", "http://localhost:5173")
	l := PairingLink("ABCD-EFGH-JKLM-NPQR-STUV")
	if l != "http://localhost:5173/#/install?pair=ABCD-EFGH-JKLM-NPQR-STUV" {
		t.Fatalf("got %s", l)
	}
	if strings.Index(l, "pair=") < strings.Index(l, "#") {
		t.Fatal("the code must be after the #, so it never reaches a server")
	}
}

func TestArgs(t *testing.T) {
	a := args{"--strict", "--chrome-extension-id", "abc"}
	if !a.flag("strict") || a.flag("purge") || a.option("chrome-extension-id") != "abc" || a.option("firefox-xpi") != "" {
		t.Fatal("flag parsing")
	}
}

func TestNoPauseIsAcceptedAnywhere(t *testing.T) {
	if code := Main([]string{"--no-pause", "version"}); code != 0 {
		t.Fatalf("exit %d", code)
	}
	if code := Main([]string{"version", "--no-pause"}); code != 0 {
		t.Fatalf("exit %d", code)
	}
}

func TestPairCodeExpires(t *testing.T) {
	var cfg paths.Config
	newPairCode(&cfg)
	if !pairCodeLive(cfg) {
		t.Fatal("a new code is live")
	}
	if d := time.Until(time.UnixMilli(cfg.PairExpiresAt)); d < 29*time.Minute || d > 31*time.Minute {
		t.Fatalf("expiry %v", d)
	}
	cfg.PairExpiresAt = time.Now().Add(-time.Second).UnixMilli()
	if pairCodeLive(cfg) {
		t.Fatal("an old code is not live")
	}
	cfg.PairExpiresAt = 0
	if pairCodeLive(cfg) {
		t.Fatal("a code without expiry (older versions) is not live")
	}
}

func TestInstallMovesAnOldFocusGatewayInstall(t *testing.T) {
	root := t.TempDir()
	old, cur := filepath.Join(root, "focusgateway"), filepath.Join(root, "regimen")
	t.Setenv("REGIMEN_DATA", cur)
	t.Setenv("REGIMEN_LEGACY_DATA", old)
	removed := 0
	saved := legacyService
	t.Cleanup(func() { legacyService = saved })
	legacyService.installed = func() bool { return false }
	legacyService.remove = func() { removed++ }

	// Nothing old around: nothing happens.
	migrateLegacy()
	if removed != 0 {
		t.Fatal("no old install, no cleanup")
	}

	if err := os.MkdirAll(old, 0o700); err != nil {
		t.Fatal(err)
	}
	_ = os.WriteFile(filepath.Join(old, "config.json"), []byte(`{"pairCode":null,"secretHash":"h","strict":true,"chromeExtensionId":"","firefoxXpiUrl":""}`), 0o600)
	_ = os.WriteFile(filepath.Join(old, "snapshot.json"), []byte(`{"sentAt":1,"rules":[]}`), 0o600)
	if err := prepareDataDir(); err != nil {
		t.Fatal(err)
	}
	migrateLegacy()
	if removed != 1 {
		t.Fatal("the old service is stopped before its data moves")
	}
	cfg, ok := paths.ReadConfig()
	if !ok || paths.Val(cfg.SecretHash) != "h" || !cfg.Strict {
		t.Fatalf("the pairing and strict mode carry over: %+v", cfg)
	}
	if _, err := os.Stat(old); err == nil {
		t.Fatal("the emptied old folder is removed")
	}
}
