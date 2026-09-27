// Package cli is the regimen-agent command line. Running it with no
// arguments (a double click) does the natural thing: install when it is not
// installed, open a fresh pairing link when it is not connected yet, and show
// the status otherwise.
package cli

import (
	"bufio"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"net/http"
	"os"
	"runtime"
	"strings"
	"time"

	"regimen/agent/internal/buildinfo"
	"regimen/agent/internal/daemon"
	"regimen/agent/internal/hosts"
	"regimen/agent/internal/lock"
	"regimen/agent/internal/paths"
	"regimen/agent/internal/platform"
	"regimen/agent/internal/policies"
	"regimen/agent/internal/safefile"
	"regimen/agent/internal/service"
)

// LinkLifetime is how long the code inside a pairing link stays valid.
const LinkLifetime = 30 * time.Minute

type exitCode int

type args []string

func (a args) flag(name string) bool {
	for _, x := range a {
		if x == "--"+name {
			return true
		}
	}
	return false
}

func (a args) option(name string) string {
	for i, x := range a {
		if x == "--"+name && i+1 < len(a) {
			return a[i+1]
		}
	}
	return ""
}

var color = runtime.GOOS != "windows" && func() bool {
	st, err := os.Stdout.Stat()
	return err == nil && st.Mode()&os.ModeCharDevice != 0
}()

func paint(code, s string) string {
	if !color {
		return s
	}
	return "\x1b[" + code + "m" + s + "\x1b[0m"
}

func bold(s string) string   { return paint("1", s) }
func green(s string) string  { return paint("32", s) }
func yellow(s string) string { return paint("33", s) }
func red(s string) string    { return paint("31", s) }
func dim(s string) string    { return paint("2", s) }

func banner() {
	fmt.Println(bold("\n  Regimen lock agent " + buildinfo.Version + "\n  Blocks your distractions in every browser and app on this computer.\n"))
}

// Help is the usage text.
func Help() string {
	return `Regimen lock agent ` + buildinfo.Version + `

Usage: regimen-agent [command]

  (no command)  Install if needed, then connect it to Regimen in your browser
  install [--strict] [--chrome-extension-id ID] [--firefox-xpi URL] [--no-browser]
            Install as a background service (admin). Opens a pairing link and prints the pairing code.
            --strict  also lock the extensions page, flags and developer tools
  status    Show whether the agent runs, pairing state and what is blocked
  pair [--no-browser]
            Make a new one-time pairing code and link (admin), e.g. after reinstalling the extension
  recover   Emergency: clear blocks if the agent is broken (refused while healthy)
  policies  Re-apply browser policies (after installing a new browser)
  uninstall [--purge]  Remove the agent (refused while a no-failsafe block runs)
  run       Run in the foreground (used by the service)
  version   Print the version

  --no-pause  never wait for Enter before exiting (installers pass it)
`
}

// Main runs the CLI and returns the process exit code.
func Main(argv []string) int {
	noPause := false
	kept := []string{}
	for _, a := range argv {
		if a == "--no-pause" {
			noPause = true
			continue
		}
		kept = append(kept, a)
	}
	argv = kept
	cmd := ""
	if len(argv) > 0 {
		cmd = argv[0]
	}
	rest := args{}
	if len(argv) > 1 {
		rest = argv[1:]
	}
	code := dispatch(cmd, rest, argv)
	// Started by a double click (or from Apps & Features): keep the window open.
	// Never when an installer runs us (--no-pause, or stdin is a pipe, not a
	// console someone can press Enter in): that would hang the installer.
	if !noPause && platform.OwnConsole() && platform.StdinIsConsole() && cmd != "run" && code != elevatedElsewhere {
		fmt.Print("\nPress Enter to close.")
		_, _ = bufio.NewReader(os.Stdin).ReadString('\n')
	}
	if code == elevatedElsewhere {
		return 0
	}
	return int(code)
}

