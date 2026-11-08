// First-run setup (docs/SPEC-SERVER-CLI.md §3.1): server name, password, and ports behind "Advanced?".
//
// Interactive when there's a console; scripted with --name / --password / --no-password otherwise.
// Streams are injected so tests can drive it with scripted input.

import { randomInt } from 'node:crypto'
import { createInterface } from 'node:readline/promises'
import type { Readable, Writable } from 'node:stream'
import {
  createDefaultConfig,
  DEFAULT_PORTS,
  DEFAULT_SERVER_NAME,
  NETWORK_MODES,
  SERVER_NAME_MAX,
  SERVER_PASSWORD_MAX,
  type NetworkMode,
  type ServerCliConfig,
} from './config.ts'

// Short, common, easy to spell and say out loud; no homophones or look-alikes.
const WORDS = [
  'acorn', 'amber', 'anchor', 'apple', 'arrow', 'aspen', 'badger', 'bamboo', 'banjo', 'basil', 'beacon', 'bear',
  'berry', 'birch', 'bison', 'blaze', 'bloom', 'boulder', 'breeze', 'brook', 'cactus', 'canyon', 'cedar', 'cherry',
  'cliff', 'clover', 'cobalt', 'comet', 'copper', 'coral', 'cotton', 'crane', 'cricket', 'daisy', 'delta', 'dolphin',
  'dune', 'eagle', 'ember', 'falcon', 'fern', 'fig', 'finch', 'fjord', 'flint', 'forest', 'fox', 'frost',
  'garnet', 'gecko', 'ginger', 'glacier', 'grove', 'harbor', 'hazel', 'heron', 'honey', 'island', 'ivy', 'jade',
  'jaguar', 'juniper', 'kayak', 'kettle', 'kiwi', 'lagoon', 'lantern', 'lemon', 'lily', 'lime', 'lotus', 'lynx',
  'magnet', 'mango', 'maple', 'marble', 'meadow', 'melon', 'mint', 'moss', 'nectar', 'nova', 'oak', 'ocean',
  'olive', 'orbit', 'otter', 'owl', 'panda', 'pebble', 'pepper', 'pine', 'planet', 'plum', 'pony', 'puffin',
  'quartz', 'rabbit', 'radar', 'raven', 'reef', 'river', 'robin', 'rocket', 'saffron', 'sage', 'salmon', 'sparrow',
  'spruce', 'squid', 'stone', 'storm', 'summit', 'sunset', 'swan', 'thunder', 'tiger', 'timber', 'topaz', 'tulip',
  'tundra', 'velvet', 'violet', 'walnut', 'willow', 'wolf', 'yak', 'zebra',
] as const

/** A memorable password like `moss-tiger-41`: two words and a number (about 20 bits; it only gates new identities). */
export function generatePassword(): string {
  const a = WORDS[randomInt(WORDS.length)]
  let b = WORDS[randomInt(WORDS.length)]
  while (b === a) b = WORDS[randomInt(WORDS.length)]
  return `${a}-${b}-${randomInt(10, 100)}`
}

export const PASSWORD_RE = /^[a-z]+-[a-z]+-[1-9][0-9]$/

export class SetupError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SetupError'
  }
}

export interface SetupFlags {
  name?: string
  password?: string
  noPassword?: boolean
}

export interface SetupOptions {
  /** Where the config will be saved (shown to the host). */
  dataDir: string
  /** Current config when re-running setup: its answers become the defaults and its LiveKit keys are kept. */
  existing?: ServerCliConfig | null
  flags?: SetupFlags
  input?: Readable
  output?: Writable
  /** Whether `input` is an interactive console. Default: `input.isTTY`. */
  interactive?: boolean
  /** Shown in the header, e.g. "0.5.0". */
  version?: string
  platform?: NodeJS.Platform
}

export interface SetupResult {
  config: ServerCliConfig
  /** True when the password was generated (so the caller can highlight it). */
  generatedPassword: boolean
}

const NON_TTY_HELP =
  'Setup needs answers, but this is not an interactive console.\n' +
  'Run "nexo-server setup" in a terminal (or double-click nexo-server), or set it up with flags:\n' +
  '  nexo-server setup --name "The Lounge" --password <password>\n' +
  '  nexo-server setup --name "The Lounge" --no-password'

