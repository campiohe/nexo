// Music engine: YouTube Music through InnerTube (youtubei.js), in the main process. Searches the catalogue,
// lists albums / playlists, and resolves a video id to a playable audio-only googlevideo URL.
//
// No Electron imports here (scripts can run it under plain Node). index.ts wires it to IPC and the
// nexo-music:// protocol (stream.ts).
//
// Which InnerTube client for what (checked against YouTube in Nov 2026, youtubei.js 18.3.0):
// - search / albums / playlists: WEB_REMIX (what youtubei.js's `music` client uses). No PO token needed.
// - streams: only VISIONOS gives URLs that serve the whole file without a PO token (plain URLs, no cipher or
//   "n", Opus itag 251). ANDROID_VR (plain), WEB_REMIX (ciphered: needs the player script → evaluator.ts) and
//   IOS (plain, AAC itag 140 only) give URLs that answer the first ~1 MB and then 403 (googlevideo wants a
//   GVS PO token for the rest); they stay as fallbacks in case that changes. WEB / ANDROID are SABR-only (no
//   URLs), MWEB URLs 403 right away, TV answers "The page needs to be reloaded".
//   Every candidate URL is probed before use (its first KB and its last 2 KB, the latter past that 1 MB
//   limit), so a client that starts needing a PO token falls through to the next one.
import { createHash } from 'node:crypto'
import { isAbsolute, relative, resolve as resolvePath } from 'node:path'
import type { Innertube as InnertubeT, Types as YTTypes } from 'youtubei.js'
import type { MusicCollection, MusicCollectionTracks, MusicEngineError, MusicSearchResults, MusicTrackInfo } from '../../preload/api'
import type { PlayerEvaluator } from './evaluator'
import {
  bestArtwork,
  cleanChannelName,
  collectionFromItem,
  isVideoId,
  type ListItemLike,
  makeTrack,
  parseInput,
  text,
  trackFromItem,
} from './mapping'

type YT = typeof import('youtubei.js')
type ClientName = 'ANDROID_VR' | 'VISIONOS' | 'YTMUSIC' | 'IOS'
type ErrorCode = MusicEngineError['code']
export type LogFn = (level: 'INFO' | 'WARN' | 'ERROR', ...args: unknown[]) => void

/** Thrown inside the engine; crosses IPC as a plain MusicEngineError (see toPlainError). */
export class MusicError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'MusicEngineError'
  }
}

export function toPlainError(err: unknown): MusicEngineError {
  const e = err instanceof MusicError ? err : classifyError(err)
  return { name: 'MusicEngineError', code: e.code, message: e.message }
}

/** A resolved audio stream. `url` is always https://*.googlevideo.com/videoplayback… */
export interface StreamInfo {
  videoId: string
  url: string
  itag: number
  mimeType: 'audio/webm' | 'audio/mp4'
  contentLength: number
  /** ms epoch; googlevideo URLs live ~6 h and only work from the IP that resolved them. */
  expiresAt: number
  /** User-Agent of the client that got the URL (sent with the media requests). */
  userAgent: string
  client: ClientName
}

export interface EngineOptions {
  /** Where youtubei.js caches session data and the player script (<userData>/music). null: no cache. */
  cacheDir: string | null
  /** Region for search ranking (ISO 3166 alpha-2). Playability is decided by the IP anyway. */
  location?: string
  fetch?: typeof fetch
  log?: LogFn
  /**
   * Runs the player script's decipher code (evaluator.ts, in a worker). Without it the ciphered YTMUSIC
   * fallback is skipped; the other clients don't need it.
   */
  evaluate?: PlayerEvaluator
}

const SEARCH_MAX_QUERY = 200
const MAX_TRACKS = 20
const MAX_COLLECTIONS = 10
/** Same as MUSIC_MAX_QUEUE in shared/protocol.ts: more than that can never be queued. */
const MAX_COLLECTION_TRACKS = 200
const MAX_PLAYLIST_PAGES = 10
const REQUEST_TIMEOUT_MS = 15_000
const OPERATION_TIMEOUT_MS = 45_000
const MAX_CONCURRENT = 3
/** Re-resolve this long before googlevideo's `expire`. */
const EXPIRY_MARGIN_MS = 10 * 60_000
const CACHE_MAX = 300
const UNAVAILABLE_TTL_MS = 10 * 60_000
const SESSION_RESET_INTERVAL_MS = 10 * 60_000
/** How long the file a video was last served from (itag + length) is kept after its last use, and how many. */
const PIN_TTL_MS = 6 * 3600_000
const PIN_MAX = 1000
const MAX_REDIRECTS = 3
const DESKTOP_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36'

