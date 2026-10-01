package paths

import (
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

func write(t *testing.T, f, s string) {
	t.Helper()
	if err := os.WriteFile(f, []byte(s), 0o600); err != nil {
		t.Fatal(err)
	}
}

func read(f string) string {
	b, _ := os.ReadFile(f)
	return string(b)
}

func TestMigrateLegacyDataMovesAnOldInstall(t *testing.T) {
	root := t.TempDir()
	old, cur := filepath.Join(root, "focusgateway"), filepath.Join(root, "regimen")
	_ = os.MkdirAll(old, 0o700)
	write(t, filepath.Join(old, "config.json"), `{"secretHash":"abc"}`)
	write(t, filepath.Join(old, "snapshot.json"), `{"rules":[]}`)
	write(t, filepath.Join(old, "hosts.original.bak"), "127.0.0.1 localhost\n")
	write(t, filepath.Join(old, "policies-written.json"), `[]`)
	write(t, filepath.Join(old, LegacyBinaryName()), "old binary")
	n, err := MigrateLegacyData(old, cur)
	if err != nil || n != 4 {
		t.Fatalf("moved %d, err %v", n, err)
	}
	if read(filepath.Join(cur, "config.json")) != `{"secretHash":"abc"}` || read(filepath.Join(cur, "snapshot.json")) != `{"rules":[]}` {
		t.Fatal("pairing and snapshot must carry over")
	}
	if _, err := os.Stat(filepath.Join(cur, LegacyBinaryName())); err == nil {
		t.Fatal("the old fallback binary is not data and must not move")
	}
	if _, err := os.Stat(filepath.Join(old, LegacyBinaryName())); err == nil {
		t.Fatal("the old fallback binary is deleted")
	}
	if runtime.GOOS != "windows" {
		if st, _ := os.Stat(cur); st.Mode().Perm() != 0o700 {
			t.Fatalf("new data folder must be private, mode %v", st.Mode())
		}
	}
	t.Setenv("REGIMEN_LEGACY_DATA", old)
	RemoveEmptyLegacyDirs()
	if _, err := os.Stat(old); err == nil {
		t.Fatal("the empty old folder is removed")
	}
}

func TestMigrateLegacyDataNeverOverwrites(t *testing.T) {
	root := t.TempDir()
	old, cur := filepath.Join(root, "old"), filepath.Join(root, "new")
	_ = os.MkdirAll(old, 0o700)
	_ = os.MkdirAll(cur, 0o700)
	write(t, filepath.Join(old, "config.json"), "old")
	write(t, filepath.Join(old, "snapshot.json"), "old snapshot")

	// Already set up as Regimen: nothing moves.
	write(t, filepath.Join(cur, "config.json"), "new")
	if n, _ := MigrateLegacyData(old, cur); n != 0 || read(filepath.Join(cur, "config.json")) != "new" {
		t.Fatal("an existing Regimen install wins")
	}
	if _, err := os.Stat(filepath.Join(cur, "snapshot.json")); err == nil {
		t.Fatal("nothing is mixed into an existing install")
	}

	// New folder without config: files move, but an existing file is kept.
	_ = os.Remove(filepath.Join(cur, "config.json"))
	write(t, filepath.Join(cur, "snapshot.json"), "new snapshot")
	if n, err := MigrateLegacyData(old, cur); n != 1 || err != nil {
		t.Fatalf("moved %d, err %v", n, err)
	}
	if read(filepath.Join(cur, "snapshot.json")) != "new snapshot" || read(filepath.Join(cur, "config.json")) != "old" {
		t.Fatal("existing files are never overwritten")
	}
	RemoveEmptyLegacyDirs() // the old folder still holds a file: it stays
	if _, err := os.Stat(filepath.Join(old, "snapshot.json")); err != nil {
		t.Fatal("a file that was not moved is not deleted")
	}
}

func TestMigrateLegacyDataNeedsAnOldConfig(t *testing.T) {
	root := t.TempDir()
	old, cur := filepath.Join(root, "old"), filepath.Join(root, "new")
	_ = os.MkdirAll(old, 0o700)
	write(t, filepath.Join(old, "agent.log"), "log")
	if n, _ := MigrateLegacyData(old, cur); n != 0 {
		t.Fatal("no config.json, no old install")
	}
	if n, _ := MigrateLegacyData(filepath.Join(root, "missing"), cur); n != 0 {
		t.Fatal("a missing folder is not an error")
	}
	if n, _ := MigrateLegacyData("", cur); n != 0 {
		t.Fatal("no legacy location, nothing to do")
	}
	if runtime.GOOS == "windows" {
		return
	}
	// A linked config.json is not followed.
	target := filepath.Join(root, "elsewhere.json")
	write(t, target, "{}")
	_ = os.Symlink(target, filepath.Join(old, "config.json"))
	if n, _ := MigrateLegacyData(old, cur); n != 0 {
		t.Fatal("a linked config.json is refused")
	}
}

func TestLegacyLocations(t *testing.T) {
	t.Setenv("REGIMEN_LEGACY_DATA", "")
	t.Setenv("REGIMEN_DATA", t.TempDir())
	if LegacyDataDir() != "" || LegacyOwnParent() != "" {
		t.Fatal("a development data folder has no old install next to it")
	}
	t.Setenv("REGIMEN_DATA", "")
	want := map[string]string{"linux": "/var/lib/focusgateway", "darwin": "/Library/Application Support/FocusGateway/data"}
	if w, ok := want[runtime.GOOS]; ok && LegacyDataDir() != w {
		t.Fatalf("legacy data dir %q", LegacyDataDir())
	}
	if runtime.GOOS == "darwin" && LegacyOwnParent() != "/Library/Application Support/FocusGateway" {
		t.Fatal("macOS keeps program and data in one FocusGateway folder")
	}
	if runtime.GOOS == "linux" && (LegacyOwnParent() != "" || LegacyProgramDir() != "/opt/focusgateway") {
		t.Fatal("linux layout")
	}
}
