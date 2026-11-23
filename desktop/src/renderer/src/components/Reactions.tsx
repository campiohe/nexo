// Reaction chips under a message: "emoji count", highlighted when you reacted, click toggles, the tooltip
// names who reacted. A "+" at the end (shown while the message is hovered) opens the emoji picker.
import { memo } from 'react'
import type { Reaction } from '@shared/protocol'
import { MAX_REACTIONS_PER_MESSAGE } from '@shared/protocol'
import { useApp } from '../store/app'
import { findEmoji } from '../lib/emoji'
import { toast } from '../lib/toast'
import { formatList, useT, type Translate } from '../i18n'
import { SmilePlusIcon } from './icons'

const TOOLTIP_NAMES = 12

function whoReacted(r: Reaction, names: (id: string) => string, t: Translate): string {
  const shown = r.userIds.slice(0, TOOLTIP_NAMES).map(names)
  const more = r.userIds.length - shown.length
  const list = more > 0 ? t('{names} and {count} more', { names: shown.join(', '), count: more }) : formatList(shown)
  // Emoji names stay in English (they're the :shortcode: words).
  const name = findEmoji(r.emoji)?.name
  const emoji = name ? `${r.emoji} (${name})` : r.emoji
  return t('{count, plural, one {{names} reacted with {emoji}} other {{names} reacted with {emoji}}}', {
    count: r.userIds.length,
    names: list,
    emoji,
  })
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
  const t = useT()
  const users = useApp((s) => s.users)
  if (reactions.length === 0) return null
  const names = (id: string) => (id === meId ? t('You') : (users[id]?.name ?? t('Deleted user')))

  return (
    <div className="reactions">
      {reactions.map((r) => {
        const mine = !!meId && r.userIds.includes(meId)
        const label = whoReacted(r, names, t)
        return (
          <button
            key={r.emoji}
            className={`reaction ${mine ? 'is-mine' : ''}`}
            aria-pressed={mine}
            title={label}
            aria-label={mine ? t('{label}. Click to remove your reaction', { label }) : t('{label}. Click to react', { label })}
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
          title={t('Add reaction')}
          aria-label={t('Add reaction')}
          onClick={(e) => onAdd(e.currentTarget)}
        >
          <SmilePlusIcon size={16} />
        </button>
      )}
    </div>
  )
})
