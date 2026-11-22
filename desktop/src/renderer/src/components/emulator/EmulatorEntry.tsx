// Emulator plugin entry points outside the emulator area: whether the area shows on a stage, the stage toolbar
// button (load a game / show or hide it), the sidebar line under a voice channel and the plugin's icon.
import { useRef, type DragEvent } from 'react'
import { useEmulator, setEmulatorHidden } from '../../store/emulator'
import { usePlugins } from '../../store/plugins'
import { useApp } from '../../store/app'
import { useVoice } from '../../voice/session'
import { acceptFor, hostGameFile, useEmuHost } from './host'
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
  const click = () => {
    if (session) setEmulatorHidden(channelId, shown)
    else if (!loading) input.current?.click()
  }
  return (
    <>
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
              : 'Play a game: load a SNES game file you own'
        }
        aria-label="Emulator"
        aria-pressed={shown}
      >
        <ConsoleIcon size={size === 'lg' ? 20 : 18} />
        {session && !shown && <span className="emu-dot" aria-hidden="true" />}
      </button>
      <input
        ref={input}
        type="file"
        accept={acceptFor('snes')}
        hidden
        onChange={(e) => {
          const file = e.target.files?.[0]
          e.target.value = ''
          if (file) void hostGameFile(channelId, file)
        }}
      />
    </>
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
