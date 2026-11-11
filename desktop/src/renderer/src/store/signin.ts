// Getting back into an existing account from onboarding (docs/SPEC-ACCOUNTS.md §1, §3, §4):
// - findLogin: the saved login for a server, asking GET /api/info when the server id isn't known yet
//   (that also yields the "Welcome back" accounts linked to this device).
// - claimAccount: "Welcome back" → Continue, i.e. connect with `{ claim: userId }`.
// - startAccessRequest: "This is my account" → a sign-in request an admin approves; polled until answered.
// - saveNewLogin: persist a token the server just issued, telling the user when that fails.
import { create } from 'zustand'
import type { User } from '@shared/protocol'
import { ACCESS_REQUEST_POLL_MS } from '@shared/protocol'
import {
  AccessRequestError,
  cancelAccessRequest,
  createAccessRequest,
  fetchServerInfo,
  pollAccessRequest,
  type CreatedAccessRequest,
} from '../net/accounts'
import { connect, disconnect } from '../net/socket'
import { toast } from '../lib/toast'
import { useApp } from './app'
import { knownServerId, readLogin, rememberServerId, saveLogin, type LoginRead } from './logins'

export const NOTICE_UNREADABLE =
  "Nexo couldn't read the login saved on this device for this server. If you already have an account there, " +
  "don't create a new one: pick it below, or enter your name and choose “This is my account”."
export const NOTICE_NOT_RECOGNIZED =
  "This device isn't linked to that account anymore. Enter your name and choose “This is my account” to ask an admin to let you in."
const NOTICE_DENIED = 'Your sign-in request was denied.'
const NOTICE_EXPIRED = 'Your sign-in request expired or was cancelled. You can send a new one.'

export interface PendingAccessRequest extends CreatedAccessRequest {
  serverUrl: string
  name: string
}

interface SignInState {
  /** Server URL whose `/api/info` last answered without a login being found (onboarding re-checks others). */
  probedUrl: string | null
  /** "Welcome back": accounts this device is linked to on `serverUrl`. */
  welcome: { serverUrl: string; accounts: User[] } | null
  /** A sign-in request waiting for an admin ("This is my account"). */
  request: PendingAccessRequest | null
}

export const useSignIn = create<SignInState>()(() => ({ probedUrl: null, welcome: null, request: null }))

let pollTimer: ReturnType<typeof setTimeout> | null = null

function stopPolling() {
  if (pollTimer) clearTimeout(pollTimer)
  pollTimer = null
}

/** Forget onboarding sign-in state (after a successful login, a logout or a server change). */
export function resetSignIn(): void {
  stopPolling()
  useSignIn.setState({ probedUrl: null, welcome: null, request: null })
}

/**
 * The saved login for `serverUrl`. Without one, asks `/api/info` (short timeout): a newly learned server id
 * may find a login saved under another address, and `recognized` accounts become the "Welcome back" offer.
 */
export async function findLogin(serverUrl: string): Promise<LoginRead> {
  const first = await readLogin(serverUrl)
  // Not marked as probed: if this login turns out to be unknown, onboarding asks /api/info again.
  if (first.token) return first
  let result = first
  const info = await fetchServerInfo(serverUrl)
  if (info) {
    const previousId = knownServerId(serverUrl)
    rememberServerId(serverUrl, info.serverId)
    if (info.serverId !== previousId) {
      const byId = await readLogin(serverUrl, info.serverId)
      if (byId.token) return byId
      result = { token: null, unreadable: first.unreadable || byId.unreadable }
    }
  }
  // Without an answer (offline, or an older server) the next onboarding submit asks again.
  const accounts = info?.recognized ?? []
  useSignIn.setState({
    probedUrl: info ? serverUrl : null,
    welcome: accounts.length ? { serverUrl, accounts } : null,
  })
  return result
}

/** Connect with a saved (or just approved) login; the splash takes over until the bootstrap. */
export function resumeLogin(serverUrl: string, token: string): void {
  useApp.setState({ view: 'main', serverUrl, onboardingNotice: null })
  connect(serverUrl, { token })
}

/** "Welcome back" → Continue. The bootstrap carries a new token (saved like a new account's). */
export function claimAccount(serverUrl: string, userId: string): void {
  useApp.setState({ onboardingNotice: null })
  connect(serverUrl, { claim: userId })
}

/** "Not me": back to the form; the next submit to the same server creates the account. */
export function dismissWelcome(): void {
  useSignIn.setState({ welcome: null })
}

/** The server refused a claim (handshake error NOT_RECOGNIZED). */
export function handleNotRecognized(): void {
  disconnect()
  useSignIn.setState({ welcome: null })
  useApp.setState({ view: 'onboarding', connection: 'idle', connectionError: null, onboardingNotice: NOTICE_NOT_RECOGNIZED })
}

/**
 * Persist a token the server just issued (new account, claim, approved request). Never fails silently: a
 * login that couldn't be saved anywhere is logged and shown, since closing the app would lose the account.
 */
export async function saveNewLogin(serverUrl: string, serverId: string | undefined, token: string): Promise<void> {
  try {
    await saveLogin(serverUrl, serverId, token)
  } catch (err) {
    console.error('[nexo] the new login could not be saved on this device', err)
    toast(
      "Nexo couldn't save your login on this device. You're signed in for now; if Nexo doesn't remember you " +
        'next time, use “This is my account” instead of making a new account.',
      'error',
      30_000,
    )
  }
}

// ---- sign-in requests ----

/** "This is my account": create the request and start polling. Throws AccessRequestError (shown as is). */
export async function startAccessRequest(serverUrl: string, name: string, password?: string): Promise<void> {
  stopPolling()
  const created = await createAccessRequest(serverUrl, name, password)
  useApp.setState({ onboardingNotice: null })
  useSignIn.setState({ request: { ...created, serverUrl, name } })
  schedulePoll()
}

/** Cancel the pending request (DELETE, best effort) and go back to the form. */
export async function cancelPendingRequest(): Promise<void> {
  const req = useSignIn.getState().request
  stopPolling()
  useSignIn.setState({ request: null })
  if (req) await cancelAccessRequest(req.serverUrl, req)
}

function schedulePoll() {
  stopPolling()
  pollTimer = setTimeout(() => void pollOnce(), ACCESS_REQUEST_POLL_MS)
}

function endRequest(notice: string) {
  stopPolling()
  useSignIn.setState({ request: null })
  useApp.setState({ onboardingNotice: notice })
}

async function pollOnce() {
  pollTimer = null
  const req = useSignIn.getState().request
  if (!req) return
  let res: Awaited<ReturnType<typeof pollAccessRequest>>
  try {
    res = await pollAccessRequest(req.serverUrl, req)
  } catch (err) {
    if (useSignIn.getState().request !== req) return
    // Network hiccup: keep trying until the request would have expired anyway.
    if (err instanceof AccessRequestError && err.status === 0 && Date.now() < req.expiresAt) return schedulePoll()
    console.warn('[nexo] sign-in request poll failed', err)
    return endRequest(err instanceof AccessRequestError && err.status !== 0 ? err.message : NOTICE_EXPIRED)
  }
  if (useSignIn.getState().request !== req) return // cancelled meanwhile
  switch (res.status) {
    case 'pending':
      return schedulePoll()
    case 'denied':
      return endRequest(NOTICE_DENIED)
    case 'gone':
      return endRequest(NOTICE_EXPIRED)
    case 'approved':
      stopPolling()
      useSignIn.setState({ request: null })
      await saveNewLogin(req.serverUrl, undefined, res.token)
      resumeLogin(req.serverUrl, res.token)
  }
}
