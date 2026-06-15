#!/usr/bin/env bash
set -euo pipefail

REPO="couchbaselabs/fit-cli"
INSTALL_DIR="${INSTALL_DIR:-/usr/local/bin}"
BINARY_NAME="fit"

detect_target() {
  local os arch
  os="$(uname -s)"
  arch="$(uname -m)"

  case "$os" in
    Linux)  os="linux" ;;
    Darwin) os="darwin" ;;
    *)
      echo "Unsupported OS: $os" >&2
      exit 1
      ;;
  esac

  case "$arch" in
    x86_64)  arch="x64" ;;
    arm64|aarch64) arch="arm64" ;;
    *)
      echo "Unsupported architecture: $arch" >&2
      exit 1
      ;;
  esac

  echo "fit-${os}-${arch}"
}

main() {
  local target
  target="$(detect_target)"

  echo "Detected platform: $target"

  local version
  version="$(curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest" | grep '"tag_name"' | sed 's/.*"tag_name": *"\(.*\)".*/\1/')"

  if [[ -z "$version" ]]; then
    echo "Could not determine latest release version." >&2
    exit 1
  fi

  echo "Installing fit-cli $version..."

  local url="https://github.com/${REPO}/releases/download/${version}/${target}"
  local tmp
  tmp="$(mktemp)"

  curl -fsSL "$url" -o "$tmp"
  chmod +x "$tmp"

  if [[ -w "$INSTALL_DIR" ]]; then
    mv "$tmp" "${INSTALL_DIR}/${BINARY_NAME}"
  else
    echo "Installing to $INSTALL_DIR requires sudo..."
    sudo mv "$tmp" "${INSTALL_DIR}/${BINARY_NAME}"
  fi

  echo "Installed: $(which fit)"
  fit --version 2>/dev/null || true
}

main "$@"
