// The Nintendo 64 engine (contract: ../../types.ts): libretro's Mupen64Plus-Next (GLideN64 renderer on WebGL 2,
// HLE RSP, cached interpreter) compiled to WebAssembly with Nexo's own libretro frontend (./mupen64plus_next/:
// nexo_frontend.c, patches, build.sh). Nothing is ever fetched from the network: the WebAssembly ships with the
// app (public/emulator/mupen64plus_next/, GPL-2.0, see its LICENSE.txt) and only runs the bytes the host gave it.
//
// Threads: the emulator runs in a worker (./worker.ts) that draws with WebGL 2 on the engine canvas's
// OffscreenCanvas (transferControlToOffscreen) and talks to the audio worklet directly, so the renderer's main
// thread only relays controller input and the UI stays responsive however heavy the game is. The canvas is
// always 640×480 (the core renders at 640×480, 2× the N64's usual 320×240, and the frontend scales whatever it
// draws into that), so the stream never changes size. Pacing: the console's frame rate, kept in step with the
// sound card, inside the worker (see worker.ts).
import { EMU_PORTS, type EmuAxes } from '@shared/protocol'
import type { EmulatorEngine, EmulatorOptions } from '../../types'
import { EmulatorError } from '../../types'
import { N64Audio } from './audio'
import { toN64Keys } from './pad'
import { prepareN64Rom } from './rom'
import type { FromWorker, ToWorker } from './worker'

const WIDTH = 640
const HEIGHT = 480
/** The core's output rate (Mupen64Plus-Next resamples the N64's to 44.1 kHz). */
const CORE_SAMPLE_RATE = 44100
const START_TIMEOUT_MS = 30_000
/**
 * Keyboards send no axes, gamepads with centered sticks don't either (input.ts). A port that sent axes is taken
 * as a gamepad (its d-pad is the D-pad) until it goes idle this long: then the next player on that port may be on
 * a keyboard, whose d-pad must move the stick.
 */
const ANALOG_FORGET_MS = 5000

/** Diagnostics (not part of the contract), refreshed about once a second by the worker. */
export interface N64Stats {
  /** Frames (VIs) run in the last second, their average and worst run time (ms), pictures drawn. */
  frames: number
  avgRunMs: number
  maxRunMs: number
  drawn: number
  /** Paced by the sound card (else by a timer). */
  audioClock: boolean
  /** The core's WebAssembly memory. */
  heapMB: number
}

let wasmModule: Promise<string> | null = null

/** The core's WebAssembly, base64 in an ES module (import() works from file://, fetch() doesn't). */
function loadWasmBase64(): Promise<string> {
  wasmModule ??= (async () => {
    // Relative to the page: http://localhost:…/ in dev, file://…/out/renderer/index.html when packaged.
    const url = new URL('emulator/mupen64plus_next/mupen64plus_next.wasm.js', document.baseURI).href
    const mod = (await import(/* @vite-ignore */ url)) as { default: string }
    return mod.default
  })().catch((e: unknown) => {
    wasmModule = null // let a later attempt retry
    throw e
  })
  return wasmModule
}

