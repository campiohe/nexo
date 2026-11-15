// The right-side chat panels (search results, pinned messages) and "jump to message" requests.
// While a panel is open it takes the member list's place (MainLayout).
import { create } from 'zustand'
import type { Message } from '@shared/protocol'
import { SEARCH_QUERY_MAX } from '@shared/protocol'
import { request } from '../net/socket'
import { useApp } from './app'

export type ChatPanel = 'search' | 'pins' | null

/** A submitted search: free text plus resolved filters (what the server gets) and labels for the chips. */
export interface SearchQuery {
  /** Free text, without the `from:` / `in:` filters. */
  text: string
  authorId?: string
  /** From `in:#channel`. */
  channelId?: string
  /** "This channel only" was on: the channel selected when searching (ignored when `channelId` is set). */
  scopeChannelId?: string
}

export interface JumpRequest {
  channelId: string
  messageId: string
  /** Lets MessageList stop paging once it's past the message (e.g. it was deleted). */
  createdAt?: number
  nonce: number
}

interface ChatPanelsState {
  panel: ChatPanel
  openPanel(panel: ChatPanel): void

  // ---- search ----
  search: SearchQuery | null
  results: Message[]
  hasMore: boolean
  loading: boolean
  error: string | null
  /** Restrict searches to the selected channel (panel toggle). */
  thisChannelOnly: boolean
  setThisChannelOnly(on: boolean): void
  /** Bumped to ask the header search box to take focus (Ctrl+F). */
  focusSearchNonce: number
  focusSearch(): void
  runSearch(q: SearchQuery): Promise<void>
  loadMoreResults(): Promise<void>

  // ---- pins ----
  pinsChannelId: string | null
  pins: Message[]
  pinsLoading: boolean
  pinsError: string | null
  loadPins(channelId: string): Promise<void>

  // ---- jump ----
  jump: JumpRequest | null
  /** Show `msg` in its channel (selects it; MessageList loads older pages until found, then flashes it). */
  jumpTo(msg: Pick<Message, 'id' | 'channelId' | 'createdAt'>): void
  clearJump(nonce: number): void
}

let searchSeq = 0
let pinsSeq = 0
let jumpNonce = 0

const effectiveChannel = (q: SearchQuery) => q.channelId ?? q.scopeChannelId

function dedupe(a: Message[], b: Message[]): Message[] {
  const ids = new Set(a.map((m) => m.id))
  return [...a, ...b.filter((m) => !ids.has(m.id))]
}

const sortPins = (list: Message[]) => [...list].sort((x, y) => (y.pinned?.at ?? 0) - (x.pinned?.at ?? 0))

