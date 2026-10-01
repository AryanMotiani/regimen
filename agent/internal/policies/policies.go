// Package policies writes browser policies: the officially supported, admin-level
// way to configure browsers. They close the usual escape routes around a
// hosts-file blocker:
//   - Secure DNS / DNS over HTTPS (would skip the hosts file)
//   - private, incognito and guest windows and new profiles (no extension there)
//   - (strict) the extensions page and developer tools
package policies

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"

	"regimen/agent/internal/paths"
	"regimen/agent/internal/platform"
	"regimen/agent/internal/safefile"
)

// KV is one policy entry. Policies keep their order so files and plists are stable.
type KV struct {
	Key   string
	Value any
}

// Policy is an ordered set of policy entries.
type Policy []KV

// MarshalJSON writes the entries in order.
func (p Policy) MarshalJSON() ([]byte, error) {
	var b bytes.Buffer
	b.WriteByte('{')
	for i, kv := range p {
		if i > 0 {
			b.WriteByte(',')
		}
		k, _ := json.Marshal(kv.Key)
		v, err := json.Marshal(kv.Value)
		if err != nil {
			return nil, err
		}
		b.Write(k)
		b.WriteByte(':')
		b.Write(v)
	}
	b.WriteByte('}')
	return b.Bytes(), nil
}

// Options select what gets written.
type Options struct {
	Strict        bool
	ForceInstall  []string
	FirefoxXpiURL string
}

// FirefoxExtensionID is the add-on id from extension/build.mjs.
const FirefoxExtensionID = "regimen@aryanmotiani.github.io"

// OptionsFromConfig builds Options from config.json.
func OptionsFromConfig(c paths.Config) Options {
	o := Options{Strict: c.Strict, FirefoxXpiURL: c.FirefoxXpiURL}
	if c.ChromeExtensionID != "" {
		o.ForceInstall = []string{c.ChromeExtensionID + ";https://clients2.google.com/service/update2/crx"}
	}
	return o
}

// Chromium is the policy for Chrome, Edge, Brave and Chromium.
func Chromium(o Options) Policy {
	p := Policy{
		{"DnsOverHttpsMode", "off"},
		{"IncognitoModeAvailability", 1},
		{"BrowserGuestModeEnabled", false},
		{"BrowserAddPersonEnabled", false},
	}
	if o.Strict {
		p = append(p,
			KV{"URLBlocklist", []string{"chrome://extensions", "edge://extensions", "brave://extensions", "chrome://flags", "edge://flags", "brave://flags"}},
			KV{"DeveloperToolsAvailability", 2},
		)
	}
	if len(o.ForceInstall) > 0 {
		p = append(p, KV{"ExtensionInstallForcelist", o.ForceInstall})
	}
	return p
}

// Firefox is the policy for Firefox (policies.json).
func Firefox(o Options) Policy {
	p := Policy{
		{"DNSOverHTTPS", Policy{{"Enabled", false}, {"Locked", true}}},
		{"DisablePrivateBrowsing", true},
	}
	if o.Strict {
		p = append(p,
			KV{"BlockAboutAddons", true},
			KV{"BlockAboutConfig", true},
			KV{"BlockAboutProfiles", true},
			KV{"DisableDeveloperTools", true},
		)
	}
	if o.FirefoxXpiURL != "" {
		p = append(p, KV{"ExtensionSettings", Policy{{FirefoxExtensionID, Policy{{"installation_mode", "force_installed"}, {"install_url", o.FirefoxXpiURL}}}}})
	}
	return p
}

// Written records one thing we changed, so uninstall can undo exactly that.
type Written struct {
	Kind string `json:"kind"` // regkey, regvalue or file
	Key  string `json:"key,omitempty"`
	Name string `json:"name,omitempty"`
	Path string `json:"path,omitempty"`
}

