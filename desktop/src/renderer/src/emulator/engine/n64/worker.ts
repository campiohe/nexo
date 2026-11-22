// The N64 engine's worker: runs Mupen64Plus-Next (mupen64plus_next/core.js + the WebAssembly the main thread
// hands over) on the engine canvas's OffscreenCanvas, off the renderer's main thread. Loaded by ./index.ts as an
// inline (blob:) worker, which works from file:// in packaged builds.
//
// Pacing: a wall clock at the console's frame rate, kept in step with the sound card. Unlike the SNES, an N64 game
// often stops its audio DMA altogether (boot, loading, silence), so the sound can't be the only clock as in
// ../../engine.ts or the game would race whenever it's silent. The audio worklet's MessagePort was transferred
// here: the worker posts each frame's sound to the worklet and reads its consumption reports (~190 a second)
// itself, so the main thread being busy (React, the stream's encoder) doesn't matter. While the game makes sound,
// the frame rate bends (±1 %) to keep TARGET_QUEUED_FRAMES of it queued, a frame runs early when the queue runs
// dry and waits while it overflows: the game follows the sound card's clock, without drift or crackle. A frame the
// machine can't run in time slows the game down (at most MAX_FRAMES_PER_TICK frames run back to back to catch up,
// and a longer stall is forgotten) instead of fast-forwarding afterwards.
import createMupen64PlusNext from './mupen64plus_next/core.js'

/** The module's exports (see mupen64plus_next/nexo_frontend.c). Pointers are byte offsets into HEAPU8. */
interface CoreModule {
  HEAPU8: Uint8Array
  GL: {
    registerContext(ctx: WebGL2RenderingContext, attributes: Record<string, unknown>): number
    makeContextCurrent(handle: number): boolean
  }
  _malloc(size: number): number
  _free(ptr: number): void
  _nexo_init(): void
  _nexo_load(ptr: number, size: number): number
  _nexo_fps(): number
  _nexo_sample_rate(): number
  _nexo_run(): number
  _nexo_frame_drawn(): number
  _nexo_frame_width(): number
  _nexo_frame_height(): number
  _nexo_audio(): number
  _nexo_set_keys(port: number, value: number): void
  _nexo_reset(hard: number): void
  _nexo_state_size(): number
  _nexo_save_state(ptr: number, size: number): number
  _nexo_load_state(ptr: number, size: number): number
}

export type ToWorker =
  | { type: 'init'; canvas: OffscreenCanvas; wasm: ArrayBuffer; rom: ArrayBuffer; audio: MessagePort }
  | { type: 'keys'; port: number; value: number }
  | { type: 'pause' }
  | { type: 'resume' }
  | { type: 'reset'; hard: boolean }
  | { type: 'save'; id: number }
  | { type: 'load'; id: number; state: ArrayBuffer }

export type FromWorker =
  | { type: 'ready'; fps: number; sampleRate: number }
  /** `stage`: what failed (`load` = the core refused the game; `gl` = no usable WebGL 2; `core` = anything else). */
  | { type: 'error'; stage: 'core' | 'gl' | 'load'; message: string }
  | { type: 'saved'; id: number; state: ArrayBuffer }
  | { type: 'loaded'; id: number }
  | { type: 'failed'; id: number; message: string }
  /** The core crashed mid-game: the worker stopped running it. */
  | { type: 'crashed'; message: string }
  /** About once a second: frames run, average / worst time one took (ms), pictures drawn, clock, memory (MB). */
  | { type: 'stats'; frames: number; avgRunMs: number; maxRunMs: number; drawn: number; audioClock: boolean; heapMB: number }

/** Frames of sound kept queued in the worklet (~67 ms): latency vs. slack for slow frames. */
const TARGET_QUEUED_FRAMES = 4
/** Never run more than this many frames in one go (after a stall the game slows down instead of racing). */
const MAX_FRAMES_PER_TICK = 3
/** Behind the schedule by more than this (ms): start over from now. */
const MAX_LAG_MS = 100
/** No consumption report for this long: the sound card isn't running (no device, suspended context). */
const AUDIO_STALE_MS = 150
/** How much the frame rate may bend (fraction) to keep the sound queue at its target. */
const DRIFT_CORRECTION = 0.01
/** The game counts as making sound if one of its last this many frames produced some. */
const AUDIO_FRAMES_WINDOW = 30
const TIMER_MS = 4

