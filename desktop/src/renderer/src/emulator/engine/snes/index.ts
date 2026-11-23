// The SNES engine (contract: ../../types.ts): libretro's snes9x compiled to WebAssembly together with a tiny
// libretro frontend of our own (../snes9x/: nexo_frontend.cpp + build.sh), bundled with the app
// (public/emulator/snes9x/) and run on the renderer's main thread. Nothing is ever fetched from the network:
// the engine only runs the bytes the host gave it.
//
// Clock: the sound card. The audio worklet (../audio-worklet.js) reports how much of the game's sound it has
// played; whenever less than TARGET_QUEUED_FRAMES frames of sound are waiting, the next frame runs. So the game
// runs exactly at the speed its sound plays (no drift, no crackle) and keeps running with the window hidden
// (Nexo disables background throttling). If the audio clock stops (no report for AUDIO_STALE_MS, e.g. the
// context couldn't start), frames run on a wall-clock timer instead, so the picture never freezes.
import { EMU_PORTS, GAME_PAD } from '@shared/protocol'
import type { EmulatorEngine, EmulatorOptions } from '../../types'
import { EmulatorError } from '../../types'
import { EmulatorAudio } from '../audio'
import { prepareRom } from '../rom'
import { instantiateSnes9x, type Snes9xModule } from '../snes9x'

const WIDTH = 256
const HEIGHT = 224
/** Frames of sound kept queued in the worklet (~50 ms): the host's audio latency vs. slack for main-thread hiccups. */
const TARGET_QUEUED_FRAMES = 3
/** Never run more than this many frames in one go (after a stall the game slows down instead of racing). */
const MAX_FRAMES_PER_TICK = 4
const AUDIO_STALE_MS = 120
const TIMER_MS = 4

/** GAME_PAD bit → libretro joypad bit, by position (standard gamepad → SNES): bottom = B, right = A, left = Y, top = X. */
const PAD_MAP: readonly (readonly [number, number])[] = [
  [GAME_PAD.A, 1 << 0], // RETRO_DEVICE_ID_JOYPAD_B
  [GAME_PAD.X, 1 << 1], // Y
  [GAME_PAD.SELECT, 1 << 2],
  [GAME_PAD.START, 1 << 3],
  [GAME_PAD.UP, 1 << 4],
  [GAME_PAD.DOWN, 1 << 5],
  [GAME_PAD.LEFT, 1 << 6],
  [GAME_PAD.RIGHT, 1 << 7],
  [GAME_PAD.B, 1 << 8], // A
  [GAME_PAD.Y, 1 << 9], // X
  [GAME_PAD.L, 1 << 10],
  [GAME_PAD.R, 1 << 11],
]

function toLibretroPad(buttons: number): number {
  let bits = 0
  for (const [pad, retro] of PAD_MAP) if (buttons & pad) bits |= retro
  return bits
}

class Snes9xEngine implements EmulatorEngine {
  readonly system = 'snes' as const
  readonly canvas: HTMLCanvasElement
  readonly width = WIDTH
  readonly height = HEIGHT
  /** Diagnostics (not part of the contract): frames run and the average time one takes, in ms. */
  readonly stats = { frames: 0, avgRunMs: 0 }

  private core: Snes9xModule | null
  private audio: EmulatorAudio | null = null
  private readonly ctx2d: CanvasRenderingContext2D
  private readonly image: ImageData
  private readonly frameMs: number
  private readonly samplesPerFrame: number
  private nextFrameAt = 0
  private timer: number | undefined
  private stream: MediaStream | null = null
  private _paused = false
  onCrash: ((message: string) => void) | null = null
  private hasCrashed = false

  /** The core threw (a WebAssembly trap): tell the UI once; the game stays paused. */
  private crashed(e: unknown): void {
    if (this.hasCrashed) return
    this.hasCrashed = true
    this.onCrash?.(e instanceof Error ? e.message : String(e))
  }
  private destroyed = false

  constructor(core: Snes9xModule) {
    this.core = core
    this.frameMs = 1000 / core._nexo_fps()
    this.samplesPerFrame = core._nexo_sample_rate() / core._nexo_fps()
    this.canvas = document.createElement('canvas')
    this.canvas.width = WIDTH
    this.canvas.height = HEIGHT
    const ctx2d = this.canvas.getContext('2d', { alpha: false })
    if (!ctx2d) throw new EmulatorError("The emulator couldn't create its screen")
    this.ctx2d = ctx2d
    this.image = new ImageData(WIDTH, HEIGHT)
  }

  async start(): Promise<void> {
    const core = this.core!
    this.audio = await EmulatorAudio.create(core._nexo_sample_rate(), this.tick)
    if (this.destroyed) return
    // First frame right away: the canvas shows the game as soon as createEmulator resolves.
    this.runFrame()
    this.draw()
    this.nextFrameAt = performance.now() + this.frameMs
    this.timer = window.setInterval(this.tick, TIMER_MS)
  }

  get paused(): boolean {
    return this._paused
  }

