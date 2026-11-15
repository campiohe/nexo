// Emoji picker popover (reactions now, the composer later). Offline data from lib/emoji.ts: search, a
// "Recent" row, categories with tabs, skin tones. Portals to <body>, opens next to `anchor` (below it,
// or above when there's no room), stays inside the viewport, closes on outside click / Escape / window
// resize. Shift+click picks without closing. Arrow keys move between emoji; Enter in the search picks
// the first result.
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import {
  emojiCategories,
  findEmoji,
  noteRecentEmoji,
  recentEmoji,
  searchEmoji,
  setSkinTone,
  skinTone,
  SKIN_TONE_LABELS,
  SKIN_TONES,
  withTone,
  type Emoji,
} from '../lib/emoji'
import { SearchIcon } from './icons'

export interface EmojiPickerProps {
  /** The element it opens next to (e.g. the button that opened it). Clicks on it don't count as "outside". */
  anchor: HTMLElement
  /** Called with the chosen emoji (skin tone applied). */
  onPick(emoji: string): void
  onClose(): void
  /** Accessible name of the dialog. */
  label?: string
}

const MARGIN = 8
const GAP = 4

interface Section {
  id: string
  label: string
  /** Emoji to show, already toned. */
  items: { char: string; name: string }[]
}

export function EmojiPicker({ anchor, onPick, onClose, label = 'Choose an emoji' }: EmojiPickerProps) {
  const ref = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const closeRef = useRef(onClose)
  closeRef.current = onClose
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)
  const [query, setQuery] = useState('')
  const [tone, setTone] = useState(skinTone)
  const [toneOpen, setToneOpen] = useState(false)
  const [recent] = useState(recentEmoji)
  const [active, setActive] = useState<string>('')
  const [preview, setPreview] = useState<{ char: string; name: string } | null>(null)

  const sections = useMemo<Section[]>(() => {
    const toned = (e: Emoji) => ({ char: withTone(e, tone), name: e.name })
    if (query.trim()) return [{ id: 'search', label: 'Search results', items: searchEmoji(query).map(toned) }]
    const out: Section[] = []
    if (recent.length)
      out.push({
        id: 'recent',
        label: 'Recent',
        items: recent.map((char) => ({ char, name: findEmoji(char)?.name ?? char })),
      })
    for (const c of emojiCategories()) out.push({ id: c.id, label: c.label, items: c.emojis.map(toned) })
    return out
  }, [query, tone, recent])

  // Place next to the anchor: below, right edges aligned; above when it doesn't fit; clamped.
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const a = anchor.getBoundingClientRect()
    const { width, height } = el.getBoundingClientRect()
    const vw = window.innerWidth
    const vh = window.innerHeight
    let left = a.right - width
    let top = a.bottom + GAP
    if (top + height > vh - MARGIN && a.top - GAP - height >= MARGIN) top = a.top - GAP - height
    left = Math.max(MARGIN, Math.min(left, vw - width - MARGIN))
    top = Math.max(MARGIN, Math.min(top, vh - height - MARGIN))
    setPos({ left, top })
  }, [anchor])

  useEffect(() => {
    const onPointer = (e: PointerEvent) => {
      const t = e.target
      if (t instanceof Node && (ref.current?.contains(t) || anchor.contains(t))) return
      closeRef.current()
    }
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      e.stopPropagation()
      closeRef.current()
    }
    const onResize = () => closeRef.current()
    document.addEventListener('pointerdown', onPointer, true)
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('resize', onResize)
    window.addEventListener('blur', onResize)
    return () => {
      document.removeEventListener('pointerdown', onPointer, true)
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('resize', onResize)
      window.removeEventListener('blur', onResize)
    }
  }, [anchor])

  // Give focus back to where it was (if it's still in the picker or nowhere) on close.
  useEffect(() => {
    const prev = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const picker = ref.current
    return () => {
      const now = document.activeElement
      if (prev?.isConnected && (!now || now === document.body || picker?.contains(now))) prev.focus({ preventScroll: true })
    }
  }, [])

  // Focus the search once the picker is placed: until then it's `visibility: hidden`, which can't take focus.
  const placed = pos !== null
  useEffect(() => {
    if (placed) searchRef.current?.focus({ preventScroll: true })
  }, [placed])

  function pick(char: string, keepOpen: boolean) {
    noteRecentEmoji(char)
    onPick(char)
    if (!keepOpen) closeRef.current()
  }

  // Highlight the tab of the section at the top of the scroll area.
  function onScroll() {
    const sc = scrollRef.current
    if (!sc) return
    let current = sections[0]?.id ?? ''
    for (const s of sc.querySelectorAll<HTMLElement>('[data-section]')) {
      if (s.offsetTop - sc.offsetTop <= sc.scrollTop + 8) current = s.dataset.section ?? current
    }
    if (current !== active) setActive(current)
  }

  function jumpTo(id: string) {
    const sc = scrollRef.current
    const s = sc?.querySelector<HTMLElement>(`[data-section="${id}"]`)
    if (!sc || !s) return
    sc.scrollTop = s.offsetTop - sc.offsetTop
    setActive(id)
  }

  function buttons(): HTMLButtonElement[] {
    return [...(scrollRef.current?.querySelectorAll<HTMLButtonElement>('.ep-emoji') ?? [])]
  }

  function onSearchKey(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter') {
      const first = sections[0]?.items[0]
      if (query.trim() && first) {
        e.preventDefault()
        pick(first.char, e.shiftKey)
      }
    } else if (e.key === 'ArrowDown') {
      const first = buttons()[0]
      if (first) {
        e.preventDefault()
        first.focus()
      }
    }
  }

  // Arrow keys in the grid: left/right by one, up/down to the nearest emoji in the row above/below.
  function onGridKey(e: KeyboardEvent<HTMLDivElement>) {
    const cur = e.target
    if (!(cur instanceof HTMLButtonElement) || !cur.classList.contains('ep-emoji')) return
    const all = buttons()
    const i = all.indexOf(cur)
    let next: HTMLButtonElement | undefined
    if (e.key === 'ArrowRight') next = all[i + 1]
    else if (e.key === 'ArrowLeft') next = all[i - 1]
    else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      const r = cur.getBoundingClientRect()
      const down = e.key === 'ArrowDown'
      let bestRow = down ? Infinity : -Infinity
      let best: HTMLButtonElement | undefined
      let bestDx = Infinity
      for (const b of all) {
        const br = b.getBoundingClientRect()
        const isNextRow = down ? br.top > r.top + 4 && br.top <= bestRow : br.top < r.top - 4 && br.top >= bestRow
        if (!isNextRow) continue
        const dx = Math.abs(br.left - r.left)
        if (br.top !== bestRow) {
          bestRow = br.top
          bestDx = Infinity
        }
        if (dx < bestDx) {
          bestDx = dx
          best = b
        }
      }
      next = best
      if (!next && !down) {
        e.preventDefault()
        searchRef.current?.focus()
        return
      }
    } else return
    e.preventDefault()
    if (next) {
      next.focus()
      next.scrollIntoView({ block: 'nearest' })
    }
  }

  const tabs = query.trim()
    ? []
    : [
        ...(recent.length ? [{ id: 'recent', label: 'Recent', icon: '🕘' }] : []),
        ...emojiCategories().map((c) => ({ id: c.id, label: c.label, icon: c.icon })),
      ]
  const activeTab = active || tabs[0]?.id
  const toneSample = withTone({ char: '✋', name: '', search: '', tone: true }, tone)

  return createPortal(
    <div
      ref={ref}
      className="emoji-picker"
      role="dialog"
      aria-label={label}
      style={pos ? { left: pos.left, top: pos.top } : { left: 0, top: 0, visibility: 'hidden' }}
      onContextMenu={(e) => e.preventDefault()}
    >
      <div className="ep-head">
        <label className="ep-search">
          <SearchIcon size={15} />
          <input
            ref={searchRef}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value)
              scrollRef.current?.scrollTo({ top: 0 })
            }}
            onKeyDown={onSearchKey}
            placeholder="Search emoji"
            aria-label="Search emoji"
            spellCheck={false}
          />
        </label>
        <div className="ep-tone">
          <button
            className="ep-tone-btn"
            onClick={() => setToneOpen((o) => !o)}
            title={`Skin tone: ${SKIN_TONE_LABELS[tone]}`}
            aria-label={`Skin tone: ${SKIN_TONE_LABELS[tone]}`}
            aria-expanded={toneOpen}
          >
            {toneSample}
          </button>
          {toneOpen && (
            <div className="ep-tone-menu" role="listbox" aria-label="Skin tone">
              {SKIN_TONES.map((_, t) => (
                <button
                  key={t}
                  role="option"
                  aria-selected={t === tone}
                  className={`ep-tone-opt ${t === tone ? 'is-active' : ''}`}
                  title={SKIN_TONE_LABELS[t]}
                  aria-label={SKIN_TONE_LABELS[t]}
                  onClick={() => {
                    setTone(t)
                    setSkinTone(t)
                    setToneOpen(false)
                  }}
                >
                  {withTone({ char: '✋', name: '', search: '', tone: true }, t)}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
      {tabs.length > 0 && (
        <nav className="ep-tabs" aria-label="Emoji categories">
          {tabs.map((t) => (
            <button
              key={t.id}
              className={`ep-tab ${t.id === activeTab ? 'is-active' : ''}`}
              title={t.label}
              aria-label={t.label}
              onClick={() => jumpTo(t.id)}
            >
              {t.icon}
            </button>
          ))}
        </nav>
      )}
      <div
        className="ep-scroll"
        ref={scrollRef}
        onScroll={onScroll}
        onKeyDown={onGridKey}
        onMouseOver={(e) => {
          const b = (e.target as HTMLElement).closest<HTMLButtonElement>('.ep-emoji')
          if (b?.dataset.e && b.dataset.e !== preview?.char) setPreview({ char: b.dataset.e, name: b.dataset.name ?? '' })
        }}
        onFocus={(e) => {
          const b = e.target
          if (b instanceof HTMLButtonElement && b.dataset.e) setPreview({ char: b.dataset.e, name: b.dataset.name ?? '' })
        }}
        onClick={(e) => {
          const b = (e.target as HTMLElement).closest<HTMLButtonElement>('.ep-emoji')
          if (b?.dataset.e) pick(b.dataset.e, e.shiftKey)
        }}
      >
        <EmojiSections sections={sections} />
      </div>
      <div className="ep-foot" aria-hidden="true">
        {preview ? (
          <>
            <span className="ep-foot-emoji">{preview.char}</span>
            <span className="ep-foot-name">{preview.name}</span>
          </>
        ) : (
          <span className="ep-foot-hint">Shift+click to pick several</span>
        )}
      </div>
    </div>,
    document.body,
  )
}

/** The grid, memoized so hover previews and tab highlighting don't re-render ~1000 buttons. */
const EmojiSections = memo(function EmojiSections({ sections }: { sections: Section[] }) {
  if (sections.length === 1 && sections[0].id === 'search' && sections[0].items.length === 0)
    return <div className="ep-empty">No emoji found</div>
  return (
    <>
      {sections.map((s) => (
        <section key={s.id} data-section={s.id} className="ep-section" aria-label={s.label}>
          <h3 className="ep-section-title">{s.label}</h3>
          <div className="ep-grid">
            {s.items.map((e) => (
              <button key={e.char} className="ep-emoji" data-e={e.char} data-name={e.name} title={e.name} aria-label={e.name}>
                {e.char}
              </button>
            ))}
          </div>
        </section>
      ))}
    </>
  )
})