export const useChatPanels = create<ChatPanelsState>()((set, get) => ({
  panel: null,
  openPanel: (panel) => set({ panel }),

  search: null,
  results: [],
  hasMore: false,
  loading: false,
  error: null,
  thisChannelOnly: false,
  setThisChannelOnly: (on) => {
    set({ thisChannelOnly: on })
    const q = get().search
    if (!q || q.channelId) return
    const app = useApp.getState()
    const selected = app.channels.find((c) => c.id === app.selectedChannelId)
    const scopeChannelId = on && selected?.type === 'text' ? selected.id : undefined
    if (scopeChannelId !== q.scopeChannelId) void get().runSearch({ ...q, scopeChannelId })
  },
  focusSearchNonce: 0,
  focusSearch: () => set((s) => ({ focusSearchNonce: s.focusSearchNonce + 1 })),

  runSearch: async (q) => {
    const seq = ++searchSeq
    set({ panel: 'search', search: q, results: [], hasMore: false, loading: true, error: null })
    if (q.text.length > SEARCH_QUERY_MAX) {
      set({ loading: false, error: `Search is limited to ${SEARCH_QUERY_MAX} characters` })
      return
    }
    const channelId = effectiveChannel(q)
    try {
      const page = await request('message:search', {
        query: q.text,
        ...(channelId ? { channelId } : {}),
        ...(q.authorId ? { authorId: q.authorId } : {}),
      })
      if (seq !== searchSeq) return
      set({ results: page.messages, hasMore: page.hasMore, loading: false })
    } catch (err) {
      if (seq !== searchSeq) return
      set({ loading: false, error: err instanceof Error ? err.message : String(err) })
    }
  },

  loadMoreResults: async () => {
    const { search: q, results, hasMore, loading } = get()
    const last = results[results.length - 1]
    if (!q || !hasMore || loading || !last) return
    const seq = searchSeq
    set({ loading: true, error: null })
    const channelId = effectiveChannel(q)
    try {
      const page = await request('message:search', {
        query: q.text,
        ...(channelId ? { channelId } : {}),
        ...(q.authorId ? { authorId: q.authorId } : {}),
        before: last.createdAt,
      })
      if (seq !== searchSeq) return
      set((s) => ({ results: dedupe(s.results, page.messages), hasMore: page.hasMore, loading: false }))
    } catch (err) {
      if (seq !== searchSeq) return
      set({ loading: false, error: err instanceof Error ? err.message : String(err) })
    }
  },

  pinsChannelId: null,
  pins: [],
  pinsLoading: false,
  pinsError: null,
  loadPins: async (channelId) => {
    const seq = ++pinsSeq
    const same = get().pinsChannelId === channelId
    set({ pinsChannelId: channelId, pins: same ? get().pins : [], pinsLoading: true, pinsError: null })
    try {
      const pins = await request('message:pins', { channelId })
      if (seq !== pinsSeq) return
      set({ pins: sortPins(pins), pinsLoading: false })
    } catch (err) {
      if (seq !== pinsSeq) return
      set({ pinsLoading: false, pinsError: err instanceof Error ? err.message : String(err) })
    }
  },

  jump: null,
  jumpTo: (msg) => {
    const app = useApp.getState()
    if (!app.channels.some((c) => c.id === msg.channelId)) return
    if (app.selectedChannelId !== msg.channelId) app.selectChannel(msg.channelId)
    set({ jump: { channelId: msg.channelId, messageId: msg.id, createdAt: msg.createdAt, nonce: ++jumpNonce } })
  },
  clearJump: (nonce) => {
    if (get().jump?.nonce === nonce) set({ jump: null })
  },
}))

/** `message:updated` (net/socket): keep the pins list and search results in sync (pin/unpin, edits). */
export function chatPanelsMessageUpdated(m: Message): void {
  const s = useChatPanels.getState()
  const patch: Partial<ChatPanelsState> = {}
  if (s.pinsChannelId === m.channelId) {
    const rest = s.pins.filter((p) => p.id !== m.id)
    if (m.pinned) patch.pins = sortPins([...rest, m])
    else if (rest.length !== s.pins.length) patch.pins = rest
  }
  if (s.results.some((r) => r.id === m.id)) patch.results = s.results.map((r) => (r.id === m.id ? m : r))
  if (Object.keys(patch).length) useChatPanels.setState(patch)
}

/** `message:deleted` / own deletes: drop it from the pins list and search results. */
export function chatPanelsMessageDeleted(messageId: string): void {
  const s = useChatPanels.getState()
  const patch: Partial<ChatPanelsState> = {}
  if (s.pins.some((p) => p.id === messageId)) patch.pins = s.pins.filter((p) => p.id !== messageId)
  if (s.results.some((r) => r.id === messageId)) patch.results = s.results.filter((r) => r.id !== messageId)
  if (Object.keys(patch).length) useChatPanels.setState(patch)
}

/** An unpin succeeded for a message that isn't loaded in its channel: drop it from the pins list. */
export function chatPanelsUnpinned(messageId: string): void {
  const s = useChatPanels.getState()
  if (s.pins.some((p) => p.id === messageId)) useChatPanels.setState({ pins: s.pins.filter((p) => p.id !== messageId) })
}

/** Logout / server change: forget everything. */
export function resetChatPanels(): void {
  searchSeq++
  pinsSeq++
  useChatPanels.setState({
    panel: null,
    search: null,
    results: [],
    hasMore: false,
    loading: false,
    error: null,
    pinsChannelId: null,
    pins: [],
    pinsLoading: false,
    pinsError: null,
    jump: null,
  })
}
