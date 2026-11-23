import { useEffect, useRef, useState, type ChangeEvent, type ComponentType } from 'react'
import type { AppPrefs, CaptureEngine, HotkeyStatus, Keybind, NativeShareCapabilities, UpdateState } from '../../../preload/api'
import { useApp, type ConnectionStatus } from '../store/app'
import { msg, useT, type Translate } from '../i18n'
import { useUi, type SettingsTab } from '../store/ui'
import { ActivitySection, hasActivityBridge } from './ActivitySettings'
import { AppearanceSection } from './AppearanceSettings'
import { LanguageTimeSection } from './LanguageSettings'
import { GamepadIcon } from './peopleIcons'
import { HeadphonesIcon, ScreenIcon } from './voice/icons'
import { CustomStatusField } from './StatusMenu'
import { SWATCHES } from '../lib/colors'
import { toast, useToasts } from '../lib/toast'
import { AVATAR_INPUT_TYPES, loadImageFile, type LoadedImage } from '../lib/imageCrop'
import { removeAvatar, uploadAvatar } from '../net/avatar'
import { hasUpdates, useInCall, useUpdates } from '../lib/updates'
import { actionLabel, defaultInAppBinding, findConflict, HOTKEY_ACTIONS, sameCombo, type HotkeyAction } from '../lib/keybinds'
import { allKeybinds, isInAppAction, setKeybind, useInputPrefs, useKeybinds } from '../voice/prefs'
import { cancelCapture, recordKeybind, usePtt } from '../voice/ptt'
import { DeviceSettings } from './voice/DeviceSettings'
import { MembersSection } from './MembersSection'
import { PluginsSection } from './PluginsSettings'
import { useVoice } from '../voice/session'
import { useDevicePrefs } from '../voice/devices'
import { hasNativeNotifications, setNotifyPrefs, useNotifyPrefs, type NotifyLevel } from '../lib/notify'
import '../styles/notify.css'
import { Avatar } from './Avatar'
import { AvatarCropDialog } from './AvatarCropDialog'
import { BannerField } from './BannerSettings'
import { ColorSwatches } from './ColorSwatches'
import { ConfirmDialog, Modal } from './Modal'
import {
  AlertIcon,
  BellIcon,
  LanguagesIcon,
  KeyboardIcon,
  LogoutIcon,
  PaletteIcon,
  PluginIcon,
  ServerIcon,
  UserIcon,
  UsersIcon,
  type IconProps,
} from './icons'

type Tab = SettingsTab

/** The App section needs the Electron bridge (window.nexo.prefs); it's hidden in a plain browser. */
const hasPrefs = () => typeof window.nexo?.prefs?.get === 'function'

interface TabDef {
  id: Tab
  /** Message key (msg): shown with t(label). */
  label: string
  /** Drawn left of the label (decorative: the label names the tab). */
  icon: ComponentType<IconProps>
  available?: () => boolean
}

/** Nav groups; `label: null` is the server group, labelled with the server's name. Labels are message keys. */
const GROUPS: { key: string; label: string | null; tabs: TabDef[] }[] = [
  {
    key: 'you',
    label: msg('You'),
    tabs: [
      { id: 'profile', label: msg('Profile'), icon: UserIcon },
      { id: 'appearance', label: msg('Appearance'), icon: PaletteIcon },
      { id: 'language', label: msg('Language & time'), icon: LanguagesIcon },
      { id: 'av', label: msg('Audio & video'), icon: HeadphonesIcon },
      { id: 'keybinds', label: msg('Keybinds'), icon: KeyboardIcon },
      { id: 'notifications', label: msg('Notifications'), icon: BellIcon, available: hasNativeNotifications },
      { id: 'activity', label: msg('Activity'), icon: GamepadIcon, available: hasActivityBridge },
    ],
  },
  { key: 'device', label: msg('This device'), tabs: [{ id: 'app', label: msg('App'), icon: ScreenIcon, available: hasPrefs }] },
  {
    key: 'server',
    label: null,
    tabs: [
      { id: 'plugins', label: msg('Plugins'), icon: PluginIcon },
      { id: 'members', label: msg('Members'), icon: UsersIcon },
      { id: 'server', label: msg('Server'), icon: ServerIcon },
    ],
  },
]

