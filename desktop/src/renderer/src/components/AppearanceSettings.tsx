// Settings → Appearance: theme, accent, title bar, app icon, UI zoom, message density, link previews.
import { useId, useRef, type KeyboardEvent } from 'react'
import {
  ACCENTS,
  APP_ICONS,
  CUSTOM_ACCENT_LABEL,
  hasAppIconBridge,
  useAppearance,
  ZOOM_STEPS,
  zoomPercent,
  type AppIconChoice,
  type ResolvedTheme,
  type ThemeChoice,
  type TitleBarStyle,
} from '../lib/appearance'
import { AppIconArt } from './AppIconArt'
import { CustomAccentSwatch } from './AccentPicker'
import { msg, useT } from '../i18n'
import { useLinkPreviewsPref } from '../store/chatPrefs'

// Labels are message keys (msg): translated where they're shown, with t(label).
const THEMES: { id: ThemeChoice; label: string }[] = [
  { id: 'system', label: msg('System') },
  { id: 'dark', label: msg('Dark') },
  { id: 'midnight', label: msg('Midnight') },
  { id: 'light', label: msg('Light') },
]

const TITLE_BARS: { id: TitleBarStyle; label: string }[] = [
  { id: 'search', label: msg('With search') },
  { id: 'minimal', label: msg('Minimal') },
]

const hasZoomBridge = () => typeof window.nexo?.appearance?.setZoom === 'function'

/** A tiny mock of the app (sidebar, messages, composer) drawn with the given palette's tokens. */
function MiniApp({ theme }: { theme: ResolvedTheme }) {
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

function AccentRow() {
  const t = useT()
  const accent = useAppearance((s) => s.accent)
  const label = accent === 'custom' ? CUSTOM_ACCENT_LABEL : ACCENTS.find((a) => a.id === accent)?.label
  return (
    <div className="appearance-group">
      <span id="accent-label" className="field-label">
        {t.rich('Accent <name>{accent}</name>', {
          accent: label ? t(label) : '',
          name: (c) => <span className="appearance-accent-name">{c}</span>,
        })}
      </span>
      <div className="swatches" role="radiogroup" aria-labelledby="accent-label">
        {ACCENTS.map((a) => (
          <button
            key={a.id}
            type="button"
            role="radio"
            aria-checked={accent === a.id}
            aria-label={t(a.label)}
            title={t(a.label)}
            data-accent={a.id}
            className={`swatch accent-swatch ${accent === a.id ? 'is-selected' : ''}`}
            onClick={() => useAppearance.getState().setAccent(a.id)}
          />
        ))}
        <CustomAccentSwatch />
      </div>
    </div>
  )
}

function TitleBarRow() {
  const t = useT()
  const titleBar = useAppearance((s) => s.titleBar)
  return (
    <div className="appearance-group">
      <span id="titlebar-label" className="field-label">
        {t('Title bar')}
      </span>
      <div className="vx-seg" role="radiogroup" aria-labelledby="titlebar-label">
        {TITLE_BARS.map((b) => (
          <button
            key={b.id}
            type="button"
            role="radio"
            aria-checked={titleBar === b.id}
            className={`vx-seg-btn ${titleBar === b.id ? 'is-active' : ''}`}
            onClick={() => useAppearance.getState().setTitleBar(b.id)}
          >
            {t(b.label)}
          </button>
        ))}
      </div>
    </div>
  )
}

/** Where the icon shows; on Windows the taskbar reads it when Nexo starts (main/appIcon.ts). */
const APP_ICON_HINT =
  window.nexo?.platform === 'win32'
    ? msg('Used for the title bar, tray, taskbar and Start menu. The taskbar shows it the next time Nexo starts.')
    : window.nexo?.platform === 'darwin'
      ? msg('Used for the title bar, the Dock and the menu bar.')
      : msg('Used for the title bar, the window and the tray.')

function AppIconRow() {
  const t = useT()
  const appIcon = useAppearance((s) => s.appIcon)
  const group = useRef<HTMLDivElement>(null)

  // Radio group keys: the arrows move the choice (and the focus) through the tiles.
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0
    if (!step) return
    e.preventDefault()
    const i = APP_ICONS.findIndex((a) => a.id === appIcon)
    const next = (i + step + APP_ICONS.length) % APP_ICONS.length
    useAppearance.getState().setAppIcon(APP_ICONS[next]!.id)
    group.current?.querySelectorAll<HTMLButtonElement>('[role="radio"]')[next]?.focus()
  }

  return (
    <div className="appearance-group">
      <span id="app-icon-label" className="field-label">
        {t('App icon')}
      </span>
      <div ref={group} className="app-icon-options" role="radiogroup" aria-labelledby="app-icon-label" onKeyDown={onKeyDown}>
        {APP_ICONS.map((a) => (
          <button
            key={a.id}
            type="button"
            role="radio"
            aria-checked={appIcon === a.id}
            tabIndex={appIcon === a.id ? 0 : -1}
            className={`app-icon-option ${appIcon === a.id ? 'is-selected' : ''}`}
            onClick={() => useAppearance.getState().setAppIcon(a.id)}
          >
            <AppIconArt choice={a.id} className="app-icon-art" outline />
            <span className="app-icon-label">{t(a.label)}</span>
          </button>
        ))}
      </div>
      <span className="muted small">{t(APP_ICON_HINT)}</span>
    </div>
  )
}

