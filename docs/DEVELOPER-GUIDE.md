# Regimen developer guide

How Regimen is built, how blocking is computed, and how to add the things people ask for most. For the full map of the codebase (diagrams, storage, the lock agent, CI/CD and "where to change what") read [ARCHITECTURE.md](ARCHITECTURE.md) first. For using the app, see the [user guide](USER-GUIDE.md).

## Architecture

```
packages/core   The rules engine and the Backend (pure JavaScript, no DOM). Shared by everything.
apps/web        Vue 3 + Tailwind 4 web app: the landing page, the study room and every page.
extension       Manifest V3 extension. Runs the Backend, blocks with declarativeNetRequest,
                ships a copy of the web app inside (extension/dist/<target>/app).
agent           Optional lock agent in Go. Blocks through the hosts file, sets browser policies.
tests/e2e       Playwright tests that load the built extension (and the agent) into Chromium.
```

### The Backend and dispatch

`packages/core/src/backend.js` is the single authority for every rule. `createBackend({ storage, now })` returns `dispatch(command, payload)`. A command is a handler in the `handlers` table, for example `focus.start`, `rules.create`, `tasks.complete`, `failsafe.confirm`, `blocking.test`.

- Handlers get a draft copy of the state and change it. If they throw an `FGError` (code, message), nothing is saved.
- Commands run one at a time (a promise queue), so two tabs can not race.
- `publicState()` strips the PIN hash and the agent token before the state leaves the Backend.
- Rules that protect you (PIN checks, cooldowns, typed confirmations, conflict checks, forward limits, the empty-window rule) live here, never in the UI.

### Where the Backend runs

`apps/web/src/lib/api.js` picks one of three adapters:

| Mode | When | Transport |
|---|---|---|
| `extension` | The app is opened from the extension (`chrome-extension://.../app/index.html`) | `runtime.sendMessage({ type: 'fg', cmd, payload })` |
| `bridge` | The official hosted app (GitHub Pages) or a localhost copy, with the extension installed | `window.postMessage` to the content script `extension/src/bridge.js`, which forwards to the background. Payloads are sent as JSON copies (Vue reactive arrays can not be structured-cloned) |
| `local` | No extension | The Backend runs in the page, data in `localStorage['regimen:v1']`. Nothing is blocked |

The bridge content script is injected only on the official app's path (`homepage` in the root `package.json`, for example `https://aryanmotiani.github.io/regimen/*`) and on `http://localhost/*` / `http://127.0.0.1/*`. `bridge.js` and the background both check the full URL (origin and path, see `extension/src/app-url.js`). The official app is trusted without a prompt. A localhost origin needs **Allow** in the toolbar popup (`r_approved_origins`): its first `hello` puts it on a pending list and shows `?` on the badge. Other sites never get the bridge. Security notes: [SECURITY.md](../SECURITY.md).

### Which copy of the app the extension opens

The popup, the install welcome and the blocked page open the hosted app when it answers a quick `HEAD` request (`appUrl()` in `extension/src/app-url.js`), so extension users always get the current app, even from an older extension. The copy bundled in `app/` is the fallback: offline, no answer within 1.5 s, no website access (Firefox) or **Use the offline copy** ticked in the popup. `build.mjs` bakes the hosted URL in (`R_APP_URL` overrides `homepage`).

### What was seen: `state.ui`

Tours, the room's first-open tips, one-time notices (`blocking-intro-hidden`, `blocking-start-seen`, `no-extension-seen`) and the shop's "New" marks live in `state.ui` (`packages/core/src/ui.js`), because the website and the extension page are different origins with separate `localStorage`. `ui.mark` adds to it (validated, whitelisted flags, lists capped at 40, never removes). `apps/web/src/lib/seen.js` mirrors it to `localStorage` for guests and older extensions, and once state exists it merges whatever this browser saw into it. `setup.adopt` and `data.import` join both sides, so a room intro taken on the website does not show again in the extension, and the other way round.

`apps/web/src/lib/store.js` holds the reactive `store` (state, mode, clock, toasts, `health`), `call(cmd, payload)`, and computed helpers: `blocks`, `blockingIssue` (why blocking can not work here: `no-extension`, `not-approved`, `no-access`) and `sessionRunning()`.

### The extension

`extension/src/background.js`:

1. Owns the Backend, with state in `storage.local`.
2. After every command that can change blocking (anything not in `PASSIVE`) and every 30 seconds (`fg-tick` alarm), `apply()` runs `computeBlocks(state, now)` and rewrites the dynamic rules: one `redirect` rule per domain for `main_frame` (to `blocked.html?d=<domain>`) and one `block` rule for `sub_frame`. Without host access (Firefox can install without it) it uses `block` rules instead, sets a red `!` badge and opens `grant.html` on install.
3. Redirects tabs already open on a newly blocked site.
4. Sends notifications when a block starts or ends.
5. Mirrors a snapshot to the lock agent if one is paired.

