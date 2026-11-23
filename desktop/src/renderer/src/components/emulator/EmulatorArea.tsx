// Emulator plugin UI (docs/SPEC.md §5.5): the area that takes the voice stage's main spot while someone hosts a
// game in your channel. The host sees the engine's canvas (no delay) with the game controls; everyone else sees
// the host's stream (watched automatically while the area is shown). Four controller ports: take a free one to
// play (your keyboard / gamepad go to the host through the server), the host or an admin can assign them.
// The host's engine and its lifecycle: ./host.ts.
import { useEffect, useLayoutEffect, useRef, useState, type DragEvent } from 'react'
import { EMU_PORTS, GAME_PAD, type EmuSession, type EmuSystem, type User } from '@shared/protocol'
import { useApp } from '../../store/app'
import { useEmulator, setEmulatorHidden } from '../../store/emulator'
import { assignEmuPort, sendEmuInput, stopEmu, takeEmuPort } from '../../emulator/actions'
import type { EmulatorEngine } from '../../emulator/types'
import { startPadInput, BUTTON_KEYS } from '../../emulator/input'
import { EMU_SYSTEM_INFO } from '../../emulator/systems'
import { isStaff } from '../../lib/permissions'
import { setStreamVolume, stopWatching, useVoice, watchStream } from '../../voice/session'
import { useParticipants } from '../../voice/participants'
import { Avatar } from '../Avatar'
import { VideoTrackView } from '../voice/VideoTrackView'
import {
  hostGameFiles,
  quickLoad,
  quickSave,
  resetGame,
  restreamGame,
  setGameVolume,
  stopHosting,
  togglePause,
  useEmuHost,
} from './host'
import { ConsoleIcon, dragHasFiles, GameFileInput, LoadProgress } from './EmulatorEntry'
import { msg, useT } from '../../i18n'
import '../../styles/emulator.css'

/** One color per controller port (P1 red, P2 blue, P3 yellow, P4 green). */
const PORT_COLORS = ['#ff5a5f', '#3d9cff', '#ffd23f', '#3ee6b0']
const portColor = (i: number) => PORT_COLORS[i % PORT_COLORS.length]

