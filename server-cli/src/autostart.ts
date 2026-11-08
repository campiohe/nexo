// `nexo-server autostart on|off|status` (docs/SPEC-SERVER-CLI.md §3.3): start with the computer, without
// admin rights.
//
// - Windows: a value in the per-user Run key (HKCU\...\CurrentVersion\Run), written with reg.exe. At login
//   Windows starts nexo-server in a console window (closing that window stops the server).
// - Linux: a systemd *user* unit (~/.config/systemd/user/nexo-server.service), enabled with
//   `systemctl --user`. Without `loginctl enable-linger` it only runs while the user is logged in.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run'
/** Where Task Manager's "Startup apps" stores enabled/disabled for Run entries. */
export const STARTUP_APPROVED_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\Run'
export const RUN_VALUE = 'Nexo Server'
export const UNIT_NAME = 'nexo-server.service'

export interface ExecResult {
  /** Exit code; -1 when the program couldn't run at all (see `missing`). */
  code: number
  stdout: string
  stderr: string
  /** The program doesn't exist (ENOENT). */
  missing?: boolean
}

/** Runs a program without a shell; never throws. */
export type Exec = (file: string, args: readonly string[]) => Promise<ExecResult>

export interface AutostartDeps {
  platform: NodeJS.Platform
  /** The packaged nexo-server (packagedBinary()), or null when running from source. */
  binary: string | null
  dataDir: string
  /** config.json exists for dataDir. */
  configured: boolean
  /** A server is running for dataDir right now. */
  running: boolean
  exec: Exec
  out: (line?: string) => void
  err: (line?: string) => void
  env?: NodeJS.ProcessEnv
  homedir?: string
}

// ---------- Windows ----------

/**
 * A command-line argument in double quotes, as CommandLineToArgvW (and Node) parse it: backslashes before
 * a quote (including the closing one) are doubled, quotes escaped.
 */
export function quoteWindowsArg(s: string): string {
  return `"${s.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1')}"`
}

/** The Run value's data: `"<exe>" --data "<dir>"`. */
export function windowsRunCommand(binary: string, dataDir: string): string {
  return `${quoteWindowsArg(binary)} --data ${quoteWindowsArg(dataDir)}`
}

export const regExe = (env: NodeJS.ProcessEnv = process.env) =>
  env.SystemRoot ? path.win32.join(env.SystemRoot, 'System32', 'reg.exe') : 'reg.exe'

export const regArgs = {
  add: (data: string) => ['add', RUN_KEY, '/v', RUN_VALUE, '/t', 'REG_SZ', '/d', data, '/f'],
  query: (key = RUN_KEY) => ['query', key, '/v', RUN_VALUE],
  delete: (key = RUN_KEY) => ['delete', key, '/v', RUN_VALUE, '/f'],
}

/** The data of `RUN_VALUE` in `reg query` output, or null. */
export function parseRegQuery(stdout: string): { type: string; data: string } | null {
  for (const line of stdout.split(/\r?\n/)) {
    const m = /^\s+(.+?)\s{4}(REG_\w+)\s{4}(.*)$/.exec(line) ?? /^\s+(.+?)\s{4}(REG_\w+)$/.exec(line)
    if (m && m[1] === RUN_VALUE) return { type: m[2]!, data: m[3] ?? '' }
  }
  return null
}

/** Task Manager marks a disabled startup entry with an odd first byte (03…), enabled with 02…. */
export const approvedDisabled = (hex: string) => /^[0-9a-f]{2}/i.test(hex) && (parseInt(hex.slice(0, 2), 16) & 1) === 1

