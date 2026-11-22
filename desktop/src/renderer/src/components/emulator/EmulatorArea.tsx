// Emulator plugin UI (docs/SPEC.md §5.6): the area that takes the voice stage's main spot while someone hosts a
// game in your channel. The host sees the engine's canvas (no delay) with the game controls; everyone else sees
// the host's stream (watched automatically while the area is shown). Four controller ports: take a free one to
// play (your keyboard / gamepad go to the host through the server), the host or an admin can assign them.
// The host's engine and its lifecycle: ./host.ts.
import { useEffect, useLayoutEffect, useRef, useState, type DragEvent } from 'react'
import { EMU_PORTS, GAME_SEAT_COLORS, type EmuSession, type User } from '@shared/protocol'
import { useApp } from '../../store/app'
import { useEmulator, setEmulatorHidden } from '../../store/emulator'
import { assignEmuPort, sendEmuInput, stopEmu, takeEmuPort } from '../../emulator/actions'
import type { EmulatorEngine } from '../../emulator/types'
import { startPadInput, BUTTON_KEYS } from '../../games/input'
import { isStaff } from '../../lib/permissions'
import { setStreamVolume, stopWatching, useVoice, watchStream } from '../../voice/session'
import { useParticipants } from '../../voice/participants'
import { Avatar } from '../Avatar'
import { VideoTrackView } from '../voice/VideoTrackView'
import {
  acceptFor,
  hostGameFile,
  quickLoad,
  quickSave,
  resetGame,
  restreamGame,
  setGameVolume,
  stopHosting,
  togglePause,
  useEmuHost,
} from './host'
import { ConsoleIcon, dragHasFiles } from './EmulatorEntry'
import '../../styles/games.css'
import '../../styles/emulator.css'

