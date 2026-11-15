import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type FocusEvent, type KeyboardEvent, type MouseEvent } from 'react'
import type { Attachment, Message, User } from '@shared/protocol'
import { NO_REACTIONS, useApp } from '../store/app'
import { useCompose } from '../store/compose'
import { toast } from '../lib/toast'
import { canDeleteMessage } from '../lib/permissions'
import { contentToPlain, mentionsUser } from '../lib/mentions'
import { formatDay, formatFull, formatTime, isSameDay } from '../lib/time'
import { Avatar } from './Avatar'
import { ConfirmDialog } from './Modal'
import { MessageAttachments, MessageContent } from './MessageContent'
import { ImageLightbox } from './ImageLightbox'
import { MessageActions } from './MessageActions'
import { MessageEditor } from './MessageEditor'
import { Reactions } from './Reactions'
import { EmojiPicker } from './EmojiPicker'
import { ArrowDownIcon, HashIcon } from './icons'

const GROUP_WINDOW_MS = 5 * 60 * 1000
const STICK_THRESHOLD_PX = 80
const LOAD_OLDER_THRESHOLD_PX = 120
/** Clicking a reply preview loads at most this many older pages looking for the original. */
const JUMP_MAX_PAGES = 10
const FLASH_MS = 1600
/** Older servers send messages without the field. */
const NO_ATTACHMENTS: Attachment[] = []

/** Short description of a message for the delete confirmation. */
function previewText(msg: Message): string {
  const n = msg.attachments?.length ?? 0
  const images = n === 1 ? '1 image' : `${n} images`
  if (!msg.content) return n ? `(${images})` : ''
  return n ? `${msg.content}\n(+ ${images})` : msg.content
}

interface Row {
  msg: Message
  /** Shows author + time header (false = continuation of a group). */
  head: boolean
  /** Day separator before this message. */
  day: string | null
}

function buildRows(items: Message[]): Row[] {
  const rows: Row[] = []
  let prev: Message | undefined
  for (const msg of items) {
    const newDay = !prev || !isSameDay(prev.createdAt, msg.createdAt)
    // A reply always starts a new group (its preview line sits above the author header).
    const head =
      newDay || !prev || prev.userId !== msg.userId || msg.createdAt - prev.createdAt > GROUP_WINDOW_MS || !!msg.replyTo
    rows.push({ msg, head, day: newDay ? formatDay(msg.createdAt) : null })
    prev = msg
  }
  return rows
}

/** Where the emoji picker was opened from (one picker at a time). */
interface PickerState {
  messageId: string
  anchor: HTMLElement
  from: 'bar' | 'reactions'
}

const nextFrame = () => new Promise<void>((r) => requestAnimationFrame(() => r()))

function flash(el: HTMLElement) {
  el.classList.remove('is-flash')
  void el.offsetWidth // restart the animation
  el.classList.add('is-flash')
  window.setTimeout(() => el.classList.remove('is-flash'), FLASH_MS)
}

