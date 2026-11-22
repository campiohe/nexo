// Contract of the emulator engine (emulator/engine.ts) used by the emulator UI (components/emulator/*).
// The engine runs on the HOST's device only: it loads a game file the host picked from their own disk, runs it,
// takes the 4 controllers' buttons (GAME_PAD bits, from the host's own input and from players relayed by the
// server) and exposes its picture and sound as a MediaStream that voice/session.ts publishes as the host's stream.
import type { EmuAxes, EmuSystem } from '@shared/protocol'

export interface EmulatorOptions {
  system: EmuSystem
  /** The game file's bytes (read with File.arrayBuffer() from the host's file picker / drop). */
  rom: Uint8Array
  /** The original file name (some cores look at the extension, e.g. .sfc / .smc / .zip / .cue). */
  fileName: string
  /**
   * Other files the host picked together with the game, by their original names: a PlayStation disc's track files
   * next to its .cue (`Game (Track 1).bin`…), or a BIOS file (e.g. `scph1001.bin`). Engines that need none ignore
   * them. The `rom` file isn't repeated here.
   */
  extraFiles?: { name: string; data: Uint8Array }[]
  /** Loading progress for big games (0..1), e.g. while a disc image is copied into the core. Optional. */
  onProgress?(fraction: number): void
}

export interface EmulatorEngine {
  readonly system: EmuSystem
  /**
   * The canvas the game is drawn into, at a FIXED size for the whole session (e.g. 256×224 for SNES; 640×480 or
   * 320×240 for consoles whose resolution changes between screens: scale into the fixed size), already
   * running once `createEmulator` resolves. The UI attaches it to the DOM for the host's own (zero-latency) view
   * and scales it with CSS (image-rendering: pixelated).
   */
  readonly canvas: HTMLCanvasElement
  /** Size of the canvas (fixed). The picture is shown 4:3 like a TV (SNES 256×224 included). */
  readonly width: number
  readonly height: number
  /**
   * Set the held buttons of controller `port` (0..EMU_PORTS-1) as GAME_PAD bits, and its sticks (absent = centered).
   * Takes effect next frame. Systems with an analog stick but a player without one (keyboard: no axes) should
   * drive the stick from the d-pad (full tilt), so N64 games stay playable on a keyboard.
   */
  setPad(port: number, buttons: number, axes?: EmuAxes): void
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
  /**
   * Set by the UI: called once if the core crashes (the game then stays paused for good; only loading a game
   * again helps). Without it, a crash only shows in the console.
   */
  onCrash: ((message: string) => void) | null
  /** Stops everything, ends the stream's tracks, frees the core. Safe to call twice. */
  destroy(): void
}

/** Thrown by createEmulator with a readable message (bad file, unsupported system, core failed to load). */
export class EmulatorError extends Error {
  override name = 'EmulatorError'
}