const elevatedElsewhere exitCode = -1

func dispatch(cmd string, rest args, argv []string) exitCode {
	switch cmd {
	case "":
		return smart(argv)
	case "install":
		if c, ok := needAdmin(argv); !ok {
			return c
		}
		return install(rest)
	case "uninstall":
		if c, ok := needAdmin(argv); !ok {
			return c
		}
		return uninstall(rest)
	case "recover":
		if c, ok := needAdmin(argv); !ok {
			return c
		}
		return recoverCmd()
	case "status":
		return status()
	case "policies":
		if c, ok := needAdmin(argv); !ok {
			return c
		}
		cfg, _ := paths.ReadConfig()
		fmt.Printf("%d policy entries written.\n", len(policies.Apply(policies.OptionsFromConfig(cfg))))
		return 0
	case "pair":
		if c, ok := needAdmin(argv); !ok {
			return c
		}
		return pair(rest)
	case "run":
		if err := daemon.Run(); err != nil {
			return 1
		}
		return 0
	case "version", "--version", "-v":
		fmt.Println(buildinfo.Version)
		return 0
	default:
		fmt.Print(Help())
		return 0
	}
}

// needAdmin returns ok=true when we already run as admin. On Windows, when the
// program was started from Explorer (its own console), it asks for elevation
// through UAC and hands over to the elevated copy.
func needAdmin(argv []string) (exitCode, bool) {
	if platform.IsAdmin() {
		return 0, true
	}
	if runtime.GOOS == "windows" && platform.OwnConsole() {
		if self, err := service.Self(); err == nil {
			if err := platform.Elevate(self, argv); err == nil {
				return elevatedElsewhere, false
			}
		}
	}
	fmt.Fprintln(os.Stderr, red("This needs administrator rights."))
	fmt.Fprintln(os.Stderr, platform.ElevationHint)
	return 1, false
}

func isInstalled() bool {
	_, hasConfig := paths.ReadConfig()
	_, err := os.Stat(paths.ProgramBinary())
	return hasConfig && err == nil && service.Installed()
}

// smart is the no-argument path: what a double click should do.
func smart(argv []string) exitCode {
	if !platform.IsAdmin() {
		banner()
		fmt.Println("Installing needs administrator rights. Your computer will ask for permission.")
		self, err := service.Self()
		if err == nil {
			err = platform.Elevate(self, argv)
		}
		if err != nil {
			fmt.Fprintln(os.Stderr, red("Could not get administrator rights: "+err.Error()))
			fmt.Fprintln(os.Stderr, platform.ElevationHint)
			return 1
		}
		if runtime.GOOS == "windows" {
			return elevatedElsewhere
		}
		return 0
	}
	self, _ := service.Self()
	switch {
	case !isInstalled():
		return install(args{})
	case self != "" && !strings.EqualFold(self, paths.ProgramBinary()):
		// A newer download was opened: update in place, keep the settings.
		return install(args{"--keep-settings"})
	default:
		cfg, _ := paths.ReadConfig()
		if paths.Val(cfg.SecretHash) == "" {
			return pair(args{})
		}
		code := status()
		fmt.Println("\nThe lock agent is installed and connected. Nothing else to do.")
		fmt.Println(dim("To remove it: regimen-agent uninstall (as admin)"))
		return code
	}
}

// PairingCode is 5 groups of 4 from an unambiguous alphabet (100 bits).
func PairingCode() string {
	const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
	b := make([]byte, 20)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	var sb strings.Builder
	for i, x := range b {
		if i > 0 && i%4 == 0 {
			sb.WriteByte('-')
		}
		sb.WriteByte(alphabet[int(x)%len(alphabet)])
	}
	return sb.String()
}

// PairingLink is the hosted app's install page with a one-time code in the hash,
// so it never reaches a server.
func PairingLink(code string) string { return buildinfo.App() + "#/install?pair=" + code }

