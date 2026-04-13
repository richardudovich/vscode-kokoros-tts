#!/usr/bin/env bash

set -euo pipefail

INSTALL_DIR="${1:-$HOME/.local/share/Kokoros}"
REPO_URL="https://github.com/lucasjinreal/Kokoros.git"

echo "Bootstrapping Kokoros into: $INSTALL_DIR"

if ! command -v brew >/dev/null 2>&1; then
  echo "Homebrew is required on macOS for pkg-config, opus, and cmake."
  exit 1
fi

for formula in pkg-config opus cmake; do
  if ! brew list "$formula" >/dev/null 2>&1; then
    echo "Installing missing formula: $formula"
    brew install "$formula"
  fi
done

if [ ! -d "$INSTALL_DIR/.git" ]; then
  mkdir -p "$(dirname "$INSTALL_DIR")"
  git clone "$REPO_URL" "$INSTALL_DIR"
else
  echo "Existing Kokoros checkout found."
fi

cd "$INSTALL_DIR"

export PKG_CONFIG_PATH="/opt/homebrew/lib/pkgconfig:/opt/homebrew/opt/opus/lib/pkgconfig${PKG_CONFIG_PATH:+:$PKG_CONFIG_PATH}"

cargo build --release

echo
echo "Kokoros is ready."
echo "Executable: $INSTALL_DIR/target/release/koko"
echo "Working directory: $INSTALL_DIR"
echo
echo "Set these in VS Code if auto-detection does not find them:"
echo "  kokorosTts.kokorosExecutable = $INSTALL_DIR/target/release/koko"
echo "  kokorosTts.kokorosWorkingDirectory = $INSTALL_DIR"
