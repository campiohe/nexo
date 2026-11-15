// Music plugin: requests to the server (`music:add`, `music:control`, `plugins:set`) with their errors toasted,
// YouTube Music engine errors turned into text, and the music panel's UI state (open / anchor / tab / search),
// kept here so the search survives closing and reopening the panel.
import { create } from 'zustand'
import type { MusicState, MusicTrackInfo, PluginId } from '@shared/protocol'
import { MUSIC_MAX_ADD } from '@shared/protocol'
import type { MusicCollection, MusicCollectionTracks, MusicEngineError, MusicSearchResults } from '../../../preload/api'
import { request } from '../net/socket'
import { applyMusicState } from '../store/music'
import { applyPlugins } from '../store/plugins'
import type { AnchorRect } from '../store/ui'
import { toast } from '../lib/toast'

// ---------------------------------------------------------------------------------------------
// Errors

export type MusicErrorCode = MusicEngineError['code']

export function isMusicEngineError(err: unknown): err is MusicEngineError {
  return !!err && typeof err === 'object' && (err as { name?: unknown }).name === 'MusicEngineError'
}

const ERROR_TEXT: Record<MusicErrorCode, string> = {
  'bot-check': "YouTube is asking this device to verify it isn't a bot. Try again later.",
  unavailable: "This song isn't available here (removed, region-locked or age-restricted).",
  network: "Couldn't reach YouTube. Check your connection.",
  engine: 'YouTube changed something Nexo relies on. An app update should fix it.',
}

/** Readable text for a MusicEngineError code. */
export function musicErrorText(code: MusicErrorCode): string {
  return ERROR_TEXT[code] ?? ERROR_TEXT.engine
}

/** Readable text for anything a music engine call rejected with. */
export function musicErrorMessage(err: unknown): string {
  if (isMusicEngineError(err)) return musicErrorText(err.code)
  if (err instanceof Error && err.message) return err.message
  return ERROR_TEXT.engine
}

/** The engine in the main process (missing in a plain browser or an app build without it). */
export function musicEngine() {
  const bridge = (window as { nexo?: Window['nexo'] }).nexo
  return bridge?.music ?? null
}

// ---------------------------------------------------------------------------------------------
// Server requests (errors are human-readable: toasted)

type ControlAction = 'play' | 'pause' | 'seek' | 'skip' | 'previous' | 'remove' | 'move' | 'clear' | 'stop'

/** `music:control`; resolves with the new state (also applied to the store), or null after toasting the error. */
export async function musicControl(
  channelId: string,
  action: ControlAction,
  extra: { positionMs?: number; queueId?: string; toIndex?: number } = {},
): Promise<MusicState | null> {
  try {
    const state = await request('music:control', { channelId, action, ...extra })
    applyMusicState(state)
    return state
  } catch (err) {
    toast(err, 'error')
    return null
  }
}

/** Only the fields the server validates (search results may carry more). */
function infoOf(t: MusicTrackInfo): MusicTrackInfo {
  return { videoId: t.videoId, title: t.title, artist: t.artist, album: t.album, durationMs: t.durationMs, artwork: t.artwork }
}

/**
 * `music:add` (in chunks of MUSIC_MAX_ADD). `next`: right after the current track (chunks keep their order).
 * Returns how many were added.
 */
export async function addTracks(channelId: string, tracks: MusicTrackInfo[], next = false): Promise<number> {
  const list = tracks.filter((t) => t && t.durationMs > 0).map(infoOf)
  if (list.length === 0) {
    toast('Nothing playable to add', 'error')
    return 0
  }
  const chunks: MusicTrackInfo[][] = []
  for (let i = 0; i < list.length; i += MUSIC_MAX_ADD) chunks.push(list.slice(i, i + MUSIC_MAX_ADD))
  // "Play next" for several chunks: insert the last chunk first so the first ends up right after the current track.
  if (next) chunks.reverse()
  let added = 0
  for (const chunk of chunks) {
    try {
      applyMusicState(await request('music:add', { channelId, tracks: chunk, next }))
      added += chunk.length
    } catch (err) {
      toast(err, 'error')
      break
    }
  }
  if (added > 0) {
    const what = added === 1 ? `“${list[0].title}”` : `${added} songs`
    toast(next ? `${what} plays next` : `Added ${what} to the queue`, 'success', 2500)
  }
  return added
}

/** Admins / owner: turn a plugin on or off for the whole server. */
export async function setPlugin(plugin: PluginId, enabled: boolean): Promise<boolean> {
  try {
    applyPlugins(await request('plugins:set', { plugin, enabled }))
    return true
  } catch (err) {
    toast(err, 'error')
    return false
  }
}

