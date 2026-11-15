// Soundboard (docs/SPEC.md): the toolbar / panel button, its popover grid of clips, the "who played what"
// feed above the stage button, and the host for the upload dialog and delete confirmation (rendered once,
// by the sidebar, so they outlive the popover). Playback and state: voice/soundboard.ts.
import { useEffect, useMemo, useRef, useState } from 'react'
import type { Sound } from '@shared/protocol'
import { MAX_SOUNDS, SOUND_COOLDOWN_MS } from '@shared/protocol'
import { useApp } from '../../store/app'
import { useSounds } from '../../store/sounds'
import { anchorOf, type AnchorRect } from '../../store/ui'
import { isStaff } from '../../lib/permissions'
import { toast } from '../../lib/toast'
import { deleteSound } from '../../net/sounds'
import { useVoice } from '../../voice/session'
import {
  closeSoundboard,
  playSound,
  previewSound,
  soundLabel,
  toggleSoundboard,
  useSoundboardUi,
} from '../../voice/soundboard'
import { Floating } from '../Floating'
import { ConfirmDialog } from '../Modal'
import { PlusIcon, SearchIcon, TrashIcon } from '../icons'
import { PlayIcon, SoundboardIcon, StopIcon } from './icons'
import { SoundUploadDialog } from './SoundUploadDialog'
import '../../styles/soundboard.css'

/** Width of the popover (soundboard.css .sb), used to center it over the button. */
const POPOVER_W = 344
/** More sounds than this: show the search box. */
const SEARCH_FROM = 12

export function SoundboardButton({ size = 'sm' }: { size?: 'sm' | 'lg' }) {
  const supported = useSounds((s) => s.supported)
  const from = size === 'lg' ? 'stage' : 'panel'
  const open = useSoundboardUi((s) => s.popover?.from === from)
  if (!supported) return null
  return (
    <span className="sb-btn-wrap">
      <button
        className={`vx-ctl vx-ctl-${size} ${open ? 'is-on' : ''}`}
        onClick={(e) => {
          const r = anchorOf(e.currentTarget)
          const mid = (r.left + r.right) / 2
          toggleSoundboard({ ...r, left: mid - POPOVER_W / 2, right: mid + POPOVER_W / 2 }, from)
        }}
        title="Soundboard"
        aria-label="Soundboard"
        aria-haspopup="dialog"
        aria-expanded={open}
      >
        <SoundboardIcon size={size === 'lg' ? 20 : 18} />
      </button>
      {size === 'lg' && <SoundFeed />}
    </span>
  )
}

/** "Alex played 📯 Airhorn", briefly, above the stage's soundboard button. */
function SoundFeed() {
  const feed = useSoundboardUi((s) => s.feed)
  const users = useApp((s) => s.users)
  // Labels resolved when shown (the sound may be renamed / deleted later; the line is short-lived).
  useSounds((s) => s.sounds)
  if (feed.length === 0) return null
  return (
    <span className="sb-feed" role="status" aria-live="polite">
      {feed.map((f) => (
        <span key={f.key} className="sb-feed-item">
          <strong>{users[f.userId]?.name ?? 'Someone'}</strong> played <em>{soundLabel(f.soundId)}</em>
        </span>
      ))}
    </span>
  )
}

/** Popover, upload dialog and delete confirmation. Render once. */
export function SoundboardHost() {
  const popover = useSoundboardUi((s) => s.popover)
  const uploadOpen = useSoundboardUi((s) => s.uploadOpen)
  const confirm = useSoundboardUi((s) => s.confirmDelete)
  // Remember where the popover was, to bring it back after the dialog.
  const lastAnchor = useRef<{ anchor: AnchorRect; from: 'panel' | 'stage' } | null>(null)
  if (popover) lastAnchor.current = popover

  const reopen = () => {
    const at = lastAnchor.current
    if (at && useVoice.getState().channelId) useSoundboardUi.setState({ popover: at })
  }

  return (
    <>
      {popover && <SoundboardPopover anchor={popover.anchor} />}
      {uploadOpen && (
        <SoundUploadDialog
          onClose={(added) => {
            useSoundboardUi.setState({ uploadOpen: false })
            if (added) reopen()
          }}
        />
      )}
      {confirm && (
        <ConfirmDialog
          title={`Delete “${confirm.name}”?`}
          message={<>It's removed from the soundboard for everyone. This can't be undone.</>}
          confirmLabel="Delete sound"
          danger
          onClose={() => {
            useSoundboardUi.setState({ confirmDelete: null })
            reopen()
          }}
          onConfirm={async () => {
            try {
              await deleteSound(confirm.id)
              useSoundboardUi.setState({ confirmDelete: null })
              reopen()
            } catch (err) {
              toast(err, 'error')
            }
          }}
        />
      )}
    </>
  )
}

function fold(s: string): string {
  return s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()
}

/** True until the local cooldown ends (re-renders at the end). */
function useCoolingDown(): { cooling: boolean; start: number } {
  const until = useSoundboardUi((s) => s.cooldownUntil)
  const start = useSoundboardUi((s) => s.cooldownStart)
  const [, tick] = useState(0)
  const cooling = Date.now() < until
  useEffect(() => {
    if (!cooling) return
    const t = window.setTimeout(() => tick((n) => n + 1), until - Date.now() + 10)
    return () => window.clearTimeout(t)
  }, [cooling, until])
  return { cooling, start }
}

