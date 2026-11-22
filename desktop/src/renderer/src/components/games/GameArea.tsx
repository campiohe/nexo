// Games plugin UI (docs/SPEC.md §5.5): the game area that takes the voice stage's main spot while a game session
// is open in your channel (picker → lobby → match → result), the toolbar button, and the "🎮 Game · playing"
// line under voice channels. Requests: games/actions.ts; frames: games/frames.ts; each game's view:
// games/<id>/View.tsx (games/registry.ts).
import { Suspense, lazy, useEffect, useMemo, useRef, useState, type ComponentType, type ReactNode } from 'react'
import { create } from 'zustand'
import type { GameId, GameLobby, GameSeat, User } from '@shared/protocol'
import { GAME_IDS, GAME_PAD, GAME_SEAT_COLORS } from '@shared/protocol'
import { GAMES } from '@shared/games/index'
import { useApp } from '../../store/app'
import { useGames, setGameHidden } from '../../store/games'
import { useEmulator, setEmulatorHidden } from '../../store/emulator'
import { usePlugins } from '../../store/plugins'
import { EmulatorPickerCard, useEmuAreaShown } from '../emulator/EmulatorEntry'
import { useVoice } from '../../voice/session'
import { isStaff } from '../../lib/permissions'
import { Avatar } from '../Avatar'
import { frameBuffer, frameSource } from '../../games/frames'
import { request } from '../../net/socket'
import { startPadInput, BUTTON_KEYS, type PadInput } from '../../games/input'
import { GAME_VIEWS } from '../../games/registry'
import { setSfxMuted, sfx } from '../../games/retro'
import type { GameViewProps } from '../../games/types'
import {
  closeGame,
  joinGame,
  leaveGame,
  openGame,
  sendGameAction,
  sendPadInput,
  setBots,
  startGame,
  stopGame,
} from '../../games/actions'
import '../../styles/games.css'

// ---------------------------------------------------------------------------------------------
// Local UI state: the picker (choosing a game before a session exists, or the host changing it) and sound.

const SFX_KEY = 'nexo.games.sfx'
function loadSfxOn(): boolean {
  try {
    return localStorage.getItem(SFX_KEY) !== 'off'
  } catch {
    return true
  }
}

interface GameUi {
  /** Voice channel whose picker is open on this device. */
  picking: string | null
  sfxOn: boolean
}
export const useGameUi = create<GameUi>()(() => ({ picking: null, sfxOn: loadSfxOn() }))

function setSfxOn(on: boolean) {
  useGameUi.setState({ sfxOn: on })
  try {
    localStorage.setItem(SFX_KEY, on ? 'on' : 'off')
  } catch {
    /* private mode */
  }
}

/**
 * The game area shows on the stage of `channelId`: the games plugin on and a session not hidden, or the picker
 * open (it also offers the Emulator plugin's "Your own game", so it opens when either plugin is on).
 */
export function useGameAreaShown(channelId: string | null): boolean {
  const on = usePlugins((s) => s.plugins.games)
  const anyOn = usePlugins((s) => s.plugins.games || s.plugins.emulator)
  const open = useGames((s) => !!channelId && !!s.byChannel[channelId] && !s.hidden[channelId])
  const picking = useGameUi((s) => !!channelId && s.picking === channelId)
  return !!channelId && ((on && open) || (anyOn && picking))
}

// ---------------------------------------------------------------------------------------------
// Toolbar button and sidebar line

export const GamepadIcon = ({ size = 18 }: { size?: number }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={2}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
    focusable="false"
  >
    <path d="M7 7h10a5 5 0 0 1 4.9 6l-.6 3.1a2.6 2.6 0 0 1-4.5 1.2L14.6 15H9.4l-2.2 2.3a2.6 2.6 0 0 1-4.5-1.2L2.1 13A5 5 0 0 1 7 7z" />
    <path d="M7.5 10v3M6 11.5h3" />
    <circle cx="15.5" cy="10.5" r=".6" fill="currentColor" />
    <circle cx="17.5" cy="12.5" r=".6" fill="currentColor" />
  </svg>
)

