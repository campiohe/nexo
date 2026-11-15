// Music plugin "listen together": the pure math behind keeping every client on the same position (clock offset
// selection, expected position from MusicState, drift decisions, queue drop index). No imports with side
// effects (type-only), so it can be unit-tested with plain node and imported from anywhere.
import type { MusicState } from '@shared/protocol'

// ---------------------------------------------------------------------------------------------
// Clock offset (time:now)

/** One `time:now` round trip: local Date.now() before (t0) and after (t1), and the server's answer. */
export interface ClockSample {
  t0: number
  t1: number
  server: number
}

/**
 * The offset (serverNow - localNow, ms) from the sample with the lowest round trip: the server read its clock
 * somewhere inside [t0, t1], best guessed as the midpoint, and a shorter trip bounds that guess tighter.
 * Samples with a negative or non-finite round trip (clock jumped mid-sample) are ignored. null when none is usable.
 */
export function pickClockOffset(samples: readonly ClockSample[]): { offset: number; rtt: number } | null {
  let best: { offset: number; rtt: number } | null = null
  for (const s of samples) {
    const rtt = s.t1 - s.t0
    if (!Number.isFinite(rtt) || rtt < 0 || !Number.isFinite(s.server)) continue
    if (!best || rtt < best.rtt) best = { offset: s.server - (s.t0 + s.t1) / 2, rtt }
  }
  return best
}

// ---------------------------------------------------------------------------------------------
// Shared position

/** True while the session's current track is playing (not paused / stopped). */
export function isMusicPlaying(state: MusicState | null | undefined): boolean {
  return !!state?.current && state.startedAt !== null
}

/**
 * Where everyone should be in the current track (ms), at server time `serverNow`. null without a current track.
 * Playing: serverNow - startedAt; paused: pausedAt. Clamped to [0, durationMs].
 */
export function expectedPositionMs(state: MusicState | null | undefined, serverNow: number): number | null {
  const cur = state?.current
  if (!state || !cur) return null
  const raw = state.startedAt !== null ? serverNow - state.startedAt : (state.pausedAt ?? 0)
  return Math.min(Math.max(0, raw), Math.max(0, cur.durationMs))
}

// ---------------------------------------------------------------------------------------------
// Drift correction

/** Beyond this (ms, either way) the player jumps to the right position. */
export const HARD_SEEK_MS = 750
/** From this much drift (ms) the player starts nudging its playback rate… */
export const NUDGE_START_MS = 80
/** …and goes back to normal speed once within this much. */
export const NUDGE_STOP_MS = 40
/** Rates used while nudging: slow down when ahead, speed up when behind (±3% is hard to hear; pitch is kept). */
export const RATE_SLOW = 0.97
export const RATE_FAST = 1.03

export type DriftAction = { kind: 'ok'; rate: number } | { kind: 'seek' } | { kind: 'rate'; rate: number }

/**
 * What to do about `driftMs` = local position - expected position (positive = this client is ahead), given the
 * playback rate in use (1 = not nudging). Hysteresis: nudging starts at NUDGE_START_MS and only stops within
 * NUDGE_STOP_MS, so the rate doesn't flap around one threshold.
 */
export function driftDecision(driftMs: number, currentRate: number): DriftAction {
  const abs = Math.abs(driftMs)
  if (!Number.isFinite(driftMs) || abs > HARD_SEEK_MS) return { kind: 'seek' }
  const nudging = currentRate !== 1
  if (nudging ? abs <= NUDGE_STOP_MS : abs < NUDGE_START_MS) return { kind: 'ok', rate: 1 }
  return { kind: 'rate', rate: driftMs > 0 ? RATE_SLOW : RATE_FAST }
}

/** Longest head start given to a hard seek (ms). */
export const MAX_SEEK_LEAD_MS = 1500

/**
 * Seeking a stream isn't instant (the new range is fetched and decoded while the shared position moves on), so
 * hard seeks aim ahead by `lead` ms. After a seek, the first drift measured once playback resumed tells how far
 * off the lead was: behind (negative drift) → lead more, ahead → lead less. Clamped to [0, MAX_SEEK_LEAD_MS].
 */
export function nextSeekLead(lead: number, residualDriftMs: number): number {
  if (!Number.isFinite(residualDriftMs)) return lead
  return Math.min(MAX_SEEK_LEAD_MS, Math.max(0, lead - residualDriftMs))
}

// ---------------------------------------------------------------------------------------------
// Queue drag and drop

/**
 * Final index (in the queue after the move, what `music:control move` takes as `toIndex`) when the entry at
 * `from` is dropped before (`after` false) or after the entry at `over`. null when it wouldn't move.
 */
export function queueDropIndex(from: number, over: number, after: boolean): number | null {
  if (from < 0 || over < 0 || over === from) return null
  // Index in the list without the dragged entry, then the insertion point there.
  const overWithout = over > from ? over - 1 : over
  const to = after ? overWithout + 1 : overWithout
  return to === from ? null : to
}

// ---------------------------------------------------------------------------------------------
// Formatting

/** 3:07, 1:02:09 */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`
}

/** "1 h 02 min", "12 min", "45 s": total queue length. */
export function formatTotal(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000))
  if (total < 60) return `${total} s`
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  return h > 0 ? `${h} h ${String(m).padStart(2, '0')} min` : `${m} min`
}