func health(timeout time.Duration) map[string]any {
	c := http.Client{Timeout: timeout}
	res, err := c.Get(fmt.Sprintf("http://127.0.0.1:%d/health", paths.Port))
	if err != nil {
		return nil
	}
	defer res.Body.Close()
	var h map[string]any
	if json.NewDecoder(res.Body).Decode(&h) != nil {
		return nil
	}
	return h
}

// prepareDataDir makes sure the data folder, and on macOS and Windows the
// Regimen folder around it, were made by an administrator. On Windows a
// standard user may create folders in ProgramData, and whoever creates a folder
// owns it and can always grant themselves access again. So a folder that is
// not owned by an administrator (or is a link or junction) is moved aside and
// made fresh before anything private is written into it.
func prepareDataDir() error {
	if os.Getenv("REGIMEN_DATA") == "" {
		for _, dir := range []string{paths.OwnParent(), paths.DataDir()} {
			if dir == "" {
				continue
			}
			if _, err := os.Lstat(dir); err != nil {
				continue // not there yet: we create it
			}
			if problem := safefile.AdminOwnedDir(dir); problem != nil {
				aside := fmt.Sprintf("%s.untrusted-%d", dir, time.Now().Unix())
				if err := os.Rename(dir, aside); err != nil {
					return fmt.Errorf("%v, and it could not be moved aside: %v", problem, err)
				}
				fmt.Println(yellow("    " + problem.Error() + ". Moved it to " + aside + " and made a fresh one."))
			}
		}
	}
	if err := paths.EnsureDataDir(); err != nil {
		return err
	}
	return safefile.AdminOwnedDir(paths.DataDir())
}

// lockDownDataDir: admins and the service only (config holds the pairing secret hash).
func lockDownDataDir() {
	if runtime.GOOS == "windows" {
		dirs := []string{paths.DataDir()}
		if p := paths.OwnParent(); p != "" {
			dirs = []string{p, paths.DataDir()}
		}
		for _, d := range dirs {
			// Owner Administrators for everything inside, then only SYSTEM and
			// Administrators on the ACL (/L: act on links themselves, never follow).
			_ = platform.Run("icacls", d, "/setowner", "*S-1-5-32-544", "/T", "/C", "/L", "/Q")
			_ = platform.Run("icacls", d, "/inheritance:r", "/grant:r", "*S-1-5-18:(OI)(CI)F", "*S-1-5-32-544:(OI)(CI)F", "/C", "/L", "/Q")
		}
		return
	}
	_ = os.Chmod(paths.DataDir(), 0o700)
	// The parent (macOS) holds the program folder too: others need to reach it,
	// for example `regimen-agent status` through /usr/local/bin.
	if p := paths.OwnParent(); p != "" {
		_ = os.Chmod(p, 0o755)
	}
}

// newPairCode gives cfg a fresh typed pairing code that expires like the link.
func newPairCode(cfg *paths.Config) {
	code := PairingCode()
	cfg.PairCode = &code
	cfg.PairExpiresAt = time.Now().Add(LinkLifetime).UnixMilli()
}

// pairCodeLive reports whether the typed code can still be used.
func pairCodeLive(cfg paths.Config) bool {
	return paths.Val(cfg.PairCode) != "" && time.Now().UnixMilli() < cfg.PairExpiresAt
}

func newLink(cfg *paths.Config) string {
	link := PairingCode()
	cfg.LinkCode = &link
	cfg.LinkExpiresAt = time.Now().Add(LinkLifetime).UnixMilli()
	return PairingLink(link)
}

func openPairing(link string, noBrowser bool) {
	if !noBrowser {
		if err := platform.OpenURL(link); err == nil {
			fmt.Println(green("Your browser opens Regimen to connect the agent. Click Connect there if it asks."))
			fmt.Println(dim("If nothing opened, visit this link (valid for 30 minutes, works once):"))
			fmt.Println("  " + link)
			return
		}
	}
	fmt.Println("To connect in one click, open this link in the browser that has the Regimen extension")
	fmt.Println(dim("(valid for 30 minutes, works once):"))
	fmt.Println("  " + link)
}

