// The invite the host sends to friends (docs/SPEC-SERVER-CLI.md §3.1), as plain lines.
//
// Pure: no I/O. Draws a box when it fits the console and the console can show it; falls back to ASCII
// borders, and to no box at all in very narrow consoles (URLs are never wrapped, so they stay copyable).

import type { ServerCliConfig } from './config.ts'

export interface InviteAddress {
  /** e.g. "Internet", "Tailscale", "Same network" */
  label: string
  url: string
  /** The one to send; the first recommended (or the first) address goes in the box. */
  recommended?: boolean
}

export interface InviteInput {
  serverName: string
  /** Empty = no password. */
  password: string
  addresses: InviteAddress[]
  /** How the host joins from this PC, e.g. http://localhost:3001 */
  localUrl: string
  /** Plain-words guidance shown under the invite. */
  notes: string[]
}

export interface RenderOptions {
  /** ASCII only (no box-drawing characters, em dashes or ellipses). */
  ascii?: boolean
  /** Console width in columns. Default 80. */
  width?: number
  /** Left margin. Default 2 spaces. */
  indent?: string
}

/** Symbols with an ASCII fallback, for the startup checklist (✓/✗) and other console output. */
export function symbols(ascii: boolean) {
  return ascii
    ? { ok: '[ok]', fail: '[!!]', warn: '[!]', dash: '-', ellipsis: '...', dot: '|', range: '-' }
    : { ok: '✓', fail: '✗', warn: '!', dash: '—', ellipsis: '…', dot: '·', range: '–' }
}

/**
 * Whether the console can show box-drawing characters. Windows: yes (Node writes UTF-16 to the console).
 * Elsewhere: when the locale is UTF-8 and the terminal isn't "dumb". `NEXO_ASCII=1` forces ASCII.
 */
export function supportsUnicode(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): boolean {
  if (env.NEXO_ASCII && env.NEXO_ASCII !== '0') return false
  if (env.TERM === 'dumb') return false
  if (platform === 'win32') return true
  const locale = env.LC_ALL || env.LC_CTYPE || env.LANG || ''
  return /utf-?8/i.test(locale)
}

/** Column width of a string (code points; good enough for names and URLs). */
const width = (s: string) => [...s].length

function truncate(s: string, max: number, ellipsis: string): string {
  const chars = [...s]
  if (chars.length <= max) return s
  return chars.slice(0, Math.max(0, max - width(ellipsis))).join('') + ellipsis
}

/** Greedy word wrap to `max` columns; words longer than a line are kept whole. */
export function wrap(text: string, max: number): string[] {
  const out: string[] = []
  let line = ''
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (!line) line = word
    else if (width(line) + 1 + width(word) <= max) line += ' ' + word
    else {
      out.push(line)
      line = word
    }
  }
  if (line) out.push(line)
  return out
}

/** Picks the address that goes in the box. */
export function primaryAddress(addresses: InviteAddress[]): InviteAddress | undefined {
  return addresses.find((a) => a.recommended) ?? addresses[0]
}