/** Checks a server name; returns the cleaned name or an error message. */
export function checkServerName(name: string): { ok: true; value: string } | { ok: false; error: string } {
  const v = name.trim().replace(/\s+/g, ' ')
  if (!v) return { ok: false, error: 'The server name can\'t be empty.' }
  if (v.length > SERVER_NAME_MAX) return { ok: false, error: `Keep the server name under ${SERVER_NAME_MAX + 1} characters.` }
  return { ok: true, value: v }
}

/** Checks a password typed by the host; returns an error message or null. */
export function checkPassword(pw: string): string | null {
  if (pw.length > SERVER_PASSWORD_MAX) return `Keep the password under ${SERVER_PASSWORD_MAX + 1} characters.`
  if (pw !== pw.trim()) return 'The password can\'t start or end with a space.'
  return null
}

/** Applies `--name/--password/--no-password` without asking anything. */
function scriptedSetup(opts: SetupOptions, out: (line: string) => void): SetupResult {
  const flags = opts.flags ?? {}
  if (flags.password !== undefined && flags.noPassword) throw new SetupError('Use either --password or --no-password, not both.')
  const base = opts.existing ?? createDefaultConfig()
  let serverName = base.serverName
  if (flags.name !== undefined) {
    const r = checkServerName(flags.name)
    if (!r.ok) throw new SetupError(r.error)
    serverName = r.value
  }
  let serverPassword = base.serverPassword
  let generatedPassword = false
  if (flags.noPassword) serverPassword = ''
  else if (flags.password !== undefined) {
    const err = checkPassword(flags.password)
    if (err) throw new SetupError(err)
    if (!flags.password) throw new SetupError('--password needs a value (use --no-password for none).')
    serverPassword = flags.password
  } else if (!opts.existing) {
    serverPassword = generatePassword()
    generatedPassword = true
  }
  const config: ServerCliConfig = { ...base, serverName, serverPassword }
  out(`Server name: ${config.serverName}`)
  out(`Password:    ${config.serverPassword || '(none)'}`)
  out(`Data folder: ${opts.dataDir}`)
  return { config, generatedPassword }
}

/**
 * Runs setup and returns the new config (not saved: the caller saves it with saveCliConfig).
 * Throws SetupError when it can't ask (no console and no flags) or the input ends early.
 */