func install(rest args) exitCode {
	banner()
	if err := prepareDataDir(); err != nil {
		fmt.Fprintln(os.Stderr, red("Could not set up "+paths.DataDir()+": "+err.Error()))
		return 1
	}
	lockDownDataDir()
	// one-time backup of the original hosts file (never overwritten)
	bak := paths.File("hosts.original.bak")
	if _, err := os.Lstat(bak); errors.Is(err, fs.ErrNotExist) {
		if content, err := hosts.Read(hosts.Path()); err == nil {
			_ = safefile.WriteFile(bak, []byte(content), 0o600)
		}
	}
	existing, _ := paths.ReadConfig()
	keep := rest.flag("keep-settings")
	cfg := existing
	switch {
	case pairCodeLive(existing):
		// keep the code that is still valid (someone may be typing it right now)
	case existing.SecretHash == nil:
		newPairCode(&cfg) // not paired yet: a fresh code, the old one expired
	default:
		cfg.PairCode, cfg.PairExpiresAt = nil, 0
	}
	cfg.Strict = rest.flag("strict") || (keep && existing.Strict)
	if v := rest.option("chrome-extension-id"); v != "" {
		cfg.ChromeExtensionID = v
	}
	if v := rest.option("firefox-xpi"); v != "" {
		cfg.FirefoxXpiURL = v
	}
	if cfg.InstalledAt == "" {
		cfg.InstalledAt = paths.ISO(time.Now())
	}
	link := ""
	if paths.Val(cfg.PairCode) != "" {
		link = newLink(&cfg)
	}
	if err := paths.WriteJSON("config.json", cfg); err != nil {
		fmt.Fprintln(os.Stderr, red("Could not save the configuration: "+err.Error()))
		return 1
	}
	service.Uninstall() // reinstall: stop the old copy cleanly first

	fmt.Println("1/4 Copying the program to", paths.ProgramDir())
	exe, err := service.CopyProgram()
	if err != nil {
		fmt.Fprintln(os.Stderr, red("    Could not copy the program: "+err.Error()))
		return 1
	}
	extra := ""
	if cfg.Strict {
		extra = ", extensions page locked"
	}
	fmt.Println("2/4 Setting browser policies (Secure DNS off, no private windows" + extra + ")")
	written := policies.Apply(policies.OptionsFromConfig(cfg))
	fmt.Println(dim(fmt.Sprintf("    %d policy entries written", len(written))))
	fmt.Println("3/4 Registering the background service (starts at boot, restarts on crash)")
	if err := service.Install(exe); err != nil {
		fmt.Fprintln(os.Stderr, red("    Could not register the service: "+err.Error()))
		return 1
	}
	if !strings.EqualFold(exe, paths.FallbackBinary()) {
		// the service runs from the program folder again: drop the copy that kept
		// it running while its package was removed (see uninstall --package-removal)
		_ = safefile.Remove(paths.FallbackBinary())
	}
	fmt.Println("4/4 Checking it runs...")
	var h map[string]any
	for i := 0; i < 10 && h == nil; i++ {
		time.Sleep(700 * time.Millisecond)
		h = health(2 * time.Second)
	}
	if h != nil {
		fmt.Println(green("    Agent is running."))
	} else {
		fmt.Println(yellow("    The agent did not answer yet. It may need a moment, check `regimen-agent status`."))
	}
	fmt.Println()
	if link != "" {
		openPairing(link, rest.flag("no-browser"))
		fmt.Printf("\nOr type the pairing code in Regimen, Settings, Lock agent:  %s\n", green(bold(paths.Val(cfg.PairCode))))
		fmt.Println("Each code works once. After pairing, only the extension holds the connection secret.")
	} else {
		fmt.Println("Already paired with your extension. Run `regimen-agent pair` for a new code.")
	}
	fmt.Println("\nRestart your browsers so the new policies apply.")
	fmt.Println("\nEmergency recovery if the agent ever breaks: " + bold(service.RecoveryHint))
	return 0
}