/**
 * Stage toolbar: open the game picker, or show / hide your channel's game. With either the games or the emulator
 * plugin on; an emulator session in the channel comes first (it takes the stage, see VoiceStage).
 */
export function GamesButton({ size = 'lg' }: { size?: 'sm' | 'lg' }) {
  const gamesOn = usePlugins((s) => s.plugins.games)
  const emuOn = usePlugins((s) => s.plugins.emulator)
  const channelId = useVoice((s) => s.channelId)
  const lobby = useGames((s) => (gamesOn && channelId ? s.byChannel[channelId] : undefined))
  const emu = useEmulator((s) => (emuOn && channelId ? s.byChannel[channelId] : undefined))
  const gameShown = useGameAreaShown(channelId)
  const emuShown = useEmuAreaShown(channelId)
  const shown = emuShown || gameShown
  if ((!gamesOn && !emuOn) || !channelId) return null
  const click = () => {
    if (emu) {
      setEmulatorHidden(channelId, emuShown)
      if (!emuShown) useGameUi.setState({ picking: null })
    } else if (lobby) setGameHidden(channelId, shown)
    else useGameUi.setState((s) => ({ picking: s.picking === channelId ? null : channelId }))
  }
  const live = !!emu || lobby?.status === 'playing'
  const title = emu
    ? emuShown
      ? 'Hide the game (show people)'
      : `Show ${emu.title}`
    : lobby
      ? shown
        ? 'Hide the game (show people)'
        : `Show ${GAMES[lobby.gameId]?.name ?? 'the game'}`
      : 'Play a game'
  return (
    <button
      className={`vx-ctl vx-ctl-${size} ${shown ? 'is-on' : ''}`}
      onClick={click}
      title={title}
      aria-label="Games"
      aria-pressed={shown}
    >
      <GamepadIcon size={size === 'lg' ? 20 : 18} />
      {live && !shown && <span className="gm-dot" aria-hidden="true" />}
    </button>
  )
}

/** Under a voice channel in the sidebar: what's being played there. */
export function ChannelGameLine({ channelId }: { channelId: string }) {
  const on = usePlugins((s) => s.plugins.games)
  const lobby = useGames((s) => s.byChannel[channelId])
  if (!on || !lobby) return null
  const name = GAMES[lobby.gameId]?.name ?? 'A game'
  const what = lobby.status === 'playing' ? 'playing' : lobby.status === 'finished' ? 'match over' : 'in the lobby'
  return (
    <div className={`gm-channel-line ${lobby.status === 'playing' ? 'is-live' : ''}`} title={`${name}: ${what}`}>
      <GamepadIcon size={12} />
      <span className="gm-channel-line-text">
        {name} · {what}
      </span>
    </div>
  )
}

// ---------------------------------------------------------------------------------------------
// The game area