const STREAM_CLIENTS: { client: ClientName; needsPlayer: boolean }[] = [
  { client: 'VISIONOS', needsPlayer: false },
  { client: 'ANDROID_VR', needsPlayer: false },
  { client: 'YTMUSIC', needsPlayer: true },
  { client: 'IOS', needsPlayer: false },
]

/** Audio itags by preference: Opus 160 kb/s, AAC 128 kb/s, then the lower ones. */
const ITAG_ORDER = [251, 140, 250, 249, 139]

// ── Error classification ──────────────────────────────────────────────────────────────────────────────

const BOT_RE = /not a bot|confirm you(?:'|’)?re not a bot|unusual traffic|status code 429|sign in to confirm(?! your age)/i
const UNAVAILABLE_RE =
  /unavailable|not available|private video|video is private|been removed|no longer available|terminated|\bage\b|age-restricted|copyright|blocked|members-only|premium/i

function errorChain(err: unknown): { names: string[]; messages: string[]; codes: string[] } {
  const names: string[] = []
  const messages: string[] = []
  const codes: string[] = []
  let cur: unknown = err
  for (let i = 0; i < 5 && cur; i++) {
    if (typeof cur === 'object') {
      const o = cur as { name?: unknown; message?: unknown; code?: unknown; cause?: unknown }
      if (typeof o.name === 'string') names.push(o.name)
      if (typeof o.message === 'string') messages.push(o.message)
      if (typeof o.code === 'string') codes.push(o.code)
      cur = o.cause
    } else {
      messages.push(String(cur))
      break
    }
  }
  return { names, messages, codes }
}

export function classifyError(err: unknown): MusicError {
  if (err instanceof MusicError) return err
  const { names, messages, codes } = errorChain(err)
  const msg = messages.join(' | ')
  if (BOT_RE.test(msg)) return new MusicError('bot-check', 'YouTube wants to confirm this device is not a bot. Try again later.')
  if (names.includes('TimeoutError') || names.includes('AbortError')) return new MusicError('network', 'YouTube took too long to answer.')
  if (
    codes.some((c) => /^(E[A-Z]+|UND_ERR_[A-Z_]+)$/.test(c)) ||
    /fetch failed|network|socket|ECONN|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|status code 5\d\d/i.test(msg)
  ) {
    return new MusicError('network', 'Could not reach YouTube.')
  }
  if (UNAVAILABLE_RE.test(msg)) return new MusicError('unavailable', firstLine(messages[0]) || 'This track is unavailable.')
  return new MusicError('engine', `YouTube Music failed: ${firstLine(messages[0]) || 'unknown error'}`)
}

const firstLine = (s: string | undefined): string => (s ?? '').split('\n', 1)[0].slice(0, 200)

/** Playability status of a /player answer → null (playable) or the error it means. */
function playabilityError(status: string | undefined, reason: string): MusicError | null {
  if (status === 'OK') return null
  const why = reason || status || 'unknown'
  if (status === 'LOGIN_REQUIRED' && BOT_RE.test(why)) return new MusicError('bot-check', 'YouTube wants to confirm this device is not a bot. Try again later.')
  if (BOT_RE.test(why)) return new MusicError('bot-check', 'YouTube wants to confirm this device is not a bot. Try again later.')
  if (status === 'LOGIN_REQUIRED' || status === 'UNPLAYABLE' || status === 'ERROR' || status === 'AGE_CHECK_REQUIRED' || status === 'CONTENT_CHECK_REQUIRED' || status === 'LIVE_STREAM_OFFLINE') {
    return new MusicError('unavailable', why.slice(0, 200))
  }
  return new MusicError('engine', `Unexpected playability status: ${why.slice(0, 200)}`)
}

// ── Small helpers ─────────────────────────────────────────────────────────────────────────────────────

class Limiter {
  private active = 0
  private readonly queue: (() => void)[] = []
  constructor(private readonly max: number) {}
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.max) await new Promise<void>((resolve) => this.queue.push(resolve))
    this.active++
    try {
      return await fn()
    } finally {
      this.active--
      this.queue.shift()?.()
    }
  }
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new MusicError('network', `YouTube took too long to answer (${what}).`)), ms)
  })
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer))
}

