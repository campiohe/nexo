// Music plugin panel (a popover from the now-playing bar, the stage toolbar or the sidebar voice panel): search
// YouTube Music (debounced; Enter searches now; pasted links are resolved), Songs / Albums / Playlists results,
// albums and playlists expand into their tracks, and the channel's queue (drag to reorder, remove, clear).
// Read-only with an explanation when you aren't in that voice channel. Render <MusicPanelHost/> once.
import { useEffect, useMemo, useRef, useState, type DragEvent, type KeyboardEvent } from 'react'
import type { MusicState, MusicTrack, MusicTrackInfo } from '@shared/protocol'
import type { MusicCollection } from '../../../../preload/api'
import { useApp } from '../../store/app'
import { useMusic } from '../../store/music'
import { usePlugins } from '../../store/plugins'
import type { AnchorRect } from '../../store/ui'
import { formatDuration, formatTotal, isMusicPlaying, queueDropIndex } from '../../voice/musicSync'
import {
  addTracks,
  closeCollection,
  closeMusicPanel,
  isMusicLink,
  musicControl,
  openCollection,
  runSearch,
  useMusicPanel,
  type MusicTab,
} from '../../voice/musicActions'
import { Floating } from '../Floating'
import { CloseIcon, PlusIcon, SearchIcon, TrashIcon } from '../icons'
import { AlertIcon } from './icons'
import { addedByName, Artwork, useInMusicChannel } from './MusicBar'
import { BackIcon, GripIcon, LinkIcon, MusicIcon, PlayNextIcon } from './musicIcons'
import { tKnown, useT } from '../../i18n'
import '../../styles/music.css'

const SEARCH_DEBOUNCE_MS = 350
const QUEUE_DRAG_TYPE = 'application/x-nexo-music-queue'

/** The open panel (if any). Render once (Sidebar). */
export function MusicPanelHost() {
  const open = useMusicPanel((s) => s.open)
  const pluginOn = usePlugins((s) => s.plugins.music)
  const channelExists = useApp((s) => !!open && s.channels.some((c) => c.id === open.channelId))
  useEffect(() => {
    if (open && (!pluginOn || !channelExists)) closeMusicPanel()
  }, [open, pluginOn, channelExists])
  if (!open || !pluginOn || !channelExists) return null
  return <MusicPanel channelId={open.channelId} anchor={open.anchor} />
}

/** The last query sent to the engine (reopening the panel doesn't search again). */
let searchedQuery = ''

function MusicPanel({ channelId, anchor }: { channelId: string; anchor: AnchorRect }) {
  const t = useT()
  const tab = useMusicPanel((s) => s.tab)
  const state = useMusic((s) => s.byChannel[channelId])
  const channelName = useApp((s) => s.channels.find((c) => c.id === channelId)?.name) ?? t('Voice // channel name fallback')
  const canAct = useInMusicChannel(channelId)
  const queueCount = state?.queue.length ?? 0

  const setTab = (next: MusicTab) => useMusicPanel.setState({ tab: next })

  return (
    <Floating anchor={anchor} side="top" onClose={closeMusicPanel} className="mu-panel" label={t('Music')}>
      <header className="mu-panel-head">
        <MusicIcon size={16} />
        <span className="mu-panel-title">{t('Music')}</span>
        <span className="mu-panel-channel" title={channelName}>
          {channelName}
        </span>
        <div className="vx-seg mu-tabs" role="tablist" aria-label={t('Music panel')}>
          <button role="tab" aria-selected={tab === 'search'} className={`vx-seg-btn ${tab === 'search' ? 'is-active' : ''}`} onClick={() => setTab('search')}>
            {t('Search')}
          </button>
          <button role="tab" aria-selected={tab === 'queue'} className={`vx-seg-btn ${tab === 'queue' ? 'is-active' : ''}`} onClick={() => setTab('queue')}>
            {queueCount > 0 ? t('Queue ({count})', { count: queueCount }) : t('Queue')}
          </button>
        </div>
        <button className="vx-icon-btn" onClick={closeMusicPanel} title={t('Close (Esc)')} aria-label={t('Close')}>
          <CloseIcon size={14} />
        </button>
      </header>
      {!canAct && (
        <div className="mu-panel-callout">
          <AlertIcon size={14} />
          <span>{t('Join {channel} to add songs or control its music.', { channel: channelName })}</span>
        </div>
      )}
      {tab === 'search' ? <SearchTab channelId={channelId} canAct={canAct} /> : <QueueTab channelId={channelId} state={state} canAct={canAct} />}
    </Floating>
  )
}

