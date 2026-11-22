// CONTRACT (owner: workstream C — renderer core & chat). Socket.io client + wiring of server events into the app store.
import { io, type Socket } from 'socket.io-client'
import type {
  AckResult,
  Bootstrap,
  ClientToServerEvents,
  HandshakeAuth,
  Message,
  ServerToClientEvents,
} from '@shared/protocol'
import { MESSAGE_PAGE_SIZE, REPLY_PREVIEW_LENGTH } from '@shared/protocol'
import {
  defaultChannelId,
  forgetDeletedMessage,
  mapMessage,
  mergeMessages,
  sortChannels,
  useApp,
  type ChannelMessages,
} from '../store/app'
import { settings } from '../store/settings'
import { migrateLogin } from '../store/logins'
import { handleNotRecognized, resetSignIn, saveNewLogin } from '../store/signin'
import { forgetChannel, loadReadState, noteDeleted, noteMessage, resetUnread } from '../store/unread'
import { addAccessRequest, applyUserRemoved, dropAccessRequest, setAccessRequests } from '../store/admin'
import { notifyMessage } from '../lib/notify'
import { applyPresenceChanged, pruneOffline, setBootstrapPresence } from '../store/presence'
import { removeSound, resetSounds, setBootstrapSounds, upsertSound } from '../store/sounds'
import { chatPanelsMessageDeleted, chatPanelsMessageUpdated, resetChatPanels } from '../store/chatPanels'
import { applyPlugins, resetPlugins, setBootstrapPlugins } from '../store/plugins'
import { applyMusicState, forgetMusicChannel, resetMusic, setBootstrapMusic } from '../store/music'
import { applyGameLobby, forgetGameChannel, resetGames, setBootstrapGames } from '../store/games'
import { handleGameFrame } from '../games/frames'
import { applyEmuSession, forgetEmulatorChannel, handleEmuInput, resetEmulator, setBootstrapEmulator } from '../store/emulator'

export type NexoSocket = Socket<ServerToClientEvents, ClientToServerEvents>

/** Client→server events that take an ack callback (request/response). */
export type RequestEvent = {
  [K in keyof ClientToServerEvents]: Parameters<ClientToServerEvents[K]> extends [unknown, (res: AckResult<any>) => void]
    ? K
    : never
}[keyof ClientToServerEvents]

export type RequestPayload<K extends RequestEvent> = Parameters<ClientToServerEvents[K]>[0]
export type RequestData<K extends RequestEvent> =
  Parameters<ClientToServerEvents[K]>[1] extends (res: AckResult<infer D>) => void ? D : never

/** Fire-and-forget events. */
export type EmitEvent = Exclude<keyof ClientToServerEvents, RequestEvent>

export const REQUEST_TIMEOUT_MS = 10_000
/** How long a `typing` event keeps someone in the typing line. */
export const TYPING_TTL_MS = 3_500
/** Failed attempts (with a saved token, never connected yet) before the splash shows an error. */
const FAILURES_BEFORE_ERROR = 3

let socket: NexoSocket | null = null
let currentUrl = ''
let currentAuth: HandshakeAuth | null = null
/** True once this connection has received at least one bootstrap. */
let bootstrapped = false
let failures = 0
const connectedListeners = new Set<() => void>()

/** Open (or re-open) the connection. Server events are wired into the app store by this module. */
export function connect(serverUrl: string, auth: HandshakeAuth): void {
  disconnect()
  currentUrl = serverUrl
  currentAuth = auth
  bootstrapped = false
  failures = 0
  useApp.setState({ serverUrl, connection: 'connecting', connectionError: null })

  const s: NexoSocket = io(serverUrl, {
    transports: ['websocket'],
    reconnection: true,
    reconnectionDelay: 800,
    reconnectionDelayMax: 5000,
    timeout: 8000,
    // Function form so a freshly issued token is used on every later reconnect.
    auth: (cb) => cb((currentAuth ?? {}) as Record<string, unknown>),
  })
  socket = s
  wire(s)
}

export function disconnect(): void {
  const s = socket
  socket = null
  if (s) {
    s.removeAllListeners()
    s.io.removeAllListeners()
    s.disconnect()
  }
  bootstrapped = false
  if (useApp.getState().connection !== 'idle') useApp.setState({ connection: 'idle', connectionError: null })
}

