// Search results (store/chatPanels), newest first, in the right-side panel. Opened by the header SearchBox.
import { useMemo } from 'react'
import { useApp } from '../store/app'
import { useChatPanels } from '../store/chatPanels'
import { searchWords } from '../lib/highlight'
import { PanelMessage } from './PanelMessage'
import { CloseIcon, SearchIcon } from './icons'
import { tKnown, useT } from '../i18n'

export function SearchPanel() {
  const t = useT()
  const search = useChatPanels((s) => s.search)
  const results = useChatPanels((s) => s.results)
  const hasMore = useChatPanels((s) => s.hasMore)
  const loading = useChatPanels((s) => s.loading)
  const error = useChatPanels((s) => s.error)
  const thisChannelOnly = useChatPanels((s) => s.thisChannelOnly)
  const author = useApp((s) => (search?.authorId ? s.users[search.authorId] : undefined))
  const inChannel = useApp((s) => s.channels.find((c) => c.id === (search?.channelId ?? search?.scopeChannelId)))
  const selectedIsText = useApp((s) => s.channels.find((c) => c.id === s.selectedChannelId)?.type === 'text')
  const words = useMemo(() => searchWords(search?.text ?? ''), [search?.text])
  const panels = useChatPanels.getState()

  const count = hasMore
    ? t('{count}+ results', { count: results.length })
    : t('{count, plural, one {# result} other {# results}}', { count: results.length })

  return (
    <aside className="side-panel" aria-label={t('Search results')}>
      <header className="side-panel-head">
        <SearchIcon size={16} />
        <h2 className="side-panel-title">{loading && results.length === 0 ? t('Searching…') : count}</h2>
        <span className="grow" />
        <button
          className="icon-btn"
          onClick={() => panels.openPanel(null)}
          aria-label={t('Close search results')}
          title={t('Close (Esc)')}
        >
          <CloseIcon size={16} />
        </button>
      </header>
      <div className="side-panel-filters">
        {search?.text && <span className="side-panel-chip is-text">“{search.text}”</span>}
        {author && (
          <span className="side-panel-chip">
            {'from: ' /* the filter keyword: not translated */}
            <strong style={{ color: author.color }}>{author.name}</strong>
          </span>
        )}
        {inChannel && (
          <span className="side-panel-chip">
            {'in: '}
            <strong>#{inChannel.name}</strong>
          </span>
        )}
        <span className="grow" />
        <label
          className={`side-panel-toggle ${search?.channelId || (!selectedIsText && !thisChannelOnly) ? 'is-disabled' : ''}`}
          title={search?.channelId ? t('The in: filter already picks a channel') : t('Only search the channel you are viewing')}
        >
          <input
            type="checkbox"
            checked={thisChannelOnly}
            disabled={!!search?.channelId || (!selectedIsText && !thisChannelOnly)}
            onChange={(e) => panels.setThisChannelOnly(e.target.checked)}
          />
          {t('This channel only')}
        </label>
      </div>
      <div className="side-panel-scroll">
        {results.map((m) => (
          <PanelMessage key={m.id} msg={m} highlight={words} showChannel />
        ))}
        {error && (
          <div className="side-panel-empty is-error" role="alert">
            {tKnown(error)}
          </div>
        )}
        {!loading && !error && results.length === 0 && (
          <div className="side-panel-empty">
            <SearchIcon size={28} />
            <p>{t('No messages found.')}</p>
            <p className="muted small">{t('Try other words, or fewer filters.')}</p>
          </div>
        )}
        {loading && (
          <div className="history-loader">
            <span className="spinner" /> {t('Searching…')}
          </div>
        )}
        {!loading && hasMore && (
          <button className="btn btn-ghost btn-sm side-panel-more" onClick={() => void panels.loadMoreResults()}>
            {t('Load more')}
          </button>
        )}
      </div>
    </aside>
  )
}
