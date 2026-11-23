// Hover action bar of a message (top right, like Discord): quick reactions, React (emoji picker), Reply,
// Pin / Unpin (lib/permissions canUnpinMessage), Edit (own messages), Delete (lib/permissions canDeleteMessage; Shift+click skips the confirmation).
// Rendered only for the hovered / keyboard-focused message (MessageList), so long lists stay light.
import type { MouseEvent } from 'react'
import { QUICK_REACTIONS, findEmoji, noteRecentEmoji } from '../lib/emoji'
import { toast } from '../lib/toast'
import { useT } from '../i18n'
import { useApp } from '../store/app'
import { PencilIcon, ReplyIcon, SmilePlusIcon, TrashIcon } from './icons'
import { PinIcon, PinOffIcon } from './chatIcons'

export function MessageActions({
  messageId,
  canEdit,
  canDelete,
  pinned,
  canUnpin,
  pickerOpen,
  onReact,
  onReply,
  onEdit,
  onDelete,
}: {
  messageId: string
  canEdit: boolean
  canDelete: boolean
  /** The message is pinned (the button unpins, when `canUnpin`). */
  pinned: boolean
  canUnpin: boolean
  /** The emoji picker is open from this bar's React button. */
  pickerOpen: boolean
  onReact(anchor: HTMLElement): void
  onReply(): void
  onEdit(): void
  onDelete(e: MouseEvent): void
}) {
  const t = useT()
  return (
    <div className="message-actions" role="toolbar" aria-label={t('Message actions')}>
      {QUICK_REACTIONS.map((emoji) => {
        const name = findEmoji(emoji)?.name ?? emoji
        return (
          <button
            key={emoji}
            className="icon-btn message-quick-react"
            title={t('React with {name}', { name })}
            aria-label={t('React with {name}', { name })}
            onClick={() => {
              noteRecentEmoji(emoji)
              useApp.getState().toggleReaction(messageId, emoji).catch((err) => toast(err, 'error'))
            }}
          >
            {emoji}
          </button>
        )
      })}
      <span className="message-actions-sep" aria-hidden="true" />
      <button
        className={`icon-btn ${pickerOpen ? 'is-active' : ''}`}
        title={t('Add reaction')}
        aria-label={t('Add reaction')}
        aria-expanded={pickerOpen}
        onClick={(e) => onReact(e.currentTarget)}
      >
        <SmilePlusIcon size={16} />
      </button>
      <button className="icon-btn" title={t('Reply')} aria-label={t('Reply')} onClick={onReply}>
        <ReplyIcon size={16} />
      </button>
      {!pinned ? (
        <button className="icon-btn" title={t('Pin message')} aria-label={t('Pin message')} onClick={() => setPinned(messageId, true)}>
          <PinIcon size={16} />
        </button>
      ) : (
        canUnpin && (
          <button className="icon-btn" title={t('Unpin message')} aria-label={t('Unpin message')} onClick={() => setPinned(messageId, false)}>
            <PinOffIcon size={16} />
          </button>
        )
      )}
      {canEdit && (
        <button className="icon-btn" title={t('Edit')} aria-label={t('Edit message')} onClick={onEdit}>
          <PencilIcon size={15} />
        </button>
      )}
      {canDelete && (
        <button
          className="icon-btn danger"
          title={t('Delete message (Shift+click to skip confirmation)')}
          aria-label={t('Delete message')}
          onClick={onDelete}
        >
          <TrashIcon size={15} />
        </button>
      )}
    </div>
  )
}

function setPinned(messageId: string, pinned: boolean) {
  useApp
    .getState()
    .pinMessage(messageId, pinned)
    .catch((err) => toast(err, 'error'))
}