/** Emit with ack; resolves with `data` or rejects with Error(error). Times out after 10 s. */
export function request<K extends RequestEvent>(event: K, payload: RequestPayload<K>): Promise<RequestData<K>> {
  return new Promise((resolve, reject) => {
    const s = socket
    if (!s || !s.connected) {
      reject(new Error('Not connected to the server'))
      return
    }
    // The typed overloads don't compose well with a generic event name; the public signature stays typed.
    const untyped = s.timeout(REQUEST_TIMEOUT_MS) as unknown as {
      emit(ev: string, p: unknown, cb: (err: Error | null, res?: AckResult<RequestData<K>>) => void): void
    }
    untyped.emit(event, payload, (err, res) => {
      if (err) return reject(new Error('The server took too long to respond'))
      if (!res || typeof res !== 'object') return reject(new Error('Invalid response from the server'))
      if (res.ok) resolve(res.data)
      else reject(new Error(res.error || 'Request failed'))
    })
  })
}

export function emit<K extends EmitEvent>(event: K, payload: Parameters<ClientToServerEvents[K]>[0]): void {
  const s = socket
  // Drop when offline instead of buffering: these are ephemeral (typing) or re-sent on connect (voice:state).
  if (!s || !s.connected) return
  ;(s.emit as (ev: string, p: unknown) => void)(event, payload)
}

/** Called after every successful (re)connect + bootstrap. Returns an unsubscribe fn. */
export function onConnected(cb: () => void): () => void {
  connectedListeners.add(cb)
  return () => {
    connectedListeners.delete(cb)
  }
}

/** True when the socket is connected and bootstrapped. */
export function isConnected(): boolean {
  return !!socket?.connected && bootstrapped
}

// ---------------------------------------------------------------------------------------------

function readableError(raw: string): string {
  const msg = raw || 'Connection failed'
  if (/websocket error|xhr poll error|timeout|transport/i.test(msg))
    return `Can't reach the server at ${currentUrl}. Check the address and that the server is running.`
  if (/^UNKNOWN_TOKEN$/.test(msg)) return "This server doesn't recognize this device anymore."
  if (/^NOT_RECOGNIZED$/.test(msg)) return "This device isn't linked to that account anymore."
  return msg
}