export function SettingsModal() {
  const t = useT()
  const open = useUi((s) => s.settingsOpen)
  const close = () => useUi.getState().openSettings(false)
  // In store/ui.ts so other places can open a given section (e.g. the profile card's "Edit profile").
  const tab = useUi((s) => s.settingsTab)
  const setTab = useUi((s) => s.setSettingsTab)
  const serverName = useApp((s) => s.serverName)
  if (!open) return null

  return (
    <Modal title={t('Settings')} onClose={close} width={720} className="settings-modal">
      <div className="settings">
        <nav className="settings-nav" role="tablist" aria-label={t('Settings sections')} aria-orientation="vertical">
          {GROUPS.map((g) => {
            const tabs = g.tabs.filter((d) => !d.available || d.available())
            if (tabs.length === 0) return null
            const label = g.label ? t(g.label) : serverName || t('Server')
            return (
              <div key={g.key} className="settings-nav-group" role="presentation">
                {/* Visual grouping only: a tablist may only own tabs, and each tab's name says enough. */}
                <span className="settings-nav-label" aria-hidden="true" title={label}>
                  {label}
                </span>
                {tabs.map((d) => (
                  <button
                    key={d.id}
                    role="tab"
                    aria-selected={tab === d.id}
                    className={`settings-tab ${tab === d.id ? 'is-active' : ''}`}
                    onClick={() => setTab(d.id)}
                  >
                    <d.icon size={18} className="settings-tab-icon" aria-hidden="true" />
                    <span className="settings-tab-label">{t(d.label)}</span>
                  </button>
                ))}
              </div>
            )
          })}
        </nav>
        <div className="settings-panel" role="tabpanel">
          {tab === 'profile' && <ProfileSection />}
          {tab === 'appearance' && <AppearanceSection />}
          {tab === 'language' && <LanguageTimeSection />}
          {tab === 'av' && (
            <section>
              <h3 className="settings-heading">{t('Audio & video')}</h3>
              <DeviceSettings />
            </section>
          )}
          {tab === 'keybinds' && <KeybindsSection />}
          {tab === 'notifications' && hasNativeNotifications() && <NotificationsSection />}
          {tab === 'activity' && hasActivityBridge() && <ActivitySection />}
          {tab === 'app' && hasPrefs() && <AppSection />}
          {tab === 'plugins' && <PluginsSection />}
          {tab === 'members' && <MembersSection />}
          {tab === 'server' && <ServerSection onDone={close} />}
        </div>
      </div>
    </Modal>
  )
}

function ProfileSection() {
  const t = useT()
  const me = useApp((s) => s.me)
  const updateColor = useApp((s) => s.updateColor)
  const [saving, setSaving] = useState(false)
  if (!me) return null

  const pick = async (color: string) => {
    if (color.toLowerCase() === me.color.toLowerCase() || saving) return
    setSaving(true)
    try {
      await updateColor(color)
    } catch (err) {
      toast(err, 'error')
    } finally {
      setSaving(false)
    }
  }

  return (
    <section>
      <h3 className="settings-heading">{t('Profile')}</h3>
      <div className="profile-card">
        <span className="avatar-preview">
          <Avatar user={me} size={96} animate />
          {me.avatar && me.avatarAnimated && (
            <span className="avatar-gif-badge" title={t('Animated picture: others see it move when they hover over you or while you talk')}>
              GIF
            </span>
          )}
        </span>
        <div className="profile-card-text">
          <div className="profile-name" style={{ color: me.color }}>
            {me.name}
          </div>
          <div className="muted small">{t('Your name is tied to this device.')}</div>
          <AvatarActions hasAvatar={!!me.avatar} />
        </div>
      </div>
      <div className="field">
        <span className="field-label">{t('Color')}</span>
        <ColorSwatches value={me.color} onChange={pick} colors={SWATCHES} disabled={saving} />
      </div>
      <BannerField />
      <CustomStatusField />
    </section>
  )
}

