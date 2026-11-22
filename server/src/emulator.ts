// Emulator plugin (docs/SPEC.md §5.6): one emulator session per voice channel. The host's Nexo runs the emulator
// on a game file loaded from their own disk and streams it to the call (LiveKit); the file never reaches the
// server. The server only keeps who hosts, the game's title, who is on which controller port and whether it is
// paused (broadcast to everyone as `emu:session`), and relays each player's held buttons to the socket that owns
// the host's voice state (`emu:input`). Memory only. The clock is injectable so tests can drive revisions.
import type { EmuSession, EmuSystem } from '../../shared/protocol.ts'
import { EMU_PORTS, EMU_SYSTEMS, EMU_TITLE_MAX, GAME_PAD_MASK } from '../../shared/protocol.ts'
import { normalizeDisplayText } from './text.ts'

/** Ack errors of the `emu:*` requests (the plugin / channel / voice / rate checks are made by server.ts). */
export const EMU_ERRORS = {
  pluginOff: 'The Emulator plugin is off',
  channelNotFound: 'Voice channel not found',
  notInChannel: 'Join the voice channel to play',
  unknownSystem: 'Unsupported console',
  invalidTitle: 'Invalid game title',
  busy: 'Someone is already hosting a game here',
  noSession: 'No game is running in this channel',
  notHost: 'Only the host can do that',
  invalidPort: 'Invalid controller',
  portTaken: 'That controller is taken',
  notInVoice: "They're not in this voice channel",
  invalidPaused: 'Invalid pause setting',
  slowDown: 'Slow down',
} as const

export const EMU_LIMITS = {
  /** `emu:input` messages per socket per second; more are dropped. */
  inputsPerSecond: 120,
  /** Session requests (`emu:start`, `emu:port`, …) per user per 10 s. */
  requestsPer10s: 40,
} as const

/** Someone in a voice channel and the socket that owns their voice state. */
export interface EmuMember {
  userId: string
  socketId: string
}

export interface EmuSessionsOptions {
  /** Every session change (server.ts broadcasts it as `emu:session`). */
  onSession: (s: EmuSession) => void
  /** A player's buttons for the host's voice socket (server.ts emits `emu:input` to it). */
  onInput: (socketId: string, p: { channelId: string; port: number; buttons: number }) => void
  /** Default: Date.now (seeds the revision counter). */
  now?: () => number
}

interface Session {
  channelId: string
  hostId: string
  system: EmuSystem
  title: string
  ports: (string | null)[]
  paused: boolean
  rev: number
  /** The buttons last relayed to the host, per port (a relay is sent only when they change). */
  relayed: number[]
  /** The host's voice socket relays went to (another device taking over voice gets the held buttons again). */
  hostSocketId: string | null
}

export type EmuRequestResult = EmuSession | string

