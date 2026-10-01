//go:build windows

package service

import (
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"unicode/utf16"

	"regimen/agent/internal/paths"
	"regimen/agent/internal/platform"
	"regimen/agent/internal/safefile"
)

const uninstallKey = `HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\Regimen`

func startMenuDir() string {
	pd := os.Getenv("ProgramData")
	if pd == "" {
		pd = `C:\ProgramData`
	}
	return filepath.Join(pd, "Microsoft", "Windows", "Start Menu", "Programs", "Regimen")
}

func taskXML(exe string) string {
	return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo><Description>Regimen lock agent</Description></RegistrationInfo>
  <Triggers><BootTrigger><Enabled>true</Enabled></BootTrigger><LogonTrigger><Enabled>true</Enabled></LogonTrigger></Triggers>
  <Principals><Principal id="Author"><UserId>S-1-5-18</UserId><RunLevel>HighestAvailable</RunLevel></Principal></Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <RestartOnFailure><Interval>PT1M</Interval><Count>999</Count></RestartOnFailure>
    <Enabled>true</Enabled>
  </Settings>
  <Actions Context="Author"><Exec><Command>` + xmlEscape(exe) + `</Command><Arguments>run</Arguments></Exec></Actions>
</Task>`
}

func utf16LE(s string) []byte {
	u := utf16.Encode([]rune("\ufeff" + s))
	b := make([]byte, len(u)*2)
	for i, c := range u {
		b[2*i] = byte(c)
		b[2*i+1] = byte(c >> 8)
	}
	return b
}

// Install registers a SYSTEM task that starts at boot and logon and restarts on failure.
func Install(exe string) error {
	// The task definition goes through the locked-down data folder, not %TEMP%,
	// where the signed-in user could swap it between writing and schtasks reading it.
	tmp := paths.File("regimen-task.xml")
	if err := safefile.WriteFile(tmp, utf16LE(taskXML(exe)), 0o600); err != nil {
		return err
	}
	defer safefile.Remove(tmp)
	if out, err := platform.Output("schtasks", "/Create", "/TN", paths.ServiceName, "/XML", tmp, "/F"); err != nil {
		return &cmdError{"schtasks /Create", err, out}
	}
	_ = platform.Run("schtasks", "/Run", "/TN", paths.ServiceName)
	createShortcuts(exe)
	registerUninstall(exe)
	return nil
}

type cmdError struct {
	what string
	err  error
	out  []byte
}

func (e *cmdError) Error() string {
	return e.what + ": " + e.err.Error() + " " + strings.TrimSpace(string(e.out))
}

func psQuote(s string) string { return "'" + strings.ReplaceAll(s, "'", "''") + "'" }

func shortcut(lnk, target, args string) {
	ps := "$s=(New-Object -ComObject WScript.Shell).CreateShortcut(" + psQuote(lnk) + ");$s.TargetPath=" + psQuote(target) +
		";$s.Arguments=" + psQuote(args) + ";$s.Save()"
	_ = platform.Run("powershell", "-NoProfile", "-NonInteractive", "-Command", ps)
}

func createShortcuts(exe string) {
	dir := startMenuDir()
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return
	}
	// A .cmd that asks for admin rights by itself, then runs recover and waits.
	cmd := filepath.Join(paths.ProgramDir(), "recover.cmd")
	_ = safefile.WriteFile(cmd, []byte("@echo off\r\nnet session >nul 2>&1 || (powershell -NoProfile -Command \"Start-Process -Verb RunAs -FilePath '%~f0'\" & exit /b)\r\n\""+
		exe+"\" recover\r\npause\r\n"), 0o644)
	shortcut(filepath.Join(dir, "Regimen Emergency Recovery.lnk"), cmd, "")
	shortcut(filepath.Join(dir, "Regimen Lock Agent.lnk"), exe, "")
}

// registerUninstall adds an Apps & Features entry for a self-install. The Windows
// installer writes its own entry (same key) and replaces this one.
func registerUninstall(exe string) {
	if platform.Run("reg", "query", uninstallKey) == nil {
		return
	}
	add := func(name, typ, data string) {
		_ = platform.Run("reg", "add", uninstallKey, "/v", name, "/t", typ, "/d", data, "/f")
	}
	add("DisplayName", "REG_SZ", "Regimen lock agent")
	add("Publisher", "REG_SZ", "Regimen (open source)")
	add("DisplayIcon", "REG_SZ", exe)
	add("InstallLocation", "REG_SZ", paths.ProgramDir())
	add("UninstallString", "REG_SZ", `"`+exe+`" uninstall`)
	add("NoModify", "REG_DWORD", "1")
	add("NoRepair", "REG_DWORD", "1")
}

func unregisterUninstall() {
	out, err := platform.Output("reg", "query", uninstallKey, "/v", "UninstallString")
	if err == nil && strings.Contains(strings.ToLower(string(out)), "regimen-agent.exe") {
		_ = platform.Run("reg", "delete", uninstallKey, "/f")
	}
}

// Uninstall stops and removes the task, the shortcuts and any leftover process on our port.
func Uninstall() {
	_ = platform.Run("schtasks", "/End", "/TN", paths.ServiceName)
	_ = platform.Run("schtasks", "/Delete", "/TN", paths.ServiceName, "/F")
	_ = os.RemoveAll(startMenuDir())
	stopPortListeners()
	unregisterUninstall()
}

// stopPortListeners stops any leftover process listening on our port (never ourselves).
func stopPortListeners() {
	_ = platform.Run("powershell", "-NoProfile", "-NonInteractive", "-Command",
		"Get-NetTCPConnection -LocalPort 47621 -State Listen -ErrorAction SilentlyContinue | ? { $_.OwningProcess -ne "+strconv.Itoa(os.Getpid())+" } | % { Stop-Process -Id $_.OwningProcess -Force }")
}

func removeProgram(dir string) {
	self, _ := Self()
	if self != "" && strings.EqualFold(filepath.Dir(self), filepath.Clean(dir)) {
		// We are running from the folder: delete it a moment after we exit.
		c := exec.Command("cmd", "/c", "ping -n 3 127.0.0.1 >nul & rmdir /s /q \""+dir+"\"")
		platform.HideWindow(c)
		_ = c.Start()
		return
	}
	_ = os.RemoveAll(dir)
}

// Installed reports whether the service task exists.
func Installed() bool { return platform.Run("schtasks", "/Query", "/TN", paths.ServiceName) == nil }

// RecoveryHint is where people find the emergency recovery tool.
const RecoveryHint = "Start Menu, Regimen, Regimen Emergency Recovery"

// What the agent registered before the rename from FocusGateway (up to v1.2.0).
const legacyUninstallKey = `HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\FocusGateway`

func legacyStartMenuDir() string { return filepath.Join(filepath.Dir(startMenuDir()), "FocusGateway") }

// LegacyInstalled reports whether an old FocusGateway agent is registered.
func LegacyInstalled() bool {
	return platform.Run("schtasks", "/Query", "/TN", paths.LegacyServiceName) == nil
}

// RemoveLegacy stops and deletes an old FocusGateway task, its Start Menu
// folder, its Apps & Features entry and its program folder (with the old
// uninstaller, which would otherwise point at files that are gone). Its data
// folder is moved separately (paths.MigrateLegacyData).
func RemoveLegacy() {
	_ = platform.Run("schtasks", "/End", "/TN", paths.LegacyServiceName)
	_ = platform.Run("schtasks", "/Delete", "/TN", paths.LegacyServiceName, "/F")
	stopPortListeners() // the old binary must exit before its folder can go
	_ = os.RemoveAll(legacyStartMenuDir())
	_ = platform.Run("reg", "delete", legacyUninstallKey, "/f")
	removeProgram(paths.LegacyProgramDir())
}