const portColor = (i: number) => GAME_SEAT_COLORS[i % GAME_SEAT_COLORS.length]

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

  if (!session) return null
  const isHost = session.hostId === meId
  const canManage = isHost || staff
  const myPort = meId ? session.ports.indexOf(meId) : -1
  const hostName = isHost ? 'you' : (hostUser?.name ?? 'someone')

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
    const file = e.dataTransfer.files[0]
    if (isHost && file) void hostGameFile(channelId, file)
  }

  return (
    <section className="gm-area emu-area" aria-label="Emulator">
      <header className="gm-head">
        <span className="gm-head-icon">
          <ConsoleIcon size={16} />
        </span>
        <span className="gm-head-title" title={session.title}>
          {session.title}
        </span>
        <span className="gm-chip emu-chip-system">{session.system.toUpperCase()}</span>
        {session.paused ? <span className="gm-chip gm-chip-finished">Paused</span> : <span className="gm-chip gm-chip-playing">Live</span>}
        <span className="emu-head-host">hosted by {hostName}</span>
        <span className="gm-head-spacer" />
        {isHost && (
          <button className="gm-btn gm-btn-ghost" onClick={pickFile} disabled={!!loading} title="Load another game file">
            {loading ? 'Loading…' : 'Load another game'}
          </button>
        )}
        {canManage && (
          <button
            className="gm-btn gm-btn-ghost"
            onClick={() => (isHost ? stopHosting(true) : void stopEmu(channelId))}
            title="End the game for everyone"
          >
            Stop
          </button>
        )}
        <button className="gm-btn gm-btn-ghost" onClick={() => setEmulatorHidden(channelId, true)} title="Show people instead">
          Hide
        </button>
        {isHost && (
          <input
            ref={fileInput}
            type="file"
            accept={acceptFor(session.system)}
            hidden
            onChange={(e) => {
              const file = e.target.files?.[0]
              e.target.value = ''
              if (file) void hostGameFile(channelId, file)
            }}
          />
        )}
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
                <p>Your game isn't running on this device. Load the game file again, or stop the session.</p>
                <button className="gm-btn gm-btn-primary" onClick={pickFile} disabled={!!loading}>
                  {loading ? 'Loading…' : 'Load a game file'}
                </button>
              </div>
            ) : (
              <HostStream hostId={session.hostId} hostName={hostUser?.name ?? 'The host'} />
            )}
            {session.paused && (
              <div className="emu-paused" role="status">
                {isHost ? (
                  <>
                    <span>Paused</span>
                    <button className="gm-btn gm-btn-primary" onClick={togglePause}>
                      Resume
                    </button>
                  </>
                ) : (
                  <span>Paused by the host</span>
                )}
              </div>
            )}
            {dropOver && <div className="emu-drop">Drop to load this game</div>}
          </div>
          {isHost ? engine && <HostBar engine={engine} paused={session.paused} /> : <ViewerBar hostId={session.hostId} />}
        </div>
        <aside className="emu-side">
          <h3 className="gm-side-title">Controllers</h3>
          <Ports channelId={channelId} session={session} meId={meId} canManage={canManage} />
          {myPort >= 0 ? (
            <p className="emu-note">
              You're <strong>player {myPort + 1}</strong>.{' '}
              {isHost
                ? 'Your keys go straight to the game.'
                : `Your keys go to ${hostUser?.name ?? 'the host'}'s game while this view is open.`}
            </p>
          ) : (
            <p className="emu-note">Take a free controller to play. Everyone else watches.</p>
          )}
          <button className="emu-help-toggle" onClick={() => setHelpOpen((o) => !o)} aria-expanded={helpOpen}>
            {helpOpen ? 'Hide controls' : 'Show controls'}
          </button>
          {helpOpen && <ControlsHelp />}
          <p className="emu-note emu-latency">
            {isHost
              ? "You play without delay. Friends see your stream, so their presses reach the game after a short round trip (about 0.1–0.2 s on a good connection)."
              : `You see ${hostUser?.name ?? 'the host'}'s stream, so a press takes a round trip to their computer and back: about 0.1–0.2 s on a good connection. Fine for most games, noticeable in fast action games.`}
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
function HostStream({ hostId, hostName }: { hostId: string; hostName: string }) {
  const view = useParticipants((s) => s.list.find((p) => p.identity === hostId))
  const streaming = !!view?.isStreaming
  const watching = useParticipants((s) => !!s.watching[hostId])
  const autoWatched = useRef<string | null>(null)

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
        <p>{streaming ? `Loading ${hostName}'s stream…` : `Waiting for ${hostName}'s stream…`}</p>
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
  return (
    <footer className="emu-bar">
      <button className="gm-btn" onClick={togglePause}>
        {paused ? 'Resume' : 'Pause'}
      </button>
      <button className="gm-btn" onClick={resetGame} title="The console's reset button">
        Reset
      </button>
      {canSave && (
        <>
          <button className="gm-btn" onClick={() => void quickSave()} title="Remember this moment (until you load another game)">
            Quick save
          </button>
          <button className="gm-btn" onClick={() => void quickLoad()} disabled={!hasSave} title="Go back to the quick save">
            Quick load
          </button>
        </>
      )}
      <span className="gm-head-spacer" />
      {streaming ? (
        <span className="emu-live" title="Your game is your stream in this call">
          <span className="vx-live-badge is-small">LIVE</span> Streaming
        </span>
      ) : (
        <span className="emu-warn">
          {starting ? (
            'Starting the stream…'
          ) : (
            <>
              Not streaming{' '}
              <button className="gm-btn" onClick={() => void restreamGame()}>
                Stream it
              </button>
            </>
          )}
        </span>
      )}
      <Volume label="Game volume (only for you)" value={volume} onChange={setGameVolume} />
    </footer>
  )
}

function ViewerBar({ hostId }: { hostId: string }) {
  const volume = useParticipants((s) => s.streamVolumes[hostId] ?? 1)
  const deafened = useVoice((s) => s.deafened)
  return (
    <footer className="emu-bar">
      <span className="emu-note">{deafened ? "You're deafened: no game sound." : 'Game sound comes with the stream.'}</span>
      <span className="gm-head-spacer" />
      <Volume label="Game volume" value={volume} onChange={(v) => setStreamVolume(hostId, v)} />
    </footer>
  )
}