const scope = self as unknown as {
  postMessage(msg: FromWorker, transfer?: Transferable[]): void
  onmessage: ((e: MessageEvent<ToWorker>) => void) | null
}
const post = (msg: FromWorker, transfer: Transferable[] = []) => scope.postMessage(msg, transfer)

let core: CoreModule | null = null
let audioPort: MessagePort | null = null
let frameMs = 1000 / 60
let samplesPerFrame = 735
let sent = 0
let consumed = 0
let lastReport = 0
let nextFrameAt = 0
/** Frames since the core last produced sound. */
let silentFrames = AUDIO_FRAMES_WINDOW
let paused = false
let dead = false
const stats = { frames: 0, sumMs: 0, maxMs: 0, drawn: 0 }

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

async function init(msg: Extract<ToWorker, { type: 'init' }>): Promise<void> {
  const gl = msg.canvas.getContext('webgl2', {
    alpha: false,
    depth: false,
    stencil: false,
    antialias: false,
    premultipliedAlpha: false,
    preserveDrawingBuffer: false,
    powerPreference: 'high-performance',
  })
  if (!gl) {
    post({ type: 'error', stage: 'gl', message: 'WebGL 2 is unavailable' })
    return
  }
  msg.canvas.addEventListener('webglcontextlost', (e) => {
    e.preventDefault()
    crash('the WebGL context was lost')
  })

  let mod: CoreModule
  try {
    const wasm = await WebAssembly.compile(msg.wasm)
    mod = (await createMupen64PlusNext({
      print: () => {},
      printErr: (s: string) => console.warn(s),
      instantiateWasm(imports: WebAssembly.Imports, done: (i: WebAssembly.Instance, m: WebAssembly.Module) => void) {
        WebAssembly.instantiate(wasm, imports).then(
          (instance) => done(instance, wasm),
          (e: unknown) => post({ type: 'error', stage: 'core', message: errorText(e) }),
        )
        return {}
      },
    })) as CoreModule
    const handle = mod.GL.registerContext(gl, {
      majorVersion: 2,
      minorVersion: 0,
      enableExtensionsByDefault: true,
      alpha: false,
      depth: false,
      stencil: false,
      antialias: false,
    })
    if (!handle || !mod.GL.makeContextCurrent(handle)) throw new Error("couldn't attach the WebGL context")
    mod._nexo_init()
  } catch (e) {
    console.error('[emulator] the N64 core failed to start', e)
    post({ type: 'error', stage: 'core', message: errorText(e) })
    return
  }

  let loaded = 0
  try {
    const rom = new Uint8Array(msg.rom)
    const ptr = mod._malloc(rom.length)
    if (!ptr) throw new Error('out of memory')
    try {
      mod.HEAPU8.set(rom, ptr)
      loaded = mod._nexo_load(ptr, rom.length)
    } finally {
      mod._free(ptr)
    }
  } catch (e) {
    console.error('[emulator] the N64 core failed to load the game', e)
    post({ type: 'error', stage: 'load', message: errorText(e) })
    return
  }
  if (loaded !== 1) {
    post({ type: 'error', stage: loaded === -1 ? 'gl' : 'load', message: `nexo_load returned ${loaded}` })
    return
  }

  core = mod
  frameMs = 1000 / mod._nexo_fps()
  samplesPerFrame = mod._nexo_sample_rate() / mod._nexo_fps()
  audioPort = msg.audio
  audioPort.onmessage = (e: MessageEvent<number>) => {
    consumed = e.data
    lastReport = performance.now()
    tick()
  }
  // First frame right away: the canvas shows the game as soon as the engine is ready.
  try {
    runFrame()
  } catch (e) {
    console.error('[emulator] the N64 core crashed on its first frame', e)
    post({ type: 'error', stage: 'core', message: errorText(e) })
    core = null
    return
  }
  post({ type: 'ready', fps: mod._nexo_fps(), sampleRate: mod._nexo_sample_rate() })
  nextFrameAt = performance.now() + frameMs
  setInterval(tick, TIMER_MS)
  setInterval(reportStats, 1000)
}

