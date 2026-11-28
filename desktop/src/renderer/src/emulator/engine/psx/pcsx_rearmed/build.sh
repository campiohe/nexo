#!/usr/bin/env bash
# Builds the PlayStation core the Emulator plugin runs: libretro's PCSX ReARMed (pinned below, GPL-2.0) + Nexo's
# own tiny libretro frontend (nexo_frontend.c), compiled with Emscripten into ONE ES module with the WebAssembly
# embedded (SINGLE_FILE: the packaged app loads the renderer from file://, where fetch() can't read a .wasm file).
#
# The core is built by its own Makefile.libretro (platform=emscripten: interpreter CPU, no threads, the "neon"
# software GPU with its SSE paths mapped to WebAssembly SIMD, libchdr for .chd, zlib for .pbp), with the patches in
# ./patches.
#
# Output: desktop/src/renderer/public/emulator/pcsx_rearmed/pcsx_rearmed.js (+ LICENSE.txt), copied as-is into
# out/renderer/emulator/pcsx_rearmed/ by Vite and loaded at runtime with import() (engine/psx/core.ts).
#
# GPL: the module is a GPL-2.0 work. Nexo ships it as a separate file next to its MIT code; whoever distributes a
# Nexo build must also offer the corresponding source: the pinned commit below, the patches, this script and
# nexo_frontend.c.
#
# Usage: desktop/src/renderer/src/emulator/engine/psx/pcsx_rearmed/build.sh [path to a pcsx_rearmed checkout]
# (the checkout gets patched, once, and built in place; it must be at the pinned commit). Needs emcc on PATH, or Docker (then it runs itself inside the emscripten/emsdk
# image).
set -euo pipefail

PCSX_REPO=https://github.com/libretro/pcsx_rearmed.git
PCSX_COMMIT=121fe97af5adcad840893b96b233d8f3bb9c8412 # 2026-10-29, "Merge branch 'master' (Oct 29 2026) into libretro"
EMSDK_IMAGE=emscripten/emsdk:4.0.10

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$HERE/../../../../../../../.." && pwd)"
OUT_DIR="$REPO_ROOT/desktop/src/renderer/public/emulator/pcsx_rearmed"

SRC="${1:-}"
if [[ -z "$SRC" ]]; then
  SRC="$(mktemp -d)/pcsx_rearmed"
  git clone --quiet "$PCSX_REPO" "$SRC"
  git -C "$SRC" checkout --quiet "$PCSX_COMMIT"
fi
SRC="$(cd "$SRC" && pwd)"

if ! command -v emcc >/dev/null 2>&1; then
  exec docker run --rm -u "$(id -u):$(id -g)" -v "$REPO_ROOT:$REPO_ROOT" -v "$SRC:$SRC" -w "$REPO_ROOT" \
    -e HOME=/tmp "$EMSDK_IMAGE" bash "$HERE/build.sh" "$SRC"
fi

if [[ "$(git -C "$SRC" rev-parse HEAD)" != "$PCSX_COMMIT" ]]; then
  echo "error: $SRC isn't at $PCSX_COMMIT" >&2
  exit 1
fi
for p in "$HERE"/patches/*.patch; do
  if git -C "$SRC" apply --check "$p" 2>/dev/null; then
    git -C "$SRC" apply "$p"
  elif ! git -C "$SRC" apply --reverse --check "$p" 2>/dev/null; then
    echo "error: $p doesn't apply to $SRC" >&2
    exit 1
  fi # else: already applied
done

# The core as a static archive (pcsx_rearmed_libretro_emscripten.bc, an `ar` archive despite its name).
emmake make -C "$SRC" -f Makefile.libretro platform=emscripten CFLAGS_OPT=-O3 -j"$(nproc)" >/dev/null
OBJ="$(mktemp -d)"
cp "$SRC/pcsx_rearmed_libretro_emscripten.bc" "$OBJ/core.a"

EXPORTS=_malloc,_free,_nexo_init,_nexo_set_multitap,_nexo_load,_nexo_fps,_nexo_sample_rate,_nexo_run
EXPORTS=$EXPORTS,_nexo_frame_drawn,_nexo_frame,_nexo_src_width,_nexo_src_height,_nexo_audio,_nexo_set_pad
EXPORTS=$EXPORTS,_nexo_reset,_nexo_state_size,_nexo_save_state,_nexo_load_state,_nexo_unload

mkdir -p "$OUT_DIR"
emcc -O3 -msimd128 -I"$SRC/deps/libretro-common/include" "$HERE/nexo_frontend.c" "$OBJ/core.a" \
  -o "$OUT_DIR/pcsx_rearmed.js" \
  -sMODULARIZE=1 -sEXPORT_ES6=1 -sEXPORT_NAME=createPcsxRearmed -sENVIRONMENT=web -sSINGLE_FILE=1 \
  -sUSE_ZLIB=1 -sALLOW_MEMORY_GROWTH=1 -sINITIAL_MEMORY=64MB -sSTACK_SIZE=2MB -sFORCE_FILESYSTEM=1 \
  -sDYNAMIC_EXECUTION=0 -sEXIT_RUNTIME=0 -sEXPORTED_FUNCTIONS="$EXPORTS" -sEXPORTED_RUNTIME_METHODS=HEAPU8,FS \
  -sINCOMING_MODULE_JS_API=print,printErr
{
  echo "PCSX ReARMed (libretro port), built for Nexo's Emulator plugin from $PCSX_REPO"
  echo "commit $PCSX_COMMIT with $EMSDK_IMAGE by"
  echo "desktop/src/renderer/src/emulator/engine/psx/pcsx_rearmed/build.sh with the patches in its patches/ folder,"
  echo "linked with Nexo's libretro frontend (nexo_frontend.c in the same folder). This module is distributed under"
  echo "the GNU General Public License version 2 (below); its complete corresponding source is that commit plus those"
  echo "files."
  echo
  echo "Bundled third-party code keeps its own license: libchdr (BSD-3-Clause, deps/libchdr/LICENSE.txt),"
  echo "Zstandard (BSD), LZMA SDK (public domain), zlib (zlib license, Emscripten port), libretro-common"
  echo "(MIT-style license in each file's header, Copyright (C) 2010-2020 The RetroArch team)."
  echo
  echo "==== libchdr ===="
  cat "$SRC/deps/libchdr/LICENSE.txt"
  echo
  echo "==== PCSX ReARMed: GNU General Public License, version 2 ===="
  cat "$SRC/COPYING"
} > "$OUT_DIR/LICENSE.txt"
rm -rf "$OBJ"
ls -l "$OUT_DIR"