func readLine(prompt string) string {
	fmt.Print(prompt)
	s, _ := bufio.NewReader(os.Stdin).ReadString('\n')
	return strings.ToLower(strings.TrimSpace(s))
}

func readSnapshot() any {
	var snap any
	if !paths.ReadJSON("snapshot.json", &snap) {
		return nil
	}
	return snap
}

func uninstall(rest args) exitCode {
	if until := lock.LockedUntil(readSnapshot(), time.Now().UnixMilli()); until != 0 {
		fmt.Fprintln(os.Stderr, red("A no-failsafe block is running until "+time.UnixMilli(until).Format("Mon 2 Jan 15:04")+"."))
		fmt.Fprintln(os.Stderr, "You chose no escape hatch for this one. Uninstall after it ends.")
		if rest.flag("package-removal") {
			keepRunningWithoutPackage()
		}
		return 2
	}
	// --yes is for installers and package managers, which ask for confirmation themselves.
	if !rest.flag("yes") && readLine(`Type "uninstall" to remove the Regimen agent: `) != "uninstall" {
		fmt.Println("Cancelled.")
		return 0
	}
	purge := false
	if rest.flag("purge") {
		purge = rest.flag("yes") || readLine(red(`Also permanently delete the agent data (pairing code, backups, logs)? Type "delete my data": `)) == "delete my data"
	}
	service.Uninstall()
	n := policies.Remove()
	if _, err := hosts.Apply(nil); err != nil {
		fmt.Fprintln(os.Stderr, yellow("Could not clean the hosts file: "+err.Error()))
	}
	if rest.flag("keep-program") {
		service.RemoveExtras() // a package manager removes the binary itself
	} else {
		service.RemoveProgram()
	}
	if runtime.GOOS == "darwin" {
		// forget the installer package receipt, so a later .pkg install starts fresh
		_ = platform.Run("pkgutil", "--forget", "app.regimen.agent")
	}
	// The copy that kept the agent running after its package was removed.
	_ = safefile.Remove(paths.FallbackBinary())
	if purge {
		_ = os.RemoveAll(paths.DataDir())
	}
	fmt.Println(green(fmt.Sprintf("Removed. %d policy entries reverted, hosts file cleaned.", n)))
	if !purge {
		fmt.Println(dim("Agent data kept in " + paths.DataDir()))
	}
	return 0
}

// keepRunningWithoutPackage is for package managers that remove the program
// even when uninstall refuses (pacman can't stop a removal). The agent copies
// itself into its data folder, which no package owns, and points the service
// there, so blocking and `recover` keep working until the block ends. After
// that, `sudo regimen-agent uninstall` removes this copy too.
func keepRunningWithoutPackage() {
	exe, err := service.CopyTo(paths.FallbackBinary())
	if err == nil {
		err = service.Install(exe)
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, red("Could not keep the agent running outside the package: "+err.Error()))
		fmt.Fprintln(os.Stderr, "If blocked sites stay blocked after the package is gone, run: "+service.RecoveryHint)
		return
	}
	paths.Log("package removed during a no-failsafe block: agent now runs from", exe)
	fmt.Fprintln(os.Stderr, "The package can be removed, but the agent keeps running from "+exe+" until the block ends.")
	fmt.Fprintln(os.Stderr, "After it ends, remove it with: sudo regimen-agent uninstall")
}

