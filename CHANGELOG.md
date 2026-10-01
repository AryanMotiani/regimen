# Changelog

All notable changes are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

FocusGateway is now **Regimen**. The website moved to https://aryanmotiani.github.io/regimen/ and the repository to https://github.com/AryanMotiani/regimen.

### Fixed

- Updating from FocusGateway keeps everything. The website copies data saved under the old `focusgateway:*` browser keys to the new names on first load, the extension moves its old `fg_*` storage to `r_*` (PIN, rules, tasks and the lock agent pairing), and the lock agent installer finds an old FocusGateway agent, removes its service and moves its data folder over, so it stays paired and a running no-failsafe block keeps running. Old hosts file entries and policy backups are still recognised, so nothing stale is left behind.
- The Linux `install.sh` and the macOS package's postinstall script work again (the rename had put an invisible byte before `#!/bin/sh`).
- Backups exported by FocusGateway import as before.

### Changed

- The `regimen-agent` `.deb`, `.rpm` and AUR packages replace the old `focusgateway-agent` packages.
- A new README, and new docs: [ARCHITECTURE.md](docs/ARCHITECTURE.md), [DEPLOYMENT.md](docs/DEPLOYMENT.md), [RELEASING.md](docs/RELEASING.md) and [ROADMAP.md](docs/ROADMAP.md). The Netlify and Vercel configs moved to `docs/deploy/` as optional examples, GitHub Pages is the supported host.
- Internal notes, specs and design screenshots left the public repository (they now live in a git-ignored `private/` folder).

## [1.2.0] - 2026-09-26

The extension now opens the current app, and what you have already seen follows you between the website and the extension.

### Fixed

- The extension no longer shows an old app. v1.1.0 shipped a copy of the app built before the clean study room, so after setup the add-on opened every window and the old tutorials. The popup, the install welcome, the blocked page and Failsafe now open the Regimen website when online (always the newest version), and the copy inside the extension when offline or when **Use the offline copy** is ticked in the popup.
- The room intro, the first-open tips and other one-time notices no longer come back when you switch between the website and the extension. They are saved with your data (`state.ui`, new `ui.mark` command), merged with what the browser remembers, and carried over when the website hands its setup to the extension.

### Added

- Blocking page with no rules: "You have not blocked any sites yet" with the three ways to block (task-gated window, hard block, focus session), each with Set one up and Learn more, and "Not now, I will just use the study room".
- A small start card in the room after the intro, once, with the same three choices and Maybe later. It comes before the starter gift, never on top of the intro.
- The Blocking help explains the three ways with an example each.
- Clear signs of why blocking may not work: a one-time "Site blocking needs the free extension" dialog, a trial room notice, a Blocking status checklist (Blocking page, Settings and the red chip) with a fix for each step, a two step approval guide with Check again, and banners for missing website access and an extension older than the site.
- A palette button on every page, the study room included, to change the style, theme and Light or Dark any time.

### Changed

- The study room starts clean: every window waits in the dock, a short 4 step intro runs once, and each window explains itself the first time it opens.
- Light is the default look: new users get Sunny Quest, and old saves that followed the system setting now get the light theme. Saves that picked dark keep a dark theme.

### Security

- The website bridge runs only on the official app (`https://aryanmotiani.github.io/regimen/*`) and on localhost for development, instead of every site. The page's origin and path are checked again before anything is relayed. The official app connects without the Allow step, a localhost copy still asks. PIN checks are unchanged. See SECURITY.md.

## [1.1.0] - 2026-09-25

First public release: the study room home, Game and Calm styles, visual accountability, and the single-file lock agent with installers.

### Changed

- The lock agent is now one small Go program (about 7 MB) instead of a Node.js script. Nothing else to install. Same commands, same protocol, and an existing pairing and data folder carry over.
- The Install page shows one button per step: the right store for your browser (Firefox and Edge, Chrome later) and the right lock agent download for your computer, with the manual steps only where no store listing exists yet.

### Added

- One-click pairing: after installing, the lock agent opens Regimen in your browser with a one-time link (expires after 30 minutes or first use, never sent to a server) and the page connects the agent by itself. Typing the code still works.
- Double-clicking the agent does the natural thing: installs it (asking for admin rights), or opens a fresh pairing link, or shows its status.
- Installers for the lock agent: Windows setup (`Regimen-Setup.exe`, with an Apps & Features entry), macOS package (`Regimen.pkg`, Apple silicon and Intel), Linux `.deb` and `.rpm`, and a one-line `install.sh`. Templates for winget, Homebrew and AUR.
- Privacy policy page (`privacy.html`), store listing texts, checklists and screenshots for Firefox Add-ons, Edge Add-ons and the Chrome Web Store.
- Release pipeline publishes to Edge Add-ons when its API secrets are set, and attaches the source code for Firefox Add-ons review.
- Guide for the "unknown publisher" warnings of the unsigned installers (`docs/INSTALL-AGENT.md`).

### Security

- The lock agent now also refuses requests whose Host header is not loopback, so a web page can't reach it through DNS rebinding.

### Fixed

- Setting up on the website and then installing the extension no longer runs the tutorial a second time. The extension takes over the website's setup (PIN, recovery code, rules, tasks, habits) once you approve the site.
- The lock agent's crash-loop protection no longer crashes itself when it triggers, and it only counts real crashes (not normal restarts).

### Added

- Open source setup: contributing guide, code of conduct, security policy, issue and pull request templates, CI on Windows, macOS and Linux, end-to-end tests, CodeQL, Dependabot and a tag-based release pipeline with optional store publishing.

## [1.0.0] - 2026-09-24

First release: web app, browser extension (Chromium and Firefox) and lock agent.