export async function runSetup(opts: SetupOptions): Promise<SetupResult> {
  const input = opts.input ?? process.stdin
  const output = opts.output ?? process.stdout
  const out = (line = '') => output.write(line + '\n')
  const flags = opts.flags ?? {}
  const scripted = flags.name !== undefined || flags.password !== undefined || flags.noPassword === true
  if (scripted) return scriptedSetup(opts, out)

  const interactive = opts.interactive ?? (input as Readable & { isTTY?: boolean }).isTTY === true
  if (!interactive) throw new SetupError(NON_TTY_HELP)

  const existing = opts.existing ?? null
  const rl = createInterface({ input, output, terminal: (output as Writable & { isTTY?: boolean }).isTTY === true })
  // Lines are read through the async iterator, which buffers them: piped or pasted answers that arrive
  // before the question is printed are not lost (rl.question would drop them).
  const lines = rl[Symbol.asyncIterator]()
  // Ctrl+C in a terminal: readline would only pause; end the input instead so setup stops cleanly.
  rl.on('SIGINT', () => rl.close())
  let closed = false
  rl.on('close', () => (closed = true))
  const ask = async (prompt: string): Promise<string> => {
    // Through readline's own prompt, so line editing in a terminal redraws the question too.
    // Once the input has ended, buffered answers are still read; the prompt is then written directly.
    if (closed) output.write(prompt)
    else {
      rl.setPrompt(prompt)
      rl.prompt()
    }
    const next = await lines.next()
    if (next.done) throw new SetupError('Setup was cancelled (input ended). Nothing was saved.')
    return String(next.value).trim()
  }
  const yesNo = async (prompt: string, def: boolean): Promise<boolean> => {
    for (;;) {
      const a = (await ask(`${prompt} ${def ? '[Y/n]' : '[y/N]'}: `)).toLowerCase()
      if (!a) return def
      if (['y', 'yes'].includes(a)) return true
      if (['n', 'no'].includes(a)) return false
      out('  Please answer y or n.')
    }
  }

  try {
    out(`Nexo Server${opts.version ? ` ${opts.version}` : ''} — ${existing ? 'setup' : 'first-time setup'}`)
    out()

    // --- name ---
    const defName = existing?.serverName ?? DEFAULT_SERVER_NAME
    let serverName = defName
    for (;;) {
      const a = await ask(`  Server name  [${defName}]: `)
      if (!a) break
      const r = checkServerName(a)
      if (r.ok) {
        serverName = r.value
        break
      }
      out(`  ${r.error}`)
    }

    // --- password ---
    // Enter = keep the current one (re-run) or take the suggested generated one (first run).
    const suggestion = existing ? existing.serverPassword : generatePassword()
    const hint = existing
      ? `Password for new friends (Enter = keep, "none" = no password) [${existing.serverPassword || 'none'}]: `
      : `Password for new friends (Enter = generate one) [${suggestion}]: `
    let serverPassword = suggestion
    let generatedPassword = !existing
    for (;;) {
      const a = await ask(`  ${hint}`)
      if (!a) break
      if (a.toLowerCase() === 'none') {
        out('  Without a password, anyone who has the address can join.')
        if (await yesNo('  Continue without a password?', false)) {
          serverPassword = ''
          generatedPassword = false
          break
        }
        continue
      }
      const err = checkPassword(a)
      if (err) {
        out(`  ${err}`)
        continue
      }
      serverPassword = a
      generatedPassword = false
      break
    }

    // --- advanced ---
    const base = existing ?? createDefaultConfig()
    const ports = { ...base.ports }
    let mode: NetworkMode = base.network.mode
    out()
    if (await yesNo('  Advanced settings (ports, network mode)?', false)) {
      const askPort = async (label: string, def: number, taken: number[]): Promise<number> => {
        for (;;) {
          const a = await ask(`    ${label} [${def}]: `)
          const n = a ? Number(a) : def
          if (!Number.isInteger(n) || n < 1 || n > 65535) out('    Enter a port number between 1 and 65535.')
          else if (taken.includes(n)) out('    That port is already used by another setting.')
          else return n
        }
      }
      ports.http = await askPort('Nexo server port (TCP)', ports.http, [])
      ports.livekit = await askPort('Voice signaling port (TCP)', ports.livekit, [ports.http])
      ports.livekitTcp = await askPort('Voice fallback port (TCP)', ports.livekitTcp, [ports.http, ports.livekit])
      ports.livekitUdp = await askPort('Voice media port (UDP)', ports.livekitUdp, [ports.http, ports.livekit, ports.livekitTcp])
      for (;;) {
        out('    Network mode: auto = pick the best way (recommended), tailscale, public (port forwarding), lan')
        const a = (await ask(`    Network mode [${mode}]: `)).toLowerCase()
        if (!a) break
        if ((NETWORK_MODES as readonly string[]).includes(a)) {
          mode = a as NetworkMode
          break
        }
        out(`    Choose one of: ${NETWORK_MODES.join(', ')}`)
      }
      if (mode === 'public' || mode === 'auto') {
        out('    Note: opening ports puts the server on the internet over plain http. Tailscale is safer when it works for your group.')
      }
    }

    const config: ServerCliConfig = { ...base, serverName, serverPassword, ports, network: { mode } }
    out()
    out(`  Data folder: ${opts.dataDir}`)
    if ((opts.platform ?? process.platform) === 'win32' && !existing) {
      out('  Windows will ask to let nexo-server and livekit-server through the firewall:')
      out('  click Allow on both, for private and public networks.')
    }
    if (ports.http !== DEFAULT_PORTS.http || ports.livekit !== DEFAULT_PORTS.livekit) {
      out(`  Ports: ${ports.http} (server), ${ports.livekit}/${ports.livekitTcp} TCP + ${ports.livekitUdp} UDP (voice)`)
    }
    return { config, generatedPassword }
  } finally {
    rl.close()
  }
}
