import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react'
import { MAX_MESSAGE_LENGTH } from '@shared/protocol'
import { useApp } from '../store/app'
import { emit } from '../net/socket'
import { toast } from '../lib/toast'
import { SendIcon } from './icons'

const TYPING_THROTTLE_MS = 2500
const COUNTER_FROM = MAX_MESSAGE_LENGTH - 500
/** Unsent drafts per channel (kept for the app session). */
const drafts = new Map<string, string>()

export function Composer({ channelId, channelName }: { channelId: string; channelName: string }) {
  const sendMessage = useApp((s) => s.sendMessage)
  const connected = useApp((s) => s.connection === 'connected')
  const [value, setValue] = useState(() => drafts.get(channelId) ?? '')
  const ref = useRef<HTMLTextAreaElement>(null)
  const lastTypingRef = useRef(0)

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

  async function send() {
    const text = value.trim()
    if (!text || tooLong) return
    if (!connected) {
      toast('Not connected — your message is still in the box.', 'error')
      return
    }
    setValue('')
    lastTypingRef.current = 0
    try {
      await sendMessage(channelId, text)
    } catch (err) {
      // Put the text back so nothing is lost (unless the user already typed something new).
      setValue((cur) => (cur ? cur : text))
      toast(err, 'error')
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

  return (
    <div className={`composer ${tooLong ? 'is-invalid' : ''}`}>
      <textarea
        ref={ref}
        className="composer-input"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onKeyDown}
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
        disabled={!length || tooLong}
        aria-label="Send message"
        title="Send (Enter) · New line (Shift+Enter)"
      >
        <SendIcon size={18} />
      </button>
    </div>
  )
}
