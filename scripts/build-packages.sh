#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIST="$ROOT/dist"
ELECTRON_RESOURCES="$DIST/electron-resources"

rm -rf "$ELECTRON_RESOURCES" "$DIST/electron"
mkdir -p "$DIST"
mkdir -p "$ELECTRON_RESOURCES/bin"

(
  cd "$ROOT/web"
  npm run build
)

go build -trimpath -ldflags="-s -w" -o "$DIST/pocket-studio-server-bin" "$ROOT/cmd/server"
go build -trimpath -ldflags="-s -w" -o "$DIST/pocket-studio-daemon-bin" "$ROOT/cmd/daemon"

install -m 0755 "$DIST/pocket-studio-server-bin" "$ELECTRON_RESOURCES/bin/pocket-studio-server"
install -m 0755 "$DIST/pocket-studio-daemon-bin" "$ELECTRON_RESOURCES/bin/pocket-studio-daemon"

(
  cd "$ROOT/web"
  npm run build:electron
)

echo "Build artifacts:"
echo "  $DIST/electron"
