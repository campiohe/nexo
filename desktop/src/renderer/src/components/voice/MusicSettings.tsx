// Settings → Audio & video → Music: this device's music plugin preferences (voice/musicPrefs.ts).
import { saveMusicPrefs, useMusicPrefs } from '../../voice/musicPrefs'

export function MusicSettingsSection() {
  const enabled = useMusicPrefs((s) => s.musicEnabled)
  const volume = useMusicPrefs((s) => s.musicVolume)
  const duck = useMusicPrefs((s) => s.musicDuck)
  const pct = Math.round(volume * 100)
  return (
    <>
      <label className="toggle-row">
        <span className="toggle-text">
          <span>Play music on this device</span>
          <span className="muted small">
            Hear the YouTube Music played in your voice channel (when the server's Music plugin is on). Turn it off to
            keep the music silent here; you can still see and control what's playing.
          </span>
        </span>
        <input
          type="checkbox"
          role="switch"
          className="switch"
          checked={enabled}
          onChange={(e) => saveMusicPrefs({ musicEnabled: e.target.checked })}
        />
      </label>
      <div className="vx-field">
        <label className="vx-field-label" htmlFor="vx-music-volume">
          Music volume
        </label>
        <div className="vx-range-row">
          <input
            id="vx-music-volume"
            type="range"
            className="vx-range"
            min={0}
            max={100}
            step={1}
            value={pct}
            disabled={!enabled}
            onChange={(e) => saveMusicPrefs({ musicVolume: Number(e.target.value) / 100 })}
            style={{ ['--fill' as string]: `${pct}%` }}
          />
          <span className="vx-range-value">{pct}%</span>
        </div>
      </div>
      <label className="toggle-row">
        <span className="toggle-text">
          <span>Lower music while people talk</span>
          <span className="muted small">Turns the music down while anyone in the channel is speaking.</span>
        </span>
        <input
          type="checkbox"
          role="switch"
          className="switch"
          checked={duck}
          disabled={!enabled}
          onChange={(e) => saveMusicPrefs({ musicDuck: e.target.checked })}
        />
      </label>
    </>
  )
}
