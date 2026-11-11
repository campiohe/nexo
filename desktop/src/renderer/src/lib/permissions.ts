// Who may do what (docs/SPEC-ACCOUNTS.md §2). The server enforces every rule; these only gate the UI.
// A missing `role` means the server predates roles and checks no permissions, so it counts as 'admin'.
import type { AccessRequest, Message, Role, User } from '@shared/protocol'

type WithRole = Pick<User, 'role'> | null | undefined
type Me = Pick<User, 'id' | 'role'> | null | undefined

export function roleOf(u: WithRole): Role {
  return u?.role ?? 'admin'
}

/** False on servers older than roles: they don't send `role`, so there are no roles to show or manage. */
export function hasRoles(me: WithRole): boolean {
  return !!me && me.role !== undefined
}

/** owner or admin. */
export function isStaff(u: WithRole): boolean {
  return roleOf(u) !== 'member'
}

export const ROLE_LABEL: Record<Role, string> = { owner: 'Owner', admin: 'Admin', member: 'Member' }

/** Create, rename and delete channels. */
export function canManageChannels(me: Me): boolean {
  return !!me && isStaff(me)
}

/** Own messages always; anyone's for admins and the owner. */
export function canDeleteMessage(me: Me, msg: Pick<Message, 'userId'>): boolean {
  return !!me && (msg.userId === me.id || isStaff(me))
}

/** Admins remove members; only the owner removes admins; nobody removes the owner or themselves. */
export function canRemove(me: Me, target: Pick<User, 'id' | 'role'> | null | undefined): boolean {
  if (!me || !target || target.id === me.id) return false
  const mine = roleOf(me)
  const theirs = roleOf(target)
  if (theirs === 'owner') return false
  if (mine === 'owner') return true
  return mine === 'admin' && theirs === 'member'
}

/** Only the owner sets roles; `target` (when given) can't be the owner, which includes the owner themselves. */
export function canSetRole(me: Me, target?: Pick<User, 'id' | 'role'> | null): boolean {
  if (!me || roleOf(me) !== 'owner') return false
  if (target === undefined) return true
  return !!target && target.id !== me.id && roleOf(target) !== 'owner'
}

/** Admins and the owner answer every request; anyone answers requests for their own account. */
export function canAnswerAccessRequest(me: Me, req: Pick<AccessRequest, 'userId'>): boolean {
  return !!me && (req.userId === me.id || isStaff(me))
}
