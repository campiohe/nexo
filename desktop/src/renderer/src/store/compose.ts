// Composer state shared between the message list (where you click Reply / Edit) and the composer
// (which shows the "Replying to" bar and sends `replyToId`). Session only, per channel.
import { create } from 'zustand'

interface ComposeState {
  /** channelId -> id of the message being replied to. */
  replyTo: Record<string, string>
  /** The message currently being edited inline in the message list (one at a time), or null. */
  editingId: string | null
  /** Bumped to ask the composer of `channelId` to take focus (e.g. after clicking Reply). */
  focusRequest: { channelId: string; n: number } | null
  setReply(channelId: string, messageId: string | null): void
  setEditing(messageId: string | null): void
  focusComposer(channelId: string): void
}

export const useCompose = create<ComposeState>()((set, get) => ({
  replyTo: {},
  editingId: null,
  focusRequest: null,
  setReply: (channelId, messageId) =>
    set((s) => {
      const { [channelId]: _old, ...rest } = s.replyTo
      return { replyTo: messageId ? { ...rest, [channelId]: messageId } : rest }
    }),
  setEditing: (messageId) => set({ editingId: messageId }),
  focusComposer: (channelId) => set({ focusRequest: { channelId, n: (get().focusRequest?.n ?? 0) + 1 } }),
}))