function wire(s: NexoSocket) {
  s.on('connect_error', (err) => {
    if (socket !== s) return
    const message = err?.message ?? ''

    if (!s.active) {
      // Rejected by the server's handshake middleware (no automatic retry).
      if (message === 'UNKNOWN_TOKEN') return void handleUnknownToken()
      if (message === 'NOT_RECOGNIZED') return handleNotRecognized()
      useApp.setState({ connection: 'error', connectionError: readableError(message) })
      return
    }

    // Transport-level failure; socket.io keeps retrying.
    failures++
    const isNewIdentity = !!currentAuth && !('token' in currentAuth)
    if (isNewIdentity && !bootstrapped) {
      // Onboarding: don't keep silently retrying to create an account in the background.
      s.disconnect()
      useApp.setState({ connection: 'error', connectionError: readableError(message) })
      return
    }
    if (bootstrapped) {
      useApp.setState({ connection: 'reconnecting', connectionError: readableError(message) })
    } else {
      useApp.setState({
        connection: failures >= FAILURES_BEFORE_ERROR ? 'error' : 'connecting',
        connectionError: readableError(message),
      })
    }
  })

  s.on('disconnect', (reason) => {
    if (socket !== s) return
    if (reason === 'io client disconnect') return
    useApp.setState({ connection: bootstrapped ? 'reconnecting' : 'connecting', connectionError: null })
    // A server-initiated disconnect is not retried automatically.
    if (reason === 'io server disconnect') s.connect()
  })

  s.on('bootstrap', (b) => {
    if (socket !== s) return
    void handleBootstrap(b)
  })

  s.on('user:upsert', (u) => {
    useApp.setState((st) => ({ users: { ...st.users, [u.id]: u }, me: st.me?.id === u.id ? u : st.me }))
  })

  s.on('presence', (ids) => {
    useApp.setState({ online: toSet(ids) })
    pruneOffline(ids)
  })

  s.on('presence:changed', ({ userId, presence }) => {
    if (socket !== s || !presence || typeof presence !== 'object') return
    applyPresenceChanged(userId, presence)
  })

  s.on('channel:upsert', (c) => {
    useApp.setState((st) => ({ channels: sortChannels([...st.channels.filter((x) => x.id !== c.id), c]) }))
  })

  s.on('channel:deleted', ({ channelId }) => {
    const st = useApp.getState()
    const channels = st.channels.filter((c) => c.id !== channelId)
    const messages = { ...st.messages }
    delete messages[channelId]
    const typing = { ...st.typing }
    delete typing[channelId]
    useApp.setState({ channels, messages, typing })
    forgetChannel(channelId)
    forgetMusicChannel(channelId)
    forgetGameChannel(channelId)
    forgetEmulatorChannel(channelId)
    if (st.selectedChannelId === channelId) useApp.getState().selectChannel(defaultChannelId(channels, null))
    void import('../voice/session')
      .then(({ useVoice }) => {
        if (useVoice.getState().channelId === channelId) return useVoice.getState().leave()
      })
      .catch((err) => console.warn('[nexo] voice leave after channel delete failed', err))
  })

  s.on('message:new', (m) => {
    noteMessage(m, useApp.getState().me?.id)
    notifyMessage(m)
    useApp.setState((st) => {
      const cm = st.messages[m.channelId]
      const patch: Partial<typeof st> = {}
      if (cm?.loaded && !cm.items.some((x) => x.id === m.id)) {
        const last = cm.items[cm.items.length - 1]
        const items = !last || last.createdAt <= m.createdAt ? [...cm.items, m] : mergeMessages(cm.items, [m])
        patch.messages = { ...st.messages, [m.channelId]: { ...cm, items } }
      }
      // Whoever just sent a message has stopped typing.
      const ct = st.typing[m.channelId]
      if (ct && m.userId in ct) {
        const { [m.userId]: _gone, ...rest } = ct
        patch.typing = { ...st.typing, [m.channelId]: rest }
      }
      return patch
    })
  })

  s.on('message:deleted', ({ messageId, channelId }) => {
    forgetDeletedMessage(messageId)
    chatPanelsMessageDeleted(messageId)
    const st = useApp.getState()
    const cm = st.messages[channelId]
    if (!cm) return
    const deleted = cm.items.find((x) => x.id === messageId)
    // Loaded replies to it keep their preview line, shown as "Original message was deleted".
    const replies = cm.items.some((x) => x.replyTo?.id === messageId)
    if (!deleted && !replies) return
    const items = cm.items
      .filter((x) => x.id !== messageId)
      .map((x) =>
        x.replyTo?.id === messageId
          ? { ...x, replyTo: { ...x.replyTo, content: '', hasAttachments: false, deleted: true } }
          : x,
      )
    useApp.setState({ messages: { ...st.messages, [channelId]: { ...cm, items } } })
    if (deleted) noteDeleted(channelId, deleted, items, st.me?.id)
  })

  s.on('message:updated', (m) => {
    chatPanelsMessageUpdated(m)
    useApp.setState((st) => {
      const cm = st.messages[m.channelId]
      if (!cm) return {}
      // Replace in place, and refresh the preview of loaded replies to it.
      const items = cm.items.map((x) => {
        if (x.id === m.id) return m
        if (x.replyTo?.id === m.id && !x.replyTo.deleted)
          return { ...x, replyTo: { ...x.replyTo, content: cutPreview(m.content) } }
        return x
      })
      return { messages: { ...st.messages, [m.channelId]: { ...cm, items } } }
    })
  })

  s.on('message:reactions', ({ messageId, channelId, reactions }) => {
    // Not loaded: ignored (history loads bring the current list).
    useApp.setState((st) => {
      const messages = mapMessage(st.messages, channelId, messageId, (m) => ({ ...m, reactions }))
      return messages === st.messages ? {} : { messages }
    })
  })

  s.on('typing', ({ channelId, userId }) => {
    useApp.setState((st) => {
      if (userId === st.me?.id) return {}
      return { typing: { ...st.typing, [channelId]: { ...st.typing[channelId], [userId]: Date.now() + TYPING_TTL_MS } } }
    })
  })

  s.on('voice:states', (states) => {
    useApp.setState({ voice: states })
  })

  // Lazy, like voice/session above: voice/voiceActions imports voice/session, which imports this module.
  s.on('voice:moved', ({ channelId, by }) => {
    if (socket !== s) return
    void import('../voice/voiceActions')
      .then((m) => m.handleMoved(channelId, by))
      .catch((err) => console.warn('[nexo] voice move failed', err))
  })

  // ---- soundboard (store/sounds.ts; playback in voice/soundboard.ts, lazy like voice/session) ----
  s.on('sound:upsert', (sound) => {
    if (socket !== s) return
    upsertSound(sound)
  })

  s.on('sound:deleted', ({ soundId }) => {
    if (socket !== s) return
    removeSound(soundId)
  })

  s.on('sound:played', (p) => {
    if (socket !== s) return
    void import('../voice/soundboard')
      .then((m) => m.handleSoundPlayed(p))
      .catch((err) => console.warn('[nexo] soundboard playback failed', err))
  })

  // ---- plugins and music (store/plugins.ts, store/music.ts; playback in voice/musicPlayer.ts, lazy) ----
  s.on('plugins:changed', (p) => {
    if (socket !== s) return
    applyPlugins(p)
    if (p?.music) loadMusicPlayer()
  })

  s.on('music:state', (st) => {
    if (socket !== s) return
    applyMusicState(st)
    loadMusicPlayer()
  })

  // ---- games plugin (store/games.ts: lobbies; games/frames.ts: the running match) ----
  s.on('games:lobby', (l) => {
    if (socket !== s) return
    applyGameLobby(l)
  })

  s.on('games:frame', (f) => {
    if (socket !== s) return
    handleGameFrame(f)
  })

  // ---- emulator plugin (store/emulator.ts: sessions; relayed player input reaches the host's engine) ----
  s.on('emu:session', (e) => {
    if (socket !== s) return
    applyEmuSession(e)
  })

  s.on('emu:input', (p) => {
    if (socket !== s) return
    handleEmuInput(p)
  })

  s.on('voice:nudged', ({ by }) => {
    if (socket !== s) return
    void import('../voice/voiceActions')
      .then((m) => m.handleNudged(by))
      .catch((err) => console.warn('[nexo] voice nudge failed', err))
  })

  // ---- accounts and roles (docs/SPEC-ACCOUNTS.md §2, §4); state lives in store/admin.ts ----
  s.on('user:removed', ({ userId }) => {
    if (socket !== s) return
    applyUserRemoved(userId)
    stripReactionsOf(userId)
  })

  s.on('access:request', (r) => {
    if (socket !== s) return
    addAccessRequest(r)
  })

  s.on('access:resolved', ({ requestId }) => {
    if (socket !== s) return
    dropAccessRequest(requestId)
  })
}