export function EmulatorArea({ channelId }: { channelId: string }) {
  const session = useEmulator((s) => s.byChannel[channelId])
  const meId = useApp((s) => s.me?.id)
  const staff = useApp((s) => !!s.me && isStaff(s.me))
  const hostUser = useApp((s) => (session ? s.users[session.hostId] : undefined))
  const engine = useEmuHost((s) => (s.channelId === channelId ? s.engine : null))
  const loading = useEmuHost((s) => s.loading)
  const fileInput = useRef<HTMLInputElement>(null)
  const [helpOpen, setHelpOpen] = useState(false)
  const [dropOver, setDropOver] = useState(false)
  const t = useT()

  if (!session) return null
  const isHost = session.hostId === meId
  const canManage = isHost || staff
  const myPort = meId ? session.ports.indexOf(meId) : -1
  const hostName = hostUser?.name

  const pickFile = () => fileInput.current?.click()
  const onDragOver = (e: DragEvent) => {
    if (!isHost || !dragHasFiles(e)) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
    setDropOver(true)
  }
  const onDrop = (e: DragEvent) => {
    if (!dragHasFiles(e)) return
    e.preventDefault()
    setDropOver(false)
    const files = Array.from(e.dataTransfer.files)
    if (isHost && files.length && !loading) void hostGameFiles(channelId, files)
  }
  const info = EMU_SYSTEM_INFO[session.system] as (typeof EMU_SYSTEM_INFO)[EmuSystem] | undefined

  return (
    <section className="gm-area emu-area" aria-label={t('Emulator')}>
      <header className="gm-head">
        <span className="gm-head-icon">
          <ConsoleIcon size={16} />
        </span>
        <span className="gm-head-title" title={session.title}>
          {session.title}
        </span>
        <span className="gm-chip emu-chip-system" title={info?.name}>
          {info?.short ?? String(session.system).toUpperCase()}
        </span>
        {session.paused ? (
          <span className="gm-chip gm-chip-finished">{t('Paused // game')}</span>
        ) : (
          <span className="gm-chip gm-chip-playing">{t('Live')}</span>
        )}
        <span className="emu-head-host">
          {isHost ? t('hosted by you') : t('hosted by {name}', { name: hostName ?? t('someone') })}
        </span>
        <span className="gm-head-spacer" />
        {isHost && (
          <button className="gm-btn gm-btn-ghost" onClick={pickFile} disabled={!!loading} title={t('Load another game (any console)')}>
            {loading ? t('Loading…') : t('Load another game')}
          </button>
        )}
        {canManage && (
          <button
            className="gm-btn gm-btn-ghost"
            onClick={() => (isHost ? stopHosting(true) : void stopEmu(channelId))}
            title={t('End the game for everyone')}
          >
            {t('Stop')}
          </button>
        )}
        <button className="gm-btn gm-btn-ghost" onClick={() => setEmulatorHidden(channelId, true)} title={t('Show people instead')}>
          {t('Hide')}
        </button>
        {isHost && <GameFileInput inputRef={fileInput} channelId={channelId} />}
      </header>
      <div className="emu-body">
        <div className="emu-main">
          <div
            className={`emu-screen ${dropOver ? 'is-drop' : ''}`}
            onDragOver={onDragOver}
            onDragLeave={() => setDropOver(false)}
            onDrop={onDrop}
          >
            {isHost && engine ? (
              <HostScreen engine={engine} />
            ) : isHost ? (
              <div className="emu-placeholder">
                <ConsoleIcon size={40} />
                <p>{t("Your game isn't running on this device. Load the game file again, or stop the session.")}</p>
                <button className="gm-btn gm-btn-primary" onClick={pickFile} disabled={!!loading}>
                  {loading ? t('Loading…') : t('Load a game file')}
                </button>
              </div>
            ) : (
              <HostStream hostId={session.hostId} hostName={hostName} />
            )}
            {session.paused && (
              <div className="emu-paused" role="status">
                {isHost ? (
                  <>
                    <span>{t('Paused // game')}</span>
                    <button className="gm-btn gm-btn-primary" onClick={togglePause}>
                      {t('Resume')}
                    </button>
                  </>
                ) : (
                  <span>{t('Paused by the host')}</span>
                )}
              </div>
            )}
            {dropOver && <div className="emu-drop">{t('Drop to load this game')}</div>}
            {isHost && loading && (
              <div className="emu-loading-over">
                <LoadProgress loading={loading} />
              </div>
            )}
          </div>
          {isHost ? engine && <HostBar engine={engine} paused={session.paused} /> : <ViewerBar hostId={session.hostId} />}
        </div>
        <aside className="emu-side">
          <h3 className="gm-side-title">{t('Controllers')}</h3>
          <Ports channelId={channelId} session={session} meId={meId} canManage={canManage} />
          {myPort >= 0 ? (
            <p className="emu-note">
              {t.rich("You're <b>player {number}</b>.", { number: myPort + 1, b: (c) => <strong>{c}</strong> })}{' '}
              {isHost
                ? t('Your keys go straight to the game.')
                : hostName
                  ? t("Your keys go to {name}'s game while this view is open.", { name: hostName })
                  : t("Your keys go to the host's game while this view is open.")}
            </p>
          ) : (
            <p className="emu-note">{t('Take a free controller to play. Everyone else watches.')}</p>
          )}
          <button className="emu-help-toggle" onClick={() => setHelpOpen((o) => !o)} aria-expanded={helpOpen}>
            {helpOpen ? t('Hide controls') : t('Show controls')}
          </button>
          {helpOpen && <ControlsHelp system={session.system} />}
          <p className="emu-note emu-latency">
            {isHost
              ? t(
                  'You play without delay. Friends see your stream, so their presses reach the game after a short round trip (about 0.1–0.2 s on a good connection).',
                )
              : hostName
                ? t(
                    "You see {name}'s stream, so a press takes a round trip to their computer and back: about 0.1–0.2 s on a good connection. Fine for most games, noticeable in fast action games.",
                    { name: hostName },
                  )
                : t(
                    "You see the host's stream, so a press takes a round trip to their computer and back: about 0.1–0.2 s on a good connection. Fine for most games, noticeable in fast action games.",
                  )}
          </p>
        </aside>
      </div>
      <PadInput channelId={channelId} session={session} meId={meId} engine={isHost ? engine : null} />
    </section>
  )
}

// ---------- screens ----------

/** The host's own view: the engine's canvas, attached here while shown (no stream round trip). */
function HostScreen({ engine }: { engine: EmulatorEngine }) {
  const ref = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const canvas = engine.canvas
    canvas.classList.add('emu-canvas')
    el.appendChild(canvas)
    return () => {
      if (canvas.parentElement === el) el.removeChild(canvas)
    }
  }, [engine])
  return <div className="emu-frame" ref={ref} />
}