// ---------------------------------------------------------------------------------------------
// Search

function SearchTab({ channelId, canAct }: { channelId: string; canAct: boolean }) {
  const t = useT()
  const query = useMusicPanel((s) => s.query)
  const results = useMusicPanel((s) => s.results)
  const searching = useMusicPanel((s) => s.searching)
  const error = useMusicPanel((s) => s.searchError)
  const collection = useMusicPanel((s) => s.collection)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    inputRef.current?.focus({ preventScroll: true })
  }, [])

  // Debounced search (pasted links right away).
  useEffect(() => {
    const q = query.trim()
    if (q === searchedQuery) return
    const go = () => {
      searchedQuery = q
      void runSearch(q)
    }
    if (!q || isMusicLink(q)) return go()
    const timer = window.setTimeout(go, SEARCH_DEBOUNCE_MS)
    return () => window.clearTimeout(timer)
  }, [query])

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      searchedQuery = query.trim()
      void runSearch(query)
    } else if (e.key === 'Escape' && query) {
      e.preventDefault()
      useMusicPanel.setState({ query: '' })
    }
  }

  const add = (tracks: MusicTrackInfo[], next = false) => void addTracks(channelId, tracks, next)

  return (
    <>
      <label className="mu-search">
        {isMusicLink(query) ? <LinkIcon size={14} /> : <SearchIcon size={14} />}
        <input
          ref={inputRef}
          className="mu-search-input"
          value={query}
          onChange={(e) => useMusicPanel.setState({ query: e.target.value })}
          onKeyDown={onKeyDown}
          // Escape clears the search first (Floating leaves it to the input while there's text).
          data-own-escape={query ? '' : undefined}
          placeholder={t('Search songs, albums, playlists, or paste a link')}
          aria-label={t('Search YouTube Music')}
          spellCheck={false}
        />
        {searching && <span className="vx-spinner" aria-label={t('Searching')} />}
        {query && !searching && (
          <button className="mu-search-clear" onClick={() => useMusicPanel.setState({ query: '' })} aria-label={t('Clear search')} title={t('Clear')}>
            <CloseIcon size={12} />
          </button>
        )}
      </label>
      <div className="mu-panel-body">
        {collection ? (
          <CollectionView canAct={canAct} onAdd={add} linked={isMusicLink(collection.key)} />
        ) : error ? (
          <div className="mu-empty is-error">
            <AlertIcon size={18} />
            <span>{tKnown(error)}</span>
          </div>
        ) : !query.trim() ? (
          <div className="mu-empty">
            <MusicIcon size={24} />
            <span>{t('Find something to play. Everyone in the channel hears it, in sync.')}</span>
          </div>
        ) : results ? (
          <Results canAct={canAct} onAdd={add} />
        ) : null}
      </div>
    </>
  )
}

function Results({ canAct, onAdd }: { canAct: boolean; onAdd(tracks: MusicTrackInfo[], next?: boolean): void }) {
  const t = useT()
  const results = useMusicPanel((s) => s.results)
  if (!results) return null
  const none = results.tracks.length === 0 && results.albums.length === 0 && results.playlists.length === 0
  if (none) return <div className="mu-empty is-search">{t('No results')}</div>
  return (
    <>
      {results.tracks.length > 0 && (
        <section className="mu-section">
          <h4 className="mu-section-title">{t('Songs')}</h4>
          <ul className="mu-list">
            {results.tracks.map((track, i) => (
              <TrackRow key={`${track.videoId}:${i}`} track={track} canAct={canAct} onAdd={onAdd} />
            ))}
          </ul>
        </section>
      )}
      <CollectionSection title={t('Albums')} items={results.albums} />
      <CollectionSection title={t('Playlists')} items={results.playlists} />
    </>
  )
}

