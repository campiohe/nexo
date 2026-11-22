#!/usr/bin/env bash
# Builds the SNES core the Emulator plugin runs: libretro's snes9x (pinned below) + Nexo's own tiny libretro
# frontend (nexo_frontend.cpp), compiled with Emscripten into ONE ES module with the WebAssembly embedded
# (SINGLE_FILE: the packaged app loads the renderer from file://, where fetch() can't read a .wasm file).
#
# Output: desktop/src/renderer/public/emulator/snes9x/snes9x.js (+ LICENSE.txt), copied as-is into
# out/renderer/emulator/snes9x/ by Vite and loaded at runtime with import() (engine/snes9x.ts).
#
# Usage: desktop/src/renderer/src/emulator/engine/snes9x/build.sh [path to a snes9x checkout]
# Needs emcc on PATH, or Docker (then it runs itself inside the emscripten/emsdk image).
set -euo pipefail

SNES9X_REPO=https://github.com/libretro/snes9x.git
SNES9X_COMMIT=fae2fea08f74180759ef540ee94259213f503480 # 2026-09-19, "libretro: turn LTO/LTCG off by default"
EMSDK_IMAGE=emscripten/emsdk:4.0.10

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$HERE/../../../../../../.." && pwd)"
OUT_DIR="$REPO_ROOT/desktop/src/renderer/public/emulator/snes9x"

SRC="${1:-}"
if [[ -z "$SRC" ]]; then
  SRC="$(mktemp -d)/snes9x"
  git clone --quiet "$SNES9X_REPO" "$SRC"
  git -C "$SRC" checkout --quiet "$SNES9X_COMMIT"
fi
SRC="$(cd "$SRC" && pwd)"

if ! command -v emcc >/dev/null 2>&1; then
  exec docker run --rm -u "$(id -u):$(id -g)" -v "$REPO_ROOT:$REPO_ROOT" -v "$SRC:$SRC" -w "$REPO_ROOT" \
    "$EMSDK_IMAGE" bash "$HERE/build.sh" "$SRC"
fi

OBJ="$(mktemp -d)"
LRC="$SRC/libretro/libretro-common"

# The core's sources as listed by its own libretro/Makefile.common (dynamically linked core), minus
# filter/snes_ntsc.c (LGPL, replaced by ntsc_stub.c), plus Nexo's frontend.
mapfile -t FILES < <(printf 'CORE_DIR := %s\ninclude %s/libretro/Makefile.common\nprint:\n\t@echo $(SOURCES_C) $(SOURCES_CXX)\n' \
  "$SRC" "$SRC" | make -s -f - print | tr ' ' '\n' | grep -v '^$' | grep -v 'filter/snes_ntsc\.c$')
FILES+=("$HERE/nexo_frontend.cpp" "$HERE/ntsc_stub.c")

FLAGS=(-O3 -DNDEBUG -D__LIBRETRO__ -DALLOW_CPU_OVERCLOCK -DSKIP_STDIO_REDEFINES -fno-strict-aliasing
  -fomit-frame-pointer -w -I"$SRC/libretro" -I"$LRC/include" -I"$SRC" -I"$SRC/apu" -I"$SRC/apu/bapu")

compile() {
  local f="$1" o
  o="$OBJ/$(echo "$f" | sed 's|[/.]|_|g').o"
  case "$f" in
    *.cpp) emcc "${FLAGS[@]}" -std=c++14 -fno-rtti -fno-exceptions -c "$f" -o "$o" ;;
    *) emcc "${FLAGS[@]}" -c "$f" -o "$o" ;;
  esac
}
export -f compile
export OBJ
export FLAGS_STR="${FLAGS[*]}"
printf '%s\n' "${FILES[@]}" | xargs -P "$(nproc)" -I{} bash -c 'FLAGS=($FLAGS_STR); compile "$@"' _ {}

EXPORTS=_malloc,_free,_nexo_init,_nexo_load,_nexo_fps,_nexo_sample_rate,_nexo_run,_nexo_frame_drawn,_nexo_frame
EXPORTS=$EXPORTS,_nexo_audio,_nexo_set_pad,_nexo_reset,_nexo_state_size,_nexo_save_state,_nexo_load_state,_nexo_unload

mkdir -p "$OUT_DIR"
emcc -O3 "$OBJ"/*.o -o "$OUT_DIR/snes9x.js" \
  -sMODULARIZE=1 -sEXPORT_ES6=1 -sEXPORT_NAME=createSnes9x -sENVIRONMENT=web -sSINGLE_FILE=1 \
  -sALLOW_MEMORY_GROWTH=1 -sINITIAL_MEMORY=64MB -sSTACK_SIZE=1MB -sFILESYSTEM=0 -sDYNAMIC_EXECUTION=0 \
  -sEXIT_RUNTIME=0 -sEXPORTED_FUNCTIONS="$EXPORTS" -sEXPORTED_RUNTIME_METHODS=HEAPU8 \
  -sINCOMING_MODULE_JS_API=print,printErr
{
  echo "snes9x (libretro port), built for Nexo's Emulator plugin from $SNES9X_REPO"
  echo "commit $SNES9X_COMMIT with $EMSDK_IMAGE by desktop/src/renderer/src/emulator/engine/snes9x/build.sh."
  echo "filter/snes_ntsc.c (LGPL) is not included. libretro-common files are under the MIT-style license in"
  echo "their headers (Copyright (C) 2010-2020 The RetroArch team)."
  echo
  cat "$SRC/LICENSE"
} > "$OUT_DIR/LICENSE.txt"
rm -rf "$OBJ"
ls -l "$OUT_DIR"
