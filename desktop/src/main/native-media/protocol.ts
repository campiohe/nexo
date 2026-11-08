// Protocol v1 between Electron main and the native helper `nexo-media.exe` (docs/SPEC-BETA.md §6).
// Newline-delimited JSON over stdio: commands on the helper's stdin, events on its stdout, one object per line.
// Mirrored by native/nexo-media/src/ipc/protocol.hpp; keep both in sync.
//
// Contract file (Phase 1 of docs/PLAN-BETA.md): workstreams report changes instead of editing it.

import type { NativeShareContentHint, NativeShareEndReason, NativeShareErrorCode } from '../../preload/api'

export const PROTOCOL_VERSION = 1

// ── Shared pieces ──────────────────────────────────────────────────────────────────────────────────────

/** Physical (not DIP) desktop coordinates. */
export interface HelperRect {
  x: number
  y: number
  width: number
  height: number
}

export type HelperSource =
  /** HWND as a decimal string (64-bit safe). */
  | { kind: 'window'; hwnd: string }
  /** Resolved by the helper with MonitorFromRect. */
  | { kind: 'monitor'; rect: HelperRect }

export interface HelperPreset {
  /** Output box; the source is fit inside it keeping its aspect ratio, never upscaled. */
  width: number
  height: number
  fps: number
  /** Upper bound for the encoder bitrate, bits per second. */
  maxBitrate: number
  contentHint: NativeShareContentHint
}

/**
 * - off: no audio track
 * - app: process loopback, INCLUDE the process tree owning the shared window
 * - system-but-nexo: process loopback, EXCLUDE the process tree of `excludePid` (Electron main)
 */
export type HelperAudioMode = 'off' | 'app' | 'system-but-nexo'

export interface HelperCapabilities {
  /** Helper version (semver). */
  version: string
  protocol: number
  /** Windows build number, e.g. 26100. */
  osBuild: number
  /** Adapter chosen for capture + encode, or null when none qualifies. */
  adapter: { name: string; vendor: string; luid: string } | null
  /** Hardware H.264 encoder on that adapter, or null (native share unavailable). */
  encoder: { name: string; vendor: string } | null
  features: {
    /** GraphicsCaptureSession.IsBorderRequired */
    borderless: boolean
    /** GraphicsCaptureSession.MinUpdateInterval */
    minUpdateInterval: boolean
    /** GraphicsCaptureSession.IsCursorCaptureEnabled */
    cursorToggle: boolean
    /** WASAPI process loopback */
    processLoopback: boolean
  }
}

export interface HelperStats {
  /** Frames delivered by WGC per second. */
  captureFps: number
  /** Frames encoded and sent per second. */
  encodeFps: number
  /** Current encoder target, bits per second (after LiveKit feedback, capped by the preset). */
  targetBitrate: number
  /** Measured output bitrate, when known. */
  sentBitrate?: number
  /** Keyframes produced since the share started. */
  keyframes: number
  /** Captured frames that were never encoded (superseded or dropped) since the share started. */
  droppedFrames: number
  /** No new frame for > 1 s (minimized window, static content is not "stalled" for monitors). */
  stalled: boolean
  /** Encoder display name, e.g. "NVIDIA H.264 Encoder MFT". */
  encoder: string
  /** Encoded output size. */
  width: number
  height: number
}

export type HelperState = 'connecting' | 'live' | 'reconnecting' | 'stopped'

export type HelperLogLevel = 'debug' | 'info' | 'warn' | 'error'

/** A top-level window a share can capture (`windows` command). */
export interface HelperWindow {
  /** HWND, decimal: the same number as in Chromium's "window:<hwnd>:0" source ids. */
  hwnd: string
  title: string
  pid: number
  /** Full path of the process image ('' when the helper can't read it). */
  exe: string
  /** Chromium's source list skips minimized windows; main adds these to the picker. */
  minimized: boolean
}

// ── Commands (main → helper) ───────────────────────────────────────────────────────────────────────────

export type HelperCommand =
  | { id: number; type: 'hello'; protocol: number }
  | {
      id: number
      type: 'start'
      source: HelperSource
      preset: HelperPreset
      cursor: boolean
      audio: HelperAudioMode
      /** Electron main's PID (for system-but-nexo). */
      excludePid: number
      /** Never logged by either side. */
      livekit: { url: string; token: string }
    }
  | { id: number; type: 'update'; preset?: Partial<HelperPreset>; cursor?: boolean }
  | { id: number; type: 'stop' }
  | { id: number; type: 'shutdown' }
  /** Lists capturable windows, minimized ones included. Answered with `windows`. */
  | { id: number; type: 'windows' }

export type HelperCommandType = HelperCommand['type']

// ── Events (helper → main) ─────────────────────────────────────────────────────────────────────────────

export type HelperEvent =
  /** Answer to the command with the same id. `hello` answers with `capabilities`, `windows` with `windows`. */
  | { type: 'result'; id: number; ok: true; capabilities?: HelperCapabilities; windows?: HelperWindow[] }
  | { type: 'result'; id: number; ok: false; error: { code: NativeShareErrorCode; message: string } }
  | { type: 'state'; state: HelperState }
  /** 1 Hz while a share is active. */
  | { type: 'stats'; stats: HelperStats }
  | { type: 'ended'; reason: Exclude<NativeShareEndReason, 'crashed'> }
  /** Asynchronous failure during a share (a failed command is reported through `result` instead). */
  | { type: 'error'; code: NativeShareErrorCode; message: string }
  /** Never contains the LiveKit token. */
  | { type: 'log'; level: HelperLogLevel; message: string }

export type HelperEventType = HelperEvent['type']

/** Helper CLI flags (main passes these when spawning). */
export const HELPER_ARGS = {
  /** `--parent-pid=<pid>`: the helper exits when this process exits. */
  parentPid: '--parent-pid',
  /** Print capabilities JSON to stdout and exit. */
  selftest: '--selftest',
} as const