async function windows(action: Action, d: AutostartDeps): Promise<number> {
  const reg = regExe(d.env)
  const current = await d.exec(reg, regArgs.query())
  if (current.missing) {
    d.err(`Can't find reg.exe (${reg}), so autostart can't be changed.`)
    return 1
  }
  const value = current.code === 0 ? parseRegQuery(current.stdout) : null

  if (action === 'status') {
    if (!value) {
      d.out('Autostart is off: Nexo Server does not start with Windows.')
      d.out('Turn it on with "nexo-server autostart on".')
      return 0
    }
    const approved = await d.exec(reg, regArgs.query(STARTUP_APPROVED_KEY))
    const flags = approved.code === 0 ? parseRegQuery(approved.stdout) : null
    if (flags && approvedDisabled(flags.data)) {
      d.out('Autostart is set up but disabled in Task Manager (Startup apps).')
      d.out('Run "nexo-server autostart on" to enable it again, or enable "Nexo Server" there.')
    } else d.out('Autostart is on: Nexo Server starts in a console window when you log in to Windows.')
    d.out(`  Command: ${value.data}`)
    return 0
  }

  if (action === 'off') {
    if (!value) {
      d.out('Autostart was already off.')
      return 0
    }
    const r = await d.exec(reg, regArgs.delete())
    if (r.code !== 0) {
      d.err(`Couldn't turn autostart off: ${r.stderr.trim() || r.stdout.trim() || `reg.exe exit code ${r.code}`}`)
      return 1
    }
    await d.exec(reg, regArgs.delete(STARTUP_APPROVED_KEY)) // usually absent: ignore the result
    d.out('Autostart is off: Nexo Server will no longer start with Windows.')
    return 0
  }

  const data = windowsRunCommand(d.binary!, d.dataDir)
  const r = await d.exec(reg, regArgs.add(data))
  if (r.code !== 0) {
    d.err(`Couldn't turn autostart on: ${r.stderr.trim() || r.stdout.trim() || `reg.exe exit code ${r.code}`}`)
    return 1
  }
  // A "disabled" mark from Task Manager would keep it from starting: clear it (no-op when absent).
  await d.exec(reg, regArgs.delete(STARTUP_APPROVED_KEY))
  d.out('Autostart is on: Nexo Server will start when you log in to Windows.')
  d.out('  It opens in a console window; keep that window open (minimize it). Closing it stops the server.')
  d.out(`  Command: ${data}`)
  d.out('  If you move nexo-server.exe to another folder, run "nexo-server autostart on" again from there.')
  d.out('  Turn it off with "nexo-server autostart off".')
  return 0
}

// ---------- Linux (systemd user unit) ----------

/** A systemd ExecStart argument: double-quoted with C escapes; `%` and `$` doubled (specifiers, variables). */
export function systemdQuote(s: string): string {
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%').replace(/\$/g, '$$$$')}"`
}

export function systemdUnit(binary: string, dataDir: string): string {
  return [
    '# Written by "nexo-server autostart on". Remove with "nexo-server autostart off".',
    '[Unit]',
    'Description=Nexo Server',
    '',
    '[Service]',
    `ExecStart=${systemdQuote(binary)} --data ${systemdQuote(dataDir)}`,
    'Restart=on-failure',
    'RestartSec=10',
    // Plain output for the journal (no box drawing).
    'Environment=NEXO_ASCII=1',
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  ].join('\n')
}

export function unitPath(env: NodeJS.ProcessEnv = process.env, home = os.homedir()): string {
  const config = env.XDG_CONFIG_HOME && path.posix.isAbsolute(env.XDG_CONFIG_HOME) ? env.XDG_CONFIG_HOME : path.posix.join(home, '.config')
  return path.posix.join(config, 'systemd', 'user', UNIT_NAME)
}

const firstLine = (r: ExecResult) => (r.stderr.trim() || r.stdout.trim()).split('\n')[0] || `exit code ${r.code}`