function AvatarActions({ hasAvatar }: { hasAvatar: boolean }) {
  const t = useT()
  const fileRef = useRef<HTMLInputElement>(null)
  const [image, setImage] = useState<LoadedImage | null>(null)
  const [busy, setBusy] = useState(false)

  // Free the decoded image's blob: URL when the dialog closes (or Settings unmounts).
  useEffect(() => () => image?.release(), [image])

  const pickFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = '' // picking the same file again should still fire `change`
    if (!file) return
    try {
      setImage(await loadImageFile(file))
    } catch (err) {
      toast(err, 'error')
    }
  }

  const upload = async (picture: Blob) => {
    const pending = toast(t('Uploading picture…'), 'info', 30_000)
    try {
      await uploadAvatar(picture)
      setImage(null)
      toast(t('Profile picture updated'), 'success')
    } finally {
      useToasts.getState().dismiss(pending)
    }
  }

  const remove = async () => {
    if (busy) return
    setBusy(true)
    try {
      await removeAvatar()
      toast(t('Profile picture removed'), 'success')
    } catch (err) {
      toast(err, 'error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="settings-actions profile-avatar-actions">
      <input
        ref={fileRef}
        type="file"
        accept={AVATAR_INPUT_TYPES.join(',')}
        onChange={pickFile}
        hidden
        tabIndex={-1}
        aria-hidden="true"
      />
      <button className="btn btn-primary btn-sm" onClick={() => fileRef.current?.click()} disabled={busy}>
        {t('Upload picture')}
      </button>
      {hasAvatar && (
        <button className="btn btn-ghost btn-sm" onClick={remove} disabled={busy}>
          {t('Remove')}
        </button>
      )}
      {image && <AvatarCropDialog image={image} onCancel={() => setImage(null)} onConfirm={upload} />}
    </div>
  )
}

/** Message keys. */
const KEYBIND_HINTS: Partial<Record<HotkeyAction, string>> = {
  toggleShare: msg('Stops your stream, or opens the share picker.'),
}

/** A combination another action already uses (kept as data, so the message follows a language change). */
interface KeybindConflict {
  action: HotkeyAction
  combo: string
  usedBy: HotkeyAction
  /** Resetting to the default, rather than recording. */
  reset: boolean
}

/** SPEC §13.2: record / clear each action's combination; in-app shortcuts can be reset to their default. */
function KeybindsSection() {
  const t = useT()
  const keybinds = useKeybinds()
  const pttBinding = useInputPrefs((s) => s.pttBinding)
  const inputMode = useInputPrefs((s) => s.inputMode)
  const hookStatus = usePtt((s) => s.hookStatus)
  const capturing = usePtt((s) => s.capturing)
  const [recording, setRecording] = useState<HotkeyAction | null>(null)
  const [error, setError] = useState<KeybindConflict | null>(null)
  const [probe, setProbe] = useState<HotkeyStatus | null>(null)

  // Leaving the tab (or closing Settings) mid-recording cancels it.
  useEffect(() => () => {
    if (usePtt.getState().capturing) cancelCapture()
  }, [])

  // Explain up front when the global hook can't run here, even before anything is bound.
  useEffect(() => {
    let alive = true
    window.nexo?.hotkeys
      ?.status()
      .then((s) => alive && setProbe(s))
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [])

  const bindings: Record<HotkeyAction, Keybind | null> = { ...keybinds, ptt: pttBinding }

  const record = async (action: HotkeyAction) => {
    setError(null)
    if (recording === action && capturing) {
      cancelCapture()
      setRecording(null)
      return
    }
    setRecording(action)
    const result = await recordKeybind()
    setRecording((cur) => (cur === action ? null : cur))
    if (result === null) return
    if (result === 'clear') {
      setKeybind(action, null)
      return
    }
    const conflict = findConflict(allKeybinds(), action, result)
    if (conflict) {
      setError({ action, combo: result.label, usedBy: conflict, reset: false })
      return
    }
    setKeybind(action, result)
  }

  const reset = (action: HotkeyAction) => {
    if (!isInAppAction(action)) return
    setError(null)
    const def = defaultInAppBinding(action)
    const conflict = findConflict(allKeybinds(), action, def)
    if (conflict) {
      setError({ action, combo: def.label, usedBy: conflict, reset: true })
      return
    }
    setKeybind(action, def)
  }

  const anyGlobal = HOTKEY_ACTIONS.some((a) => a.scope === 'global' && bindings[a.id])
  const reason =
    anyGlobal && hookStatus && !hookStatus.active && hookStatus.reason
      ? t('{reason} Until then, these shortcuts only work while Nexo is focused.', { reason: hookStatus.reason })
      : !anyGlobal && probe?.reason
        ? t('{reason} Without it, global shortcuts only work while Nexo is focused.', { reason: probe.reason })
        : null

  const row = (action: HotkeyAction) => {
    const b = bindings[action]
    const isRecording = recording === action && capturing
    const inApp = isInAppAction(action)
    const hintKey = KEYBIND_HINTS[action]
    const hint =
      action === 'ptt'
        ? inputMode === 'ptt'
          ? t('Hold to talk. Extra modifiers like Shift still work.')
          : t('Only used in push to talk mode.')
        : hintKey && t(hintKey)
    const name = t(actionLabel(action))
    const isDefault = inApp && !!b && sameCombo(b, defaultInAppBinding(action))
    return (
      <div key={action} className="kb-item">
        <div className="kb-row">
          <span className="toggle-text">
            <span>{name}</span>
            {hint && <span className="muted small">{hint}</span>}
          </span>
          <button
            type="button"
            className={`vx-keybind kb-combo ${isRecording ? 'is-recording' : b ? '' : 'is-empty'}`}
            onClick={() => void record(action)}
            aria-label={
              isRecording
                ? t('Recording: press a key combination or mouse button. Esc cancels, Backspace clears.')
                : t('Change the {action} shortcut', { action: name })
            }
            title={b?.label}
          >
            {isRecording ? t('Press keys…') : (b?.label ?? t('Not set'))}
          </button>
          <button type="button" className="btn btn-ghost btn-sm" disabled={!b || isRecording} onClick={() => setKeybind(action, null)}>
            {t('Clear')}
          </button>
          {inApp && (
            <button type="button" className="btn btn-ghost btn-sm" disabled={isDefault || isRecording} onClick={() => reset(action)}>
              {t('Reset')}
            </button>
          )}
        </div>
        {error?.action === action && (
          <p className="kb-error" role="alert">
            {error.reset
              ? t('{combo} is used by {action}. Clear it there first.', { combo: error.combo, action: t(actionLabel(error.usedBy)) })
              : t('{combo} is already used by {action}. Clear it there first.', {
                  combo: error.combo,
                  action: t(actionLabel(error.usedBy)),
                })}
          </p>
        )}
      </div>
    )
  }

  return (
    <section>
      <h3 className="settings-heading">{t('Keybinds')}</h3>
      <p className="muted small kb-intro">
        {capturing
          ? t('Press a key or mouse button, with any modifiers. For a modifier alone, press and release it. Esc cancels, Backspace clears.')
          : t('Click a shortcut to change it. Left and right click can’t be used.')}
      </p>
      {reason && (
        <div className="callout callout-warn">
          <AlertIcon size={16} />
          <span>{reason}</span>
        </div>
      )}
      <div className="kb-group">
        <div className="kb-group-head">
          <span className="field-label">{t('Global')}</span>
          <span className="muted small">{t('Work even while a game has focus. None are set by default.')}</span>
        </div>
        {HOTKEY_ACTIONS.filter((a) => a.scope === 'global').map((a) => row(a.id))}
      </div>
      <div className="kb-group">
        <div className="kb-group-head">
          <span className="field-label">{t('In Nexo')}</span>
          <span className="muted small">{t('Only while Nexo is focused.')}</span>
        </div>
        {HOTKEY_ACTIONS.filter((a) => a.scope === 'app').map((a) => row(a.id))}
      </div>
    </section>
  )
}

/**
 * Main applies fastCapture only at startup. The first read in this renderer happens before the user can
 * change it (the toggle lives here), so it's the value Nexo is running with.
 */
let startupFastCapture: Promise<boolean> | null = null
function fastCaptureAtStartup(): Promise<boolean> {
  startupFastCapture ??= window.nexo.prefs
    .get()
    .then((p) => p.fastCapture)
    .catch(() => true)
  return startupFastCapture
}

const CAPTURE_ENGINES: { id: CaptureEngine; label: string }[] = [
  { id: 'native', label: msg('Native (beta)') },
  { id: 'chromium', label: msg('Chromium') },
]

/** What the native capture helper found on this PC (Windows). Starts the helper if it isn't running. */
function useNativeCapabilities(): NativeShareCapabilities | null {
  const [caps, setCaps] = useState<NativeShareCapabilities | null>(null)
  useEffect(() => {
    const native = window.nexo.nativeShare
    if (!native) return
    let alive = true
    native
      .capabilities()
      .then((c) => {
        if (alive) setCaps(c)
        // Main caches capabilities for the app session, so the helper isn't needed after this answer. Outside
        // voice nothing else would shut it down (leaving voice does), so release it right away.
        const v = useVoice.getState()
        if (!v.channelId && !v.sharing && !v.shareStarting) void native.release().catch(() => undefined)
      })
      .catch((err: unknown) => alive && setCaps({ available: false, reason: errorText(err) }))
    return () => {
      alive = false
    }
  }, [])
  return caps
}

/** The error's message (main's diagnostics are English), or undefined: the line then says "unknown reason". */
function errorText(err: unknown): string | undefined {
  return err instanceof Error && err.message ? err.message : undefined
}

function nativeCapabilitiesLine(t: Translate, caps: NativeShareCapabilities | null): string {
  if (!caps) return t('Checking your graphics card…')
  if (!caps.available) {
    return t("Native capture isn't available on this PC: {reason}. Streams use Chromium.", {
      reason: caps.reason ?? t('unknown reason'),
    })
  }
  if (!caps.encoder) {
    return caps.adapter ? t('Streams with the hardware encoder on {gpu}.', { gpu: caps.adapter }) : t('Streams with the hardware encoder.')
  }
  return caps.adapter
    ? t('Streams with {encoder} on {gpu}.', { encoder: caps.encoder, gpu: caps.adapter })
    : t('Streams with {encoder}.', { encoder: caps.encoder })
}

/** Labels and titles are message keys. */
const NOTIFY_LEVELS: { id: NotifyLevel; label: string; title?: string }[] = [
  { id: 'all', label: msg('All messages') },
  { id: 'mentions', label: msg('Only mentions'), title: msg('Messages with your @name or @everyone, and replies to you') },
  { id: 'off', label: msg('Off // desktop notifications') },
]

/** Stored in renderer localStorage (lib/notify.ts): every notification decision is made in the renderer. */
function NotificationsSection() {
  const t = useT()
  const prefs = useNotifyPrefs()
  const soundEffects = useDevicePrefs((s) => s.soundEffects)
  const flashLabel =
    window.nexo.platform === 'darwin' ? t('Bounce the Dock icon when you’re mentioned') : t('Flash the taskbar when you’re mentioned')
  return (
    <section>
      <h3 className="settings-heading">{t('Notifications')}</h3>
      <div className="toggle-row is-static">
        <span className="toggle-text">
          <span id="notify-level-label">{t('Desktop notifications')}</span>
          <span className="muted small">{t("For channels you're not looking at.")}</span>
        </span>
        <div className="vx-seg" role="radiogroup" aria-labelledby="notify-level-label">
          {NOTIFY_LEVELS.map((l) => (
            <button
              key={l.id}
              type="button"
              role="radio"
              aria-checked={prefs.desktop === l.id}
              className={`vx-seg-btn ${prefs.desktop === l.id ? 'is-active' : ''}`}
              title={l.title && t(l.title)}
              onClick={() => setNotifyPrefs({ desktop: l.id })}
            >
              {t(l.label)}
            </button>
          ))}
        </div>
      </div>
      <label className="toggle-row">
        <span className="toggle-text">
          <span>{t('Notification sound')}</span>
          {!soundEffects && <span className="muted small">{t('Silent while sound effects are off in Audio & video.')}</span>}
        </span>
        <input
          type="checkbox"
          role="switch"
          className="switch"
          checked={prefs.sound}
          disabled={prefs.desktop === 'off'}
          onChange={(e) => setNotifyPrefs({ sound: e.target.checked })}
        />
      </label>
      <label className="toggle-row">
        <span className="toggle-text">
          <span>{flashLabel}</span>
          <span className="muted small">{t('Only while Nexo is in the background.')}</span>
        </span>
        <input
          type="checkbox"
          role="switch"
          className="switch"
          checked={prefs.flash}
          onChange={(e) => setNotifyPrefs({ flash: e.target.checked })}
        />
      </label>
      <div className="settings-actions-row">
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          onClick={() =>
            window.nexo.notifications.show({
              channelId: 'nexo-test',
              title: 'Nexo',
              body: t('Notifications are working. Unread mentions also show on the taskbar and the tray icon.'),
              icon: null,
            })
          }
        >
          {t('Send a test notification')}
        </button>
      </div>
    </section>
  )
}

function AppSection() {
  const t = useT()
  const [prefs, setPrefs] = useState<AppPrefs | null>(null)
  const [loadFailed, setLoadFailed] = useState(false)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    let alive = true
    void fastCaptureAtStartup()
    window.nexo.prefs
      .get()
      .then((p) => alive && setPrefs(p))
      .catch((err: unknown) => {
        console.error('[nexo] prefs.get failed', err)
        if (alive) setLoadFailed(true)
      })
    return () => {
      alive = false
    }
  }, [])

  const [restartNeeded, setRestartNeeded] = useState(false)
  // Main reports the native engine unavailable off Windows, unless the fake helper is on (NEXO_MEDIA_FAKE=1).
  const isWindows = window.nexo.platform === 'win32'
  const nativeCaps = useNativeCapabilities()
  const showEngine = isWindows || !!nativeCaps?.available
  // Missing in prefs written before the beta: the default is native (preload/api.ts).
  const engine: CaptureEngine = prefs?.captureEngine ?? 'native'

  const setPref = async (patch: Partial<AppPrefs>) => {
    if (!prefs || saving) return
    setSaving(true)
    setPrefs({ ...prefs, ...patch }) // optimistic
    try {
      const next = await window.nexo.prefs.set(patch)
      setPrefs(next)
      setRestartNeeded(next.fastCapture !== (await fastCaptureAtStartup()))
    } catch (err) {
      setPrefs(prefs)
      toast(err, 'error')
    } finally {
      setSaving(false)
    }
  }

  return (
    <section>
      <h3 className="settings-heading">{t('App')}</h3>
      {loadFailed ? (
        <div className="callout callout-warn">
          <AlertIcon size={16} />
          <span>{t("Couldn't load the app preferences")}</span>
        </div>
      ) : (
        <>
          <label className="toggle-row">
            <span className="toggle-text">
              <span>{t('Close to the system tray')}</span>
              <span className="muted small">{t('Nexo keeps running and stays in voice. Quit from the tray icon.')}</span>
            </span>
            <input
              type="checkbox"
              role="switch"
              className="switch"
              checked={prefs?.closeToTray ?? false}
              disabled={!prefs || saving}
              onChange={(e) => void setPref({ closeToTray: e.target.checked })}
            />
          </label>
          {showEngine && (
            <div className="toggle-row is-static">
              <span className="toggle-text">
                <span id="capture-engine-label">{t('Capture engine')}</span>
                <span className="muted small">
                  {t('Native uses your graphics card, so games keep their frame rate. Falls back to Chromium if it fails.')}
                </span>
                <span className="muted small">
                  {t('{status} Applies to your next stream.', { status: nativeCapabilitiesLine(t, nativeCaps) })}
                </span>
              </span>
              <div className="vx-seg" role="radiogroup" aria-labelledby="capture-engine-label">
                {CAPTURE_ENGINES.map((e) => (
                  <button
                    key={e.id}
                    type="button"
                    role="radio"
                    aria-checked={engine === e.id}
                    className={`vx-seg-btn ${engine === e.id ? 'is-active' : ''}`}
                    disabled={!prefs || saving}
                    onClick={() => engine !== e.id && void setPref({ captureEngine: e.id })}
                  >
                    {t(e.label)}
                  </button>
                ))}
              </div>
            </div>
          )}
          {isWindows && (
            <label className="toggle-row">
              <span className="toggle-text">
                <span>{t('Fast game capture')}</span>
                <span className="muted small">
                  {t('Chromium engine only. Turn it off if your stream shows a black or frozen picture.')}
                  {restartNeeded && <strong> {t('Restart Nexo to apply.')}</strong>}
                </span>
              </span>
              <input
                type="checkbox"
                role="switch"
                className="switch"
                checked={prefs?.fastCapture ?? false}
                disabled={!prefs || saving}
                onChange={(e) => void setPref({ fastCapture: e.target.checked })}
              />
            </label>
          )}
        </>
      )}
      {hasUpdates() && <UpdatesPanel />}
    </section>
  )
}

