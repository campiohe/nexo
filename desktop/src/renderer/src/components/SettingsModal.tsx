import { useEffect, useRef, useState, type ChangeEvent } from 'react'
import type { AppPrefs, CaptureEngine, HotkeyStatus, Keybind, NativeShareCapabilities, UpdateState } from '../../../preload/api'
import { useApp } from '../store/app'
import { useUi } from '../store/ui'
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
import { useVoice } from '../voice/session'
import { Avatar } from './Avatar'
import { AvatarCropDialog } from './AvatarCropDialog'
import { ColorSwatches } from './ColorSwatches'
import { ConfirmDialog, Modal } from './Modal'
import { AlertIcon, LogoutIcon } from './icons'

type Tab = 'profile' | 'av' | 'keybinds' | 'app' | 'members' | 'server'

/** The App section needs the Electron bridge (window.nexo.prefs); it's hidden in a plain browser. */
const hasPrefs = () => typeof window.nexo?.prefs?.get === 'function'

const TABS: { id: Tab; label: string; available?: () => boolean }[] = [
  { id: 'profile', label: 'Profile' },
  { id: 'av', label: 'Audio & video' },
  { id: 'keybinds', label: 'Keybinds' },
  { id: 'app', label: 'App', available: hasPrefs },
  { id: 'members', label: 'Members' },
  { id: 'server', label: 'Server' },
]

