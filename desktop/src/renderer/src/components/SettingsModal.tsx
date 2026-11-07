import { useState } from 'react'
import { useApp } from '../store/app'
import { useUi } from '../store/ui'
import { SWATCHES } from '../lib/colors'
import { toast } from '../lib/toast'
import { DeviceSettings } from './voice/DeviceSettings'
import { Avatar } from './Avatar'
import { ColorSwatches } from './ColorSwatches'
import { ConfirmDialog, Modal } from './Modal'
import { AlertIcon, LogoutIcon } from './icons'

type Tab = 'profile' | 'av' | 'server'

const TABS: { id: Tab; label: string }[] = [
  { id: 'profile', label: 'Profile' },
  { id: 'av', label: 'Audio & video' },
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
          {TABS.map((t) => (
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
        <Avatar user={me} size={64} />
        <div>
          <div className="profile-name" style={{ color: me.color }}>
            {me.name}
          </div>
          <div className="muted small">Your display name is tied to this device.</div>
        </div>
      </div>
      <div className="field">
        <span className="field-label">Color</span>
        <ColorSwatches value={me.color} onChange={pick} colors={SWATCHES} disabled={saving} />
      </div>
    </section>
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
