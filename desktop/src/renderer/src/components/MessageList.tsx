import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { Message, User } from '@shared/protocol'
import { useApp } from '../store/app'
import { toast } from '../lib/toast'
import { formatDay, formatFull, formatTime, isSameDay } from '../lib/time'
import { Avatar } from './Avatar'
import { ConfirmDialog } from './Modal'
import { MessageContent } from './MessageContent'
import { ArrowDownIcon, HashIcon, TrashIcon } from './icons'

const GROUP_WINDOW_MS = 5 * 60 * 1000
const STICK_THRESHOLD_PX = 80
const LOAD_OLDER_THRESHOLD_PX = 120

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
    const head = newDay || !prev || prev.userId !== msg.userId || msg.createdAt - prev.createdAt > GROUP_WINDOW_MS
    rows.push({ msg, head, day: newDay ? formatDay(msg.createdAt) : null })
    prev = msg
  }
  return rows
}

export function MessageList({ channelId }: { channelId: string }) {
  const cm = useApp((s) => s.messages[channelId])
  const channelName = useApp((s) => s.channels.find((c) => c.id === channelId)?.name ?? '')
  const users = useApp((s) => s.users)
  const meId = useApp((s) => s.me?.id)
  const loadHistory = useApp((s) => s.loadHistory)
  const loadOlder = useApp((s) => s.loadOlder)

  const scrollRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const stickRef = useRef(true)
  const snapRef = useRef<{ firstId?: string; lastId?: string; scrollHeight: number; scrollTop: number }>({
    scrollHeight: 0,
    scrollTop: 0,
  })
  const [unseen, setUnseen] = useState(0)
  const [pendingDelete, setPendingDelete] = useState<Message | null>(null)

  const items = cm?.items ?? []
  const loaded = !!cm?.loaded
  const hasMore = cm?.hasMore ?? true
  const loading = !!cm?.loading
  const firstId = items[0]?.id
  const lastId = items[items.length - 1]?.id

  useEffect(() => {
    loadHistory(channelId).catch((err) => toast(err, 'error'))
  }, [channelId, loadHistory])

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

  const rows = buildRows(items)

  return (
    <div className="message-list-wrap">
      <div className="message-list" ref={scrollRef} onScroll={onScroll} role="log" aria-label={`Messages in #${channelName}`}>
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
              row={r}
              author={users[r.msg.userId]}
              mine={r.msg.userId === meId}
              onDelete={setPendingDelete}
            />
          ))}
        </div>
      </div>
      {unseen > 0 && (
        <button className="new-messages-pill" onClick={jumpToBottom}>
          {unseen === 1 ? 'New message' : `${unseen} new messages`} <ArrowDownIcon size={14} />
        </button>
      )}
      {pendingDelete && (
        <ConfirmDialog
          title="Delete message?"
          message={
            <>
              <div className="confirm-preview">{pendingDelete.content}</div>
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

const MessageRow = memo(function MessageRow({
  row,
  author,
  mine,
  onDelete,
}: {
  row: Row
  author: User | undefined
  mine: boolean
  onDelete(m: Message): void
}) {
  const { msg, head, day } = row
  return (
    <>
      {day && (
        <div className="day-separator" role="separator">
          <span>{day}</span>
        </div>
      )}
      <div className={`message ${head ? 'is-head' : 'is-cont'} ${mine ? 'is-mine' : ''}`}>
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
          <MessageContent text={msg.content} />
        </div>
        {mine && (
          <div className="message-actions">
            <button
              className="icon-btn danger"
              title="Delete message (Shift+click to skip confirmation)"
              aria-label="Delete message"
              onClick={(e) => (e.shiftKey ? void deleteNow(msg) : onDelete(msg))}
            >
              <TrashIcon size={15} />
            </button>
          </div>
        )}
      </div>
    </>
  )
})
