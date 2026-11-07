#!/usr/bin/env bash
# Build the Nexo desktop app in WSL and run it on Windows with a Windows Electron binary.
#
#   scripts/win-run.sh               build + launch (logs stream to this terminal)
#   scripts/win-run.sh --no-build    launch the last build
#   NEXO_PROFILE=2 scripts/win-run.sh   second, separate profile (log in as another user)
#   scripts/win-run.sh --remote-debugging-port=9223   extra args are passed to Electron
#
# Windows doesn't need Node: the built app in desktop/out is plain JS, so the official
# Electron zip for win32-x64 is downloaded once (checksum-verified) into %LOCALAPPDATA%\nexo-dev.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUILD=1
EXTRA_ARGS=()
for arg in "$@"; do
  if [[ "$arg" == "--no-build" ]]; then BUILD=0; else EXTRA_ARGS+=("$arg"); fi
done

command -v cmd.exe >/dev/null || { echo "cmd.exe not found: this script must run inside WSL with Windows interop" >&2; exit 1; }

LOCALAPPDATA_WIN="$(cmd.exe /c 'echo %LOCALAPPDATA%' 2>/dev/null | tr -d '\r')"
DEV_DIR="$(wslpath "$LOCALAPPDATA_WIN")/nexo-dev"
VERSION="$(node -p "require('$ROOT/node_modules/electron/package.json').version")"
ZIP_NAME="electron-v${VERSION}-win32-x64.zip"
ELECTRON_DIR="$DEV_DIR/electron-v${VERSION}"
PROFILE="${NEXO_PROFILE:-1}"
APP_DIR="$DEV_DIR/app"

mkdir -p "$DEV_DIR"

# 1. Windows Electron (once per version)
if [[ ! -f "$ELECTRON_DIR/electron.exe" ]]; then
  echo "→ Downloading $ZIP_NAME"
  expected="$(node -p "require('$ROOT/node_modules/electron/checksums.json')['$ZIP_NAME'] || ''")"
  [[ -n "$expected" ]] || { echo "No checksum for $ZIP_NAME in electron/checksums.json" >&2; exit 1; }
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' EXIT
  curl -fL --progress-bar -o "$tmp/$ZIP_NAME" "https://github.com/electron/electron/releases/download/v${VERSION}/${ZIP_NAME}"
  actual="$(sha256sum "$tmp/$ZIP_NAME" | cut -d' ' -f1)"
  [[ "$actual" == "$expected" ]] || { echo "Checksum mismatch for $ZIP_NAME" >&2; exit 1; }
  rm -rf "$ELECTRON_DIR.partial" && mkdir -p "$ELECTRON_DIR.partial"
  unzip -q "$tmp/$ZIP_NAME" -d "$ELECTRON_DIR.partial"
  mv "$ELECTRON_DIR.partial" "$ELECTRON_DIR"
fi

# 2. Build in WSL
if [[ $BUILD == 1 ]]; then
  echo "→ Building desktop app"
  (cd "$ROOT" && npm run build -w desktop --silent)
fi
[[ -f "$ROOT/desktop/out/main/index.js" ]] || { echo "No build found; run without --no-build" >&2; exit 1; }

# 3. Copy the bundle to the Windows filesystem (Electron on Windows can't load from \\wsl$ reliably).
#    Skipped with --no-build so a second profile doesn't overwrite files a running copy is using.
if [[ $BUILD == 1 || ! -f "$APP_DIR/out/main/index.js" ]]; then
  rm -rf "$APP_DIR/out"
  mkdir -p "$APP_DIR"
  cp -r "$ROOT/desktop/out" "$APP_DIR/out"
  [[ -d "$ROOT/desktop/resources" ]] && rm -rf "$APP_DIR/resources" && cp -r "$ROOT/desktop/resources" "$APP_DIR/resources"
  cat > "$APP_DIR/package.json" <<EOF
{ "name": "nexo-dev", "productName": "Nexo Dev", "version": "0.0.0-dev", "main": "./out/main/index.js" }
EOF
fi

# 4. Launch. Each profile gets its own user-data dir, so two copies can log in as different users.
USER_DATA_WIN="$(wslpath -w "$DEV_DIR/profile-$PROFILE")"
echo "→ Launching Nexo (profile $PROFILE) — logs below, Ctrl+C to quit"
cd "$DEV_DIR"
exec "$ELECTRON_DIR/electron.exe" "$(wslpath -w "$APP_DIR")" "--user-data-dir=$USER_DATA_WIN" --nexo-dev "${EXTRA_ARGS[@]}"