function CollectionSection({ title, items }: { title: string; items: MusicCollection[] }) {
  if (items.length === 0) return null
  return (
    <section className="mu-section">
      <h4 className="mu-section-title">{title}</h4>
      <ul className="mu-list">
        {items.map((c) => (
          <li key={c.id}>
            <button className="mu-row mu-row-collection" onClick={() => void openCollection({ key: c.id, title: c.title, artwork: c.artwork })}>
              <Artwork src={c.artwork} size={36} />
              <span className="mu-row-text">
                <span className="mu-row-title">{c.title}</span>
                <span className="mu-row-sub">{c.subtitle}</span>
              </span>
              <span className="mu-row-chevron" aria-hidden="true">
                ›
              </span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  )
}

function TrackRow(props: { track: MusicTrackInfo; canAct: boolean; onAdd(tracks: MusicTrackInfo[], next?: boolean): void; index?: number }) {
  const { track, canAct, onAdd, index } = props
  const t = useT()
  const why = canAct ? undefined : t('Join the voice channel to add songs')
  return (
    <li className="mu-row mu-row-track" onDoubleClick={canAct ? () => onAdd([track]) : undefined} title={canAct ? t('Double-click to add to the queue') : why}>
      {index !== undefined ? <span className="mu-row-index">{index + 1}</span> : <Artwork src={track.artwork} size={36} />}
      <span className="mu-row-text">
        <span className="mu-row-title">{track.title}</span>
        <span className="mu-row-sub">
          {[track.artist, track.album].filter(Boolean).join(' · ')}
        </span>
      </span>
      <span className="mu-row-dur">{formatDuration(track.durationMs)}</span>
      <span className="mu-row-actions">
        <button className="mu-btn" onClick={() => onAdd([track], true)} disabled={!canAct} title={why ?? t('Play next')} aria-label={t('Play {title} next', { title: track.title })}>
          <PlayNextIcon size={15} />
        </button>
        <button className="mu-btn" onClick={() => onAdd([track])} disabled={!canAct} title={why ?? t('Add to queue')} aria-label={t('Add {title} to the queue', { title: track.title })}>
          <PlusIcon size={15} />
        </button>
      </span>
    </li>
  )
}

function CollectionView({ canAct, onAdd, linked }: { canAct: boolean; onAdd(tracks: MusicTrackInfo[], next?: boolean): void; linked: boolean }) {
  const t = useT()
  const c = useMusicPanel((s) => s.collection)
  if (!c) return null
  const tracks = c.data?.tracks ?? []
  const total = tracks.reduce((sum, x) => sum + x.durationMs, 0)
  return (
    <section className="mu-section">
      <div className="mu-collection-head">
        {!linked && (
          <button className="vx-icon-btn" onClick={closeCollection} title={t('Back to results')} aria-label={t('Back to results')}>
            <BackIcon size={16} />
          </button>
        )}
        <Artwork src={c.artwork ?? tracks[0]?.artwork ?? null} size={44} />
        <span className="mu-row-text">
          <span className="mu-row-title">{c.title}</span>
          <span className="mu-row-sub">{c.loading
              ? t('Loading…')
              : tracks.length
                ? t('{count, plural, one {# song} other {# songs}} · {total}', { count: tracks.length, total: formatTotal(total) })
                : ''}</span>
        </span>
        {tracks.length > 0 && (
          <button
            className="vx-btn vx-btn-sm vx-btn-primary"
            onClick={() => onAdd(tracks)}
            disabled={!canAct}
            title={canAct ? t('Add every song to the queue') : t('Join the voice channel to add songs')}
          >
            <PlusIcon size={14} /> {t('Add all')}
          </button>
        )}
      </div>
      {c.loading ? (
        <div className="mu-empty is-search">
          <span className="vx-spinner" />
        </div>
      ) : c.error ? (
        <div className="mu-empty is-error">
          <AlertIcon size={18} />
          <span>{tKnown(c.error)}</span>
        </div>
      ) : (
        <ul className="mu-list">
          {tracks.map((track, i) => (
            <TrackRow key={`${track.videoId}:${i}`} track={track} canAct={canAct} onAdd={onAdd} index={linked && tracks.length === 1 ? undefined : i} />
          ))}
        </ul>
      )}
    </section>
  )
}

// ---------------------------------------------------------------------------------------------
// Queue

function QueueTab({ channelId, state, canAct }: { channelId: string; state: MusicState | undefined; canAct: boolean }) {
  const t = useT()
  const users = useApp((s) => s.users)
  const meId = useApp((s) => s.me?.id)
  const queue = state?.queue ?? []
  const cur = state?.current ?? null
  const total = useMemo(() => queue.reduce((sum, x) => sum + x.durationMs, 0), [queue])
  const [drag, setDrag] = useState<string | null>(null)
  const [over, setOver] = useState<{ index: number; after: boolean } | null>(null)
  const [confirmClear, setConfirmClear] = useState(false)
  useEffect(() => {
    if (!confirmClear) return
    const timer = window.setTimeout(() => setConfirmClear(false), 3000)
    return () => window.clearTimeout(timer)
  }, [confirmClear])

  const move = (queueId: string, toIndex: number) => void musicControl(channelId, 'move', { queueId, toIndex })
  const endDrag = () => {
    setDrag(null)
    setOver(null)
  }
  const onDragOver = (e: DragEvent<HTMLLIElement>, index: number) => {
    if (!drag || !e.dataTransfer.types.includes(QUEUE_DRAG_TYPE)) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    const r = e.currentTarget.getBoundingClientRect()
    const after = e.clientY > r.top + r.height / 2
    setOver((o) => (o && o.index === index && o.after === after ? o : { index, after }))
  }
  const onDrop = (e: DragEvent<HTMLLIElement>) => {
    e.preventDefault()
    const from = queue.findIndex((x) => x.queueId === drag)
    const to = over ? queueDropIndex(from, over.index, over.after) : null
    if (drag && to !== null) move(drag, to)
    endDrag()
  }

  return (
    <div className="mu-panel-body">
      {cur ? (
        <section className="mu-section">
          <h4 className="mu-section-title">{isMusicPlaying(state) ? t('Now playing') : t('Paused // song')}</h4>
          <div className="mu-row mu-row-current">
            <Artwork src={cur.artwork} size={40} />
            <span className="mu-row-text">
              <span className="mu-row-title">{cur.title}</span>
              <span className="mu-row-sub">
                {cur.artist} · {t('added by {name}', { name: addedByName(users, cur.addedBy, meId, t) })}
              </span>
            </span>
            <span className="mu-row-dur">{formatDuration(cur.durationMs)}</span>
          </div>
        </section>
      ) : (
        <div className="mu-empty is-search">{t('Nothing is playing.')}</div>
      )}
      <section className="mu-section">
        <h4 className="mu-section-title">
          {t('Up next')}
          {queue.length > 0 && (
            <span className="mu-section-meta">
              {t('{count, plural, one {# song} other {# songs}} · {total}', { count: queue.length, total: formatTotal(total) })}
            </span>
          )}
        </h4>
        {queue.length === 0 ? (
          <div className="mu-empty is-search">
            {t('The queue is empty.')}{' '}
            <button className="mu-link" onClick={() => useMusicPanel.setState({ tab: 'search' })}>
              {t('Search for songs')}
            </button>
          </div>
        ) : (
          <ul className="mu-list mu-queue" onDragLeave={(e) => !e.currentTarget.contains(e.relatedTarget as Node | null) && setOver(null)}>
            {queue.map((track, i) => (
              <QueueRow
                key={track.queueId}
                track={track}
                index={i}
                count={queue.length}
                canAct={canAct}
                addedBy={addedByName(users, track.addedBy, meId, t)}
                dragging={drag === track.queueId}
                dropEdge={over?.index === i && drag !== track.queueId ? (over.after ? 'after' : 'before') : null}
                onDragStart={(e) => {
                  e.dataTransfer.setData(QUEUE_DRAG_TYPE, track.queueId)
                  e.dataTransfer.effectAllowed = 'move'
                  setDrag(track.queueId)
                }}
                onDragEnd={endDrag}
                onDragOver={(e) => onDragOver(e, i)}
                onDrop={onDrop}
                onMove={(to) => move(track.queueId, to)}
                onRemove={() => void musicControl(channelId, 'remove', { queueId: track.queueId })}
              />
            ))}
          </ul>
        )}
      </section>
      {queue.length > 0 && (
        <footer className="mu-queue-foot">
          <span className="mu-hint">{canAct ? t('Drag songs to reorder (or Alt+↑/↓).') : ''}</span>
          <button
            className={`vx-btn vx-btn-sm ${confirmClear ? 'mu-btn-danger' : ''}`}
            disabled={!canAct}
            onClick={() => {
              if (!confirmClear) return setConfirmClear(true)
              setConfirmClear(false)
              void musicControl(channelId, 'clear')
            }}
          >
            <TrashIcon size={13} /> {confirmClear ? t('Click again to clear') : t('Clear queue')}
          </button>
        </footer>
      )}
    </div>
  )
}

interface QueueRowProps {
  track: MusicTrack
  index: number
  count: number
  canAct: boolean
  addedBy: string
  dragging: boolean
  dropEdge: 'before' | 'after' | null
  onDragStart(e: DragEvent<HTMLLIElement>): void
  onDragEnd(): void
  onDragOver(e: DragEvent<HTMLLIElement>): void
  onDrop(e: DragEvent<HTMLLIElement>): void
  onMove(toIndex: number): void
  onRemove(): void
}

function QueueRow(p: QueueRowProps) {
  const { track, index, count, canAct } = p
  const t = useT()
  return (
    <li
      className={`mu-row mu-row-queue ${p.dragging ? 'is-dragging' : ''} ${p.dropEdge ? `is-drop-${p.dropEdge}` : ''}`}
      draggable={canAct}
      onDragStart={canAct ? p.onDragStart : undefined}
      onDragEnd={p.onDragEnd}
      onDragOver={p.onDragOver}
      onDrop={p.onDrop}
      tabIndex={canAct ? 0 : -1}
      aria-label={`${index + 1}. ${track.title} — ${track.artist}`}
      aria-keyshortcuts={canAct ? 'Alt+ArrowUp Alt+ArrowDown Delete' : undefined}
      onKeyDown={(e) => {
        if (!canAct || e.target !== e.currentTarget) return
        if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
          e.preventDefault()
          const to = index + (e.key === 'ArrowUp' ? -1 : 1)
          if (to >= 0 && to < count) p.onMove(to)
        } else if (e.key === 'Delete') {
          e.preventDefault()
          p.onRemove()
        }
      }}
    >
      {canAct && (
        <span className="mu-grip" aria-hidden="true">
          <GripIcon size={14} />
        </span>
      )}
      <Artwork src={track.artwork} size={32} />
      <span className="mu-row-text">
        <span className="mu-row-title">{track.title}</span>
        <span className="mu-row-sub">
          {track.artist} · {t('added by {name}', { name: p.addedBy })}
        </span>
      </span>
      <span className="mu-row-dur">{formatDuration(track.durationMs)}</span>
      <span className="mu-row-actions">
        <button className="mu-btn" onClick={p.onRemove} disabled={!canAct} title={t('Remove from the queue')} aria-label={t('Remove {name}', { name: track.title })}>
          <CloseIcon size={13} />
        </button>
      </span>
    </li>
  )
}