function updateStatusLine(t: Translate, s: UpdateState): { text: string; tone?: 'ok' | 'warn' } {
  // "Nexo 1.4.0", or a phrase when the version is unknown (a separate message: it isn't a name in every language).
  const version = s.version ?? ''
  const known = s.version ? 'known' : 'unknown'
  switch (s.status) {
    case 'unsupported':
      return { text: s.reason ?? t('Updates are not available for this build.') }
    case 'idle':
      return { text: t('Nexo checks for updates automatically.') }
    case 'checking':
      return { text: t('Checking for updates…') }
    case 'up-to-date':
      return { text: t("You're up to date."), tone: 'ok' }
    case 'available':
      return {
        text: s.canAutoInstall
          ? t('{known, select, known {Nexo {version} is available.} other {A new version is available.}}', { known, version })
          : t(
              '{known, select, known {Nexo {version} is available.} other {A new version is available.}} Download it from the release page.',
              { known, version },
            ),
        tone: 'ok',
      }
    case 'downloading':
      return {
        text: t('{known, select, known {Downloading Nexo {version}…} other {Downloading the new version…}} {percent}%', {
          known,
          version,
          percent: s.percent ?? 0,
        }),
      }
    case 'ready':
      return {
        text: t(
          '{known, select, known {Nexo {version} is downloaded.} other {The new version is downloaded.}} It installs when you restart or quit Nexo.',
          { known, version },
        ),
        tone: 'ok',
      }
    case 'error':
      return { text: t("Couldn't check for updates: {error}", { error: s.error ?? t('unknown error') }), tone: 'warn' }
  }
}

