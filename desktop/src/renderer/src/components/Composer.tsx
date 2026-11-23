import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ClipboardEvent, type KeyboardEvent } from 'react'
import { ATTACHMENT_TYPES, MAX_ATTACHMENTS_PER_MESSAGE, MAX_MESSAGE_LENGTH, type User } from '@shared/protocol'
import { useApp } from '../store/app'
import { useCompose } from '../store/compose'
import { editableToContent, EVERYONE_TOKEN, findMentionQuery, nameMatches } from '../lib/mentions'
import { emit } from '../net/socket'
import {
  addImages,
  clearImages,
  removeImage,
  retryImage,
  settledImages,
  usePendingImages,
  type PendingImage,
} from '../net/attachments'
import { toast } from '../lib/toast'
import {
  findShortcodeQuery,
  noteRecentEmoji,
  replaceShortcodes,
  searchShortcodes,
  shortcodeBefore,
  skinTone,
  withTone,
} from '../lib/emoji'
import { domKeyMatches } from '../lib/keybinds'
import { useKeybinds } from '../voice/prefs'
import { AutocompletePopup } from './AutocompletePopup'
import { Avatar } from './Avatar'
import { EmojiPicker } from './EmojiPicker'
import { CloseIcon, ReplyIcon, SendIcon } from './icons'
import '../styles/composer-extras.css'

const TYPING_THROTTLE_MS = 2500
const COUNTER_FROM = MAX_MESSAGE_LENGTH - 500
/** Unsent drafts per channel (kept for the app session). */
const drafts = new Map<string, string>()
const NO_IMAGES: PendingImage[] = []
/** Rows in the @mention / :emoji popup. */
const MAX_SUGGESTIONS = 8

type Suggestion =
  | { kind: 'user'; user: User; online: boolean }
  | { kind: 'everyone' }
  | { kind: 'emoji'; char: string; code: string }

/** What the popup completes: an `@name` or a `:shortcode` (`start` = index of the `@` / `:`). */
type AutoQuery = { kind: 'mention' | 'emoji'; start: number; query: string }

/** Keys that end a word: a complete `:shortcode:` right before one becomes its emoji. */
const WORD_END_RE = /^[\s.,!?;)\]}'"]$/

/** Formatting shortcuts (Ctrl/Cmd + key) and the markers they wrap the selection in. */
const FORMAT_KEYS: Record<string, string> = { b: '**', i: '*', u: '__', e: '`' }

/** "@Ana " right after picking Ana: the mention is done, don't reopen the popup (though "Ana Clara" matches). */
function isCompleteMention(query: string, users: Record<string, User>): boolean {
  if (!/\s$/.test(query)) return false
  const name = query.trimEnd().toLocaleLowerCase()
  return name === EVERYONE_TOKEN.slice(1) || Object.values(users).some((u) => u.name.toLocaleLowerCase() === name)
}

/** People matching an @query: online first, then by name; `@everyone` last. You aren't listed. */
function suggest(query: string, users: Record<string, User>, online: Record<string, true>, meId: string | undefined): Suggestion[] {
  const people = Object.values(users)
    .filter((u) => u.id !== meId && nameMatches(u.name, query))
    .sort((a, b) => Number(!!online[b.id]) - Number(!!online[a.id]) || a.name.localeCompare(b.name))
    .slice(0, MAX_SUGGESTIONS)
    .map((user): Suggestion => ({ kind: 'user', user, online: !!online[user.id] }))
  const everyone = EVERYONE_TOKEN.slice(1).startsWith(query.toLocaleLowerCase())
  return everyone ? [...people, { kind: 'everyone' }] : people
}

/** Image files among `files`; anything else is reported with a toast. Shared with drag and drop. */
export function pickImageFiles(files: FileList | File[] | null | undefined): File[] {
  const all = [...(files ?? [])]
  // Types are re-checked from the bytes before upload; an empty type (some clipboard sources) gets that chance.
  const images = all.filter((f) => f.type === '' || f.type.startsWith('image/'))
  if (images.length < all.length) toast('Only images (PNG, JPEG, WebP, GIF) can be attached', 'error')
  return images
}