// ── googlevideo requests (shared with stream.ts) ───────────────────────────────────────────────────────

/** https://*.googlevideo.com/videoplayback… (no credentials, no explicit port): the only URLs ever fetched. */
export function isStreamUrl(raw: string): boolean {
  try {
    const u = new URL(raw)
    return u.protocol === 'https:' && /(^|\.)googlevideo\.com$/.test(u.hostname) && u.pathname.startsWith('/videoplayback') && !u.username && !u.password && !u.port
  } catch {
    return false
  }
}

/**
 * fetch for googlevideo stream URLs: redirects are followed by hand, and only to another stream URL (at most
 * MAX_REDIRECTS hops). Never answers with a 3xx. The caller owns the signal (timeouts, cancellation).
 */
export async function fetchGooglevideo(
  fetchImpl: (input: string, init: RequestInit) => Promise<Response>,
  url: string,
  init: Omit<RequestInit, 'redirect'>,
): Promise<Response> {
  for (let hop = 0; ; hop++) {
    if (!isStreamUrl(url)) throw new MusicError('engine', 'refusing to fetch a non-googlevideo URL')
    const res = await fetchImpl(url, { ...init, redirect: 'manual' })
    if (res.status < 300 || res.status >= 400) return res
    const location = res.headers.get('location')
    await res.body?.cancel().catch(() => {})
    if (!location || hop >= MAX_REDIRECTS) throw new MusicError('network', `googlevideo redirect without target (${res.status})`)
    url = new URL(location, url).toString()
  }
}

/**
 * youtubei.js's file cache keyed by names it gets from YouTube (the player id): keys are reduced to a plain
 * file name (else hashed) and must resolve inside the cache directory, so a hostile id can't write elsewhere.
 */
export class SafeCache implements YTTypes.ICache {
  private readonly dir: string
  constructor(private readonly inner: YTTypes.ICache) {
    this.dir = resolvePath(inner.cache_dir)
  }
  get cache_dir(): string {
    return this.inner.cache_dir
  }
  private key(raw: string): string {
    const plain = typeof raw === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(raw) && !/^(con|prn|aux|nul|com\d|lpt\d)$/i.test(raw)
    const key = plain ? raw : `h_${createHash('sha256').update(String(raw)).digest('hex').slice(0, 40)}`
    const rel = relative(this.dir, resolvePath(this.dir, key))
    if (!rel || rel.startsWith('..') || isAbsolute(rel) || /[\\/]/.test(rel)) throw new Error('invalid cache key')
    return key
  }
  get(key: string): Promise<ArrayBuffer | undefined> {
    return this.inner.get(this.key(key))
  }
  set(key: string, value: ArrayBuffer): Promise<void> {
    return this.inner.set(this.key(key), value)
  }
  remove(key: string): Promise<void> {
    return this.inner.remove(this.key(key))
  }
}

const refuseEval: PlayerEvaluator = () => Promise.reject(new Error('no player script evaluator'))

/** EBML (WebM) or an ISO BMFF box ('ftyp' / 'sidx' / 'moov' at offset 4). */
function looksLikeAudio(bytes: Uint8Array, mime: StreamInfo['mimeType']): boolean {
  if (bytes.length < 8) return false
  if (mime === 'audio/webm') return bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3
  const box = String.fromCharCode(bytes[4], bytes[5], bytes[6], bytes[7])
  return box === 'ftyp' || box === 'sidx' || box === 'moov' || box === 'styp'
}

// Minimal structural views of youtubei.js objects (see mapping.ts for why).
interface FormatLike {
  itag?: unknown
  url?: unknown
  signature_cipher?: unknown
  cipher?: unknown
  mime_type?: unknown
  has_audio?: unknown
  has_video?: unknown
  is_drc?: unknown
  is_type_otf?: unknown
  drm_families?: unknown
  content_length?: unknown
  audio_track?: { audio_is_default?: unknown } | null
  decipher(player?: unknown): Promise<string>
}

