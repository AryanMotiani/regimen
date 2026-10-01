//go:build !windows && !darwin

package service

import (
	"os"
	"path/filepath"

	"regimen/agent/internal/paths"
	"regimen/agent/internal/platform"
	"regimen/agent/internal/safefile"
)

const (
	systemdUnit = "/etc/systemd/system/regimen-agent.service"
	cliLink     = "/usr/local/bin/regimen-agent"
	desktopFile = "/usr/share/applications/regimen-recovery.desktop"
)

// Install writes a systemd unit (Restart=always), enables and starts it.
func Install(exe string) error {
	unit := `[Unit]
Description=Regimen lock agent
After=network.target

[Service]
ExecStart="` + exe + `" run
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
`
	if err := safefile.WriteFile(systemdUnit, []byte(unit), 0o644); err != nil {
		return err
	}
	if out, err := platform.Output("systemctl", "daemon-reload"); err != nil {
		return &cmdError{"systemctl daemon-reload", err, out}
	}
	if out, err := platform.Output("systemctl", "enable", "--now", "regimen-agent.service"); err != nil {
		return &cmdError{"systemctl enable", err, out}
	}
	// restart picks up a new binary when this is a reinstall or upgrade
	_ = platform.Run("systemctl", "restart", "regimen-agent.service")
	if exe != cliLink {
		_ = os.MkdirAll(filepath.Dir(cliLink), 0o755)
		_ = os.Remove(cliLink)
		_ = os.Symlink(exe, cliLink)
	}
	_ = os.MkdirAll(filepath.Dir(desktopFile), 0o755)
	_ = safefile.WriteFile(desktopFile, []byte("[Desktop Entry]\nType=Application\nName=Regimen Emergency Recovery\nExec=pkexec "+exe+
		" recover\nTerminal=true\nCategories=Utility;\n"), 0o644)
	return nil
}

type cmdError struct {
	what string
	err  error
	out  []byte
}

func (e *cmdError) Error() string { return e.what + ": " + e.err.Error() + " " + string(e.out) }

// Uninstall stops and removes the unit and the helpers.
func Uninstall() {
	_ = platform.Run("systemctl", "disable", "--now", "regimen-agent.service")
	_ = os.Remove(systemdUnit)
	_ = platform.Run("systemctl", "daemon-reload")
	if t, err := os.Readlink(cliLink); err == nil && filepath.Base(t) == paths.BinaryName() {
		_ = os.Remove(cliLink)
	}
	_ = os.Remove(desktopFile)
}

func removeProgram(dir string) { _ = os.RemoveAll(dir) }

// Installed reports whether the systemd unit exists.
func Installed() bool {
	_, err := os.Stat(systemdUnit)
	return err == nil
}

// RecoveryHint is where people find the emergency recovery tool.
const RecoveryHint = "sudo regimen-agent recover"

// What the agent registered before the rename from FocusGateway (up to v1.2.0).
const (
	legacyUnit        = "/etc/systemd/system/focusgateway-agent.service"
	legacyCliLink     = "/usr/local/bin/focusgateway-agent"
	legacyDesktopFile = "/usr/share/applications/focusgateway-recovery.desktop"
)

// LegacyInstalled reports whether an old FocusGateway agent is registered.
func LegacyInstalled() bool {
	_, err := os.Stat(legacyUnit)
	return err == nil
}

// packageOwned reports whether dpkg or rpm owns path. A package's own removal
// scripts expect its files, so those stay until the package goes (the new
// .deb and .rpm replace the old package by themselves).
func packageOwned(path string) bool {
	return platform.Run("dpkg-query", "-S", path) == nil || platform.Run("rpm", "-qf", path) == nil
}

// RemoveLegacy stops and removes an old FocusGateway service and its helpers.
// Its data folder is moved separately (paths.MigrateLegacyData).
func RemoveLegacy() {
	_ = platform.Run("systemctl", "disable", "--now", "focusgateway-agent.service")
	_ = os.Remove(legacyUnit)
	_ = platform.Run("systemctl", "daemon-reload")
	if t, err := os.Readlink(legacyCliLink); err == nil && filepath.Base(t) == paths.LegacyBinaryName() {
		_ = os.Remove(legacyCliLink)
	}
	_ = os.Remove(legacyDesktopFile)
	dir := paths.LegacyProgramDir()
	if !packageOwned(filepath.Join(dir, paths.LegacyBinaryName())) {
		_ = os.RemoveAll(dir)
	}
}
