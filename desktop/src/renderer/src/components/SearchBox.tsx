// Search box in the center header (Ctrl/Cmd+F focuses it). Enter searches and opens the results panel
// (SearchPanel). Filters: `from:Name` and `in:#channel`, completed from a popup like the composer's @.
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import type { Channel, User } from '@shared/protocol'
import { SEARCH_QUERY_MAX } from '@shared/protocol'
import { useApp } from '../store/app'
import { useChatPanels } from '../store/chatPanels'
import { toast } from '../lib/toast'
import { msg, useT, type Translate } from '../i18n'
import {
  findTextChannelByName,
  findUserByName,
  fromToken,
  matchTextChannels,
  matchUsers,
  parseSearch,
  tokenAtCaret,
} from '../lib/searchQuery'
import { AutocompletePopup } from './AutocompletePopup'
import { Avatar } from './Avatar'
import { CloseIcon, HashIcon, SearchIcon } from './icons'
import '../styles/composer-extras.css'

const MAX_SUGGESTIONS = 8

type Suggestion =
  | { kind: 'user'; user: User }
  | { kind: 'channel'; channel: Channel }
  /** `label` is the filter keyword (never translated), `hint` a message key. */
  | { kind: 'option'; insert: string; label: string; hint: string }

const OPTIONS: Suggestion[] = [
  { kind: 'option', insert: 'from:', label: 'from:', hint: msg('user // search filter') },
  { kind: 'option', insert: 'in:#', label: 'in:', hint: msg('channel // search filter') },
]

const suggestionKey = (s: Suggestion) => (s.kind === 'user' ? `u${s.user.id}` : s.kind === 'channel' ? `c${s.channel.id}` : `o${s.insert}`)

function renderSuggestion(s: Suggestion, t: Translate) {
  if (s.kind === 'user')
    return (
      <>
        <Avatar user={s.user} size={24} />
        <span className="mention-option-name">{s.user.name}</span>
      </>
    )
  if (s.kind === 'channel')
    return (
      <>
        <HashIcon size={16} />
        <span className="mention-option-name">{s.channel.name}</span>
      </>
    )
  return (
    <>
      <span className="mention-option-name search-option-key">{s.label}</span>
      <span className="search-option-hint">{t(s.hint)}</span>
    </>
  )
}

