// Approver side of sign-in requests (docs/SPEC-ACCOUNTS.md §4): one bar per pending request above the
// channel view, stacked oldest first. Admins and the owner see every request; anyone sees requests for
// their own account (answered from a device that's already signed in).
import { useState } from 'react'
import type { AccessRequest } from '@shared/protocol'
import { useApp } from '../store/app'
import { respondToAccessRequest, useAdmin } from '../store/admin'
import { canAnswerAccessRequest } from '../lib/permissions'
import { errorMessage } from '../lib/toast'
import { formatFull } from '../lib/time'
import { KeyIcon } from './icons'

export function AccessRequestBanners() {
  const me = useApp((s) => s.me)
  const requests = useAdmin((s) => s.accessRequests)
  // Re-checked on every role change: a demoted admin stops seeing other people's requests.
  const visible = requests.filter((r) => canAnswerAccessRequest(me, r))
  if (!me || visible.length === 0) return null
  return (
    <div className="access-requests" role="region" aria-label="Sign-in requests">
      {visible.map((r) => (
        <AccessRequestBar key={r.id} request={r} mine={r.userId === me.id} />
      ))}
    </div>
  )
}

function AccessRequestBar({ request, mine }: { request: AccessRequest; mine: boolean }) {
  const name = useApp((s) => s.users[request.userId]?.name)
  const [busy, setBusy] = useState<'approve' | 'deny' | null>(null)
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

  const where = request.address ? ` (${request.address})` : ''
  return (
    <div className="access-request" role="status" title={`Requested ${formatFull(request.createdAt)}`}>
      <KeyIcon size={16} className="access-request-icon" />
      <span className="access-request-text">
        {mine ? (
          <>Someone wants to sign in to your account on a new device{where}</>
        ) : (
          <>
            <strong>{name ?? 'Someone'}</strong> wants to sign in on a new device{where}
          </>
        )}
        {error && <span className="access-request-error"> — {error}</span>}
      </span>
      <span className="access-request-actions">
        <button className="btn btn-primary btn-xs" onClick={() => void answer(true)} disabled={!!busy}>
          {busy === 'approve' ? 'Approving…' : 'Approve'}
        </button>
        <button className="btn btn-ghost btn-xs" onClick={() => void answer(false)} disabled={!!busy}>
          {busy === 'deny' ? 'Denying…' : 'Deny'}
        </button>
      </span>
    </div>
  )
}
