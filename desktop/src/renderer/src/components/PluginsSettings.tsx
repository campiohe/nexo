// Settings → Plugins: built-in features the server's admins turn on or off for everyone (`plugins:set`).
// Visible to everyone; only admins and the owner can change them.
import { useState } from 'react'
import { useApp } from '../store/app'
import { usePlugins } from '../store/plugins'
import { isStaff } from '../lib/permissions'
import { setPlugin } from '../voice/musicActions'
import { MusicIcon } from './voice/musicIcons'
import '../styles/music.css'

export function PluginsSection() {
  const supported = usePlugins((s) => s.supported)
  const music = usePlugins((s) => s.plugins.music)
  const canEdit = useApp((s) => !!s.me && isStaff(s.me))
  const [busy, setBusy] = useState(false)

  const toggle = async (enabled: boolean) => {
    if (busy) return
    setBusy(true)
    try {
      await setPlugin('music', enabled)
    } finally {
      setBusy(false)
    }
  }

  return (
    <section>
      <h3 className="settings-heading">Plugins</h3>
      <p className="muted small">Built-in extras for this server. Admins turn them on or off for everyone.</p>
      {!supported && (
        <p className="callout callout-warn">This server's version has no plugins yet. Update the server to use them.</p>
      )}
      <label className={`plugin-card ${music ? 'is-on' : ''}`} style={{ cursor: canEdit && supported ? 'pointer' : 'default' }}>
        <span className="plugin-icon" aria-hidden="true">
          <MusicIcon size={20} />
        </span>
        <span className="plugin-text">
          <span className="plugin-name">YouTube Music</span>
          <span className="muted small">
            Listen together in voice channels. Everyone's Nexo plays the same song from YouTube Music, in sync. Each
            person can change the music volume or turn it off for themselves (Audio & video).
          </span>
        </span>
        <input
          type="checkbox"
          role="switch"
          className="switch"
          aria-label="YouTube Music"
          checked={music}
          disabled={!canEdit || !supported || busy}
          onChange={(e) => void toggle(e.target.checked)}
        />
      </label>
      {supported && !canEdit && <p className="muted small">Only admins can change plugins.</p>}
    </section>
  )
}