func chromiumTargets() []string {
	switch runtime.GOOS {
	case "windows":
		return []string{`SOFTWARE\Policies\Google\Chrome`, `SOFTWARE\Policies\Microsoft\Edge`, `SOFTWARE\Policies\BraveSoftware\Brave`, `SOFTWARE\Policies\Chromium`}
	case "darwin":
		return []string{"com.google.Chrome", "com.microsoft.Edge", "com.brave.Browser", "org.chromium.Chromium"}
	default:
		return []string{
			"/etc/opt/chrome/policies/managed",
			"/etc/chromium/policies/managed",
			"/etc/chromium-browser/policies/managed",
			"/etc/brave/policies/managed",
			"/etc/opt/edge/policies/managed",
		}
	}
}

func firefoxDirs() []string {
	switch runtime.GOOS {
	case "windows":
		pf := paths.ProgramFiles()
		pf86 := os.Getenv("ProgramFiles(x86)")
		if pf86 == "" {
			pf86 = `C:\Program Files (x86)`
		}
		return []string{filepath.Join(pf, "Mozilla Firefox", "distribution"), filepath.Join(pf86, "Mozilla Firefox", "distribution")}
	case "darwin":
		// Firefox on macOS reads its policies from the org.mozilla.firefox
		// preference domain instead (see firefoxPlist).
		return nil
	default:
		return []string{"/etc/firefox/policies", "/usr/lib/firefox/distribution", "/usr/lib64/firefox/distribution"}
	}
}

// ---- Windows registry (through reg.exe, so no extra dependencies)

func reg(args ...string) error { return platform.Run("reg", args...) }