export function GameArea({ channelId }: { channelId: string }) {
  const lobby = useGames((s) => s.byChannel[channelId])
  const picking = useGameUi((s) => s.picking === channelId)
  const sfxOn = useGameUi((s) => s.sfxOn)
  const deafened = useVoice((s) => s.deafened)
  const meId = useApp((s) => s.me?.id)
  const staff = useApp((s) => !!s.me && isStaff(s.me))
  const gamesOn = usePlugins((s) => s.plugins.games)
  const host = !!lobby && (lobby.hostId === meId || staff)

  useEffect(() => setSfxMuted(deafened || !sfxOn), [deafened, sfxOn])

  const def = lobby ? GAMES[lobby.gameId] : undefined
  // Without a session: the picker starts one. With one: only its host (between matches) reopens it to switch.
  const showPicker = !lobby || (picking && host && lobby.status !== 'playing')

  return (
    <section className="gm-area" aria-label="Game">
      <header className="gm-head">
        <span className="gm-head-icon">
          <GamepadIcon size={16} />
        </span>
        <span className="gm-head-title">{showPicker ? 'Pick a game' : (def?.name ?? 'Game')}</span>
        {lobby && !showPicker && <StatusChip lobby={lobby} />}
        <span className="gm-head-spacer" />
        {gamesOn && (
          <button
            className={`gm-icon-btn ${sfxOn ? '' : 'is-off'}`}
            onClick={() => setSfxOn(!sfxOn)}
            title={sfxOn ? 'Mute game sounds' : 'Unmute game sounds'}
            aria-pressed={!sfxOn}
          >
            {sfxOn ? 'Sound on' : 'Sound off'}
          </button>
        )}
        {lobby && host && lobby.status === 'playing' && (
          <button className="gm-btn gm-btn-ghost" onClick={() => void stopGame(channelId)}>
            End match
          </button>
        )}
        {lobby && host && (
          <button
            className="gm-btn gm-btn-ghost"
            onClick={() => void closeGame(channelId)}
            title="Close the game for everyone"
          >
            Close
          </button>
        )}
        {lobby && showPicker ? (
          <button className="gm-btn gm-btn-ghost" onClick={() => useGameUi.setState({ picking: null })}>
            Back
          </button>
        ) : lobby ? (
          <button className="gm-btn gm-btn-ghost" onClick={() => setGameHidden(channelId, true)} title="Show people instead">
            Hide
          </button>
        ) : (
          <button className="gm-btn gm-btn-ghost" onClick={() => useGameUi.setState({ picking: null })}>
            Cancel
          </button>
        )}
      </header>
      <div className="gm-body">
        {showPicker ? (
          <Picker channelId={channelId} lobby={lobby} />
        ) : lobby && lobby.status === 'lobby' ? (
          <Lobby channelId={channelId} lobby={lobby} host={host} />
        ) : lobby ? (
          <Match channelId={channelId} lobby={lobby} host={host} muted={deafened || !sfxOn} />
        ) : null}
      </div>
    </section>
  )
}

function StatusChip({ lobby }: { lobby: GameLobby }) {
  const text = lobby.status === 'playing' ? 'Live' : lobby.status === 'finished' ? 'Match over' : 'Lobby'
  return <span className={`gm-chip gm-chip-${lobby.status}`}>{text}</span>
}

function playersLabel(min: number, max: number): string {
  if (min === max) return `${min} players`
  return `${min}–${max} players`
}

// ---------- picker ----------

function Picker({ channelId, lobby }: { channelId: string; lobby: GameLobby | undefined }) {
  const gamesOn = usePlugins((s) => s.plugins.games)
  const emuOn = usePlugins((s) => s.plugins.emulator)
  const [busy, setBusy] = useState<GameId | null>(null)
  const pick = async (id: GameId) => {
    if (busy) return
    sfx.select()
    setBusy(id)
    const l = await openGame(channelId, id)
    setBusy(null)
    if (l) useGameUi.setState({ picking: null })
  }
  return (
    <div className="gm-picker">
      <div className="gm-picker-grid">
        {gamesOn && GAME_IDS.map((id) => {
          const def = GAMES[id]
          return (
            <button
              key={id}
              className={`gm-card gm-card-${id} ${lobby?.gameId === id ? 'is-current' : ''}`}
              disabled={!!busy}
              onClick={() => void pick(id)}
            >
              <span className="gm-card-art" aria-hidden="true">
                <GameArt id={id} />
              </span>
              <span className="gm-card-name">{def.name}</span>
              <span className="gm-card-tag">{def.tagline}</span>
              <span className="gm-card-meta">
                {playersLabel(def.minPlayers, def.maxPlayers)}
                {def.bots && ' · bots'}
              </span>
              {busy === id && <span className="gm-card-busy">Opening…</span>}
            </button>
          )
        })}
        {emuOn && <EmulatorPickerCard channelId={channelId} onHosted={() => useGameUi.setState({ picking: null })} />}
      </div>
    </div>
  )
}