`blocked.js` renders the blocked page. It reports `blocking.hit` for the Test blocking check. `popup.js` shows what is blocked, pending website approvals and permission warnings. `build.mjs` builds `dist/chromium` and `dist/firefox` (same code, different manifest background keys) and zips them, plus `dist/e2e-chromium` for the end-to-end tests (the local preview `http://localhost:4173/` as its hosted app, never zipped).

### The lock agent

`agent/` is one static Go binary. `internal/core` is a Go port of the engine, checked against the JavaScript engine with golden files (`scripts/gen-agent-golden.mjs`). The daemon listens on `127.0.0.1:47621`, receives snapshots from the extension (`/v1/sync`, after pairing with `/v1/pair`), and writes blocked domains between markers in the hosts file. `internal/policies` writes browser policies (Secure DNS off, private windows off). See [INSTALL-AGENT.md](INSTALL-AGENT.md) and [../TROUBLESHOOTING.md](../TROUBLESHOOTING.md).

## Data model

`defaultState()` in `packages/core/src/state.js` lists every key. The important ones:

| Key | What |
|---|---|
| `rules[]` | `{ id, name, mode: 'gated' \| 'hard', siteIds, days: [1..7], start, end (minutes), failsafe }`. `days` are the days a window starts. `end <= start` crosses midnight |
| `tasks[]` | `{ id, title, deadline, priority, tags, ruleId, parentId, status, completedAt, startAt, forwardedUntil, recurrence, ... }` |
| `customSites[]` | `{ id, name, domains }`, next to the curated bundles in `bundles.js` |
| `focus` | `{ active: { workMin, breakMin, iterations, siteIds, startedAt, endsAt } \| null, history[] }` |
| `overrides[]` | Failsafe unlocks: `{ ruleId, until }` |
| `habits[]`, `habitLogs` | Habits and `{ habitId: { 'YYYY-MM-DD': true } }` |
| `log[]`, `stats` | Event history and the running XP and badge counters |
| `ui` | What was already seen: tours, room tips, one-time notices, the shop's "New" marks (`ui.js`) |
| `settings` | Style, theme, notifications, Failsafe wait, lofi (scene, track, mix), room (avatar, placed decor) |
| `runtime` | Things that are not data: rule status for transitions, the `blockTest` of Test blocking |
| `security`, `agent` | PIN and recovery hashes, pairing. Never leave the Backend |

`migrate()` fills in missing keys so old saves keep working. Bump `SCHEMA_VERSION` only for a breaking change.

## How blocking is computed

`computeBlocks(state, now)` in `packages/core/src/engine.js` returns `{ domains, blocks, test }`:

- **Hard block**: blocks while `windowAt(rule, now)` is set, unless a live Failsafe override exists (never for a no-failsafe rule).
- **Task-gated window**: `gatedStatus()` looks at the tasks that belong to the current window. No tasks, or any open task: `blocked`. All done: `unlocked`. The window ended with tasks open: `extended`, still blocking.
- **Focus session**: from `startedAt` to `focusEndsAt()`, breaks included.
- **Test blocking**: `runtime.blockTest` adds `TEST_DOMAIN` (`example.com`) for one minute. It is not a block entry, so the UI never lists it.

Sites become domains with `domainsForSites()`. `declarativeNetRequest` `requestDomains` and `hostMatches()` both match subdomains, so `youtube.com` covers `m.youtube.com`. `explainRule(state, rule, now)` gives the UI a reason code (`window`, `pending`, `no-tasks`, `extended`, `outside`, `done`, `failsafe`), turned into sentences in `apps/web/src/components/help/ruleWhy.js`.

## The web app

- `src/router.js`: hash routes (works on any static host and inside the extension). A guard asks "Stay focused?" when leaving the study room during a session.
- `src/views/*`: one file per page. `Room.vue` is home.
- `src/components/room/*`: the room drawing (`StudyRoom.vue`), windows (`RoomWindow.vue`, `lib/windows.js`), dock, panels and decorate.
- `src/lib/lofi.js`: the generative music and ambience (Web Audio, no audio files).
- `src/lib/rewards.js`: XP pops, level-ups and celebrations.
- `src/lib/dialogs.js` + `DialogHost.vue`: promise based PIN, type-to-confirm and yes/no dialogs.
- `src/components/help/*` and `src/lib/tour.js`: tours, the help drawer, the Blocking is off dialog and Test blocking. See below.

### Tours and help

