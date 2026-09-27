// Package paths knows where the agent keeps its program and data, and reads and
// writes the small JSON files in the data folder.
package paths

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"regimen/agent/internal/safefile"
)

// Port is the loopback port the extension talks to.
const Port = 47621

// ServiceName is the Task Scheduler task name on Windows.
const ServiceName = "RegimenAgent"

func env(name, fallback string) string {
	if v := os.Getenv(name); v != "" {
		return v
	}
	return fallback
}

// ProgramDir is where the agent binary lives after install. Only admins can write there.
func ProgramDir() string {
	if v := os.Getenv("REGIMEN_PROGRAM_DIR"); v != "" {
		return v
	}
	switch runtime.GOOS {
	case "windows":
		return filepath.Join(ProgramFiles(), "Regimen")
	case "darwin":
		return "/Library/Application Support/Regimen/app"
	default:
		return "/opt/regimen"
	}
}

// ProgramFiles is the 64-bit Program Files folder on Windows. ProgramW6432 comes
// first because a 32-bit parent (like the setup program) can pass on
// ProgramFiles pointing at "Program Files (x86)".
func ProgramFiles() string {
	return env("ProgramW6432", env("ProgramFiles", `C:\Program Files`))
}

// BinaryName is the executable's file name on this OS.
func BinaryName() string {
	if runtime.GOOS == "windows" {
		return "regimen-agent.exe"
	}
	return "regimen-agent"
}

// ProgramBinary is the installed executable.
func ProgramBinary() string { return filepath.Join(ProgramDir(), BinaryName()) }

// FallbackBinary is where the agent keeps a copy of itself when a package
// manager removes the program while a no-failsafe block runs. No package owns
// this path.
func FallbackBinary() string { return filepath.Join(DataDir(), BinaryName()) }

// DataDir holds root-owned data: config (pairing), last snapshot, hosts backup, log.
// It survives uninstall unless --purge is used.
func DataDir() string {
	if v := os.Getenv("REGIMEN_DATA"); v != "" {
		return v
	}
	switch runtime.GOOS {
	case "windows":
		return filepath.Join(env("ProgramData", `C:\ProgramData`), "Regimen", "data")
	case "darwin":
		return "/Library/Application Support/Regimen/data"
	default:
		return "/var/lib/regimen"
	}
}

// OwnParent is the Regimen folder that holds DataDir on macOS and Windows
// ("" on Linux, where DataDir sits directly in /var/lib, and when
// REGIMEN_DATA overrides the location).
func OwnParent() string {
	if os.Getenv("REGIMEN_DATA") != "" {
		return ""
	}
	if p := filepath.Dir(DataDir()); filepath.Base(p) == "Regimen" {
		return p
	}
	return ""
}

// EnsureDataDir creates the data folder as owner-only (0700). Missing parents
// are created as 0755, never 0700: on macOS the parent also holds the program
// folder, and the /usr/local/bin link only works for other users when they can
// reach the program through it.
func EnsureDataDir() error {
	if err := os.MkdirAll(filepath.Dir(DataDir()), 0o755); err != nil {
		return err
	}
	return os.MkdirAll(DataDir(), 0o700)
}

// File is a path inside the data folder.
func File(name string) string { return filepath.Join(DataDir(), name) }

// ReadJSON decodes a data file into v. It returns false when the file is missing or unreadable.
func ReadJSON(name string, v any) bool {
	b, err := os.ReadFile(File(name))
	if err != nil {
		return false
	}
	d := json.NewDecoder(bytes.NewReader(b))
	d.UseNumber()
	return d.Decode(v) == nil
}

// WriteJSON writes a data file atomically (temp file and rename) with owner-only permissions.
func WriteJSON(name string, v any) error {
	if err := EnsureDataDir(); err != nil {
		return err
	}
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	enc.SetIndent("", "  ")
	if err := enc.Encode(v); err != nil {
		return err
	}
	return safefile.WriteFile(File(name), bytes.TrimRight(buf.Bytes(), "\n"), 0o600)
}

// ISO formats a time like JavaScript's Date.prototype.toISOString.
func ISO(t time.Time) string { return t.UTC().Format("2006-01-02T15:04:05.000Z") }

// Log prints a line and appends it to agent.log (rotated at about 1 MB).
func Log(args ...any) {
	parts := make([]string, len(args))
	for i, a := range args {
		parts[i] = fmt.Sprint(a)
	}
	line := fmt.Sprintf("[%s] %s", ISO(time.Now()), strings.Join(parts, " "))
	fmt.Println(line)
	if err := EnsureDataDir(); err != nil {
		return
	}
	f := File("agent.log")
	if st, err := os.Lstat(f); err == nil && st.Size() > 1_000_000 {
		_ = os.Rename(f, f+".1")
	}
	_ = safefile.AppendFile(f, []byte(line+"\n"), 0o600)
}
