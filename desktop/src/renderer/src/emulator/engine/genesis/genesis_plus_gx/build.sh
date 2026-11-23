#!/usr/bin/env bash
# Builds the Mega Drive / Genesis core the Emulator plugin runs: libretro's Genesis Plus GX (pinned below) + Nexo's
# own tiny libretro frontend (nexo_frontend.c), compiled with Emscripten into ONE ES module with the WebAssembly
# embedded (SINGLE_FILE: the packaged app loads the renderer from file://, where fetch() can't read a .wasm file).
#
# Output: desktop/src/renderer/public/emulator/genesis_plus_gx/genesis_plus_gx.js (+ LICENSE.txt), copied as-is
# into out/renderer/emulator/genesis_plus_gx/ by Vite and loaded at runtime with import() (engine/genesis/core.ts).
#
# Usage: desktop/src/renderer/src/emulator/engine/genesis/genesis_plus_gx/build.sh [path to a Genesis Plus GX checkout]
# Needs emcc on PATH, or Docker (then it runs itself inside the emscripten/emsdk image).
set -euo pipefail

GPGX_REPO=https://github.com/libretro/Genesis-Plus-GX.git
GPGX_COMMIT=4fd32efe1fec3537d11f7aaa24cb961c6ff57fdd # 2026-11-20, "Fetch translations & Recreate libretro_core_options_intl.h"
EMSDK_IMAGE=emscripten/emsdk:4.0.10

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$HERE/../../../../../../../.." && pwd)"
OUT_DIR="$REPO_ROOT/desktop/src/renderer/public/emulator/genesis_plus_gx"

SRC="${1:-}"
if [[ -z "$SRC" ]]; then
  SRC="$(mktemp -d)/Genesis-Plus-GX"
  git clone --quiet "$GPGX_REPO" "$SRC"
  git -C "$SRC" checkout --quiet "$GPGX_COMMIT"
fi
SRC="$(cd "$SRC" && pwd)"

if ! command -v emcc >/dev/null 2>&1; then
  exec docker run --rm -u "$(id -u):$(id -g)" -v "$REPO_ROOT:$REPO_ROOT" -v "$SRC:$SRC" -w "$REPO_ROOT" \
    "$EMSDK_IMAGE" bash "$HERE/build.sh" "$SRC"
fi

OBJ="$(mktemp -d)"

# The core's sources as listed by its own libretro/Makefile.common (no CHD / Ogg Vorbis: those only serve Mega CD
# images, which Nexo doesn't run), minus core/ntsc/*.c: blargg's NTSC filters (LGPL-2.1, optional; replaced by
# ntsc_stub.c). (zlib stays: the core identifies games by their crc32.)
# core/sound/ym3438.c (Nuked OPN2, LGPL-2.1, optional) and opll.c (Nuked OPLL, optional) compile to nothing:
# HAVE_YM3438_CORE / HAVE_OPLL_CORE aren't defined.
mapfile -t FILES < <(printf 'CORE_DIR := %s\ninclude %s/libretro/Makefile.common\nprint:\n\t@echo $(SOURCES_C)\n' \
  "$SRC" "$SRC" | make -s -f - print | tr ' ' '\n' | grep -v '^$' | grep -v '/core/ntsc/')
FILES+=("$HERE/nexo_frontend.c" "$HERE/ntsc_stub.c")

INCLUDES=()
for d in core core/z80 core/m68k core/ntsc core/sound core/sound/minimp3 core/input_hw core/cd_hw core/cart_hw \
  core/cart_hw/svp libretro libretro/libretro-common/include; do
  INCLUDES+=(-I"$SRC/$d")
done

FLAGS=(-O3 -DNDEBUG -fomit-frame-pointer -fno-strict-aliasing -w
  -D__LIBRETRO__ -DUSE_LIBRETRO_VFS -DHAVE_NO_LANGEXTRA -DLSB_FIRST -DALIGN_LONG -DBYTE_ORDER=LITTLE_ENDIAN
  -DUSE_16BPP_RENDERING -DFRONTEND_SUPPORTS_RGB565 -DM68K_OVERCLOCK_SHIFT=20 -DZ80_OVERCLOCK_SHIFT=20
  -DMAXROMSIZE=10485760 '-DINLINE=static inline' "${INCLUDES[@]}")

