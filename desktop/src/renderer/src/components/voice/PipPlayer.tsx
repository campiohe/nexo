// Floating video player (Discord-style picture-in-picture): while you're in a voice call but looking at
// another channel, the stream you're watching (else someone's camera) keeps playing in a small card in
// a corner of the app. Plus the OS-level pop-out window (browser Picture-in-Picture), which also works
// with Nexo minimized; it lives on its own hidden <video> (PopOutHost) so it survives navigation.
import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { useApp } from '@renderer/store/app'
import { toast } from '@renderer/lib/toast'
import { setStreamVolume, useVoice } from '../../voice/session'
import { isAudiblySpeaking, useParticipants, type VideoTrack } from '../../voice/participants'
import { VideoTrackView } from './VideoTrackView'
import { CloseIcon, PopOutIcon, ReturnIcon, VolumeIcon, VolumeOffIcon } from './icons'
import {
  clearPipDismissed,
  closePopOut,
  dismissKey,
  dismissPip,
  isPoppedOut,
  pickSubject,
  popOut,
  supportsPopOut,
  trackFor,
  usePip,
  type PipSubject,
  type PipTarget,
} from './pip'
import './voice.css'
import './pip.css'

/** Floating player + pop-out host. Rendered once by MainLayout. */
export function PipLayer() {
  return (
    <>
      <PipPlayer />
      <PopOutHost />
    </>
  )
}

// ---------------------------------------------------------------------------------------------
// Floating in-app player
// ---------------------------------------------------------------------------------------------

function PipPlayer() {
  const voiceChannelId = useVoice((s) => (s.status === 'connected' || s.status === 'reconnecting' ? s.channelId : null))
  const selectedChannelId = useApp((s) => s.selectedChannelId)
  const overChat = useApp((s) => s.channels.find((c) => c.id === s.selectedChannelId)?.type === 'text')
  const list = useParticipants((s) => s.list)
  const watchOrder = usePip((s) => s.watchOrder)
  const cameraPick = usePip((s) => s.cameraPick)
  const dismissedKey = usePip((s) => s.dismissedKey)
  const poppedOut = usePip((s) => s.poppedOut)

  const away = !!voiceChannelId && selectedChannelId !== voiceChannelId
  const subject = away ? pickSubject(list, watchOrder, cameraPick) : null
  const subjectKey = subject ? dismissKey(subject) : null

  // A dismissed player comes back when you return to the call (or leave voice)...
  useEffect(() => {
    if (!away) clearPipDismissed()
  }, [away])
  // ...or when there's something else to show.
  useEffect(() => {
    if (subjectKey && dismissedKey && subjectKey !== dismissedKey) clearPipDismissed()
  }, [subjectKey, dismissedKey])

  // One picture-in-picture at a time: while the OS window is open, the in-app card stays hidden.
  if (!voiceChannelId || !subject || subjectKey === dismissedKey || poppedOut) return null
  return <PipCard subject={subject} voiceChannelId={voiceChannelId} overChat={overChat} />
}

type Corner = 'tl' | 'tr' | 'bl' | 'br'
const CORNER_KEY = 'nexo:pipCorner'
const DRAG_THRESHOLD = 5

function loadCorner(): Corner {
  try {
    const v = localStorage.getItem(CORNER_KEY)
    if (v === 'tl' || v === 'tr' || v === 'bl' || v === 'br') return v
  } catch {
    // storage unavailable: default corner
  }
  return 'br'
}

function saveCorner(c: Corner): void {
  try {
    localStorage.setItem(CORNER_KEY, c)
  } catch {
    // not persisted; fine
  }
}

/** Corner of the area the player may occupy (right of the sidebar) closest to the card's center. */
function nearestCorner(rect: DOMRect): Corner {
  const left = document.querySelector('.sidebar')?.getBoundingClientRect().right ?? 0
  const midX = (left + window.innerWidth) / 2
  const midY = window.innerHeight / 2
  const cx = rect.left + rect.width / 2
  const cy = rect.top + rect.height / 2
  return `${cy < midY ? 't' : 'b'}${cx < midX ? 'l' : 'r'}` as Corner
}

interface DragState {
  pointerId: number
  x: number
  y: number
  rect: DOMRect
  moved: boolean
}

interface PipCardProps {
  subject: PipSubject
  voiceChannelId: string
  overChat: boolean
}

