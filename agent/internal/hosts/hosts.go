// Package hosts is the hosts-file layer. Regimen only ever touches the lines
// between its markers, writes atomically (temp file and rename) so a crash can't
// leave a half-written file, and never edits anything else in the file.
package hosts

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"sort"
	"strings"
	"time"

	"regimen/agent/internal/paths"
	"regimen/agent/internal/platform"
	"regimen/agent/internal/safefile"
)

const (
	markerPrefix = "# >>> REGIMEN-MANAGED-START"
	// MarkerStart opens the managed block.
	MarkerStart = "# >>> REGIMEN-MANAGED-START (do not edit; run `regimen-agent recover` if stuck)"
	// MarkerEnd closes the managed block.
	MarkerEnd = "# <<< REGIMEN-MANAGED-END"
)

// Path is the system hosts file. REGIMEN_HOSTS overrides it (tests and development).
func Path() string {
	if v := os.Getenv("REGIMEN_HOSTS"); v != "" {
		return v
	}
	if runtime.GOOS == "windows" {
		root := os.Getenv("SystemRoot")
		if root == "" {
			root = `C:\Windows`
		}
		return filepath.Join(root, "System32", "drivers", "etc", "hosts")
	}
	return "/etc/hosts"
}

// splitLines splits on \r?\n like the JavaScript version.
func splitLines(content string) []string {
	lines := strings.Split(content, "\n")
	for i, l := range lines {
		lines[i] = strings.TrimSuffix(l, "\r")
	}
	return lines
}

// hostLabel is one DNS label: letters, digits and inner hyphens, 1 to 63 long.
var hostLabel = regexp.MustCompile(`^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$`)

// ValidDomain reports whether d is a plain lowercase host name that is safe to
// write into the hosts file: at most 253 characters, at least two labels of 1
// to 63 letters, digits or inner hyphens, and not an IP address. Anything else
// (spaces, newlines, control characters, "#", wildcards) could add or comment
// out other lines, so it never reaches the file.
func ValidDomain(d string) bool {
	if len(d) == 0 || len(d) > 253 {
		return false
	}
	labels := strings.Split(d, ".")
	if len(labels) < 2 {
		return false
	}
	for _, l := range labels {
		if !hostLabel.MatchString(l) {
			return false
		}
	}
	// A numeric last label means an IP address (or nonsense), not a site.
	return strings.Trim(labels[len(labels)-1], "0123456789") != ""
}

// Sanitize lowercases the domains and splits them into valid (sorted, no
// duplicates) and dropped ones.
func Sanitize(domains []string) (valid, dropped []string) {
	seen := map[string]bool{}
	valid = []string{}
	for _, d := range domains {
		l := strings.ToLower(d)
		if !ValidDomain(l) {
			dropped = append(dropped, d)
			continue
		}
		if !seen[l] {
			seen[l] = true
			valid = append(valid, l)
		}
	}
	sort.Strings(valid)
	return valid, dropped
}

// LogDropped writes one log line about domains Sanitize refused (a few of them,
// shortened and quoted, so a hostile value can't forge log lines either).
func LogDropped(dropped []string) {
	if len(dropped) == 0 {
		return
	}
	show := []string{}
	for i, d := range dropped {
		if i == 5 {
			show = append(show, "...")
			break
		}
		if len(d) > 80 {
			d = d[:80] + "..."
		}
		show = append(show, fmt.Sprintf("%q", d))
	}
	paths.Log(fmt.Sprintf("skipped %d invalid domain(s): %s", len(dropped), strings.Join(show, ", ")))
}

// ExpandDomains adds the www. variant of every domain (hosts files have no wildcards).
func ExpandDomains(domains []string) []string {
	set := map[string]bool{}
	for _, d := range domains {
		set[d] = true
		if !strings.HasPrefix(d, "www.") {
			set["www."+d] = true
		}
	}
	out := make([]string, 0, len(set))
	for d := range set {
		out = append(out, d)
	}
	sort.Strings(out)
	return out
}

// StripManaged removes our managed block and trailing blank lines, leaving everything else intact.
func StripManaged(content string) []string {
	var out []string
	inside := false
	for _, line := range splitLines(content) {
		switch {
		case strings.HasPrefix(line, markerPrefix):
			inside = true
		case strings.HasPrefix(line, MarkerEnd):
			inside = false
		case !inside:
			out = append(out, line)
		}
	}
	for len(out) > 0 && out[len(out)-1] == "" {
		out = out[:len(out)-1]
	}
	return out
}

