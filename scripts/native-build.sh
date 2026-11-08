#!/usr/bin/env bash
# Build the native helper nexo-media.exe on Windows (MSVC), driven from WSL (docs/SPEC-BETA.md §9.3).
#
#   scripts/native-build.sh            release build + unit tests, installs into native/out/
#   scripts/native-build.sh --debug    debug build (still the release CRT, see CMakeLists.txt)
#   scripts/native-build.sh --doctor   check the Windows toolchain and print what's missing
#   scripts/native-build.sh --clean    wipe the Windows build tree first
#
# MSVC, Ninja and cargo misbehave on \\wsl$ paths, so native/ is mirrored to
# %LOCALAPPDATA%\nexo-dev\native\src and built there with the same four commands CI runs:
#   cmake --preset windows-<cfg> && cmake --build --preset windows-<cfg> && ctest --preset windows-<cfg>
#   && cmake --install build/windows-<cfg> --prefix ../out
# The LiveKit SDK is downloaded and checksum-verified by CMake itself (native/livekit-sdk.lock).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONFIG=release
DOCTOR=0
CLEAN=0
for arg in "$@"; do
  case "$arg" in
    --debug) CONFIG=debug ;;
    --doctor) DOCTOR=1 ;;
    --clean) CLEAN=1 ;;
    -h|--help) sed -n '2,13p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done
PRESET="windows-$CONFIG"

if [[ -t 1 ]]; then ok=$'\e[32m✓\e[0m' bad=$'\e[31m✗\e[0m' b=$'\e[1m' off=$'\e[0m'; else ok='✓' bad='✗' b='' off=''; fi
die() { echo "$bad $*" >&2; exit 1; }

command -v cmd.exe >/dev/null || die "cmd.exe not found: run this inside WSL with Windows interop enabled"
command -v wslpath >/dev/null || die "wslpath not found (not WSL?)"

# cmd.exe refuses a UNC working directory; run it from the Windows side.
wincmd() { (cd /mnt/c && cmd.exe /d /c "$@" 2>&1) | tr -d '\r'; }

LOCALAPPDATA_WIN="$(wincmd 'echo %LOCALAPPDATA%' | tail -n1)"
[[ -n "$LOCALAPPDATA_WIN" && "$LOCALAPPDATA_WIN" != "%LOCALAPPDATA%" ]] || die "could not read %LOCALAPPDATA%"
DEV_DIR="$(wslpath "$LOCALAPPDATA_WIN")/nexo-dev/native"
DEV_DIR_WIN="$LOCALAPPDATA_WIN\\nexo-dev\\native"
VSWHERE="/mnt/c/Program Files (x86)/Microsoft Visual Studio/Installer/vswhere.exe"

find_vs() {
  [[ -x "$VSWHERE" ]] || return 1
  (cd /mnt/c && "$VSWHERE" -latest -prerelease -products '*' \
    -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath) | tr -d '\r' | head -n1
}

