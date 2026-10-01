# Contributing to Regimen

Thanks for helping! Regimen is built by and for students who want their focus back. Every kind of help counts: code, adding sites to the block list, testing on your browser or OS, design, docs and translations.

## Ground rules

- Be kind. We follow the [Code of Conduct](CODE_OF_CONDUCT.md).
- **Found a way around a block?** That is a security issue for us. Report it privately (see [SECURITY.md](SECURITY.md)), not in a public issue.
- Small, focused pull requests get reviewed fastest. For anything big, open an issue first so we can agree on the approach.

## Good first contributions

- **Add a site to the block list.** Edit `packages/core/src/bundles.js`, add the site's domains (main site, CDN, video, API), and open a PR. Look for issues labelled `site-bundle` or `good first issue`.
- Try Regimen on a browser or OS we have not tested (Firefox, Safari with the agent, macOS, Windows) and report what breaks.
- Improve wording in the app. Keep it short, plain and friendly.

## Set up

You need Node.js 20.19 or newer (`.nvmrc` pins the version we use) and Git. Working on the lock agent also needs [Go](https://go.dev/dl/) 1.24 or newer.

```bash
git clone https://github.com/AryanMotiani/regimen.git
cd regimen
npm install
npm run dev          # web app at http://localhost:5173 (standalone mode, no blocking)
```

To work on blocking, build and load the extension:

```bash
npm run build        # builds apps/web and extension/dist/{chromium,firefox}
```

Then in Chrome open `chrome://extensions`, turn on Developer mode, click **Load unpacked** and pick `extension/dist/chromium`. After a change, run `npm run build` again and press the reload icon on the extension card. In Firefox use `about:debugging`, **Load Temporary Add-on**, and pick `extension/dist/firefox/manifest.json`.

### The lock agent (Go)

The agent is a Go module in `agent/` with no dependencies outside the standard library:

```
agent/cmd/regimen-agent   main package (the CLI)
agent/internal/cli             commands: install, pair, status, recover, policies, uninstall, run
agent/internal/daemon          HTTP API on 127.0.0.1:47621 (/health, /v1/pair, /v1/sync) and the hosts loop
agent/internal/core            Go port of the engine parts it needs (windows, task gating, computeBlocks)
agent/internal/lock            snapshot validation and the "running no-failsafe rule can't be weakened" merge
agent/internal/hosts           hosts file rendering and atomic writes
agent/internal/policies        browser policies (registry, plist, JSON)
agent/internal/service         Task Scheduler, launchd and systemd registration
agent/internal/platform        admin checks, elevation, opening the browser
agent/internal/assets          embedded copies of the site bundles, TROUBLESHOOTING.md and LICENSE
```

```bash
npm run agent:test            # go vet + go test (or: cd agent && go test ./...)
npm run agent:build           # agent/dist/regimen-agent-<os>-<arch>, all six targets
cd agent && go run ./cmd/regimen-agent help
```

Try it without touching your real hosts file or needing admin rights. Put a `config.json` with a pairing code in a temp folder and point the agent at a fake hosts file:

```bash
mkdir -p /tmp/fg && echo '{"pairCode":"ABCD-EFGH-JKLM-NPQR-STUV"}' > /tmp/fg/config.json
cd agent && REGIMEN_DATA=/tmp/fg REGIMEN_HOSTS=/tmp/hosts go run ./cmd/regimen-agent run
curl http://127.0.0.1:47621/health
```

`REGIMEN_APP_URL=http://localhost:5173` makes `pair` and `install` open your local dev server instead of the hosted app.

Two things keep the Go agent honest against the JavaScript engine:

- **Embedded assets.** The agent embeds `packages/core/src/bundles.js` as JSON. After editing bundles, `TROUBLESHOOTING.md` or `LICENSE`, run `npm run agent:bundles`. A unit test fails if you forget.
- **Golden tests.** `agent/internal/core/testdata/golden.json` holds random snapshots with the answers of the JavaScript engine. If you change engine rules in `packages/core`, change the Go port too and regenerate: `TZ=America/New_York node scripts/gen-agent-golden.mjs`.

The end-to-end test `tests/e2e/agent.spec.js` pairs the real extension with the real agent binary through the one-click link. It runs when `agent/dist` has a binary for your system (`npm run agent:build -- --target linux/amd64`).

## Project map

| Folder | What lives there |
|---|---|
| `packages/core` | The rules engine and backend. Pure JavaScript, no browser APIs. **All rules live here** (PIN, Failsafe, conflicts, forward limits). |
| `apps/web` | Vue 3 + Tailwind app (landing page, dashboard, study room) |
| `extension` | Manifest V3 extension. Runs the backend, applies `declarativeNetRequest` rules |
| `agent` | Lock agent in Go, one static binary (hosts file, browser policies, OS service) |
| `packaging` | Installers for the agent (NSIS, pkg, deb/rpm, install.sh) and package manager templates |
| `tests/e2e` | Playwright tests that load the real extension into Chromium |

The UI never enforces a rule by itself. If you add a rule, put it in `packages/core/src/backend.js` and test it there. See the "How it fits together" section of the README for more.

## Before you open a pull request

```bash
npm run check        # lint + format check + unit tests + build
npm run agent:test   # if you touched agent/
npm run test:e2e     # end-to-end tests (needs `npm run build` first)
```

`npm run format` and `npm run lint:fix` fix most style problems automatically.

- **Tests:** new behaviour in `packages/core` needs a unit test (Vitest), new behaviour in `agent` a Go test. Test through the public seams: `computeBlocks(state, now)`, `createBackend(...).dispatch(command, payload)`, and in the agent `hosts.Render`, `lock.Merge` and the HTTP handler (`daemon_test.go`). Pass a fixed `now` so tests never depend on the real clock.
- **Bypass check:** if your change touches blocking, the PIN, Failsafe, task rules or the agent, write down in the PR how someone might misuse it and why they can't.
- **Commits:** we like [Conventional Commits](https://www.conventionalcommits.org/) (`feat: add Letterboxd bundle`, `fix(agent): retry launchctl bootstrap`). Not required, but it keeps the history readable.
- **Changelog:** add a line under "Unreleased" in `CHANGELOG.md` for anything users will notice.
- **Writing style:** UI text and docs use plain language and avoid em dashes.

CI runs lint, unit tests on Windows, macOS and Linux (JavaScript and Go), a cross build of the agent, the build, a Firefox add-on lint and the end-to-end tests on every pull request. A maintainer reviews once CI is green.

## Releasing (maintainers)

1. Move the "Unreleased" notes in `CHANGELOG.md` under a new version heading.
2. Bump the version: `npm version 1.2.0 --no-git-tag-version` (this updates `package.json`, the extension manifest version comes from it).
3. Commit, then tag and push: `git tag v1.2.0 && git push origin master --tags`.
4. The Release workflow checks the tag matches `package.json`, runs everything, builds the extension zips, the agent binaries and installers (Windows, macOS, Linux), and publishes a GitHub Release. If store secrets are configured it also uploads to addons.mozilla.org, Edge Add-ons and the Chrome Web Store.

Store accounts, secrets and the full release flow are in [docs/RELEASING.md](docs/RELEASING.md). How the whole codebase fits together: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).
