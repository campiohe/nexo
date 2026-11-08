// The live status line (spec §3.1) and the `status` command (spec §3.3).
//
// `status` runs in a separate process from the server, so it reads what the running instance wrote in
// its lock file (PID, ports, start time, live counts) and asks the server's /health endpoint.

import { readLock, isProcessAlive, type LockInfo } from './instance.ts'
import { symbols } from './invite.ts'

export interface LiveStats {
  online: number
  inVoice: number
  streaming: number
  /** The PC's upload in Mbit/s (busiest network adapter, src/upload.ts), when measured. */
  uploadMbps?: number
}

/** `3 online · 2 in voice · 1 streaming · PC upload 9.4 Mbit/s`; zero voice/streaming parts are left out. */
export function statusLine(s: LiveStats, opts: { ascii?: boolean } = {}): string {
  const parts = [`${s.online} online`]
  if (s.inVoice > 0) parts.push(`${s.inVoice} in voice`)
  if (s.streaming > 0) parts.push(`${s.streaming} streaming`)
  if (s.uploadMbps !== undefined && Number.isFinite(s.uploadMbps)) parts.push(`PC upload ${s.uploadMbps.toFixed(1)} Mbit/s`)
  return parts.join(` ${symbols(opts.ascii ?? false).dot} `)
}

/**
 * Whether the live status is worth printing again: any count changed, upload appeared/disappeared, or it
 * moved by at least 25% and 1 Mbit/s since the last printed line (so small jitter doesn't scroll the console).
 */
export function statusChanged(printed: LiveStats | null, next: LiveStats): boolean {
  if (!printed) return true
  if (printed.online !== next.online || printed.inVoice !== next.inVoice || printed.streaming !== next.streaming) return true
  const a = printed.uploadMbps
  const b = next.uploadMbps
  if (a === undefined || b === undefined) return a !== b
  return Math.abs(a - b) >= Math.max(1, 0.25 * a)
}

export interface HealthResult {
  ok: boolean
  name?: string
  error?: string
}

/** GET http://127.0.0.1:<port>/health with a short timeout. Never throws. */
export async function checkHealth(port: number, timeoutMs = 2000, fetchFn: typeof fetch = fetch): Promise<HealthResult> {
  try {
    const res = await fetchFn(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(timeoutMs) })
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` }
    const body = (await res.json()) as { ok?: boolean; name?: string }
    return { ok: body.ok === true, ...(typeof body.name === 'string' ? { name: body.name } : {}) }
  } catch (err) {
    const e = err as Error & { cause?: { code?: string } }
    return { ok: false, error: e.name === 'TimeoutError' ? 'no answer' : (e.cause?.code ?? e.message) }
  }
}

export type StatusReport =
  | { running: false; staleLock?: LockInfo }
  | { running: true; lock: LockInfo; health: HealthResult }

export interface StatusOptions {
  isAlive?: (pid: number) => boolean
  fetch?: typeof fetch
  timeoutMs?: number
}

/** Whether the server for `dataDir` is running, from its lock file and /health. */
export async function getStatus(dataDir: string, opts: StatusOptions = {}): Promise<StatusReport> {
  const lock = readLock(dataDir)
  if (!lock) return { running: false }
  if (!(opts.isAlive ?? isProcessAlive)(lock.pid)) return { running: false, staleLock: lock }
  const health = await checkHealth(lock.ports.http, opts.timeoutMs, opts.fetch)
  return { running: true, lock, health }
}

function formatDuration(ms: number): string {
  const m = Math.max(0, Math.floor(ms / 60000))
  if (m < 60) return `${m} min`
  const h = Math.floor(m / 60)
  if (h < 48) return `${h} h ${m % 60} min`
  return `${Math.floor(h / 24)} days`
}

/** Console lines for `nexo-server status`. */
export function formatStatus(
  report: StatusReport,
  ctx: { dataDir: string; version: string; ascii?: boolean; now?: Date },
): string[] {
  const sym = symbols(ctx.ascii ?? false)
  const lines: string[] = []
  if (!report.running) {
    lines.push(`Nexo Server ${ctx.version}: not running.`)
    if (report.staleLock) lines.push(`(A previous run, PID ${report.staleLock.pid}, did not shut down cleanly; that's fine.)`)
    lines.push(`Data folder: ${ctx.dataDir}`)
    return lines
  }
  const { lock, health } = report
  const up = formatDuration((ctx.now ?? new Date()).getTime() - Date.parse(lock.startedAt))
  lines.push(`Nexo Server ${lock.version}: running (PID ${lock.pid}, up ${up}).`)
  if (lock.version !== ctx.version) lines.push(`Note: this nexo-server is ${ctx.version}; the running one is ${lock.version}.`)
  lines.push(
    health.ok
      ? `${sym.ok} Server answering on port ${lock.ports.http}${health.name ? ` ("${health.name}")` : ''}`
      : `${sym.fail} Server not answering on port ${lock.ports.http} (${health.error ?? 'unhealthy'}). It may still be starting.`,
  )
  const p = lock.ports
  lines.push(`  Voice ports: ${p.livekit}, ${p.livekitTcp} (TCP) and ${p.livekitUdp} (UDP)`)
  if (lock.stats) lines.push(`  ${statusLine(lock.stats, { ascii: ctx.ascii })}`)
  lines.push(`Data folder: ${ctx.dataDir}`)
  return lines
}
