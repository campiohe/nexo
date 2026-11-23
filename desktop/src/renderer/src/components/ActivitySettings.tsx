// Settings → Activity: opt-in "Playing X" (off by default) and the user's own games.
// Settings are stored by the main process in <userData>/activity.json (main/presence.ts), which also does
// the detection; only the detected game's display name reaches the renderer and the server.
import { useEffect, useMemo, useState } from 'react'
import { ACTIVITY_NAME_MAX } from '@shared/protocol'
import type { ActivitySettings, CustomGame } from '../../../preload/api'
import { usePresenceStore } from '../store/presence'
import { formatElapsed, useNow } from '../lib/activity'
import { errorMessage, toast } from '../lib/toast'
import { AlertIcon, TrashIcon } from './icons'
import { GamepadIcon } from './peopleIcons'
import { tKnown, useT } from '../i18n'
import '../styles/people.css'

/** The main process's message without Electron's "Error invoking remote method '…': Error: " prefix. */
const ipcErrorMessage = (err: unknown): string =>
  tKnown(errorMessage(err).replace(/^Error invoking remote method '[^']*': (?:[A-Za-z]*Error: )?/, ''))

/** Needs the desktop bridge (absent in a plain browser or with an older preload). */
export const hasActivityBridge = (): boolean => typeof window.nexo?.presence?.getState === 'function'

/** "MyGame-Win64-Shipping.exe" → "MyGame". A starting point for the display name. */
function guessName(exe: string): string {
  return exe
    .replace(/\.exe$/i, '')
    .replace(/-Win64-Shipping$/i, '')
    .replace(/[_]+/g, ' ')
    .trim()
    .slice(0, ACTIVITY_NAME_MAX)
}

export function ActivitySection() {
  const t = useT()
  const [settings, setSettings] = useState<ActivitySettings | null>(null)
  const [loadFailed, setLoadFailed] = useState(false)
  const [saving, setSaving] = useState(false)
  const [adding, setAdding] = useState(false)
  const activity = usePresenceStore((s) => s.activity)
  const now = useNow(30_000)
  const isWindows = window.nexo.platform === 'win32'

  useEffect(() => {
    let alive = true
    window.nexo.presence
      .getState()
      .then((s) => alive && setSettings(s.settings))
      .catch((err: unknown) => {
        console.error('[nexo] presence.getState failed', err)
        if (alive) setLoadFailed(true)
      })
    return () => {
      alive = false
    }
  }, [])

  const save = async (patch: Partial<ActivitySettings>): Promise<boolean> => {
    if (!settings || saving) return false
    setSaving(true)
    setSettings({ ...settings, ...patch }) // optimistic
    try {
      setSettings(await window.nexo.presence.setSettings(patch))
      return true
    } catch (err) {
      setSettings(settings)
      toast(ipcErrorMessage(err), 'error')
      return false
    } finally {
      setSaving(false)
    }
  }

  const removeGame = (exe: string) => {
    if (!settings) return
    void save({ customGames: settings.customGames.filter((g) => g.exe !== exe) })
  }

  const addGame = async (game: CustomGame): Promise<boolean> => {
    if (!settings) return false
    const rest = settings.customGames.filter((g) => g.exe.toLowerCase() !== game.exe.toLowerCase())
    return save({ customGames: [...rest, game] })
  }

  return (
    <section className="activity-section">
      <h3 className="settings-heading">{t('Activity')}</h3>
      {loadFailed ? (
        <div className="callout callout-warn">
          <AlertIcon size={16} />
          <span>{t("Couldn't load the activity settings")}</span>
        </div>
      ) : (
        <>
          <label className="toggle-row">
            <span className="toggle-text">
              <span>{t("Share what I'm playing")}</span>
              <span className="muted small">
                {t("Only the game's name is shared. Detection runs on this computer and your programs never leave it.")}
                {!isWindows && ` ${t('Best effort on this system.')}`}
              </span>
            </span>
            <input
              type="checkbox"
              role="switch"
              className="switch"
              checked={settings?.shareActivity ?? false}
              disabled={!settings || saving}
              onChange={(e) => void save({ shareActivity: e.target.checked })}
            />
          </label>

          {settings?.shareActivity && (
            <div className={`activity-now ${activity ? 'is-playing' : ''}`} role="status">
              <GamepadIcon size={18} />
              {activity ? (
                <span>
                  {t.rich('Playing <b>{game}</b> · {elapsed}', {
                    game: activity.name,
                    elapsed: formatElapsed(activity.startedAt, now, t),
                    b: (c) => <strong>{c}</strong>,
                  })}
                </span>
              ) : (
                <span className="muted">{t('No game detected right now.')}</span>
              )}
            </div>
          )}

          <div className="field">
            <span className="field-label">{t('Your games')}</span>
            <span className="field-hint">{t('Missing a game? Start it, then add it from your running programs.')}</span>
            {settings && settings.customGames.length > 0 && (
              <ul className="activity-games">
                {settings.customGames.map((g) => (
                  <li key={g.exe} className="activity-game">
                    <span className="activity-game-text">
                      <span className="activity-game-name">{g.name}</span>
                      <span className="activity-game-exe">{g.exe}</span>
                    </span>
                    <button
                      type="button"
                      className="icon-btn danger"
                      onClick={() => removeGame(g.exe)}
                      disabled={saving}
                      aria-label={t('Remove {name}', { name: g.name })}
                      title={t('Remove')}
                    >
                      <TrashIcon size={15} />
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {adding ? (
              <AddGame
                busy={saving}
                onCancel={() => setAdding(false)}
                onAdd={async (g) => {
                  if (await addGame(g)) setAdding(false)
                }}
              />
            ) : (
              <div>
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => setAdding(true)} disabled={!settings}>
                  {t('Add a game')}
                </button>
              </div>
            )}
          </div>
        </>
      )}
    </section>
  )
}

function AddGame({ busy, onAdd, onCancel }: { busy: boolean; onAdd(g: CustomGame): void; onCancel(): void }) {
  const t = useT()
  const [processes, setProcesses] = useState<string[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [filter, setFilter] = useState('')
  const [exe, setExe] = useState<string | null>(null)
  const [name, setName] = useState('')

  const load = () => {
    setLoadError(null)
    window.nexo.presence
      .listProcesses()
      .then(setProcesses)
      .catch((err: unknown) => setLoadError(ipcErrorMessage(err)))
  }
  useEffect(load, [])

  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase()
    return (processes ?? []).filter((p) => !q || p.toLowerCase().includes(q))
  }, [processes, filter])

  const trimmed = name.trim()
  return (
    <div className="activity-add">
      <div className="activity-add-row">
        <input
          className="input input-sm"
          placeholder={t('Filter running programs')}
          aria-label={t('Filter running programs')}
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <button type="button" className="btn btn-ghost btn-xs" onClick={load}>
          {t('Refresh')}
        </button>
      </div>
      {loadError ? (
        <p className="muted small">{loadError}</p>
      ) : !processes ? (
        <p className="muted small">{t('Loading running programs…')}</p>
      ) : shown.length === 0 ? (
        <p className="muted small">{t('No running program matches.')}</p>
      ) : (
        <ul className="activity-procs" role="listbox" aria-label={t('Running programs')}>
          {shown.map((p) => (
            <li key={p}>
              <button
                type="button"
                role="option"
                aria-selected={exe === p}
                className={`activity-proc ${exe === p ? 'is-selected' : ''}`}
                onClick={() => {
                  setExe(p)
                  setName(guessName(p))
                }}
                title={p}
              >
                {p}
              </button>
            </li>
          ))}
        </ul>
      )}
      <form
        className="activity-add-row"
        onSubmit={(e) => {
          e.preventDefault()
          if (exe && trimmed) onAdd({ exe, name: trimmed })
        }}
      >
        <input
          className="input input-sm"
          placeholder={exe ? t('Name others see') : t('Pick a program above')}
          aria-label={t('Game name')}
          value={name}
          maxLength={ACTIVITY_NAME_MAX}
          disabled={!exe}
          onChange={(e) => setName(e.target.value)}
        />
        <button type="button" className="btn btn-ghost btn-xs" onClick={onCancel}>
          {t('Cancel')}
        </button>
        <button type="submit" className="btn btn-primary btn-xs" disabled={!exe || !trimmed || busy}>
          {t('Add')}
        </button>
      </form>
    </div>
  )
}