export function MessageList({ channelId }: { channelId: string }) {
  const cm = useApp((s) => s.messages[channelId])
  const channelName = useApp((s) => s.channels.find((c) => c.id === channelId)?.name ?? '')
  const users = useApp((s) => s.users)
  const meId = useApp((s) => s.me?.id)
  // Admins and the owner may delete anyone's message; members only their own.
  const me = useApp((s) => s.me)
  const serverUrl = useApp((s) => s.serverUrl)
  const loadHistory = useApp((s) => s.loadHistory)
  const loadOlder = useApp((s) => s.loadOlder)
  const editingId = useCompose((s) => s.editingId)
  const replyingToId = useCompose((s) => s.replyTo[channelId])

  const scrollRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const stickRef = useRef(true)
  const snapRef = useRef<{ firstId?: string; lastId?: string; scrollHeight: number; scrollTop: number }>({
    scrollHeight: 0,
    scrollTop: 0,
  })
  const [unseen, setUnseen] = useState(0)
  const [pendingDelete, setPendingDelete] = useState<Message | null>(null)
  const [lightbox, setLightbox] = useState<Attachment | null>(null)
  const [picker, setPicker] = useState<PickerState | null>(null)

  const items = cm?.items ?? []
  const loaded = !!cm?.loaded
  const hasMore = cm?.hasMore ?? true
  const loading = !!cm?.loading
  const firstId = items[0]?.id
  const lastId = items[items.length - 1]?.id

  useEffect(() => {
    loadHistory(channelId).catch((err) => toast(err, 'error'))
  }, [channelId, loadHistory])

  // Leaving the channel closes its inline editor and picker.
  useEffect(() => {
    setPicker(null)
    return () => {
      const id = useCompose.getState().editingId
      if (id && useApp.getState().messages[channelId]?.items.some((m) => m.id === id)) useCompose.getState().setEditing(null)
    }
  }, [channelId])

  // The message the picker belongs to was deleted.
  const pickerMessageId = picker?.messageId
  useEffect(() => {
    if (pickerMessageId && !items.some((m) => m.id === pickerMessageId)) setPicker(null)
  }, [items, pickerMessageId])

  const requestOlder = useCallback(() => {
    loadOlder(channelId).catch((err) => toast(err, 'error'))
  }, [channelId, loadOlder])

  /** Remember the scroll geometry (ids are updated by the layout effect only). */
  const snapshot = () => {
    const el = scrollRef.current
    if (el) snapRef.current = { ...snapRef.current, scrollHeight: el.scrollHeight, scrollTop: el.scrollTop }
  }

  // Keep the scroll position stable when older messages are prepended; follow the bottom for new ones.
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const prev = snapRef.current
    if (prev.firstId !== undefined && firstId !== prev.firstId && lastId === prev.lastId) {
      el.scrollTop = el.scrollHeight - prev.scrollHeight + prev.scrollTop
    } else if (lastId !== prev.lastId) {
      const last = items[items.length - 1]
      if (prev.lastId === undefined || stickRef.current || last?.userId === meId) {
        el.scrollTop = el.scrollHeight
        stickRef.current = true
        setUnseen(0)
      } else if (last) {
        setUnseen((n) => n + 1)
      }
    }
    snapRef.current = { firstId, lastId, scrollHeight: el.scrollHeight, scrollTop: el.scrollTop }
    // Not enough content to scroll yet: keep pulling older pages so "scroll to top" can work.
    if (loaded && hasMore && !loading && el.scrollHeight <= el.clientHeight + 4 && items.length > 0) requestOlder()
  })

  // Stay pinned to the bottom when the content or viewport resizes (window resize, composer growth).
  useEffect(() => {
    const el = scrollRef.current
    const content = contentRef.current
    if (!el || !content) return
    const ro = new ResizeObserver(() => {
      if (stickRef.current) el.scrollTop = el.scrollHeight
      snapshot()
    })
    ro.observe(el)
    ro.observe(content)
    return () => ro.disconnect()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function onScroll() {
    const el = scrollRef.current
    if (!el) return
    const dist = el.scrollHeight - el.scrollTop - el.clientHeight
    stickRef.current = dist < STICK_THRESHOLD_PX
    if (stickRef.current && unseen) setUnseen(0)
    if (el.scrollTop < LOAD_OLDER_THRESHOLD_PX && loaded && hasMore && !loading) requestOlder()
    snapshot()
  }

  function jumpToBottom() {
    const el = scrollRef.current
    if (!el) return
    stickRef.current = true
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
    setUnseen(0)
  }

  const openPicker = useCallback((messageId: string, anchor: HTMLElement, from: PickerState['from']) => {
    // The same button again closes it (the picker ignores clicks on its anchor).
    setPicker((p) => (p && p.messageId === messageId && p.anchor === anchor ? null : { messageId, anchor, from }))
  }, [])

  /** Scroll to a message (loading older pages if needed, up to a cap) and flash it. */
  const jumpTo = useCallback(
    async (messageId: string) => {
      const find = () => scrollRef.current?.querySelector<HTMLElement>(`[data-mid="${CSS.escape(messageId)}"]`) ?? null
      let el = find()
      for (let page = 0; !el && page < JUMP_MAX_PAGES; page++) {
        // Let an automatic older-page load finish first.
        for (let i = 0; i < 300 && useApp.getState().messages[channelId]?.loading; i++) await nextFrame()
        const before = useApp.getState().messages[channelId]
        if (!before?.loaded || !before.hasMore) break
        try {
          await loadOlder(channelId)
        } catch (err) {
          toast(err, 'error')
          return
        }
        await nextFrame()
        el = find()
        if ((useApp.getState().messages[channelId]?.items.length ?? 0) <= before.items.length) break
      }
      if (!el) {
        toast('Original message is further up', 'info')
        return
      }
      stickRef.current = false
      el.scrollIntoView({ block: 'center', behavior: 'smooth' })
      flash(el)
    },
    [channelId, loadOlder],
  )

  // Keyboard: Up/Down move between messages (focusing one shows its action bar), Escape goes to the composer.
  function onListKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    const t = e.target as HTMLElement
    const onRow = t.classList.contains('message')
    if (t !== e.currentTarget && !onRow) return
    if (e.key === 'Escape' && onRow) {
      e.preventDefault()
      useCompose.getState().focusComposer(channelId)
      return
    }
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return
    const rowsEls = [...(contentRef.current?.querySelectorAll<HTMLElement>('.message[data-mid]') ?? [])]
    if (!rowsEls.length) return
    let next: HTMLElement | undefined
    if (onRow) {
      const i = rowsEls.indexOf(t)
      next = rowsEls[e.key === 'ArrowUp' ? i - 1 : i + 1]
    } else {
      next = rowsEls[rowsEls.length - 1]
    }
    e.preventDefault()
    if (next) {
      next.focus({ preventScroll: true })
      next.scrollIntoView({ block: 'nearest' })
    }
  }

  const rows = useMemo(() => buildRows(items), [items])

  return (
    <div className="message-list-wrap">
      <div
        className="message-list"
        ref={scrollRef}
        onScroll={onScroll}
        onKeyDown={onListKeyDown}
        tabIndex={0}
        role="log"
        aria-label={`Messages in #${channelName}`}
      >
        <div className="message-list-content" ref={contentRef}>
          {loaded && !hasMore && (
            <div className="channel-intro">
              <div className="channel-intro-icon">
                <HashIcon size={30} />
              </div>
              <h2>Welcome to #{channelName}</h2>
              <p className="muted">This is the beginning of #{channelName}. Say hi!</p>
            </div>
          )}
          {(loading || !loaded) && (
            <div className={`history-loader ${loaded ? '' : 'is-initial'}`}>
              <span className="spinner" /> {loaded ? 'Loading older messages…' : 'Loading messages…'}
            </div>
          )}
          {rows.map((r) => (
            <MessageRow
              key={r.msg.id}
              msg={r.msg}
              head={r.head}
              day={r.day}
              author={users[r.msg.userId]}
              meId={meId}
              mine={r.msg.userId === meId}
              canDelete={canDeleteMessage(me, r.msg)}
              mentioned={mentionsUser(r.msg, meId)}
              editing={editingId === r.msg.id}
              replyTarget={replyingToId === r.msg.id}
              picker={picker?.messageId === r.msg.id ? picker.from : null}
              serverUrl={serverUrl}
              onDelete={setPendingDelete}
              onOpenImage={setLightbox}
              onOpenPicker={openPicker}
              onJump={jumpTo}
            />
          ))}
        </div>
      </div>
      {unseen > 0 && (
        <button className="new-messages-pill" onClick={jumpToBottom}>
          {unseen === 1 ? 'New message' : `${unseen} new messages`} <ArrowDownIcon size={14} />
        </button>
      )}
      {picker && (
        <EmojiPicker
          key={picker.messageId}
          anchor={picker.anchor}
          label="Add a reaction"
          onClose={() => setPicker(null)}
          onPick={(emoji) => {
            const messageId = picker.messageId
            useApp.getState().toggleReaction(messageId, emoji).catch((err) => toast(err, 'error'))
          }}
        />
      )}
      {pendingDelete && (
        <ConfirmDialog
          title={
            pendingDelete.userId === meId
              ? 'Delete message?'
              : `Delete ${users[pendingDelete.userId]?.name ?? 'this user'}'s message?`
          }
          message={
            <>
              <div className="confirm-preview">{previewText(pendingDelete)}</div>
              <span className="muted small">Tip: hold Shift while clicking delete to skip this.</span>
            </>
          }
          confirmLabel="Delete"
          danger
          onClose={() => setPendingDelete(null)}
          onConfirm={async () => {
            const msg = pendingDelete
            setPendingDelete(null)
            await deleteNow(msg)
          }}
        />
      )}
      {lightbox && <ImageLightbox att={lightbox} serverUrl={serverUrl} onClose={() => setLightbox(null)} />}
    </div>
  )
}