export function createEmuSessions(options: EmuSessionsOptions) {
  const { onSession, onInput, now = Date.now } = options

  const sessions = new Map<string, Session>()
  /** channelId -> who is in that voice channel now (from server.ts after every voice change). */
  let members = new Map<string, EmuMember[]>()
  /** Server-wide revision counter seeded from the clock (never goes back, like music and games). */
  let lastRev = Math.max(0, Math.floor(now()))

  const snapshot = (s: Session): EmuSession => ({
    channelId: s.channelId,
    hostId: s.hostId,
    system: s.system,
    title: s.title,
    ports: [...s.ports],
    paused: s.paused,
    status: 'running',
    rev: s.rev,
  })

  function commit(s: Session): EmuSession {
    s.rev = ++lastRev
    const out = snapshot(s)
    onSession(out)
    return out
  }

  function close(s: Session): void {
    sessions.delete(s.channelId)
    s.rev = ++lastRev
    onSession({ ...snapshot(s), status: 'closed' })
  }

  const memberSocket = (channelId: string, userId: string) =>
    (members.get(channelId) ?? []).find((m) => m.userId === userId)?.socketId ?? null

  /** Sends `buttons` for `port` to the host's voice socket (when there is one). */
  function relay(s: Session, port: number, buttons: number) {
    s.relayed[port] = buttons
    const socketId = memberSocket(s.channelId, s.hostId)
    if (socketId) onInput(socketId, { channelId: s.channelId, port, buttons })
  }

  /** Frees `port` and tells the host it holds nothing now (a held button never sticks). */
  function freePort(s: Session, port: number) {
    s.ports[port] = null
    relay(s, port, 0)
  }

  const isPort = (port: unknown): port is number =>
    typeof port === 'number' && Number.isInteger(port) && port >= 0 && port < EMU_PORTS

  const isHost = (s: Session, userId: string, admin: boolean) => admin || s.hostId === userId

  return {
    /** The channel's session, or null. */
    session(channelId: string): EmuSession | null {
      const s = sessions.get(channelId)
      return s ? snapshot(s) : null
    },

    /** Every running session (bootstrap). */
    active(): EmuSession[] {
      return [...sessions.values()].map(snapshot)
    },

    /**
     * `emu:start`: a new session with the caller as host on port 0, or (host only) a new game in the running
     * one: title and system change, it is unpaused, the ports stay.
     */
    start(channelId: string, userId: string, system: unknown, rawTitle: unknown): EmuRequestResult {
      if (typeof system !== 'string' || !(EMU_SYSTEMS as readonly string[]).includes(system)) return EMU_ERRORS.unknownSystem
      const title = typeof rawTitle === 'string' ? normalizeDisplayText(rawTitle) : ''
      if (!title || title.length > EMU_TITLE_MAX) return EMU_ERRORS.invalidTitle
      const s = sessions.get(channelId)
      if (!s) {
        const ports: (string | null)[] = Array.from({ length: EMU_PORTS }, () => null)
        ports[0] = userId
        const created: Session = {
          channelId,
          hostId: userId,
          system: system as EmuSystem,
          title,
          ports,
          paused: false,
          rev: lastRev,
          relayed: ports.map(() => 0),
          hostSocketId: memberSocket(channelId, userId),
        }
        sessions.set(channelId, created)
        return commit(created)
      }
      if (s.hostId !== userId) return EMU_ERRORS.busy
      if (s.system === system && s.title === title && !s.paused) return snapshot(s)
      s.system = system as EmuSystem
      s.title = title
      s.paused = false
      return commit(s)
    },

    /** `emu:port`: take a free port (leaving your previous one), or give yours up (`null`). */
    port(channelId: string, userId: string, port: unknown): EmuRequestResult {
      const s = sessions.get(channelId)
      if (!s) return EMU_ERRORS.noSession
      const mine = s.ports.indexOf(userId)
      if (port === null) {
        if (mine < 0) return snapshot(s)
        freePort(s, mine)
        return commit(s)
      }
      if (!isPort(port)) return EMU_ERRORS.invalidPort
      if (port === mine) return snapshot(s)
      if (s.ports[port] !== null) return EMU_ERRORS.portTaken
      if (mine >= 0) freePort(s, mine)
      s.ports[port] = userId
      s.relayed[port] = 0
      return commit(s)
    },

    /** `emu:assign` (host / admins): put someone of the channel on `port` (off any other), or free it. */
    assign(channelId: string, userId: string, port: unknown, target: unknown, admin: boolean): EmuRequestResult {
      const s = sessions.get(channelId)
      if (!s) return EMU_ERRORS.noSession
      if (!isHost(s, userId, admin)) return EMU_ERRORS.notHost
      if (!isPort(port)) return EMU_ERRORS.invalidPort
      if (target === null) {
        if (s.ports[port] === null) return snapshot(s)
        freePort(s, port)
        return commit(s)
      }
      if (typeof target !== 'string' || !memberSocket(channelId, target)) return EMU_ERRORS.notInVoice
      if (s.ports[port] === target) return snapshot(s)
      const previous = s.ports.indexOf(target)
      if (previous >= 0) freePort(s, previous)
      if (s.ports[port] !== null) freePort(s, port)
      s.ports[port] = target
      s.relayed[port] = 0
      return commit(s)
    },

    /** `emu:pause` (host only). */
    pause(channelId: string, userId: string, paused: unknown): EmuRequestResult {
      const s = sessions.get(channelId)
      if (!s) return EMU_ERRORS.noSession
      if (s.hostId !== userId) return EMU_ERRORS.notHost
      if (typeof paused !== 'boolean') return EMU_ERRORS.invalidPaused
      if (s.paused === paused) return snapshot(s)
      s.paused = paused
      return commit(s)
    },

    /** `emu:stop` (host / admins): ends the session. null when done, else the error. */
    stop(channelId: string, userId: string, admin: boolean): string | null {
      const s = sessions.get(channelId)
      if (!s) return EMU_ERRORS.noSession
      if (!isHost(s, userId, admin)) return EMU_ERRORS.notHost
      close(s)
      return null
    },

    /**
     * `emu:input`: a player's held buttons, relayed to the host when they changed for that port. Ignored when the
     * caller holds no port, is the host (the host's own controller is applied on their device) or sent junk.
     */
    input(channelId: string, userId: string, buttons: unknown): void {
      const s = sessions.get(channelId)
      if (!s || s.hostId === userId) return
      if (typeof buttons !== 'number' || !Number.isInteger(buttons)) return
      const port = s.ports.indexOf(userId)
      if (port < 0) return
      const next = buttons & GAME_PAD_MASK
      if (s.relayed[port] === next) return
      relay(s, port, next)
    },

    /**
     * Who is in which voice channel now (after every voice state change). The host leaving closes the session;
     * a player leaving loses their port (the host is told their buttons are 0). When the host's voice moves to
     * another device, relays go to that socket (which first gets every port's held buttons).
     */
    setMembers(next: Map<string, EmuMember[]>) {
      members = next
      for (const s of [...sessions.values()]) {
        const hostSocket = memberSocket(s.channelId, s.hostId)
        if (!hostSocket) {
          close(s)
          continue
        }
        if (hostSocket !== s.hostSocketId) {
          // The new device gets what the players hold now.
          s.hostSocketId = hostSocket
          s.relayed.forEach((buttons, port) => {
            if (buttons !== 0) onInput(hostSocket, { channelId: s.channelId, port, buttons })
          })
        }
        let changed = false
        s.ports.forEach((id, port) => {
          if (id !== null && !memberSocket(s.channelId, id)) {
            freePort(s, port)
            changed = true
          }
        })
        if (changed) commit(s)
      }
    },

    /** Ends a channel's session (channel deleted). */
    drop(channelId: string) {
      const s = sessions.get(channelId)
      if (s) close(s)
    },

    /** Ends every session (the plugin was turned off). */
    clearAll() {
      for (const s of [...sessions.values()]) close(s)
    },

    /** Forgets all sessions without broadcasting (server shutdown). */
    shutdown() {
      sessions.clear()
    },
  }
}

export type EmuSessions = ReturnType<typeof createEmuSessions>