/**
 * Everyone else: the host's stream, watched automatically while this view is shown (and no longer when it
 * goes away, unless you were already watching it before).
 */
function HostStream({ hostId, hostName }: { hostId: string; hostName: string | undefined }) {
  const view = useParticipants((s) => s.list.find((p) => p.identity === hostId))
  const streaming = !!view?.isStreaming
  const watching = useParticipants((s) => !!s.watching[hostId])
  const autoWatched = useRef<string | null>(null)
  const t = useT()

  useEffect(() => {
    if (!streaming || useParticipants.getState().watching[hostId]) return
    watchStream(hostId)
    autoWatched.current = hostId
  }, [hostId, streaming])

  useEffect(
    () => () => {
      if (autoWatched.current === hostId) stopWatching(hostId)
      autoWatched.current = null
    },
    [hostId],
  )

  const track = watching ? (view?.screenTrack ?? null) : null
  if (!track) {
    return (
      <div className="emu-placeholder">
        <span className="vx-spinner" aria-hidden="true" />
        <p>
          {streaming
            ? hostName
              ? t("Loading {name}'s stream…", { name: hostName })
              : t("Loading the host's stream…")
            : hostName
              ? t("Waiting for {name}'s stream…", { name: hostName })
              : t("Waiting for the host's stream…")}
        </p>
      </div>
    )
  }
  return (
    <div className="emu-frame">
      <VideoTrackView track={track} fit="contain" className="emu-video" />
    </div>
  )
}

// ---------- bars under the screen ----------

function HostBar({ engine, paused }: { engine: EmulatorEngine; paused: boolean }) {
  const volume = useEmuHost((s) => s.volume)
  const hasSave = useEmuHost((s) => s.hasSave)
  const streaming = useVoice((s) => s.sharing && s.shareEngine === 'emulator')
  const starting = useVoice((s) => s.shareStarting)
  const canSave = typeof engine.saveState === 'function' && typeof engine.loadState === 'function'
  const t = useT()
  return (
    <footer className="emu-bar">
      <button className="gm-btn" onClick={togglePause}>
        {paused ? t('Resume') : t('Pause')}
      </button>
      <button className="gm-btn" onClick={resetGame} title={t("The console's reset button")}>
        {t('Reset // console button')}
      </button>
      {canSave && (
        <>
          <button className="gm-btn" onClick={() => void quickSave()} title={t('Remember this moment (until you load another game)')}>
            {t('Quick save')}
          </button>
          <button className="gm-btn" onClick={() => void quickLoad()} disabled={!hasSave} title={t('Go back to the quick save')}>
            {t('Quick load')}
          </button>
        </>
      )}
      <span className="gm-head-spacer" />
      {streaming ? (
        <span className="emu-live" title={t('Your game is your stream in this call')}>
          <span className="vx-live-badge is-small">{t('LIVE')}</span> {t('Streaming')}
        </span>
      ) : (
        <span className="emu-warn">
          {starting ? (
            t('Starting the stream…')
          ) : (
            <>
              {t('Not streaming')}{' '}
              <button className="gm-btn" onClick={() => void restreamGame()}>
                {t('Stream it')}
              </button>
            </>
          )}
        </span>
      )}
      <Volume label={t('Game volume (only for you)')} value={volume} onChange={setGameVolume} />
    </footer>
  )
}

function ViewerBar({ hostId }: { hostId: string }) {
  const volume = useParticipants((s) => s.streamVolumes[hostId] ?? 1)
  const deafened = useVoice((s) => s.deafened)
  const t = useT()
  return (
    <footer className="emu-bar">
      <span className="emu-note">{deafened ? t("You're deafened: no game sound.") : t('Game sound comes with the stream.')}</span>
      <span className="gm-head-spacer" />
      <Volume label={t('Game volume')} value={volume} onChange={(v) => setStreamVolume(hostId, v)} />
    </footer>
  )
}

function Volume({ label, value, onChange }: { label: string; value: number; onChange(v: number): void }) {
  const pct = Math.round(value * 100)
  const t = useT()
  return (
    <label className="emu-volume" title={t('{label}: {percent}%', { label, percent: pct })}>
      <span className="emu-volume-label">{t('Volume')}</span>
      <input
        className="vx-range"
        type="range"
        min={0}
        max={100}
        value={pct}
        onChange={(e) => onChange(Number(e.target.value) / 100)}
        aria-label={label}
        style={{ ['--fill' as string]: `${pct}%` }}
      />
    </label>
  )
}

// ---------- controller ports ----------