function UpdatesPanel() {
  const t = useT()
  const state = useUpdates((s) => s.state)
  const checking = useUpdates((s) => s.checking)
  const inCall = useInCall()
  if (!state) return null

  const { downloadUrl, releaseNotesUrl } = state
  const line = updateStatusLine(t, state)
  const busy = checking || state.status === 'checking' || state.status === 'downloading'
  const canCheck = state.status !== 'unsupported' && state.status !== 'ready' && !busy
  // A failed background check while an update is known: say so, without hiding the update.
  const staleError = (state.status === 'ready' || state.status === 'available') && state.error

  return (
    <>
      <h3 className="settings-heading">{t('Updates')}</h3>
      <dl className="kv">
        <dt>{t('Version')}</dt>
        <dd>
          <code>{state.currentVersion}</code>
          {state.testBuild && (
            <span className="muted small">
              {' · '}
              {state.leavingTestBuilds ? t('test build, switching to regular releases') : t('test build: updates only to newer test builds')}
            </span>
          )}
        </dd>
        <dt>{t('Status')}</dt>
        <dd className={line.tone ?? ''}>
          {line.text}
          {staleError && <span className="muted small"> {t('(last check failed: {error})', { error: staleError })}</span>}
        </dd>
      </dl>
      <div className="settings-actions">
        {state.status === 'ready' && state.canAutoInstall && (
          <button className="btn btn-primary btn-sm" onClick={() => useUpdates.getState().install()}>
            {inCall ? t('Restart to update (leaves the call)') : t('Restart to update')}
          </button>
        )}
        {state.status === 'available' && downloadUrl && (
          <button className="btn btn-primary btn-sm" onClick={() => window.nexo.openExternal(downloadUrl)}>
            {t('Download')}
          </button>
        )}
        {state.status !== 'unsupported' && (
          <button className="btn btn-ghost btn-sm" disabled={!canCheck} onClick={() => void useUpdates.getState().check()}>
            {busy && state.status !== 'downloading' ? t('Checking…') : t('Check for updates')}
          </button>
        )}
        {state.testBuild && !state.leavingTestBuilds && state.status !== 'unsupported' && (
          <button
            className="btn btn-ghost btn-sm"
            disabled={busy}
            title={t('Installs the newest regular release on the next restart, even if its version number is lower')}
            onClick={() => void useUpdates.getState().leaveTestBuilds()}
          >
            {t('Leave test builds')}
          </button>
        )}
        {releaseNotesUrl && (
          <button className="btn btn-ghost btn-sm" onClick={() => window.nexo.openExternal(releaseNotesUrl)}>
            {t('Release notes')}
          </button>
        )}
      </div>
    </>
  )
}

