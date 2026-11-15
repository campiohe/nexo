// Link previews over plain HTTP (see the link previews block in shared/protocol.ts):
//   GET /api/embed?url=<link>   (Authorization: Bearer <device token>) → 200 {embed} | 204 | 400 | 401 | 429
//
// This is an SSRF boundary. The server never fetches the link itself, nor anything derived from it except
// as a query parameter of a FIXED oEmbed endpoint of an allowlisted provider:
//   1. the link is parsed with `new URL`; only http(s), no credentials, no explicit port;
//   2. its hostname must be one of the provider's exact hostnames and its path/query must match the provider's
//      pattern, from which a canonical link is rebuilt (fragment, tracking parameters etc. dropped);
//   3. only that canonical link is sent, URL-encoded, to the provider's hard-coded https endpoint, with
//      redirects refused, a timeout and a response size cap;
//   4. the JSON answer is mapped to an `Embed` with plain-text fields (control characters removed, lengths
//      capped); provider HTML is never returned, and thumbnails must be https URLs on the provider's CDN.
// Twitch (oEmbed endpoint removed with its v5 API) and X/Twitter (HTML-only answers) aren't supported.
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Embed } from '../../shared/protocol.ts'
import type { Db } from './db.ts'
import { HttpError, authenticate, corsHeaders, finish, preflight, sendJson } from './http.ts'
import { normalizeDisplayText, truncate } from './text.ts'

export type EmbedData = Omit<Embed, 'url'>

export const EMBED_LIMITS = {
  /** Longest accepted `url` parameter. */
  urlMax: 2048,
  titleMax: 200,
  authorMax: 100,
  thumbnailUrlMax: 2048,
  /** oEmbed answers larger than this are dropped (YouTube's is ~1 KB). */
  responseMaxBytes: 256 * 1024,
  cacheEntries: 500,
  hitTtlMs: 24 * 60 * 60 * 1000,
  missTtlMs: 60 * 60 * 1000,
} as const

export const EMBED_ERRORS = {
  invalidUrl: 'Invalid link',
  slowDown: 'Slow down: too many link previews in the last minute',
} as const

interface Provider {
  name: string
  kind: Embed['kind']
  /** Fixed oEmbed endpoint; the canonical link is appended URL-encoded. */
  endpoint: string
  /** Thumbnails must be on one of these hosts (or a subdomain). */
  thumbnailHosts: readonly string[]
  /** Thumbnail size when the provider omits it. */
  thumbnailSize: { width: number; height: number }
}

export const PROVIDERS = {
  youtube: {
    name: 'YouTube',
    kind: 'video',
    endpoint: 'https://www.youtube.com/oembed?format=json&url=',
    thumbnailHosts: ['ytimg.com'],
    thumbnailSize: { width: 480, height: 360 },
  },
  spotify: {
    name: 'Spotify',
    kind: 'audio',
    endpoint: 'https://open.spotify.com/oembed?url=',
    thumbnailHosts: ['scdn.co', 'spotifycdn.com'],
    thumbnailSize: { width: 300, height: 300 },
  },
  soundcloud: {
    name: 'SoundCloud',
    kind: 'audio',
    endpoint: 'https://soundcloud.com/oembed?format=json&url=',
    thumbnailHosts: ['sndcdn.com'],
    thumbnailSize: { width: 500, height: 500 },
  },
  vimeo: {
    name: 'Vimeo',
    kind: 'video',
    endpoint: 'https://vimeo.com/api/oembed.json?url=',
    thumbnailHosts: ['vimeocdn.com'],
    thumbnailSize: { width: 640, height: 360 },
  },
  reddit: {
    name: 'Reddit',
    kind: 'post',
    endpoint: 'https://www.reddit.com/oembed?url=',
    thumbnailHosts: ['redditmedia.com', 'redd.it'],
    thumbnailSize: { width: 140, height: 140 },
  },
} as const satisfies Record<string, Provider>

export interface EmbedMatch {
  provider: Provider
  /** The canonical link sent to the oEmbed endpoint (also the cache key). */
  url: string
}

