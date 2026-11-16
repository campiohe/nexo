// Music plugin ("listen together", docs/SPEC.md §5.4): the shared per-voice-channel state machine. Clients fetch
// and play the tracks themselves at the position derived from MusicState; this module only keeps the queue and
// the timing, advances to the next track on a timer (from `durationMs`) and pauses sessions whose voice channel
// emptied. Memory only. Clock and timers are injectable so tests can drive it without waiting.
import { randomBytes } from 'node:crypto'
import type { MusicState, MusicTrack, MusicTrackInfo } from '../../shared/protocol.ts'
import { MUSIC_IDLE_CLEAR_MS, MUSIC_MAX_ADD, MUSIC_MAX_QUEUE, MUSIC_MAX_TRACK_MS } from '../../shared/protocol.ts'
import { normalizeDisplayText } from './text.ts'

/** Ack errors of `music:add` / `music:control` (the plugin/channel/voice checks are made by server.ts). */
export const MUSIC_ERRORS = {
  pluginOff: 'The Music plugin is off',
  channelNotFound: 'Voice channel not found',
  notInChannel: 'Join the voice channel to control its music',
  invalidTrack: 'Invalid track',
  tooManyAdd: `You can add at most ${MUSIC_MAX_ADD} tracks at once`,
  queueFull: `The queue is full (${MUSIC_MAX_QUEUE} tracks)`,
  notInQueue: 'That track is no longer in the queue',
  invalidAction: 'Invalid music action',
  slowDown: 'Slow down',
} as const

export const MUSIC_LIMITS = {
  /** title / artist / album, in UTF-16 units after normalizeDisplayText. */
  textMax: 200,
  artworkUrlMax: 2048,
  /**
   * The server advances this long after a track's nominal end, so clients finish it naturally (their
   * playback starts a little after `startedAt`: fetch, buffering, network) instead of being cut.
   */
  advanceGraceMs: 750,
  /** `previous` goes back to the last played track only within this long of the current one's start. */
  previousRestartMs: 3000,
  /** Played tracks remembered for `previous`. */
  historyMax: 20,
  /** `seek` is clamped to [0, durationMs - this]. */
  seekEndMarginMs: 1000,
} as const

export const MUSIC_ACTIONS = ['play', 'pause', 'seek', 'skip', 'previous', 'remove', 'move', 'clear', 'stop'] as const
export type MusicAction = (typeof MUSIC_ACTIONS)[number]

const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/
const isStr = (v: unknown): v is string => typeof v === 'string'
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null

/** Artwork hosts: ytimg.com and its subdomains (i.ytimg.com…), and subdomains of googleusercontent.com (lh3…). */
function isArtworkHost(host: string): boolean {
  return host === 'ytimg.com' || host.endsWith('.ytimg.com') || host.endsWith('.googleusercontent.com')
}

/** An https artwork URL on an allowed host (normalized by URL), else null. Never rejects the track. */
export function parseArtwork(raw: unknown): string | null {
  if (!isStr(raw) || raw.length > MUSIC_LIMITS.artworkUrlMax) return null
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return null
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) return null
  if (!isArtworkHost(url.hostname)) return null
  return url.href.length <= MUSIC_LIMITS.artworkUrlMax ? url.href : null
}

/** A text field normalized like other display text, or null when not a string or longer than textMax. */
function parseText(raw: unknown): string | null {
  if (!isStr(raw)) return null
  const text = normalizeDisplayText(raw)
  return text.length <= MUSIC_LIMITS.textMax ? text : null
}

/**
 * A MusicTrackInfo from an untrusted payload (only the known fields are kept), or null when invalid:
 * videoId /^[A-Za-z0-9_-]{11}$/, title 1..200 and artist 0..200 characters, album null/absent or 0..200
 * (empty → null), durationMs an integer in [1000, MUSIC_MAX_TRACK_MS]. A bad artwork is dropped (null), not an error.
 */