function PipCard({ subject, voiceChannelId, overChat }: PipCardProps) {
  const { view, kind } = subject
  const user = useApp((s) => s.users[view.identity])
  const channelName = useApp((s) => s.channels.find((c) => c.id === voiceChannelId)?.name ?? 'voice')
  const deafened = useVoice((s) => s.deafened)
  const volume = useParticipants((s) => s.streamVolumes[view.identity] ?? 1)
  const [corner, setCorner] = useState<Corner>(loadCorner)
  const [snapSeq, setSnapSeq] = useState(0)
  const ref = useRef<HTMLDivElement>(null)
  const drag = useRef<DragState | null>(null)
  const snapFrom = useRef<DOMRect | null>(null)
  // Unmuting restores the level the stream had before muting (not always 100%).
  const lastVolume = useRef(volume > 0 ? volume : 1)
  if (volume > 0) lastVolume.current = volume

  const name = user?.name ?? view.name
  const isStream = kind === 'stream'
  const label = isStream ? (view.isLocal ? 'Your stream' : `${name}'s stream`) : `${name}'s camera`
  const showStreamAudio = isStream && view.hasScreenAudio && !view.isLocal
  const audioOff = volume === 0 || deafened

  const returnToCall = () => useApp.getState().selectChannel(voiceChannelId)

  // Snap animation (FLIP): the card is already at its new corner; start it where it was dropped.
  useLayoutEffect(() => {
    const el = ref.current
    const from = snapFrom.current
    if (!el || !from) return
    snapFrom.current = null
    el.style.transition = 'none'
    el.style.transform = ''
    const to = el.getBoundingClientRect()
    el.style.transform = `translate(${from.left - to.left}px, ${from.top - to.top}px)`
    void el.offsetWidth
    el.style.transition = ''
    el.style.transform = ''
  }, [snapSeq])

  // Drag styling is applied imperatively (not via className) so re-renders mid-drag can't undo it.
  const endDrag = (el: HTMLDivElement) => {
    delete el.dataset.dragging
    drag.current = null
  }

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || drag.current) return
    // Controls handle their own clicks; only the video body drags / returns to the call.
    if ((e.target as Element).closest('button, input, label')) return
    const el = e.currentTarget
    drag.current = { pointerId: e.pointerId, x: e.clientX, y: e.clientY, rect: el.getBoundingClientRect(), moved: false }
    el.setPointerCapture(e.pointerId)
  }

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current
    if (!d || d.pointerId !== e.pointerId) return
    let dx = e.clientX - d.x
    let dy = e.clientY - d.y
    if (!d.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) return
    const el = e.currentTarget
    if (!d.moved) {
      d.moved = true
      el.dataset.dragging = ''
    }
    // Keep the whole card inside the window while dragging.
    dx = Math.min(Math.max(dx, -d.rect.left), window.innerWidth - d.rect.right)
    dy = Math.min(Math.max(dy, -d.rect.top), window.innerHeight - d.rect.bottom)
    el.style.transform = `translate(${dx}px, ${dy}px)`
  }

  const onPointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current
    if (!d || d.pointerId !== e.pointerId) return
    const el = e.currentTarget
    endDrag(el)
    if (!d.moved) {
      returnToCall()
      return
    }
    const rect = el.getBoundingClientRect()
    const next = nearestCorner(rect)
    snapFrom.current = rect
    saveCorner(next)
    setCorner(next)
    setSnapSeq((n) => n + 1)
  }

  const onPointerCancel = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current
    if (!d || d.pointerId !== e.pointerId) return
    const el = e.currentTarget
    endDrag(el)
    if (d.moved) {
      // Glide back to the corner it came from.
      snapFrom.current = el.getBoundingClientRect()
      setSnapSeq((n) => n + 1)
    }
  }

  return (
    <div
      ref={ref}
      role="region"
      aria-label={`${label} (picture-in-picture)`}
      title="Click to return to the call · drag to move"
      className={`pip is-${corner} ${overChat ? 'is-over-chat' : ''} ${
        !isStream && isAudiblySpeaking(view) ? 'is-speaking' : ''
      }`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      onLostPointerCapture={onPointerCancel}
    >
      <VideoTrackView track={subject.track} fit={isStream ? 'contain' : 'cover'} />
      <div className="pip-overlay">
        <div className="pip-top">
          {isStream && <span className="vx-live-badge">LIVE</span>}
          <span className="pip-name">{isStream && view.isLocal ? 'Your stream' : name}</span>
          <span className="pip-grow" />
          {supportsPopOut() && (
            <button className="vx-tile-btn" onClick={() => popOut(subject)} title="Pop out" aria-label="Pop out">
              <PopOutIcon size={16} />
            </button>
          )}
          <button className="vx-tile-btn" onClick={() => dismissPip(subject)} title="Close" aria-label="Close player">
            <CloseIcon size={16} />
          </button>
        </div>
        <div className="pip-bottom">
          <button className="vx-tile-btn is-text" onClick={returnToCall} title={`Return to ${channelName}`}>
            <ReturnIcon size={15} /> Return to call
          </button>
          <span className="pip-grow" />
          {showStreamAudio && (
            <button
              className="vx-tile-btn"
              onClick={() => setStreamVolume(view.identity, volume > 0 ? 0 : lastVolume.current)}
              title={deafened ? 'You are deafened' : volume > 0 ? 'Mute stream' : 'Unmute stream'}
              aria-label={volume > 0 ? 'Mute stream' : 'Unmute stream'}
            >
              {audioOff ? <VolumeOffIcon size={16} /> : <VolumeIcon size={16} />}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------------------------
// OS pop-out window
// ---------------------------------------------------------------------------------------------

/**
 * Owns the <video> shown in the OS picture-in-picture window. It's a separate element (invisible, kept
 * mounted while popped out) so the window stays open whichever view is on screen, and closes by itself
 * when its stream / camera goes away (stopped, unwatched, left voice).
 */
function PopOutHost() {
  const poppedOut = usePip((s) => s.poppedOut)
  const track = useParticipants((s) => (poppedOut ? trackFor(s.list, poppedOut) : null))

  useEffect(() => {
    if (poppedOut && !track) closePopOut()
  }, [poppedOut, track])

  // Logging out / leaving the main view: nothing should reopen the window later.
  useEffect(() => () => closePopOut(), [])

  if (!poppedOut || !track) return null
  // Keyed by target: a different subject gets a fresh element (and window); a new track object for the
  // same subject (resubscribe after a reconnect) is re-attached to the same one.
  return <PopOutVideo key={`${poppedOut.kind}:${poppedOut.identity}`} target={poppedOut} track={track} />
}

/** Default size of the hidden element before the window reports its own (drives adaptiveStream quality). */
const POPOUT_W = 640
const POPOUT_H = 360

function PopOutVideo({ target, track }: { target: PipTarget; track: VideoTrack }) {
  const [el, setEl] = useState<HTMLVideoElement | null>(null)
  const boxRef = useRef<HTMLDivElement>(null)
  const { kind, identity } = target

  useEffect(() => {
    if (!el) return
    const box = boxRef.current
    let cancelled = false
    let pipWindow: PictureInPictureWindow | null = null
    // LiveKit's adaptiveStream sizes the subscription from the element's size, so mirror the window's.
    const fitToWindow = () => {
      if (!box || !pipWindow || !pipWindow.width) return
      box.style.width = `${pipWindow.width}px`
      box.style.height = `${pipWindow.height}px`
    }
    const onLeave = () => {
      pipWindow?.removeEventListener('resize', fitToWindow)
      pipWindow = null
      const current = usePip.getState().poppedOut
      if (current && isPoppedOut(current, { kind, identity })) usePip.setState({ poppedOut: null })
    }
    const request = () => {
      if (cancelled || document.pictureInPictureElement === el) return
      el.requestPictureInPicture().then(
        (win) => {
          if (cancelled) return
          pipWindow = win
          fitToWindow()
          win.addEventListener('resize', fitToWindow)
        },
        (err: unknown) => {
          if (cancelled) return
          console.warn('[pip] requestPictureInPicture failed', err)
          toast("Couldn't pop out the video", 'error')
          onLeave()
        },
      )
    }
    el.addEventListener('leavepictureinpicture', onLeave)
    if (el.readyState >= HTMLMediaElement.HAVE_METADATA) request()
    else el.addEventListener('loadedmetadata', request, { once: true })
    return () => {
      cancelled = true
      el.removeEventListener('leavepictureinpicture', onLeave)
      el.removeEventListener('loadedmetadata', request)
      pipWindow?.removeEventListener('resize', fitToWindow)
      if (document.pictureInPictureElement === el) void document.exitPictureInPicture().catch(() => {})
    }
  }, [el, kind, identity])

  return (
    <div ref={boxRef} className="pip-popout-host" style={{ width: POPOUT_W, height: POPOUT_H }} aria-hidden="true">
      <VideoTrackView track={track} fit="contain" onElement={setEl} />
    </div>
  )
}