const YOUTUBE_HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com'])
const YOUTUBE_ID = /^[A-Za-z0-9_-]{11}$/
const YOUTUBE_PATH = /^\/(?:shorts|live|embed)\/([A-Za-z0-9_-]{11})\/?$/
const YOUTU_BE_PATH = /^\/([A-Za-z0-9_-]{11})\/?$/
const SPOTIFY_PATH = /^(?:\/intl-[a-z]{2}(?:-[a-z]{2})?)?\/(track|album|playlist|episode|show)\/([A-Za-z0-9]{22})\/?$/i
const SOUNDCLOUD_HOSTS = new Set(['soundcloud.com', 'www.soundcloud.com', 'm.soundcloud.com'])
const SOUNDCLOUD_PATH = /^\/([A-Za-z0-9_-]{1,64})\/(?:(sets)\/)?([A-Za-z0-9_-]{1,128})\/?$/
/** Profile sub-pages, not tracks. */
const SOUNDCLOUD_RESERVED = new Set(['tracks', 'albums', 'sets', 'reposts', 'likes', 'followers', 'following', 'popular-tracks', 'comments'])
const VIMEO_HOSTS = new Set(['vimeo.com', 'www.vimeo.com'])
const VIMEO_PATH = /^\/(\d{1,12})(?:\/([0-9a-f]{6,20}))?\/?$/
const VIMEO_CHANNEL_PATH = /^\/channels\/[A-Za-z0-9_-]{1,64}\/(\d{1,12})\/?$/
const REDDIT_HOSTS = new Set(['reddit.com', 'www.reddit.com', 'old.reddit.com', 'new.reddit.com', 'm.reddit.com'])
const REDDIT_PATH = /^\/r\/([A-Za-z0-9_]{2,21})\/comments\/([a-z0-9]{1,12})(?:\/([A-Za-z0-9_-]{1,200}))?\/?$/

/**
 * The provider and canonical link for `raw`: 'invalid' when it isn't an http(s) URL at all (→ 400), null
 * when no allowlisted provider previews it (→ 204). Pure: never touches the network.
 */
export function matchEmbed(raw: string): EmbedMatch | 'invalid' | null {
  if (raw.length > EMBED_LIMITS.urlMax) return 'invalid'
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    return 'invalid'
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return 'invalid'
  // `new URL` lowercases the hostname, applies IDNA and drops default ports.
  if (u.username || u.password || u.port) return null
  const host = u.hostname
  const path = u.pathname
  let m: RegExpExecArray | null

  if (YOUTUBE_HOSTS.has(host)) {
    const v = path === '/watch' ? u.searchParams.get('v') : null
    const id = v !== null && YOUTUBE_ID.test(v) ? v : YOUTUBE_PATH.exec(path)?.[1]
    return id ? { provider: PROVIDERS.youtube, url: `https://www.youtube.com/watch?v=${id}` } : null
  }
  if (host === 'youtu.be') {
    m = YOUTU_BE_PATH.exec(path)
    return m ? { provider: PROVIDERS.youtube, url: `https://www.youtube.com/watch?v=${m[1]}` } : null
  }
  if (host === 'open.spotify.com') {
    m = SPOTIFY_PATH.exec(path)
    return m ? { provider: PROVIDERS.spotify, url: `https://open.spotify.com/${m[1].toLowerCase()}/${m[2]}` } : null
  }
  if (SOUNDCLOUD_HOSTS.has(host)) {
    m = SOUNDCLOUD_PATH.exec(path)
    if (!m || (!m[2] && SOUNDCLOUD_RESERVED.has(m[3].toLowerCase()))) return null
    return { provider: PROVIDERS.soundcloud, url: `https://soundcloud.com/${m[1]}/${m[2] ? 'sets/' : ''}${m[3]}` }
  }
  if (VIMEO_HOSTS.has(host)) {
    m = VIMEO_PATH.exec(path)
    if (m) return { provider: PROVIDERS.vimeo, url: `https://vimeo.com/${m[1]}${m[2] ? `/${m[2]}` : ''}` }
    m = VIMEO_CHANNEL_PATH.exec(path)
    return m ? { provider: PROVIDERS.vimeo, url: `https://vimeo.com/${m[1]}` } : null
  }
  if (REDDIT_HOSTS.has(host)) {
    m = REDDIT_PATH.exec(path)
    return m
      ? { provider: PROVIDERS.reddit, url: `https://www.reddit.com/r/${m[1]}/comments/${m[2]}/${m[3] ? `${m[3]}/` : ''}` }
      : null
  }
  return null
}