function ZoomRow() {
  const t = useT()
  const zoom = useAppearance((s) => s.zoom)
  const isMac = window.nexo?.platform === 'darwin'
  const mod = isMac ? '⌘' : 'Ctrl'
  const index = zoom === null ? ZOOM_STEPS.indexOf(1) : Math.max(0, ZOOM_STEPS.indexOf(zoom))
  const fill = `${(index / (ZOOM_STEPS.length - 1)) * 100}%`

  return (
    <div className="appearance-group">
      <div className="appearance-row">
        <span className="toggle-text">
          <span id="zoom-label">{t('Zoom')}</span>
          <span className="muted small">
            {t('{mod}+= and {mod}+- change it from anywhere, {mod}+0 resets it. {mod}+mouse wheel works too.', { mod })}
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
          {t('Reset')}
        </button>
      </div>
    </div>
  )
}

export function AppearanceSection() {
  const t = useT()
  const resolved = useAppearance((s) => s.resolved)
  const theme = useAppearance((s) => s.theme)
  const density = useAppearance((s) => s.density)
  const [linkPreviews, setLinkPreviews] = useLinkPreviewsPref()

  return (
    <section>
      <h3 className="settings-heading">{t('Appearance')}</h3>

      <div className="appearance-group" role="radiogroup" aria-labelledby="theme-label">
        <span id="theme-label" className="field-label">
          {t('Theme')}
        </span>
        <div className="theme-cards">
          {/* The OS theme is only known while System is chosen: main mirrors the choice into nativeTheme.themeSource,
              which prefers-color-scheme then follows. */}
          {THEMES.map((c) => (
            <ThemeCard
              key={c.id}
              id={c.id}
              label={t(c.label)}
              hint={c.id === 'system' && theme === 'system' ? `(${t(THEMES.find((x) => x.id === resolved)?.label ?? resolved)})` : undefined}
            />
          ))}
        </div>
      </div>

      <div className="appearance-pair">
        <AccentRow />
        <TitleBarRow />
      </div>

      {hasAppIconBridge() && <AppIconRow />}

      {hasZoomBridge() && <ZoomRow />}

      <div className="appearance-group">
        <span className="field-label">{t('Chat')}</span>
        <label className="toggle-row">
          <span className="toggle-text">
            <span>{t('Compact messages')}</span>
            <span className="muted small">{t('Smaller avatars and less space between messages.')}</span>
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
            <span>{t('Show link previews')}</span>
            <span className="muted small">{t('Cards for links (videos, music, articles) under messages. Only on this device.')}</span>
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
