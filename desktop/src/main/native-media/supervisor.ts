// Supervises the native helper nexo-media.exe (docs/SPEC-BETA.md §4.1, §6, §8.1): lazy spawn, `hello` +
// capabilities cache, one share at a time, the crash policy, and helper → bridge event mapping.
//
// No Electron imports: everything Electron-specific (exe path, IPC, windows, source translation) is injected
// through SupervisorDeps by ./index.ts. That keeps this file drivable from a plain Node script against
// desktop/scripts/fake-nexo-media.mjs.
//
// Every share main accepts gets the next `shareId` (1, 2, … for the app session); start() resolves with it and
// every bridge event of that share carries it, so the renderer can tell a late event of an earlier share apart.
//
// Helper events are attributed to the share only once the helper answered its `start` (the helper writes that
// result before any event of the new share, SPEC-BETA §6). Anything before it is the tail of an earlier share
// (e.g. a `stop` that timed out on the helper side) and is dropped.
//
// Bridge events (NativeShareEvent) for one share, in order:
//   state 'starting'                         main accepted the request (before the helper answered)
//   state 'connecting' | 'live' | …          forwarded from the helper (+ stats at 1 Hz while active)
//   state 'reconnecting'                     also sent by main while it restarts a crashed helper
//   error {…}                                async failures; they don't end the share by themselves. A failure
//                                            that ends the share comes right before its `ended`
//   ended {reason}                           exactly once per share that the helper accepted
//   state 'idle'                             last event of every share, including a failed start
// A failed start() rejects (no `error`/`ended` events, only `state: 'idle'`).
import type { NativeShareCapabilities, NativeShareEndReason, NativeShareEvent } from '../../preload/api'
import { redactText } from './codec'
import { HelperProcess, type AsyncHelperEvent, type ExitInfo, type LaunchSpec, type Logger } from './helper-process'
import {
  fallbackFor,
  NativeShareFailure,
  toBridgeCapabilities,
  toBridgeStats,
  unavailableCapabilities,
} from './mapping'
import {
  PROTOCOL_VERSION,
  type HelperAudioMode,
  type HelperCapabilities,
  type HelperPreset,
  type HelperSource,
} from './protocol'

export interface StartRequest {
  source: HelperSource
  preset: HelperPreset
  cursor: boolean
  audio: HelperAudioMode
  excludePid: number
  livekit: { url: string; token: string }
  /** Keep Nexo's windows out of the capture. Only honoured for monitor sources. */
  hideNexo: boolean
}

export interface UpdateRequest {
  preset?: Partial<HelperPreset>
  cursor?: boolean
}

export type LaunchResult = { ok: true; spec: LaunchSpec } | { ok: false; reason: string }

export interface SupervisorDeps {
  /** How to run the helper; called on every spawn. `ok: false` → helper-unavailable for the session. */
  resolveLaunch(): LaunchResult
  /** Native capture can work here at all (Windows, or the fake helper). */
  osSupported: boolean
  /** Not on this OS: the user-readable reason (e.g. "only available on Windows"). */
  osReason?: string
  emit(event: NativeShareEvent): void
  /** true: exclude Nexo's windows from screen capture; false: undo. Called with false on every end path. */
  setHideNexo(on: boolean): void
  log?: Logger
  /** Print every command and event (token redacted). */
  debug?: boolean
  now?: () => number
  /** Two unexpected exits within this window disable native sharing for the session. Default 60 s. */
  crashWindowMs?: number
  /** Grace period for `shutdown` before the helper is killed. Default 2 s. */
  shutdownGraceMs?: number
}

interface Share {
  /** NativeShareEvent.shareId */
  id: number
  req: StartRequest
  /** setHideNexo(true) was applied for this share. */
  hideNexo: boolean
  /** The helper answered `start` with ok (directly or after a restart). */
  accepted: boolean
  stopping: boolean
  /** The in-flight start or resume; stop() waits for it. */
  busy: Promise<void>
}

const CRASH_WINDOW_MS = 60_000
const MAX_REMEMBERED_TOKENS = 4

export class NativeShareSupervisor {
  private proc: HelperProcess | null = null
  /** Spawn + hello in flight or done, for `proc`. */
  private ready: Promise<HelperProcess> | null = null
  /** From the last successful hello; kept for the session (capabilities don't change while running). */
  private caps: HelperCapabilities | null = null
  /** Set once native sharing can't work this session (missing exe, spawn failure, crashed twice, …). */
  private disabledReason: string | null = null
  private lastCrashAt: number | null = null
  private share: Share | null = null
  private nextShareId = 1
  /** Tokens sent to the helper recently, scrubbed from anything it prints. */
  private tokens: string[] = []
  private readonly log: Logger
  private readonly now: () => number

