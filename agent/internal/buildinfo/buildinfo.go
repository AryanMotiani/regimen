// Package buildinfo holds values that release builds set with -ldflags:
//
//	go build -ldflags "-X regimen/agent/internal/buildinfo.Version=1.2.0 \
//	  -X regimen/agent/internal/buildinfo.AppURL=https://example.github.io/regimen/"
package buildinfo

import (
	"os"
	"strings"
)

// Version is reported by /health and the CLI.
var Version = "0.0.0-dev"

// AppURL is the hosted web app the agent opens for one-click pairing.
// It must end with a slash. REGIMEN_APP_URL overrides it (handy for local development).
var AppURL = "https://aryanmotiani.github.io/regimen/"

// App returns the web app URL to open, with a trailing slash.
func App() string {
	u := AppURL
	if v := strings.TrimSpace(os.Getenv("REGIMEN_APP_URL")); v != "" {
		u = v
	}
	if !strings.HasSuffix(u, "/") {
		u += "/"
	}
	return u
}
