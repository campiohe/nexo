// Slim bar above the channel view: update downloading / ready to install (Windows, AppImage) or
// available to download (macOS). Dismissing hides it until the next app start.
import type { ReactNode } from 'react'
import { useInCall, useUpdates } from '../lib/updates'
import { CloseIcon } from './icons'
import { useT } from '../i18n'

export function UpdateBanner() {
  const state = useUpdates((s) => s.state)
  const dismissed = useUpdates((s) => s.bannerDismissed)
  const inCall = useInCall()
  const t = useT()
  if (!state || dismissed) return null

  const version = state.version
  let body: ReactNode

  if (state.status === 'ready' && state.canAutoInstall) {
    body = (
      <>
        <span className="update-banner-text">
          {version ? t('Nexo {version} is ready', { version }) : t('A new version of Nexo is ready')}
        </span>
        <button
          className="btn btn-primary btn-xs"
          onClick={() => useUpdates.getState().install()}
          title={inCall ? t('Nexo restarts to install the update, which leaves the voice call') : undefined}
        >
          {inCall ? t('Restart (leaves the call)') : t('Restart to update')}
        </button>
      </>
    )
  } else if (state.status === 'available' && state.downloadUrl) {
    const url = state.downloadUrl
    body = (
      <>
        <span className="update-banner-text">
          {version ? t('Nexo {version} is available', { version }) : t('A new version of Nexo is available')}
        </span>
        <button className="btn btn-primary btn-xs" onClick={() => window.nexo.openExternal(url)}>
          {t('Download')}
        </button>
      </>
    )
  } else if (state.status === 'downloading') {
    const percent = state.percent ?? 0
    body = (
      <>
        <span className="update-banner-text muted">
          {version
            ? t('Downloading Nexo {version}… {percent}%', { version, percent })
            : t('Downloading a new version of Nexo… {percent}%', { percent })}
        </span>
        <span
          className="update-progress"
          role="progressbar"
          aria-label={t('Update download')}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent}
        >
          <span style={{ width: `${percent}%` }} />
        </span>
      </>
    )
  } else {
    return null
  }

  return (
    <div className={`update-banner ${state.status === 'downloading' ? 'is-subtle' : ''}`} role="status">
      {body}
      <button
        className="icon-btn update-banner-close"
        onClick={() => useUpdates.getState().dismissBanner()}
        aria-label={t('Dismiss')}
        title={state.status === 'ready' ? t('Dismiss (the update still installs when you quit Nexo)') : t('Dismiss')}
      >
        <CloseIcon size={14} />
      </button>
    </div>
  )
}
