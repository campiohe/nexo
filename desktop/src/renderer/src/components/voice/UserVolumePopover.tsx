// Owner: workstream D. Floating per-user "voice user card", opened by right-clicking someone in voice (sidebar
// voice members, voice stage tiles, member list). Self-contained: render it anywhere with the click position
// as `anchor`; it portals to <body>, keeps itself inside the viewport and closes on outside click / Esc.
// - Volume ("lower a friend's volume"): for everyone but yourself.
// - Actions, while the target is in voice: "Wake up" (they're muted or deafened; anyone may nudge) and
//   "Move to" another voice channel (admins / owner, lib/permissions.ts canMoveMember). Right-clicking
//   yourself opens an actions-only card (staff: move yourself); it closes once it has nothing to offer.
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useApp } from '@renderer/store/app'
import { canMoveMember } from '@renderer/lib/permissions'
import { toast } from '@renderer/lib/toast'
import { setUserMuted, setUserVolume, useUserVolume } from '../../voice/session'
import { USER_VOLUME_MAX } from '../../voice/userVolumes'
import { useParticipants } from '../../voice/participants'
import { moveToChannel, nudge } from '../../voice/voiceActions'
import { BellIcon, SpeakerIcon } from '../icons'
import { VolumeIcon, VolumeOffIcon } from './icons'
import './voice.css'

export interface UserVolumePopoverProps {
  userId: string
  /** Viewport coordinates to open near (e.g. the contextmenu event's clientX / clientY). */
  anchor: { x: number; y: number }
  onClose(): void
}

/** The general name of this card; UserVolumePopover is kept for existing callers. */
export { UserVolumePopover as VoiceUserCard }

const MARGIN = 8