export function parseTrackInfo(raw: unknown): MusicTrackInfo | null {
  if (!isObj(raw)) return null
  if (!isStr(raw.videoId) || !VIDEO_ID_RE.test(raw.videoId)) return null
  const title = parseText(raw.title)
  if (!title) return null
  const artist = parseText(raw.artist)
  if (artist === null) return null
  let album: string | null = null
  if (raw.album !== null && raw.album !== undefined) {
    const a = parseText(raw.album)
    if (a === null) return null
    album = a || null
  }
  const d = raw.durationMs
  if (typeof d !== 'number' || !Number.isInteger(d) || d < 1000 || d > MUSIC_MAX_TRACK_MS) return null
  return { videoId: raw.videoId, title, artist, album, durationMs: d, artwork: parseArtwork(raw.artwork) }
}

export interface MusicTimers {
  set(fn: () => void, ms: number): unknown
  clear(handle: unknown): void
}

const realTimers: MusicTimers = {
  set(fn, ms) {
    const t = setTimeout(fn, ms)
    t.unref?.()
    return t
  },
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
}

export interface MusicOptions {
  /** Called with every changed state (server.ts broadcasts it as `music:state`). */
  onState: (state: MusicState) => void
  /** Server clock (ms epoch). Default: Date.now. */
  now?: () => number
  /** Default: setTimeout/clearTimeout (unref'd). */
  timers?: MusicTimers
  /** Default: MUSIC_LIMITS.advanceGraceMs. */
  advanceGraceMs?: number
  /** Default: MUSIC_IDLE_CLEAR_MS. */
  idleClearMs?: number
  /** queueId generator. Default: 12 random bytes, base64url. */
  newId?: () => string
}

export interface MusicControl {
  action?: unknown
  positionMs?: unknown
  queueId?: unknown
  toIndex?: unknown
}

interface Session {
  channelId: string
  current: MusicTrack | null
  queue: MusicTrack[]
  startedAt: number | null
  pausedAt: number | null
  rev: number
  /** Played tracks, oldest first (for `previous`). */
  history: MusicTrack[]
  advanceTimer: unknown
  /** Set while the voice channel is empty: clears the session when it fires. */
  idleTimer: unknown
}

/** A result is either the new state or an ack error. */
export type MusicResult = MusicState | string