/** A tiny pixel emblem per game (CSS-scaled 8×8 patterns). */
function GameArt({ id }: { id: GameId }) {
  const art: Record<GameId, string[]> = {
    bomber: ['...##...', '..#..#..', '.######.', '########', '########', '########', '.######.', '..####..'],
    kart: ['........', '..####..', '.#....#.', '########', '##.##.##', '########', '.##..##.', '.##..##.'],
    brawl: ['...##...', '..####..', '...##...', '.######.', '...##...', '..#..#..', '.#....#.', '########'],
    fighter: ['.##..##.', '.##..##.', '#.#..#.#', '..#..#..', '.###.###', '.#.#.#.#', '.#.#.#.#', '##.###.#'],
    cards: ['.####...', '.#..#...', '.#.####.', '.#.#..#.', '.###..#.', '...#..#.', '...####.', '........'],
  }
  return (
    <svg viewBox="0 0 8 8" width="40" height="40" shapeRendering="crispEdges">
      {art[id].flatMap((row, y) =>
        [...row].map((c, x) => (c === '#' ? <rect key={`${x}-${y}`} x={x} y={y} width="1" height="1" fill="currentColor" /> : null)),
      )}
    </svg>
  )
}

// ---------- lobby ----------

function Seats({ lobby, users }: { lobby: GameLobby; users: Record<string, User> }) {
  const def = GAMES[lobby.gameId]
  const rows: ReactNode[] = []
  lobby.players.forEach((id, i) => {
    const u = users[id]
    rows.push(
      <li key={id} className="gm-seat">
        <span className="gm-seat-color" style={{ background: seatColor(i) }} />
        <Avatar user={u ?? { id, name: 'Someone', color: '#3a4152' }} size={24} />
        <span className="gm-seat-name">{u?.name ?? 'Someone'}</span>
        {id === lobby.hostId && <span className="gm-tag">host</span>}
      </li>,
    )
  })
  for (let b = 0; b < lobby.bots; b++) {
    const i = lobby.players.length + b
    rows.push(
      <li key={`bot${b}`} className="gm-seat is-bot">
        <span className="gm-seat-color" style={{ background: seatColor(i) }} />
        <span className="gm-bot-face" aria-hidden="true">
          ▣
        </span>
        <span className="gm-seat-name">CPU {b + 1}</span>
      </li>,
    )
  }
  for (let i = lobby.players.length + lobby.bots; i < (def?.maxPlayers ?? 0); i++) {
    rows.push(
      <li key={`empty${i}`} className="gm-seat is-empty">
        <span className="gm-seat-color" />
        <span className="gm-seat-name">Open seat</span>
      </li>,
    )
  }
  return <ul className="gm-seats">{rows}</ul>
}

const seatColor = (i: number) => GAME_SEAT_COLORS[i % GAME_SEAT_COLORS.length]

/** Controller buttons and key names show as key caps; other help labels ("Items", "Goal") as plain text. */
const isKeyLabel = (key: string) => key in BUTTON_KEYS || /^(arrows|d-pad|space|enter|esc|[←→↑↓][←→↑↓ ]*)/i.test(key)

function Help({ gameId }: { gameId: GameId }) {
  const def = GAMES[gameId]
  return (
    <dl className="gm-help">
      {def.help.map(([key, what]) => (
        <div key={key + what} className="gm-help-row">
          <dt>
            {isKeyLabel(key) ? <kbd>{key}</kbd> : <span className="gm-help-label">{key}</span>}
            {key in BUTTON_KEYS && def.controls === 'pad' && (
              <span className="gm-help-keys">{BUTTON_KEYS[key as keyof typeof GAME_PAD]}</span>
            )}
          </dt>
          <dd>{what}</dd>
        </div>
      ))}
      {def.controls === 'pad' && <p className="gm-help-pad">Gamepads work too (plug one in and press a button).</p>}
    </dl>
  )
}