# io_ctrl.c only (see compile): the Team Player port handlers become Nexo's automatic multitap (nexo_frontend.c),
# which hands each access to the real Team Player / 4-Way Play / plain pad handler depending on what the game uses.
compile() {
  local f="$1" o extra=()
  o="$OBJ/$(echo "$f" | sed 's|[/.]|_|g').o"
  [[ "$f" == */core/io_ctrl.c ]] && extra=(-Dteamplayer_1_read=nexo_port_1_read -Dteamplayer_1_write=nexo_port_1_write
    -Dteamplayer_2_read=nexo_port_2_read -Dteamplayer_2_write=nexo_port_2_write)
  emcc "${FLAGS[@]}" "${extra[@]}" -c "$f" -o "$o"
}
export -f compile
export OBJ
# Arrays don't cross the process boundary: pass FLAGS NUL-separated through a file.
FLAGS_FILE="$OBJ/flags"
printf '%s\0' "${FLAGS[@]}" > "$FLAGS_FILE"
export FLAGS_FILE
printf '%s\n' "${FILES[@]}" | xargs -P "$(nproc)" -I{} bash -c 'mapfile -d "" -t FLAGS < "$FLAGS_FILE"; compile "$@"' _ {}
rm -f "$FLAGS_FILE"

EXPORTS=_malloc,_free,_nexo_init,_nexo_load,_nexo_fps,_nexo_sample_rate,_nexo_run,_nexo_frame_drawn,_nexo_frame
EXPORTS=$EXPORTS,_nexo_audio,_nexo_set_pad,_nexo_reset,_nexo_state_size,_nexo_save_state,_nexo_load_state,_nexo_unload

mkdir -p "$OUT_DIR"
emcc -O3 "$OBJ"/*.o -o "$OUT_DIR/genesis_plus_gx.js" \
  -sMODULARIZE=1 -sEXPORT_ES6=1 -sEXPORT_NAME=createGenesisPlusGX -sENVIRONMENT=web -sSINGLE_FILE=1 \
  -sALLOW_MEMORY_GROWTH=1 -sINITIAL_MEMORY=64MB -sSTACK_SIZE=1MB -sFILESYSTEM=0 -sDYNAMIC_EXECUTION=0 \
  -sEXIT_RUNTIME=0 -sEXPORTED_FUNCTIONS="$EXPORTS" -sEXPORTED_RUNTIME_METHODS=HEAPU8 \
  -sINCOMING_MODULE_JS_API=print,printErr
{
  echo "Genesis Plus GX (libretro port), built for Nexo's Emulator plugin from $GPGX_REPO"
  echo "commit $GPGX_COMMIT with $EMSDK_IMAGE by"
  echo "desktop/src/renderer/src/emulator/engine/genesis/genesis_plus_gx/build.sh, together with Nexo's frontend"
  echo "(nexo_frontend.c, ntsc_stub.c next to that script). The Genesis Plus GX sources are used unmodified; only"
  echo "core/io_ctrl.c is compiled with its Team Player port handlers renamed (-D flags) to Nexo's frontend's."
  echo
  echo "Not included: the NTSC filters (core/ntsc, LGPL-2.1), the Nuked OPN2 / OPLL sound cores, the Mega CD"
  echo "image readers (libchdr, zstd, lzma, Tremor). Included: blip_buf (core/sound/blip_buf.c, Shay Green,"
  echo "LGPL-2.1, the core's audio resampler: its source is in the repository above, its license is reproduced"
  echo "below), zlib (zlib license, below) and minimp3 (CC0); everything else is under the Genesis Plus GX license"
  echo "below. libretro-common files are under the MIT-style license in their headers (Copyright (C) 2010-2020 The"
  echo "RetroArch team)."
  echo
  cat "$SRC/LICENSE.txt"
} > "$OUT_DIR/LICENSE.txt"
rm -rf "$OBJ"
ls -l "$OUT_DIR"
