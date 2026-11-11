// Settings → Members (docs/SPEC-ACCOUNTS.md §2): every account with its role. The owner sets admin/member;
// admins remove members and the owner removes anyone but themselves. The server enforces all of it and
// its ack errors are shown next to the row (or in the confirmation).
import { useState } from 'react'
import type { Role, User } from '@shared/protocol'
import { useApp } from '../store/app'
import { removeUser, setUserRole } from '../store/admin'
import { canRemove, canSetRole, hasRoles, roleOf, ROLE_LABEL } from '../lib/permissions'
import { errorMessage, toast } from '../lib/toast'
import { Avatar } from './Avatar'
import { ConfirmDialog } from './Modal'
import { AlertIcon } from './icons'

const ROLE_RANK: Record<Role, number> = { owner: 0, admin: 1, member: 2 }
const SETTABLE: ('admin' | 'member')[] = ['admin', 'member']

export function RoleBadge({ role }: { role: Role }) {
  return <span className={`role-badge is-${role}`}>{ROLE_LABEL[role]}</span>
}

function intro(me: User): string {
  switch (roleOf(me)) {
    case 'owner':
      return "You're the owner. You can make people admins and remove accounts."
    case 'admin':
      return "You're an admin. You can remove members' accounts. Only the owner can change roles or remove admins."
    default:
      return 'Admins manage channels and accounts. Ask one if you need something changed.'
  }
}

export function MembersSection() {
  const me = useApp((s) => s.me)
  const users = useApp((s) => s.users)
  const online = useApp((s) => s.online)
  const [pendingRole, setPendingRole] = useState<string | null>(null)
  const [rowError, setRowError] = useState<{ userId: string; text: string } | null>(null)
  const [removing, setRemoving] = useState<User | null>(null)
  const [removeError, setRemoveError] = useState<string | null>(null)
  if (!me) return null

  const roles = hasRoles(me)
  const list = Object.values(users).sort(
    (a, b) =>
      (roles ? ROLE_RANK[roleOf(a)] - ROLE_RANK[roleOf(b)] : 0) ||
      a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }),
  )
  // Close the confirmation if the account is already gone or we lost the right to remove it.
  const removeTarget = removing && users[removing.id] && canRemove(me, users[removing.id]) ? users[removing.id] : null

  const changeRole = async (u: User, role: 'admin' | 'member') => {
    if (pendingRole || roleOf(u) === role) return
    setPendingRole(u.id)
    setRowError(null)
    try {
      await setUserRole(u.id, role)
    } catch (err) {
      setRowError({ userId: u.id, text: errorMessage(err) })
    } finally {
      setPendingRole(null)
    }
  }

  const confirmRemove = async (u: User) => {
    setRemoveError(null)
    try {
      await removeUser(u.id)
      setRemoving(null)
      toast(`Removed ${u.name}`, 'success')
    } catch (err) {
      setRemoveError(errorMessage(err))
    }
  }

  return (
    <section>
      <h3 className="settings-heading">Members</h3>
      {roles ? (
        <p className="muted small members-intro">{intro(me)}</p>
      ) : (
        <div className="callout callout-warn">
          <AlertIcon size={16} />
          <span>This server doesn't have roles yet, so everyone can manage channels. Update the server to manage members here.</span>
        </div>
      )}
      <ul className="members-admin" aria-label="Members">
        {list.map((u) => {
          const role = roleOf(u)
          const settable = roles && canSetRole(me, u)
          const removable = roles && canRemove(me, u)
          return (
            <li key={u.id} className="members-admin-item">
              <div className="members-admin-row">
                <Avatar user={u} size={36} online={!!online[u.id]} />
                <div className="members-admin-text">
                  <span className="members-admin-name" style={{ color: u.color }}>
                    {u.name}
                    {u.id === me.id && <span className="member-you"> (you)</span>}
                  </span>
                  {roles && (
                    <span>
                      <RoleBadge role={role} />
                    </span>
                  )}
                </div>
                {settable && (
                  <div className="vx-seg members-role-seg" role="radiogroup" aria-label={`Role of ${u.name}`}>
                    {SETTABLE.map((r) => (
                      <button
                        key={r}
                        type="button"
                        role="radio"
                        aria-checked={role === r}
                        className={`vx-seg-btn ${role === r ? 'is-active' : ''}`}
                        disabled={!!pendingRole}
                        onClick={() => void changeRole(u, r)}
                      >
                        {ROLE_LABEL[r]}
                      </button>
                    ))}
                  </div>
                )}
                {removable && (
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm members-remove"
                    onClick={() => {
                      setRemoveError(null)
                      setRemoving(u)
                    }}
                  >
                    Remove
                  </button>
                )}
              </div>
              {rowError?.userId === u.id && (
                <p className="members-error" role="alert">
                  {rowError.text}
                </p>
              )}
            </li>
          )
        })}
      </ul>

      {removeTarget && (
        <ConfirmDialog
          title={`Remove ${removeTarget.name}?`}
          danger
          confirmLabel="Remove account"
          message={
            <div className="members-confirm">
              <span>
                This deletes <strong>{removeTarget.name}</strong>'s account and <strong>all of their messages</strong>{' '}
                and images, for everyone. Their devices are signed out right away.
              </span>
              <span>
                The name <strong>{removeTarget.name}</strong> becomes free, so anyone can join with it. This can't be undone.
              </span>
              {removeError && (
                <div className="callout callout-error" role="alert">
                  <AlertIcon size={16} />
                  <span>{removeError}</span>
                </div>
              )}
            </div>
          }
          onClose={() => setRemoving(null)}
          onConfirm={() => confirmRemove(removeTarget)}
        />
      )}
    </section>
  )
}