const onHost = (host: string, allowed: readonly string[]) => allowed.some((h) => host === h || host.endsWith(`.${h}`))

/** Plain text from an untrusted JSON value: control/format characters removed, whitespace collapsed, capped. */
function text(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined
  return truncate(normalizeDisplayText(value), max) || undefined
}

/** A positive integer size from an untrusted JSON value (number or numeric string), else the fallback. */
function size(value: unknown, fallback: number): number {
  const n = typeof value === 'number' ? value : typeof value === 'string' && /^\d{1,5}$/.test(value) ? Number(value) : NaN
  return Number.isFinite(n) && n >= 1 && n <= 10_000 ? Math.round(n) : fallback
}

/** Maps an oEmbed answer to an Embed (without `url`), or null when it has no usable title. */
export function toEmbed(json: unknown, provider: Provider): EmbedData | null {
  if (typeof json !== 'object' || json === null || Array.isArray(json)) return null
  const o = json as Record<string, unknown>
  const title = text(o.title, EMBED_LIMITS.titleMax)
  if (!title) return null
  const embed: EmbedData = { provider: provider.name, kind: provider.kind, title }
  const author = text(o.author_name, EMBED_LIMITS.authorMax)
  if (author) embed.author = author
  if (typeof o.thumbnail_url === 'string' && o.thumbnail_url.length <= EMBED_LIMITS.thumbnailUrlMax) {
    try {
      const t = new URL(o.thumbnail_url)
      if (t.protocol === 'https:' && !t.username && !t.password && !t.port && onHost(t.hostname, provider.thumbnailHosts)) {
        embed.thumbnail = {
          url: t.href,
          width: size(o.thumbnail_width, provider.thumbnailSize.width),
          height: size(o.thumbnail_height, provider.thumbnailSize.height),
        }
      }
    } catch {
      // Not a URL: no thumbnail.
    }
  }
  return embed
}

/** The body as text, or null when it is (or announces itself as) larger than `max` bytes. */
async function readCapped(res: Response, max: number): Promise<string | null> {
  if (Number(res.headers.get('content-length')) > max) {
    await res.body?.cancel().catch(() => {})
    return null
  }
  if (!res.body) return ''
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > max) {
      await reader.cancel().catch(() => {})
      return null
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks, total).toString('utf8')
}

const CORS_HEADERS = corsHeaders('GET')
const RATE_WINDOW_MS = 60_000
const USER_AGENT = 'Mozilla/5.0 (compatible; NexoLinkPreview/1.0)'

export interface EmbedRoutesOptions {
  users: Db['users']
  hashToken(token: string): string
  /** The fetch used for oEmbed requests (tests inject a fake; it must never be reached for other URLs). */
  fetch: typeof fetch
  /** Per oEmbed request (connect + headers + body). */
  timeoutMs: number
  /** oEmbed lookups a user may start per minute (cached links and links without a provider don't count). */
  lookupsPerMinute: number
  log(msg: string): void
}