function Ports({ channelId, session, meId, canManage }: { channelId: string; session: EmuSession; meId: string | undefined; canManage: boolean }) {
  const users = useApp((s) => s.users)
  const [menu, setMenu] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)
  const t = useT()
  const myPort = meId ? session.ports.indexOf(meId) : -1
  const run = async (p: Promise<unknown>) => {
    setBusy(true)
    try {
      await p
    } finally {
      setBusy(false)
    }
  }
  const ports = Array.from({ length: EMU_PORTS }, (_, i) => session.ports[i] ?? null)
  return (
    <ul className="emu-ports">
      {ports.map((uid, i) => {
        const u = uid ? users[uid] : undefined
        const mine = !!uid && uid === meId
        return (
          <li key={i} className={`emu-port ${uid ? '' : 'is-free'} ${mine ? 'is-me' : ''}`}>
            <span className="emu-port-num" style={{ ['--port' as string]: portColor(i) }}>
              P{i + 1}
            </span>
            {uid ? (
              <>
                <Avatar user={u ?? { id: uid, name: t('Someone'), color: '#3a4152' }} size={22} />
                <span className="emu-port-name">
                  {u?.name ?? t('Someone')}
                  {mine && <span className="emu-port-you"> {t('(you)')}</span>}
                </span>
                {uid === session.hostId && !mine && <span className="gm-tag">{t('host')}</span>}
              </>
            ) : (
              <span className="emu-port-name emu-port-free">{t('Free // controller')}</span>
            )}
            {mine ? (
              <button
                className="gm-icon-btn emu-port-leave"
                disabled={busy}
                onClick={() => void run(takeEmuPort(channelId, null))}
                title={t('Give up this controller (watch instead)')}
              >
                {t('Leave // controller')}
              </button>
            ) : !uid ? (
              <button className="gm-btn emu-port-btn" disabled={busy} onClick={() => void run(takeEmuPort(channelId, i))}>
                {myPort >= 0 ? t('Move // controller') : t('Take // controller')}
              </button>
            ) : null}
            {canManage && (
              <span className="emu-port-menu-wrap">
                <button
                  className="gm-icon-btn emu-port-more"
                  onClick={() => setMenu(menu === i ? null : i)}
                  aria-label={t('Assign controller {number}', { number: i + 1 })}
                  aria-expanded={menu === i}
                  title={t('Assign this controller')}
                >
                  ⋯
                </button>
                {menu === i && (
                  <PortMenu
                    session={session}
                    port={i}
                    users={users}
                    onClose={() => setMenu(null)}
                    onPick={(userId) => {
                      setMenu(null)
                      void run(assignEmuPort(channelId, i, userId))
                    }}
                  />
                )}
              </span>
            )}
          </li>
        )
      })}
    </ul>
  )
}

/** Host / admins: put someone in the voice channel on this controller, or free it. */
function PortMenu({
  session,
  port,
  users,
  onClose,
  onPick,
}: {
  session: EmuSession
  port: number
  users: Record<string, User>
  onClose(): void
  onPick(userId: string | null): void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const voice = useApp((s) => s.voice)
  const members = voice.filter((v) => v.channelId === session.channelId).map((v) => v.userId)
  const current = session.ports[port] ?? null
  const t = useT()

  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('pointerdown', onDown, true)
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('pointerdown', onDown, true)
      window.removeEventListener('keydown', onKey, true)
    }
  }, [onClose])

  return (
    <div className="emu-menu" role="menu" ref={ref}>
      <p className="emu-menu-title">{t('Controller {number}', { number: port + 1 })}</p>
      {members
        .filter((id) => id !== current)
        .map((id) => {
          const other = session.ports.indexOf(id)
          return (
            <button key={id} role="menuitem" className="emu-menu-item" onClick={() => onPick(id)}>
              <Avatar user={users[id] ?? { id, name: t('Someone'), color: '#3a4152' }} size={18} />
              <span className="emu-port-name">{users[id]?.name ?? t('Someone')}</span>
              {other >= 0 && <span className="emu-menu-hint">P{other + 1}</span>}
            </button>
          )
        })}
      {members.filter((id) => id !== current).length === 0 && <p className="emu-menu-empty">{t('Nobody else is in the call.')}</p>}
      {current && (
        <button role="menuitem" className="emu-menu-item is-danger" onClick={() => onPick(null)}>
          {t('Free this controller')}
        </button>
      )}
    </div>
  )
}

// ---------- controls ----------