interface TrackMeta {
  title: string
  artist: string
  durationSeconds: number
  artwork: string | null
}

interface CacheEntry {
  stream: StreamInfo | null
  meta: TrackMeta | null
  /** Set while the video is known unavailable (negative cache). */
  unavailable: { until: number; error: MusicError } | null
}

/**
 * The file a video was last served from. A re-resolve (expiry, eviction, 403 refresh) must land on the same
 * file, or the byte offsets of a playback in progress would point into a different one.
 */
interface Pin {
  itag: number
  contentLength: number
  client: ClientName
  at: number
}

// ── Engine ────────────────────────────────────────────────────────────────────────────────────────────

let ytModule: Promise<YT> | null = null

/** Loads youtubei.js lazily (keeps it off the startup path) and plugs in the evaluator and logging. */
function loadYoutubei(log: LogFn): Promise<YT> {
  ytModule ??= import('youtubei.js').then((yt) => {
    yt.Platform.shim.eval = refuseEval
    yt.Log.setLevel(yt.Log.Level.ERROR)
    // Parser drift (new/changed node classes) is expected and mostly harmless: one line per class, not a dump.
    const seen = new Set<string>()
    yt.Parser.setParserErrorHandler((ctx: { classname?: string; error_type?: string }) => {
      const key = `${ctx.error_type}:${ctx.classname}`
      if (seen.has(key) || seen.size > 200) return
      seen.add(key)
      log('WARN', `[music] parser ${ctx.error_type ?? 'error'}: ${ctx.classname ?? '?'}`)
    })
    return yt
  })
  ytModule.catch(() => {
    ytModule = null
  })
  return ytModule
}

export class MusicEngine {
  private readonly fetchImpl: typeof fetch
  private readonly log: LogFn
  private readonly limiter = new Limiter(MAX_CONCURRENT)
  private readonly cache = new Map<string, CacheEntry>()
  /** Kept apart from `cache` (and its LRU), which drops entries much sooner. */
  private readonly pins = new Map<string, Pin>()
  private readonly inflight = new Map<string, Promise<StreamInfo>>()
  private sessions: { plain: Promise<InnertubeT> | null; player: Promise<InnertubeT> | null } = { plain: null, player: null }
  private lastSessionReset = 0

  constructor(private readonly opts: EngineOptions) {
    this.fetchImpl = opts.fetch ?? globalThis.fetch.bind(globalThis)
    this.log = opts.log ?? (() => {})
  }

