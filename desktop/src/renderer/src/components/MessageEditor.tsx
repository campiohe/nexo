// Inline editor that replaces a message's text while editing (one at a time: store/compose editingId).
// Mentions show as "@Name" while editing (lib/mentions) and go back to `<@id>` on save. Enter saves,
// Shift+Enter is a newline, Escape cancels. Emptying a text-only message asks to delete it instead.
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react'
import type { Message } from '@shared/protocol'
import { MAX_MESSAGE_LENGTH } from '@shared/protocol'
import { useApp } from '../store/app'
import { useCompose } from '../store/compose'
import { contentToEditable, editableToContent } from '../lib/mentions'
import { toast } from '../lib/toast'
import { useT } from '../i18n'

const MAX_HEIGHT_PX = 320

export function MessageEditor({ msg, onDelete }: { msg: Message; onDelete(m: Message): void }) {
  const t = useT()
  const ref = useRef<HTMLTextAreaElement>(null)
  // The text as first shown. `@Name` -> `<@id>` isn't always reversible (names that prefix other names, a
  // name followed by letters), so an unchanged editor must close without saving, or it could re-target
  // or drop a mention.
  const [initial] = useState(() => contentToEditable(msg.content, useApp.getState().users))
  const [text, setText] = useState(initial)
  const [saving, setSaving] = useState(false)
  const users = useApp((s) => s.users)
  // The server limits the wire content (`<@id>` tokens), not the `@Name` text.
  const over = editableToContent(text, users).trim().length > MAX_MESSAGE_LENGTH

  function close() {
    if (useCompose.getState().editingId === msg.id) useCompose.getState().setEditing(null)
    useCompose.getState().focusComposer(msg.channelId)
  }

  async function save() {
    if (saving) return
    if (text.trim() === initial.trim()) return close()
    const content = editableToContent(text, useApp.getState().users).trim()
    if (content === msg.content.trim()) return close()
    if (!content && !msg.attachments?.length) {
      close()
      onDelete(msg)
      return
    }
    setSaving(true)
    try {
      await useApp.getState().editMessage(msg.id, content)
      close()
    } catch (err) {
      toast(err, 'error')
      setSaving(false)
    }
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.nativeEvent.isComposing) return
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      void save()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      close()
    }
  }

  // Auto-grow up to a cap, then scroll inside.
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, MAX_HEIGHT_PX)}px`
  }, [text])

  // Focus with the caret at the end, and bring the editor into view (ArrowUp may edit an off-screen message).
  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.focus({ preventScroll: true })
    el.setSelectionRange(el.value.length, el.value.length)
    el.closest('.message')?.scrollIntoView({ block: 'nearest' })
  }, [])

  return (
    <div className="message-editor">
      <div className={`message-editor-box ${over ? 'is-invalid' : ''}`}>
        <textarea
          ref={ref}
          className="message-editor-input"
          value={text}
          rows={1}
          disabled={saving}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          aria-label={t('Edit message')}
          spellCheck
        />
      </div>
      <div className="message-editor-hint">
        {t.rich('escape to <cancel>cancel</cancel> • enter to <save>save</save>', {
          cancel: (c) => (
            <button className="message-editor-link" onClick={close}>
              {c}
            </button>
          ),
          save: (c) => (
            <button className="message-editor-link" onClick={() => void save()} disabled={saving}>
              {c}
            </button>
          ),
        })}
        {over && (
          <span className="message-editor-over">
            {' '}
            • {text.trim().length}/{MAX_MESSAGE_LENGTH}
          </span>
        )}
      </div>
    </div>
  )
}