  constructor(private readonly deps: SupervisorDeps) {
    this.log = deps.log ?? console
    this.now = deps.now ?? Date.now
  }

  // ── Public API (mirrors NexoBridge.nativeShare) ────────────────────────────────────────────────────

  async capabilities(): Promise<NativeShareCapabilities> {
    if (!this.deps.osSupported) return unavailableCapabilities(this.deps.osReason ?? 'Native capture is not available here')
    if (this.disabledReason) return unavailableCapabilities(this.disabledReason)
    if (!this.caps) {
      try {
        await this.ensureHelper()
      } catch (err) {
        return unavailableCapabilities(err instanceof Error ? err.message : String(err))
      }
    }
    return this.caps ? toBridgeCapabilities(this.caps, true) : unavailableCapabilities('nexo-media did not report its capabilities')
  }

  /** Resolves once the helper accepted the share, with the id its events carry. Rejects with a NativeShareFailure. */
  async start(req: StartRequest): Promise<{ shareId: number }> {
    if (this.share) throw new NativeShareFailure('busy', 'A native share is already running')
    if (!this.deps.osSupported)
      throw new NativeShareFailure('helper-unavailable', this.deps.osReason ?? 'Native capture is not available here')
    if (this.disabledReason) throw new NativeShareFailure('helper-unavailable', this.disabledReason)

    const share: Share = {
      id: this.nextShareId++,
      req: cloneRequest(req),
      hideNexo: false,
      accepted: false,
      stopping: false,
      busy: Promise.resolve(),
    }
    this.share = share
    this.rememberToken(req.livekit.token)
    this.emit(share, { type: 'state', state: 'starting' })
    if (req.hideNexo && req.source.kind === 'monitor') {
      share.hideNexo = true
      this.applyHideNexo(true)
    }
    const run = this.runStart(share)
    share.busy = run.then(
      () => {},
      () => {},
    )
    await run
    return { shareId: share.id }
  }

  /** Live bitrate/fps/contentHint/cursor changes. No-op without an active share. */
  async update(patch: UpdateRequest): Promise<void> {
    const share = this.share
    if (!share || !share.accepted || share.stopping) return
    // The output size is fixed for a share (SPEC-BETA §6): an unchanged size is dropped, a new one refused.
    const preset = patch.preset ? { ...patch.preset } : undefined
    if (preset) {
      for (const key of ['width', 'height'] as const) {
        if (preset[key] === undefined) continue
        if (preset[key] !== share.req.preset[key])
          throw new NativeShareFailure('internal', 'The output size cannot change during a share: stop and start it again')
        delete preset[key]
      }
    }
    if (preset) Object.assign(share.req.preset, preset)
    if (patch.cursor !== undefined) share.req.cursor = patch.cursor
    const proc = this.proc
    if (!proc?.alive) return // restarting: the resumed start uses the merged request above
    const body: UpdateRequest = {}
    if (preset && Object.keys(preset).length > 0) body.preset = preset
    if (patch.cursor !== undefined) body.cursor = patch.cursor
    if (body.preset || body.cursor !== undefined) await proc.send({ type: 'update', ...body })
  }

  /** Stops the active share (no-op when none). Never rejects. */
  async stop(): Promise<void> {
    const share = this.share
    if (!share) return
    share.stopping = true
    await share.busy
    if (this.share !== share) return
    if (!share.accepted) {
      // Stopped before the helper took it (runStart bailed out): nothing to stop, nothing ended.
      this.clearShare(share)
      this.emit(share, { type: 'state', state: 'idle' })
      return
    }
    const proc = this.proc
    if (proc?.alive) {
      try {
        await proc.send({ type: 'stop' })
      } catch (err) {
        this.log.warn('[nexo-media] stop failed:', err instanceof Error ? err.message : err)
      }
    }
    this.endShare(share, 'stopped') // no-op if the helper already reported `ended`
  }

  /** Stops any share and shuts the helper down (leaving voice, window closed). Never rejects. */
  async release(): Promise<void> {
    await this.stop()
    const proc = this.proc
    if (proc) await proc.shutdown(this.deps.shutdownGraceMs ?? 2_000)
  }

  /** Synchronous last resort (app quit): restore content protection and kill the helper. */
  dispose(): void {
    const share = this.share
    if (share) {
      share.stopping = true
      this.clearShare(share)
    }
    this.proc?.kill()
  }

  get running(): boolean {
    return !!this.proc?.alive
  }

  get sharing(): boolean {
    return !!this.share
  }

  // ── Helper process ─────────────────────────────────────────────────────────────────────────────────

