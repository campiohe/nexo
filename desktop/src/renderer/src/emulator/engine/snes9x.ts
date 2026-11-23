// Loads the bundled snes9x core: public/emulator/snes9x/snes9x.js, an Emscripten ES module with the WebAssembly
// embedded (built by ./snes9x/build.sh; license in public/emulator/snes9x/LICENSE.txt). It ships inside the
// app (out/renderer/emulator/snes9x/) and is imported from 'self' at runtime: never from the network. Each call
// of the factory is an independent emulator instance with its own memory.

/** The module's exports (see ./snes9x/nexo_frontend.cpp). Pointers are byte offsets into HEAPU8. */
export interface Snes9xModule {
  HEAPU8: Uint8Array
  _malloc(size: number): number
  _free(ptr: number): void
  _nexo_init(): void
  _nexo_load(ptr: number, size: number): number
  _nexo_fps(): number
  _nexo_sample_rate(): number
  /** Runs one frame; returns the stereo audio frames it produced (at `_nexo_audio()`). */
  _nexo_run(): number
  _nexo_frame_drawn(): number
  /** 256×224 RGBA picture. */
  _nexo_frame(): number
  /** Interleaved stereo int16. */
  _nexo_audio(): number
  _nexo_set_pad(port: number, bits: number): void
  _nexo_reset(): void
  _nexo_state_size(): number
  _nexo_save_state(ptr: number, size: number): number
  _nexo_load_state(ptr: number, size: number): number
  _nexo_unload(): void
}

type Factory = (opts?: { print?: (s: string) => void; printErr?: (s: string) => void }) => Promise<Snes9xModule>

let factory: Promise<Factory> | null = null

function loadFactory(): Promise<Factory> {
  factory ??= (async () => {
    // Relative to the page: http://localhost:…/ in dev, file://…/out/renderer/index.html when packaged.
    const url = new URL('emulator/snes9x/snes9x.js', document.baseURI).href
    const mod = (await import(/* @vite-ignore */ url)) as { default: Factory }
    return mod.default
  })().catch((e: unknown) => {
    factory = null // let a later attempt retry
    throw e
  })
  return factory
}

export async function instantiateSnes9x(): Promise<Snes9xModule> {
  const create = await loadFactory()
  return create({ print: () => {}, printErr: (s) => console.warn(s) })
}
