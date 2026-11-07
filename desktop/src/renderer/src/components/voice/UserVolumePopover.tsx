// Owner: workstream D. Floating per-user volume card ("lower a friend's volume"). Self-contained:
// render it anywhere (e.g. on right-click of a voice member row) with the click position as
// `anchor`; it portals to <body>, keeps itself inside the viewport and closes on outside click / Esc.
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useApp } from '@renderer/store/app'
import { setUserMuted, setUserVolume, useUserVolume } from '../../voice/session'
import { USER_VOLUME_MAX } from '../../voice/userVolumes'
import { useParticipants } from '../../voice/participants'
import { VolumeIcon, VolumeOffIcon } from './icons'
import './voice.css'

export interface UserVolumePopoverProps {
  userId: string
  /** Viewport coordinates to open near (e.g. the contextmenu event's clientX / clientY). */
  anchor: { x: number; y: number }
  onClose(): void
}

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

  // Focus the slider so arrow keys work right away.
  useEffect(() => {
    ref.current?.querySelector<HTMLInputElement>('input[type="range"]')?.focus({ preventScroll: true })
  }, [])

  return createPortal(
    <div
      ref={ref}
      className="vx-uv"
      role="dialog"
      aria-label={`Volume for ${name}`}
      style={pos ? { left: pos.left, top: pos.top } : { left: anchor.x, top: anchor.y, visibility: 'hidden' }}
      onContextMenu={(e) => e.preventDefault()}
    >
      <div className="vx-uv-head">
        <span className="vx-uv-name" title={name}>
          {name}
        </span>
        <span className={`vx-uv-pct ${muted ? 'is-muted' : ''}`}>{muted ? 'Muted' : `${pct}%`}</span>
      </div>
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
    </div>,
    document.body,
  )
}