// Render returns the new hosts file content for this set of blocked domains. Pure.
// Invalid domains are left out (see ValidDomain).
func Render(content string, domains []string, eol string) string {
	domains, _ = Sanitize(domains)
	base := StripManaged(content)
	if len(domains) == 0 {
		return strings.Join(base, eol) + eol
	}
	lines := append([]string{}, base...)
	lines = append(lines, "", MarkerStart)
	for _, h := range ExpandDomains(domains) {
		lines = append(lines, "0.0.0.0 "+h, ":: "+h)
	}
	lines = append(lines, MarkerEnd)
	return strings.Join(lines, eol) + eol
}

// ManagedDomains lists the host names inside our block.
func ManagedDomains(content string) []string {
	set := map[string]bool{}
	inside := false
	for _, line := range splitLines(content) {
		switch {
		case strings.HasPrefix(line, markerPrefix):
			inside = true
		case strings.HasPrefix(line, MarkerEnd):
			inside = false
		case inside:
			if f := strings.Fields(line); len(f) > 1 {
				set[f[1]] = true
			}
		}
	}
	out := make([]string, 0, len(set))
	for d := range set {
		out = append(out, d)
	}
	sort.Strings(out)
	return out
}

// Read returns the hosts file, or "" if it does not exist.
func Read(file string) (string, error) {
	b, err := os.ReadFile(file)
	if errors.Is(err, fs.ErrNotExist) {
		return "", nil
	}
	return string(b), err
}

// WriteAtomic replaces the file through a temp file and rename.
// The temp file is created exclusively and without following links.
func WriteAtomic(content, file string) error {
	err := safefile.Replace(file, []byte(content), 0o644)
	if err == nil || runtime.GOOS != "windows" {
		return err
	}
	// Windows can refuse to replace a file that antivirus has open: write in place
	// instead, but never through a link.
	if lerr := safefile.RefuseLink(file); lerr != nil {
		return lerr
	}
	f, oerr := os.OpenFile(file, os.O_WRONLY|os.O_TRUNC, 0o644)
	if oerr != nil {
		return err
	}
	_, werr := f.WriteString(content)
	if cerr := f.Close(); werr == nil {
		werr = cerr
	}
	return werr
}

// EOL is the line ending the hosts file uses on this OS.
func EOL() string {
	if runtime.GOOS == "windows" {
		return "\r\n"
	}
	return "\n"
}

// Apply writes the domain set into the hosts file. It returns true if the file changed.
func Apply(domains []string) (bool, error) { return ApplyTo(Path(), domains) }

// detectEOL returns the line ending style used in content, or the OS default.
func detectEOL(content string) string {
	if strings.Contains(content, "\r\n") {
		return "\r\n"
	}
	if strings.Contains(content, "\n") {
		return "\n"
	}
	return EOL()
}

// ApplyTo is Apply for a given file.
func ApplyTo(file string, domains []string) (bool, error) {
	domains, dropped := Sanitize(domains)
	LogDropped(dropped)
	current, err := Read(file)
	if err != nil {
		return false, err
	}
	// Use the file's own line endings so the comparison next==current is
	// always like-for-like. Avoids rewriting a LF file with CRLF on Windows
	// when no valid domains are supplied.
	eol := detectEOL(current)
	next := Render(current, domains, eol)
	if next == current {
		return false, nil
	}
	if err := WriteAtomic(next, file); err != nil {
		return false, err
	}
	if os.Getenv("REGIMEN_HOSTS") == "" {
		FlushDNS()
	}
	return true, nil
}

// FlushDNS asks the OS to forget cached lookups so the new block applies right away.
func FlushDNS() {
	var cmds [][]string
	switch runtime.GOOS {
	case "windows":
		cmds = [][]string{{"ipconfig", "/flushdns"}}
	case "darwin":
		cmds = [][]string{{"dscacheutil", "-flushcache"}, {"killall", "-HUP", "mDNSResponder"}}
	case "linux":
		cmds = [][]string{{"resolvectl", "flush-caches"}, {"systemd-resolve", "--flush-caches"}, {"nscd", "-i", "hosts"}}
	}
	for _, c := range cmds {
		cmd := exec.Command(c[0], c[1:]...)
		platform.HideWindow(cmd)
		if err := cmd.Start(); err != nil {
			continue
		}
		done := make(chan struct{})
		go func() { _ = cmd.Wait(); close(done) }()
		select {
		case <-done:
		case <-time.After(5 * time.Second):
			_ = cmd.Process.Kill()
		}
	}
}