  /** fetch with a per-request timeout, for youtubei.js. */
  private readonly timedFetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    const outer = init?.signal ?? (input instanceof Request ? input.signal : undefined)
    const signal = outer ? AbortSignal.any([outer, timeout]) : timeout
    return this.fetchImpl(input, { ...init, signal })
  }) as typeof fetch

  /**
   * One shared Innertube session, created on first use. A second one with the player script (needed only to
   * decipher WEB_REMIX stream URLs) is created only when that fallback is reached. Both share the cache dir.
   */
  private session(withPlayer: boolean): Promise<InnertubeT> {
    const key = withPlayer ? 'player' : 'plain'
    const existing = this.sessions[key]
    if (existing) return existing
    const created = (async () => {
      const yt = await loadYoutubei(this.log)
      // Process-wide hook; one engine per process.
      yt.Platform.shim.eval = this.opts.evaluate ?? refuseEval
      const started = Date.now()
      const it = await yt.Innertube.create({
        cache: this.opts.cacheDir ? new SafeCache(new yt.UniversalCache(true, this.opts.cacheDir)) : undefined,
        retrieve_player: withPlayer,
        // Fixed (the default is random per session), so the cached session data matches and is reused.
        user_agent: DESKTOP_UA,
        location: this.opts.location,
        fetch: this.timedFetch,
      })
      this.log('INFO', `[music] innertube session ready (${key}, ${Date.now() - started} ms)`)
      return it
    })()
    this.sessions[key] = created
    created.catch(() => {
      if (this.sessions[key] === created) this.sessions[key] = null
    })
    return created
  }

  /** After an unexplained failure: start from a fresh session next time (rate limited). */
  private maybeResetSessions(err: MusicError): void {
    if (err.code !== 'engine' || Date.now() - this.lastSessionReset < SESSION_RESET_INTERVAL_MS) return
    this.lastSessionReset = Date.now()
    this.sessions = { plain: null, player: null }
    this.log('WARN', '[music] resetting InnerTube sessions after:', err.message)
  }

  private async op<T>(what: string, fn: () => Promise<T>): Promise<T> {
    try {
      return await withTimeout(
        this.limiter.run(fn),
        OPERATION_TIMEOUT_MS,
        what,
      )
    } catch (err) {
      const e = classifyError(err)
      if (e.code !== 'unavailable') this.log('WARN', `[music] ${what} failed (${e.code}):`, errorChain(err).messages[0] ?? e.message)
      this.maybeResetSessions(e)
      throw e
    }
  }

  // ── Search ──────────────────────────────────────────────────────────────────────────────────────────

  async search(rawQuery: string): Promise<MusicSearchResults> {
    const query = rawQuery.replace(/\s+/g, ' ').trim().slice(0, SEARCH_MAX_QUERY)
    if (!query) return { tracks: [], albums: [], playlists: [] }
    return this.op('search', async () => {
      const it = await this.session(false)
      // "Songs" (has durations and albums) + the unfiltered search (albums and playlists, no durations).
      const [songs, all] = await Promise.allSettled([it.music.search(query, { type: 'song' }), it.music.search(query)])
      if (songs.status === 'rejected' && all.status === 'rejected') throw songs.reason
      const items = (s: PromiseSettledResult<{ contents?: unknown }>): ListItemLike[] => {
        if (s.status !== 'fulfilled') return []
        const contents = (s.value.contents ?? []) as { contents?: unknown }[]
        return contents.flatMap((section) => (Array.isArray(section?.contents) ? (section.contents as ListItemLike[]) : []))
      }
      const songItems = items(songs)
      const allItems = items(all)
      const tracks: MusicTrackInfo[] = []
      for (const item of [...songItems, ...allItems]) {
        if (item.item_type !== 'song' && item.item_type !== 'video') continue
        const t = trackFromItem(item)
        if (t && !tracks.some((x) => x.videoId === t.videoId)) tracks.push(t)
        if (tracks.length >= MAX_TRACKS) break
      }
      const albums: MusicCollection[] = []
      const playlists: MusicCollection[] = []
      for (const item of allItems) {
        const c = collectionFromItem(item)
        if (!c) continue
        const list = c.kind === 'album' ? albums : playlists
        if (list.length < MAX_COLLECTIONS && !list.some((x) => x.id === c.id)) list.push(c)
      }
      return { tracks, albums, playlists }
    })
  }

  // ── Resolve (albums, playlists, links) ────────────────────────────────────────────────────────────────

  async resolve(input: string): Promise<MusicCollectionTracks | null> {
    const parsed = parseInput(input)
    if (!parsed) return null
    if (parsed.kind === 'video') {
      const track = await this.track(parsed.videoId)
      return { title: track.title, tracks: [track] }
    }
    if (parsed.kind === 'album') return this.op('album', () => this.album(parsed.id))
    return this.op('playlist', () => this.playlist(parsed.id))
  }

  private async album(id: string): Promise<MusicCollectionTracks | null> {
    const it = await this.session(false)
    const album = await it.music.getAlbum(id)
    const header = album.header as unknown as {
      title?: unknown
      strapline_text_one?: unknown
      author?: { name?: unknown }
      thumbnail?: { contents?: unknown }
      thumbnails?: unknown
    } | undefined
    const title = text(header?.title) || 'Album'
    const artist = cleanChannelName(text(header?.strapline_text_one) || text(header?.author?.name))
    const artwork = bestArtwork((header?.thumbnail?.contents ?? header?.thumbnails) as never)
    const tracks: MusicTrackInfo[] = []
    for (const item of album.contents as unknown as ListItemLike[]) {
      const t = trackFromItem(item, { album: title, artwork, artist })
      if (t && !tracks.some((x) => x.videoId === t.videoId)) tracks.push(t)
      if (tracks.length >= MAX_COLLECTION_TRACKS) break
    }
    return tracks.length ? { title, tracks } : null
  }

  private async playlist(id: string): Promise<MusicCollectionTracks | null> {
    const it = await this.session(false)
    let page = await it.music.getPlaylist(id)
    const header = page.header as unknown as { title?: unknown; thumbnail?: { contents?: unknown } } | undefined
    let title = text(header?.title)
    const headerArt = bestArtwork(header?.thumbnail?.contents as never)
    const tracks: MusicTrackInfo[] = []
    for (let pages = 1; ; pages++) {
      for (const item of page.items as unknown as (ListItemLike & { type?: string })[]) {
        if (item.type !== 'MusicResponsiveListItem') continue
        const t = trackFromItem(item, { artwork: headerArt })
        if (t && !tracks.some((x) => x.videoId === t.videoId)) tracks.push(t)
        if (tracks.length >= MAX_COLLECTION_TRACKS) break
      }
      if (tracks.length >= MAX_COLLECTION_TRACKS || pages >= MAX_PLAYLIST_PAGES || !page.has_continuation) break
      page = await page.getContinuation()
    }
    // Album playlists (OLAK5uy_…) come without a header: name them after the album.
    if (!title) title = tracks[0]?.album ?? 'Playlist'
    return tracks.length ? { title, tracks } : null
  }

  /** One video → its MusicTrackInfo (from the same /player answer that resolves its stream). */
  private async track(videoId: string): Promise<MusicTrackInfo> {
    await this.stream(videoId)
    const meta = this.cache.get(videoId)?.meta
    const track =
      meta &&
      makeTrack({
        videoId,
        title: meta.title,
        artist: meta.artist,
        album: null,
        durationSeconds: meta.durationSeconds,
        artwork: meta.artwork,
      })
    if (!track) throw new MusicError('unavailable', 'This video has no usable length or title (live streams are not supported).')
    return track
  }

  // ── Streams ─────────────────────────────────────────────────────────────────────────────────────────

  /** Resolve and cache a stream ahead of time. Never rejects. */
  async prefetch(videoId: string): Promise<void> {
    if (!isVideoId(videoId)) return
    await this.stream(videoId).catch(() => {})
  }

  /** Drop a cached URL (e.g. googlevideo answered 403). Only if it's still the one cached. */
  invalidate(videoId: string, url?: string): void {
    const entry = this.cache.get(videoId)
    if (entry?.stream && (!url || entry.stream.url === url)) entry.stream = null
  }

  /**
   * The audio stream for a video: cached while its URL is valid, otherwise resolved (one request per video
   * at a time). `fresh` ignores the cached URL.
   */
  stream(videoId: string, opts: { fresh?: boolean } = {}): Promise<StreamInfo> {
    if (!isVideoId(videoId)) return Promise.reject(new MusicError('engine', 'invalid video id'))
    const entry = this.cache.get(videoId)
    if (entry?.unavailable && entry.unavailable.until > Date.now() && !opts.fresh) return Promise.reject(entry.unavailable.error)
    if (!opts.fresh && entry?.stream && entry.stream.expiresAt - EXPIRY_MARGIN_MS > Date.now()) {
      // LRU: move to the end.
      this.cache.delete(videoId)
      this.cache.set(videoId, entry)
      this.pinFor(videoId)
      return Promise.resolve(entry.stream)
    }
    const running = this.inflight.get(videoId)
    if (running) return running
    const p = this.op('stream', () => this.resolveStream(videoId)).finally(() => this.inflight.delete(videoId))
    this.inflight.set(videoId, p)
    return p
  }

  private remember(videoId: string, patch: Partial<CacheEntry>): void {
    const prev = this.cache.get(videoId) ?? { stream: null, meta: null, unavailable: null }
    this.cache.delete(videoId)
    this.cache.set(videoId, { ...prev, ...patch })
    while (this.cache.size > CACHE_MAX) {
      const oldest = this.cache.keys().next().value
      if (oldest === undefined) break
      this.cache.delete(oldest)
    }
  }

  /** The live pin of a video (refreshing its age), or null. */
  private pinFor(videoId: string): Pin | null {
    const pin = this.pins.get(videoId)
    if (!pin) return null
    this.pins.delete(videoId)
    if (Date.now() - pin.at > PIN_TTL_MS) return null
    pin.at = Date.now()
    this.pins.set(videoId, pin)
    return pin
  }

  private setPin(videoId: string, s: StreamInfo): void {
    this.pins.delete(videoId)
    this.pins.set(videoId, { itag: s.itag, contentLength: s.contentLength, client: s.client, at: Date.now() })
    while (this.pins.size > PIN_MAX) {
      const oldest = this.pins.keys().next().value
      if (oldest === undefined) break
      this.pins.delete(oldest)
    }
  }

  private async resolveStream(videoId: string): Promise<StreamInfo> {
    // Two clients saying "unavailable" (removed, private, region, age): it's the video, not the client.
    const gaveUp = (errors: MusicError[]): boolean => errors.filter((e) => e.code === 'unavailable').length >= 2
    const yt = await loadYoutubei(this.log)
    // A known file: ask the client that produced it first, and accept only that same file.
    const pin = this.pinFor(videoId)
    const clients = pin ? [...STREAM_CLIENTS].sort((a, b) => Number(b.client === pin.client) - Number(a.client === pin.client)) : STREAM_CLIENTS
    let otherFile = false
    const errors: MusicError[] = []
    for (const { client, needsPlayer } of clients) {
      if (needsPlayer && !this.opts.evaluate) continue
      try {
        const it = await this.session(needsPlayer)
        const info = await it.getBasicInfo(videoId, { client })
        const ps = info.playability_status
        const notPlayable = playabilityError(ps?.status, text(ps?.reason))
        const basic = info.basic_info as { title?: unknown; author?: unknown; duration?: unknown; thumbnail?: unknown; is_live?: unknown }
        if (!notPlayable && basic) {
          const meta: TrackMeta = {
            title: text(basic.title),
            artist: cleanChannelName(text(basic.author)),
            durationSeconds: basic.is_live ? 0 : Number(basic.duration) || 0,
            artwork: bestArtwork(basic.thumbnail as never),
          }
          this.remember(videoId, { meta })
        }
        if (notPlayable) {
          errors.push(notPlayable)
          if (ps?.status === 'ERROR' || gaveUp(errors)) break
          continue
        }
        const formats = ((info.streaming_data?.adaptive_formats ?? []) as unknown as FormatLike[]).filter(
          (f) =>
            f.has_audio === true &&
            f.has_video !== true &&
            f.is_drc !== true &&
            f.is_type_otf !== true &&
            !(Array.isArray(f.drm_families) && f.drm_families.length) &&
            typeof f.itag === 'number' &&
            ITAG_ORDER.includes(f.itag) &&
            (typeof f.url === 'string' || (needsPlayer && (typeof f.signature_cipher === 'string' || typeof f.cipher === 'string'))),
        )
        const order = (f: FormatLike): number => {
          const nonDefaultTrack = f.audio_track && f.audio_track.audio_is_default === false ? 50 : 0
          return nonDefaultTrack + ITAG_ORDER.indexOf(f.itag as number)
        }
        formats.sort((a, b) => order(a) - order(b))
        if (!formats.length) {
          errors.push(new MusicError('engine', `${client}: no direct audio URLs`))
          continue
        }
        const format = pin ? formats.find((f) => f.itag === pin.itag) : formats[0]
        if (!format) {
          otherFile = true
          errors.push(new MusicError('engine', `${client}: itag ${pin?.itag} no longer offered`))
          continue
        }
        const url = needsPlayer ? await format.decipher(it.session.player) : (format.url as string)
        const stream = await this.checkStream(yt, videoId, client, format, url)
        if (!stream) {
          errors.push(new MusicError('engine', `${client}: stream URL refused`))
          continue
        }
        if (pin && stream.contentLength !== pin.contentLength) {
          otherFile = true
          errors.push(new MusicError('engine', `${client}: itag ${stream.itag} is now ${stream.contentLength} B, was ${pin.contentLength} B`))
          continue
        }
        this.remember(videoId, { stream, unavailable: null })
        this.setPin(videoId, stream)
        this.log('INFO', `[music] stream ${videoId}: ${client} itag ${stream.itag} (${stream.mimeType}, ${stream.contentLength} B)`)
        return stream
      } catch (err) {
        const e = classifyError(err)
        errors.push(e)
        if (e.code === 'network' || gaveUp(errors)) break
      }
    }
    // A bot check explains the other clients' failures too; then "unavailable" (region, age, removed).
    const pick =
      errors.find((e) => e.code === 'bot-check') ??
      errors.find((e) => e.code === 'unavailable') ??
      errors.find((e) => e.code === 'network') ??
      errors[0] ??
      new MusicError('engine', 'no stream found')
    if (pick.code === 'unavailable') this.remember(videoId, { stream: null, unavailable: { until: Date.now() + UNAVAILABLE_TTL_MS, error: pick } })
    this.log('WARN', `[music] no stream for ${videoId}:`, errors.map((e) => `${e.code}: ${e.message}`).join('; '))
    if (otherFile && pick.code !== 'bot-check' && pick.code !== 'unavailable') {
      // YouTube serves a different file now: fail this request rather than mix two files' bytes, and forget
      // the pin so the player's reload (which starts from byte 0) gets the new file.
      this.pins.delete(videoId)
      throw new MusicError('engine', 'YouTube now serves a different file for this track; it has to be reloaded.')
    }
    throw pick
  }

  /**
   * Validates a candidate URL and probes it: the first KB (must look like the container) and the last 2 KB
   * (googlevideo serves the first ~1 MB of a URL that lacks a PO token, then 403s: the tail catches that).
   */
  private async checkStream(yt: YT, videoId: string, client: ClientName, format: FormatLike, rawUrl: string): Promise<StreamInfo | null> {
    let u: URL
    try {
      u = new URL(rawUrl)
    } catch {
      return null
    }
    if (!isStreamUrl(u.toString())) return null
    const mimeBase = typeof format.mime_type === 'string' ? format.mime_type.split(';', 1)[0].trim() : ''
    const mimeType = mimeBase === 'audio/webm' ? 'audio/webm' : mimeBase === 'audio/mp4' ? 'audio/mp4' : null
    if (!mimeType) return null
    const userAgent = (yt.Constants.CLIENTS as Record<string, { USER_AGENT?: string }>)[client]?.USER_AGENT ?? DESKTOP_UA
    const expire = Number(u.searchParams.get('expire'))
    const expiresAt = Number.isFinite(expire) && expire > 0 ? expire * 1000 : Date.now() + 5 * 3600_000
    const probe = async (from: number, to: number): Promise<{ status: number; body: Uint8Array; total: number }> => {
      // Redirects only to another googlevideo stream URL, as in stream.ts: a URL is never approved off-site.
      const res = await fetchGooglevideo(this.fetchImpl, u.toString(), {
        headers: { range: `bytes=${from}-${to}`, 'user-agent': userAgent, accept: '*/*' },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })
      const body = new Uint8Array(await res.arrayBuffer())
      const total = Number(/\/(\d+)$/.exec(res.headers.get('content-range') ?? '')?.[1] ?? NaN)
      return { status: res.status, body, total }
    }
    const known = Number(format.content_length)
    const tailOf = (total: number): [number, number] => [Math.max(0, total - 2048), total - 1]
    const [head, tail] = await Promise.all([
      probe(0, 1023),
      Number.isSafeInteger(known) && known > 0 ? probe(...tailOf(known)) : Promise.resolve(null),
    ])
    if (head.status !== 206 || !looksLikeAudio(head.body, mimeType)) {
      this.log('WARN', `[music] ${client} stream probe for ${videoId}: HTTP ${head.status}${head.status === 206 ? ' (unexpected bytes)' : ''}`)
      return null
    }
    const total = Number.isSafeInteger(head.total) && head.total > 0 ? head.total : known
    if (!Number.isSafeInteger(total) || total <= 0) return null
    const end = tail && total === known ? tail : await probe(...tailOf(total))
    if (end.status !== 206) {
      this.log('INFO', `[music] ${client} stream for ${videoId} stops early (HTTP ${end.status} past the start; PO token wanted)`)
      return null
    }
    return { videoId, url: u.toString(), itag: format.itag as number, mimeType, contentLength: total, expiresAt, userAgent, client }
  }
}
