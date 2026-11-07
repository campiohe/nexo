// Slim bar above the channel view: update downloading / ready to install (Windows, AppImage) or
// available to download (macOS). Dismissing hides it until the next app start.
import type { ReactNode } from 'react'
import { useInCall, useUpdates } from '../lib/updates'
import { CloseIcon } from './icons'

export function UpdateBanner() {
  const state = useUpdates((s) => s.state)
  const dismissed = useUpdates((s) => s.bannerDismissed)
  const inCall = useInCall()
  if (!state || dismissed) return null

  const version = state.version ? `Nexo ${state.version}` : 'A new version of Nexo'
  let body: ReactNode

  if (state.status === 'ready' && state.canAutoInstall) {
    body = (
      <>
        <span className="update-banner-text">{version} is ready</span>
        <button
          className="btn btn-primary btn-xs"
          onClick={() => useUpdates.getState().install()}
          title={inCall ? 'Nexo restarts to install the update, which leaves the voice call' : undefined}
        >
          {inCall ? 'Restart (leaves the call)' : 'Restart to update'}
        </button>
      </>
    )
  } else if (state.status === 'available' && state.downloadUrl) {
    const url = state.downloadUrl
    body = (
      <>
        <span className="update-banner-text">{version} is available</span>
        <button className="btn btn-primary btn-xs" onClick={() => window.nexo.openExternal(url)}>
          Download
        </button>
      </>
    )
  } else if (state.status === 'downloading') {
    const percent = state.percent ?? 0
    body = (
      <>
        <span className="update-banner-text muted">
          Downloading {version}… {percent}%
        </span>
        <span
          className="update-progress"
          role="progressbar"
          aria-label="Update download"
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
        aria-label="Dismiss"
        title={state.status === 'ready' ? 'Dismiss (the update still installs when you quit Nexo)' : 'Dismiss'}
      >
        <CloseIcon size={14} />
      </button>
    </div>
  )
}
