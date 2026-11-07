import { useEffect, useRef, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { CloseIcon } from './icons'

interface ModalProps {
  title: string
  onClose(): void
  children: ReactNode
  footer?: ReactNode
  width?: number
  className?: string
}

/** Accessible modal: Esc / backdrop click closes, focus moves inside and is restored on close. */
export function Modal({ title, onClose, children, footer, width = 440, className }: ModalProps) {
  const panelRef = useRef<HTMLDivElement>(null)
  const closeRef = useRef(onClose)
  closeRef.current = onClose

  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null
    const panel = panelRef.current
    const first = panel?.querySelector<HTMLElement>('[data-autofocus], input, textarea, select, button:not(.modal-close)')
    ;(first ?? panel)?.focus()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        closeRef.current()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('keydown', onKey, true)
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
          <button className="icon-btn modal-close" onClick={onClose} aria-label="Close" title="Close (Esc)">
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

export function ConfirmDialog({ title, message, confirmLabel = 'Confirm', danger, onConfirm, onClose }: ConfirmProps) {
  const busy = useRef(false)
  return (
    <Modal
      title={title}
      onClose={onClose}
      width={400}
      footer={
        <>
          <button className="btn btn-ghost" onClick={onClose}>
            Cancel
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
            {confirmLabel}
          </button>
        </>
      }
    >
      <div className="confirm-message">{message}</div>
    </Modal>
  )
}