/** Message keys. */
const CONNECTION_LABELS: Record<ConnectionStatus, string> = {
  idle: msg('Not connected'),
  connecting: msg('Connecting…'),
  connected: msg('Connected'),
  reconnecting: msg('Reconnecting…'),
  error: msg('Connection error'),
}

function ServerSection({ onDone }: { onDone(): void }) {
  const t = useT()
  const serverName = useApp((s) => s.serverName)
  const serverUrl = useApp((s) => s.serverUrl)
  const connection = useApp((s) => s.connection)
  const me = useApp((s) => s.me)
  const [confirmLogout, setConfirmLogout] = useState(false)

  return (
    <section>
      <h3 className="settings-heading">{t('Server')}</h3>
      <dl className="kv">
        <dt>{t('Name')}</dt>
        <dd>{serverName}</dd>
        <dt>{t('Address')}</dt>
        <dd>
          <code>{serverUrl}</code>
        </dd>
        <dt>{t('Status')}</dt>
        <dd className={connection === 'connected' ? 'ok' : 'warn'}>{t(CONNECTION_LABELS[connection])}</dd>
      </dl>

      <div className="settings-actions">
        <button
          className="btn btn-ghost"
          onClick={() => {
            onDone()
            useApp.getState().changeServer()
          }}
        >
          {t('Switch server')}
        </button>
        <span className="muted small">{t('You stay signed in here.')}</span>
      </div>

      <div className="danger-zone">
        <div>
          <strong>{t('Log out of this device')}</strong>
          <p className="muted small">
            {t.rich("Deletes this device's key. Without it, <b>{name}</b> can't be recovered and you'd join with a new name.", {
              name: me?.name ?? '',
              b: (c) => <strong>{c}</strong>,
            })}
          </p>
        </div>
        <button className="btn btn-danger" onClick={() => setConfirmLogout(true)}>
          <LogoutIcon size={16} /> {t('Log out')}
        </button>
      </div>

      {confirmLogout && (
        <ConfirmDialog
          title={t('Log out of this device?')}
          danger
          confirmLabel={t('Log out')}
          message={
            <div className="callout callout-warn">
              <AlertIcon size={16} />
              <span>
                {t.rich(
                  "Without this device's key, <b>{name}</b> can't be signed back in. Your messages stay, but you'll need to join with a different name.",
                  { name: me?.name ?? '', b: (c) => <strong>{c}</strong> },
                )}
              </span>
            </div>
          }
          onClose={() => setConfirmLogout(false)}
          onConfirm={async () => {
            setConfirmLogout(false)
            onDone()
            await useApp.getState().logout()
          }}
        />
      )}
    </section>
  )
}
