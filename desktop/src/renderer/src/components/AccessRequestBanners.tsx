// Approver side of sign-in requests (docs/SPEC-ACCOUNTS.md §4): one bar per pending request above the
// channel view, stacked oldest first. Admins and the owner see every request; anyone sees requests for
// their own account (answered from a device that's already signed in).
import { useState, type ReactNode } from 'react'
import type { AccessRequest } from '@shared/protocol'
import { useApp } from '../store/app'
import { respondToAccessRequest, useAdmin } from '../store/admin'
import { canAnswerAccessRequest } from '../lib/permissions'
import { errorMessage } from '../lib/toast'
import { formatFull, useClock } from '../lib/time'
import { KeyIcon } from './icons'
import { useT } from '../i18n'

export function AccessRequestBanners() {
  const t = useT()
  const me = useApp((s) => s.me)
  const requests = useAdmin((s) => s.accessRequests)
  // Re-checked on every role change: a demoted admin stops seeing other people's requests.
  const visible = requests.filter((r) => canAnswerAccessRequest(me, r))
  if (!me || visible.length === 0) return null
  return (
    <div className="access-requests" role="region" aria-label={t('Sign-in requests')}>
      {visible.map((r) => (
        <AccessRequestBar key={r.id} request={r} mine={r.userId === me.id} />
      ))}
    </div>
  )
}

function AccessRequestBar({ request, mine }: { request: AccessRequest; mine: boolean }) {
  const t = useT()
  const name = useApp((s) => s.users[request.userId]?.name)
  const [busy, setBusy] = useState<'approve' | 'deny' | null>(null)
  const clock = useClock()
  const [error, setError] = useState<string | null>(null)

  const answer = async (approve: boolean) => {
    if (busy) return
    setBusy(approve ? 'approve' : 'deny')
    setError(null)
    try {
      await respondToAccessRequest(request.id, approve)
      // Unmounts on success (the request leaves the store).
    } catch (err) {
      setError(errorMessage(err))
      setBusy(null)
    }
  }

  const address = request.address
  const strong = (c: ReactNode) => <strong>{c}</strong>
  return (
    <div className="access-request" role="status" title={t('Requested {time}', { time: formatFull(request.createdAt, clock) })}>
      <KeyIcon size={16} className="access-request-icon" />
      <span className="access-request-text">
        {mine
          ? address
            ? t('Someone wants to sign in to your account on a new device ({address})', { address })
            : t('Someone wants to sign in to your account on a new device')
          : name
            ? address
              ? t.rich('<b>{name}</b> wants to sign in on a new device ({address})', { name, address, b: strong })
              : t.rich('<b>{name}</b> wants to sign in on a new device', { name, b: strong })
            : address
              ? t.rich('<b>Someone</b> wants to sign in on a new device ({address})', { address, b: strong })
              : t.rich('<b>Someone</b> wants to sign in on a new device', { b: strong })}
        {error && <span className="access-request-error"> — {error}</span>}
      </span>
      <span className="access-request-actions">
        <button className="btn btn-primary btn-xs" onClick={() => void answer(true)} disabled={!!busy}>
          {busy === 'approve' ? t('Approving…') : t('Approve')}
        </button>
        <button className="btn btn-ghost btn-xs" onClick={() => void answer(false)} disabled={!!busy}>
          {busy === 'deny' ? t('Denying…') : t('Deny')}
        </button>
      </span>
    </div>
  )
}
