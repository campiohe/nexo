// Global toast host. Render once (App). Trigger with `toast()` from lib/toast.
import { useToasts } from '../lib/toast'
import { AlertIcon, CheckIcon, CloseIcon } from './icons'

export { toast } from '../lib/toast'

export function Toasts() {
  const toasts = useToasts((s) => s.toasts)
  const dismiss = useToasts((s) => s.dismiss)
  return (
    <div className="toasts" role="region" aria-live="polite" aria-label="Notifications">
      {toasts.map((t) => (
        <div key={t.id} className={`toast toast-${t.kind}`} role={t.kind === 'error' ? 'alert' : 'status'}>
          <span className="toast-icon">
            {t.kind === 'error' ? <AlertIcon size={16} /> : t.kind === 'success' ? <CheckIcon size={16} /> : <span className="toast-dot" />}
          </span>
          <span className="toast-text">{t.message}</span>
          <button className="icon-btn toast-close" onClick={() => dismiss(t.id)} aria-label="Dismiss">
            <CloseIcon size={14} />
          </button>
        </div>
      ))}
    </div>
  )
}
