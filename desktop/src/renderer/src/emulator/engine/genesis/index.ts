// The Mega Drive / Genesis engine (contract: ../../types.ts): libretro's Genesis Plus GX compiled to WebAssembly
// together with a tiny libretro frontend of our own (./genesis_plus_gx/: nexo_frontend.c + build.sh), bundled with
// the app (public/emulator/genesis_plus_gx/) and run on the renderer's main thread. Nothing is ever fetched from the
// network: the engine only runs the bytes the host gave it. Cartridges only (no Master System / Game Gear / Mega CD).
//
// Same runner as the SNES engine (../snes/index.ts). Clock: the sound card. The audio worklet (../audio-worklet.js)
// reports how much of the game's sound it has played; whenever less than TARGET_QUEUED_FRAMES frames of sound are
// waiting, the next frame runs. So the game runs exactly at the speed its sound plays (60 Hz NTSC, 50 Hz PAL: the
// core picks the region from the cartridge) and keeps running with the window hidden. If the audio clock stops (no
// report for AUDIO_STALE_MS), frames run on a wall-clock timer instead, so the picture never freezes.
//
// Picture: always 320×224 (the frontend stretches 256-wide modes to 320 and crops PAL's 240 lines to 224), so the
// stream never changes size. Players: 4 ports through an automatic multitap (Team Player / EA 4-Way Play / plain
// pads, whichever the game asks for: see nexo_frontend.c), 6-button pads.
import { EMU_PORTS, GAME_PAD, type EmuAxes } from '@shared/protocol'
import type { EmulatorEngine, EmulatorOptions } from '../../types'
import { EmulatorError } from '../../types'
import { EmulatorAudio } from '../audio'
import { instantiateGenesis, type GenesisModule } from './core'
import { prepareGenesisRom } from './rom'

const WIDTH = 320
const HEIGHT = 224
/** Frames of sound kept queued in the worklet (~50 ms): the host's audio latency vs. slack for main-thread hiccups. */
const TARGET_QUEUED_FRAMES = 3
/** Never run more than this many frames in one go (after a stall the game slows down instead of racing). */
const MAX_FRAMES_PER_TICK = 4
const AUDIO_STALE_MS = 120
const TIMER_MS = 4
/** Left stick → d-pad threshold (axes are -127..127). */
const STICK_DPAD = 64

// libretro joypad bits (RETRO_DEVICE_ID_JOYPAD_*), and the Mega Drive button the core reads from each.
const RETRO_B = 1 << 0 // B
const RETRO_Y = 1 << 1 // A
const RETRO_SELECT = 1 << 2 // Mode
const RETRO_START = 1 << 3 // Start
const RETRO_UP = 1 << 4
const RETRO_DOWN = 1 << 5
const RETRO_LEFT = 1 << 6
const RETRO_RIGHT = 1 << 7
const RETRO_A = 1 << 8 // C
const RETRO_X = 1 << 9 // Y
const RETRO_L = 1 << 10 // X
const RETRO_R = 1 << 11 // Z

/**
 * GAME_PAD bit → libretro joypad bit, by position on an Xbox-style pad (systems.ts): the bottom row X / A / B is the
 * Mega Drive's A / B / C, the top row L / Y / R its X / Y / Z, SELECT is Mode.
 */
const PAD_MAP: readonly (readonly [number, number])[] = [
  [GAME_PAD.X, RETRO_Y], // A
  [GAME_PAD.A, RETRO_B], // B
  [GAME_PAD.B, RETRO_A], // C
  [GAME_PAD.L, RETRO_L], // X
  [GAME_PAD.Y, RETRO_X], // Y
  [GAME_PAD.R, RETRO_R], // Z
  [GAME_PAD.START, RETRO_START],
  [GAME_PAD.SELECT, RETRO_SELECT], // Mode
  [GAME_PAD.UP, RETRO_UP],
  [GAME_PAD.DOWN, RETRO_DOWN],
  [GAME_PAD.LEFT, RETRO_LEFT],
  [GAME_PAD.RIGHT, RETRO_RIGHT],
]
const DPAD = GAME_PAD.UP | GAME_PAD.DOWN | GAME_PAD.LEFT | GAME_PAD.RIGHT

/** Exported for tests. */
export function toLibretroPad(buttons: number, axes?: EmuAxes): number {
  let bits = 0
  for (const [pad, retro] of PAD_MAP) if (buttons & pad) bits |= retro
  // The left stick drives the d-pad while no d-pad direction is pressed.
  if (!(buttons & DPAD) && axes) {
    const [x, y] = axes
    if (x < -STICK_DPAD) bits |= RETRO_LEFT
    else if (x > STICK_DPAD) bits |= RETRO_RIGHT
    if (y < -STICK_DPAD) bits |= RETRO_UP
    else if (y > STICK_DPAD) bits |= RETRO_DOWN
  }
  return bits
}

class GenesisEngine implements EmulatorEngine {
  readonly system = 'genesis' as const
  readonly canvas: HTMLCanvasElement
  readonly width = WIDTH
  readonly height = HEIGHT
  /** Diagnostics (not part of the contract): frames run and the average time one takes, in ms. */
  readonly stats = { frames: 0, avgRunMs: 0 }

  private core: GenesisModule | null
  private audio: EmulatorAudio | null = null
  private readonly ctx2d: CanvasRenderingContext2D
  private readonly image: ImageData
  private readonly frameMs: number
  private readonly samplesPerFrame: number
  private nextFrameAt = 0
  private timer: number | undefined
  private stream: MediaStream | null = null
  private _paused = false
  private destroyed = false

  constructor(core: GenesisModule) {
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

  setPad(port: number, buttons: number, axes?: EmuAxes): void {
    if (this.destroyed || !Number.isInteger(port) || port < 0 || port >= EMU_PORTS) return
    this.core!._nexo_set_pad(port, toLibretroPad(buttons | 0, axes))
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
    // The frontend checks the size and the game's fingerprint at the start of the state.
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

  private liveCore(): GenesisModule {
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

export async function createGenesisEngine(opts: EmulatorOptions): Promise<EmulatorEngine> {
  if (opts.system !== 'genesis') throw new EmulatorError("This console isn't supported")
  const rom = await prepareGenesisRom(opts.rom)

  let core: GenesisModule
  try {
    core = await instantiateGenesis()
    core._nexo_init()
  } catch (e) {
    console.error('[emulator] the Mega Drive core failed to load', e)
    throw new EmulatorError("The Mega Drive emulator couldn't start (its core failed to load)")
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
  if (!loaded) throw new EmulatorError("This Mega Drive game couldn't be loaded (the file may be corrupt)")

  const engine = new GenesisEngine(core)
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
