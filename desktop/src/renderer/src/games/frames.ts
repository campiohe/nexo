// The running match's frames (GameFrame views) as they arrive, outside React: game views read them every
// animation frame. Interpolation: frames are placed on a local timeline from their tick numbers (not their
// jittery arrival times), and `sample` renders a little in the past so there is usually a frame on each side.
import type { GameFrame } from '@shared/protocol'
import { GAMES } from '@shared/games/index'
import { useGames } from '../store/games'

export interface FrameSample<V> {
  /** The frame at or before the render time (the latest one if we're behind). */
  a: { tick: number; view: V }
  /** The next one (= a when there's none yet). */
  b: { tick: number; view: V }
  /** Position between a and b, 0..1 (lerp positions with it). */
  t: number
}

export interface FrameSource<V = unknown> {
  /** The newest frame (null before the first). */
  latest(): { tick: number; view: V } | null
  /** Two frames around the render time and how far between them we are. null before the first frame. */
  sample(nowMs?: number): FrameSample<V> | null
  /** Bumped on every new frame (cheap change detection for canvases that only redraw on change). */
  version(): number
  /**
   * About how long after you press a button its effect shows on screen (ms): the network round trip (measured
   * while you play) + the interpolation delay + half a tick. For local prediction of your own input, e.g.
   * turning the camera at once and letting the server's state catch up.
   */
  latencyMs(): number
}

const KEEP = 12

class FrameBuffer {
  matchId: string | null = null
  dtMs = 50
  /** How many ticks behind the newest data we render (frameEvery + a little jitter room). */
  delayTicks = 2
  private frames: { tick: number; view: unknown }[] = []
  /** Local time (performance.now) of tick 0, estimated as min(arrival - tick·dt) with a slow upward drift. */
  private offset: number | null = null
  private v = 0
  /** Smoothed round trip to the server (ms); a typical LAN / Tailscale value until measured. */
  private rtt = 60

  reset(matchId: string | null, tickHz = 20, frameEvery = 1): void {
    this.matchId = matchId
    this.dtMs = 1000 / tickHz
    this.delayTicks = frameEvery + 1
    this.frames = []
    this.offset = null
    this.v++
  }

  push(f: GameFrame, at = performance.now()): void {
    if (f.matchId !== this.matchId) return
    const last = this.frames[this.frames.length - 1]
    if (last && f.tick <= last.tick) {
      // Same tick again (an actions game sends one after each move): replace it.
      if (f.tick === last.tick) last.view = f.view
      else return
    } else {
      this.frames.push({ tick: f.tick, view: f.view })
      if (this.frames.length > KEEP) this.frames.shift()
    }
    const o = at - f.tick * this.dtMs
    if (this.offset === null || o < this.offset) this.offset = o
    else this.offset += (o - this.offset) * 0.02
    this.v++
  }

  latest() {
    return this.frames[this.frames.length - 1] ?? null
  }

  sample(nowMs = performance.now()): FrameSample<unknown> | null {
    const n = this.frames.length
    if (n === 0 || this.offset === null) return null
    const renderTick = (nowMs - this.offset) / this.dtMs - this.delayTicks
    let i = n - 1
    while (i > 0 && this.frames[i].tick > renderTick) i--
    const a = this.frames[i]
    const b = this.frames[Math.min(n - 1, i + 1)]
    if (a === b || b.tick === a.tick) return { a, b: a, t: 0 }
    const t = Math.min(1, Math.max(0, (renderTick - a.tick) / (b.tick - a.tick)))
    return { a, b, t }
  }

  version() {
    return this.v
  }

  /** A measured round trip (GameArea pings the server while you play). */
  addRttSample(ms: number): void {
    if (!Number.isFinite(ms) || ms < 0 || ms > 5000) return
    this.rtt += (ms - this.rtt) * 0.3
  }

  latencyMs() {
    return this.rtt + this.delayTicks * this.dtMs + this.dtMs / 2
  }
}

/** The one buffer: this device watches at most one match (its voice channel's). */
export const frameBuffer = new FrameBuffer()

/**
 * `games:frame` (net/socket.ts). The first frame of a new match resets the buffer here (not in a React effect,
 * which would run after it and drop it): `games:lobby` for the match arrives before its frames.
 */
export function handleGameFrame(f: GameFrame): void {
  if (!f || typeof f !== 'object' || typeof f.matchId !== 'string' || typeof f.tick !== 'number') return
  if (f.matchId !== frameBuffer.matchId) {
    const lobby = useGames.getState().byChannel[f.channelId]
    const def = lobby?.matchId === f.matchId ? GAMES[lobby.gameId] : undefined
    if (!def) return
    frameBuffer.reset(f.matchId, def.tickHz, def.frameEvery ?? 1)
  }
  frameBuffer.push(f)
}

export function frameSource<V>(): FrameSource<V> {
  return frameBuffer as unknown as FrameSource<V>
}
