// One running nexo-media process: spawn, JSON-lines stdio, command ids with timeouts, exit detection.
// Node only (no Electron imports), so it can be driven against the fake helper from a plain script.
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { encodeCommand, LineSplitter, parseHelperEvent, redactCommand, redactText } from './codec'
import { NativeShareFailure } from './mapping'
import type { HelperCommand, HelperCommandType, HelperEvent } from './protocol'

export interface LaunchSpec {
  command: string
  args: string[]
  env?: NodeJS.ProcessEnv
  /** For log lines, e.g. the exe path. */
  label: string
}

export type Logger = Pick<Console, 'debug' | 'info' | 'warn' | 'error'>

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never
export type CommandBody = DistributiveOmit<HelperCommand, 'id'>
export type ResultOk = Extract<HelperEvent, { type: 'result'; ok: true }>
export type AsyncHelperEvent = Exclude<HelperEvent, { type: 'result' }>

export interface ExitInfo {
  code: number | null
  signal: NodeJS.Signals | null
  /** Main asked for it (shutdown, kill, release). Anything else is a crash. */
  expected: boolean
  /** The process never started (ENOENT, EACCES, …). */
  spawnError?: Error
  /** It was killed because a command went unanswered. */
  hung?: string
}

export interface HelperProcessOptions {
  onEvent(event: AsyncHelperEvent): void
  /** Called exactly once, before pending commands are rejected. */
  onExit(info: ExitInfo): void
  log: Logger
  /** Print every command/event (token redacted). */
  debug?: boolean
  /** Strings to scrub from anything the helper prints (the LiveKit token in use). */
  secrets?: () => Iterable<string>
}

/** SPEC-BETA §6 timeouts: `start` may wait for the encoder and the first connect. */
export const COMMAND_TIMEOUTS_MS: Record<HelperCommandType, number> = {
  hello: 5_000,
  start: 15_000,
  update: 5_000,
  stop: 5_000,
  shutdown: 5_000,
}

/** Command ids are unique for the app's lifetime, across helper restarts. */
let nextCommandId = 1

export interface SendOptions {
  timeoutMs?: number
  /**
   * Called synchronously when the `ok` result is read, before any event on the lines after it is dispatched
   * (the promise resolves a microtask later, after the rest of that stdout chunk was handled).
   */
  onOk?(result: ResultOk): void
}

interface Pending {
  type: HelperCommandType
  onOk?(result: ResultOk): void
  resolve(result: ResultOk): void
  reject(err: Error): void
  timer: NodeJS.Timeout
}

/** After 'exit', give stdout this long to drain ('close') before finalizing anyway. */
const CLOSE_GRACE_MS = 1_000

export class HelperProcess {
  readonly pid: number | undefined
  private readonly child: ChildProcessWithoutNullStreams
  private readonly pending = new Map<number, Pending>()
  private finished = false
  private expected = false
  private hung: string | undefined
  private spawnError: Error | undefined
  private exitWaiters: (() => void)[] = []

  constructor(
    readonly spec: LaunchSpec,
    private readonly opts: HelperProcessOptions,
  ) {
    const child = spawn(spec.command, spec.args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env: spec.env })
    this.child = child
    this.pid = child.pid