export function SettingsModal() {
  const open = useUi((s) => s.settingsOpen)
  const close = () => useUi.getState().openSettings(false)
  const [tab, setTab] = useState<Tab>('profile')
  if (!open) return null

  return (
    <Modal title="Settings" onClose={close} width={720} className="settings-modal">
      <div className="settings">
        <nav className="settings-nav" role="tablist" aria-label="Settings sections">
          {TABS.filter((t) => !t.available || t.available()).map((t) => (
            <button
              key={t.id}
              role="tab"
              aria-selected={tab === t.id}
              className={`settings-tab ${tab === t.id ? 'is-active' : ''}`}
              onClick={() => setTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </nav>
        <div className="settings-panel" role="tabpanel">
          {tab === 'profile' && <ProfileSection />}
          {tab === 'av' && (
            <section>
              <h3 className="settings-heading">Audio & video</h3>
              <DeviceSettings />
            </section>
          )}
          {tab === 'keybinds' && <KeybindsSection />}
          {tab === 'app' && hasPrefs() && <AppSection />}
          {tab === 'members' && <MembersSection />}
          {tab === 'server' && <ServerSection onDone={close} />}
        </div>
      </div>
    </Modal>
  )
}

function ProfileSection() {
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
      <h3 className="settings-heading">Profile</h3>
      <div className="profile-card">
        <Avatar user={me} size={96} />
        <div className="profile-card-text">
          <div className="profile-name" style={{ color: me.color }}>
            {me.name}
          </div>
          <div className="muted small">Your display name is tied to this device.</div>
          <AvatarActions hasAvatar={!!me.avatar} />
        </div>
      </div>
      <div className="field">
        <span className="field-label">Color</span>
        <ColorSwatches value={me.color} onChange={pick} colors={SWATCHES} disabled={saving} />
      </div>
    </section>
  )
}

function AvatarActions({ hasAvatar }: { hasAvatar: boolean }) {
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
    const pending = toast('Uploading picture…', 'info', 30_000)
    try {
      await uploadAvatar(picture)
      setImage(null)
      toast('Profile picture updated', 'success')
    } finally {
      useToasts.getState().dismiss(pending)
    }
  }

  const remove = async () => {
    if (busy) return
    setBusy(true)
    try {
      await removeAvatar()
      toast('Profile picture removed', 'success')
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
        Upload picture
      </button>
      {hasAvatar && (
        <button className="btn btn-ghost btn-sm" onClick={remove} disabled={busy}>
          Remove
        </button>
      )}
      {image && <AvatarCropDialog image={image} onCancel={() => setImage(null)} onConfirm={upload} />}
    </div>
  )
}

const KEYBIND_HINTS: Partial<Record<HotkeyAction, string>> = {
  toggleShare: 'Stops your stream, or brings Nexo to the front with the share picker open.',
}

/** SPEC §13.2: record / clear each action's combination; in-app shortcuts can be reset to their default. */
function KeybindsSection() {
  const keybinds = useKeybinds()
  const pttBinding = useInputPrefs((s) => s.pttBinding)
  const inputMode = useInputPrefs((s) => s.inputMode)
  const hookStatus = usePtt((s) => s.hookStatus)
  const capturing = usePtt((s) => s.capturing)
  const [recording, setRecording] = useState<HotkeyAction | null>(null)
  const [error, setError] = useState<{ action: HotkeyAction; text: string } | null>(null)
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
      setError({ action, text: `${result.label} is already used by ${actionLabel(conflict)}. Clear it there first.` })
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
      setError({ action, text: `${def.label} is used by ${actionLabel(conflict)}. Clear it there first.` })
      return
    }
    setKeybind(action, def)
  }

  const anyGlobal = HOTKEY_ACTIONS.some((a) => a.scope === 'global' && bindings[a.id])
  const reason =
    anyGlobal && hookStatus && !hookStatus.active && hookStatus.reason
      ? `${hookStatus.reason} Until then, these shortcuts only work while Nexo is focused.`
      : !anyGlobal && probe?.reason
        ? `${probe.reason} Without it, global shortcuts only work while Nexo is focused.`
        : null

  const row = (action: HotkeyAction) => {
    const b = bindings[action]
    const isRecording = recording === action && capturing
    const inApp = isInAppAction(action)
    const hint =
      action === 'ptt'
        ? inputMode === 'ptt'
          ? 'Hold to talk. Holding extra modifiers (like Shift) still talks.'
          : 'Used when Input mode is Push to talk (Audio & video).'
        : KEYBIND_HINTS[action]
    const isDefault = inApp && !!b && sameCombo(b, defaultInAppBinding(action))
    return (
      <div key={action} className="kb-item">
        <div className="kb-row">
          <span className="toggle-text">
            <span>{actionLabel(action)}</span>
            {hint && <span className="muted small">{hint}</span>}
          </span>
          <button
            type="button"
            className={`vx-keybind kb-combo ${isRecording ? 'is-recording' : b ? '' : 'is-empty'}`}
            onClick={() => void record(action)}
            aria-label={
              isRecording
                ? 'Recording: press a key combination or mouse button. Esc cancels, Backspace clears.'
                : `Change the ${actionLabel(action)} shortcut`
            }
            title={b?.label}
          >
            {isRecording ? 'Press keys…' : (b?.label ?? 'Not set')}
          </button>
          <button type="button" className="btn btn-ghost btn-sm" disabled={!b || isRecording} onClick={() => setKeybind(action, null)}>
            Clear
          </button>
          {inApp && (
            <button type="button" className="btn btn-ghost btn-sm" disabled={isDefault || isRecording} onClick={() => reset(action)}>
              Reset
            </button>
          )}
        </div>
        {error?.action === action && (
          <p className="kb-error" role="alert">
            {error.text}
          </p>
        )}
      </div>
    )
  }

  return (
    <section>
      <h3 className="settings-heading">Keybinds</h3>
      <p className="muted small kb-intro">
        {capturing
          ? 'Hold any modifiers and press a key or mouse button. To bind a modifier alone, press and release it. Esc cancels, Backspace clears.'
          : 'Click a shortcut to record a new one. Left and right click can’t be used.'}
      </p>
      {reason && (
        <div className="callout callout-warn">
          <AlertIcon size={16} />
          <span>{reason}</span>
        </div>
      )}
      <div className="kb-group">
        <span className="field-label">Global</span>
        <span className="muted small">
          Work even while another app, like a game, is focused. None are set by default, so they never clash with your games.
        </span>
        {HOTKEY_ACTIONS.filter((a) => a.scope === 'global').map((a) => row(a.id))}
      </div>
      <div className="kb-group">
        <span className="field-label">In Nexo</span>
        <span className="muted small">Only while the Nexo window is focused.</span>
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
  { id: 'native', label: 'Native (beta)' },
  { id: 'chromium', label: 'Chromium' },
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

function errorText(err: unknown): string {
  return err instanceof Error && err.message ? err.message : 'The capture helper did not start'
}

function nativeCapabilitiesLine(caps: NativeShareCapabilities | null): string {
  if (!caps) return 'Checking your graphics card…'
  if (!caps.available) return `Native capture isn't available on this PC: ${caps.reason ?? 'unknown reason'}. Streams use Chromium.`
  const encoder = caps.encoder ?? 'the hardware encoder'
  return caps.adapter ? `Streams with ${encoder} on ${caps.adapter}.` : `Streams with ${encoder}.`
}

function AppSection() {
  const [prefs, setPrefs] = useState<AppPrefs | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    let alive = true
    void fastCaptureAtStartup()
    window.nexo.prefs
      .get()
      .then((p) => alive && setPrefs(p))
      .catch((err: unknown) => {
        console.error('[nexo] prefs.get failed', err)
        if (alive) setError("Couldn't load the app preferences")
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
      <h3 className="settings-heading">App</h3>
      {error ? (
        <div className="callout callout-warn">
          <AlertIcon size={16} />
          <span>{error}</span>
        </div>
      ) : (
        <>
          <label className="toggle-row">
            <span className="toggle-text">
              <span>Close button minimizes Nexo to the system tray</span>
              <span className="muted small">
                Nexo keeps running (and stays in voice) in the tray. Quit from the tray icon's menu.
              </span>
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
            <div className="toggle-row" style={{ cursor: 'default' }}>
              <span className="toggle-text">
                <span id="capture-engine-label">Capture engine</span>
                <span className="muted small">
                  Native captures and encodes streams on your graphics card, outside Nexo, so games keep their frame
                  rate and the stream stays smooth. If it fails, Nexo switches to Chromium on its own.{' '}
                  {nativeCapabilitiesLine(nativeCaps)} Applies to your next stream.
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
                    {e.label}
                  </button>
                ))}
              </div>
            </div>
          )}
          {isWindows && (
            <label className="toggle-row">
              <span className="toggle-text">
                <span>Fast game capture</span>
                <span className="muted small">
                  Chromium capture engine only. Keeps stream frames on the GPU, so streams stay smooth while a game
                  keeps your GPU busy. Turn it off if your stream shows a black or frozen picture.
                  {restartNeeded && <strong> Restart Nexo to apply.</strong>}
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

function updateStatusLine(s: UpdateState): { text: string; tone?: 'ok' | 'warn' } {
  const v = s.version ? `Nexo ${s.version}` : 'A new version'
  switch (s.status) {
    case 'unsupported':
      return { text: s.reason ?? 'Updates are not available for this build.' }
    case 'idle':
      return { text: 'Nexo checks for updates automatically.' }
    case 'checking':
      return { text: 'Checking for updates…' }
    case 'up-to-date':
      return { text: "You're up to date.", tone: 'ok' }
    case 'available':
      return {
        text: s.canAutoInstall ? `${v} is available.` : `${v} is available. Download it from the release page.`,
        tone: 'ok',
      }
    case 'downloading':
      return { text: `Downloading ${v}… ${s.percent ?? 0}%` }
    case 'ready':
      return { text: `${v} is downloaded. It installs when you restart or quit Nexo.`, tone: 'ok' }
    case 'error':
      return { text: `Couldn't check for updates: ${s.error ?? 'unknown error'}`, tone: 'warn' }
  }
}

function UpdatesPanel() {
  const state = useUpdates((s) => s.state)
  const checking = useUpdates((s) => s.checking)
  const inCall = useInCall()
  if (!state) return null

  const { downloadUrl, releaseNotesUrl } = state
  const line = updateStatusLine(state)
  const busy = checking || state.status === 'checking' || state.status === 'downloading'
  const canCheck = state.status !== 'unsupported' && state.status !== 'ready' && !busy
  // A failed background check while an update is known: say so, without hiding the update.
  const staleError = (state.status === 'ready' || state.status === 'available') && state.error

  return (
    <>
      <h3 className="settings-heading">Updates</h3>
      <dl className="kv">
        <dt>Version</dt>
        <dd>
          <code>{state.currentVersion}</code>
          {state.testBuild && (
            <span className="muted small">
              {state.leavingTestBuilds ? ' · test build, switching to regular releases' : ' · test build: updates only to newer test builds'}
            </span>
          )}
        </dd>
        <dt>Status</dt>
        <dd className={line.tone ?? ''}>
          {line.text}
          {staleError && <span className="muted small"> (last check failed: {staleError})</span>}
        </dd>
      </dl>
      <div className="settings-actions">
        {state.status === 'ready' && state.canAutoInstall && (
          <button className="btn btn-primary btn-sm" onClick={() => useUpdates.getState().install()}>
            {inCall ? 'Restart to update (leaves the call)' : 'Restart to update'}
          </button>
        )}
        {state.status === 'available' && downloadUrl && (
          <button className="btn btn-primary btn-sm" onClick={() => window.nexo.openExternal(downloadUrl)}>
            Download
          </button>
        )}
        {state.status !== 'unsupported' && (
          <button className="btn btn-ghost btn-sm" disabled={!canCheck} onClick={() => void useUpdates.getState().check()}>
            {busy && state.status !== 'downloading' ? 'Checking…' : 'Check for updates'}
          </button>
        )}
        {state.testBuild && !state.leavingTestBuilds && state.status !== 'unsupported' && (
          <button
            className="btn btn-ghost btn-sm"
            disabled={busy}
            title="Installs the newest regular release on the next restart, even if its version number is lower"
            onClick={() => void useUpdates.getState().leaveTestBuilds()}
          >
            Leave test builds
          </button>
        )}
        {releaseNotesUrl && (
          <button className="btn btn-ghost btn-sm" onClick={() => window.nexo.openExternal(releaseNotesUrl)}>
            Release notes
          </button>
        )}
      </div>
    </>
  )
}

function ServerSection({ onDone }: { onDone(): void }) {
  const serverName = useApp((s) => s.serverName)
  const serverUrl = useApp((s) => s.serverUrl)
  const connection = useApp((s) => s.connection)
  const me = useApp((s) => s.me)
  const [confirmLogout, setConfirmLogout] = useState(false)

  return (
    <section>
      <h3 className="settings-heading">Server</h3>
      <dl className="kv">
        <dt>Name</dt>
        <dd>{serverName}</dd>
        <dt>Address</dt>
        <dd>
          <code>{serverUrl}</code>
        </dd>
        <dt>Status</dt>
        <dd className={connection === 'connected' ? 'ok' : 'warn'}>{connection}</dd>
      </dl>

      <div className="settings-actions">
        <button
          className="btn btn-ghost"
          onClick={() => {
            onDone()
            useApp.getState().changeServer()
          }}
        >
          Switch server
        </button>
        <span className="muted small">Keeps this device signed in here, so you can come back later.</span>
      </div>

      <div className="danger-zone">
        <div>
          <strong>Log out of this device</strong>
          <p className="muted small">
            Removes this device's key for this server. The name <strong>{me?.name}</strong> can't be recovered without it — you'd
            have to join again with a new name.
          </p>
        </div>
        <button className="btn btn-danger" onClick={() => setConfirmLogout(true)}>
          <LogoutIcon size={16} /> Log out
        </button>
      </div>

      {confirmLogout && (
        <ConfirmDialog
          title="Log out of this device?"
          danger
          confirmLabel="Log out"
          message={
            <div className="callout callout-warn">
              <AlertIcon size={16} />
              <span>
                Without this device's key, <strong>{me?.name}</strong> can't be signed back in. Your messages stay, but you'll
                need to join with a different name.
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
