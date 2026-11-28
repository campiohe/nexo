// The PlayStation engine (contract: ../../types.ts): libretro's PCSX ReARMed compiled to WebAssembly together with
// a tiny libretro frontend of our own (./pcsx_rearmed/: nexo_frontend.c + build.sh), bundled with the app
// (public/emulator/pcsx_rearmed/) and run on the renderer's main thread. Nothing is ever fetched from the
// network: the engine only runs the bytes the host gave it. Without a BIOS file the core's built-in HLE BIOS
// boots the game; a BIOS picked with the game (512 KB, e.g. scph1001.bin) is used instead.
//
// Same clock as the SNES engine (../../engine.ts): the sound card. Whenever less than TARGET_QUEUED_FRAMES frames
// of sound wait in the audio worklet, the next frame runs; if the audio clock stops, a wall-clock timer takes
// over. The picture is always 640×480 (the console's 256..640 × 224..480 modes are stretched into it by the core
// frontend, like a TV showed them), so the stream never changes size.
import { EMU_PORTS, GAME_PAD, type EmuAxes } from '@shared/protocol'
import type { EmulatorEngine, EmulatorOptions } from '../../types'
import { EmulatorError } from '../../types'
import { EmulatorAudio } from '../audio'
import { instantiatePcsx, type PcsxModule } from './core'
import { planDisc } from './disc'

const WIDTH = 640
const HEIGHT = 480
/** Frames of sound kept queued in the worklet (~50 ms): the host's audio latency vs. slack for main-thread hiccups. */
const TARGET_QUEUED_FRAMES = 3
/** Never run more than this many frames in one go (after a stall the game slows down instead of racing). */
const MAX_FRAMES_PER_TICK = 4
const AUDIO_STALE_MS = 120
const TIMER_MS = 4
/**
 * Multitap in PSX port 1, so 4 players work in multitap games. 2-player games that don't know the multitap still
 * work: the tap passes its slot A through, and PSX port 2 mirrors Nexo port 1 (see nexo_frontend.c).
 */
const MULTITAP = true

/** GAME_PAD bit → libretro joypad bit (systems.ts, psx): A→✕, B→○, X→□, Y→△, L/R→L1/R1, L2/R2, L3/R3. */
const PAD_MAP: readonly (readonly [number, number])[] = [
  [GAME_PAD.A, 1 << 0], // RETRO_DEVICE_ID_JOYPAD_B = Cross
  [GAME_PAD.X, 1 << 1], // Y = Square
  [GAME_PAD.SELECT, 1 << 2],
  [GAME_PAD.START, 1 << 3],
  [GAME_PAD.UP, 1 << 4],
  [GAME_PAD.DOWN, 1 << 5],
  [GAME_PAD.LEFT, 1 << 6],
  [GAME_PAD.RIGHT, 1 << 7],
  [GAME_PAD.B, 1 << 8], // A = Circle
  [GAME_PAD.Y, 1 << 9], // X = Triangle
  [GAME_PAD.L, 1 << 10], // L1
  [GAME_PAD.R, 1 << 11], // R1
  [GAME_PAD.L2, 1 << 12],
  [GAME_PAD.R2, 1 << 13],
  [GAME_PAD.L3, 1 << 14],
  [GAME_PAD.R3, 1 << 15],
]

function toLibretroPad(buttons: number): number {
  let bits = 0
  for (const [pad, retro] of PAD_MAP) if (buttons & pad) bits |= retro
  return bits
}

/** EmuAxes value (-127..127) → libretro analog (-32768..32767). */
function toLibretroAxis(v: number | undefined): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return 0
  const c = Math.max(-127, Math.min(127, Math.round(v)))
  return c < 0 ? Math.round((c * 32768) / 127) : Math.round((c * 32767) / 127)
}

/** The core's console output, kept for error reports (it says why a disc didn't load). */
class CoreLog {
  private readonly lines: string[] = []
  readonly push = (line: string): void => {
    this.lines.push(line)
    if (this.lines.length > 40) this.lines.shift()
  }
  dump(): string {
    return this.lines.join('\n')
  }
}

class PsxEngine implements EmulatorEngine {
  readonly system = 'psx' as const
  readonly canvas: HTMLCanvasElement
  readonly width = WIDTH
  readonly height = HEIGHT
  /** Diagnostics (not part of the contract): frames run and the average time one takes, in ms. */
  readonly stats = { frames: 0, avgRunMs: 0, avgDrawMs: 0, srcWidth: 0, srcHeight: 0 }
  /** Diagnostics: the core's latest console lines (BIOS found or HLE, disc tracks, …). */
  readonly coreLog: () => string

  private core: PcsxModule | null
  private audio: EmulatorAudio | null = null
  private readonly ctx2d: CanvasRenderingContext2D
  private readonly image: ImageData
  private frameMs: number
  private nextFrameAt = 0
  private timer: number | undefined
  private stream: MediaStream | null = null
  private dirty = false
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

