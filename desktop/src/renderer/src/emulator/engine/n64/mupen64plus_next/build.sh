#!/usr/bin/env bash
# Builds the Nintendo 64 core the Emulator plugin runs: libretro's Mupen64Plus-Next (pinned below; GLideN64 on
# OpenGL ES 3 = WebGL 2, HLE RSP, cached interpreter) + Nexo's libretro frontend (nexo_frontend.c), compiled with
# Emscripten, with the patches in ./patches (the core runs re-entrantly instead of in a libco coroutine, and
# takes the N64 controller state straight from the frontend).
#
# Outputs (both from the same link; they only work together):
#   desktop/src/renderer/public/emulator/mupen64plus_next/mupen64plus_next.wasm.js + LICENSE.txt
#       The WebAssembly as an ES module (`export default "<base64>"`): the packaged app loads the renderer from
#       file://, where fetch() can't read a .wasm file but import() of a module works. Copied as-is by Vite.
#   desktop/src/renderer/src/emulator/engine/n64/mupen64plus_next/core.js
#       Emscripten's JavaScript glue (ES module factory), bundled into the engine's worker (../worker.ts).
#
# Usage: desktop/src/renderer/src/emulator/engine/n64/mupen64plus_next/build.sh [path to a mupen64plus-libretro-nx checkout]
# Needs emcc on PATH, or Docker (then it runs itself inside the emscripten/emsdk image). A given checkout must be
# at the pinned commit; the patches are applied to it (once).
set -euo pipefail

CORE_REPO=https://github.com/libretro/mupen64plus-libretro-nx.git
CORE_COMMIT=15bada85906593376e8fd697f1b0b3af3a20f512 # 2026-10-17, "[CI/CD] Add Linux ARM 64-bit"
EMSDK_IMAGE=emscripten/emsdk:4.0.10

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$HERE/../../../../../../../.." && pwd)"
OUT_DIR="$REPO_ROOT/desktop/src/renderer/public/emulator/mupen64plus_next"

SRC="${1:-}"
if [[ -z "$SRC" ]]; then
  SRC="$(mktemp -d)/mupen64plus-libretro-nx"
  git clone --quiet "$CORE_REPO" "$SRC"
  git -C "$SRC" checkout --quiet "$CORE_COMMIT"
fi
SRC="$(cd "$SRC" && pwd)"

if ! command -v emcc >/dev/null 2>&1; then
  exec docker run --rm -u "$(id -u):$(id -g)" -e HOME=/tmp -v "$REPO_ROOT:$REPO_ROOT" -v "$SRC:$SRC" -w "$SRC" \
    "$EMSDK_IMAGE" bash "$HERE/build.sh" "$SRC"
fi

if [[ "$(git -C "$SRC" rev-parse HEAD)" != "$CORE_COMMIT" ]]; then
  echo "error: $SRC isn't at $CORE_COMMIT" >&2
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

# The core as a static archive (its own Makefile; `platform=emscripten`). CFLAGS/CXXFLAGS from the environment
# are appended to the Makefile's own.
export CFLAGS="-DNEXO_REENTRANT -msimd128"
export CXXFLAGS="-DNEXO_REENTRANT -msimd128"
MAKE_ARGS=(platform=emscripten GLES3=1 STATIC_LINKING=1 NEXO=1 PIC=0 HAVE_PARALLEL_RSP=0 HAVE_PARALLEL_RDP=0
  HAVE_THR_AL=0 LLE=0 HAVE_LTCG=0)
make -C "$SRC" "${MAKE_ARGS[@]}" clean >/dev/null # (no header dependency tracking: always build from scratch)
emmake make -C "$SRC" -j"$(nproc)" "${MAKE_ARGS[@]}" >/dev/null
ARCHIVE="$SRC/mupen64plus_next_libretro_emscripten.bc"

EXPORTS=_malloc,_free,_nexo_init,_nexo_load,_nexo_fps,_nexo_sample_rate,_nexo_run,_nexo_frame_drawn
EXPORTS=$EXPORTS,_nexo_frame_width,_nexo_frame_height,_nexo_audio,_nexo_set_keys,_nexo_reset,_nexo_state_size
EXPORTS=$EXPORTS,_nexo_save_state,_nexo_load_state

