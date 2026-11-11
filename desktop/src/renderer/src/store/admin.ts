// Roles and sign-in requests, client side (docs/SPEC-ACCOUNTS.md §2 and the approver half of §4).
// Server events are fed in by net/socket.ts; the actions here are what the Members settings tab and the
// sign-in request banners call. Kept out of store/app.ts on purpose.
import { create } from 'zustand'
import type { AccessRequest, Message, User } from '@shared/protocol'
import { ACCESS_REQUEST_TTL_MS } from '@shared/protocol'
import { request } from '../net/socket'
import { playVoiceSound } from '../voice/sounds'
import { useApp, type AppState } from './app'
import { useUi } from './ui'
import { noteDeleted } from './unread'

interface AdminState {
  /** Pending sign-in requests this user may answer, oldest first. */
  accessRequests: AccessRequest[]
}

export const useAdmin = create<AdminState>()(() => ({ accessRequests: [] }))

/**
 * Safety net only: the server sends `access:resolved` when a request expires. Waits a little past
 * `expiresAt` (and never longer than the TTL), so a client clock that runs late can't hide a live request.
 */
const EXPIRY_GRACE_MS = 30_000
const expiryTimers = new Map<string, number>()

function scheduleExpiry(r: AccessRequest): void {
  window.clearTimeout(expiryTimers.get(r.id))
  const left = Math.min(Math.max(0, r.expiresAt - Date.now()), ACCESS_REQUEST_TTL_MS)
  expiryTimers.set(
    r.id,
    window.setTimeout(() => dropAccessRequest(r.id), left + EXPIRY_GRACE_MS),
  )
}

function clearExpiry(id: string): void {
  window.clearTimeout(expiryTimers.get(id))
  expiryTimers.delete(id)
}

/** Bootstrap: the server's full list replaces ours (older servers send none). */
export function setAccessRequests(list: AccessRequest[] | undefined): void {
  for (const id of expiryTimers.keys()) clearExpiry(id)
  const items = [...(list ?? [])].sort((a, b) => a.createdAt - b.createdAt)
  for (const r of items) scheduleExpiry(r)
  useAdmin.setState({ accessRequests: items })
}

/** `access:request`. A new request for an account replaces its older one, as on the server. */
export function addAccessRequest(r: AccessRequest): void {
  const cur = useAdmin.getState().accessRequests
  const isNew = !cur.some((x) => x.id === r.id)
  for (const x of cur) if (x.id !== r.id && x.userId === r.userId) clearExpiry(x.id)
  const rest = cur.filter((x) => x.id !== r.id && x.userId !== r.userId)
  scheduleExpiry(r)
  useAdmin.setState({ accessRequests: [...rest, r] })
  if (isNew) playVoiceSound('request')
}

/** `access:resolved` (approved, denied, cancelled or expired), or answered by us. */
export function dropAccessRequest(id: string): void {
  clearExpiry(id)
  useAdmin.setState((s) =>
    s.accessRequests.some((r) => r.id === id) ? { accessRequests: s.accessRequests.filter((r) => r.id !== id) } : {},
  )
}

/** Approve or deny. Rejects with the server's error; the banner shows it. */
export async function respondToAccessRequest(requestId: string, approve: boolean): Promise<void> {
  await request('access:respond', { requestId, approve })
  dropAccessRequest(requestId)
}

/** Owner only. The broadcast `user:upsert` follows; apply the ack's user right away anyway. */
export async function setUserRole(userId: string, role: 'admin' | 'member'): Promise<User> {
  const user = await request('user:setRole', { userId, role })
  useApp.setState((st) => ({ users: { ...st.users, [user.id]: user }, me: st.me?.id === user.id ? user : st.me }))
  return user
}

/** Delete an account with its messages. The broadcast `user:removed` follows; clean up right away anyway. */
export async function removeUser(userId: string): Promise<void> {
  await request('user:remove', { userId })
  applyUserRemoved(userId)
}

/**
 * `user:removed`: drop the user, their messages in loaded channels, their typing entries and pending
 * sign-in requests. Voice presence comes separately (`voice:states`). Idempotent.
 */
export function applyUserRemoved(userId: string): void {
  const st = useApp.getState()
  const meId = st.me?.id
  const patch: Partial<AppState> = {}

  if (userId in st.users && userId !== meId) {
    const users = { ...st.users }
    delete users[userId]
    patch.users = users
  }
  if (userId in st.online) {
    const online = { ...st.online }
    delete online[userId]
    patch.online = online
  }

  const unreadFixes: { channelId: string; newest: Message; remaining: Message[] }[] = []
  let messages: AppState['messages'] | null = null
  for (const [cid, cm] of Object.entries(st.messages)) {
    if (!cm.items.some((m) => m.userId === userId)) continue
    const remaining = cm.items.filter((m) => m.userId !== userId)
    let newest: Message | undefined
    for (const m of cm.items) if (m.userId === userId && (!newest || m.createdAt > newest.createdAt)) newest = m
    messages ??= { ...st.messages }
    messages[cid] = { ...cm, items: remaining }
    if (newest) unreadFixes.push({ channelId: cid, newest, remaining })
  }
  if (messages) patch.messages = messages

  let typing: AppState['typing'] | null = null
  for (const [cid, t] of Object.entries(st.typing)) {
    if (!(userId in t)) continue
    typing ??= { ...st.typing }
    const rest = { ...t }
    delete rest[userId]
    typing[cid] = rest
  }
  if (typing) patch.typing = typing

  if (Object.keys(patch).length) useApp.setState(patch)
  // A channel that was unread only because of their messages shouldn't stay unread.
  for (const f of unreadFixes) noteDeleted(f.channelId, f.newest, f.remaining, meId)

  for (const r of useAdmin.getState().accessRequests) if (r.userId === userId) dropAccessRequest(r.id)
  if (useUi.getState().volumePopover?.userId === userId) useUi.getState().closeVolumePopover()
}