/** The invite as console lines (no trailing newlines). */
export function renderInvite(input: InviteInput, opts: RenderOptions = {}): string[] {
  const ascii = opts.ascii ?? false
  const cols = Math.max(20, opts.width ?? 80)
  const indent = opts.indent ?? '  '
  const sym = symbols(ascii)
  const room = cols - width(indent) // usable columns
  const lines: string[] = []

  const primary = primaryAddress(input.addresses)
  const serverUrl = primary?.url ?? input.localUrl
  const password = input.password || '(none needed)'
  const body = [`Server:   ${serverUrl}`, `Password: ${password}`]

  const name = truncate(input.serverName, Math.max(8, room - 40), sym.ellipsis)
  const header = `Invite your friends to "${name}" ${sym.dash} send them this:`
  lines.push(...(width(header) <= room ? [header] : [`Invite your friends to "${name}":`]).map((l) => indent + l))

  // Box: at least 46 wide like the spec's example, wider for long URLs, if the console has room.
  const inner = Math.max(44, ...body.map((l) => width(l) + 2))
  if (inner + 2 <= room) {
    const [tl, tr, bl, br, h, v] = ascii ? ['+', '+', '+', '+', '-', '|'] : ['┌', '┐', '└', '┘', '─', '│']
    lines.push(indent + tl + h.repeat(inner) + tr)
    for (const l of body) lines.push(indent + v + ' ' + l + ' '.repeat(inner - 1 - width(l)) + v)
    lines.push(indent + bl + h.repeat(inner) + br)
  } else {
    for (const l of body) lines.push(indent + l)
  }
  if (!primary) lines.push(indent + 'Only reachable from this PC for now (see below).')

  // "label: url" on one line when it fits, else the URL on its own line (never broken).
  const labeled = (pad: string, label: string, url: string) => {
    const one = `${pad}${label}: ${url}`
    if (width(one) <= room) lines.push(indent + one)
    else lines.push(`${indent}${pad}${label}:`, `${indent}${pad}  ${url}`)
  }
  const others = input.addresses.filter((a) => a !== primary)
  if (others.length) {
    lines.push(indent + 'Other addresses:')
    for (const a of others) labeled('  ', a.label, a.url)
  }
  labeled('', 'You (on this PC)', input.localUrl)

  if (input.notes.length) {
    lines.push('')
    for (const note of input.notes) for (const l of wrap(note, room)) lines.push(indent + l)
  }
  return lines
}

// ---------- adapter for the network probe (server-cli/src/network, agent B) ----------

/** Shape of `probeNetwork()`'s result (src/network). Declared here so the CLI doesn't depend on its internals. */
export interface NetworkProbe {
  lan: string[]
  tailscale: { ip: string } | null
  stunIp: string | null
  gateway: { found: boolean; externalIp: string | null }
  reachability: 'public' | 'cgnat' | 'unknown'
  notes: string[]
}

/** http URL for an IPv4/IPv6 address and port. */
export function httpUrl(host: string, port: number): string {
  return `http://${host.includes(':') ? `[${host}]` : host}:${port}`
}

/**
 * Turns a network probe and the (effective) config into invite input.
 * Recommended address by mode: tailscale → Tailscale; public → internet; lan → same network;
 * auto → Tailscale if present, else internet if reachable, else same network.
 */
export function inviteFromProbe(probe: NetworkProbe, cfg: ServerCliConfig): InviteInput {
  const port = cfg.ports.http
  const mode = cfg.network.mode
  const notes: string[] = []

  const ts: InviteAddress | null = probe.tailscale ? { label: 'Tailscale', url: httpUrl(probe.tailscale.ip, port) } : null
  const publicIp = probe.reachability === 'public' ? (probe.gateway.externalIp ?? probe.stunIp) : null
  const pub: InviteAddress | null = publicIp ? { label: 'Internet', url: httpUrl(publicIp, port) } : null
  const lan: InviteAddress[] = probe.lan.map((ip) => ({ label: 'Same network', url: httpUrl(ip, port) }))

  let pick: InviteAddress | undefined
  if (mode === 'tailscale') {
    pick = ts ?? undefined
    if (!ts) notes.push('Network mode is "tailscale", but Tailscale is not running on this PC. Start Tailscale, or run "nexo-server setup" to change the mode.')
  } else if (mode === 'public') {
    pick = pub ?? undefined
    if (!pub) notes.push('Network mode is "public", but this PC could not confirm a public address that friends can reach.')
  } else if (mode === 'lan') {
    pick = lan[0]
  } else {
    pick = ts ?? pub ?? lan[0]
  }
  if (pick) pick.recommended = true

  // Primary first, then the rest in a stable order. In "lan" mode, internet/Tailscale aren't offered.
  const all = (mode === 'lan' ? lan : [ts, pub, ...lan]).filter((a): a is InviteAddress => a !== null)
  const addresses = pick ? [pick, ...all.filter((a) => a !== pick)] : all

  return {
    serverName: cfg.serverName,
    password: cfg.serverPassword,
    addresses,
    localUrl: httpUrl('localhost', port),
    notes: [...notes, ...probe.notes],
  }
}
