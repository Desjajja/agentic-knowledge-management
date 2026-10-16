#!/usr/bin/env bash
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
INSTALL_ROOT="${AKM_INSTALL_ROOT:-$HOME/.local/share/akm/0.1.0}"
BIN_DIR="${AKM_BIN_DIR:-$HOME/.local/bin}"
mkdir -p "$INSTALL_ROOT" "$BIN_DIR"
cp -R "$ROOT_DIR/bin" "$ROOT_DIR/src" "$ROOT_DIR/package.json" "$ROOT_DIR/package-lock.json" "$INSTALL_ROOT/"
(cd "$INSTALL_ROOT" && npm ci --omit=dev)
ln -sfn "$INSTALL_ROOT/bin/akm.js" "$BIN_DIR/akm"
chmod +x "$INSTALL_ROOT/bin/akm.js" "$BIN_DIR/akm"
printf 'Installed akm to %s\n' "$INSTALL_ROOT"
printf 'Ensure %s is on PATH.\n' "$BIN_DIR"
