// Server clock estimate for the music plugin: MusicState timing is in server time (startedAt), and every client
// must agree on "now" to play the same position. Offset from `time:now` round trips (the lowest-RTT sample of a
// small burst, voice/musicSync.ts pickClockOffset), refreshed every few minutes and after each reconnect while
// running. Started / stopped by voice/musicPlayer.ts (only needed while in a voice channel with music on).
import { onConnected, request } from '../net/socket'
import { pickClockOffset, type ClockSample } from './musicSync'

const SAMPLES = 5
const SAMPLE_GAP_MS = 60
const REFRESH_MS = 5 * 60 * 1000
/** A sync attempt (all samples) giving up; also how long playback waits for the first one. */
const FIRST_SYNC_WAIT_MS = 2500

/** serverNow - Date.now(), ms. 0 until measured (older servers without `time:now`: assume synced clocks). */
let offset = 0
let measured = false
let running = false
let refreshTimer: number | undefined
let offConnected: (() => void) | null = null
let inflight: Promise<void> | null = null
const listeners = new Set<() => void>()

/** The server's clock now (ms epoch), as well as this device can tell. */
export function serverNow(): number {
  return Date.now() + offset
}

/** Called after every sync that changed the offset (the player re-checks its position). */
export function onClockChange(cb: () => void): () => void {
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}

const wait = (ms: number) => new Promise<void>((r) => window.setTimeout(r, ms))

async function sample(): Promise<ClockSample | null> {
  const t0 = Date.now()
  try {
    const { now } = await request('time:now', {})
    const t1 = Date.now()
    return typeof now === 'number' && Number.isFinite(now) ? { t0, t1, server: now } : null
  } catch {
    return null
  }
}

/** One burst of samples; keeps the previous offset when none succeeds. */
export function syncClock(): Promise<void> {
  if (inflight) return inflight
  inflight = (async () => {
    const samples: ClockSample[] = []
    for (let i = 0; i < SAMPLES; i++) {
      const s = await sample()
      // The first failure is most likely an older server without `time:now` (or offline): don't insist.
      if (!s) break
      samples.push(s)
      if (i < SAMPLES - 1) await wait(SAMPLE_GAP_MS)
    }
    const best = pickClockOffset(samples)
    if (!best) return
    const changed = !measured || Math.abs(best.offset - offset) > 5
    offset = best.offset
    measured = true
    if (changed) for (const cb of [...listeners]) cb()
  })().finally(() => {
    inflight = null
  })
  return inflight
}

/** Resolves after the first sync attempt (or FIRST_SYNC_WAIT_MS), so a track doesn't start at a guessed position. */
export function whenClockReady(): Promise<void> {
  if (measured || !running) return Promise.resolve()
  return Promise.race([syncClock(), wait(FIRST_SYNC_WAIT_MS)])
}

export function startMusicClock(): void {
  if (running) return
  running = true
  void syncClock()
  refreshTimer = window.setInterval(() => void syncClock(), REFRESH_MS)
  // After a reconnect the server may be another process (restart) or the network path changed.
  offConnected = onConnected(() => void syncClock())
}

export function stopMusicClock(): void {
  if (!running) return
  running = false
  window.clearInterval(refreshTimer)
  refreshTimer = undefined
  offConnected?.()
  offConnected = null
}

/** Signed out / another server: the next server's clock is measured from scratch. */
export function resetMusicClock(): void {
  stopMusicClock()
  offset = 0
  measured = false
}
