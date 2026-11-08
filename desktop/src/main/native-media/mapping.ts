// Helper protocol types → preload bridge types (NativeShare*). Pure: no Electron imports.
import type {
  NativeShareCapabilities,
  NativeShareError,
  NativeShareErrorCode,
  NativeShareStats,
} from '../../preload/api'
import { PROTOCOL_VERSION, type HelperCapabilities, type HelperStats } from './protocol'

/**
 * Whether the renderer should retry a failed native share on the Chromium engine.
 *
 * true: the native path itself can't work right now, but getDisplayMedia probably can.
 * - helper-unavailable / helper-crashed: no usable helper (missing exe, not Windows, crashed twice)
 * - encoder-unavailable: no hardware H.264 MFT, or its session limit is reached (e.g. OBS recording);
 *   Chromium falls back to its software encoder
 * - capture-failed: WGC refused the item; Chromium's capturer has other code paths (and reports a gone
 *   source on its own)
 * - protocol: helper/app version mismatch or garbage on stdout, or an unanswered command
 *
 * false: Chromium would fail the same way, or the share is fine.
 * - livekit-connect: the SFU or the network is the problem, not the engine
 * - audio-failed: video keeps going on the native path
 * - busy: a native share is already running (a renderer bookkeeping bug, not an engine failure)
 * - internal: invalid arguments or an unexpected bug; retrying elsewhere would hide it
 */
export function fallbackFor(code: NativeShareErrorCode): boolean {
  switch (code) {
    case 'helper-unavailable':
    case 'helper-crashed':
    case 'encoder-unavailable':
    case 'capture-failed':
    case 'protocol':
      return true
    case 'livekit-connect':
    case 'audio-failed':
    case 'busy':
    case 'internal':
      return false
  }
}

/** An Error carrying a NativeShareError's fields. Main-side only: it never crosses IPC as an Error. */
export class NativeShareFailure extends Error implements NativeShareError {
  readonly code: NativeShareErrorCode
  readonly fallback: boolean

  constructor(code: NativeShareErrorCode, message: string, fallback = fallbackFor(code)) {
    super(message)
    this.name = 'NativeShareFailure'
    this.code = code
    this.fallback = fallback
  }

  toJSON(): NativeShareError {
    return { code: this.code, message: this.message, fallback: this.fallback }
  }
}

/** Any thrown value → a plain NativeShareError (unknown errors become `internal`). */
export function toNativeShareError(err: unknown): NativeShareError {
  if (err instanceof NativeShareFailure) return err.toJSON()
  const message = err instanceof Error ? err.message : String(err)
  return { code: 'internal', message, fallback: fallbackFor('internal') }
}

export function toBridgeCapabilities(caps: HelperCapabilities, osOk: boolean): NativeShareCapabilities {
  const out: NativeShareCapabilities = {
    available: false,
    version: caps.version,
    osBuild: caps.osBuild,
    features: { ...caps.features },
  }
  if (caps.adapter) out.adapter = caps.adapter.name
  if (caps.encoder) out.encoder = caps.encoder.name
  if (!osOk) out.reason = 'Native capture is only available on Windows'
  else if (caps.protocol !== PROTOCOL_VERSION)
    out.reason = `nexo-media speaks protocol ${caps.protocol}, this Nexo needs ${PROTOCOL_VERSION}; reinstall Nexo`
  else if (!caps.adapter) out.reason = 'No suitable GPU found for native capture'
  else if (!caps.encoder) out.reason = `No hardware H.264 encoder on ${caps.adapter.name}`
  else out.available = true
  return out
}

export function unavailableCapabilities(reason: string): NativeShareCapabilities {
  return { available: false, reason }
}

export function toBridgeStats(s: HelperStats): NativeShareStats {
  const out: NativeShareStats = {
    captureFps: s.captureFps,
    encodeFps: s.encodeFps,
    targetBitrate: s.targetBitrate,
    keyframes: s.keyframes,
    droppedFrames: s.droppedFrames,
    stalled: s.stalled,
    encoder: s.encoder,
    width: s.width,
    height: s.height,
  }
  if (s.sentBitrate !== undefined) out.sentBitrate = s.sentBitrate
  return out
}
