import { useEffect, useRef, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { CloseIcon } from './icons'
import { isFloatingOpen } from './Floating'
import { useT } from '../i18n'

interface ModalProps {
  title: string
  onClose(): void
  children: ReactNode
  footer?: ReactNode
  width?: number
  className?: string
}

/** Open modals, innermost last: Esc only closes the top one (e.g. a crop dialog over Settings). */
const openModals: object[] = []

/**
 * How the user last interacted: a modal opened with the mouse shouldn't land focus (and its ring) on a button.
 * Chromium shows :focus-visible for script focus after a mouse click on another control, so CSS alone can't tell.
 */
let lastInput: 'keyboard' | 'pointer' = 'keyboard'
if (typeof window !== 'undefined') {
  window.addEventListener('pointerdown', () => (lastInput = 'pointer'), true)
  window.addEventListener('keydown', () => (lastInput = 'keyboard'), true)
}

/** Fields that take typing: focusing them on open is useful even after a click (no ring, just the caret). */
const isTextEntry = (el: HTMLElement) =>
  el instanceof HTMLTextAreaElement ||
  el instanceof HTMLSelectElement ||
  (el instanceof HTMLInputElement && !['checkbox', 'radio', 'range', 'button', 'submit', 'reset', 'file', 'color'].includes(el.type))

/** Accessible modal: Esc / backdrop click closes, focus moves inside and is restored on close. */
export function Modal({ title, onClose, children, footer, width = 440, className }: ModalProps) {
  const panelRef = useRef<HTMLDivElement>(null)
  const closeRef = useRef(onClose)
  closeRef.current = onClose
  const t = useT()

  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null
    const panel = panelRef.current
    const first = panel?.querySelector<HTMLElement>('[data-autofocus], input, textarea, select, button:not(.modal-close)')
    // Opened with the mouse: a plain button (e.g. Settings' first tab) stays unfocused; the dialog itself takes
    // focus, so Esc works and Tab moves into it. data-autofocus (a confirm button, for Enter) always wins.
    const keepOnPanel = first && lastInput === 'pointer' && !first.hasAttribute('data-autofocus') && !isTextEntry(first)
    ;(first && !keepOnPanel ? first : panel)?.focus()
    const self = {}
    openModals.push(self)
    const onKey = (e: KeyboardEvent) => {
      // A floating card over the modal (e.g. a color picker) closes first: Floating.tsx handles that Escape.
      if (e.key === 'Escape' && openModals[openModals.length - 1] === self && !isFloatingOpen()) {
        e.stopPropagation()
        closeRef.current()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('keydown', onKey, true)
      openModals.splice(openModals.indexOf(self), 1)
      prev?.focus?.()
    }
  }, [])

  return createPortal(
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        ref={panelRef}
        className={`modal ${className ?? ''}`}
        style={{ width }}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
      >
        <header className="modal-header">
          <h2>{title}</h2>
          <button className="icon-btn modal-close" onClick={onClose} aria-label={t('Close')} title={t('Close (Esc)')}>
            <CloseIcon size={18} />
          </button>
        </header>
        <div className="modal-body">{children}</div>
        {footer && <footer className="modal-footer">{footer}</footer>}
      </div>
    </div>,
    document.body,
  )
}

interface ConfirmProps {
  title: string
  message: ReactNode
  confirmLabel?: string
  danger?: boolean
  onConfirm(): void | Promise<void>
  onClose(): void
}

export function ConfirmDialog({ title, message, confirmLabel, danger, onConfirm, onClose }: ConfirmProps) {
  const busy = useRef(false)
  const t = useT()
  return (
    <Modal
      title={title}
      onClose={onClose}
      width={400}
      footer={
        <>
          <button className="btn btn-ghost" onClick={onClose}>
            {t('Cancel')}
          </button>
          <button
            className={`btn ${danger ? 'btn-danger' : 'btn-primary'}`}
            data-autofocus
            onClick={async () => {
              if (busy.current) return
              busy.current = true
              try {
                await onConfirm()
              } finally {
                busy.current = false
              }
            }}
          >
            {confirmLabel ?? t('Confirm')}
          </button>
        </>
      }
    >
      <div className="confirm-message">{message}</div>
    </Modal>
  )
}