function Volume({ label, value, onChange }: { label: string; value: number; onChange(v: number): void }) {
  const pct = Math.round(value * 100)
  return (
    <label className="emu-volume" title={`${label}: ${pct}%`}>
      <span className="emu-volume-label">Volume</span>
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
                <Avatar user={u ?? { id: uid, name: 'Someone', color: '#3a4152' }} size={22} />
                <span className="emu-port-name">
                  {u?.name ?? 'Someone'}
                  {mine && <span className="emu-port-you"> (you)</span>}
                </span>
                {uid === session.hostId && !mine && <span className="gm-tag">host</span>}
              </>
            ) : (
              <span className="emu-port-name emu-port-free">Free</span>
            )}
            {mine ? (
              <button
                className="gm-icon-btn emu-port-leave"
                disabled={busy}
                onClick={() => void run(takeEmuPort(channelId, null))}
                title="Give up this controller (watch instead)"
              >
                Leave
              </button>
            ) : !uid ? (
              <button className="gm-btn emu-port-btn" disabled={busy} onClick={() => void run(takeEmuPort(channelId, i))}>
                {myPort >= 0 ? 'Move' : 'Take'}
              </button>
            ) : null}
            {canManage && (
              <span className="emu-port-menu-wrap">
                <button
                  className="gm-icon-btn emu-port-more"
                  onClick={() => setMenu(menu === i ? null : i)}
                  aria-label={`Assign controller ${i + 1}`}
                  aria-expanded={menu === i}
                  title="Assign this controller"
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
      <p className="emu-menu-title">Controller {port + 1}</p>
      {members
        .filter((id) => id !== current)
        .map((id) => {
          const other = session.ports.indexOf(id)
          return (
            <button key={id} role="menuitem" className="emu-menu-item" onClick={() => onPick(id)}>
              <Avatar user={users[id] ?? { id, name: 'Someone', color: '#3a4152' }} size={18} />
              <span className="emu-port-name">{users[id]?.name ?? 'Someone'}</span>
              {other >= 0 && <span className="emu-menu-hint">P{other + 1}</span>}
            </button>
          )
        })}
      {members.filter((id) => id !== current).length === 0 && <p className="emu-menu-empty">Nobody else is in the call.</p>}
      {current && (
        <button role="menuitem" className="emu-menu-item is-danger" onClick={() => onPick(null)}>
          Free this controller
        </button>
      )}
    </div>
  )
}

// ---------- controls ----------

/**
 * The SNES buttons by position (like a gamepad): Nexo's A/B/X/Y keys are the bottom / right / left / top
 * buttons, which on a SNES pad are B / A / Y / X.
 */
const SNES_FACE: [snes: string, where: string, key: keyof typeof BUTTON_KEYS][] = [
  ['B', 'bottom', 'A'],
  ['A', 'right', 'B'],
  ['Y', 'left', 'X'],
  ['X', 'top', 'Y'],
]

function ControlsHelp() {
  return (
    <dl className="gm-help emu-help">
      <div className="gm-help-row">
        <dt>
          <span className="gm-help-label">D-pad</span>
        </dt>
        <dd>
          <kbd>Arrows</kbd> or <kbd>WASD</kbd>
        </dd>
      </div>
      {SNES_FACE.map(([snes, where, key]) => (
        <div key={snes} className="gm-help-row">
          <dt>
            <span className="gm-help-label">
              {snes} <span className="emu-help-where">({where})</span>
            </span>
          </dt>
          <dd>
            <kbd>{BUTTON_KEYS[key]}</kbd>
          </dd>
        </div>
      ))}
      <div className="gm-help-row">
        <dt>
          <span className="gm-help-label">L / R</span>
        </dt>
        <dd>
          <kbd>{BUTTON_KEYS.L}</kbd> / <kbd>{BUTTON_KEYS.R}</kbd>
        </dd>
      </div>
      <div className="gm-help-row">
        <dt>
          <span className="gm-help-label">Start / Select</span>
        </dt>
        <dd>
          <kbd>{BUTTON_KEYS.START}</kbd> / <kbd>{BUTTON_KEYS.SELECT}</kbd>
        </dd>
      </div>
      <p className="gm-help-pad">
        Buttons go by position, like on the SNES pad: the bottom button is B, the right one A, the left one Y and
        the top one X. Gamepads work too (plug one in and press a button).
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

  useEffect(() => {
    if (port < 0) return
    if (isHost) {
      if (!engine) return
      const pad = startPadInput((mask) => engine.setPad(port, mask))
      return () => pad.stop() // sends 0 to that port
    }
    const pad = startPadInput((mask) => sendEmuInput(channelId, mask))
    return () => pad.stop()
  }, [channelId, port, isHost, engine])

  return null
}
