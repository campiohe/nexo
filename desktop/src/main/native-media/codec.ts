// JSON-lines codec for the nexo-media protocol (./protocol.ts, docs/SPEC-BETA.md §6).
// Pure: no Electron or child_process imports, so scripts can exercise it outside the app.
import type { NativeShareErrorCode } from '../../preload/api'
import type {
  HelperCapabilities,
  HelperCommand,
  HelperEvent,
  HelperLogLevel,
  HelperState,
  HelperStats,
} from './protocol'

/** A line longer than this is dropped (the helper never sends anything close to it). */
export const MAX_LINE_BYTES = 1 << 20

const STATES: readonly HelperState[] = ['connecting', 'live', 'reconnecting', 'stopped']
const END_REASONS = ['source-closed', 'stopped', 'device-lost', 'error'] as const
const LOG_LEVELS: readonly HelperLogLevel[] = ['debug', 'info', 'warn', 'error']
export const ERROR_CODES: readonly NativeShareErrorCode[] = [
  'helper-unavailable',
  'helper-crashed',
  'encoder-unavailable',
  'capture-failed',
  'livekit-connect',
  'audio-failed',
  'busy',
  'protocol',
  'internal',
]
const MAX_TEXT = 4096

/** Splits a byte stream into lines. Oversized lines are reported through `onOverflow` and skipped. */
export class LineSplitter {
  private buffer = ''
  private overflowing = false

  constructor(
    private readonly onLine: (line: string) => void,
    private readonly onOverflow: () => void = () => {},
  ) {}

  push(chunk: string): void {
    let data = chunk
    for (;;) {
      const nl = data.indexOf('\n')
      if (nl < 0) {
        if (!this.overflowing) {
          this.buffer += data
          if (this.buffer.length > MAX_LINE_BYTES) {
            this.buffer = ''
            this.overflowing = true
            this.onOverflow()
          }
        }
        return
      }
      const head = data.slice(0, nl)
      data = data.slice(nl + 1)
      if (this.overflowing) {
        this.overflowing = false
        continue
      }
      const line = (this.buffer + head).replace(/\r$/, '')
      this.buffer = ''
      if (line.length > MAX_LINE_BYTES) {
        this.onOverflow()
        continue
      }
      if (line.trim()) this.onLine(line)
    }
  }
}

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const isStr = (v: unknown, max = MAX_TEXT): v is string => typeof v === 'string' && v.length <= max
const isBool = (v: unknown): v is boolean => typeof v === 'boolean'

/** Unknown error codes from a newer helper are kept as 'internal' rather than rejected. */
export function normalizeErrorCode(code: unknown): NativeShareErrorCode {
  return ERROR_CODES.includes(code as NativeShareErrorCode) ? (code as NativeShareErrorCode) : 'internal'
}

export function isHelperCapabilities(v: unknown): v is HelperCapabilities {
  if (!isObj(v)) return false
  if (!isStr(v.version, 64) || !isNum(v.protocol) || !isNum(v.osBuild)) return false
  const a = v.adapter
  if (a !== null && !(isObj(a) && isStr(a.name, 256) && isStr(a.vendor, 256) && isStr(a.luid, 64))) return false
  const e = v.encoder
  if (e !== null && !(isObj(e) && isStr(e.name, 256) && isStr(e.vendor, 256))) return false
  const f = v.features
  return (
    isObj(f) && isBool(f.borderless) && isBool(f.minUpdateInterval) && isBool(f.cursorToggle) && isBool(f.processLoopback)
  )
}

export function isHelperStats(v: unknown): v is HelperStats {
  if (!isObj(v)) return false
  const nums = ['captureFps', 'encodeFps', 'targetBitrate', 'keyframes', 'droppedFrames', 'width', 'height'] as const
  return (
    nums.every((k) => isNum(v[k]) && (v[k] as number) >= 0) &&
    (v.sentBitrate === undefined || (isNum(v.sentBitrate) && v.sentBitrate >= 0)) &&
    isBool(v.stalled) &&
    isStr(v.encoder, 256)
  )
}

export type ParseResult = { ok: true; event: HelperEvent } | { ok: false; error: string }

/** Parses and validates one line from the helper's stdout. Returns a fresh object (no extra fields). */
export function parseHelperEvent(line: string): ParseResult {
  let v: unknown
  try {
    v = JSON.parse(line)
  } catch {
    return { ok: false, error: 'not JSON' }
  }
  if (!isObj(v)) return { ok: false, error: 'not an object' }
  const bad = (what: string): ParseResult => ({ ok: false, error: `invalid ${String(v.type).slice(0, 32)} event: ${what}` })

  switch (v.type) {
    case 'result': {
      if (!Number.isSafeInteger(v.id) || (v.id as number) < 0) return bad('id')
      const id = v.id as number
      if (v.ok === true) {
        if (v.capabilities === undefined) return { ok: true, event: { type: 'result', id, ok: true } }
        if (!isHelperCapabilities(v.capabilities)) return bad('capabilities')
        return { ok: true, event: { type: 'result', id, ok: true, capabilities: v.capabilities } }
      }
      if (v.ok === false) {
        const e = v.error
        if (!isObj(e) || !isStr(e.code, 64) || !isStr(e.message)) return bad('error')
        return { ok: true, event: { type: 'result', id, ok: false, error: { code: normalizeErrorCode(e.code), message: e.message } } }
      }
      return bad('ok')
    }
    case 'state':
      if (!STATES.includes(v.state as HelperState)) return bad('state')
      return { ok: true, event: { type: 'state', state: v.state as HelperState } }
    case 'stats': {
      if (!isHelperStats(v.stats)) return bad('stats')
      const s = v.stats
      const stats: HelperStats = {
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
      if (s.sentBitrate !== undefined) stats.sentBitrate = s.sentBitrate
      return { ok: true, event: { type: 'stats', stats } }
    }
    case 'ended':
      if (!END_REASONS.includes(v.reason as (typeof END_REASONS)[number])) return bad('reason')
      return { ok: true, event: { type: 'ended', reason: v.reason as (typeof END_REASONS)[number] } }
    case 'error':
      if (!isStr(v.code, 64) || !isStr(v.message)) return bad('code/message')
      return { ok: true, event: { type: 'error', code: normalizeErrorCode(v.code), message: v.message } }
    case 'log':
      if (!LOG_LEVELS.includes(v.level as HelperLogLevel) || !isStr(v.message, MAX_LINE_BYTES)) return bad('level/message')
      return { ok: true, event: { type: 'log', level: v.level as HelperLogLevel, message: v.message } }
    default:
      return { ok: false, error: `unknown event type ${JSON.stringify(v.type)?.slice(0, 32)}` }
  }
}

export function encodeCommand(cmd: HelperCommand): string {
  return `${JSON.stringify(cmd)}\n`
}

export const REDACTED = '[redacted]'

/** A copy of `cmd` that is safe to print: the LiveKit token is replaced. */
export function redactCommand(cmd: HelperCommand): HelperCommand {
  if (cmd.type !== 'start') return cmd
  return { ...cmd, livekit: { url: cmd.livekit.url, token: REDACTED } }
}

/** Replaces every occurrence of each secret in `text` (defence in depth for helper log lines). */
export function redactText(text: string, secrets: Iterable<string>): string {
  let out = text
  for (const s of secrets) if (s.length >= 8) out = out.split(s).join(REDACTED)
  return out
}