func writeRegistry(key string, p Policy) ([]Written, error) {
	var written []Written
	for _, kv := range p {
		switch v := kv.Value.(type) {
		case []string:
			sub := `HKLM\` + key + `\` + kv.Key
			_ = reg("delete", sub, "/f")
			for i, s := range v {
				if err := reg("add", sub, "/v", strconv.Itoa(i+1), "/t", "REG_SZ", "/d", s, "/f"); err != nil {
					return written, err
				}
			}
			written = append(written, Written{Kind: "regkey", Key: sub})
		default:
			typ, data := "REG_DWORD", ""
			switch x := v.(type) {
			case string:
				typ, data = "REG_SZ", x
			case bool:
				data = "0"
				if x {
					data = "1"
				}
			default:
				data = fmt.Sprint(x)
			}
			if err := reg("add", `HKLM\`+key, "/v", kv.Key, "/t", typ, "/d", data, "/f"); err != nil {
				return written, err
			}
			written = append(written, Written{Kind: "regvalue", Key: `HKLM\` + key, Name: kv.Key})
		}
	}
	return written, nil
}

// ---- macOS managed preferences plist

// managedPrefs is the root-owned folder for managed (MDM style) preferences.
// Chrome, Edge, Brave and Firefox all read their policies from here.
const managedPrefs = "/Library/Managed Preferences"

// firefoxPlist is Firefox's macOS policy file. Firefox reads policies from the
// org.mozilla.firefox preference domain once EnterprisePoliciesEnabled is true,
// with the same names and shapes as policies.json. Writing it here, and not into
// Firefox.app, keeps root away from the app bundle, which the signed-in user
// owns and could have swapped for links.
const firefoxPlist = managedPrefs + "/org.mozilla.firefox.plist"

// FirefoxMac is the Firefox policy as the macOS preference domain wants it.
func FirefoxMac(o Options) Policy {
	return append(Policy{{"EnterprisePoliciesEnabled", true}}, Firefox(o)...)
}

func xmlText(s string) string {
	return strings.NewReplacer("&", "&amp;", "<", "&lt;").Replace(s)
}

func plistValue(v any, indent int) string {
	pad := strings.Repeat("  ", indent)
	switch x := v.(type) {
	case bool:
		return fmt.Sprintf("%s<%t/>", pad, x)
	case int:
		return fmt.Sprintf("%s<integer>%d</integer>", pad, x)
	case string:
		return pad + "<string>" + xmlText(x) + "</string>"
	case []string:
		items := make([]string, len(x))
		for i, s := range x {
			items[i] = plistValue(s, indent+1)
		}
		return pad + "<array>\n" + strings.Join(items, "\n") + "\n" + pad + "</array>"
	case Policy:
		items := make([]string, len(x))
		for i, kv := range x {
			items[i] = pad + "  <key>" + xmlText(kv.Key) + "</key>\n" + plistValue(kv.Value, indent+1)
		}
		return pad + "<dict>\n" + strings.Join(items, "\n") + "\n" + pad + "</dict>"
	}
	return pad + "<string>" + xmlText(fmt.Sprint(v)) + "</string>"
}

// ToPlist renders a policy as a property list.
func ToPlist(p Policy) string {
	return "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">\n<plist version=\"1.0\">\n" +
		plistValue(p, 0) + "\n</plist>\n"
}

func exists(p string) bool {
	_, err := os.Lstat(p)
	return err == nil
}

// backupSuffix marks the copy of a policy file that was there before us.
const backupSuffix = ".regimen-backup"

// legacyBackupSuffix is the backup name used before the rename from
// FocusGateway to Regimen (up to v1.2.0).
const legacyBackupSuffix = ".focusgateway-backup"

// adoptLegacyBackup renames a backup an earlier FocusGateway version made of
// f to the current backup name. Without this an upgrade would back up our own
// old policy file as if it were the original, and uninstall would then restore
// it, leaving Secure DNS and private windows switched off for good. Links are
// never followed.
func adoptLegacyBackup(f string) error {
	old, bak := f+legacyBackupSuffix, f+backupSuffix
	st, err := os.Lstat(old)
	if err != nil || !st.Mode().IsRegular() {
		return nil // nothing to adopt (or a link we leave alone)
	}
	if exists(bak) {
		return nil // a current backup wins: it was made first
	}
	return os.Rename(old, bak)
}

// backupAndWrite writes a policy file as root. It refuses links (at the file
// and at its backup) and folders that a user other than root could change, so
// nobody can point the write at another file. Backups are private (0600): they
// can hold another admin's policies.
func backupAndWrite(f string, content []byte) (Written, error) {
	dir := filepath.Dir(f)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return Written{}, err
	}
	if err := safefile.AdminOwnedDir(dir); err != nil {
		return Written{}, err
	}
	if err := safefile.RefuseLink(f); err != nil {
		return Written{}, err
	}
	if err := safefile.RefuseLink(f + legacyBackupSuffix); err != nil {
		return Written{}, err
	}
	if err := adoptLegacyBackup(f); err != nil {
		return Written{}, err
	}
	bak := f + backupSuffix
	if err := safefile.RefuseLink(bak); err != nil {
		return Written{}, err
	}
	if exists(f) && !exists(bak) {
		b, err := safefile.ReadFile(f)
		if err != nil {
			return Written{}, err
		}
		if err := safefile.WriteFile(bak, b, 0o600); err != nil {
			return Written{}, err
		}
	}
	if err := safefile.WriteFile(f, content, 0o644); err != nil {
		return Written{}, err
	}
	return Written{Kind: "file", Path: f}, nil
}

// restoreOrRemove undoes backupAndWrite: it puts the backup back (readable again,
// 0644, since browsers read policy files as the signed-in user) or deletes our
// file. It never follows a link. Files that an older version wrote into a folder
// a user controls (the Firefox app bundle on macOS) are only deleted when they
// are still plain files.
func restoreOrRemove(f string) error {
	_ = adoptLegacyBackup(f)
	bak := f + backupSuffix
	backup := false
	if st, err := os.Lstat(bak); err == nil && st.Mode().IsRegular() {
		backup = true
	}
	if safefile.AdminOwnedDir(filepath.Dir(f)) != nil {
		// A folder the user controls: never write file content there as root. A
		// rename inside the folder and a delete of a plain file are all we do.
		if backup {
			return os.Rename(bak, f)
		}
		return safefile.Remove(f)
	}
	if backup {
		b, err := safefile.ReadFile(bak)
		if err != nil {
			return err
		}
		if err := safefile.WriteFile(f, b, 0o644); err != nil {
			return err
		}
		return safefile.Remove(bak)
	}
	return safefile.Remove(f)
}

func indentJSON(v any) []byte {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	enc.SetIndent("", "  ")
	_ = enc.Encode(v)
	return bytes.TrimRight(buf.Bytes(), "\n")
}

// MergeFirefox adds our policies to an existing policies.json, keeping everything else.
func MergeFirefox(existing []byte, ff Policy) []byte {
	var doc map[string]any
	d := json.NewDecoder(bytes.NewReader(existing))
	d.UseNumber()
	if d.Decode(&doc) != nil || doc == nil {
		doc = map[string]any{}
	}
	pol, _ := doc["policies"].(map[string]any)
	if pol == nil {
		pol = map[string]any{}
	}
	for _, kv := range ff {
		pol[kv.Key] = kv.Value
	}
	doc["policies"] = pol
	return indentJSON(doc)
}

// Apply writes the policies for every supported browser and records what it wrote.
func Apply(o Options) []Written {
	var previous []Written
	paths.ReadJSON("policies-written.json", &previous)
	var written []Written
	chrome := Chromium(o)
	ff := Firefox(o)
	for _, target := range chromiumTargets() {
		var (
			w   []Written
			err error
		)
		switch runtime.GOOS {
		case "windows":
			w, err = writeRegistry(target, chrome)
		case "darwin":
			var one Written
			if one, err = backupAndWrite(managedPrefs+"/"+target+".plist", []byte(ToPlist(chrome))); err == nil {
				w = []Written{one}
			}
		default:
			var one Written
			if one, err = backupAndWrite(filepath.Join(target, "regimen.json"), indentJSON(chrome)); err == nil {
				w = []Written{one}
			}
		}
		written = append(written, w...)
		if err != nil {
			paths.Log("policy write failed for", target, err.Error())
		}
	}
	if runtime.GOOS == "darwin" {
		if one, err := backupAndWrite(firefoxPlist, []byte(ToPlist(FirefoxMac(o)))); err == nil {
			written = append(written, one)
		} else {
			paths.Log("firefox policy write failed:", err.Error())
		}
	}
	for _, dir := range firefoxDirs() {
		// Only where Firefox is actually installed (Linux /etc/firefox/policies always works).
		if !(runtime.GOOS == "linux" && dir == "/etc/firefox/policies") && !exists(filepath.Dir(dir)) {
			continue
		}
		f := filepath.Join(dir, "policies.json")
		existing, _ := safefile.ReadFile(f)
		one, err := backupAndWrite(f, MergeFirefox(existing, ff))
		if err != nil {
			paths.Log("firefox policy write failed for", dir, err.Error())
			continue
		}
		written = append(written, one)
	}
	if written == nil {
		written = []Written{}
	}
	// Undo files an earlier version wrote that this one no longer writes (like
	// policies.json inside Firefox.app on macOS).
	for _, w := range previous {
		if w.Kind == "file" && !containsFile(written, w.Path) {
			if err := restoreOrRemove(w.Path); err != nil {
				paths.Log("could not remove", w.Path, err.Error())
			}
		}
	}
	_ = paths.WriteJSON("policies-written.json", written)
	return written
}

func containsFile(ws []Written, p string) bool {
	for _, w := range ws {
		if w.Kind == "file" && w.Path == p {
			return true
		}
	}
	return false
}

// Remove undoes what Apply recorded: deletes our registry values and restores or removes our files.
func Remove() int {
	var written []Written
	paths.ReadJSON("policies-written.json", &written)
	for _, w := range written {
		switch w.Kind {
		case "regkey":
			_ = reg("delete", w.Key, "/f")
		case "regvalue":
			_ = reg("delete", w.Key, "/v", w.Name, "/f")
		case "file":
			if err := restoreOrRemove(w.Path); err != nil {
				paths.Log("could not remove", w.Path, err.Error())
			}
		}
	}
	_ = paths.WriteJSON("policies-written.json", []Written{})
	return len(written)
}
