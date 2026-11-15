// Hover action bar of a message (top right, like Discord): quick reactions, React (emoji picker), Reply,
// Edit (own messages), Delete (lib/permissions canDeleteMessage; Shift+click skips the confirmation).
// Rendered only for the hovered / keyboard-focused message (MessageList), so long lists stay light.
import type { MouseEvent } from 'react'
import { QUICK_REACTIONS, findEmoji, noteRecentEmoji } from '../lib/emoji'
import { toast } from '../lib/toast'
import { useApp } from '../store/app'
import { PencilIcon, ReplyIcon, SmilePlusIcon, TrashIcon } from './icons'

export function MessageActions({
  messageId,
  canEdit,
  canDelete,
  pickerOpen,
  onReact,
  onReply,
  onEdit,
  onDelete,
}: {
  messageId: string
  canEdit: boolean
  canDelete: boolean
  /** The emoji picker is open from this bar's React button. */
  pickerOpen: boolean
  onReact(anchor: HTMLElement): void
  onReply(): void
  onEdit(): void
  onDelete(e: MouseEvent): void
}) {
  return (
    <div className="message-actions" role="toolbar" aria-label="Message actions">
      {QUICK_REACTIONS.map((emoji) => {
        const name = findEmoji(emoji)?.name ?? emoji
        return (
          <button
            key={emoji}
            className="icon-btn message-quick-react"
            title={`React with ${name}`}
            aria-label={`React with ${name}`}
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
        title="Add reaction"
        aria-label="Add reaction"
        aria-expanded={pickerOpen}
        onClick={(e) => onReact(e.currentTarget)}
      >
        <SmilePlusIcon size={16} />
      </button>
      <button className="icon-btn" title="Reply" aria-label="Reply" onClick={onReply}>
        <ReplyIcon size={16} />
      </button>
      {canEdit && (
        <button className="icon-btn" title="Edit" aria-label="Edit message" onClick={onEdit}>
          <PencilIcon size={15} />
        </button>
      )}
      {canDelete && (
        <button
          className="icon-btn danger"
          title="Delete message (Shift+click to skip confirmation)"
          aria-label="Delete message"
          onClick={onDelete}
        >
          <TrashIcon size={15} />
        </button>
      )}
    </div>
  )
}
