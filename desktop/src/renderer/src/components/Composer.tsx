import { useEffect, useLayoutEffect, useRef, useState, type ClipboardEvent, type KeyboardEvent } from 'react'
import { ATTACHMENT_TYPES, MAX_ATTACHMENTS_PER_MESSAGE, MAX_MESSAGE_LENGTH } from '@shared/protocol'
import { useApp } from '../store/app'
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
import { CloseIcon, SendIcon } from './icons'

const TYPING_THROTTLE_MS = 2500
const COUNTER_FROM = MAX_MESSAGE_LENGTH - 500
/** Unsent drafts per channel (kept for the app session). */
const drafts = new Map<string, string>()
const NO_IMAGES: PendingImage[] = []

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

export function Composer({ channelId, channelName }: { channelId: string; channelName: string }) {
  const sendMessage = useApp((s) => s.sendMessage)
  const connected = useApp((s) => s.connection === 'connected')
  const images = usePendingImages((s) => s.byChannel[channelId] ?? NO_IMAGES)
  const [value, setValue] = useState(() => drafts.get(channelId) ?? '')
  /** Waiting for uploads to finish before sending. */
  const [waiting, setWaiting] = useState(false)
  const ref = useRef<HTMLTextAreaElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const lastTypingRef = useRef(0)
  const sendingRef = useRef(false)

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

  const length = value.trim().length
  const tooLong = length > MAX_MESSAGE_LENGTH
  const failed = images.some((i) => i.status === 'error')
  const canSend = (length > 0 || images.length > 0) && !tooLong && !waiting

  async function send() {
    const text = value.trim()
    if ((!text && images.length === 0) || tooLong || sendingRef.current) return
    if (!connected) {
      toast('Not connected — your message is still in the box.', 'error')
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
      setValue('')
      lastTypingRef.current = 0
      try {
        await sendMessage(channelId, text, ids)
        clearImages(channelId, ready.map((i) => i.key))
      } catch (err) {
        // Put the text back so nothing is lost (unless the user already typed something new).
        setValue((cur) => (cur ? cur : sentText))
        toast(err, 'error')
      }
    } finally {
      sendingRef.current = false
    }
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      void send()
    }
  }

  function onChange(next: string) {
    setValue(next)
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

  return (
    <div className={`composer ${tooLong ? 'is-invalid' : ''} ${images.length ? 'has-images' : ''}`}>
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
          onPaste={onPaste}
          // The text that goes out with the images is the text at the moment Send was pressed.
          readOnly={waiting}
          placeholder={`Message #${channelName}`}
          rows={1}
          spellCheck
          aria-label={`Message #${channelName}`}
        />
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
  )
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
          <button className="icon-btn" onClick={() => retryImage(channelId, img.key)} aria-label={`Retry uploading ${img.name}`} title={`${img.error} — retry`}>
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
