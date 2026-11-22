// Emulator plugin entry points outside the emulator area: whether the area shows on a stage, the "Your own game"
// card in the Games picker, the sidebar line under a voice channel and the plugin's icon. Kept apart from
// EmulatorArea.tsx (and free of imports from components/games) so the games UI can use it without a cycle.
import { useRef, useState, type DragEvent } from 'react'
import { useEmulator, setEmulatorHidden } from '../../store/emulator'
import { usePlugins } from '../../store/plugins'
import { useApp } from '../../store/app'
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
 * Games picker card: "Your own game" (SNES). Click (or drop a file on it) to load a game file you own;
 * while someone else hosts in this channel it shows their game instead.
 */
export function EmulatorPickerCard({ channelId, onHosted }: { channelId: string; onHosted?(): void }) {
  const session = useEmulator((s) => s.byChannel[channelId])
  const loading = useEmuHost((s) => s.loading)
  const users = useApp((s) => s.users)
  const meId = useApp((s) => s.me?.id)
  const input = useRef<HTMLInputElement>(null)
  const [over, setOver] = useState(false)
  const otherHost = session && session.hostId !== meId ? session.hostId : null

  const load = async (file: File | undefined) => {
    if (!file || loading) return
    await hostGameFile(channelId, file)
    if (useEmulator.getState().byChannel[channelId]?.hostId === useApp.getState().me?.id) onHosted?.()
  }
  const click = () => {
    if (session) {
      setEmulatorHidden(channelId, false)
      onHosted?.()
    } else input.current?.click()
  }

  return (
    <>
      <button
        className={`gm-card emu-card ${over ? 'is-drop' : ''} ${session ? 'is-current' : ''}`}
        disabled={!!loading}
        onClick={click}
        onDragOver={(e) => {
          if (!dragHasFiles(e) || otherHost) return
          e.preventDefault()
          e.dataTransfer.dropEffect = 'copy'
          setOver(true)
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          if (!dragHasFiles(e)) return
          e.preventDefault()
          setOver(false)
          if (!otherHost) void load(e.dataTransfer.files[0])
        }}
      >
        <span className="gm-card-art emu-card-art" aria-hidden="true">
          <ConsoleIcon size={34} />
        </span>
        <span className="gm-card-name">Your own game</span>
        <span className="gm-card-tag">
          {session
            ? otherHost
              ? `${users[otherHost]?.name ?? 'Someone'} is playing ${session.title}. Click to watch or join.`
              : `You're hosting ${session.title}. Click to show it.`
            : 'Load a SNES game file you own and play it with friends. It stays on your computer.'}
        </span>
        <span className="gm-card-meta">SNES · 1–4 players · {acceptFor('snes').split(',').join(' ')}</span>
        {loading && <span className="gm-card-busy">Loading…</span>}
      </button>
      <input
        ref={input}
        type="file"
        accept={acceptFor('snes')}
        hidden
        onChange={(e) => {
          const file = e.target.files?.[0]
          e.target.value = ''
          void load(file)
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
