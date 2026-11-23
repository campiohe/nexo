import { useApp } from '../store/app'
import { AlertIcon, NexoMark } from './icons'
import { tKnown, useT } from '../i18n'

/** Shown while the saved-token connection is being established, or when it keeps failing. */
export function Splash() {
  const connection = useApp((s) => s.connection)
  const error = useApp((s) => s.connectionError)
  const serverUrl = useApp((s) => s.serverUrl)
  const retry = useApp((s) => s.retry)
  const changeServer = useApp((s) => s.changeServer)
  const t = useT()

  if (connection === 'error') {
    return (
      <div className="splash">
        <div className="splash-card">
          <AlertIcon size={28} className="splash-icon" />
          <h1>{t("Can't connect")}</h1>
          <p className="muted">{error ? tKnown(error) : t('The connection failed.')}</p>
          {serverUrl && <code className="splash-url">{serverUrl}</code>}
          <p className="muted small">{t('Still retrying in the background…')}</p>
          <div className="splash-actions">
            <button className="btn btn-primary" onClick={() => void retry()}>
              {t('Retry now')}
            </button>
            <button className="btn btn-ghost" onClick={changeServer}>
              {t('Change server')}
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
          {serverUrl ? t('Connecting to {server}…', { server: serverUrl.replace(/^https?:\/\//, '') }) : t('Connecting…')}
        </p>
      </div>
    </div>
  )
}