  private ensureHelper(): Promise<HelperProcess> {
    if (this.disabledReason) return Promise.reject(new NativeShareFailure('helper-unavailable', this.disabledReason))
    if (!this.ready) {
      const ready = this.spawnAndHello()
      this.ready = ready
      ready.catch(() => {
        if (this.ready === ready) this.ready = null
      })
    }
    return this.ready
  }

  private async spawnAndHello(): Promise<HelperProcess> {
    const launch = this.deps.resolveLaunch()
    if (!launch.ok) {
      this.disabledReason = launch.reason
      this.log.warn(`[nexo-media] unavailable: ${launch.reason}`)
      throw new NativeShareFailure('helper-unavailable', launch.reason)
    }
    const proc: HelperProcess = new HelperProcess(launch.spec, {
      onEvent: (event) => this.onEvent(proc, event),
      onExit: (info) => this.onExit(proc, info),
      log: this.log,
      debug: this.deps.debug,
      secrets: () => this.tokens,
    })
    this.proc = proc
    this.log.info(`[nexo-media] started ${launch.spec.label} (pid ${proc.pid ?? '?'})`)

    const result = await proc.send({ type: 'hello', protocol: PROTOCOL_VERSION })
    const caps = result.capabilities
    if (!caps) {
      proc.kill()
      throw new NativeShareFailure('protocol', 'nexo-media answered hello without capabilities')
    }
    this.caps = caps
    if (caps.protocol !== PROTOCOL_VERSION) {
      const reason = toBridgeCapabilities(caps, true).reason ?? 'protocol mismatch'
      this.disabledReason = reason
      proc.kill()
      throw new NativeShareFailure('protocol', reason)
    }
    const enc = caps.encoder ? `${caps.encoder.name}` : 'no hardware encoder'
    this.log.info(`[nexo-media] v${caps.version}, Windows build ${caps.osBuild}, ${caps.adapter?.name ?? 'no adapter'}, ${enc}`)
    return proc
  }

  private onExit(proc: HelperProcess, info: ExitInfo): void {
    if (proc !== this.proc) return
    this.proc = null
    this.ready = null
    const share = this.share

    if (info.spawnError) {
      this.disabledReason = `Could not start nexo-media: ${info.spawnError.message}`
      this.log.warn(`[nexo-media] ${this.disabledReason}`)
      return // a pending start/hello is rejected with helper-unavailable by HelperProcess
    }
    if (info.expected) {
      this.log.info('[nexo-media] exited')
      if (share && share.accepted) this.endShare(share, 'stopped')
      return
    }

    const how = info.hung ?? (info.signal ? `signal ${info.signal}` : `code ${info.code}`)
    this.log.warn(`[nexo-media] exited unexpectedly (${how})`)
    const now = this.now()
    const repeat = this.lastCrashAt !== null && now - this.lastCrashAt < (this.deps.crashWindowMs ?? CRASH_WINDOW_MS)
    this.lastCrashAt = now
    if (repeat) {
      this.disabledReason = 'Native capture was turned off after nexo-media crashed twice. Restart Nexo to try again.'
      this.log.warn('[nexo-media] second crash within the window: native sharing disabled for this session')
    }
    if (!share) return
    if (share.stopping) {
      this.endShare(share, 'stopped')
      return
    }
    if (repeat) {
      this.failShare(share, new NativeShareFailure('helper-crashed', 'nexo-media crashed twice; switching to the Chromium engine'), 'crashed')
      return
    }
    // Not yet accepted: runStart() sees the rejected `start` and retries it itself.
    if (share.accepted) share.busy = this.resume(share)
  }

  private onEvent(proc: HelperProcess, event: AsyncHelperEvent): void {
    if (proc !== this.proc) return
    // Not answered `start` yet: a share event now belongs to an earlier share (see the header).
    const share = this.share?.accepted ? this.share : null
    switch (event.type) {
      case 'log': {
        if (event.level === 'debug' && !this.deps.debug) return
        const line = `[nexo-media] ${redactText(event.message, this.tokens)}`
        if (event.level === 'error') this.log.error(line)
        else if (event.level === 'warn') this.log.warn(line)
        else if (event.level === 'info') this.log.info(line)
        else this.log.debug(line)
        return
      }
      case 'state':
        if (share) this.emit(share, { type: 'state', state: event.state })
        else this.log.debug(`[nexo-media] state ${event.state} without an active share`)
        return
      case 'stats':
        if (share) this.emit(share, { type: 'stats', stats: toBridgeStats(event.stats) })
        return
      case 'ended':
        if (share) this.endShare(share, event.reason)
        else this.log.debug(`[nexo-media] ended (${event.reason}) without an active share`)
        return
      case 'error': {
        const message = redactText(event.message, this.tokens)
        if (share) this.emit(share, { type: 'error', error: { code: event.code, message, fallback: fallbackFor(event.code) } })
        else this.log.warn(`[nexo-media] error without an active share: ${event.code}: ${message}`)
        return
      }
    }
  }