doctor() {
  local missing=0 vs vcvars sdk_root sdk cmake_ver ninja
  echo "${b}nexo-media toolchain check${off}"
  echo "$ok WSL interop (cmd.exe), %LOCALAPPDATA% = $LOCALAPPDATA_WIN"
  if command -v rsync >/dev/null; then echo "$ok rsync"; else echo "$bad rsync (sudo apt install rsync)"; missing=1; fi
  if [[ -x "$VSWHERE" ]]; then echo "$ok vswhere.exe"; else echo "$bad vswhere.exe not found (install Visual Studio or the Build Tools)"; missing=1; fi
  vs="$(find_vs || true)"
  if [[ -n "$vs" ]]; then
    echo "$ok Visual Studio with MSVC x64: $vs"
    vcvars="$(wslpath "$vs")/VC/Auxiliary/Build/vcvars64.bat"
    if [[ -f "$vcvars" ]]; then echo "$ok vcvars64.bat"; else echo "$bad vcvars64.bat missing"; missing=1; fi
    local vsl; vsl="$(wslpath "$vs")"
    cmake_ver="$(ls "$vsl/Common7/IDE/CommonExtensions/Microsoft/CMake/CMake/bin/cmake.exe" 2>/dev/null || true)"
    if [[ -n "$cmake_ver" ]]; then
      echo "$ok CMake (VS bundled): $(cd /mnt/c && "$cmake_ver" --version | head -n1 | tr -d '\r')"
    elif [[ -x "/mnt/c/Program Files/CMake/bin/cmake.exe" ]]; then
      echo "$ok CMake: $(cd /mnt/c && "/mnt/c/Program Files/CMake/bin/cmake.exe" --version | head -n1 | tr -d '\r')"
    else
      echo "$bad CMake ≥ 3.25 (VS component 'C++ CMake tools for Windows')"; missing=1
    fi
    ninja="$(ls "$vsl/Common7/IDE/CommonExtensions/Microsoft/CMake/Ninja/ninja.exe" 2>/dev/null || true)"
    if [[ -n "$ninja" ]]; then echo "$ok Ninja (VS bundled)"; else echo "$bad Ninja (VS component 'C++ CMake tools for Windows')"; missing=1; fi
  else
    echo "$bad Visual Studio / Build Tools with 'Desktop development with C++' (MSVC x64)"; missing=1
  fi
  sdk_root="/mnt/c/Program Files (x86)/Windows Kits/10/Include"
  sdk="$(ls -d "$sdk_root"/10.* 2>/dev/null | sort -V | tail -n1 || true)"
  if [[ -n "$sdk" && -f "$sdk/cppwinrt/winrt/base.h" ]]; then
    echo "$ok Windows SDK $(basename "$sdk") with C++/WinRT headers"
  else
    echo "$bad Windows 11 SDK with C++/WinRT headers (Include\\<ver>\\cppwinrt)"; missing=1
  fi
  if (cd /mnt/c && curl.exe -fsSI -m 10 https://github.com >/dev/null 2>&1) || curl -fsSI -m 10 https://github.com >/dev/null 2>&1; then
    echo "$ok github.com reachable (LiveKit SDK + nlohmann/json downloads)"
  else
    echo "$bad github.com not reachable: the first configure downloads the LiveKit SDK and nlohmann/json"; missing=1
  fi
  if [[ -f "$ROOT/native/third_party/livekit-sdk-$(sed -n 's/^version=//p' "$ROOT/native/livekit-sdk.lock")/.nexo-sha256" ]] \
     || [[ -f "$DEV_DIR/src/third_party/livekit-sdk-$(sed -n 's/^version=//p' "$ROOT/native/livekit-sdk.lock")/.nexo-sha256" ]]; then
    echo "$ok LiveKit SDK $(sed -n 's/^version=//p' "$ROOT/native/livekit-sdk.lock") already downloaded"
  else
    echo "  LiveKit SDK $(sed -n 's/^version=//p' "$ROOT/native/livekit-sdk.lock") will be downloaded by CMake on the first build"
  fi
  if (( missing )); then echo "${b}Missing pieces above.${off}"; return 1; fi
  echo "${b}All set.${off}"
}

if (( DOCTOR )); then doctor; exit $?; fi

VS_PATH="$(find_vs || true)"
[[ -n "$VS_PATH" ]] || die "Visual Studio with MSVC x64 not found (run scripts/native-build.sh --doctor)"
VCVARS_WIN="$VS_PATH\\VC\\Auxiliary\\Build\\vcvars64.bat"
command -v rsync >/dev/null || die "rsync is required (sudo apt install rsync)"

# 1. Mirror native/ (build trees, out/ and downloads stay on the Windows side between runs).
mkdir -p "$DEV_DIR/src"
rsync -a --delete --exclude '/nexo-media/build/' --exclude '/out/' --exclude '/third_party/' \
  "$ROOT/native/" "$DEV_DIR/src/"
if (( CLEAN )); then rm -rf "$DEV_DIR/src/nexo-media/build/$PRESET"; fi
rm -rf "$DEV_DIR/src/out"

# 2. The four CI commands, inside a VS developer environment.
SCRIPT="$DEV_DIR/build-$CONFIG.cmd"
cat > "$SCRIPT" <<EOF
@echo off
call "$VCVARS_WIN" >nul || exit /b 1
cd /d "$DEV_DIR_WIN\\src\\nexo-media" || exit /b 1
cmake --preset $PRESET || exit /b 1
cmake --build --preset $PRESET || exit /b 1
ctest --preset $PRESET || exit /b 1
cmake --install build/$PRESET --prefix ../out || exit /b 1
EOF
sed -i 's/$/\r/' "$SCRIPT"

echo "→ Building nexo-media ($PRESET) in $DEV_DIR_WIN\\src"
set +e
(cd /mnt/c && cmd.exe /d /c "$DEV_DIR_WIN\\build-$CONFIG.cmd" 2>&1) | tr -d '\r'
status=${PIPESTATUS[0]}
set -e
(( status == 0 )) || die "build failed (exit $status)"

# 3. Bring the install tree back into the repo.
rm -rf "$ROOT/native/out"
mkdir -p "$ROOT/native/out"
cp -r "$DEV_DIR/src/out/." "$ROOT/native/out/"
echo "$ok native/out:"
ls -1 "$ROOT/native/out" | sed 's/^/    /'