function LobbyControls({ channelId, lobby, host }: { channelId: string; lobby: GameLobby; host: boolean }) {
  const meId = useApp((s) => s.me?.id)
  const def = GAMES[lobby.gameId]
  const seated = !!meId && lobby.players.includes(meId)
  const total = lobby.players.length + lobby.bots
  const full = total >= def.maxPlayers && lobby.bots === 0
  const enough = lobby.players.length > 0 && total >= def.minPlayers
  return (
    <div className="gm-controls">
      {seated ? (
        <button className="gm-btn" onClick={() => void leaveGame(channelId)}>
          Leave seat
        </button>
      ) : (
        <button className="gm-btn" onClick={() => void joinGame(channelId)} disabled={full}>
          {full ? 'Table full' : 'Take a seat'}
        </button>
      )}
      {host && def.bots && (
        <span className="gm-stepper" role="group" aria-label="Computer players">
          <button
            className="gm-btn gm-btn-sq"
            onClick={() => void setBots(channelId, lobby.bots - 1)}
            disabled={lobby.bots === 0}
            aria-label="One bot fewer"
          >
            −
          </button>
          <span className="gm-stepper-value">
            {lobby.bots} bot{lobby.bots === 1 ? '' : 's'}
          </span>
          <button
            className="gm-btn gm-btn-sq"
            onClick={() => void setBots(channelId, lobby.bots + 1)}
            disabled={total >= def.maxPlayers}
            aria-label="One more bot"
          >
            +
          </button>
        </span>
      )}
      {host && (
        <button className="gm-btn" onClick={() => useGameUi.setState({ picking: channelId })}>
          Change game
        </button>
      )}
      {host ? (
        <button
          className="gm-btn gm-btn-primary"
          onClick={() => {
            sfx.select()
            void startGame(channelId)
          }}
          disabled={!enough}
          title={enough ? undefined : `Needs ${def.minPlayers}+ players (bots count)`}
        >
          {lobby.status === 'finished' ? 'Play again' : 'Start'}
        </button>
      ) : (
        <span className="gm-note">Waiting for the host to start…</span>
      )}
    </div>
  )
}

function Lobby({ channelId, lobby, host }: { channelId: string; lobby: GameLobby; host: boolean }) {
  const users = useApp((s) => s.users)
  const def = GAMES[lobby.gameId]
  return (
    <div className="gm-lobby">
      <div className="gm-lobby-main">
        <div className="gm-lobby-hero">
          <span className="gm-lobby-art">
            <GameArt id={lobby.gameId} />
          </span>
          <div>
            <h2 className="gm-lobby-title">{def.name}</h2>
            <p className="gm-lobby-tag">{def.tagline}</p>
            <p className="gm-lobby-meta">
              {playersLabel(def.minPlayers, def.maxPlayers)}
              {def.bots ? ' · computer players can fill seats' : ''}
            </p>
          </div>
        </div>
        <Seats lobby={lobby} users={users} />
        <LobbyControls channelId={channelId} lobby={lobby} host={host} />
      </div>
      <aside className="gm-lobby-side">
        <h3 className="gm-side-title">Controls</h3>
        <Help gameId={lobby.gameId} />
      </aside>
    </div>
  )
}

// ---------- match ----------

const viewCache = new Map<GameId, ComponentType<GameViewProps<any>>>()
function viewFor(id: GameId): ComponentType<GameViewProps<any>> {
  let v = viewCache.get(id)
  if (!v) {
    v = lazy(GAME_VIEWS[id])
    viewCache.set(id, v)
  }
  return v
}

