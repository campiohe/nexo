// Command-line parsing (docs/SPEC-SERVER-CLI.md §3.3). No dependencies; returns a typed command.

export interface GlobalOptions {
  /** `--data <dir>`: another data folder. */
  dataDir?: string
  /** `--ascii`: no box-drawing characters (also NEXO_ASCII=1). */
  ascii?: boolean
}

export interface SetupFlagOptions {
  name?: string
  password?: string
  noPassword?: boolean
}

export type Command =
  /** Start the server (runs setup first when there is no config; setup flags apply then). */
  | { kind: 'start'; global: GlobalOptions; setup: SetupFlagOptions }
  | { kind: 'setup'; global: GlobalOptions; setup: SetupFlagOptions }
  | { kind: 'invite'; global: GlobalOptions }
  | { kind: 'status'; global: GlobalOptions }
  | { kind: 'backup'; global: GlobalOptions; file?: string }
  | { kind: 'rename-user'; global: GlobalOptions; oldName: string; newName: string; force: boolean }
  /** `autostart` alone (or `status`) shows the current state. */
  | { kind: 'autostart'; global: GlobalOptions; action: 'on' | 'off' | 'status' }
  | { kind: 'update'; global: GlobalOptions }
  | { kind: 'help'; global: GlobalOptions }
  | { kind: 'version'; global: GlobalOptions }
  /** Invalid usage: print `message` and `usage()` to stderr, exit 2. */
  | { kind: 'error'; global: GlobalOptions; message: string }

export type CommandKind = Command['kind']

const SUBCOMMANDS = ['setup', 'invite', 'status', 'backup', 'rename-user', 'autostart', 'update', 'help'] as const

/** Usage text (the program name defaults to `nexo-server`). */
export function usage(prog = 'nexo-server'): string {
  return [
    `Usage: ${prog} [command] [options]`,
    '',
    'Commands:',
    `  (none)                      Start the server (asks a few questions the first time)`,
    `  setup                       Change the server name, password and ports`,
    `  invite                      Show what to send friends (address + password)`,
    `  status                      Is it running, who's online, ports, version`,
    `  backup [file]               Save a copy of the database (default: <data>/backups/)`,
    `  rename-user <old> <new>     Free a name: rename a user, keeping their messages`,
    `  autostart [on|off]          Start with the computer (per user, no admin); alone: show the state`,
    `  update                      Download and install the newest server version`,
    '',
    'Options:',
    `  --data <dir>                Use another data folder (several servers, or an existing server/data)`,
    `  --name <name>               Setup without questions: server name`,
    `  --password <password>       Setup without questions: password for new friends`,
    `  --no-password               Setup without questions: no password`,
    `  --force                     rename-user: even while the server is running`,
    `  --ascii                     Plain ASCII output`,
    `  -h, --help                  Show this help`,
    `  -v, --version               Show the version`,
  ].join('\n')
}

/**
 * Parses `argv` (without the node/exe path, i.e. `process.argv.slice(2)` or the SEA equivalent).
 * Options may come before or after the command; `--opt=value` and `--opt value` both work; `--` ends options.
 */
export function parseArgs(argv: readonly string[]): Command {
  const global: GlobalOptions = {}
  const setup: SetupFlagOptions = {}
  const positional: string[] = []
  let force = false
  let help = false
  let version = false
  const err = (message: string): Command => ({ kind: 'error', global, message })

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--') {
      positional.push(...argv.slice(i + 1))
      break
    }
    if (!arg.startsWith('-') || arg === '-') {
      positional.push(arg)
      continue
    }
    const eq = arg.indexOf('=')
    const flag = eq > 0 && arg.startsWith('--') ? arg.slice(0, eq) : arg
    const inline = eq > 0 && arg.startsWith('--') ? arg.slice(eq + 1) : undefined
    const value = (): string | null => {
      if (inline !== undefined) return inline
      const next = argv[i + 1]
      if (next === undefined || (next.startsWith('-') && next !== '-')) return null
      i++
      return next
    }
    const noValue = () => inline === undefined

    switch (flag) {
      case '--data': {
        const v = value()
        if (v === null || !v.trim()) return err('--data needs a folder, e.g. --data "D:\\Nexo"')
        global.dataDir = v
        break
      }
      case '--name': {
        const v = value()
        if (v === null) return err('--name needs a value, e.g. --name "The Lounge"')
        setup.name = v
        break
      }
      case '--password': {
        const v = value()
        if (v === null || v === '') return err('--password needs a value (use --no-password for none)')
        setup.password = v
        break
      }
      case '--no-password':
        if (!noValue()) return err('--no-password takes no value')
        setup.noPassword = true
        break
      case '--force':
        if (!noValue()) return err('--force takes no value')
        force = true
        break
      case '--ascii':
        if (!noValue()) return err('--ascii takes no value')
        global.ascii = true
        break
      case '-h':
      case '--help':
        help = true
        break
      case '-v':
      case '--version':
        version = true
        break
      default:
        return err(`Unknown option "${flag}"`)
    }
  }

  if (help) return { kind: 'help', global }
  if (version) return { kind: 'version', global }

  const [name, ...args] = positional
  const setupFlagsUsed = setup.name !== undefined || setup.password !== undefined || setup.noPassword === true
  if (setup.password !== undefined && setup.noPassword) return err('Use either --password or --no-password, not both')
  if (force && name !== 'rename-user') return err('--force only applies to rename-user')
  if (setupFlagsUsed && name !== undefined && name !== 'setup') return err(`--name/--password/--no-password only apply to setup (or starting for the first time)`)

  const extra = (n: number): Command | null => (args.length > n ? err(`Too many arguments for "${name}": ${args.slice(n).join(' ')}`) : null)

  switch (name) {
    case undefined:
      return { kind: 'start', global, setup }
    case 'setup':
      return extra(0) ?? { kind: 'setup', global, setup }
    case 'invite':
    case 'status':
    case 'update':
      return extra(0) ?? { kind: name, global }
    case 'help':
      return { kind: 'help', global }
    case 'backup':
      return extra(1) ?? { kind: 'backup', global, ...(args[0] !== undefined ? { file: args[0] } : {}) }
    case 'rename-user':
      if (args.length < 2) return err('rename-user needs the current name and the new name, e.g. rename-user "Alice" "Alice-old"')
      return extra(2) ?? { kind: 'rename-user', global, oldName: args[0], newName: args[1], force }
    case 'autostart': {
      const v = args[0]?.toLowerCase() ?? 'status'
      if (v !== 'on' && v !== 'off' && v !== 'status') return err('autostart takes "on", "off" or nothing (shows the state)')
      return extra(1) ?? { kind: 'autostart', global, action: v }
    }
    default: {
      const near = SUBCOMMANDS.find((c) => c.startsWith(name.slice(0, 3).toLowerCase()))
      return err(`Unknown command "${name}"${near ? ` (did you mean "${near}"?)` : ''}`)
    }
  }
}
