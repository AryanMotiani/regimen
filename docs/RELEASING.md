# Releasing and repository setup

How a Regimen release is made, how the browser store uploads work and which repository settings the workflows expect. The workflows themselves are explained in [ARCHITECTURE.md](ARCHITECTURE.md#cicd).

## Release checklist

1. Make sure `master` is green (CI) and the website deploy worked.
2. Bump the version in the root `package.json`. The web app, the extension manifest and the lock agent all take it from there:

   ```bash
   npm version 1.3.0 --no-git-tag-version
   ```

3. In [CHANGELOG.md](../CHANGELOG.md), move the **Unreleased** notes under the new version with today's date.
4. Commit, tag and push:

   ```bash
   git commit -am "release: v1.3.0"
   git tag v1.3.0
   git push origin master v1.3.0
   ```

5. Watch **Actions, Release**. When it is done, open the [Install page](https://aryanmotiani.github.io/regimen/#/install) and check that every download link works.
6. If a store job ran, check the store dashboards for the review status.
7. Package managers (winget, Homebrew, AUR) are templates in [packaging/](../packaging/README.md). Update their version and checksums (from `SHA256SUMS.txt` of the release) and submit them by hand.

Release the extension soon after website changes that need new extension commands: the hosted site is always the newest version, and an older extension shows the "Update your extension" banner.

## What the release workflow does

`.github/workflows/release.yml` runs on tags like `v1.3.0`:

1. checks that the tag matches `package.json`, runs `npm run check`, the Firefox add-on lint and the Go tests,
2. builds the lock agent for Windows, macOS and Linux (x64 and ARM64) with the version and the website URL (`homepage` in `package.json`) embedded,
3. builds `Regimen-Setup.exe` (NSIS) and the `.deb` and `.rpm` packages (nfpm) on Ubuntu, and the universal `Regimen.pkg` on a macOS runner,
4. publishes a GitHub Release with every file under a **stable name** plus `SHA256SUMS.txt`. The Install page links to `releases/latest/download/<name>`, so it always serves the newest,
5. publishes to the browser stores whose secrets exist (below).

Nothing is code-signed yet, which is fine: [INSTALL-AGENT.md](INSTALL-AGENT.md) explains the one extra click on Windows and macOS. To sign later, add a signing step for the `.exe` (Authenticode) and the `.pkg` (`productsign` and notarization, which needs the paid Apple Developer Program) before the publish job.

## Browser stores

| Store | Cost | Checklist |
|---|---|---|
| Firefox Add-ons | free | [store/CHECKLIST-FIREFOX.md](store/CHECKLIST-FIREFOX.md) |
| Edge Add-ons | free | [store/CHECKLIST-EDGE.md](store/CHECKLIST-EDGE.md) |
| Chrome Web Store | one-time 5 USD | [store/CHECKLIST-CHROME.md](store/CHECKLIST-CHROME.md) |

Listing text, permission justifications and data disclosures: [store/LISTING.md](store/LISTING.md). Screenshots: `docs/store/screenshots/` (regenerate with `npm run store:screenshots` after UI changes). Privacy policy: `apps/web/public/privacy.html`, live at https://aryanmotiani.github.io/regimen/privacy.html.

The first upload to each store is by hand, so the listing exists. After approval:

1. Put the listing URL in `apps/web/src/config.js` (`FIREFOX_ADDONS_URL`, `EDGE_STORE_URL`, `CHROME_STORE_URL`). The Install page then shows a one-click store button to people on that browser, and the manual steps only where no listing exists.
2. Add the API secrets below so every release uploads itself.

### Repository secrets

Settings, Secrets and variables, **Actions**, New repository secret. Each store job in `release.yml` skips itself while its first secret is missing, so forks and new repositories are not affected.

| Store | Secret | Where to get it |
|---|---|---|
| Firefox Add-ons | `AMO_JWT_ISSUER` | addons.mozilla.org, Developer Hub, Tools, Manage API Keys: "JWT issuer" |
| | `AMO_JWT_SECRET` | same page: "JWT secret" |
| Edge Add-ons | `EDGE_PRODUCT_ID` | Partner Center, your extension, Overview: Product ID |
| | `EDGE_CLIENT_ID` | Partner Center, Microsoft Edge, **Publish API**: Client ID (v1.1 API) |
| | `EDGE_API_KEY` | same page: API key. It expires, so renew it before the date shown |
| Chrome Web Store | `CWS_EXTENSION_ID` | the item ID in the developer dashboard |
| | `CWS_CLIENT_ID`, `CWS_CLIENT_SECRET`, `CWS_REFRESH_TOKEN` | a Google Cloud OAuth client, steps at https://github.com/fregante/chrome-webstore-upload-keys |

The Firefox job signs with `web-ext sign --channel listed` and attaches the source archive (the extension bundles minified code, so AMO asks for it, see [store/AMO_REVIEWER_NOTES.md](store/AMO_REVIEWER_NOTES.md)). The Edge job uses the Edge Add-ons API v1.1: it uploads the Chromium zip to the draft, waits for processing and submits it for review. The Chrome job uploads with `chrome-webstore-upload-cli` and publishes.

Once a store listing exists, the lock agent can force-install the extension so it can't be removed: `regimen-agent install --chrome-extension-id <id>` (and `--firefox-xpi <url>` for Firefox).

Store reviewers ask why the extension needs access to all sites: it is needed to block any site the user chooses and to redirect open tabs when a block starts. The full answers are in [store/LISTING.md](store/LISTING.md).

## Repository settings

One-time settings on github.com that the workflows and docs expect:

- **Actions**, General: allow all actions. Under "Workflow permissions" keep "Read repository contents" (each workflow asks for more only where it needs it).
- **Pages**: Source **GitHub Actions**. See [DEPLOYMENT.md](DEPLOYMENT.md).
- **Rules**, Rulesets, a branch ruleset for the default branch: restrict deletions, block force pushes, require a pull request (1 approval), require the status checks `Lint and format`, `Build web app and extension`, `End-to-end (extension in Chromium)`, `Lock agent cross build`, and the `Unit tests` and `Lock agent (Go, ...)` jobs.
- **Security**: Dependabot alerts and security updates, **Private vulnerability reporting** (SECURITY.md points to it), secret scanning with push protection.
- **General, Features**: Discussions on (the issue template links to it).
- **General, Pull Requests**: allow squash merging, automatically delete head branches.
- **About** (the gear on the repository home page): a description, the website URL and topics such as `focus`, `productivity`, `site-blocker`, `browser-extension`, `pomodoro`, `students`, `vue`.
- **Issues, Labels**: `good first issue`, `help wanted`, `site-bundle`, `triage`.

If you fork or rename the repository, `npm run set-repo -- <username> [repo-name]` updates the links.
