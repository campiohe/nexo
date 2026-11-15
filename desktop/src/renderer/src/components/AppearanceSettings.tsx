// Settings → Appearance: theme, UI zoom, message density, link previews.
import { useAppearance, ZOOM_STEPS, zoomPercent, type ThemeChoice } from '../lib/appearance'
import { useLinkPreviewsPref } from '../store/chatPrefs'

const THEMES: { id: ThemeChoice; label: string }[] = [
  { id: 'system', label: 'System' },
  { id: 'dark', label: 'Dark' },
  { id: 'light', label: 'Light' },
]

const hasZoomBridge = () => typeof window.nexo?.appearance?.setZoom === 'function'

/** A tiny mock of the app (sidebar, messages, composer) drawn with the given palette's tokens. */
function MiniApp({ theme }: { theme: 'dark' | 'light' }) {
  return (
    <div className="tp-app" data-theme={theme}>
      <div className="tp-side">
        <span className="tp-bar" />
        <span className="tp-bar is-active" />
        <span className="tp-bar" />
      </div>
      <div className="tp-main">
        <span className="tp-msg">
          <i className="tp-dot" />
          <span className="tp-line" />
        </span>
        <span className="tp-msg">
          <i className="tp-dot is-alt" />
          <span className="tp-line" />
        </span>
        <span className="tp-composer" />
      </div>
    </div>
  )
}

function ThemeCard({ id, label, hint }: { id: ThemeChoice; label: string; hint?: string }) {
  const selected = useAppearance((s) => s.theme === id)
  return (
    <label className={`theme-card ${selected ? 'is-selected' : ''}`}>
      <input
        type="radio"
        name="nexo-theme"
        className="sr-only"
        value={id}
        checked={selected}
        onChange={() => useAppearance.getState().setTheme(id)}
      />
      <span className={`theme-preview ${id === 'system' ? 'is-system' : ''}`} aria-hidden="true">
        {id === 'system' ? (
          <>
            <MiniApp theme="dark" />
            <MiniApp theme="light" />
          </>
        ) : (
          <MiniApp theme={id} />
        )}
      </span>
      <span className="theme-card-label">
        <span className="theme-card-radio" aria-hidden="true" />
        <span>{label}</span>
        {hint && <span className="muted small">{hint}</span>}
      </span>
    </label>
  )
}

function ZoomRow() {
  const zoom = useAppearance((s) => s.zoom)
  const isMac = window.nexo?.platform === 'darwin'
  const mod = isMac ? '⌘' : 'Ctrl'
  const index = zoom === null ? ZOOM_STEPS.indexOf(1) : Math.max(0, ZOOM_STEPS.indexOf(zoom))
  const fill = `${(index / (ZOOM_STEPS.length - 1)) * 100}%`

  return (
    <div className="appearance-group">
      <div className="appearance-row">
        <span className="toggle-text">
          <span id="zoom-label">Zoom</span>
          <span className="muted small">
            {mod}+= and {mod}+- change it from anywhere, {mod}+0 resets it. {mod}+mouse wheel works too.
          </span>
        </span>
        <span className="appearance-zoom-value">{zoomPercent(ZOOM_STEPS[index]!)}</span>
      </div>
      <div className="vx-range-row">
        <input
          type="range"
          className="vx-range"
          min={0}
          max={ZOOM_STEPS.length - 1}
          step={1}
          value={index}
          disabled={zoom === null}
          aria-labelledby="zoom-label"
          aria-valuetext={zoomPercent(ZOOM_STEPS[index]!)}
          style={{ ['--fill' as string]: fill }}
          onChange={(e) => void useAppearance.getState().setZoom(ZOOM_STEPS[Number(e.target.value)] ?? 1)}
        />
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          disabled={zoom === null || zoom === 1}
          onClick={() => void useAppearance.getState().setZoom(1)}
        >
          Reset
        </button>
      </div>
    </div>
  )
}

export function AppearanceSection() {
  const resolved = useAppearance((s) => s.resolved)
  const theme = useAppearance((s) => s.theme)
  const density = useAppearance((s) => s.density)
  const [linkPreviews, setLinkPreviews] = useLinkPreviewsPref()

  return (
    <section>
      <h3 className="settings-heading">Appearance</h3>

      <div className="appearance-group" role="radiogroup" aria-labelledby="theme-label">
        <span id="theme-label" className="field-label">
          Theme
        </span>
        <div className="theme-cards">
          {/* The OS theme is only known while System is chosen: main mirrors the choice into nativeTheme.themeSource,
              which prefers-color-scheme then follows. */}
          {THEMES.map((t) => (
            <ThemeCard key={t.id} id={t.id} label={t.label} hint={t.id === 'system' && theme === 'system' ? `(${resolved})` : undefined} />
          ))}
        </div>
      </div>

      {hasZoomBridge() && <ZoomRow />}

      <div className="appearance-group">
        <span className="field-label">Chat</span>
        <label className="toggle-row">
          <span className="toggle-text">
            <span>Compact messages</span>
            <span className="muted small">Smaller avatars and less space between messages.</span>
          </span>
          <input
            type="checkbox"
            role="switch"
            className="switch"
            checked={density === 'compact'}
            onChange={(e) => useAppearance.getState().setDensity(e.target.checked ? 'compact' : 'cozy')}
          />
        </label>
        <label className="toggle-row">
          <span className="toggle-text">
            <span>Show link previews</span>
            <span className="muted small">Cards for links (videos, music, articles) under messages. Only on this device.</span>
          </span>
          <input
            type="checkbox"
            role="switch"
            className="switch"
            checked={linkPreviews}
            onChange={(e) => setLinkPreviews(e.target.checked)}
          />
        </label>
      </div>
    </section>
  )
}