function tick(): void {
  if (paused || dead || !core) return
  const now = performance.now()
  if (now - nextFrameAt > MAX_LAG_MS) nextFrameAt = now
  const audioClock = now - lastReport < AUDIO_STALE_MS && silentFrames < AUDIO_FRAMES_WINDOW
  let ran = 0
  try {
    while (ran < MAX_FRAMES_PER_TICK) {
      let due = now >= nextFrameAt
      let period = frameMs
      if (audioClock) {
        const queued = sent - consumed
        const target = samplesPerFrame * TARGET_QUEUED_FRAMES
        // Follow the sound card: up to ±1 % faster / slower to bring the queue back to its target...
        period = frameMs * (1 - DRIFT_CORRECTION * Math.max(-1, Math.min(1, (target - queued) / target)))
        // ...one frame early when it's running dry (start, after a slow frame), none while it overflows.
        if (queued < target / 2) due ||= now >= nextFrameAt - frameMs
        else if (queued > target * 2) due = false
      }
      if (!due) break
      runFrame()
      ran++
      nextFrameAt += period
    }
  } catch (e) {
    console.error('[emulator] the N64 core crashed', e)
    crash(errorText(e))
  }
}

function runFrame(): void {
  const mod = core!
  const t0 = performance.now()
  const frames = mod._nexo_run()
  const dt = performance.now() - t0
  stats.frames++
  stats.sumMs += dt
  if (dt > stats.maxMs) stats.maxMs = dt
  if (mod._nexo_frame_drawn()) stats.drawn++
  silentFrames = frames > 0 ? 0 : silentFrames + 1
  if (frames > 0 && audioPort) {
    const pcm = new Int16Array(mod.HEAPU8.buffer, mod._nexo_audio(), frames * 2)
    const l = new Float32Array(frames)
    const r = new Float32Array(frames)
    for (let i = 0; i < frames; i++) {
      l[i] = pcm[2 * i] / 32768
      r[i] = pcm[2 * i + 1] / 32768
    }
    sent += frames
    audioPort.postMessage({ type: 'samples', l, r }, [l.buffer, r.buffer])
  }
}

function reportStats(): void {
  if (dead || !core || stats.frames === 0) return
  post({
    type: 'stats',
    frames: stats.frames,
    avgRunMs: stats.sumMs / stats.frames,
    maxRunMs: stats.maxMs,
    drawn: stats.drawn,
    audioClock: performance.now() - lastReport < AUDIO_STALE_MS && silentFrames < AUDIO_FRAMES_WINDOW,
    heapMB: Math.round(core!.HEAPU8.buffer.byteLength / 1048576),
  })
  stats.frames = 0
  stats.sumMs = 0
  stats.maxMs = 0
  stats.drawn = 0
}

function clearAudio(): void {
  audioPort?.postMessage({ type: 'clear' })
}

function crash(message: string): void {
  if (dead) return
  dead = true
  clearAudio()
  post({ type: 'crashed', message })
}

function save(id: number): void {
  const mod = core
  if (!mod || dead) return post({ type: 'failed', id, message: 'not running' })
  const size = mod._nexo_state_size()
  const ptr = size > 0 ? mod._malloc(size) : 0
  if (!ptr) return post({ type: 'failed', id, message: 'out of memory' })
  try {
    if (!mod._nexo_save_state(ptr, size)) return post({ type: 'failed', id, message: 'the core refused' })
    const state = mod.HEAPU8.slice(ptr, ptr + size).buffer
    post({ type: 'saved', id, state }, [state])
  } catch (e) {
    crash(errorText(e))
    post({ type: 'failed', id, message: errorText(e) })
  } finally {
    if (!dead) mod._free(ptr)
  }
}

function load(id: number, state: ArrayBuffer): void {
  const mod = core
  if (!mod || dead) return post({ type: 'failed', id, message: 'not running' })
  const bytes = new Uint8Array(state)
  const ptr = bytes.length > 0 ? mod._malloc(bytes.length) : 0
  if (!ptr) return post({ type: 'failed', id, message: 'out of memory' })
  try {
    mod.HEAPU8.set(bytes, ptr)
    if (!mod._nexo_load_state(ptr, bytes.length)) return post({ type: 'failed', id, message: 'the core refused' })
    clearAudio()
    post({ type: 'loaded', id })
  } catch (e) {
    crash(errorText(e))
    post({ type: 'failed', id, message: errorText(e) })
  } finally {
    if (!dead) mod._free(ptr)
  }
}

scope.onmessage = (e: MessageEvent<ToWorker>) => {
  const msg = e.data
  switch (msg.type) {
    case 'init':
      void init(msg)
      break
    case 'keys':
      core?._nexo_set_keys(msg.port, msg.value)
      break
    case 'pause':
      paused = true
      clearAudio()
      break
    case 'resume':
      paused = false
      nextFrameAt = performance.now()
      break
    case 'reset':
      if (core && !dead) core._nexo_reset(msg.hard ? 1 : 0)
      break
    case 'save':
      save(msg.id)
      break
    case 'load':
      load(msg.id, msg.state)
      break
  }
}