export function createMusic(options: MusicOptions) {
  const {
    onState,
    now = Date.now,
    timers = realTimers,
    advanceGraceMs = MUSIC_LIMITS.advanceGraceMs,
    idleClearMs = MUSIC_IDLE_CLEAR_MS,
    newId = () => randomBytes(12).toString('base64url'),
  } = options

  const sessions = new Map<string, Session>()
  /**
   * One server-wide revision counter, seeded from the clock: a channel whose session ended and starts again
   * never goes back in `rev` (not even across a server restart), so clients can always drop older states.
   */
  let lastRev = Math.max(0, Math.floor(now()))

  const snapshot = (s: Session): MusicState => ({
    channelId: s.channelId,
    current: s.current,
    queue: [...s.queue],
    startedAt: s.startedAt,
    pausedAt: s.pausedAt,
    rev: s.rev,
  })
  const empty = (channelId: string, rev = lastRev): MusicState => ({
    channelId,
    current: null,
    queue: [],
    startedAt: null,
    pausedAt: null,
    rev,
  })
  const hasContent = (s: Session) => s.current !== null || s.queue.length > 0

  /** Position (ms) in the current track, clamped to [0, durationMs]. */
  function position(s: Session): number {
    if (!s.current) return 0
    const p = s.startedAt !== null ? now() - s.startedAt : (s.pausedAt ?? 0)
    return Math.min(s.current.durationMs, Math.max(0, p))
  }

  function clearTimers(s: Session) {
    if (s.advanceTimer !== undefined) timers.clear(s.advanceTimer)
    if (s.idleTimer !== undefined) timers.clear(s.idleTimer)
    s.advanceTimer = s.idleTimer = undefined
  }

  /** (Re)schedules the advance to the next track: at the current one's end (+ grace) while playing. */
  function schedule(s: Session) {
    if (s.advanceTimer !== undefined) timers.clear(s.advanceTimer)
    s.advanceTimer = undefined
    if (!s.current || s.startedAt === null) return
    const delay = Math.max(0, s.startedAt + s.current.durationMs + advanceGraceMs - now())
    s.advanceTimer = timers.set(() => {
      s.advanceTimer = undefined
      if (sessions.get(s.channelId) !== s || s.startedAt === null) return
      goNext(s)
      commit(s)
    }, delay)
  }

  /** A change: new rev, timer rescheduled, broadcast. */
  function commit(s: Session): MusicState {
    s.rev = ++lastRev
    schedule(s)
    const state = snapshot(s)
    onState(state)
    return state
  }

  /** Ends the session; broadcasts the empty state when it showed something. */
  function remove(s: Session): MusicState {
    clearTimers(s)
    sessions.delete(s.channelId)
    if (!hasContent(s)) return empty(s.channelId)
    const state = empty(s.channelId, ++lastRev)
    onState(state)
    return state
  }

  function startCurrent(s: Session) {
    s.startedAt = s.current ? now() : null
    s.pausedAt = null
  }

  /** The current track goes to history; the first queued one starts now (or nothing plays). */
  function goNext(s: Session) {
    if (s.current) {
      s.history.push(s.current)
      if (s.history.length > MUSIC_LIMITS.historyMax) s.history.shift()
    }
    s.current = s.queue.shift() ?? null
    startCurrent(s)
  }

  function sessionFor(channelId: string): Session {
    let s = sessions.get(channelId)
    if (!s) {
      s = {
        channelId,
        current: null,
        queue: [],
        startedAt: null,
        pausedAt: null,
        rev: lastRev,
        history: [],
        advanceTimer: undefined,
        idleTimer: undefined,
      }
      sessions.set(channelId, s)
    }
    return s
  }

  return {
    /** The channel's state (empty when it has no session). */
    state(channelId: string): MusicState {
      const s = sessions.get(channelId)
      return s ? snapshot(s) : empty(channelId)
    },

    /** Sessions that show something (current or queue non-empty), for bootstrap. */
    active(): MusicState[] {
      return [...sessions.values()].filter(hasContent).map(snapshot)
    },

    /** Position (ms) of the channel's current track now (0 without one). For tests and logs. */
    positionOf(channelId: string): number {
      const s = sessions.get(channelId)
      return s ? position(s) : 0
    },

    /**
     * Appends validated tracks (or inserts them right after the current one with `next`); starts the first
     * one now when nothing is current. The caller's permissions are checked by server.ts.
     */
    add(channelId: string, addedBy: string, rawTracks: unknown, next: boolean): MusicResult {
      if (!Array.isArray(rawTracks) || rawTracks.length === 0) return MUSIC_ERRORS.invalidTrack
      if (rawTracks.length > MUSIC_MAX_ADD) return MUSIC_ERRORS.tooManyAdd
      const infos: MusicTrackInfo[] = []
      for (const raw of rawTracks) {
        const info = parseTrackInfo(raw)
        if (!info) return MUSIC_ERRORS.invalidTrack
        infos.push(info)
      }
      const existing = sessions.get(channelId)
      const queued = (existing?.queue.length ?? 0) + infos.length - (existing?.current ? 0 : 1)
      if (queued > MUSIC_MAX_QUEUE) return MUSIC_ERRORS.queueFull
      const s = sessionFor(channelId)
      const tracks: MusicTrack[] = infos.map((info) => ({ ...info, queueId: newId(), addedBy }))
      if (!s.current) {
        s.current = tracks.shift() ?? null
        startCurrent(s)
      }
      if (next) s.queue.unshift(...tracks)
      else s.queue.push(...tracks)
      return commit(s)
    },

    /** `music:control` (see the contract). No-ops (e.g. pause while paused) ack the state without a broadcast. */
    control(channelId: string, p: MusicControl): MusicResult {
      const action = p.action
      if (!isStr(action) || !(MUSIC_ACTIONS as readonly string[]).includes(action)) return MUSIC_ERRORS.invalidAction
      const s = sessions.get(channelId)
      const unchanged = () => (s ? snapshot(s) : empty(channelId))

      switch (action as MusicAction) {
        case 'play': {
          if (!s?.current || s.startedAt !== null) return unchanged()
          s.startedAt = now() - (s.pausedAt ?? 0)
          s.pausedAt = null
          return commit(s)
        }
        case 'pause': {
          if (!s?.current || s.startedAt === null) return unchanged()
          s.pausedAt = position(s)
          s.startedAt = null
          return commit(s)
        }
        case 'seek': {
          if (typeof p.positionMs !== 'number' || !Number.isFinite(p.positionMs)) return MUSIC_ERRORS.invalidAction
          if (!s?.current) return unchanged()
          const max = Math.max(0, s.current.durationMs - MUSIC_LIMITS.seekEndMarginMs)
          const pos = Math.min(max, Math.max(0, Math.round(p.positionMs)))
          if (s.startedAt !== null) s.startedAt = now() - pos
          else s.pausedAt = pos
          return commit(s)
        }
        case 'skip': {
          if (!s || !hasContent(s)) return unchanged()
          goNext(s)
          return commit(s)
        }
        case 'previous': {
          if (!s) return unchanged()
          if (s.current && (position(s) > MUSIC_LIMITS.previousRestartMs || s.history.length === 0)) {
            startCurrent(s) // restart
            return commit(s)
          }
          const last = s.history.pop()
          if (!last) return unchanged()
          // The current track goes back to the front of the queue (unless it's full: then it's dropped).
          if (s.current && s.queue.length < MUSIC_MAX_QUEUE) s.queue.unshift(s.current)
          s.current = last
          startCurrent(s)
          return commit(s)
        }
        case 'remove': {
          const i = isStr(p.queueId) && s ? s.queue.findIndex((t) => t.queueId === p.queueId) : -1
          if (!s || i < 0) return MUSIC_ERRORS.notInQueue
          s.queue.splice(i, 1)
          return commit(s)
        }
        case 'move': {
          if (typeof p.toIndex !== 'number' || !Number.isFinite(p.toIndex)) return MUSIC_ERRORS.invalidAction
          const i = isStr(p.queueId) && s ? s.queue.findIndex((t) => t.queueId === p.queueId) : -1
          if (!s || i < 0) return MUSIC_ERRORS.notInQueue
          const to = Math.min(s.queue.length - 1, Math.max(0, Math.trunc(p.toIndex)))
          if (to === i) return unchanged()
          const [track] = s.queue.splice(i, 1)
          s.queue.splice(to, 0, track)
          return commit(s)
        }
        case 'clear': {
          if (!s || s.queue.length === 0) return unchanged()
          s.queue = []
          return commit(s)
        }
        case 'stop': {
          return s ? remove(s) : unchanged()
        }
      }
    },

    /**
     * The voice channels that have someone in them now (called after every voice state change). A session
     * whose channel emptied is paused (keeping its position) and cleared after idleClearMs; someone joining
     * again cancels the clear (it stays paused: they press play). A session with nothing to show just ends.
     */
    setOccupied(occupied: ReadonlySet<string>) {
      for (const s of [...sessions.values()]) {
        if (occupied.has(s.channelId)) {
          if (s.idleTimer !== undefined) timers.clear(s.idleTimer)
          s.idleTimer = undefined
          continue
        }
        if (s.idleTimer !== undefined) continue
        if (!hasContent(s)) {
          remove(s)
          continue
        }
        if (s.current && s.startedAt !== null) {
          s.pausedAt = position(s)
          s.startedAt = null
          commit(s)
        }
        s.idleTimer = timers.set(() => {
          s.idleTimer = undefined
          if (sessions.get(s.channelId) === s) remove(s)
        }, idleClearMs)
      }
    },

    /** Ends a channel's session (channel deleted), broadcasting its empty state if it showed something. */
    drop(channelId: string) {
      const s = sessions.get(channelId)
      if (s) remove(s)
    },

    /** Ends every session (the plugin was turned off). */
    clearAll() {
      for (const s of [...sessions.values()]) remove(s)
    },

    /** Stops all timers and forgets every session, without broadcasting (server shutdown). */
    close() {
      for (const s of sessions.values()) clearTimers(s)
      sessions.clear()
    },
  }
}

export type Music = ReturnType<typeof createMusic>
