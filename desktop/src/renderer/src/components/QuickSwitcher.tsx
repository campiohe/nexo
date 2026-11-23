import { useMemo, useState, type KeyboardEvent } from 'react'
import { useApp } from '../store/app'
import { useUi } from '../store/ui'
import { Modal } from './Modal'
import { openChannel } from './Sidebar'
import { HashIcon, SpeakerIcon } from './icons'
import { isUnread, useUnread } from '../store/unread'
import { useT } from '../i18n'

/** Ctrl+K channel switcher. */
export function QuickSwitcher() {
  const open = useUi((s) => s.switcherOpen)
  if (!open) return null
  return <SwitcherInner />
}

function SwitcherInner() {
  const channels = useApp((s) => s.channels)
  const [query, setQuery] = useState('')
  const [index, setIndex] = useState(0)
  const close = () => useUi.getState().openSwitcher(false)
  const t = useT()

  const results = useMemo(() => {
    const q = query.trim().toLowerCase().replace(/^#/, '')
    if (!q) return channels
    return channels
      .filter((c) => c.name.toLowerCase().includes(q))
      .sort((a, b) => Number(!a.name.toLowerCase().startsWith(q)) - Number(!b.name.toLowerCase().startsWith(q)))
  }, [channels, query])

  const pick = (i: number) => {
    const c = results[i]
    if (!c) return
    close()
    openChannel(c)
  }

  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setIndex((i) => Math.min(results.length - 1, i + 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setIndex((i) => Math.max(0, i - 1))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      pick(index)
    }
  }

  return (
    <Modal title={t('Jump to a channel')} onClose={close} width={460} className="switcher">
      <input
        className="input"
        data-autofocus
        value={query}
        onChange={(e) => {
          setQuery(e.target.value)
          setIndex(0)
        }}
        onKeyDown={onKey}
        placeholder={t('Search channels…')}
        aria-label={t('Search channels')}
      />
      <ul className="switcher-list" role="listbox">
        {results.map((c, i) => (
          <li key={c.id}>
            <button
              role="option"
              aria-selected={i === index}
              className={`switcher-item ${i === index ? 'is-active' : ''}`}
              onMouseEnter={() => setIndex(i)}
              onClick={() => pick(i)}
            >
              {c.type === 'text' ? <HashIcon size={16} /> : <SpeakerIcon size={16} />}
              <span>{c.name}</span>
              {c.type === 'text' && <UnreadDot channelId={c.id} />}
              <span className="switcher-kind">{c.type === 'text' ? t('Text') : t('Voice — joins')}</span>
            </button>
          </li>
        ))}
        {results.length === 0 && <li className="switcher-empty muted">{t('No channels match “{query}”.', { query })}</li>}
      </ul>
    </Modal>
  )
}

function UnreadDot({ channelId }: { channelId: string }) {
  const unread = useUnread((s) => isUnread(s, channelId))
  const t = useT()
  if (!unread) return null
  return <span className="unread-dot" title={t('Unread messages')} aria-label={t('Unread messages')} role="img" />
}