  // ── Share lifecycle ────────────────────────────────────────────────────────────────────────────────

  private async runStart(share: Share): Promise<void> {
    let retried = false
    for (;;) {
      try {
        const proc = await this.ensureHelper()
        if (this.share !== share || share.stopping) return
        if (!this.caps?.encoder) {
          const reason = this.caps ? toBridgeCapabilities(this.caps, true).reason : undefined
          throw new NativeShareFailure('encoder-unavailable', reason ?? 'No hardware H.264 encoder')
        }
        // Marked from the result line itself: the share's first events can follow it in the same stdout chunk.
        await proc.send(startCommand(share.req), {
          onOk: () => {
            if (this.share === share) share.accepted = true
          },
        })
        return
      } catch (err) {
        const failure =
          err instanceof NativeShareFailure ? err : new NativeShareFailure('internal', err instanceof Error ? err.message : String(err))
        // SPEC-BETA §4.1: a crash during the share restarts the helper once and re-sends `start`.
        if (!retried && failure.code === 'helper-crashed' && this.share === share && !share.stopping && !this.disabledReason) {
          retried = true
          this.log.warn('[nexo-media] crashed while starting; restarting it once')
          continue
        }
        const final =
          failure.code === 'helper-crashed' && this.disabledReason
            ? new NativeShareFailure('helper-crashed', 'nexo-media crashed twice; switching to the Chromium engine')
            : failure
        if (this.share === share) this.failShare(share, final, 'error')
        throw final
      }
    }
  }

  /** First crash while live: restart the helper and re-send the (latest) start. */
  private async resume(share: Share): Promise<void> {
    this.log.warn('[nexo-media] restarting the helper and resuming the share')
    this.emit(share, { type: 'state', state: 'reconnecting' })
    try {
      const proc = await this.ensureHelper()
      if (this.share !== share || share.stopping) return
      await proc.send(startCommand(share.req))
      this.log.info('[nexo-media] share resumed')
    } catch (err) {
      if (this.share !== share) return // a second crash already failed it (onExit)
      if (share.stopping) {
        this.endShare(share, 'stopped')
        return
      }
      const failure =
        err instanceof NativeShareFailure ? err : new NativeShareFailure('internal', err instanceof Error ? err.message : String(err))
      this.failShare(share, failure, 'crashed')
    }
  }

  /** Normal end: the helper reported `ended`, or stop() finished. */
  private endShare(share: Share, reason: NativeShareEndReason): void {
    if (this.share !== share) return
    this.clearShare(share)
    this.emit(share, { type: 'ended', reason })
    this.emit(share, { type: 'state', state: 'idle' })
  }

  /** Failure end. A share the helper never accepted only gets `idle`: its start() rejection carries the error. */
  private failShare(share: Share, failure: NativeShareFailure, reason: NativeShareEndReason): void {
    if (this.share !== share) return
    this.clearShare(share)
    if (share.accepted) {
      this.emit(share, { type: 'error', error: failure.toJSON() })
      this.emit(share, { type: 'ended', reason })
    }
    this.emit(share, { type: 'state', state: 'idle' })
  }

  private emit(share: Share, event: DistributiveOmit<NativeShareEvent, 'shareId'>): void {
    this.deps.emit({ ...event, shareId: share.id } as NativeShareEvent)
  }

  private clearShare(share: Share): void {
    if (this.share === share) this.share = null
    if (share.hideNexo) {
      share.hideNexo = false
      this.applyHideNexo(false)
    }
  }

  private applyHideNexo(on: boolean): void {
    try {
      this.deps.setHideNexo(on)
    } catch (err) {
      this.log.warn('[nexo-media] content protection change failed:', err)
    }
  }

  private rememberToken(token: string): void {
    this.tokens = [token, ...this.tokens.filter((t) => t !== token)].slice(0, MAX_REMEMBERED_TOKENS)
  }
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never

function startCommand(req: StartRequest) {
  return {
    type: 'start' as const,
    source: req.source,
    preset: { ...req.preset },
    cursor: req.cursor,
    audio: req.audio,
    excludePid: req.excludePid,
    livekit: { url: req.livekit.url, token: req.livekit.token },
  }
}

function cloneRequest(req: StartRequest): StartRequest {
  return {
    ...req,
    source: req.source.kind === 'window' ? { ...req.source } : { kind: 'monitor', rect: { ...req.source.rect } },
    preset: { ...req.preset },
    livekit: { ...req.livekit },
  }
}