  constructor(core: PcsxModule, log: CoreLog) {
    this.core = core
    this.coreLog = () => log.dump()
    this.frameMs = 1000 / core._nexo_fps()
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
    // First frame right away: the canvas shows the game as soon as createPsxEngine resolves.
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
        // Audio clock: top up the worklet's queue (the frame rate can change: NTSC / PAL).
        const target = (this.core!._nexo_sample_rate() / this.core!._nexo_fps()) * TARGET_QUEUED_FRAMES
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
    if (this.dirty) this.draw()
  }

  private runFrame(): void {
    const core = this.core!
    const t0 = performance.now()
    const frames = core._nexo_run()
    const dt = performance.now() - t0
    const s = this.stats
    s.frames++
    s.avgRunMs += (dt - s.avgRunMs) * (s.frames < 60 ? 1 / s.frames : 1 / 60)
    if (core._nexo_frame_drawn()) this.dirty = true
    this.frameMs = 1000 / core._nexo_fps()
    if (frames > 0 && this.audio) {
      this.audio.push(new Int16Array(core.HEAPU8.buffer, core._nexo_audio(), frames * 2), frames)
    }
  }

  private draw(): void {
    const core = this.core!
    const t0 = performance.now()
    const ptr = core._nexo_frame()
    this.image.data.set(core.HEAPU8.subarray(ptr, ptr + WIDTH * HEIGHT * 4))
    this.ctx2d.putImageData(this.image, 0, 0)
    this.dirty = false
    const s = this.stats
    s.avgDrawMs += (performance.now() - t0 - s.avgDrawMs) / 60
    s.srcWidth = core._nexo_src_width()
    s.srcHeight = core._nexo_src_height()
  }

  setPad(port: number, buttons: number, axes?: EmuAxes): void {
    if (this.destroyed || !Number.isInteger(port) || port < 0 || port >= EMU_PORTS) return
    // No axes (keyboard): sticks centered; the d-pad works in both of the DualShock's modes (and the left stick
    // presses it in digital mode: pcsx_rearmed/patches/0001).
    const a = axes ?? [0, 0, 0, 0]
    this.core!._nexo_set_pad(
      port,
      toLibretroPad(buttons | 0),
      toLibretroAxis(a[0]),
      toLibretroAxis(a[1]),
      toLibretroAxis(a[2]),
      toLibretroAxis(a[3]),
    )
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
    this.core!._nexo_reset() // takes effect at the start of the next frame
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
    // The core only draws while it runs: one silent frame, so the restored picture shows (also while paused).
    core._nexo_run()
    this.draw()
  }

  private liveCore(): PcsxModule {
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
    this.core = null // the module's memory (and the disc image MEMFS held) goes with it
  }
}

function writeString(core: PcsxModule, s: string): number {
  const bytes = new TextEncoder().encode(s + '\0')
  const ptr = core._malloc(bytes.length)
  if (!ptr) throw new Error('out of memory')
  core.HEAPU8.set(bytes, ptr)
  return ptr
}

export async function createPsxEngine(opts: EmulatorOptions): Promise<EmulatorEngine> {
  const progress = (f: number): void => {
    try {
      opts.onProgress?.(f)
    } catch {
      // the UI's problem, not the game's
    }
  }
  progress(0)
  const plan = planDisc(opts.rom, opts.fileName, opts.extraFiles ?? [])

  const log = new CoreLog()
  let core: PcsxModule
  try {
    core = await instantiatePcsx(log.push)
  } catch (e) {
    console.error('[emulator] the PlayStation core failed to load', e)
    throw new EmulatorError("The PlayStation emulator couldn't start (its core failed to load)")
  }
  progress(0.5)

  let loaded = false
  try {
    // Files first: the core looks for a BIOS in /system when it initializes. The images go in by reference
    // (canOwn): MEMFS reads sectors straight out of the host's buffers, nothing is copied.
    core.FS.mkdir('/disc')
    core.FS.mkdir('/system')
    for (const f of plan.files) core.FS.writeFile(f.path, f.data, { canOwn: typeof f.data !== 'string' })
    if (plan.bios) core.FS.writeFile(`/system/${plan.bios.name}`, plan.bios.data, { canOwn: true })
    core._nexo_init()
    core._nexo_set_multitap(MULTITAP ? 1 : 0)
    progress(0.7)
    const path = writeString(core, plan.main)
    try {
      loaded = core._nexo_load(path) === 1
    } finally {
      core._free(path)
    }
  } catch (e) {
    console.error('[emulator] loading the game crashed the core', e)
  }
  if (!loaded) {
    console.error('[emulator] the PlayStation core rejected the game:\n' + log.dump())
    try {
      core._nexo_unload()
    } catch {
      // dropping the module frees everything anyway
    }
    throw new EmulatorError("This PlayStation game couldn't be loaded (the disc image may be incomplete or corrupt)")
  }

  const engine = new PsxEngine(core, log)
  try {
    await engine.start()
  } catch (e) {
    engine.destroy()
    if (e instanceof EmulatorError) throw e
    console.error('[emulator] starting the game failed', e)
    throw new EmulatorError("The emulator couldn't start its sound output")
  }
  progress(1)
  return engine
}