const AttachIcon = ({ size = 18 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
    <rect x="3" y="4" width="18" height="16" rx="3" />
    <circle cx="9" cy="10" r="1.6" />
    <path d="m21 16-5-5-9 9" />
  </svg>
)

const RetryIcon = ({ size = 16 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
    <path d="M20 11a8 8 0 1 0-2.3 5.7" />
    <path d="M20 4v7h-7" />
  </svg>
)

const SmileIcon = ({ size = 20 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
    <circle cx="12" cy="12" r="9" />
    <path d="M8.5 14.5a4.5 4.5 0 0 0 7 0" />
    <path d="M9 9.5h.01M15 9.5h.01" strokeWidth={2.6} />
  </svg>
)

/** Is this key press one of the app's own shortcuts (quick switcher, settings)? Those win over formatting. */
function isAppShortcut(e: globalThis.KeyboardEvent): boolean {
  const { quickSwitcher, openSettings } = useKeybinds.getState()
  return domKeyMatches(quickSwitcher, e) || domKeyMatches(openSettings, e)
}

export function Composer({ channelId, channelName }: { channelId: string; channelName: string }) {
  const sendMessage = useApp((s) => s.sendMessage)
  const connected = useApp((s) => s.connection === 'connected')
  const users = useApp((s) => s.users)
  const online = useApp((s) => s.online)
  const meId = useApp((s) => s.me?.id)
  const images = usePendingImages((s) => s.byChannel[channelId] ?? NO_IMAGES)
  const [value, setValue] = useState(() => drafts.get(channelId) ?? '')
  /** Waiting for uploads to finish before sending. */
  const [waiting, setWaiting] = useState(false)
  const ref = useRef<HTMLTextAreaElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const lastTypingRef = useRef(0)
  const sendingRef = useRef(false)

  // ---- reply ("Replying to Name") ----
  const replyId = useCompose((s) => s.replyTo[channelId] ?? null)
  const replyTarget = useApp((s) => (replyId ? (s.messages[channelId]?.items.find((m) => m.id === replyId) ?? null) : null))
  const replyLoaded = useApp((s) => !!s.messages[channelId]?.loaded)
  const replyAuthor = useApp((s) => (replyTarget ? s.users[replyTarget.userId] : undefined))
  const cancelReply = () => useCompose.getState().setReply(channelId, null)
  // The message was deleted (or fell out of the loaded history): nothing to reply to anymore.
  useEffect(() => {
    if (replyId && replyLoaded && !replyTarget) useCompose.getState().setReply(channelId, null)
  }, [channelId, replyId, replyLoaded, replyTarget])
  // Leaving the channel drops its reply.
  useEffect(() => () => useCompose.getState().setReply(channelId, null), [channelId])

  // Reply / Edit clicked in the message list (or anything else) asks for focus.
  const focusRequest = useCompose((s) => s.focusRequest)
  useEffect(() => {
    if (focusRequest?.channelId === channelId) ref.current?.focus()
  }, [focusRequest, channelId])

  // ---- @mention / :emoji autocomplete ----
  const [auto, setAuto] = useState<AutoQuery | null>(null)
  const [active, setActive] = useState(0)
  /** Escape closed the popup for the `@` / `:` at this index; typing elsewhere reopens it. */
  const dismissedRef = useRef<number | null>(null)
  const suggestions = useMemo((): Suggestion[] => {
    if (!auto) return []
    if (auto.kind === 'mention') return suggest(auto.query, users, online, meId)
    const tone = skinTone()
    return searchShortcodes(auto.query, MAX_SUGGESTIONS).map((m) => ({ kind: 'emoji', char: withTone(m.emoji, tone), code: m.code }))
  }, [auto, users, online, meId])
  // A query with a space only stays open while it still matches someone ("@Ana Cl" → "Ana Clara").
  const popupOpen = !!auto && suggestions.length > 0
  const activeIndex = Math.min(active, Math.max(0, suggestions.length - 1))

  /** Re-reads the `@query` / `:query` at the caret (from the DOM, which is current before React re-renders). */
  function updateAuto() {
    const el = ref.current
    let q: AutoQuery | null = null
    if (el && el.selectionStart === el.selectionEnd) {
      const m = findMentionQuery(el.value, el.selectionStart)
      const e = m ? null : findShortcodeQuery(el.value, el.selectionStart)
      q = m ? { kind: 'mention', ...m } : e ? { kind: 'emoji', ...e } : null
    }
    if (!q) dismissedRef.current = null
    const next = q && q.start !== dismissedRef.current && !(q.kind === 'mention' && isCompleteMention(q.query, users)) ? q : null
    if (next?.kind === auto?.kind && next?.start === auto?.start && next?.query === auto?.query) return
    setAuto(next)
    setActive(0)
  }

  /** Text and caret/selection to restore after a programmatic change that couldn't go through execCommand. */
  const selectionRef = useRef<[number, number] | null>(null)
  useLayoutEffect(() => {
    const sel = selectionRef.current
    if (!sel) return
    selectionRef.current = null
    ref.current?.setSelectionRange(sel[0], sel[1])
  }, [value])

  /**
   * Replaces value[start, end) with `insert` and selects `select` (default: caret after the insert). Goes
   * through execCommand when it can, so it's one step of the native undo stack (Ctrl+Z) and fires the usual
   * input event; otherwise (read-only, unsupported) sets the state directly.
   */
  function replaceRange(start: number, end: number, insert: string, select?: [number, number]) {
    const el = ref.current
    const sel = select ?? [start + insert.length, start + insert.length]
    if (el && !el.readOnly) {
      el.focus()
      el.setSelectionRange(start, end)
      if (document.execCommand('insertText', false, insert)) {
        el.setSelectionRange(sel[0], sel[1])
        return
      }
    }
    const cur = el?.value ?? value
    selectionRef.current = sel
    setValue(cur.slice(0, start) + insert + cur.slice(end))
  }

  function pick(s: Suggestion) {
    if (!auto) return
    const el = ref.current
    const caret = el?.selectionStart ?? auto.start + 1 + auto.query.length
    const insert = s.kind === 'everyone' ? `${EVERYONE_TOKEN} ` : s.kind === 'user' ? `@${s.user.name} ` : `${s.char} `
    if (s.kind === 'emoji') noteRecentEmoji(s.char)
    setAuto(null)
    // Swallow a space already after the caret, so "@An| x" doesn't become "@Ana  x".
    replaceRange(auto.start, value[caret] === ' ' ? caret + 1 : caret, insert)
  }

  // ---- emoji picker (button at the right of the box) ----
  const [pickerAnchor, setPickerAnchor] = useState<HTMLElement | null>(null)
  useEffect(() => setPickerAnchor(null), [channelId])

  /** Picked in the emoji picker: goes in at the caret (or over the selection); the picker keeps the focus. */
  function insertEmoji(char: string) {
    const el = ref.current
    if (!el || el.readOnly) return
    const { selectionStart: start, selectionEnd: end } = el
    selectionRef.current = [start + char.length, start + char.length]
    setValue(el.value.slice(0, start) + char + el.value.slice(end))
  }

  function closePicker() {
    const btn = pickerAnchor
    setPickerAnchor(null)
    // Back to typing, unless the click that closed it went to something else that takes focus.
    requestAnimationFrame(() => {
      const a = document.activeElement
      if (!a || a === document.body || a === btn) ref.current?.focus()
    })
  }

  // ---- markdown shortcuts and :shortcode: replacement ----

  /** Wraps the selection in `marker` (or unwraps it when it's already wrapped). Multi-line code gets a fence. */
  function toggleFormat(marker: string) {
    const el = ref.current
    if (!el || el.readOnly) return
    const { selectionStart: s, selectionEnd: t, value: v } = el
    const sel = v.slice(s, t)
    if (marker === '`' && sel.includes('\n')) {
      replaceRange(s, t, `\`\`\`\n${sel}\n\`\`\``, [s + 4, t + 4])
      return
    }
    const n = marker.length
    let wrapped = v.slice(s - n, s) === marker && v.slice(t, t + n) === marker
    if (marker[0] === '*') {
      // `**x**` is bold, not italic inside italic: count the asterisks on both sides.
      let b = 0
      let a = 0
      while (v[s - 1 - b] === '*') b++
      while (v[t + a] === '*') a++
      const run = Math.min(a, b)
      wrapped = marker === '*' ? run % 2 === 1 : run >= 2
    }
    if (wrapped && s >= n) replaceRange(s - n, t + n, sel, [s - n, t - n])
    else replaceRange(s, t, marker + sel + marker, [s + n, t + n])
  }

  /** A word-ending key right after a complete `:joy:` turns it into 😂 first (the key still types). */
  function replaceShortcodeBeforeCaret() {
    const el = ref.current
    if (!el || el.selectionStart !== el.selectionEnd) return
    const hit = shortcodeBefore(el.value, el.selectionStart)
    if (!hit) return
    const char = withTone(hit.emoji, skinTone())
    noteRecentEmoji(char)
    replaceRange(hit.start, el.selectionStart, char)
  }

  useEffect(() => {
    ref.current?.focus()
  }, [channelId])

  useEffect(() => {
    if (value) drafts.set(channelId, value)
    else drafts.delete(channelId)
  }, [channelId, value])

  // Autosize: grow with content up to the CSS max-height.
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight}px`
  }, [value])

  // What goes on the wire: `:joy:` → 😂, `@Name` → `<@id>`. The limit applies to that, not to what's in the box.
  const wire = useMemo(() => editableToContent(replaceShortcodes(value).trim(), users), [value, users])
  const length = wire.length
  const tooLong = length > MAX_MESSAGE_LENGTH
  const failed = images.some((i) => i.status === 'error')
  const canSend = (length > 0 || images.length > 0) && !tooLong && !waiting

  async function send() {
    const text = value.trim()
    if ((!text && images.length === 0) || tooLong || sendingRef.current) return
    if (!connected) {
      toast('Not connected. Your message is still in the box.', 'error')
      return
    }
    sendingRef.current = true
    try {
      let ready: PendingImage[] = []
      if (images.length > 0) {
        setWaiting(true)
        try {
          ready = await settledImages(channelId)
        } finally {
          setWaiting(false)
        }
        if (ready.some((i) => i.status === 'error')) {
          toast('An image failed to upload. Retry or remove it, then send again.', 'error')
          return
        }
        if (!text && ready.length === 0) return // everything was removed while waiting
      }
      const ids = ready.map((i) => i.attachment!.id)
      // Clear the text right away (as before images existed); images stay until the server accepted them.
      const sentText = value
      const content = editableToContent(replaceShortcodes(text).trim(), useApp.getState().users)
      const replyToId = useCompose.getState().replyTo[channelId]
      setValue('')
      setAuto(null)
      if (replyToId) cancelReply()
      lastTypingRef.current = 0
      try {
        await sendMessage(channelId, content, ids, replyToId)
        clearImages(channelId, ready.map((i) => i.key))
      } catch (err) {
        // Put the text (and the reply) back so nothing is lost (unless the user already typed something new).
        setValue((cur) => (cur ? cur : sentText))
        if (replyToId && !useCompose.getState().replyTo[channelId]) useCompose.getState().setReply(channelId, replyToId)
        toast(err, 'error')
      }
    } finally {
      sendingRef.current = false
    }
  }

  /** ArrowUp in an empty box edits your last message here (Discord-like). */
  function editLastOwn(): boolean {
    const st = useApp.getState()
    const items = st.messages[channelId]?.items ?? []
    for (let i = items.length - 1; i >= 0; i--) {
      if (items[i].userId === st.me?.id) {
        useCompose.getState().setEditing(items[i].id)
        return true
      }
    }
    return false
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.nativeEvent.isComposing) return
    if ((e.ctrlKey || e.metaKey) && !e.altKey && !isAppShortcut(e.nativeEvent)) {
      const key = e.key.toLowerCase()
      const marker = e.shiftKey ? (key === 'x' ? '~~' : undefined) : FORMAT_KEYS[key]
      if (marker) {
        e.preventDefault()
        toggleFormat(marker)
        return
      }
    }
    if (WORD_END_RE.test(e.key) && !e.ctrlKey && !e.metaKey && !e.altKey) replaceShortcodeBeforeCaret()
    if (popupOpen) {
      const n = suggestions.length
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        setActive((activeIndex + (e.key === 'ArrowDown' ? 1 : n - 1)) % n)
        return
      }
      if ((e.key === 'Enter' && !e.shiftKey) || (e.key === 'Tab' && !e.shiftKey)) {
        e.preventDefault()
        pick(suggestions[activeIndex])
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        dismissedRef.current = auto!.start
        setAuto(null)
        return
      }
    }
    if (e.key === 'Escape' && replyId) {
      e.preventDefault()
      e.stopPropagation()
      cancelReply()
      return
    }
    if (e.key === 'ArrowUp' && value === '' && !e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey) {
      if (editLastOwn()) e.preventDefault()
      return
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      void send()
    }
  }

  function onChange(next: string) {
    setValue(next)
    updateAuto()
    const now = Date.now()
    if (next.trim() && now - lastTypingRef.current > TYPING_THROTTLE_MS) {
      lastTypingRef.current = now
      emit('typing', { channelId })
    }
  }

  function onPaste(e: ClipboardEvent<HTMLTextAreaElement>) {
    const files = [...e.clipboardData.files]
    if (files.length === 0) return // plain text paste
    const images = files.filter((f) => f.type === '' || f.type.startsWith('image/'))
    if (images.length > 0) {
      // A copied image often comes with an HTML/text version too; the image wins.
      e.preventDefault()
      addImages(channelId, images)
    } else if (!e.clipboardData.types.includes('text/plain')) {
      toast('Only images (PNG, JPEG, WebP, GIF) can be attached', 'error')
    }
  }

  const listId = `mention-list-${channelId}`

  return (
    <div className="composer-wrap">
      {popupOpen && (
        <AutocompletePopup
          id={listId}
          title={auto.kind === 'mention' ? 'Members' : <>Emoji matching <span className="ac-query">:{auto.query}</span></>}
          label={auto.kind === 'mention' ? 'Mention someone' : 'Insert an emoji'}
          items={suggestions}
          active={activeIndex}
          itemKey={suggestionKey}
          renderItem={renderSuggestion}
          onHover={setActive}
          onPick={pick}
        />
      )}
      {pickerAnchor && <EmojiPicker anchor={pickerAnchor} onPick={insertEmoji} onClose={closePicker} label="Insert an emoji" />}
      <div className={`composer ${tooLong ? 'is-invalid' : ''} ${images.length ? 'has-images' : ''} ${replyId ? 'has-reply' : ''}`}>
        {replyId && replyTarget && (
          <div className="composer-reply">
            <ReplyIcon size={14} />
            <span className="composer-reply-text">
              Replying to{' '}
              <strong style={replyAuthor ? { color: replyAuthor.color } : undefined}>{replyAuthor?.name ?? 'unknown-user'}</strong>
            </span>
            <button className="icon-btn composer-reply-close" onClick={cancelReply} aria-label="Cancel reply" title="Cancel reply (Esc)">
              <CloseIcon size={14} />
            </button>
          </div>
        )}
        {images.length > 0 && (
          <ul className="composer-images" aria-label="Images to send">
            {images.map((img) => (
              <PendingThumb key={img.key} img={img} channelId={channelId} />
            ))}
          </ul>
        )}
        <div className="composer-row">
          <button
            className="icon-btn composer-attach"
            onClick={() => fileRef.current?.click()}
            disabled={images.length >= MAX_ATTACHMENTS_PER_MESSAGE}
            aria-label="Attach images"
            title={
              images.length >= MAX_ATTACHMENTS_PER_MESSAGE
                ? `Up to ${MAX_ATTACHMENTS_PER_MESSAGE} images per message`
                : 'Attach images (or paste / drop them)'
            }
          >
            <AttachIcon />
          </button>
          <input
            ref={fileRef}
            type="file"
            accept={ATTACHMENT_TYPES.join(',')}
            multiple
            hidden
            onChange={(e) => {
              addImages(channelId, pickImageFiles(e.target.files))
              e.target.value = '' // allow picking the same file again
              ref.current?.focus()
            }}
          />
          <textarea
            ref={ref}
            className="composer-input"
            value={value}
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={onKeyDown}
            // Caret moved by mouse / arrow keys: the @query (if any) follows it.
            onSelect={updateAuto}
            onBlur={() => setAuto(null)}
            onPaste={onPaste}
            // The text that goes out with the images is the text at the moment Send was pressed.
            readOnly={waiting}
            placeholder={replyId ? `Reply in #${channelName}` : `Message #${channelName}`}
            rows={1}
            spellCheck
            aria-label={`Message #${channelName}`}
            role="combobox"
            aria-expanded={popupOpen}
            aria-controls={popupOpen ? listId : undefined}
            aria-autocomplete="list"
            aria-activedescendant={popupOpen ? `${listId}-${activeIndex}` : undefined}
          />
          <button
            className={`icon-btn composer-emoji ${pickerAnchor ? 'is-active' : ''}`}
            // Keep the caret in the box: the picker gives focus back to it when it closes.
            onMouseDown={(e) => e.preventDefault()}
            onClick={(e) => {
              const btn = e.currentTarget
              setPickerAnchor((cur) => (cur ? null : btn))
            }}
            disabled={waiting}
            aria-label="Emoji"
            aria-haspopup="dialog"
            aria-expanded={!!pickerAnchor}
            title="Emoji (or type :name)"
          >
            <SmileIcon />
          </button>
          {length >= COUNTER_FROM && (
            <span className={`composer-counter ${tooLong ? 'is-over' : ''}`} title={`${MAX_MESSAGE_LENGTH} characters max`}>
              {MAX_MESSAGE_LENGTH - length}
            </span>
          )}
          <button
            className="icon-btn composer-send"
            onClick={() => void send()}
            disabled={!canSend}
            aria-label="Send message"
            title={
              waiting
                ? 'Sending when the images finish uploading…'
                : failed
                  ? 'An image failed to upload: retry or remove it'
                  : 'Send (Enter) · New line (Shift+Enter)'
            }
          >
            {waiting ? <span className="spinner" /> : <SendIcon size={18} />}
          </button>
        </div>
      </div>
    </div>
  )
}

function suggestionKey(s: Suggestion): string {
  return s.kind === 'user' ? s.user.id : s.kind === 'emoji' ? `:${s.code}` : '@everyone'
}

function renderSuggestion(s: Suggestion) {
  switch (s.kind) {
    case 'user':
      return (
        <>
          <Avatar user={s.user} size={24} online={s.online} />
          <span className="mention-option-name" style={{ color: s.user.color }}>
            {s.user.name}
          </span>
          {!s.online && <span className="mention-option-hint">offline</span>}
        </>
      )
    case 'everyone':
      return (
        <>
          <span className="mention-option-at" aria-hidden="true">
            @
          </span>
          <span className="mention-option-name">@everyone</span>
          <span className="mention-option-hint">Notify everyone</span>
        </>
      )
    case 'emoji':
      return (
        <>
          <span className="ac-emoji" aria-hidden="true">
            {s.char}
          </span>
          <span className="mention-option-name">:{s.code}:</span>
        </>
      )
  }
}

function PendingThumb({ img, channelId }: { img: PendingImage; channelId: string }) {
  const pct = Math.round(img.progress * 100)
  return (
    <li className={`composer-thumb is-${img.status}`} title={img.error ?? img.name}>
      <img src={img.previewUrl} alt={img.name} draggable={false} />
      {img.status === 'uploading' && (
        <div
          className="composer-thumb-progress"
          role="progressbar"
          aria-label={`Uploading ${img.name}`}
          aria-valuenow={pct}
          aria-valuemin={0}
          aria-valuemax={100}
        >
          <span style={{ width: `${Math.max(4, pct)}%` }} />
        </div>
      )}
      {img.status === 'error' && (
        <div className="composer-thumb-error">
          <button className="icon-btn" onClick={() => retryImage(channelId, img.key)} aria-label={`Retry uploading ${img.name}`} title={`Retry: ${img.error}`}>
            <RetryIcon />
          </button>
        </div>
      )}
      <button
        className="composer-thumb-remove"
        onClick={() => removeImage(channelId, img.key)}
        aria-label={`Remove ${img.name}`}
        title="Remove"
      >
        <CloseIcon size={12} />
      </button>
    </li>
  )
}
