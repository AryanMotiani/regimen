#!/bin/sh
# Regimen lock agent installer for Linux and macOS.
#
#   curl -fsSL https://github.com/AryanMotiani/regimen/releases/latest/download/install.sh | sh
#
# Picks the right package for this computer from the latest GitHub release
# (.deb, .rpm, the macOS .pkg, or the plain binary elsewhere), installs it with
# sudo, and the agent then opens your browser to connect to Regimen.
# Read it first if you like: it is short, and that is a good habit with any
# script you pipe into a shell.
set -eu

REPO="${REGIMEN_REPO:-AryanMotiani/regimen}"
BASE="https://github.com/$REPO/releases/latest/download"

say() { printf '%s\n' "$*"; }
fail() {
  say "Regimen: $*" >&2
  exit 1
}

fetch() { # url file
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL --retry 3 -o "$2" "$1"
  elif command -v wget >/dev/null 2>&1; then
    wget -q -O "$2" "$1"
  else
    fail "needs curl or wget"
  fi
}

SUDO=""
if [ "$(id -u)" -ne 0 ]; then
  command -v sudo >/dev/null 2>&1 || fail "run this as root, or install sudo"
  SUDO="sudo"
fi

case "$(uname -m)" in
  x86_64 | amd64) ARCH=amd64 RPMARCH=x86_64 ;;
  aarch64 | arm64) ARCH=arm64 RPMARCH=aarch64 ;;
  *) fail "unsupported processor $(uname -m). The lock agent runs on 64-bit Intel/AMD and ARM." ;;
esac

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT INT TERM

say "Regimen lock agent: installing from github.com/$REPO"
case "$(uname -s)" in
  Darwin)
    fetch "$BASE/Regimen.pkg" "$TMP/Regimen.pkg"
    say "Installing the package (asks for your password)..."
    $SUDO installer -pkg "$TMP/Regimen.pkg" -target /
    ;;
  Linux)
    if command -v dpkg >/dev/null 2>&1 && command -v apt-get >/dev/null 2>&1; then
      fetch "$BASE/regimen-agent_${ARCH}.deb" "$TMP/regimen-agent.deb"
      say "Installing the .deb package (asks for your password)..."
      $SUDO dpkg -i "$TMP/regimen-agent.deb"
    elif command -v rpm >/dev/null 2>&1 && { command -v dnf >/dev/null 2>&1 || command -v yum >/dev/null 2>&1 || command -v zypper >/dev/null 2>&1; }; then
      fetch "$BASE/regimen-agent.${RPMARCH}.rpm" "$TMP/regimen-agent.rpm"
      say "Installing the .rpm package (asks for your password)..."
      $SUDO rpm -Uvh --replacepkgs "$TMP/regimen-agent.rpm"
    else
      fetch "$BASE/regimen-agent-linux-${ARCH}" "$TMP/regimen-agent"
      chmod +x "$TMP/regimen-agent"
      say "Installing (asks for your password)..."
      $SUDO "$TMP/regimen-agent" install
    fi
    ;;
  *) fail "this script is for Linux and macOS. On Windows, download Regimen-Setup.exe from github.com/$REPO/releases" ;;
esac
say ""
say "Done. Check it any time with: regimen-agent status"