OBJ="$(mktemp -d)"
emcc -O3 -msimd128 -DNEXO_REENTRANT -I"$SRC/libretro-common/include" -I"$SRC/mupen64plus-core/src" -c "$HERE/nexo_frontend.c" -o "$OBJ/nexo_frontend.o"
# ENVIRONMENT=worker: it runs in the engine's worker, on an OffscreenCanvas. The worker compiles the WebAssembly
# itself and hands it over through `instantiateWasm`, so the glue never fetches anything. No eval (CSP).
# Whole archive: the core is built with -fcommon, and tentative definitions (g_dev, retro_thread…) don't pull
# archive members in by themselves. Unused code is still dropped by the linker.
cp "$ARCHIVE" "$OBJ/libmupen64plus_next.a" # (emcc takes a .bc file for LLVM bitcode, not an archive)
# --profiling-funcs keeps function names, so a crash's stack trace in the console says where it happened.
emcc -O3 -msimd128 --profiling-funcs "$OBJ/nexo_frontend.o" -Wl,--whole-archive "$OBJ/libmupen64plus_next.a" -Wl,--no-whole-archive -o "$OBJ/core.js" \
  -sMODULARIZE=1 -sEXPORT_NAME=createMupen64PlusNext -sENVIRONMENT=worker \
  -sALLOW_MEMORY_GROWTH=1 -sINITIAL_MEMORY=128MB -sSTACK_SIZE=4MB -sDYNAMIC_EXECUTION=0 -sEXIT_RUNTIME=0 \
  -sMIN_WEBGL_VERSION=2 -sMAX_WEBGL_VERSION=2 -sFULL_ES3=1 -sGL_ENABLE_GET_PROC_ADDRESS=1 -lEGL -lGL \
  -sEXPORTED_FUNCTIONS="$EXPORTS" -sEXPORTED_RUNTIME_METHODS=HEAPU8,GL \
  -sINCOMING_MODULE_JS_API=print,printErr,instantiateWasm \
  --js-library "$HERE/nexo_gl.js" # buffer mapping that GLideN64 can use (see the file)

mkdir -p "$OUT_DIR"
{
  printf '// Mupen64Plus-Next (GPL-2.0, see LICENSE.txt) compiled to WebAssembly by\n'
  printf '// desktop/src/renderer/src/emulator/engine/n64/mupen64plus_next/build.sh. Generated: do not edit.\n'
  printf 'export default "'
  base64 -w0 "$OBJ/core.wasm"
  printf '"\n'
} > "$OUT_DIR/mupen64plus_next.wasm.js"
{
  printf '// @ts-nocheck\n'
  printf '/* eslint-disable */\n'
  printf '// Emscripten glue of the N64 core (GPL-2.0: desktop/src/renderer/public/emulator/mupen64plus_next/LICENSE.txt),\n'
  printf '// generated by ./build.sh together with public/emulator/mupen64plus_next/mupen64plus_next.wasm.js. Do not edit.\n'
  # Minus the CommonJS / AMD export at the end: it's an ES module here.
  sed '/^if (typeof exports === .object. && typeof module === .object.) {$/,$d' "$OBJ/core.js"
  printf '\nexport default createMupen64PlusNext\n'
} > "$HERE/core.js"
if grep -q 'module\.exports' "$HERE/core.js"; then
  echo "error: couldn't strip the glue's CommonJS export" >&2
  exit 1
fi
if grep -q 'import\.meta' "$HERE/core.js"; then
  echo "error: the glue still refers to import.meta (it's bundled into a classic worker)" >&2
  exit 1
fi
{
  echo "Mupen64Plus-Next (libretro), built for Nexo's Emulator plugin from $CORE_REPO"
  echo "commit $CORE_COMMIT with $EMSDK_IMAGE by"
  echo "desktop/src/renderer/src/emulator/engine/n64/mupen64plus_next/build.sh, with the patches in"
  echo "desktop/src/renderer/src/emulator/engine/n64/mupen64plus_next/patches/ and Nexo's frontend"
  echo "(nexo_frontend.c, same folder). The complete corresponding source is that commit plus those files."
  echo
  echo "Includes mupen64plus-core, mupen64plus-rsp-hle and the libretro glue (GPL-2.0), GLideN64 (GPL-2.0 or"
  echo "later), libretro-common (MIT-style), xxHash (BSD-2-Clause), zlib/minizip (zlib license), libpng (libpng"
  echo "license) and Emscripten's runtime (MIT). The combination is distributed under the GNU GPL version 2:"
  echo
  cat "$SRC/LICENSE"
} > "$OUT_DIR/LICENSE.txt"
rm -rf "$OBJ"
ls -l "$OUT_DIR" "$HERE/core.js"