async function handleBootstrap(b: Bootstrap) {
  const url = currentUrl
  if (b.token) {
    // New identity (new account or "Welcome back" claim): persist the token (under the server id when the
    // server sends one) and use it for every future (re)connect.
    currentAuth = { token: b.token }
    await saveNewLogin(url, b.serverId, b.token)
  } else if (b.serverId && currentAuth && 'token' in currentAuth) {
    // Move a login saved under the URL (older app versions) to the server-id key.
    void migrateLogin(url, b.serverId, currentAuth.token)
  }
  settings.setServerUrl(url)
  const wasBootstrapped = bootstrapped
  bootstrapped = true
  failures = 0

  const st = useApp.getState()
  const channels = sortChannels(b.channels)
  const channelIds = new Set(channels.map((c) => c.id))
  const users: Record<string, (typeof b.users)[number]> = {}
  for (const u of b.users) users[u.id] = u
  users[b.me.id] = b.me

  // Keep already-loaded history for surviving channels, then refresh it (we may have missed events).
  const messages: Record<string, ChannelMessages> = {}
  for (const [cid, cm] of Object.entries(st.messages)) if (channelIds.has(cid)) messages[cid] = { ...cm, loading: false }

  const sameIdentity = st.me?.id === b.me.id
  const selected = defaultChannelId(
    channels,
    (sameIdentity ? st.selectedChannelId : null) ?? settings.getLastChannel(url),
  )

  useApp.setState({
    view: 'main',
    connection: 'connected',
    connectionError: null,
    onboardingNotice: null,
    serverUrl: url,
    serverName: b.serverName,
    me: b.me,
    users,
    online: toSet(b.online),
    channels,
    voice: b.voice,
    messages: sameIdentity ? messages : {},
    typing: {},
  })
  setBootstrapPresence(b.presence)
  setBootstrapSounds(b.sounds)
  setBootstrapPlugins(b.plugins)
  setBootstrapMusic(b.music)
  setBootstrapGames(b.games)
  setBootstrapEmulator(b.emulator)
  if (b.plugins?.music) loadMusicPlayer()
  resetSignIn() // signed in: any onboarding "Welcome back" / sign-in request state is obsolete
  loadReadState(
    url,
    b.me.id,
    b.lastMessageAt,
    channels.filter((c) => c.type === 'text').map((c) => c.id),
    b.lastMentionAt,
  )
  useApp.getState().selectChannel(selected)
  setAccessRequests(b.accessRequests)

  if (wasBootstrapped || sameIdentity) {
    for (const cid of Object.keys(messages)) if (messages[cid].loaded) void refreshChannel(cid)
  }

  for (const cb of [...connectedListeners]) {
    try {
      cb()
    } catch (err) {
      console.error('[nexo] onConnected listener failed', err)
    }
  }
}

