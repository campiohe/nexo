// Emulator plugin entry points outside the emulator area: whether the area shows on a stage, the stage toolbar
// button (load a game / show or hide it, with the host's loading progress and "which console?" question), the
// sidebar line under a voice channel and the plugin's icon.
import { useRef, type DragEvent, type RefObject } from 'react'
import { useEmulator, setEmulatorHidden } from '../../store/emulator'
import { usePlugins } from '../../store/plugins'
import { useApp } from '../../store/app'
import { useVoice } from '../../voice/session'
import { EMU_SYSTEM_INFO } from '../../emulator/systems'
import { Modal } from '../Modal'
import { answerAsk, cancelLoading, GAME_FILE_ACCEPT, hostGameFiles, useEmuHost, type EmuLoading } from './host'
import '../../styles/emulator.css'

/** The emulator area takes the stage of `channelId`: plugin on, a session running there, not hidden here. */
export function useEmuAreaShown(channelId: string | null): boolean {
  const on = usePlugins((s) => s.plugins.emulator)
  const open = useEmulator((s) => !!channelId && !!s.byChannel[channelId] && !s.hidden[channelId])
  return on && open
}

/** A console controller (the plugin's icon). */
export const ConsoleIcon = ({ size = 18 }: { size?: number }) => (
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
    <path d="M7 7.5h10a5 5 0 0 1 0 10H7a5 5 0 0 1 0-10z" />
    <path d="M7 10.5v4M5 12.5h4" />
    <circle cx="16" cy="11.2" r=".7" fill="currentColor" />
    <circle cx="18" cy="13.2" r=".7" fill="currentColor" />
    <circle cx="14" cy="13.2" r=".7" fill="currentColor" />
    <circle cx="16" cy="15.2" r=".7" fill="currentColor" />
  </svg>
)

/** The file input of the game pickers: every console's files, several at once (a .cue with its .bin files, a BIOS). */
export function GameFileInput({ inputRef, channelId }: { inputRef: RefObject<HTMLInputElement | null>; channelId: string }) {
  return (
    <input
      ref={inputRef}
      type="file"
      accept={GAME_FILE_ACCEPT}
      multiple
      hidden
      onChange={(e) => {
        const files = Array.from(e.target.files ?? [])
        e.target.value = ''
        if (files.length) void hostGameFiles(channelId, files)
      }}
    />
  )
}

/** "Reading Game.bin… 45%" with a bar and Cancel (the toolbar card, and the emulator screen while loading another game). */
export function LoadProgress({ loading, className = '' }: { loading: EmuLoading; className?: string }) {
  const pct = loading.progress === null ? null : Math.round(loading.progress * 100)
  const label = loading.step === 'reading' ? 'Reading' : 'Starting'
  return (
    <div className={`emu-load ${className}`} role="status" aria-live="polite">
      <div className="emu-load-text">
        <span className="emu-load-name" title={loading.name}>
          {label} {loading.name}…
        </span>
        {pct !== null && <span className="emu-load-pct">{pct}%</span>}
      </div>
      <div
        className={`emu-load-bar ${pct === null ? 'is-indeterminate' : ''}`}
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct ?? undefined}
      >
        <span style={pct === null ? undefined : { width: `${pct}%` }} />
      </div>
      <button className="gm-btn gm-btn-ghost emu-load-cancel" onClick={cancelLoading}>
        Cancel
      </button>
    </div>
  )
}

/** "Is this a Mega Drive or a PlayStation game?" when the picked file could be either (a .bin without a .cue). */
function AskSystemDialog() {
  const ask = useEmuHost((s) => s.ask)
  if (!ask) return null
  const names = ask.systems.map((id) => EMU_SYSTEM_INFO[id].name)
  const question = names.length === 2 ? `${names[0]} or ${names[1]}` : names.join(', ')
  return (
    <Modal title="Which console is this game for?" onClose={() => answerAsk(null)} width={460}>
      <p className="emu-ask-text">
        Nexo can't tell from <strong>{ask.main.name}</strong> alone. Is it a {question} game?
      </p>
      <div className="emu-ask-choices">
        {ask.systems.map((id) => (
          <button key={id} className="gm-btn emu-ask-choice" onClick={() => answerAsk(id)}>
            {EMU_SYSTEM_INFO[id].name}
          </button>
        ))}
      </div>
      {ask.systems.includes('psx') && (
        <p className="emu-note emu-ask-hint">PlayStation games usually come with a .cue file: pick it together with the .bin files.</p>
      )}
    </Modal>
  )
}

/** Drag-and-drop of a game file: true when the drag carries files. */
export function dragHasFiles(e: DragEvent): boolean {
  return Array.from(e.dataTransfer?.types ?? []).includes('Files')
}

/**
 * Stage toolbar: with no game running in your channel, opens a file picker to load a game you own (you host it);
 * with one running, shows or hides it (the stage shows people instead).
 */
export function EmulatorButton({ size = 'lg' }: { size?: 'sm' | 'lg' }) {
  const on = usePlugins((s) => s.plugins.emulator)
  const channelId = useVoice((s) => s.channelId)
  const session = useEmulator((s) => (channelId ? s.byChannel[channelId] : undefined))
  const shown = useEmuAreaShown(channelId)
  const loading = useEmuHost((s) => s.loading)
  const input = useRef<HTMLInputElement>(null)
  if (!on || !channelId) return null
  // While the area is shown it shows the progress over the game itself.
  const showLoadCard = !!loading && !shown
  const click = () => {
    if (session) setEmulatorHidden(channelId, shown)
    else if (!loading) input.current?.click()
  }
  return (
    <span className="emu-ctl-wrap">
      <button
        className={`vx-ctl vx-ctl-${size} emu-ctl ${shown ? 'is-on' : ''}`}
        onClick={click}
        disabled={!!loading && !session}
        title={
          session
            ? shown
              ? 'Hide the game (show people)'
              : `Show ${session.title}`
            : loading
              ? 'Loading the game…'
              : 'Play a game: load a SNES, Mega Drive, PlayStation or Nintendo 64 game file you own'
        }
        aria-label="Emulator"
        aria-pressed={shown}
      >
        <ConsoleIcon size={size === 'lg' ? 20 : 18} />
        {session && !shown && <span className="emu-dot" aria-hidden="true" />}
      </button>
      <GameFileInput inputRef={input} channelId={channelId} />
      {showLoadCard && <LoadProgress loading={loading} className="emu-load-card" />}
      <AskSystemDialog />
    </span>
  )
}

/** Under a voice channel in the sidebar: "Title · hosted by Ana". */
export function ChannelEmuLine({ channelId }: { channelId: string }) {
  const on = usePlugins((s) => s.plugins.emulator)
  const session = useEmulator((s) => s.byChannel[channelId])
  const host = useApp((s) => (session ? s.users[session.hostId] : undefined))
  const meId = useApp((s) => s.me?.id)
  if (!on || !session) return null
  const by = session.hostId === meId ? 'hosted by you' : `hosted by ${host?.name ?? 'someone'}`
  return (
    <div className="gm-channel-line is-live emu-channel-line" title={`${session.title} · ${by}${session.paused ? ' (paused)' : ''}`}>
      <ConsoleIcon size={12} />
      <span className="gm-channel-line-text">
        {session.title} · {by}
      </span>
    </div>
  )
}