    const stdout = new LineSplitter(
      (line) => this.onLine(line),
      () => opts.log.warn('[nexo-media] dropped an oversized stdout line'),
    )
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => stdout.push(chunk))

    const stderr = new LineSplitter((line) => opts.log.warn(`[nexo-media:stderr] ${this.scrub(line)}`))
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => stderr.push(chunk))

    // EPIPE after the helper died: the exit path reports it.
    child.stdin.on('error', (err) => opts.log.debug?.('[nexo-media] stdin:', err.message))

    child.on('error', (err) => {
      if (this.child.pid === undefined) {
        this.spawnError = err
        this.finish(null, null)
      } else {
        opts.log.warn('[nexo-media] process error:', err.message)
      }
    })
    child.on('exit', (code, signal) => {
      setTimeout(() => this.finish(code, signal), CLOSE_GRACE_MS).unref()
    })
    child.on('close', (code, signal) => this.finish(code, signal))
  }

  get alive(): boolean {
    return !this.finished
  }

  /** Sends a command and resolves with its `ok` result; rejects with a NativeShareFailure. */
  send(body: CommandBody, opts: SendOptions = {}): Promise<ResultOk> {
    const timeoutMs = opts.timeoutMs ?? COMMAND_TIMEOUTS_MS[body.type]
    if (this.finished) return Promise.reject(new NativeShareFailure('helper-crashed', 'nexo-media is not running'))
    const id = nextCommandId++
    const cmd = { ...body, id } as HelperCommand
    if (this.opts.debug) this.opts.log.debug(`[nexo-media] → ${JSON.stringify(redactCommand(cmd))}`)
    return new Promise<ResultOk>((resolve, reject) => {
      const timer = setTimeout(() => {
        // A helper that stops answering is treated like a crash (SPEC-BETA §4.1): kill it, and the exit
        // path rejects every pending command, this one included.
        if (!this.pending.has(id)) return
        this.hung = `"${cmd.type}" went unanswered for ${timeoutMs / 1000} s`
        this.opts.log.warn(`[nexo-media] ${this.hung}; killing the helper`)
        this.child.kill()
      }, timeoutMs)
      this.pending.set(id, { type: cmd.type, onOk: opts.onOk, resolve, reject, timer })
      this.child.stdin.write(encodeCommand(cmd))
    })
  }

  /** Asks the helper to exit (shutdown + stdin EOF), kills it after `graceMs`. Resolves once it's gone. */
  async shutdown(graceMs = 2_000): Promise<void> {
    if (this.finished) return
    this.expected = true
    const gone = this.waitForExit()
    this.send({ type: 'shutdown' }, { timeoutMs: graceMs }).catch(() => {})
    this.child.stdin.end()
    const timer = setTimeout(() => this.child.kill(), graceMs)
    await gone
    clearTimeout(timer)
  }

  /** Immediate, expected termination. */
  kill(): void {
    if (this.finished) return
    this.expected = true
    this.child.stdin.end()
    this.child.kill()
  }

  waitForExit(): Promise<void> {
    if (this.finished) return Promise.resolve()
    return new Promise((resolve) => this.exitWaiters.push(resolve))
  }

  private scrub(text: string): string {
    return this.opts.secrets ? redactText(text, this.opts.secrets()) : text
  }

  private onLine(line: string): void {
    const parsed = parseHelperEvent(line)
    if (!parsed.ok) {
      this.opts.log.warn(`[nexo-media] ignored malformed line (${parsed.error}): ${this.scrub(line.slice(0, 200))}`)
      return
    }
    const event = parsed.event
    if (this.opts.debug && event.type !== 'log') this.opts.log.debug(`[nexo-media] ← ${this.scrub(line.slice(0, 500))}`)
    if (event.type !== 'result') {
      this.opts.onEvent(event)
      return
    }
    const p = this.pending.get(event.id)
    if (!p) {
      this.opts.log.warn(`[nexo-media] result for unknown command id ${event.id}`)
      return
    }
    this.pending.delete(event.id)
    clearTimeout(p.timer)
    if (event.ok) {
      try {
        p.onOk?.(event)
      } catch (err) {
        this.opts.log.error('[nexo-media] result handler failed:', err)
      }
      p.resolve(event)
    } else p.reject(new NativeShareFailure(event.error.code, this.scrub(event.error.message)))
  }

  private finish(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.finished) return
    this.finished = true
    const info: ExitInfo = { code, signal, expected: this.expected }
    if (this.spawnError) info.spawnError = this.spawnError
    if (this.hung) info.hung = this.hung
    this.opts.onExit(info)

    const failure = this.spawnError
      ? new NativeShareFailure('helper-unavailable', `Could not start nexo-media: ${this.spawnError.message}`)
      : this.hung
        ? new NativeShareFailure('helper-crashed', `nexo-media stopped responding (${this.hung})`)
        : new NativeShareFailure('helper-crashed', `nexo-media exited (${signal ?? `code ${code}`})`)
    for (const p of this.pending.values()) {
      clearTimeout(p.timer)
      p.reject(failure)
    }
    this.pending.clear()
    for (const w of this.exitWaiters) w()
    this.exitWaiters = []
  }
}
