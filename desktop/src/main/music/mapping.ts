// Music engine: turns YouTube Music nodes into Nexo's MusicTrackInfo / MusicCollection, validates them against
// the server's rules (shared/protocol.ts MusicTrackInfo), and parses what users paste into "resolve".
// Pure functions (no Electron, no network): the parsed nodes are read structurally, field by field, because
// YouTube's responses (and youtubei.js's parse of them) change shape now and then.
import type { MusicCollection, MusicTrackInfo } from '../../preload/api'

export const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/
/** Same as MUSIC_MAX_TRACK_MS in shared/protocol.ts. */
export const MAX_TRACK_MS = 3 * 60 * 60 * 1000
const TEXT_MAX = 200

export const isVideoId = (v: unknown): v is string => typeof v === 'string' && VIDEO_ID_RE.test(v)

// ── Structural views of youtubei.js nodes (only what we read) ─────────────────────────────────────────

export interface ThumbLike {
  url?: unknown
  width?: unknown
  height?: unknown
}

interface NameLike {
  name?: unknown
}

/** A MusicResponsiveListItem (search result, album or playlist row). */
export interface ListItemLike {
  item_type?: unknown
  id?: unknown
  title?: unknown
  name?: unknown
  duration?: { seconds?: unknown } | null
  album?: { id?: unknown; name?: unknown } | null
  artists?: NameLike[] | null
  authors?: NameLike[] | null
  author?: NameLike | null
  year?: unknown
  item_count?: unknown
  song_count?: unknown
  subtitle?: unknown
  thumbnails?: ThumbLike[]
  flex_columns?: { title?: unknown }[] | null
}

// ── Text helpers ──────────────────────────────────────────────────────────────────────────────────────

/** Text-ish value (string or youtubei.js Text) → trimmed single-line string, '' when absent. */
export function text(v: unknown): string {
  let s: string
  if (typeof v === 'string') s = v
  else if (v && typeof v === 'object' && typeof (v as { toString?: unknown }).toString === 'function') {
    s = String(v)
    if (s === '[object Object]') return ''
  } else return ''
  // eslint-disable-next-line no-control-regex
  return s.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim()
}