async function deleteNow(msg: Message) {
  try {
    await useApp.getState().deleteMessage(msg.id)
  } catch (err) {
    toast(err, 'error')
  }
}

/** The "replying to" line above a reply: connector, avatar, name, one-line snippet. Click jumps there. */
const ReplyLine = memo(function ReplyLine({ reply, onJump }: { reply: NonNullable<Message['replyTo']>; onJump(id: string): void }) {
  const users = useApp((s) => s.users)
  if (reply.deleted) {
    return (
      <div className="message-reply is-deleted">
        <span className="message-reply-text">Original message was deleted</span>
      </div>
    )
  }
  const author: User | undefined = reply.userId ? users[reply.userId] : undefined
  // '' = the account was removed (history), and a user missing from the list is gone too.
  const name = author?.name ?? 'Deleted user'
  const text = contentToPlain(reply.content, users).replace(/\s+/g, ' ').trim()
  return (
    <div className="message-reply">
      <button
        className="message-reply-target"
        onClick={() => onJump(reply.id)}
        title="Go to the original message"
        aria-label={`Replying to ${name}: ${text || (reply.hasAttachments ? 'image' : '')}. Go to the original message`}
      >
        <Avatar user={author} size={16} />
        <span className="message-reply-author" style={{ color: author?.color }}>
          {name}
        </span>
        <span className={`message-reply-text ${text ? '' : 'is-meta'}`}>{text || (reply.hasAttachments ? '[image]' : '…')}</span>
      </button>
    </div>
  )
})

