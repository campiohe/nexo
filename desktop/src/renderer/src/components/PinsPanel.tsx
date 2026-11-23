// Pinned messages of the selected text channel (store/chatPanels), most recently pinned first, in the
// right-side panel. Refreshed whenever it opens or the channel changes; live through `message:updated`.
import { useEffect } from 'react'
import type { Message } from '@shared/protocol'
import { useApp } from '../store/app'
import { useChatPanels } from '../store/chatPanels'
import { canUnpinMessage } from '../lib/permissions'
import { formatFull, useClock } from '../lib/time'
import { toast } from '../lib/toast'
import { tKnown, useT } from '../i18n'
import { PanelMessage } from './PanelMessage'
import { PinIcon } from './chatIcons'
import { CloseIcon } from './icons'

export function PinsPanel() {
  const t = useT()
  const channel = useApp((s) => s.channels.find((c) => c.id === s.selectedChannelId && c.type === 'text') ?? null)
  const pins = useChatPanels((s) => s.pins)
  const pinsChannelId = useChatPanels((s) => s.pinsChannelId)
  const loading = useChatPanels((s) => s.pinsLoading)
  const error = useChatPanels((s) => s.pinsError)
  const channelId = channel?.id ?? null

  useEffect(() => {
    if (channelId) void useChatPanels.getState().loadPins(channelId)
  }, [channelId])

  const shown = pinsChannelId === channelId ? pins : []

  return (
    <aside className="side-panel" aria-label={t('Pinned messages')}>
      <header className="side-panel-head">
        <PinIcon size={16} />
        <h2 className="side-panel-title">{t('Pinned messages')}</h2>
        {channel && <span className="side-panel-sub">#{channel.name}</span>}
        <span className="grow" />
        <button
          className="icon-btn"
          onClick={() => useChatPanels.getState().openPanel(null)}
          aria-label={t('Close pinned messages')}
          title={t('Close (Esc)')}
        >
          <CloseIcon size={16} />
        </button>
      </header>
      <div className="side-panel-scroll">
        {!channel ? (
          <div className="side-panel-empty">
            <p className="muted">{t('Pins live in text channels.')}</p>
          </div>
        ) : (
          <>
            {shown.map((m) => (
              <PinnedItem key={m.id} msg={m} />
            ))}
            {error && (
              <div className="side-panel-empty is-error" role="alert">
                {tKnown(error)}
              </div>
            )}
            {loading && shown.length === 0 && (
              <div className="history-loader">
                <span className="spinner" /> {t('Loading pins…')}
              </div>
            )}
            {!loading && !error && shown.length === 0 && (
              <div className="side-panel-empty">
                <PinIcon size={28} />
                <p>{t("This channel doesn't have any pinned messages yet.")}</p>
                <p className="muted small">{t('Hover a message and use the pin button to keep it here.')}</p>
              </div>
            )}
          </>
        )}
      </div>
    </aside>
  )
}

function PinnedItem({ msg }: { msg: Message }) {
  const t = useT()
  const canUnpin = useApp((s) => canUnpinMessage(s.me, msg))
  const pinner = useApp((s) => (msg.pinned ? s.users[msg.pinned.by]?.name : undefined))
  const clock = useClock()
  return (
    <div className="pinned-item">
      {msg.pinned && (
        <div className="pinned-by" title={formatFull(msg.pinned.at, clock)}>
          <PinIcon size={11} /> {t('Pinned by {name}', { name: pinner ?? t('a deleted user') })}
        </div>
      )}
      <PanelMessage
        msg={msg}
        actions={
          canUnpin ? (
            <button
              type="button"
              className="panel-msg-btn is-danger"
              onClick={() =>
                useApp
                  .getState()
                  .pinMessage(msg.id, false)
                  .catch((err) => toast(err, 'error'))
              }
            >
              {t('Unpin')}
            </button>
          ) : undefined
        }
      />
    </div>
  )
}