/** After a reconnect: fetch the newest page and reconcile it with what we already have. */
async function refreshChannel(channelId: string) {
  let page: Message[]
  try {
    page = await request('message:history', { channelId })
  } catch {
    return
  }
  useApp.setState((st) => {
    const cm = st.messages[channelId]
    if (!cm) return {}
    const items = cm.items
    const newestKnown = items[items.length - 1]
    const full = page.length >= MESSAGE_PAGE_SIZE
    if (full && newestKnown && page[0].createdAt > newestKnown.createdAt) {
      // Gap bigger than one page: start over from the newest page.
      return { messages: { ...st.messages, [channelId]: { ...cm, items: page, hasMore: true } } }
    }
    // Drop local messages inside the fetched window that the server no longer has (deleted while offline).
    const from = full ? page[0].createdAt : -Infinity
    const pageIds = new Set(page.map((m) => m.id))
    const kept = items.filter((m) => m.createdAt < from || pageIds.has(m.id))
    return { messages: { ...st.messages, [channelId]: { ...cm, items: mergeMessages(kept, page) } } }
  })
}

async function handleUnknownToken() {
  const url = currentUrl
  disconnect()
  await settings.setToken(url, null)
  // The same session stores as store/app.ts logout / changeServer (presence: lib/presenceSync.ts, on `me`).
  resetUnread()
  resetChatPanels()
  resetSounds()
  resetPlugins()
  resetMusic()
  resetGames()
  resetEmulator()
  useApp.setState({
    view: 'onboarding',
    connection: 'idle',
    connectionError: null,
    me: null,
    onboardingNotice:
      "This server doesn't recognize this device anymore (its data may have been reset). Pick a name to join again.",
  })
}

/**
 * The music player (voice/musicPlayer.ts) follows the stores once loaded. Lazy like voice/session: it imports
 * voice/session, which imports this module (and a module-level store subscription must not run mid-cycle).
 */
function loadMusicPlayer(): void {
  void import('../voice/musicPlayer')
    .then((m) => m.startMusicPlayer())
    .catch((err) => console.warn('[nexo] music player failed to load', err))
}

/** Like the server's ReplyPreview content: the first REPLY_PREVIEW_LENGTH characters, never half a surrogate pair. */
function cutPreview(content: string): string {
  if (content.length <= REPLY_PREVIEW_LENGTH) return content
  const end = /[\uD800-\uDBFF]/.test(content[REPLY_PREVIEW_LENGTH - 1]) ? REPLY_PREVIEW_LENGTH - 1 : REPLY_PREVIEW_LENGTH
  return content.slice(0, end)
}

/** A removed account (safety net; the server also sends `message:reactions`): take its reactions off every loaded message (dropping reactions left empty). */
function stripReactionsOf(userId: string) {
  useApp.setState((st) => {
    let messages: typeof st.messages | null = null
    for (const [cid, cm] of Object.entries(st.messages)) {
      if (!cm.items.some((m) => m.reactions?.some((r) => r.userIds.includes(userId)))) continue
      const items = cm.items.map((m) =>
        m.reactions?.some((r) => r.userIds.includes(userId))
          ? {
              ...m,
              reactions: m.reactions
                .map((r) => ({ ...r, userIds: r.userIds.filter((u) => u !== userId) }))
                .filter((r) => r.userIds.length > 0),
            }
          : m,
      )
      messages ??= { ...st.messages }
      messages[cid] = { ...cm, items }
    }
    return messages ? { messages } : {}
  })
}

function toSet(ids: string[]): Record<string, true> {
  const out: Record<string, true> = {}
  for (const id of ids) out[id] = true
  return out
}