export function createEmbedRoutes(opts: EmbedRoutesOptions) {
  /** canonical link -> preview (null = none), in least-recently-used order (Map keeps insertion order). */
  const cache = new Map<string, { embed: EmbedData | null; expires: number }>()
  /** canonical link -> lookup in progress (concurrent requests for the same link share it). */
  const inflight = new Map<string, Promise<EmbedData | null>>()
  /** userId -> times of recent lookups (sliding one-minute window) */
  const recentLookups = new Map<string, number[]>()
  /** Aborts lookups in progress when the server closes. */
  const closing = new AbortController()

  function cacheGet(key: string): { embed: EmbedData | null } | undefined {
    const entry = cache.get(key)
    if (!entry) return undefined
    cache.delete(key)
    if (entry.expires <= Date.now()) return undefined
    cache.set(key, entry)
    return entry
  }

  function cacheSet(key: string, embed: EmbedData | null) {
    cache.delete(key)
    cache.set(key, { embed, expires: Date.now() + (embed ? EMBED_LIMITS.hitTtlMs : EMBED_LIMITS.missTtlMs) })
    while (cache.size > EMBED_LIMITS.cacheEntries) cache.delete(cache.keys().next().value!)
  }

  function rateLimit(userId: string) {
    const now = Date.now()
    for (const [uid, times] of recentLookups) if (!times.some((t) => t > now - RATE_WINDOW_MS)) recentLookups.delete(uid)
    const recent = (recentLookups.get(userId) ?? []).filter((t) => t > now - RATE_WINDOW_MS)
    if (recent.length >= opts.lookupsPerMinute) {
      recentLookups.set(userId, recent)
      throw new HttpError(429, EMBED_ERRORS.slowDown, {
        'retry-after': String(Math.max(1, Math.ceil((recent[0] + RATE_WINDOW_MS - now) / 1000))),
      })
    }
    recent.push(now)
    recentLookups.set(userId, recent)
  }

  /** Asks the provider. Never throws: any failure is a miss (cached like one). */
  async function lookup(match: EmbedMatch): Promise<EmbedData | null> {
    let embed: EmbedData | null = null
    try {
      const res = await opts.fetch(match.provider.endpoint + encodeURIComponent(match.url), {
        method: 'GET',
        redirect: 'error',
        signal: AbortSignal.any([AbortSignal.timeout(opts.timeoutMs), closing.signal]),
        headers: { accept: 'application/json', 'user-agent': USER_AGENT },
      })
      if (res.status !== 200) {
        await res.body?.cancel().catch(() => {})
        opts.log(`[nexo] no link preview from ${match.provider.name} for ${match.url} (HTTP ${res.status})`)
      } else {
        const body = await readCapped(res, EMBED_LIMITS.responseMaxBytes)
        if (body === null) opts.log(`[nexo] ${match.provider.name} sent an oversized oEmbed answer for ${match.url}`)
        else embed = toEmbed(JSON.parse(body), match.provider)
      }
    } catch (err) {
      // Network error, timeout, refused redirect, invalid JSON.
      opts.log(`[nexo] link preview from ${match.provider.name} failed for ${match.url}: ${(err as Error)?.message ?? err}`)
    }
    if (!closing.signal.aborted) cacheSet(match.url, embed)
    return embed
  }

  async function get(req: IncomingMessage, res: ServerResponse, url: URL) {
    const user = authenticate(req, opts.users, opts.hashToken)
    const raw = url.searchParams.get('url')
    if (!raw) throw new HttpError(400, EMBED_ERRORS.invalidUrl)
    const match = matchEmbed(raw)
    if (match === 'invalid') throw new HttpError(400, EMBED_ERRORS.invalidUrl)

    let embed: EmbedData | null = null
    if (match) {
      const cached = cacheGet(match.url)
      if (cached) embed = cached.embed
      else {
        let pending = inflight.get(match.url)
        if (!pending) {
          rateLimit(user.id)
          pending = lookup(match).finally(() => inflight.delete(match.url))
          inflight.set(match.url, pending)
        }
        embed = await pending
      }
    }
    if (!embed) {
      res.writeHead(204, { ...CORS_HEADERS, 'cache-control': 'no-store' }).end()
      return
    }
    sendJson(res, 200, { embed: { url: raw, ...embed } satisfies Embed }, CORS_HEADERS)
  }

  /** Handles GET /api/embed. Returns false when the request isn't one (the caller then answers it). */
  function handle(req: IncomingMessage, res: ServerResponse): boolean {
    let url: URL
    try {
      url = new URL(req.url ?? '/', 'http://nexo.invalid')
    } catch {
      return false
    }
    if (url.pathname !== '/api/embed') return false
    const method = req.method ?? 'GET'
    if (method === 'OPTIONS') {
      preflight(req, res, CORS_HEADERS)
      return true
    }
    const work = method === 'GET' ? get(req, res, url) : Promise.reject(new HttpError(405, 'Use GET', { allow: 'GET, OPTIONS' }))
    finish(req, res, work, { label: 'embed', cors: CORS_HEADERS, drainBytes: 64 * 1024 })
    return true
  }

  return {
    handle,
    /** Forgets a removed account's rate-limit window. */
    forgetUser: (userId: string) => recentLookups.delete(userId),
    close() {
      closing.abort()
      cache.clear()
      recentLookups.clear()
    },
  }
}