// ---------------------------------------------------------------------------------------------
// Music panel UI state

export type MusicTab = 'search' | 'queue'

/** An album / playlist (or pasted link) opened in the results. */
export interface OpenCollection {
  /** What was resolved: MusicCollection.id or the pasted link. */
  key: string
  /** Shown while loading (from the search result), then the resolved title. */
  title: string
  artwork: string | null
  loading: boolean
  data: MusicCollectionTracks | null
  error: string | null
}

interface MusicPanelState {
  /** The open panel: the voice channel it's about, anchored to the button that opened it. */
  open: { channelId: string; anchor: AnchorRect; from: string } | null
  tab: MusicTab
  query: string
  /** Results of `query` (null before the first search / while it's empty). */
  results: MusicSearchResults | null
  searching: boolean
  searchError: string | null
  /** A link was pasted: its tracks (shown instead of search results). */
  collection: OpenCollection | null
}

export const useMusicPanel = create<MusicPanelState>()(() => ({
  open: null,
  tab: 'search',
  query: '',
  results: null,
  searching: false,
  searchError: null,
  collection: null,
}))

/** A click on the button that just closed the panel (pointerdown outside) must not reopen it. */
let lastClosed = { at: 0, from: '' }

export function closeMusicPanel(): void {
  const cur = useMusicPanel.getState().open
  if (!cur) return
  lastClosed = { at: Date.now(), from: cur.from }
  useMusicPanel.setState({ open: null })
}

/** Open (or close, when open from the same button) the music panel of `channelId`. */
export function toggleMusicPanel(channelId: string, anchor: AnchorRect, from: string, tab?: MusicTab): void {
  const cur = useMusicPanel.getState().open
  if (cur?.from === from) return closeMusicPanel()
  if (!cur && lastClosed.from === from && Date.now() - lastClosed.at < 250) return
  useMusicPanel.setState((s) => ({ open: { channelId, anchor, from }, tab: tab ?? (s.query ? 'search' : s.tab) }))
}

/** Another server / signed out. */
export function resetMusicPanel(): void {
  useMusicPanel.setState({ open: null, tab: 'search', query: '', results: null, searching: false, searchError: null, collection: null })
}

/** Looks like a link to paste (music.youtube.com / youtube.com / youtu.be), resolved instead of searched. */
export function isMusicLink(q: string): boolean {
  const s = q.trim()
  return /^(https?:\/\/)?([a-z0-9-]+\.)*(youtube\.com|youtu\.be)\//i.test(s)
}

let searchSeq = 0

/** Run the search for `query` now (debouncing is the caller's). Stale answers are dropped. */
export async function runSearch(query: string): Promise<void> {
  const q = query.trim()
  const seq = ++searchSeq
  const engine = musicEngine()
  if (!q) {
    useMusicPanel.setState({ results: null, searching: false, searchError: null, collection: null })
    return
  }
  if (!engine) {
    useMusicPanel.setState({ searching: false, searchError: "This version of Nexo can't search YouTube Music." })
    return
  }
  if (isMusicLink(q)) {
    useMusicPanel.setState({ searching: false, searchError: null, results: null })
    await openCollection({ key: q, title: 'Link', artwork: null })
    return
  }
  useMusicPanel.setState({ searching: true, searchError: null, collection: null })
  try {
    const results = await engine.search(q)
    if (seq !== searchSeq) return
    useMusicPanel.setState({ results, searching: false })
  } catch (err) {
    if (seq !== searchSeq) return
    useMusicPanel.setState({ searching: false, searchError: musicErrorMessage(err) })
  }
}

/** Expand an album / playlist (or resolve a pasted link) into its tracks. */
export async function openCollection(c: Pick<MusicCollection, 'title' | 'artwork'> & { key: string }): Promise<void> {
  const engine = musicEngine()
  if (!engine) return
  const seq = ++searchSeq
  useMusicPanel.setState({ collection: { key: c.key, title: c.title, artwork: c.artwork, loading: true, data: null, error: null } })
  let data: MusicCollectionTracks | null = null
  let error: string | null = null
  try {
    data = await engine.resolve(c.key)
    if (!data || data.tracks.length === 0) error = isMusicLink(c.key) ? 'Nothing playable at that link.' : 'Nothing playable in there.'
  } catch (err) {
    error = musicErrorMessage(err)
  }
  if (seq !== searchSeq) return
  useMusicPanel.setState((s) =>
    s.collection?.key === c.key
      ? { collection: { ...s.collection, loading: false, data, error, title: data?.title || s.collection.title } }
      : {},
  )
}

export function closeCollection(): void {
  searchSeq++
  useMusicPanel.setState({ collection: null })
}