- A tour is a list of steps in `TOURS` (`src/lib/tour.js`). Each step has a CSS `target` (usually a `data-tour="..."` attribute on the element), a `title` and one or two sentences of `text`. Steps whose target is missing or hidden are skipped. `desktop: true` hides a step on phones.
- `TourHost.vue` shows a page's tour once, the first time the page opens after setup, and never while a dialog is open. Seen tours are saved in `state.ui` and mirrored to `localStorage['regimen:tours-seen']` (`"*"` marks all as seen, handy in tests).
- The help drawer text lives in `src/components/help/helpContent.js`, keyed by page id (`pageFor(path)`). Add a `<HelpButton page="..." />` to a new page's header.
- Copy style: friendly and short, no em dashes, few semicolons.

## Recipes

### Add a theme

1. Add a `theme(...)` entry to `APPEARANCE[mode].themes` in `packages/core/src/appearance.js` (id, name, light or dark, blurb, fonts, swatch).
2. Add its colours, surfaces and fonts in `apps/web/src/style.css` under `[data-theme-id='<id>']`, following an existing theme.
3. Load any new font in the web app and check both Game and Calm pickers in Settings.

### Add a room item

1. Add one line to `UNLOCKS` in `packages/core/src/unlocks.js` with `kind: 'object'`, a level (and a price if the shop sells it), its size `w`, `h` and its `surface`.
2. Add its drawing to `apps/web/src/components/room/art.js` under the same id (SVG in a `0..w, 0..h` box, bottom middle touches the surface).
3. Open Decorate in the study room and check the item sits well on its surface at a few sizes.

### Add a music track

Append a `T(id, style, name, tempo, key, progression, seed, mood)` line to `TRACKS` in `packages/core/src/tracks.js`, with a new id and seed. Progressions are in `P` in the same file. Keep ids stable, they are saved in `settings.lofi.track`. A new music style also needs a `kind: 'music'` line in `unlocks.js` and a groove in `STYLES` in `apps/web/src/lib/lofi.js`.

### Add a badge

Badges are data: add a line (or a tier) to `MILESTONES` in `packages/core/src/milestones.js`. If it counts something new, add the counter in `progress.js` so it survives the capped log.

### Add a site bundle

Add an entry to `packages/core/src/bundles.js` (id, name, category, domains) and run `npm run agent:bundles` so the agent's copy matches.

### Add a storage key

Use the `regimen:` prefix in the web app's `localStorage` and the `r_` prefix in the extension's storage. Never rename an existing key (or an agent file, folder or service name) without a migration, or people lose their data on update. The FocusGateway rename shows how: `apps/web/src/lib/legacy.js`, `extension/src/legacy.js` and `migrateLegacy()` in the agent, see [ARCHITECTURE.md](ARCHITECTURE.md#migrations).

### Add a backend command

Add a handler to `handlers` in `backend.js`. If it can change blocking, leave it out of `PASSIVE` in `extension/src/background.js`, so the rules are rebuilt right after it runs. Add a unit test in `packages/core/test`.

## Testing

```bash
npm test                 # vitest: engine, backend, schedule, progress, room, tracks, blocking
npm run lint             # eslint
npm run format:check     # prettier
npm run check            # lint + format + unit tests + build (what CI runs)
npm run build -w extension && npm run agent:build
npm run test:e2e         # Playwright with the real extension (and the agent)
```

End-to-end tests (`tests/e2e`) load `extension/dist/chromium` into a persistent Chromium context and map fake distracting sites (`youtube.com`, `reddit.com`, `example.com`, ...) to a local server with `--host-resolver-rules`. `blocking.spec.js` drives the app on `localhost:4173` through the bridge: approve in the popup, start a focus session or create a rule in the UI, then check the sites redirect to `blocked.html`. `parity.spec.js` uses `extension/dist/e2e-chromium` (`test.use({ extensionPath: E2E_BUILD })`), where `localhost:4173` plays the official hosted app: the install welcome and the popup open it, it is trusted without Allow, and what was seen carries between it and the bundled copy. `R_SHOTS=<folder>` saves screenshots of those screens.

## Releasing

1. Bump `version` in the root `package.json` (the extension manifest uses it).
2. Push a tag `vX.Y.Z`. `.github/workflows/release.yml` runs the checks, builds the extension zips, the agent for six platforms and the installers, and publishes a GitHub Release with stable file names (`regimen-chromium.zip`, `regimen-firefox.zip`, ...), which the Install page links to.
3. Merging to `master` deploys the website (`pages.yml`). Release the extension soon after website changes that need new extension commands, and check that the Install page downloads work.

See [RELEASING.md](RELEASING.md) for the full checklist, store publishing and secrets.
