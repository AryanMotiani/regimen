//go:build darwin

package service

import (
	"os"
	"path/filepath"
	"time"

	"regimen/agent/internal/paths"
	"regimen/agent/internal/platform"
	"regimen/agent/internal/safefile"
)

const (
	launchd     = "/Library/LaunchDaemons/app.regimen.agent.plist"
	recoveryCmd = "/Applications/Regimen Emergency Recovery.command"
	cliLink     = "/usr/local/bin/regimen-agent"
)

// Install writes a LaunchDaemon (starts at boot, KeepAlive restarts it) and loads it.
func Install(exe string) error {
	plist := `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>app.regimen.agent</string>
  <key>ProgramArguments</key><array><string>` + xmlEscape(exe) + `</string><string>run</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>` + xmlEscape(filepath.Join(paths.DataDir(), "stdout.log")) + `</string>
  <key>StandardErrorPath</key><string>` + xmlEscape(filepath.Join(paths.DataDir(), "stderr.log")) + `</string>
</dict></plist>
`
	if err := safefile.WriteFile(launchd, []byte(plist), 0o644); err != nil {
		return err
	}
	_ = platform.Run("launchctl", "bootout", "system", launchd)
	// bootout is asynchronous: retry bootstrap for a few seconds
	var err error
	for i := 0; i <= 10; i++ {
		if err = platform.Run("launchctl", "bootstrap", "system", launchd); err == nil {
			break
		}
		time.Sleep(500 * time.Millisecond)
	}
	if err != nil {
		return err
	}
	_ = safefile.WriteFile(recoveryCmd, []byte("#!/bin/sh\necho \"Regimen emergency recovery (asks for your password)\"\nsudo \""+exe+
		"\" recover\nread -p \"Press Enter to close\" _\n"), 0o755)
	_ = os.MkdirAll(filepath.Dir(cliLink), 0o755)
	_ = os.Remove(cliLink)
	_ = os.Symlink(exe, cliLink)
	return nil
}

// Uninstall unloads and removes the LaunchDaemon and the helpers.
func Uninstall() {
	_ = platform.Run("launchctl", "bootout", "system", launchd)
	_ = os.Remove(launchd)
	_ = os.Remove(recoveryCmd)
	if t, err := os.Readlink(cliLink); err == nil && filepath.Base(t) == paths.BinaryName() {
		_ = os.Remove(cliLink)
	}
}

func removeProgram(dir string) { _ = os.RemoveAll(dir) }

// Installed reports whether the LaunchDaemon exists.
func Installed() bool {
	_, err := os.Stat(launchd)
	return err == nil
}

// RecoveryHint is where people find the emergency recovery tool.
const RecoveryHint = "Applications, Regimen Emergency Recovery"

// What the agent registered before the rename from FocusGateway (up to v1.2.0).
const (
	legacyLaunchd     = "/Library/LaunchDaemons/app.focusgateway.agent.plist"
	legacyRecoveryCmd = "/Applications/FocusGateway Emergency Recovery.command"
	legacyCliLink     = "/usr/local/bin/focusgateway-agent"
)

// LegacyInstalled reports whether an old FocusGateway agent is registered.
func LegacyInstalled() bool {
	_, err := os.Stat(legacyLaunchd)
	return err == nil
}

// RemoveLegacy unloads and removes an old FocusGateway LaunchDaemon, its
// helpers, its program folder and its installer receipt. Its data folder is
// moved separately (paths.MigrateLegacyData).
func RemoveLegacy() {
	_ = platform.Run("launchctl", "bootout", "system", legacyLaunchd)
	_ = os.Remove(legacyLaunchd)
	_ = os.Remove(legacyRecoveryCmd)
	if t, err := os.Readlink(legacyCliLink); err == nil && filepath.Base(t) == paths.LegacyBinaryName() {
		_ = os.Remove(legacyCliLink)
	}
	_ = os.RemoveAll(paths.LegacyProgramDir())
	_ = platform.Run("pkgutil", "--forget", "app.focusgateway.agent")
}