async function linux(action: Action, d: AutostartDeps): Promise<number> {
  const env = d.env ?? process.env
  const file = unitPath(env, d.homedir)
  const systemctl = (...args: string[]) => d.exec('systemctl', ['--user', ...args])
  const user = env.USER || os.userInfo().username

  if (action === 'status') {
    if (!existsSync(file)) {
      d.out('Autostart is off (no systemd user unit). Turn it on with "nexo-server autostart on".')
      return 0
    }
    const enabled = await systemctl('is-enabled', UNIT_NAME)
    const active = await systemctl('is-active', UNIT_NAME)
    if (enabled.missing) d.out(`A unit file exists (${file}), but systemctl isn't available to tell its state.`)
    else d.out(`Autostart: ${enabled.stdout.trim() || 'unknown'} (service is ${active.stdout.trim() || 'unknown'}). Unit: ${file}`)
    return 0
  }

  if (action === 'off') {
    const r = await systemctl('disable', '--now', UNIT_NAME)
    const had = existsSync(file)
    rmSync(file, { force: true })
    if (!r.missing) await systemctl('daemon-reload')
    if (r.missing) d.out(had ? `Removed ${file}. (systemctl isn't available; nothing else to undo.)` : 'Autostart was already off.')
    else if (r.code !== 0 && had) d.out(`Removed ${file} (systemctl said: ${firstLine(r)}).`)
    else d.out(had ? 'Autostart is off: the systemd user service is stopped and removed.' : 'Autostart was already off.')
    return 0
  }

  const unit = systemdUnit(d.binary!, d.dataDir)
  mkdirSync(path.dirname(file), { recursive: true })
  const changed = !existsSync(file) || readFileSync(file, 'utf8') !== unit
  if (changed) writeFileSync(file, unit)

  const manual = (why: string) => {
    d.out(`Wrote ${file}, but ${why}. Enable it yourself:`)
    d.out('  systemctl --user daemon-reload')
    d.out(`  systemctl --user enable --now ${UNIT_NAME}`)
    d.out(`  loginctl enable-linger ${user}    # keep it running when you're not logged in`)
    d.out('The unit:')
    for (const l of unit.trimEnd().split('\n')) d.out(`  ${l}`)
  }
  const reload = await systemctl('daemon-reload')
  if (reload.missing) {
    manual("systemctl isn't available here")
    return 1
  }
  if (reload.code !== 0) {
    manual(`systemctl --user doesn't work here (${firstLine(reload)})`)
    return 1
  }
  // Don't start a second copy now if one is running in a terminal: it would just say "already running".
  const enable = await systemctl('enable', ...(d.running ? [] : ['--now']), UNIT_NAME)
  if (enable.code !== 0) {
    manual(`enabling it failed (${firstLine(enable)})`)
    return 1
  }
  d.out(`Autostart is on: systemd starts Nexo Server when you log in (unit ${file}).`)
  if (d.running) d.out('  It is running in a terminal now: stop that one, then "systemctl --user start nexo-server" runs it in the background.')
  else d.out('  It is running in the background now. Logs: journalctl --user -u nexo-server -f')
  const linger = await d.exec('loginctl', ['show-user', user, '-p', 'Linger'])
  if (!/Linger=yes/.test(linger.stdout)) {
    d.out(`  To keep it running when you're not logged in (e.g. after a reboot): loginctl enable-linger ${user}`)
  }
  d.out('  Turn it off with "nexo-server autostart off".')
  return 0
}

// ---------- command ----------

export type Action = 'on' | 'off' | 'status'

/** Runs `nexo-server autostart [on|off|status]`. Returns the exit code. */
export async function runAutostart(action: Action, d: AutostartDeps): Promise<number> {
  if (d.platform !== 'win32' && d.platform !== 'linux') {
    d.err('autostart is only available on Windows and Linux.')
    return 1
  }
  if (action === 'on') {
    if (!d.binary) {
      d.err('"autostart on" needs the downloaded nexo-server program: it is running from source (node) now,')
      d.err('and autostart would have to start that same command. Use the packaged nexo-server instead.')
      return 1
    }
    if (!d.configured) {
      d.err(`No server is set up in ${d.dataDir} yet. Run "nexo-server" once first (it asks a few questions), then turn autostart on.`)
      return 1
    }
  }
  return d.platform === 'win32' ? windows(action, d) : linux(action, d)
}