/** Cut to `max` UTF-16 units without splitting a surrogate pair, adding an ellipsis. */
export function clip(s: string, max = TEXT_MAX): string {
  if (s.length <= max) return s
  let cut = s.slice(0, max - 1)
  if (/[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1)
  return `${cut}…`
}

function names(list: NameLike[] | null | undefined): string[] {
  if (!Array.isArray(list)) return []
  const out: string[] = []
  for (const a of list) {
    const n = text(a?.name)
    if (n && !out.includes(n)) out.push(n)
  }
  return out
}

/** "Daft Punk - Topic" (auto-generated artist channels) → "Daft Punk". */
export function cleanChannelName(name: string): string {
  return name.replace(/\s+-\s+Topic$/i, '').trim()
}

// ── Artwork ───────────────────────────────────────────────────────────────────────────────────────────

/** Hosts the server accepts for artwork (shared/protocol.ts: https on ytimg.com / googleusercontent.com). */
function isAllowedArtHost(host: string): boolean {
  return host === 'ytimg.com' || host.endsWith('.ytimg.com') || host === 'googleusercontent.com' || host.endsWith('.googleusercontent.com')
}

/** https artwork URL on an allowed host, or null. yt3/lhN.ggpht.com are the same CDN as *.googleusercontent.com. */
export function artworkUrl(raw: unknown, size?: number): string | null {
  if (typeof raw !== 'string' || raw.length > 2048) return null
  let u: URL
  try {
    u = new URL(raw.startsWith('//') ? `https:${raw}` : raw)
  } catch {
    return null
  }
  if (u.protocol === 'http:') u.protocol = 'https:'
  if (u.protocol !== 'https:' || u.username || u.password || u.port) return null
  const ggpht = /^(yt3|lh\d)\.ggpht\.com$/.exec(u.hostname)
  if (ggpht) u.hostname = `${ggpht[1]}.googleusercontent.com`
  if (!isAllowedArtHost(u.hostname)) return null
  let out = u.toString()
  // googleusercontent images take their size in the path ("=w120-h120-l90-rj"): ask for a bigger square.
  if (size && u.hostname.endsWith('.googleusercontent.com')) out = out.replace(/=w\d+-h\d+(-[a-z0-9-]*)?$/i, `=w${size}-h${size}$1`)
  return out.length <= 2048 ? out : null
}

/**
 * Best artwork among thumbnails: square-ish ones first (album art), largest first; otherwise the largest
 * allowed one (video frames). null when none is on an allowed host.
 */
export function bestArtwork(thumbs: ThumbLike[] | null | undefined): string | null {
  if (!Array.isArray(thumbs) || thumbs.length === 0) return null
  const scored = thumbs
    .map((t) => {
      const w = typeof t?.width === 'number' ? t.width : 0
      const h = typeof t?.height === 'number' ? t.height : 0
      const square = w > 0 && h > 0 && Math.max(w, h) / Math.min(w, h) <= 1.25
      return { t, w, square }
    })
    .sort((a, b) => Number(b.square) - Number(a.square) || b.w - a.w)
  for (const { t, square } of scored) {
    const url = artworkUrl(t?.url, square ? 544 : undefined)
    if (url) return url
  }
  return null
}

// ── Validation (the server's rules) ───────────────────────────────────────────────────────────────────

/** Builds a MusicTrackInfo, or null when it wouldn't pass the server's checks (no duration, too long, …). */
export function makeTrack(p: {
  videoId: unknown
  title: unknown
  artist: string
  album?: string | null
  durationSeconds: unknown
  artwork: string | null
}): MusicTrackInfo | null {
  if (!isVideoId(p.videoId)) return null
  const title = clip(text(p.title))
  if (!title) return null
  const seconds = typeof p.durationSeconds === 'number' ? p.durationSeconds : Number(p.durationSeconds)
  if (!Number.isFinite(seconds)) return null
  const durationMs = Math.round(seconds * 1000)
  if (durationMs < 1000 || durationMs > MAX_TRACK_MS) return null
  const album = p.album ? clip(text(p.album)) : ''
  return {
    videoId: p.videoId,
    title,
    artist: clip(text(p.artist)),
    album: album || null,
    durationMs,
    artwork: p.artwork && p.artwork.startsWith('https://') && p.artwork.length <= 2048 ? p.artwork : null,
  }
}

// ── Mapping ───────────────────────────────────────────────────────────────────────────────────────────

/** Song / video row → track. `fallback` fills what album rows leave out (album name, artwork, artist). */
export function trackFromItem(
  item: ListItemLike,
  fallback?: { album?: string | null; artwork?: string | null; artist?: string },
): MusicTrackInfo | null {
  const artists = names(item.artists)
  const authors = names(item.authors)
  const people = artists.length ? artists : authors.length ? authors : names(item.author ? [item.author] : [])
  const artist = people.map(cleanChannelName).filter(Boolean).join(', ') || fallback?.artist || ''
  return makeTrack({
    videoId: item.id,
    title: item.title ?? item.name,
    artist,
    album: text(item.album?.name) || fallback?.album || null,
    durationSeconds: item.duration?.seconds,
    artwork: bestArtwork(item.thumbnails) ?? fallback?.artwork ?? null,
  })
}

const COLLECTION_ID_RE = /^(?:MPREb_[A-Za-z0-9_-]{1,64}|(?:VL)?(?:PL|OLAK5uy_|RDCLAK5uy_|RD|UU|LL|FL|OL)[A-Za-z0-9_-]{1,64})$/

export function isCollectionId(id: string): boolean {
  return id.length <= 80 && COLLECTION_ID_RE.test(id)
}

/** Album / playlist search row → MusicCollection, or null. */
export function collectionFromItem(item: ListItemLike): MusicCollection | null {
  const kind = item.item_type === 'album' ? 'album' : item.item_type === 'playlist' ? 'playlist' : null
  const id = typeof item.id === 'string' ? item.id : ''
  if (!kind || !isCollectionId(id)) return null
  if (kind === 'album' && !id.startsWith('MPREb_')) return null
  const title = clip(text(item.title ?? item.name))
  if (!title) return null
  const who = [...names(item.artists), ...names(item.authors), ...names(item.author ? [item.author] : [])]
    .map(cleanChannelName)
    .filter((n, i, all) => n && all.indexOf(n) === i)
    .join(', ')
  const parts = [who]
  if (kind === 'album') parts.push(text(item.year))
  else {
    const count = text(item.item_count) || text(item.song_count)
    if (count) parts.push(/^\d[\d,.\s]*$/.test(count) ? `${count} tracks` : count)
  }
  let subtitle = parts.filter(Boolean).join(' • ')
  // Fall back to YouTube's own second line ("Album • Daft Punk • 2013", "Someone • 559 views").
  if (!subtitle) subtitle = text(item.flex_columns?.[1]?.title)
  return { id, kind, title, subtitle: clip(subtitle), artwork: bestArtwork(item.thumbnails) }
}

// ── Pasted input ──────────────────────────────────────────────────────────────────────────────────────

export type ParsedInput =
  | { kind: 'video'; videoId: string }
  | { kind: 'album'; id: string }
  | { kind: 'playlist'; id: string }

const YT_HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com'])

function classifyId(id: string): ParsedInput | null {
  if (!isCollectionId(id)) return null
  if (id.startsWith('MPREb_')) return { kind: 'album', id }
  return { kind: 'playlist', id: id.startsWith('VL') ? id.slice(2) : id }
}

/**
 * What the user pasted (or a MusicCollection.id) → what to load. Accepts music.youtube.com / youtube.com
 * watch, playlist, browse (MPREb_ albums, VL playlists), shorts and embed links, youtu.be links, a bare
 * collection id, and a bare video id. A watch link with both `v` and `list` is the single video.
 */
export function parseInput(raw: string): ParsedInput | null {
  const input = raw.trim()
  if (!input) return null
  if (!/[/.:]/.test(input)) {
    // Playlist ids are longer than 11 characters, so an 11-character id is always a video.
    if (VIDEO_ID_RE.test(input)) return { kind: 'video', videoId: input }
    return classifyId(input)
  }
  let u: URL
  try {
    u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(input) ? input : `https://${input}`)
  } catch {
    return null
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null
  const host = u.hostname.toLowerCase()
  const segs = u.pathname.split('/').filter(Boolean)
  if (host === 'youtu.be' || host === 'www.youtu.be') {
    return segs[0] && VIDEO_ID_RE.test(segs[0]) ? { kind: 'video', videoId: segs[0] } : null
  }
  if (!YT_HOSTS.has(host)) return null
  const v = u.searchParams.get('v')
  const list = u.searchParams.get('list')
  if (segs[0] === 'watch' && v && VIDEO_ID_RE.test(v)) return { kind: 'video', videoId: v }
  if ((segs[0] === 'shorts' || segs[0] === 'embed' || segs[0] === 'live' || segs[0] === 'v') && segs[1] && VIDEO_ID_RE.test(segs[1])) {
    return { kind: 'video', videoId: segs[1] }
  }
  if (segs[0] === 'browse' && segs[1]) return classifyId(segs[1])
  if ((segs[0] === 'playlist' || segs[0] === 'watch') && list) return classifyId(list)
  return null
}
