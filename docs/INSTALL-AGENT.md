# Installing the Regimen lock agent

The lock agent is one small program (about 7 MB, nothing else to install). It makes your Regimen blocks work in every browser and app on your computer, and turns off the usual ways around a blocker (Secure DNS, private windows).

Install the browser extension first (Install page, step 1). Then:

1. Download the agent for your computer from the [Install page](https://aryanmotiani.github.io/regimen/#/install). It picks the right file.
2. Open the download and follow the prompts. It asks for your password or admin permission once.
3. Your browser opens Regimen and connects the agent by itself. You should see **Lock agent connected**.
4. Restart your browsers once so the new settings apply.

The installers are free and open source but **not code-signed yet** (signing certificates cost money every year). So Windows and macOS show a warning the first time. Here is what to click.

## Windows

File: `Regimen-Setup.exe` (Windows 10 and 11, works on Intel, AMD and ARM).

1. Your browser may say the file "isn't commonly downloaded". In Edge: click **...** next to the download, **Keep**, then **Show more**, **Keep anyway**. In Chrome: **Keep**.
2. Open the file. If a blue box says **Windows protected your PC**, click **More info**, then **Run anyway**.
3. Click **Yes** when Windows asks whether the app may make changes (it needs admin rights to protect every browser).
4. Click through the setup. At the end your browser opens Regimen and connects.

Remove it later in **Settings, Apps, Installed apps, Regimen lock agent, Uninstall**. It refuses while a no-failsafe block is running.

## macOS

File: `Regimen.pkg` (macOS 11 or newer, Apple silicon and Intel).

1. Double-click the file.
2. If macOS says it **can't verify** the package or that it is **from an unidentified developer**, click **Done** (or **OK**). Then:
   - **macOS 15 Sequoia and newer:** open **System Settings, Privacy & Security**, scroll down, and click **Open Anyway** next to the Regimen message. Enter your password, then **Open**.
   - **macOS 14 and older:** right-click (or Control-click) the file, choose **Open**, then **Open** again.
3. Click through the installer and enter your password. Your browser opens Regimen and connects.

Prefer Terminal? This installs the same package without the Gatekeeper warning:

```bash
curl -fsSL https://github.com/AryanMotiani/regimen/releases/latest/download/install.sh | sh
```

Remove it later with `sudo regimen-agent uninstall` in Terminal.

## Linux

The quickest way, any distribution (picks `.deb`, `.rpm` or the plain program):

```bash
curl -fsSL https://github.com/AryanMotiani/regimen/releases/latest/download/install.sh | sh
```

Or download a package yourself:

- Ubuntu, Debian, Mint: `regimen-agent_amd64.deb` (or `_arm64.deb`), then `sudo apt install ./regimen-agent_amd64.deb`
- Fedora, openSUSE: `regimen-agent.x86_64.rpm` (or `.aarch64.rpm`), then `sudo dnf install ./regimen-agent.x86_64.rpm`

It needs systemd. Remove it with your package manager (`sudo apt remove regimen-agent`), which is refused while a no-failsafe block is running.

Arch Linux (AUR package `regimen-agent-bin`): pacman can't refuse a removal. If you remove the package during a no-failsafe block, the agent copies itself to `/var/lib/regimen/regimen-agent`, keeps blocking until the block ends, and tells you so. Afterwards run `sudo regimen-agent uninstall` to remove that copy.

## The plain program (any system)

Every release also has the bare program: `regimen-agent-windows-amd64.exe`, `-darwin-arm64`, `-linux-amd64` and so on. Run it with no arguments (double-click on Windows) and it installs itself: it asks for admin rights, copies itself to the right place, starts the background service and opens the pairing page. Run it again later to see its status.

## If the browser did not open

Run the pairing step again. It makes a fresh link and a code you can type instead. Both work once and expire after 30 minutes, and a new one replaces any older code:

- Windows: Start menu, **Regimen Lock Agent**
- macOS and Linux: `sudo regimen-agent pair`

Then either open the link it prints, or type the code on the Regimen Install page ("Have a pairing code?") or in Settings, Lock agent.

## Upgrading from FocusGateway

Regimen used to be called FocusGateway. If you installed the FocusGateway lock agent (v1.2.0 or older), just install the Regimen one the usual way for your system. It finds the old agent, stops and removes it (its service, shortcuts and program folder), and moves its data over, so it stays paired with your extension and a running no-failsafe block keeps running. Old blocked-site entries in the hosts file and old browser policy files are cleaned up on the way. On Linux the `regimen-agent` package replaces the `focusgateway-agent` package (and `regimen-agent-bin` replaces `focusgateway-agent-bin` on the AUR).

Update the browser extension too: the new website address (`/regimen/`) only connects to the Regimen extension.

## Is this safe?

The agent needs admin rights because the hosts file and browser policies are system settings. It only listens on your own computer (`127.0.0.1`), only answers the Regimen extension (which proves itself with a secret made when you paired), and never connects to the internet. Everything is open source: [agent/](../agent) is the whole program. See the [privacy policy](https://aryanmotiani.github.io/regimen/privacy.html) and [TROUBLESHOOTING.md](../TROUBLESHOOTING.md) for the emergency recovery tool.