  private readonly tick = (): void => {
    if (this._paused || this.destroyed || !this.audio) return
    const now = performance.now()
    let ran = 0
    try {
      if (now - this.audio.lastReport < AUDIO_STALE_MS) {
        // Audio clock: top up the worklet's queue.
        const target = this.samplesPerFrame * TARGET_QUEUED_FRAMES
        while (this.audio.queued < target && ran < MAX_FRAMES_PER_TICK) {
          this.runFrame()
          ran++
        }
        this.nextFrameAt = now + this.frameMs
      } else {
        // Wall clock.
        if (now - this.nextFrameAt > 100) this.nextFrameAt = now
        while (now >= this.nextFrameAt && ran < MAX_FRAMES_PER_TICK) {
          this.runFrame()
          ran++
          this.nextFrameAt += this.frameMs
        }
      }
    } catch (e) {
      console.error('[emulator] the core crashed', e)
      this.pause()
      this.crashed(e)
      return
    }
    if (ran > 0) this.draw()
  }

  private runFrame(): void {
    const core = this.core!
    const t0 = performance.now()
    const frames = core._nexo_run()
    const dt = performance.now() - t0
    this.stats.frames++
    this.stats.avgRunMs += (dt - this.stats.avgRunMs) * (this.stats.frames < 60 ? 1 / this.stats.frames : 1 / 60)
    if (frames > 0 && this.audio) {
      this.audio.push(new Int16Array(core.HEAPU8.buffer, core._nexo_audio(), frames * 2), frames)
    }
  }

  private draw(): void {
    const core = this.core!
    const ptr = core._nexo_frame()
    this.image.data.set(core.HEAPU8.subarray(ptr, ptr + WIDTH * HEIGHT * 4))
    this.ctx2d.putImageData(this.image, 0, 0)
  }

  setPad(port: number, buttons: number): void {
    if (this.destroyed || !Number.isInteger(port) || port < 0 || port >= EMU_PORTS) return
    this.core!._nexo_set_pad(port, toLibretroPad(buttons | 0))
  }

  pause(): void {
    if (this.destroyed || this._paused) return
    this._paused = true
    this.audio?.clear()
  }

  resume(): void {
    if (this.destroyed || !this._paused) return
    this._paused = false
    this.nextFrameAt = performance.now()
  }

  reset(): void {
    if (this.destroyed) return
    this.core!._nexo_reset()
  }

  mediaStream(fps = 60): MediaStream {
    if (!this.stream) {
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
    const core = this.liveCore()
    const size = core._nexo_state_size()
    const ptr = size > 0 ? core._malloc(size) : 0
    if (!ptr) throw new EmulatorError("The game couldn't be saved")
    try {
      if (!core._nexo_save_state(ptr, size)) throw new EmulatorError("The game couldn't be saved")
      return core.HEAPU8.slice(ptr, ptr + size)
    } finally {
      core._free(ptr)
    }
  }

  async loadState(state: Uint8Array): Promise<void> {
    const core = this.liveCore()
    const ptr = state.length > 0 ? core._malloc(state.length) : 0
    if (!ptr) throw new EmulatorError("This save doesn't belong to this game")
    try {
      core.HEAPU8.set(state, ptr)
      if (!core._nexo_load_state(ptr, state.length)) throw new EmulatorError("This save doesn't belong to this game")
    } finally {
      core._free(ptr)
    }
    this.audio?.clear()
    this.draw()
  }

  private liveCore(): Snes9xModule {
    if (this.destroyed || !this.core) throw new EmulatorError('The game has been closed')
    return this.core
  }

  destroy(): void {
    if (this.destroyed) return
    this.destroyed = true
    window.clearInterval(this.timer)
    for (const t of this.stream?.getTracks() ?? []) t.stop()
    this.audio?.close()
    this.audio = null
    try {
      this.core?._nexo_unload()
    } catch (e) {
      console.warn('[emulator] unload failed', e)
    }
    this.core = null // the module's memory goes with it
  }
}

/** Loads a SNES game (.sfc / .smc / .swc / .fig, or a .zip with one) and starts it. Extra files are ignored. */
export async function createSnesEngine(opts: EmulatorOptions): Promise<EmulatorEngine> {
  const rom = await prepareRom(opts.rom)

  let core: Snes9xModule
  try {
    core = await instantiateSnes9x()
    core._nexo_init()
  } catch (e) {
    console.error('[emulator] the SNES core failed to load', e)
    throw new EmulatorError("The SNES emulator couldn't start (its core failed to load)")
  }

  let loaded = false
  try {
    const ptr = core._malloc(rom.length)
    if (!ptr) throw new Error('out of memory')
    try {
      core.HEAPU8.set(rom, ptr)
      loaded = core._nexo_load(ptr, rom.length) === 1
    } finally {
      core._free(ptr)
    }
  } catch (e) {
    console.error('[emulator] loading the game crashed the core', e)
  }
  if (!loaded) throw new EmulatorError("This SNES game couldn't be loaded (the file may be corrupt)")

  const engine = new Snes9xEngine(core)
  try {
    await engine.start()
  } catch (e) {
    engine.destroy()
    if (e instanceof EmulatorError) throw e
    console.error('[emulator] starting the game failed', e)
    throw new EmulatorError("The emulator couldn't start its sound output")
  }
  return engine
}