export function UserVolumePopover({ userId, anchor, onClose }: UserVolumePopoverProps) {
  const ref = useRef<HTMLDivElement>(null)
  const closeRef = useRef(onClose)
  closeRef.current = onClose
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)
  const userName = useApp((s) => s.users[userId]?.name)
  const participantName = useParticipants((s) => s.list.find((p) => p.identity === userId)?.name)
  const name = userName ?? participantName ?? 'User'
  const { volume, muted } = useUserVolume(userId)
  const pct = Math.round(volume * 100)
  const isSelf = useApp((s) => s.me?.id === userId)
  const voiceState = useApp((s) => s.voice.find((v) => v.userId === userId))
  const canMove = useApp((s) => canMoveMember(s.me, s.users[userId]))
  const channels = useApp((s) => s.channels)
  /** 'nudge' or the channel id of a move in flight. */
  const [pending, setPending] = useState<string | null>(null)

  // Actions only exist while they're in voice (they disappear if they leave with the card open).
  const canNudge = !isSelf && !!voiceState && (voiceState.muted || voiceState.deafened)
  const moveTargets =
    voiceState && canMove ? channels.filter((c) => c.type === 'voice' && c.id !== voiceState.channelId) : []
  const hasActions = canNudge || moveTargets.length > 0
  // Your own card has no volume part: close it once there's nothing left to do.
  const empty = isSelf && !hasActions
  useEffect(() => {
    if (empty) closeRef.current()
  }, [empty])

  async function wakeUp() {
    setPending('nudge')
    const ok = await nudge(userId)
    setPending(null)
    if (ok) closeRef.current()
  }

  async function moveTo(channelId: string) {
    setPending(channelId)
    try {
      await moveToChannel(userId, channelId)
      closeRef.current()
    } catch (err) {
      toast(err, 'error')
      setPending(null)
    }
  }

  // Position next to the anchor, flipped / clamped so the card stays fully visible.
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const { width, height } = el.getBoundingClientRect()
    const vw = window.innerWidth
    const vh = window.innerHeight
    let left = anchor.x + 4
    let top = anchor.y + 4
    if (left + width > vw - MARGIN) left = anchor.x - width - 4
    if (top + height > vh - MARGIN) top = anchor.y - height - 4
    left = Math.max(MARGIN, Math.min(left, vw - width - MARGIN))
    top = Math.max(MARGIN, Math.min(top, vh - height - MARGIN))
    setPos({ left, top })
  }, [anchor.x, anchor.y])

  useEffect(() => {
    const onPointer = (e: PointerEvent) => {
      if (ref.current && e.target instanceof Node && ref.current.contains(e.target)) return
      closeRef.current()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      closeRef.current()
    }
    const onResize = () => closeRef.current()
    // Capture phase: also catches clicks on elements that stop propagation.
    document.addEventListener('pointerdown', onPointer, true)
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('resize', onResize)
    window.addEventListener('blur', onResize)
    return () => {
      document.removeEventListener('pointerdown', onPointer, true)
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('resize', onResize)
      window.removeEventListener('blur', onResize)
    }
  }, [])

  // Focus the slider so arrow keys work right away (your own card: the first action).
  useEffect(() => {
    ref.current?.querySelector<HTMLElement>('input[type="range"], button')?.focus({ preventScroll: true })
  }, [])

  return createPortal(
    <div
      ref={ref}
      className="vx-uv"
      role="dialog"
      aria-label={isSelf ? `Options for ${name}` : `Volume for ${name}`}
      style={pos ? { left: pos.left, top: pos.top } : { left: anchor.x, top: anchor.y, visibility: 'hidden' }}
      onContextMenu={(e) => e.preventDefault()}
    >
      <div className="vx-uv-head">
        <span className="vx-uv-name" title={name}>
          {name}
        </span>
        {!isSelf && <span className={`vx-uv-pct ${muted ? 'is-muted' : ''}`}>{muted ? 'Muted' : `${pct}%`}</span>}
      </div>
      {!isSelf && (
        <>
          <div className="vx-uv-row">
            <span className="vx-uv-icon" aria-hidden="true">
              {muted || volume === 0 ? <VolumeOffIcon size={16} /> : <VolumeIcon size={16} />}
            </span>
            <input
              type="range"
              className="vx-uv-slider"
              min={0}
              max={USER_VOLUME_MAX * 100}
              step={1}
              value={pct}
              disabled={muted}
              onChange={(e) => setUserVolume(userId, Number(e.target.value) / 100)}
              aria-label={`Volume for ${name}`}
              aria-valuetext={`${pct}%`}
              style={{ ['--fill' as string]: `${(pct / (USER_VOLUME_MAX * 100)) * 100}%` }}
            />
            <button
              className="vx-btn vx-btn-sm vx-uv-reset"
              onClick={() => setUserVolume(userId, 1)}
              disabled={pct === 100}
              title="Reset to 100%"
            >
              100%
            </button>
          </div>
          {volume > 1 && !muted && <p className="vx-uv-hint">Above 100% boosts their voice; it may distort.</p>}
          <label className="vx-uv-toggle">
            <input type="checkbox" checked={muted} onChange={(e) => setUserMuted(userId, e.target.checked)} />
            <span className="vx-uv-switch" aria-hidden="true" />
            <span>Mute for me</span>
          </label>
        </>
      )}
      {hasActions && (
        <div className="vx-uv-actions">
          {canNudge && (
            <button className="vx-uv-action" onClick={() => void wakeUp()} disabled={pending !== null}>
              <BellIcon size={15} />
              <span>{pending === 'nudge' ? 'Waking up…' : 'Wake up'}</span>
            </button>
          )}
          {moveTargets.length > 0 && (
            <>
              <span className="vx-uv-label" id={`vx-uv-move-${userId}`}>
                Move to
              </span>
              <ul className="vx-uv-channels" aria-labelledby={`vx-uv-move-${userId}`}>
                {moveTargets.map((c) => (
                  <li key={c.id}>
                    <button className="vx-uv-action" onClick={() => void moveTo(c.id)} disabled={pending !== null}>
                      <SpeakerIcon size={15} />
                      <span className="vx-uv-action-name">{c.name}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}
    </div>,
    document.body,
  )
}