func recoverCmd() exitCode {
	if h := health(2 * time.Second); h != nil && h["ok"] == true && h["failOpen"] != true {
		fmt.Println(yellow("The agent is running normally."))
		fmt.Println("This tool is for when the agent is broken, not for getting around a block.")
		fmt.Println("Use Failsafe in the app if your rule allows it.")
		return 3
	}
	content, _ := hosts.Read(hosts.Path())
	before := len(hosts.ManagedDomains(content))
	if _, err := hosts.Apply(nil); err != nil {
		fmt.Fprintln(os.Stderr, red("Could not write the hosts file: "+err.Error()))
		return 1
	}
	paths.Log(fmt.Sprintf("recover: cleared %d managed hosts entries (agent unreachable)", before))
	fmt.Println(green(fmt.Sprintf("Cleared %d blocked host entries from %s.", before, hosts.Path())))
	fmt.Println("If the agent keeps failing, reinstall it or see TROUBLESHOOTING.md.")
	return 0
}

func status() exitCode {
	if h := health(2 * time.Second); h != nil {
		fo := ""
		if h["failOpen"] == true {
			fo = ", FAIL-OPEN after crashes"
		}
		fmt.Println(green(fmt.Sprintf("Agent running (v%v), %v domain(s) blocked%s", h["version"], h["blocking"], fo)))
	} else {
		fmt.Println(red(fmt.Sprintf("Agent not reachable on 127.0.0.1:%d", paths.Port)))
	}
	if cfg, ok := paths.ReadConfig(); ok {
		line := "Paired with the extension"
		if pairCodeLive(cfg) {
			line = "Pairing code: " + bold(paths.Val(cfg.PairCode)) + dim(" (valid until "+time.UnixMilli(cfg.PairExpiresAt).Format("15:04")+")")
		} else if cfg.SecretHash == nil {
			line = "Not paired. The pairing code expired: run `regimen-agent pair` as admin for a new one."
		} else if t, err := time.Parse(time.RFC3339, cfg.PairedAt); err == nil {
			line += " on " + t.Local().Format("Mon 2 Jan 2006 15:04")
		}
		if cfg.Strict {
			line += " " + dim("(strict mode)")
		}
		fmt.Println(line)
	} else if !platform.IsAdmin() {
		fmt.Println(dim("Run with admin rights to see the pairing code."))
	}
	if snap := readSnapshot(); snap != nil {
		var s struct {
			SentAt int64 `json:"sentAt"`
			Rules  []any `json:"rules"`
		}
		if b, err := json.Marshal(snap); err == nil && json.Unmarshal(b, &s) == nil {
			when := "unknown"
			if s.SentAt > 0 {
				when = time.UnixMilli(s.SentAt).Format("Mon 2 Jan 2006 15:04")
			}
			fmt.Printf("Last sync: %s, %d rule(s)\n", when, len(s.Rules))
		}
	}
	content, _ := hosts.Read(hosts.Path())
	var shown []string
	for _, d := range hosts.ManagedDomains(content) {
		if !strings.HasPrefix(d, "www.") {
			shown = append(shown, d)
		}
	}
	if len(shown) > 0 {
		fmt.Println("Blocked right now:", strings.Join(shown, ", "))
	}
	return 0
}

func pair(rest args) exitCode {
	if err := prepareDataDir(); err != nil {
		fmt.Fprintln(os.Stderr, red("Could not set up "+paths.DataDir()+": "+err.Error()))
		return 1
	}
	cfg, _ := paths.ReadConfig()
	newPairCode(&cfg) // replaces any older code, used or not
	code := paths.Val(cfg.PairCode)
	link := newLink(&cfg)
	if err := paths.WriteJSON("config.json", cfg); err != nil {
		fmt.Fprintln(os.Stderr, red("Could not save the pairing code: "+err.Error()))
		return 1
	}
	openPairing(link, rest.flag("no-browser"))
	fmt.Printf("\nNew pairing code: %s\nOr type it in Regimen, Settings, Lock agent. It works once, for 30 minutes.\n", bold(green(code)))
	return 0
}
