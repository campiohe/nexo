// Contract of the emulator engine (emulator/engine.ts) used by the emulator UI (components/emulator/*).
// The engine runs on the HOST's device only: it loads a game file the host picked from their own disk, runs it,
// takes the 4 controllers' buttons (GAME_PAD bits, from the host's own input and from players relayed by the
// server) and exposes its picture and sound as a MediaStream that voice/session.ts publishes as the host's stream.
import type { EmuSystem } from '@shared/protocol'

export interface EmulatorOptions {
  system: EmuSystem
  /** The game file's bytes (read with File.arrayBuffer() from the host's file picker / drop). */
  rom: Uint8Array
  /** The original file name (some cores look at the extension, e.g. .sfc / .smc / .zip). */
  fileName: string
}

export interface EmulatorEngine {
  readonly system: EmuSystem
  /**
   * The canvas the game is drawn into, at the console's native resolution (e.g. 256×224 for SNES), already
   * running once `createEmulator` resolves. The UI attaches it to the DOM for the host's own (zero-latency) view
   * and scales it with CSS (image-rendering: pixelated).
   */
  readonly canvas: HTMLCanvasElement
  /** Native size of the picture (for aspect ratio: SNES shows 256×224 on a 4:3 screen). */
  readonly width: number
  readonly height: number
  /** Set the held buttons of controller `port` (0..EMU_PORTS-1) as GAME_PAD bits. Takes effect next frame. */
  setPad(port: number, buttons: number): void
  pause(): void
  resume(): void
  readonly paused: boolean
  /** Soft reset (the console's reset button). */
  reset(): void
  /**
   * Picture + sound for streaming: one video track (the canvas at `fps`) and one audio track (the game's sound,
   * stereo). The same stream is returned on every call; its tracks end on destroy().
   */
  mediaStream(fps?: number): MediaStream
  /** The host's own speaker volume for the game, 0..1 (doesn't change the streamed sound). */
  setLocalVolume(volume: number): void
  /** Quick save / load in memory (one slot). Optional per engine. */
  saveState?(): Promise<Uint8Array>
  loadState?(state: Uint8Array): Promise<void>
  /** Stops everything, ends the stream's tracks, frees the core. Safe to call twice. */
  destroy(): void
}

/** Thrown by createEmulator with a readable message (bad file, unsupported system, core failed to load). */
export class EmulatorError extends Error {
  override name = 'EmulatorError'
}