function SoundboardPopover({ anchor }: { anchor: AnchorRect }) {
  const sounds = useSounds((s) => s.sounds)
  const me = useApp((s) => s.me)
  const connected = useVoice((s) => s.status === 'connected')
  const pending = useSoundboardUi((s) => s.pending)
  const previewing = useSoundboardUi((s) => s.previewing)
  const { cooling, start } = useCoolingDown()
  const [query, setQuery] = useState('')
  const searchRef = useRef<HTMLInputElement>(null)
  const showSearch = sounds.length > SEARCH_FROM

  useEffect(() => {
    if (showSearch) searchRef.current?.focus({ preventScroll: true })
  }, [showSearch])

  const shown = useMemo(() => {
    const q = fold(query.trim())
    return q ? sounds.filter((s) => fold(s.name).includes(q) || (s.emoji && s.emoji === query.trim())) : sounds
  }, [sounds, query])

  const full = sounds.length >= MAX_SOUNDS
  const canDelete = (s: Sound) => !!me && (s.uploaderId === me.id || isStaff(me))
  const disabledWhy = !connected ? 'Connect to voice to play sounds' : null

  const openUpload = () => {
    closeSoundboard()
    useSoundboardUi.setState({ uploadOpen: true })
  }

  return (
    <Floating anchor={anchor} side="top" onClose={closeSoundboard} className="sb" label="Soundboard">
      <header className="sb-head">
        <span className="sb-title">Soundboard</span>
        <span className="sb-count" title={`${sounds.length} of ${MAX_SOUNDS} sounds`}>
          {sounds.length}/{MAX_SOUNDS}
        </span>
      </header>
      {showSearch && (
        <label className="sb-search">
          <SearchIcon size={14} />
          <input
            ref={searchRef}
            className="sb-search-input"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape' && query) {
                e.preventDefault()
                setQuery('')
              } else if (e.key === 'Enter' && shown[0] && connected) {
                void playSound(shown[0].id)
              }
            }}
            // Escape clears the search first (Floating leaves it to the input while there's text).
            data-own-escape={query ? '' : undefined}
            placeholder="Search sounds"
            aria-label="Search sounds"
            spellCheck={false}
          />
        </label>
      )}
      {sounds.length === 0 ? (
        <div className="sb-empty">
          <SoundboardIcon size={26} />
          <span>No sounds yet. Add the first one!</span>
        </div>
      ) : shown.length === 0 ? (
        <div className="sb-empty is-search">No sounds match “{query.trim()}”</div>
      ) : (
        <div className="sb-grid" role="list">
          {shown.map((s) => (
            <div
              key={s.id}
              role="listitem"
              className={`sb-tile ${pending === s.id ? 'is-pending' : ''} ${cooling ? 'is-cooling' : ''}`}
            >
              <button
                className="sb-play"
                onClick={() => void playSound(s.id)}
                disabled={!connected || cooling || !!pending}
                title={disabledWhy ?? (cooling ? 'Wait a moment…' : `Play “${s.name}” to the channel`)}
              >
                <span className="sb-emoji" aria-hidden="true">
                  {s.emoji ?? <SoundboardIcon size={18} />}
                </span>
                <span className="sb-name">{s.name}</span>
              </button>
              {cooling && <CooldownRing key={start} start={start} />}
              <button
                className={`sb-mini sb-preview ${previewing === s.id ? 'is-active' : ''}`}
                onClick={() => previewSound(s.id)}
                title={previewing === s.id ? 'Stop preview' : 'Preview (only you hear it)'}
                aria-label={previewing === s.id ? `Stop preview of ${s.name}` : `Preview ${s.name} (only you hear it)`}
              >
                {previewing === s.id ? <StopIcon size={11} /> : <PlayIcon size={11} />}
              </button>
              {canDelete(s) && (
                <button
                  className="sb-mini sb-delete"
                  onClick={() => {
                    closeSoundboard()
                    useSoundboardUi.setState({ confirmDelete: s })
                  }}
                  title="Delete sound"
                  aria-label={`Delete ${s.name}`}
                >
                  <TrashIcon size={11} />
                </button>
              )}
            </div>
          ))}
        </div>
      )}
      <footer className="sb-foot">
        <span className="sb-hint">{disabledWhy ?? 'Everyone in your voice channel hears these.'}</span>
        <button
          className="vx-btn vx-btn-sm"
          onClick={openUpload}
          disabled={full}
          title={full ? `The soundboard is full (${MAX_SOUNDS} sounds)` : 'Add a sound'}
        >
          <PlusIcon size={14} /> Add sound
        </button>
      </footer>
    </Floating>
  )
}

/** A thin ring that empties over the rest of the cooldown. */
function CooldownRing({ start }: { start: number }) {
  const elapsed = Math.min(SOUND_COOLDOWN_MS, Math.max(0, Date.now() - start))
  return (
    <svg className="sb-ring" viewBox="0 0 20 20" aria-hidden="true">
      <circle cx="10" cy="10" r="8" pathLength={100} />
      <circle
        className="sb-ring-fill"
        cx="10"
        cy="10"
        r="8"
        pathLength={100}
        style={{ animationDuration: `${SOUND_COOLDOWN_MS}ms`, animationDelay: `-${elapsed}ms` }}
      />
    </svg>
  )
}
