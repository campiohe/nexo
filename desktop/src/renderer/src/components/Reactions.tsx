// Reaction chips under a message: "emoji count", highlighted when you reacted, click toggles, the tooltip
// names who reacted. A "+" at the end (shown while the message is hovered) opens the emoji picker.
import { memo } from 'react'
import type { Reaction } from '@shared/protocol'
import { MAX_REACTIONS_PER_MESSAGE } from '@shared/protocol'
import { useApp } from '../store/app'
import { findEmoji } from '../lib/emoji'
import { toast } from '../lib/toast'
import { SmilePlusIcon } from './icons'

const TOOLTIP_NAMES = 12

function whoReacted(r: Reaction, names: (id: string) => string): string {
  const shown = r.userIds.slice(0, TOOLTIP_NAMES).map(names)
  const more = r.userIds.length - shown.length
  const list =
    more > 0
      ? `${shown.join(', ')} and ${more} more`
      : shown.length > 1
        ? `${shown.slice(0, -1).join(', ')} and ${shown[shown.length - 1]}`
        : shown[0]
  const name = findEmoji(r.emoji)?.name
  return `${list} reacted with ${r.emoji}${name ? ` (${name})` : ''}`
}

export const Reactions = memo(function Reactions({
  messageId,
  reactions,
  meId,
  pickerOpen,
  onAdd,
}: {
  messageId: string
  reactions: Reaction[]
  meId: string | undefined
  /** The picker is open for this message from the "+" here (keeps "+" visible). */
  pickerOpen: boolean
  onAdd(anchor: HTMLElement): void
}) {
  const users = useApp((s) => s.users)
  if (reactions.length === 0) return null
  const names = (id: string) => (id === meId ? 'You' : users[id]?.name ?? 'Deleted user')

  return (
    <div className="reactions">
      {reactions.map((r) => {
        const mine = !!meId && r.userIds.includes(meId)
        const label = whoReacted(r, names)
        return (
          <button
            key={r.emoji}
            className={`reaction ${mine ? 'is-mine' : ''}`}
            aria-pressed={mine}
            title={label}
            aria-label={`${label}. ${mine ? 'Click to remove your reaction' : 'Click to react'}`}
            onClick={() => useApp.getState().toggleReaction(messageId, r.emoji).catch((err) => toast(err, 'error'))}
          >
            <span className="reaction-emoji">{r.emoji}</span>
            <span className="reaction-count">{r.userIds.length}</span>
          </button>
        )
      })}
      {reactions.length < MAX_REACTIONS_PER_MESSAGE && (
        <button
          className={`reaction reaction-add ${pickerOpen ? 'is-open' : ''}`}
          title="Add reaction"
          aria-label="Add reaction"
          onClick={(e) => onAdd(e.currentTarget)}
        >
          <SmilePlusIcon size={16} />
        </button>
      )}
    </div>
  )
})
