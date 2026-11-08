#!/usr/bin/env bash
# Build the Nexo desktop app in WSL and run it on Windows with a Windows Electron binary.
#
#   scripts/win-run.sh               build + launch (logs stream to this terminal)
#   scripts/win-run.sh --no-build    launch the last build
#   NEXO_PROFILE=2 scripts/win-run.sh   second, separate profile (log in as another user)
#   scripts/win-run.sh --remote-debugging-port=9223   extra args are passed to Electron
#   scripts/win-run.sh --native      also build the native helper (scripts/native-build.sh) and copy
#                                    native/out/* into the app's resources/native/ (kept for later runs)
#   NEXO_MEDIA_FAKE=1 scripts/win-run.sh   use the fake helper (desktop/scripts/fake-nexo-media.mjs);
#                                    FAKE_NEXO_MEDIA=crash|encoder-unavailable|source-closed|stall picks a failure
#
# Windows doesn't need Node: the built app in desktop/out is plain JS, so the official
# Electron zip for win32-x64 is downloaded once (checksum-verified) into %LOCALAPPDATA%\nexo-dev.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUILD=1
NATIVE=0
EXTRA_ARGS=()
for arg in "$@"; do
  case "$arg" in
    --no-build) BUILD=0 ;;
    --native) NATIVE=1 ;;
    *) EXTRA_ARGS+=("$arg") ;;
  esac
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
  # Merged, not replaced: resources/native/ (step 3c) must survive, and a running copy may hold it locked.
  [[ -d "$ROOT/desktop/resources" ]] && mkdir -p "$APP_DIR/resources" && cp -r "$ROOT/desktop/resources/." "$APP_DIR/resources/"
  cat > "$APP_DIR/package.json" <<EOF
{ "name": "nexo-dev", "productName": "Nexo Dev", "version": "0.0.0-dev", "main": "./out/main/index.js" }
EOF
fi

# 3b. Runtime node_modules: main require()s uiohook-napi (global push-to-talk), which loads its win32-x64
#     N-API prebuild through node-gyp-build. Copied only when the version changes: a running copy keeps the
#     .node file locked on Windows.
copy_module() { # <package name> <files/dirs inside the package...>
  local name="$1"; shift
  local src dst want have
  src="$(cd "$ROOT/desktop" && node -p "require('path').dirname(require.resolve('$name/package.json'))")"
  dst="$APP_DIR/node_modules/$name"
  want="$(node -p "require('$src/package.json').version")"
  have="$( [[ -f "$dst/package.json" ]] && node -p "require('$dst/package.json').version" 2>/dev/null || true)"
  [[ "$want" == "$have" ]] && return 0
  rm -rf "$dst" && mkdir -p "$dst"
  for item in "$@"; do
    mkdir -p "$dst/$(dirname "$item")"
    cp -r "$src/$item" "$dst/$item"
  done
}
copy_module node-gyp-build package.json index.js node-gyp-build.js LICENSE
copy_module uiohook-napi package.json dist LICENSE prebuilds/win32-x64

# 3c. Native helper (--native): build it on Windows (skipped with --no-build), then copy native/out/* to
#     resources/native/, where main looks for nexo-media.exe in dev. Like uiohook above, files a running copy
#     keeps locked are skipped: unchanged ones aren't touched, and a failed copy only warns.
if [[ $NATIVE == 1 ]]; then
  if [[ $BUILD == 1 ]]; then
    echo "→ Building native helper"
    "$ROOT/scripts/native-build.sh"
  fi
  [[ -f "$ROOT/native/out/nexo-media.exe" ]] || { echo "native/out/nexo-media.exe not found; run without --no-build" >&2; exit 1; }
  mkdir -p "$APP_DIR/resources/native"
  for f in "$ROOT/native/out/"*; do
    dst="$APP_DIR/resources/native/$(basename "$f")"
    [[ -f "$f" ]] || continue
    cmp -s "$f" "$dst" 2>/dev/null && continue
    cp "$f" "$dst.tmp" 2>/dev/null && mv -f "$dst.tmp" "$dst" 2>/dev/null \
      || { rm -f "$dst.tmp"; echo "  ! $(basename "$f") is in use by a running copy; kept the old one" >&2; }
  done
fi

# 3d. Fake helper: main finds it at <app>/scripts/ when NEXO_MEDIA_FAKE=1 (see src/main/native-media/index.ts).
mkdir -p "$APP_DIR/scripts"
cmp -s "$ROOT/desktop/scripts/fake-nexo-media.mjs" "$APP_DIR/scripts/fake-nexo-media.mjs" 2>/dev/null \
  || cp "$ROOT/desktop/scripts/fake-nexo-media.mjs" "$APP_DIR/scripts/fake-nexo-media.mjs"

# Windows processes only see the WSL environment variables listed in WSLENV (/p translates a path).
export WSLENV="${WSLENV:+$WSLENV:}NEXO_MEDIA_FAKE:FAKE_NEXO_MEDIA:NEXO_MEDIA_DEBUG:NEXO_MEDIA_EXE/p:NEXO_MEDIA_FAKE_SCRIPT/p"

# 4. Launch. Each profile gets its own user-data dir, so two copies can log in as different users.
USER_DATA_WIN="$(wslpath -w "$DEV_DIR/profile-$PROFILE")"
echo "→ Launching Nexo (profile $PROFILE) — logs below, Ctrl+C to quit"
cd "$DEV_DIR"
exec "$ELECTRON_DIR/electron.exe" "$(wslpath -w "$APP_DIR")" "--user-data-dir=$USER_DATA_WIN" --nexo-dev "${EXTRA_ARGS[@]}"