export function SearchBox() {
  const t = useT()
  const users = useApp((s) => s.users)
  const channels = useApp((s) => s.channels)
  const panelOpen = useChatPanels((s) => s.panel === 'search')
  const focusNonce = useChatPanels((s) => s.focusSearchNonce)
  const inputRef = useRef<HTMLInputElement>(null)
  const [value, setValue] = useState('')
  const [caret, setCaret] = useState(0)
  const [focused, setFocused] = useState(false)
  const [active, setActive] = useState(0)
  /** Escape hid the popup; it comes back on the next edit. */
  const [dismissed, setDismissed] = useState(false)

  useEffect(() => {
    if (!focusNonce) return
    const el = inputRef.current
    if (!el) return
    el.focus()
    el.select()
  }, [focusNonce])

  const token = focused && !dismissed ? tokenAtCaret(value, caret) : null
  const suggestions = useMemo<Suggestion[]>(() => {
    if (!token) return []
    if (token.kind === 'options') return OPTIONS
    if (token.kind === 'from') return matchUsers(users, token.partial, MAX_SUGGESTIONS).map((user) => ({ kind: 'user', user }))
    return matchTextChannels(channels, token.partial, MAX_SUGGESTIONS).map((channel) => ({ kind: 'channel', channel }))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token?.kind, token?.partial, users, channels])
  const popupOpen = suggestions.length > 0
  const activeIndex = Math.min(active, Math.max(0, suggestions.length - 1))

  function edit(next: string, nextCaret: number) {
    setValue(next)
    setCaret(nextCaret)
    setActive(0)
    setDismissed(false)
  }

  function pick(s: Suggestion) {
    if (!token) return
    const insert =
      s.kind === 'user' ? `${fromToken(s.user.name)} ` : s.kind === 'channel' ? `in:#${s.channel.name} ` : s.insert
    // Replace the token up to the caret, and the rest of its word after the caret.
    const restMatch = /^\S*/.exec(value.slice(caret))
    const end = caret + (s.kind === 'option' ? 0 : (restMatch?.[0].length ?? 0))
    const next = value.slice(0, token.start) + insert + value.slice(end).replace(/^\s+/, '')
    const pos = token.start + insert.length
    edit(next, pos)
    requestAnimationFrame(() => inputRef.current?.setSelectionRange(pos, pos))
  }

  function submit() {
    const p = parseSearch(value)
    const app = useApp.getState()
    let authorId: string | undefined
    let channelId: string | undefined
    if (p.from !== null) {
      const u = findUserByName(app.users, p.from)
      if (!u) {
        toast(p.from ? t('No member named "{name}"', { name: p.from }) : t('Type a name after from:'), 'error')
        return
      }
      authorId = u.id
    }
    if (p.in !== null) {
      const c = findTextChannelByName(app.channels, p.in)
      if (!c) {
        toast(p.in ? t('No text channel named #{channel}', { channel: p.in }) : t('Type a channel after in:'), 'error')
        return
      }
      channelId = c.id
    }
    if (!p.text && !authorId) {
      toast(channelId ? t('Add some words or a from: filter to search') : t('Type something to search for'), 'info')
      return
    }
    if (p.text.length > SEARCH_QUERY_MAX) {
      toast(t('Search is limited to {count} characters', { count: SEARCH_QUERY_MAX }), 'error')
      return
    }
    const panels = useChatPanels.getState()
    const selected = app.channels.find((c) => c.id === app.selectedChannelId)
    const scopeChannelId = !channelId && panels.thisChannelOnly && selected?.type === 'text' ? selected.id : undefined
    void panels.runSearch({ text: p.text, authorId, channelId, scopeChannelId })
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.nativeEvent.isComposing) return
    if (popupOpen) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        const n = suggestions.length
        setActive((activeIndex + (e.key === 'ArrowDown' ? 1 : n - 1)) % n)
        return
      }
      // Enter completes a filter being typed; in the empty-box options it searches nothing, so it picks too.
      if ((e.key === 'Enter' || e.key === 'Tab') && !e.shiftKey) {
        e.preventDefault()
        pick(suggestions[activeIndex])
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        setDismissed(true)
        return
      }
    }
    if (e.key === 'Enter') {
      e.preventDefault()
      submit()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      if (panelOpen) useChatPanels.getState().openPanel(null)
      inputRef.current?.blur()
    }
  }

  function clear() {
    edit('', 0)
    if (panelOpen) useChatPanels.getState().openPanel(null)
    inputRef.current?.focus()
  }

  const listId = 'search-suggest'
  return (
    <div className={`search-box ${focused ? 'is-focused' : ''} ${value ? 'has-value' : ''}`} role="search">
      <input
        ref={inputRef}
        className="search-input"
        type="text"
        value={value}
        placeholder={t('Search')}
        aria-label={t('Search messages')}
        aria-autocomplete="list"
        aria-controls={popupOpen ? listId : undefined}
        aria-activedescendant={popupOpen ? `${listId}-${activeIndex}` : undefined}
        spellCheck={false}
        maxLength={SEARCH_QUERY_MAX + 120}
        onChange={(e) => edit(e.target.value, e.target.selectionStart ?? e.target.value.length)}
        onSelect={(e) => setCaret(e.currentTarget.selectionStart ?? 0)}
        onFocus={() => setFocused(true)}
        onBlur={() => {
          setFocused(false)
          setDismissed(false)
        }}
        onKeyDown={onKeyDown}
      />
      {value ? (
        <button type="button" className="search-box-icon is-clear" onClick={clear} aria-label={t('Clear search')} title={t('Clear search')}>
          <CloseIcon size={14} />
        </button>
      ) : (
        <span className="search-box-icon" aria-hidden="true">
          <SearchIcon size={15} />
        </span>
      )}
      {popupOpen && (
        <AutocompletePopup
          id={listId}
          title={token?.kind === 'from' ? t('From user') : token?.kind === 'in' ? t('In channel') : t('Search options')}
          label={t('Search suggestions')}
          items={suggestions}
          active={activeIndex}
          itemKey={suggestionKey}
          renderItem={(s) => renderSuggestion(s, t)}
          onHover={setActive}
          onPick={pick}
        />
      )}
    </div>
  )
}
