import { useApp } from '../store/app'
import { AlertIcon, NexoMark } from './icons'

/** Shown while the saved-token connection is being established, or when it keeps failing. */
export function Splash() {
  const connection = useApp((s) => s.connection)
  const error = useApp((s) => s.connectionError)
  const serverUrl = useApp((s) => s.serverUrl)
  const retry = useApp((s) => s.retry)
  const changeServer = useApp((s) => s.changeServer)

  if (connection === 'error') {
    return (
      <div className="splash">
        <div className="splash-card">
          <AlertIcon size={28} className="splash-icon" />
          <h1>Can't connect</h1>
          <p className="muted">{error ?? 'The connection failed.'}</p>
          {serverUrl && <code className="splash-url">{serverUrl}</code>}
          <p className="muted small">Still retrying in the background…</p>
          <div className="splash-actions">
            <button className="btn btn-primary" onClick={() => void retry()}>
              Retry now
            </button>
            <button className="btn btn-ghost" onClick={changeServer}>
              Change server
            </button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="splash">
      <div className="splash-card is-loading">
        <NexoMark size={48} tile />
        <p className="muted splash-status" role="status">
          <span className="spinner" aria-hidden="true" />
          Connecting{serverUrl ? ` to ${serverUrl.replace(/^https?:\/\//, '')}` : ''}…
        </p>
      </div>
    </div>
  )
}
