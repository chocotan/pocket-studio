#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIST="$ROOT/dist"
ELECTRON_RESOURCES="$DIST/electron-resources"
PLATFORM="${1:-linux}"

rm -rf "$ELECTRON_RESOURCES" "$DIST/electron"
mkdir -p "$DIST"
mkdir -p "$ELECTRON_RESOURCES/bin"

(
  cd "$ROOT/studio-frontend"
  npm run build
)

(
  cd "$ROOT/user-frontend"
  npm run build
)

SERVER_EXT=""
DAEMON_EXT=""
if [ "$PLATFORM" = "win" ]; then
  SERVER_EXT=".exe"
  DAEMON_EXT=".exe"
fi

go build -trimpath -ldflags="-s -w" -o "$DIST/pocket-studio-server-bin${SERVER_EXT}" "$ROOT/cmd/server"
go build -trimpath -ldflags="-s -w" -o "$DIST/pocket-studio-daemon-bin${DAEMON_EXT}" "$ROOT/cmd/daemon"

if [ "$PLATFORM" = "win" ]; then
  cp "$DIST/pocket-studio-server-bin.exe" "$ELECTRON_RESOURCES/bin/pocket-studio-server.exe"
  cp "$DIST/pocket-studio-daemon-bin.exe" "$ELECTRON_RESOURCES/bin/pocket-studio-daemon.exe"
else
  install -m 0755 "$DIST/pocket-studio-server-bin" "$ELECTRON_RESOURCES/bin/pocket-studio-server"
  install -m 0755 "$DIST/pocket-studio-daemon-bin" "$ELECTRON_RESOURCES/bin/pocket-studio-daemon"
fi

(
  cd "$ROOT/studio-frontend"
  npm run "build:electron:${PLATFORM}"
)

echo "Build artifacts:"
echo "  $DIST/electron"
