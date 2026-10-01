package paths

import (
	"errors"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"runtime"
)

// The project was called FocusGateway up to v1.2.0. These are the places that
// version used, so an upgrade can find an old install, move its data over and
// clean up after it (see cli.migrateLegacy and service.RemoveLegacy).

// LegacyServiceName is the old Task Scheduler task name on Windows.
const LegacyServiceName = "FocusGatewayAgent"

// LegacyBinaryName is the old executable's file name on this OS.
func LegacyBinaryName() string {
	if runtime.GOOS == "windows" {
		return "focusgateway-agent.exe"
	}
	return "focusgateway-agent"
}

// LegacyProgramDir is where the old installer put the binary.
func LegacyProgramDir() string {
	switch runtime.GOOS {
	case "windows":
		return filepath.Join(ProgramFiles(), "FocusGateway")
	case "darwin":
		return "/Library/Application Support/FocusGateway/app"
	default:
		return "/opt/focusgateway"
	}
}

// LegacyDataDir is the old data folder (pairing, snapshot, hosts backup, log).
// REGIMEN_LEGACY_DATA overrides it for tests. When REGIMEN_DATA moves the data
// folder (tests and development) there is no old install to look for, so it
// returns "".
func LegacyDataDir() string {
	if v := os.Getenv("REGIMEN_LEGACY_DATA"); v != "" {
		return v
	}
	if os.Getenv("REGIMEN_DATA") != "" {
		return ""
	}
	switch runtime.GOOS {
	case "windows":
		return filepath.Join(env("ProgramData", `C:\ProgramData`), "FocusGateway", "data")
	case "darwin":
		return "/Library/Application Support/FocusGateway/data"
	default:
		return "/var/lib/focusgateway"
	}
}

// LegacyOwnParent is the old FocusGateway folder around the data folder on
// macOS and Windows ("" on Linux and when the location is overridden).
func LegacyOwnParent() string {
	if os.Getenv("REGIMEN_LEGACY_DATA") != "" || os.Getenv("REGIMEN_DATA") != "" {
		return ""
	}
	if p := filepath.Dir(LegacyDataDir()); filepath.Base(p) == "FocusGateway" {
		return p
	}
	return ""
}

// legacyLeftovers are files in the old data folder that are not data: the copy
// of the old binary that kept a block running while its package was removed,
// and the old task definition. They are deleted, not moved.
func legacyLeftovers() map[string]bool {
	return map[string]bool{
		LegacyBinaryName():          true,
		LegacyBinaryName() + ".new": true,
		LegacyBinaryName() + ".old": true,
		"focusgateway-task.xml":     true,
	}
}

// MigrateLegacyData moves the files of an old FocusGateway data folder into
// the Regimen data folder, so the pairing, the last snapshot (and with it a
// running no-failsafe block), the hosts backup and the policy records carry
// over. It only acts when the old folder holds a config.json and the new one
// does not, never overwrites a file that already exists in the new folder, and
// skips links and folders. It returns how many files it moved.
func MigrateLegacyData(oldDir, newDir string) (int, error) {
	if oldDir == "" || filepath.Clean(oldDir) == filepath.Clean(newDir) {
		return 0, nil
	}
	if st, err := os.Lstat(filepath.Join(oldDir, "config.json")); err != nil || !st.Mode().IsRegular() {
		return 0, nil // no old install (or nothing worth moving)
	}
	if _, err := os.Lstat(filepath.Join(newDir, "config.json")); err == nil {
		return 0, nil // already set up as Regimen: keep that
	}
	if err := os.MkdirAll(newDir, 0o700); err != nil {
		return 0, err
	}
	entries, err := os.ReadDir(oldDir)
	if err != nil {
		return 0, err
	}
	skip := legacyLeftovers()
	moved := 0
	var firstErr error
	for _, e := range entries {
		name := e.Name()
		from, to := filepath.Join(oldDir, name), filepath.Join(newDir, name)
		if skip[name] {
			_ = os.Remove(from)
			continue
		}
		if !e.Type().IsRegular() {
			continue // never follow or carry a link, and no subfolders exist
		}
		if _, err := os.Lstat(to); err == nil {
			continue
		}
		if err := moveFile(from, to); err != nil {
			if firstErr == nil {
				firstErr = err
			}
			continue
		}
		moved++
	}
	return moved, firstErr
}

// moveFile renames, or copies and deletes when the folders sit on different
// file systems. The copy is private (0600) like every data file.
func moveFile(from, to string) error {
	if err := os.Rename(from, to); err == nil {
		return nil
	}
	src, err := os.Open(from)
	if err != nil {
		return err
	}
	defer src.Close()
	dst, err := os.OpenFile(to, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return err
	}
	if _, err := io.Copy(dst, src); err != nil {
		dst.Close()
		os.Remove(to)
		return err
	}
	if err := dst.Close(); err != nil {
		return err
	}
	if err := os.Remove(from); err != nil && !errors.Is(err, fs.ErrNotExist) {
		return err
	}
	return nil
}

// RemoveEmptyLegacyDirs deletes the old data folder and its FocusGateway parent
// once they are empty. Anything still inside (a file that existed in both
// places) is left alone.
func RemoveEmptyLegacyDirs() {
	if d := LegacyDataDir(); d != "" {
		_ = os.Remove(d)
	}
	if p := LegacyOwnParent(); p != "" {
		_ = os.Remove(p)
	}
}
