// Loads the bundled PlayStation core: public/emulator/pcsx_rearmed/pcsx_rearmed.js, an Emscripten ES module with
// the WebAssembly embedded (built by ./pcsx_rearmed/build.sh; GPL-2.0, license and source pointer in
// public/emulator/pcsx_rearmed/LICENSE.txt). It ships inside the app (out/renderer/emulator/pcsx_rearmed/) and is
// imported from 'self' at runtime: never from the network. Each call of the factory is an independent emulator
// instance with its own memory and its own in-memory file system.

/** The subset of Emscripten's FS the engine uses (MEMFS). */
export interface PcsxFS {
  mkdir(path: string): void
  /** `canOwn`: MEMFS keeps a reference to `data` instead of copying it (the disc image is never duplicated). */
  writeFile(path: string, data: Uint8Array | string, opts?: { canOwn?: boolean }): void
  unlink(path: string): void
}

/** The module's exports (see ./pcsx_rearmed/nexo_frontend.c). Pointers are byte offsets into HEAPU8. */
export interface PcsxModule {
  /** Re-read after every call into the core: the memory can grow (the view is replaced). */
  HEAPU8: Uint8Array
  FS: PcsxFS
  _malloc(size: number): number
  _free(ptr: number): void
  _nexo_init(): void
  _nexo_set_multitap(on: number): void
  /** `path`: pointer to a NUL-terminated UTF-8 path in MEMFS. 1 = loaded. */
  _nexo_load(path: number): number
  _nexo_fps(): number
  _nexo_sample_rate(): number
  /** Runs one frame; returns the stereo audio frames it produced (at `_nexo_audio()`). */
  _nexo_run(): number
  _nexo_frame_drawn(): number
  /** 640×480 RGBA. */
  _nexo_frame(): number
  _nexo_src_width(): number
  _nexo_src_height(): number
  /** Interleaved stereo int16. */
  _nexo_audio(): number
  _nexo_set_pad(port: number, bits: number, lx: number, ly: number, rx: number, ry: number): void
  _nexo_reset(): void
  _nexo_state_size(): number
  _nexo_save_state(ptr: number, size: number): number
  _nexo_load_state(ptr: number, size: number): number
  _nexo_unload(): void
}

type Factory = (opts?: { print?: (s: string) => void; printErr?: (s: string) => void }) => Promise<PcsxModule>

let factory: Promise<Factory> | null = null

function loadFactory(): Promise<Factory> {
  factory ??= (async () => {
    // Relative to the page: http://localhost:…/ in dev, file://…/out/renderer/index.html when packaged.
    const url = new URL('emulator/pcsx_rearmed/pcsx_rearmed.js', document.baseURI).href
    const mod = (await import(/* @vite-ignore */ url)) as { default: Factory }
    return mod.default
  })().catch((e: unknown) => {
    factory = null // let a later attempt retry
    throw e
  })
  return factory
}

export async function instantiatePcsx(log?: (line: string) => void): Promise<PcsxModule> {
  const create = await loadFactory()
  return create({ print: (s) => log?.(s), printErr: (s) => (log ? log(s) : console.warn(s)) })
}