const MessageRow = memo(function MessageRow({
  msg,
  head,
  day,
  author,
  meId,
  mine,
  canDelete,
  mentioned,
  editing,
  replyTarget,
  picker,
  serverUrl,
  onDelete,
  onOpenImage,
  onOpenPicker,
  onJump,
}: {
  msg: Message
  head: boolean
  day: string | null
  author: User | undefined
  meId: string | undefined
  mine: boolean
  canDelete: boolean
  /** Mentions you (or replies to you / @everyone): highlighted. */
  mentioned: boolean
  /** Shows the inline editor (store/compose editingId). */
  editing: boolean
  /** The composer is replying to this message. */
  replyTarget: boolean
  /** The emoji picker is open for this message, opened from the action bar or the reactions "+". */
  picker: PickerState['from'] | null
  serverUrl: string | null
  onDelete(m: Message): void
  onOpenImage(att: Attachment): void
  onOpenPicker(messageId: string, anchor: HTMLElement, from: PickerState['from']): void
  onJump(messageId: string): void
}) {
  // The action bar only exists for the hovered / keyboard-focused message (cheap long lists).
  const [hover, setHover] = useState(false)
  const [keyboard, setKeyboard] = useState(false)
  const showBar = hover || keyboard || picker === 'bar'
  const reactions = msg.reactions ?? NO_REACTIONS

  const onFocus = (e: FocusEvent<HTMLDivElement>) => {
    if (e.target instanceof HTMLElement && e.target.matches(':focus-visible')) setKeyboard(true)
  }
  const onBlur = (e: FocusEvent<HTMLDivElement>) => {
    if (!(e.relatedTarget instanceof Node && e.currentTarget.contains(e.relatedTarget))) setKeyboard(false)
  }

  const classes = [
    'message',
    head ? 'is-head' : 'is-cont',
    mine ? 'is-mine' : '',
    mentioned ? 'is-mentioned' : '',
    replyTarget ? 'is-reply-target' : '',
    editing ? 'is-editing' : '',
    msg.replyTo ? 'is-reply' : '',
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <>
      {day && (
        <div className="day-separator" role="separator">
          <span>{day}</span>
        </div>
      )}
      <div
        className={classes}
        data-mid={msg.id}
        tabIndex={-1}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        onFocus={onFocus}
        onBlur={onBlur}
      >
        {msg.replyTo && <ReplyLine reply={msg.replyTo} onJump={onJump} />}
        <div className="message-gutter">
          {head ? (
            <Avatar user={author} size={36} />
          ) : (
            <time className="message-time-hover" dateTime={new Date(msg.createdAt).toISOString()} title={formatFull(msg.createdAt)}>
              {formatTime(msg.createdAt)}
            </time>
          )}
        </div>
        <div className="message-body">
          {head && (
            <div className="message-header">
              <span className="message-author" style={{ color: author?.color }}>
                {author?.name ?? 'Unknown user'}
              </span>
              <time className="message-time" dateTime={new Date(msg.createdAt).toISOString()} title={formatFull(msg.createdAt)}>
                {formatTime(msg.createdAt)}
              </time>
            </div>
          )}
          {editing ? (
            <MessageEditor msg={msg} onDelete={onDelete} />
          ) : (
            (!!msg.content || !!msg.editedAt) && (
              <div className="message-text">
                {msg.content && <MessageContent text={msg.content} />}
                {msg.editedAt ? (
                  <span className="message-edited" title={`Edited ${formatFull(msg.editedAt)}`}>
                    {' '}
                    (edited)
                  </span>
                ) : null}
              </div>
            )
          )}
          <MessageAttachments attachments={msg.attachments ?? NO_ATTACHMENTS} serverUrl={serverUrl} onOpen={onOpenImage} />
          <Reactions
            messageId={msg.id}
            reactions={reactions}
            meId={meId}
            pickerOpen={picker === 'reactions'}
            onAdd={(anchor) => onOpenPicker(msg.id, anchor, 'reactions')}
          />
        </div>
        {showBar && (
          <MessageActions
            messageId={msg.id}
            canEdit={mine && !editing}
            canDelete={canDelete}
            pickerOpen={picker === 'bar'}
            onReact={(anchor) => onOpenPicker(msg.id, anchor, 'bar')}
            onReply={() => {
              const compose = useCompose.getState()
              compose.setReply(msg.channelId, msg.id)
              compose.focusComposer(msg.channelId)
            }}
            onEdit={() => useCompose.getState().setEditing(msg.id)}
            onDelete={(e: MouseEvent) => (e.shiftKey ? void deleteNow(msg) : onDelete(msg))}
          />
        )}
      </div>
    </>
  )
})
