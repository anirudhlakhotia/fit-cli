#!/usr/bin/env bash
set -euo pipefail

REPO="couchbaselabs/fit-cli"
INSTALL_DIR="${INSTALL_DIR:-/usr/local/bin}"
BINARY_NAME="fit"
# ci = manually promoted, infrequent; latest (default) = tip of main (every push)
CHANNEL="${CHANNEL:-latest}"

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
  echo "Installing fit-cli ($CHANNEL)..."

  local url="https://github.com/${REPO}/releases/download/${CHANNEL}/${target}"
  local tmp
  tmp="$(mktemp)"

  local size_bytes
  size_bytes="$(curl -fILs "$url" | grep -i '^content-length:' | tail -1 | tr -d '\r' | awk '{print $2}')"
  if [[ -n "$size_bytes" && "$size_bytes" -gt 0 ]]; then
    local size_mb
    size_mb="$(awk "BEGIN {printf \"%.0f\", $size_bytes / 1048576}")"
    echo "Downloading ${size_mb} MB..."
  fi

  curl -fL --progress-bar "$url" -o "$tmp"
  chmod +x "$tmp"

  if [[ -w "$INSTALL_DIR" ]]; then
    mv "$tmp" "${INSTALL_DIR}/${BINARY_NAME}"
  else
    echo "Installing to $INSTALL_DIR requires sudo..."
    sudo mv "$tmp" "${INSTALL_DIR}/${BINARY_NAME}"
  fi

  echo "Installed: $(which fit)"
  fit version

  echo ""
  echo "Next steps:"
  echo "  fit config edit   # one-off configuration (AWS, GitHub credentials)"
  echo "  fit wizard        # launch the interactive wizard"
  echo "  fit help"
}

main "$@"