function Match({ channelId, lobby, host, muted }: { channelId: string; lobby: GameLobby; host: boolean; muted: boolean }) {
  const meId = useApp((s) => s.me?.id)
  const users = useApp((s) => s.users)
  const def = GAMES[lobby.gameId]
  const seats: GameSeat[] = lobby.seats
  const seat = useMemo(() => {
    const s = seats.find((x) => x.userId === meId)
    return s ? s.seat : null
  }, [seats, meId])
  const playing = lobby.status === 'playing'
  const matchId = lobby.matchId
  const padRef = useRef<PadInput | null>(null)
  const [helpOpen, setHelpOpen] = useState(false)

  // Controller input while you play a pad game.
  useEffect(() => {
    if (!playing || seat === null || def.controls !== 'pad' || !matchId) return
    const pad = startPadInput((mask) => sendPadInput(channelId, matchId, mask))
    padRef.current = pad
    return () => {
      pad.stop()
      padRef.current = null
    }
  }, [playing, seat, def.controls, matchId, channelId])

  // Measure the round trip while you play (FrameSource.latencyMs, for views that predict your own input).
  useEffect(() => {
    if (!playing || seat === null) return
    let stopped = false
    const ping = async () => {
      const t0 = performance.now()
      try {
        await request('time:now', {})
        if (!stopped) frameBuffer.addRttSample(performance.now() - t0)
      } catch {
        /* offline: keep the last estimate */
      }
    }
    void ping()
    const t = window.setInterval(() => void ping(), 3000)
    return () => {
      stopped = true
      window.clearInterval(t)
    }
  }, [playing, seat])

  // Win / lose jingle once per finished match.
  const jingled = useRef<string | null>(null)
  useEffect(() => {
    if (lobby.status !== 'finished' || !lobby.matchId || jingled.current === lobby.matchId) return
    jingled.current = lobby.matchId
    const won = lobby.result?.winners.some((w) => w.userId === meId)
    if (won) sfx.win()
    else if (seat !== null) sfx.lose()
  }, [lobby.status, lobby.matchId, lobby.result, meId, seat])

  const View = viewFor(lobby.gameId)
  const props: GameViewProps<any> = {
    lobby,
    seats,
    seat,
    frames: frameSource(),
    act: (action) => (matchId ? sendGameAction(channelId, matchId, action) : Promise.resolve('No match')),
    localButtons: () => padRef.current?.buttons() ?? 0,
    muted,
  }

  return (
    <div className="gm-match">
      <div className="gm-screen">
        <Suspense fallback={<div className="gm-loading">Loading {def.name}…</div>}>
          {/* A fresh view per match: games don't carry state (effects, event ids) into the next one. */}
          <View key={matchId ?? 'none'} {...props} />
        </Suspense>
        {lobby.status === 'finished' && <ResultCard channelId={channelId} lobby={lobby} host={host} users={users} />}
      </div>
      <footer className="gm-match-foot">
        <span className="gm-roster">
          {seats.map((s) => (
            <span key={s.seat} className="gm-roster-item" title={s.userId ? s.name : `${s.name} (computer)`}>
              <span className="gm-seat-color" style={{ background: s.color }} />
              {s.name}
              {s.userId === meId && ' (you)'}
            </span>
          ))}
        </span>
        <span className="gm-head-spacer" />
        {seat === null && playing && <span className="gm-note">You're watching. Join the next match from the lobby.</span>}
        <button className="gm-btn gm-btn-ghost" onClick={() => setHelpOpen((o) => !o)} aria-expanded={helpOpen}>
          Controls
        </button>
      </footer>
      {helpOpen && (
        <div className="gm-help-pop" role="dialog" aria-label="Controls">
          <Help gameId={lobby.gameId} />
        </div>
      )}
    </div>
  )
}

function ResultCard({ channelId, lobby, host, users }: { channelId: string; lobby: GameLobby; host: boolean; users: Record<string, User> }) {
  const result = lobby.result
  return (
    <div className="gm-result" role="status">
      <div className="gm-result-card">
        <p className="gm-result-kicker">Match over</p>
        <h2 className="gm-result-title">{result?.summary ?? 'Match over'}</h2>
        {result && result.winners.length > 0 && (
          <p className="gm-result-winners">
            {result.winners.map((w) => (
              <span key={w.seat} className="gm-roster-item">
                <span className="gm-seat-color" style={{ background: w.color }} />
                {w.userId ? (users[w.userId]?.name ?? w.name) : w.name}
              </span>
            ))}
          </p>
        )}
        <Seats lobby={lobby} users={users} />
        <LobbyControls channelId={channelId} lobby={lobby} host={host} />
      </div>
    </div>
  )
}
