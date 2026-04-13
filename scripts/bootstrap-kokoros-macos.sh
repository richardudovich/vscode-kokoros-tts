#!/usr/bin/env bash

set -euo pipefail

INSTALL_DIR="${1:-$HOME/.local/share/Kokoros}"
REPO_URL="https://github.com/lucasjinreal/Kokoros.git"

echo "Bootstrapping Kokoros into: $INSTALL_DIR"

if [ "$(uname -s)" != "Darwin" ]; then
  echo "This installer currently supports macOS only."
  exit 1
fi

if ! xcode-select -p >/dev/null 2>&1; then
  echo "Installing Xcode Command Line Tools..."
  xcode-select --install || true
  echo "Finish the Command Line Tools install if prompted, then run the installer again."
  exit 1
fi

if ! command -v brew >/dev/null 2>&1; then
  echo "Installing Homebrew..."
  NONINTERACTIVE=1 /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
fi

if [ -x /opt/homebrew/bin/brew ]; then
  eval "$(/opt/homebrew/bin/brew shellenv)"
elif [ -x /usr/local/bin/brew ]; then
  eval "$(/usr/local/bin/brew shellenv)"
fi

if ! command -v git >/dev/null 2>&1; then
  echo "Installing missing formula: git"
  brew install git
fi

if ! command -v cargo >/dev/null 2>&1; then
  echo "Installing Rust toolchain..."
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
fi

if [ -f "$HOME/.cargo/env" ]; then
  # shellcheck source=/dev/null
  . "$HOME/.cargo/env"
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
  echo "Existing Kokoros checkout found, updating..."
  git -C "$INSTALL_DIR" fetch --all --tags
  git -C "$INSTALL_DIR" pull --ff-only
fi

cd "$INSTALL_DIR"

export PATH="$HOME/.cargo/bin:$PATH"
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