/** Gamepad names of Nexo's buttons (Xbox-style labels; buttons go by position). Descriptions are message keys (msg). */
const PAD_LABEL: Partial<Record<keyof typeof GAME_PAD, string>> = {
  L: 'LB',
  R: 'RB',
  L2: 'LT',
  R2: 'RT',
  L3: msg('left stick click'),
  R3: msg('right stick click'),
  START: 'Start / Menu',
  SELECT: 'Back / View',
}

const isPadButton = (k: string): k is keyof typeof GAME_PAD => k in GAME_PAD

/** One Nexo control → its keyboard keys and gamepad control. */
function ControlKeys({ control, consoleControl }: { control: string; consoleControl: string }) {
  const t = useT()
  if (control === 'D-pad') {
    // N64: the keyboard's arrows are the control stick, so its d-pad is only on a gamepad.
    if (/with a gamepad/i.test(consoleControl)) return <span className="emu-help-pad">{t('d-pad')}</span>
    return (
      <>
        <span className="emu-help-pad">{t('d-pad')} ·</span> <kbd>{t('Arrows')}</kbd> <kbd>WASD</kbd>
      </>
    )
  }
  // (On N64 the keyboard's arrows drive the control stick: its label says so.)
  if (control === 'Left stick') return <span className="emu-help-pad">{t('left stick')}</span>
  if (control === 'Right stick') return <span className="emu-help-pad">{t('right stick')}</span>
  if (!isPadButton(control)) return <span className="emu-help-pad">{control}</span>
  const pad = PAD_LABEL[control]
  return (
    <>
      <span className="emu-help-pad">{pad ? t(pad) : control} ·</span> <kbd>{BUTTON_KEYS[control]}</kbd>
    </>
  )
}

/** How this console's pad is played: each console control with the gamepad button and the keyboard keys. */
function ControlsHelp({ system }: { system: EmuSystem }) {
  const info = EMU_SYSTEM_INFO[system] as (typeof EMU_SYSTEM_INFO)[EmuSystem] | undefined
  const t = useT()
  if (!info) return <p className="emu-note">{t("This console's controls aren't known to this version of Nexo.")}</p>
  return (
    <dl className="gm-help emu-help">
      <p className="gm-help-pad emu-help-head">{t('{console}: console button · gamepad · keyboard', { console: info.name })}</p>
      {info.controls.map(([control, consoleControl]) => (
        <div key={`${control}:${consoleControl}`} className="gm-help-row">
          <dt>
            <span className="gm-help-label">{t(consoleControl)}</span>
          </dt>
          <dd>
            <ControlKeys control={control} consoleControl={consoleControl} />
          </dd>
        </div>
      ))}
      <p className="gm-help-pad">
        {t('Gamepad buttons go by position, like on an Xbox pad: A bottom, B right, X left, Y top.')}{' '}
        {!info.analog
          ? t('Gamepads work too (plug one in and press a button); the left stick works as the d-pad.')
          : system === 'n64'
            ? t(
                "A gamepad's sticks work as the console's: the right stick presses the C buttons. On a keyboard, the arrows / WASD move the control stick.",
              )
            : t(
                "A gamepad's sticks work as the console's analog sticks. On a keyboard, the arrows / WASD are the d-pad: most games play fine with it, the few that need the analog sticks need a gamepad.",
              )}
      </p>
    </dl>
  )
}

/**
 * Your controller while this view is shown: the host's goes straight into the engine on their port; a player's
 * goes to the server (relayed to the host). Released (0) when the port changes, the window loses focus or
 * the view goes away.
 */
function PadInput({
  channelId,
  session,
  meId,
  engine,
}: {
  channelId: string
  session: EmuSession
  meId: string | undefined
  engine: EmulatorEngine | null
}) {
  const port = meId ? session.ports.indexOf(meId) : -1
  const isHost = session.hostId === meId
  // Consoles with sticks get the gamepad's sticks as axes; others use the left stick as the d-pad.
  const analog = !!(EMU_SYSTEM_INFO[session.system] as (typeof EMU_SYSTEM_INFO)[EmuSystem] | undefined)?.analog

  useEffect(() => {
    if (port < 0) return
    if (isHost) {
      if (!engine) return
      const pad = startPadInput((mask, axes) => engine.setPad(port, mask, axes), { analog })
      return () => pad.stop() // sends 0 (sticks centered) to that port
    }
    const pad = startPadInput((mask, axes) => sendEmuInput(channelId, mask, axes), { analog })
    return () => pad.stop()
  }, [channelId, port, isHost, engine, analog])

  return null
}