function decodeBase64(s: string): Uint8Array<ArrayBuffer> {
  const native = (Uint8Array as unknown as { fromBase64?: (s: string) => Uint8Array<ArrayBuffer> }).fromBase64
  if (native) return native(s)
  const bin = atob(s)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

interface PortState {
  /** This port's controller has sticks (it sent axes, and hasn't been idle since). */
  analog: boolean
  /** performance.now() since when nothing is held (0 = something is). */
  idleSince: number
}

class N64Engine implements EmulatorEngine {
  readonly system = 'n64' as const
  readonly canvas: HTMLCanvasElement
  readonly width = WIDTH
  readonly height = HEIGHT
  stats: N64Stats = { frames: 0, avgRunMs: 0, maxRunMs: 0, drawn: 0, audioClock: false, heapMB: 0 }

  private worker: Worker | null
  private audio: N64Audio | null
  private stream: MediaStream | null = null
  private readonly ports: PortState[] = Array.from({ length: EMU_PORTS }, () => ({ analog: false, idleSince: 0 }))
  private readonly pending = new Map<number, { resolve: (m: FromWorker) => void; reject: (e: Error) => void }>()
  private nextId = 1
  private _paused = false
  onCrash: ((message: string) => void) | null = null
  private crashed = false
  private destroyed = false

  constructor(canvas: HTMLCanvasElement, worker: Worker, audio: N64Audio) {
    this.canvas = canvas
    this.worker = worker
    this.audio = audio
    worker.onmessage = (e: MessageEvent<FromWorker>) => this.onMessage(e.data)
    worker.onerror = (e) => {
      console.error('[emulator] the N64 worker failed', e.message)
      this.onMessage({ type: 'crashed', message: e.message })
    }
  }

  private onMessage(msg: FromWorker): void {
    switch (msg.type) {
      case 'stats': {
        const { type: _, ...stats } = msg
        this.stats = stats
        break
      }
      case 'crashed':
        if (this.crashed) break
        this.crashed = true
        console.error('[emulator] the N64 core crashed:', msg.message)
        this.onCrash?.(msg.message)
        for (const p of this.pending.values()) p.reject(new EmulatorError('The game stopped working'))
        this.pending.clear()
        break
      case 'saved':
      case 'loaded':
      case 'failed': {
        const p = this.pending.get(msg.id)
        this.pending.delete(msg.id)
        p?.resolve(msg)
        break
      }
    }
  }

  private send(msg: ToWorker, transfer: Transferable[] = []): void {
    this.worker?.postMessage(msg, transfer)
  }

  /** Sends a request the worker answers (by `id`) with 'saved' / 'loaded' / 'failed'. */
  private request(msg: Extract<ToWorker, { id: number }>, transfer: Transferable[] = []): Promise<FromWorker> {
    return new Promise((resolve, reject) => {
      if (this.destroyed || !this.worker) return reject(new EmulatorError('The game has been closed'))
      if (this.crashed) return reject(new EmulatorError('The game stopped working'))
      this.pending.set(msg.id, { resolve, reject })
      this.send(msg, transfer)
    })
  }

  get paused(): boolean {
    return this._paused
  }

  setPad(port: number, buttons: number, axes?: EmuAxes): void {
    if (this.destroyed || !Number.isInteger(port) || port < 0 || port >= EMU_PORTS) return
    const s = this.ports[port]
    const now = performance.now()
    buttons |= 0
    if (axes) {
      s.analog = true
      s.idleSince = 0
    } else if (buttons === 0) {
      if (!s.idleSince) s.idleSince = now
    } else {
      if (s.idleSince && now - s.idleSince > ANALOG_FORGET_MS) s.analog = false
      s.idleSince = 0
    }
    this.send({ type: 'keys', port, value: toN64Keys(buttons, axes, !s.analog) })
  }

  pause(): void {
    if (this.destroyed || this._paused) return
    this._paused = true
    this.send({ type: 'pause' })
  }

  resume(): void {
    if (this.destroyed || !this._paused) return
    this._paused = false
    this.send({ type: 'resume' })
  }

  /**
   * A power cycle rather than the console's reset button: on an N64 the button only raises an NMI that the game
   * has to handle, and some (homebrew at least) never come back from it; power cycling always restarts the game.
   */
  reset(): void {
    if (this.destroyed) return
    this.send({ type: 'reset', hard: true })
  }

  mediaStream(fps = 60): MediaStream {
    if (!this.stream) {
      // The canvas's OffscreenCanvas is drawn by the worker; captureStream still captures every frame it shows.
      const video = this.canvas.captureStream(fps).getVideoTracks()
      const audio = this.audio ? this.audio.stream.getAudioTracks() : []
      this.stream = new MediaStream([...video, ...audio])
      if (this.destroyed) for (const t of this.stream.getTracks()) t.stop()
    }
    return this.stream
  }

  setLocalVolume(volume: number): void {
    this.audio?.setLocalVolume(volume)
  }

  async saveState(): Promise<Uint8Array> {
    const reply = await this.request({ type: 'save', id: this.nextId++ })
    if (reply.type !== 'saved') throw new EmulatorError("The game couldn't be saved")
    return new Uint8Array(reply.state)
  }

  async loadState(state: Uint8Array): Promise<void> {
    const copy = state.slice() // transferred to the worker: the caller keeps its own
    const reply = await this.request({ type: 'load', id: this.nextId++, state: copy.buffer }, [copy.buffer])
    if (reply.type !== 'loaded') throw new EmulatorError("This save doesn't belong to this game")
  }

  destroy(): void {
    if (this.destroyed) return
    this.destroyed = true
    this.worker?.terminate() // the core and its memory go with it
    this.worker = null
    for (const t of this.stream?.getTracks() ?? []) t.stop()
    this.audio?.close()
    this.audio = null
    for (const p of this.pending.values()) p.reject(new EmulatorError('The game has been closed'))
    this.pending.clear()
  }
}

export async function createN64Engine(opts: EmulatorOptions): Promise<EmulatorEngine> {
  const rom = await prepareN64Rom(opts.rom)

  let wasm: Uint8Array<ArrayBuffer>
  let WorkerCtor: new () => Worker
  try {
    const [base64, workerModule] = await Promise.all([loadWasmBase64(), import('./worker?worker&inline')])
    wasm = decodeBase64(base64)
    WorkerCtor = workerModule.default
  } catch (e) {
    console.error('[emulator] the N64 core failed to load', e)
    throw new EmulatorError("The Nintendo 64 emulator couldn't start (its core failed to load)")
  }

  const canvas = document.createElement('canvas')
  canvas.width = WIDTH
  canvas.height = HEIGHT
  let offscreen: OffscreenCanvas
  try {
    offscreen = canvas.transferControlToOffscreen()
  } catch (e) {
    console.error('[emulator] OffscreenCanvas unavailable', e)
    throw new EmulatorError("The Nintendo 64 emulator couldn't create its screen")
  }

  let audio: N64Audio
  try {
    audio = await N64Audio.create(CORE_SAMPLE_RATE)
  } catch (e) {
    console.error('[emulator] the N64 sound output failed', e)
    throw new EmulatorError("The emulator couldn't start its sound output")
  }

  const worker = new WorkerCtor()
  // Transferred to the worker: never the caller's own bytes (an unzipped ROM is already a fresh copy).
  const romCopy = rom === opts.rom ? rom.slice() : rom
  const started = new Promise<FromWorker>((resolve) => {
    const timer = window.setTimeout(() => resolve({ type: 'error', stage: 'core', message: 'timed out' }), START_TIMEOUT_MS)
    worker.onmessage = (e: MessageEvent<FromWorker>) => {
      if (e.data.type !== 'ready' && e.data.type !== 'error') return
      window.clearTimeout(timer)
      resolve(e.data)
    }
    worker.onerror = (e) => {
      window.clearTimeout(timer)
      resolve({ type: 'error', stage: 'core', message: e.message })
    }
  })
  const init: ToWorker = { type: 'init', canvas: offscreen, wasm: wasm.buffer, rom: romCopy.buffer as ArrayBuffer, audio: audio.port }
  worker.postMessage(init, [offscreen, wasm.buffer, romCopy.buffer as ArrayBuffer, audio.port])

  const result = await started
  if (result.type !== 'ready') {
    worker.terminate()
    audio.close()
    const message = result.type === 'error' ? result.message : 'unexpected reply'
    console.error('[emulator] the N64 core failed to start:', message)
    if (result.type === 'error' && result.stage === 'load')
      throw new EmulatorError("This Nintendo 64 game couldn't be loaded (the file may be corrupt)")
    if (result.type === 'error' && result.stage === 'gl')
      throw new EmulatorError("The Nintendo 64 emulator needs WebGL 2, which isn't available (check the graphics driver)")
    throw new EmulatorError("The Nintendo 64 emulator couldn't start (its core failed to load)")
  }
  return new N64Engine(canvas, worker, audio)
}
