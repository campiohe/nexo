// A floating card next to an element (profile card, status menu): portaled to <body>, placed on the
// preferred side of the anchor (flipped / clamped to stay in the viewport), closed on outside click,
// Escape, resize and window blur. Same behaviour as components/voice/UserVolumePopover.tsx. Over a Modal, Escape
// closes the card first (Modal.tsx skips it while one is open).
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import type { AnchorRect } from '../store/ui'

const MARGIN = 8
const GAP = 8

/** Cards open right now. */
let openCount = 0
/** A floating card is open (it takes Escape before a Modal under it). */
export const isFloatingOpen = (): boolean => openCount > 0

interface FloatingProps {
  anchor: AnchorRect
  /** top / bottom: left-aligned with the anchor, flipped to the other side when there's no room. */
  side: 'left' | 'right' | 'top' | 'bottom'
  onClose(): void
  className?: string
  label: string
  children: ReactNode
}

export function Floating({ anchor, side, onClose, className, label, children }: FloatingProps) {
  const ref = useRef<HTMLDivElement>(null)
  const closeRef = useRef(onClose)
  closeRef.current = onClose
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)

  // Re-placed whenever the content's size changes (e.g. the inline status menu opens inside the card).
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const place = () => {
      const { width, height } = el.getBoundingClientRect()
      const vw = window.innerWidth
      const vh = window.innerHeight
      let left: number
      let top: number
      if (side === 'top') {
        left = anchor.left
        top = anchor.top - height - GAP
        if (top < MARGIN) top = anchor.bottom + GAP
      } else if (side === 'bottom') {
        left = anchor.left
        top = anchor.bottom + GAP
        if (top + height > vh - MARGIN && anchor.top - height - GAP >= MARGIN) top = anchor.top - height - GAP
      } else {
        left = side === 'right' ? anchor.right + GAP : anchor.left - width - GAP
        if (side === 'right' && left + width > vw - MARGIN) left = anchor.left - width - GAP
        if (side === 'left' && left < MARGIN) left = anchor.right + GAP
        top = anchor.top
      }
      left = Math.max(MARGIN, Math.min(left, vw - width - MARGIN))
      top = Math.max(MARGIN, Math.min(top, vh - height - MARGIN))
      setPos((p) => (p && p.left === left && p.top === top ? p : { left, top }))
    }
    place()
    const ro = new ResizeObserver(place)
    ro.observe(el)
    return () => ro.disconnect()
  }, [anchor.left, anchor.top, anchor.right, anchor.bottom, side])

  useEffect(() => {
    openCount++
    const onPointer = (e: PointerEvent) => {
      if (ref.current && e.target instanceof Node && ref.current.contains(e.target)) return
      closeRef.current()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      // An input inside that handles Escape itself (e.g. cancel an edit) keeps it.
      if (e.target instanceof HTMLElement && e.target.closest('[data-own-escape]') && ref.current?.contains(e.target)) return
      e.stopPropagation()
      closeRef.current()
    }
    const onResize = () => closeRef.current()
    document.addEventListener('pointerdown', onPointer, true)
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('resize', onResize)
    window.addEventListener('blur', onResize)
    return () => {
      openCount--
      document.removeEventListener('pointerdown', onPointer, true)
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('resize', onResize)
      window.removeEventListener('blur', onResize)
    }
  }, [])

  return createPortal(
    <div
      ref={ref}
      className={`floating ${className ?? ''}`}
      role="dialog"
      aria-label={label}
      style={pos ? { left: pos.left, top: pos.top } : { left: anchor.left, top: anchor.top, visibility: 'hidden' }}
    >
      {children}
    </div>,
    document.body,
  )
}
