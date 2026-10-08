#!/bin/sh
# Installs the `trama` CLI (macOS, Linux). Verifies the download against the release's SHA256SUMS.
#
#   curl -fsSL https://raw.githubusercontent.com/alessandrobrunoh/trama/main/cli/install/install.sh | sh
#
# Environment:
#   TRAMA_VERSION      version to install, e.g. 0.1.0 (default: the latest stable CLI release)
#   TRAMA_INSTALL_DIR  where to put the binary (default: ~/.local/bin)
#   TRAMA_REPO         GitHub repository (default: alessandrobrunoh/trama)
#   TRAMA_RELEASE_BASE URL of a directory that holds the release assets (mirrors, testing)
set -eu

REPO="${TRAMA_REPO:-alessandrobrunoh/trama}"
INSTALL_DIR="${TRAMA_INSTALL_DIR:-$HOME/.local/bin}"

say() { printf '%s\n' "$*" >&2; }
fail() { say "install: $*"; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

have curl || fail "curl is required"

os=$(uname -s)
arch=$(uname -m)
case "$os" in
  Linux) os_part="unknown-linux-gnu" ;;
  Darwin) os_part="apple-darwin" ;;
  *) fail "unsupported OS '$os' (on Windows use install.ps1)" ;;
esac
case "$arch" in
  x86_64 | amd64) arch_part="x86_64" ;;
  arm64 | aarch64) arch_part="aarch64" ;;
  *) fail "unsupported CPU '$arch'" ;;
esac
# An x86_64 shell running under Rosetta still wants the native build.
if [ "$os" = "Darwin" ] && [ "$arch_part" = "x86_64" ] && [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || echo 0)" = "1" ]; then
  arch_part="aarch64"
fi
target="$arch_part-$os_part"
asset="trama-$target"

version="${TRAMA_VERSION:-}"
if [ -z "$version" ]; then
  say "Looking for the latest release..."
  # Stable CLI tags only: cli-v1.2.3 (no -rc suffixes).
  version=$(curl -fsSL "https://api.github.com/repos/$REPO/releases?per_page=50" |
    grep -o '"tag_name": *"cli-v[0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*"' |
    head -n 1 | sed 's/.*"cli-v\([^"]*\)"/\1/') || true
  [ -n "$version" ] || fail "could not find a CLI release in $REPO (set TRAMA_VERSION)"
fi
version="${version#v}"

base="${TRAMA_RELEASE_BASE:-https://github.com/$REPO/releases/download/cli-v$version}"

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT INT TERM

say "Downloading trama ${version} for ${target}..."
curl -fsSL "$base/$asset" -o "$tmp/$asset" || fail "no build for $target in release $version"
curl -fsSL "$base/SHA256SUMS" -o "$tmp/SHA256SUMS" || fail "release $version has no SHA256SUMS; refusing to install an unverified binary"

expected=$(grep " \*\{0,1\}$asset\$" "$tmp/SHA256SUMS" | head -n 1 | cut -d ' ' -f 1)
[ -n "$expected" ] || fail "SHA256SUMS does not list $asset"
if have sha256sum; then
  actual=$(sha256sum "$tmp/$asset" | cut -d ' ' -f 1)
elif have shasum; then
  actual=$(shasum -a 256 "$tmp/$asset" | cut -d ' ' -f 1)
else
  fail "sha256sum or shasum is required to verify the download"
fi
[ "$expected" = "$actual" ] || fail "checksum mismatch (expected $expected, got $actual); nothing was installed"

mkdir -p "$INSTALL_DIR"
chmod 755 "$tmp/$asset"
# Replace atomically: a running `trama` keeps working.
mv -f "$tmp/$asset" "$INSTALL_DIR/trama.new.$$"
mv -f "$INSTALL_DIR/trama.new.$$" "$INSTALL_DIR/trama"

say "Installed ${INSTALL_DIR}/trama"
case ":$PATH:" in
  *":$INSTALL_DIR:"*) ;;
  *) say "Add it to your PATH:  export PATH=\"$INSTALL_DIR:\$PATH\"" ;;
esac
say "Next:  trama login      (then \`trama skill install\` so your coding agent learns it)"
