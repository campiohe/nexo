// Your status: Online / Idle / Do not disturb (kept per device, store/presence.ts) and the custom status
// text (on the server, `profile:update { statusText }`). Shown as a popover from the user panel's avatar,
// inline on your own profile card, and the text also in Settings → Profile.
import { useEffect, useRef, useState, type FormEvent } from 'react'
import type { PresenceStatus } from '@shared/protocol'
import { STATUS_TEXT_MAX } from '@shared/protocol'
import { useApp } from '../store/app'
import { setManualStatus, STATUS_LABEL, usePresenceStore } from '../store/presence'
import { useUi, type AnchorRect } from '../store/ui'
import { supportsStatusText, updateStatusText } from '../lib/presenceSync'
import { toast } from '../lib/toast'
import { Floating } from './Floating'
import { CheckIcon, CloseIcon } from './icons'
import { SmileIcon, StatusDot } from './peopleIcons'
import { msg, useT } from '../i18n'
import '../styles/people.css'

/** `hint` is a message key (msg), translated where shown. */
const OPTIONS: { status: PresenceStatus; hint: string }[] = [
  { status: 'online', hint: '' },
  { status: 'idle', hint: msg('Shows you as away. Nexo also does this by itself after 10 minutes without input.') },
  { status: 'dnd', hint: msg("You won't get notification popups or sounds. Wake-ups still ring.") },
]

/** The three statuses; the one you picked is checked (auto-idle doesn't change your pick). */
export function StatusOptions({ onPicked }: { onPicked?(): void }) {
  const t = useT()
  const manual = usePresenceStore((s) => s.manual)
  return (
    <div className="status-options" role="radiogroup" aria-label={t('Status')}>
      {OPTIONS.map((o) => (
        <button
          key={o.status}
          type="button"
          role="radio"
          aria-checked={manual === o.status}
          className={`status-option ${manual === o.status ? 'is-active' : ''}`}
          onClick={() => {
            setManualStatus(o.status)
            onPicked?.()
          }}
        >
          <StatusDot status={o.status} />
          <span className="status-option-text">
            <span className="status-option-label">{t(STATUS_LABEL[o.status])}</span>
            {o.hint && <span className="status-option-hint">{t(o.hint)}</span>}
          </span>
          {manual === o.status && <CheckIcon size={14} className="status-option-check" />}
        </button>
      ))}
    </div>
  )
}

/** "Set a custom status" row that turns into an inline input. Hidden on servers without custom status. */
export function CustomStatusEditor({ startEditing = false }: { startEditing?: boolean }) {
  const t = useT()
  const me = useApp((s) => s.me)
  const connected = useApp((s) => s.connection === 'connected')
  const current = me?.statusText ?? ''
  const [editing, setEditing] = useState(startEditing)
  const [value, setValue] = useState(current)
  const [busy, setBusy] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (editing) {
      inputRef.current?.focus()
      inputRef.current?.select()
    }
  }, [editing])

  if (!supportsStatusText(me)) return null

  async function save(text: string | null) {
    if (busy) return
    if ((text?.trim() ?? '') === current) {
      setEditing(false)
      return
    }
    setBusy(true)
    try {
      const user = await updateStatusText(text)
      setValue(user.statusText ?? '')
      setEditing(false)
    } catch (err) {
      toast(err, 'error')
      inputRef.current?.focus()
    } finally {
      setBusy(false)
    }
  }

  if (!editing) {
    return (
      <div className="custom-status">
        <button
          type="button"
          className={`custom-status-show ${current ? 'has-text' : ''}`}
          onClick={() => {
            setValue(current)
            setEditing(true)
          }}
          disabled={!connected}
          title={current ? t('Edit custom status') : undefined}
        >
          <SmileIcon size={15} />
          <span className="custom-status-text">{current || t('Set a custom status')}</span>
        </button>
        {current && (
          <button
            type="button"
            className="icon-btn custom-status-clear"
            onClick={() => void save(null)}
            disabled={busy || !connected}
            aria-label={t('Clear custom status')}
            title={t('Clear custom status')}
          >
            <CloseIcon size={14} />
          </button>
        )}
      </div>
    )
  }

  const submit = (e: FormEvent) => {
    e.preventDefault()
    void save(value)
  }
  return (
    <form className="custom-status-form" onSubmit={submit}>
      <input
        ref={inputRef}
        className="input input-sm"
        value={value}
        maxLength={STATUS_TEXT_MAX}
        placeholder={t("What's up?")}
        aria-label={t('Custom status')}
        disabled={busy}
        // Floating cards leave Escape to this input: it cancels the edit only.
        data-own-escape=""
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault()
            e.stopPropagation()
            setEditing(false)
          }
        }}
      />
      <div className="custom-status-form-row">
        <span className="custom-status-count">
          {value.length}/{STATUS_TEXT_MAX}
        </span>
        {value && (
          <button type="button" className="btn btn-ghost btn-xs" onClick={() => setValue('')} disabled={busy}>
            {t('Clear')}
          </button>
        )}
        <button type="button" className="btn btn-ghost btn-xs" onClick={() => setEditing(false)} disabled={busy}>
          {t('Cancel')}
        </button>
        <button type="submit" className="btn btn-primary btn-xs" disabled={busy}>
          {t('Save')}
        </button>
      </div>
    </form>
  )
}

/** The user panel's status menu (opened from its avatar). */
export function StatusMenuPopover({ anchor }: { anchor: AnchorRect }) {
  const t = useT()
  const close = () => useUi.getState().openStatusMenu(false)
  return (
    <Floating anchor={anchor} side="top" onClose={close} className="status-menu" label={t('Set your status')}>
      <CustomStatusEditor />
      <StatusOptions onPicked={close} />
    </Floating>
  )
}

/** Settings → Profile. */
export function CustomStatusField() {
  const t = useT()
  const me = useApp((s) => s.me)
  if (!supportsStatusText(me)) return null
  return (
    <div className="field">
      <span className="field-label">{t('Custom status')}</span>
      <CustomStatusEditor />
      <span className="field-hint">{t('Shown under your name in the member list and on your profile card.')}</span>
    </div>
  )
}
