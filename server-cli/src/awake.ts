// Keep the PC from sleeping while friends are connected (docs/SPEC-SERVER-CLI.md §7), not while idle.
//
// Windows: Node has no FFI, so a small Windows PowerShell child calls
// SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED) once and then blocks reading its stdin. The
// request lasts as long as that thread lives, so killing the child (or closing its stdin) ends it. No
// orphans: the child exits when its stdin pipe closes (this process died), and on Windows libuv also puts
// non-detached children in a kill-on-close job object.
// Linux: `systemd-inhibit --what=sleep … cat`, same idea (cat exits when its stdin closes). Where that
// isn't available or allowed (no systemd, headless without polkit rights), it logs once and moves on.
// The display may still turn off; only system sleep is blocked.
import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { powershellArgs, powershellExe } from './powershell.ts'

export type SpawnFn = (file: string, args: readonly string[], options: SpawnOptions) => ChildProcess

/** ES_CONTINUOUS | ES_SYSTEM_REQUIRED, written as a decimal (PowerShell 5.1 reads 0x80000001 as a negative Int32). */
export const AWAKE_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  'Add-Type -Namespace NexoServer -Name Power -MemberDefinition \'[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint esFlags);\'',
  "if ([NexoServer.Power]::SetThreadExecutionState([uint32]2147483649) -eq 0) { [Console]::Error.WriteLine('SetThreadExecutionState failed'); exit 1 }",
  // Block until our parent closes stdin (stop() or its death); the request ends with this thread.
  'while ($null -ne [Console]::In.ReadLine()) { }',
].join('\n')

export function awakeCommand(platform: NodeJS.Platform, env: NodeJS.ProcessEnv = process.env): [string, string[]] | null {
  if (platform === 'win32') return [powershellExe(env), powershellArgs(AWAKE_SCRIPT)]
  if (platform === 'linux') {
    return ['systemd-inhibit', ['--what=sleep', '--who=Nexo Server', '--why=Friends are connected', '--mode=block', 'cat']]
  }
  return null
}

export interface AwakeOptions {
  log: (line: string) => void
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
  spawn?: SpawnFn
  /** Keep the PC awake this long after the last friend left (reconnects, map changes). Default 60 s. */
  graceMs?: number
  /** Give up after this many unexpected exits of the helper. Default 3. */
  maxFailures?: number
  now?: () => number
}

export interface Awake {
  /** Call on every status tick with the number of connected people. */
  update(online: number): void
  /** Lets the PC sleep again and stops for good (shutdown). Safe to call twice. */
  stop(): void
  /** The helper is running (the PC is being kept awake). */
  readonly active: boolean
}

export function createAwake(opts: AwakeOptions): Awake {
  const platform = opts.platform ?? process.platform
  const spawn = opts.spawn ?? (nodeSpawn as SpawnFn)
  const graceMs = opts.graceMs ?? 60_000
  const maxFailures = opts.maxFailures ?? 3
  const now = opts.now ?? Date.now
  const command = awakeCommand(platform, opts.env)
  const what = platform === 'win32' ? 'Windows' : 'the system'

  let child: ChildProcess | null = null
  let disabled = command === null
  let failures = 0
  let lastOnline = -Infinity
  const expected = new WeakSet<ChildProcess>()

  function giveUp(reason: string) {
    if (disabled) return
    disabled = true
    opts.log(`Couldn't ask ${what} to stay awake while friends are connected (${reason}). The server keeps running; check your sleep settings.`)
  }

  function start() {
    if (disabled || child || !command) return
    let proc: ChildProcess
    try {
      proc = spawn(command[0], command[1], { stdio: ['pipe', 'ignore', 'pipe'], windowsHide: true })
    } catch (err) {
      giveUp((err as Error).message)
      return
    }
    child = proc
    let stderr = ''
    proc.stderr?.on('data', (c: Buffer) => {
      if (stderr.length < 400) stderr += c.toString()
    })
    proc.stdin?.on('error', () => {}) // EPIPE when it already exited
    proc.once('error', (err: NodeJS.ErrnoException) => {
      if (child === proc) child = null
      expected.add(proc)
      giveUp(err.code === 'ENOENT' ? `${command[0]} not found` : err.message)
    })
    proc.once('exit', (code, signal) => {
      if (child === proc) child = null
      if (expected.has(proc)) return
      failures++
      const why = stderr.trim().split(/\r?\n/).pop() || (signal ? `signal ${signal}` : `exit code ${code}`)
      if (failures >= maxFailures) giveUp(why)
    })
    opts.log('Friends are connected: keeping this PC awake.')
  }

  function release(logIt: boolean) {
    const proc = child
    if (!proc) return
    child = null
    expected.add(proc)
    proc.stdin?.end()
    proc.kill()
    if (logIt) opts.log('Everyone left: this PC may sleep again.')
  }

  return {
    update(online) {
      if (online > 0) {
        lastOnline = now()
        start()
      } else if (child && now() - lastOnline >= graceMs) release(true)
    },
    stop() {
      release(false)
      disabled = true
    },
    get active() {
      return child !== null
    },
  }
}
