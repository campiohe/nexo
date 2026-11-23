// Onboarding steps for getting back into an existing account (docs/SPEC-ACCOUNTS.md §3, §4):
// "Welcome back" (accounts linked to this device) and the wait for an admin to approve a sign-in request.
import { useState } from 'react'
import type { User } from '@shared/protocol'
import { useApp } from '../store/app'
import { cancelPendingRequest, claimAccount, dismissWelcome, type PendingAccessRequest } from '../store/signin'
import { avatarUrl } from '../lib/avatar'
import { Avatar } from './Avatar'
import { AlertIcon, NexoMark } from './icons'
import { tKnown, useT } from '../i18n'

const host = (url: string) => url.replace(/^https?:\/\//, '')

function Notice() {
  useT() // re-render on a language change
  const notice = useApp((s) => s.onboardingNotice)
  if (!notice) return null
  return (
    <div className="callout callout-warn">
      <AlertIcon size={16} />
      <span>{tKnown(notice)}</span>
    </div>
  )
}

export function WelcomeBackStep({ serverUrl, accounts }: { serverUrl: string; accounts: User[] }) {
  const t = useT()
  const connection = useApp((s) => s.connection)
  const connectionError = useApp((s) => s.connectionError)
  const [claiming, setClaiming] = useState<string | null>(null)
  const busy = claiming !== null && connection === 'connecting'
  const error = claiming !== null && connection === 'error' && connectionError ? tKnown(connectionError) : null

  function proceed(user: User) {
    setClaiming(user.id)
    claimAccount(serverUrl, user.id)
  }

  return (
    <div className="onboarding-card">
      <div className="onboarding-brand">
        <NexoMark size={36} tile />
        <h1>{t('Welcome back')}</h1>
        <p className="muted">
          {accounts.length > 1
            ? t('This device is linked to these accounts on {server}.', { server: host(serverUrl) })
            : t('This device is linked to this account on {server}.', { server: host(serverUrl) })}
        </p>
      </div>

      <Notice />

      <ul className="welcome-accounts">
        {accounts.map((user) => (
          <li key={user.id} className="welcome-account">
            <Avatar user={user} src={avatarUrl(serverUrl, user)} size={40} />
            <span className="welcome-name" style={{ color: user.color }}>
              {user.name}
            </span>
            <button className="btn btn-primary btn-sm" type="button" disabled={busy} onClick={() => proceed(user)}>
              {busy && claiming === user.id ? (
                <>
                  <span className="spinner" /> {t('Signing in…')}
                </>
              ) : (
                t('Continue')
              )}
            </button>
          </li>
        ))}
      </ul>

      {error && (
        <div className="callout callout-error" role="alert">
          <AlertIcon size={16} />
          <span>{error}</span>
        </div>
      )}

      <button type="button" className="link-btn" onClick={dismissWelcome} disabled={busy}>
        {t('Not you? Create a new account')}
      </button>
    </div>
  )
}

export function AccessRequestStep({ request }: { request: PendingAccessRequest }) {
  const t = useT()
  const [cancelling, setCancelling] = useState(false)
  const minutes = Math.max(1, Math.round((request.expiresAt - Date.now()) / 60_000))

  function cancel() {
    setCancelling(true)
    void cancelPendingRequest()
  }

  return (
    <div className="onboarding-card">
      <div className="onboarding-brand">
        <NexoMark size={36} tile />
        <h1>{t('Sign-in request sent')}</h1>
        <p className="muted">{host(request.serverUrl)}</p>
      </div>

      <div className="signin-wait" role="status">
        <span className="spinner" />
        <span>{t('Waiting for an admin to approve…')}</span>
      </div>

      <p className="muted signin-help">
        {t.rich(
          "Ask an admin to approve <b>{name}</b>, or approve it yourself from a device where you're signed in. It expires in about {minutes, plural, one {# minute} other {# minutes}}.",
          { name: request.name, minutes, b: (c) => <strong>{c}</strong> },
        )}
      </p>

      <button className="btn btn-ghost signin-cancel" type="button" onClick={cancel} disabled={cancelling}>
        {t('Cancel request')}
      </button>
    </div>
  )
}
