// Settings → Plugins: built-in features the server's admins turn on or off for everyone (`plugins:set`).
// Visible to everyone; only admins and the owner can change them.
import { useState } from 'react'
import { useApp } from '../store/app'
import { usePlugins } from '../store/plugins'
import { isStaff } from '../lib/permissions'
import { setPlugin } from '../voice/musicActions'
import { MusicIcon } from './voice/musicIcons'
import { ConsoleIcon } from './emulator/EmulatorEntry'
import type { PluginId } from '@shared/protocol'
import '../styles/music.css'

export function PluginsSection() {
  const supported = usePlugins((s) => s.supported)
  const music = usePlugins((s) => s.plugins.music)
  const emulator = usePlugins((s) => s.plugins.emulator)
  const canEdit = useApp((s) => !!s.me && isStaff(s.me))
  const [busy, setBusy] = useState<PluginId | null>(null)

  const toggle = async (plugin: PluginId, enabled: boolean) => {
    if (busy) return
    setBusy(plugin)
    try {
      await setPlugin(plugin, enabled)
    } finally {
      setBusy(null)
    }
  }

  return (
    <section>
      <h3 className="settings-heading">Plugins</h3>
      <p className="muted small plugins-intro">Admins turn these on or off for everyone.</p>
      {!supported && (
        <p className="callout callout-warn">This server's version has no plugins yet. Update the server to use them.</p>
      )}
      <label className={`plugin-card ${music ? 'is-on' : ''}`} style={{ cursor: canEdit && supported ? 'pointer' : 'default' }}>
        <span className="plugin-icon" aria-hidden="true">
          <MusicIcon size={20} />
        </span>
        <span className="plugin-text">
          <span className="plugin-name">YouTube Music</span>
          <span className="muted small">Listen together in voice, in sync. Volume is per person, in Audio & video.</span>
        </span>
        <input
          type="checkbox"
          role="switch"
          className="switch"
          aria-label="YouTube Music"
          checked={music}
          disabled={!canEdit || !supported || !!busy}
          onChange={(e) => void toggle('music', e.target.checked)}
        />
      </label>
      <label className={`plugin-card ${emulator ? 'is-on' : ''}`} style={{ cursor: canEdit && supported ? 'pointer' : 'default' }}>
        <span className="plugin-icon" aria-hidden="true">
          <ConsoleIcon size={20} />
        </span>
        <span className="plugin-text">
          <span className="plugin-name">Emulator</span>
          <span className="muted small">
            Play SNES, Mega Drive, PlayStation and Nintendo 64 games together in a call. Bring your own game files.
          </span>
        </span>
        <input
          type="checkbox"
          role="switch"
          className="switch"
          aria-label="Emulator"
          checked={emulator}
          disabled={!canEdit || !supported || !!busy}
          onChange={(e) => void toggle('emulator', e.target.checked)}
        />
      </label>
    </section>
  )
}
