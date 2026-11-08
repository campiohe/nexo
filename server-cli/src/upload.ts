// "PC upload" for the status line (docs/SPEC-SERVER-CLI.md §7: upload is the host's limit).
//
// Source: the OS network counters, not LiveKit. LiveKit 1.13's Prometheus endpoint has per-direction
// byte counters, but it listens on every `bind_addresses` entry (pkg/service/server.go: one listener per
// address, like signaling), so on a normal host it would be a new port open to the network. The OS
// counters need no port and include everything the PC sends; hence the "PC upload" label.
//
// - Linux: /proc/net/dev, read on each tick.
// - Windows: one long-lived Windows PowerShell child printing .NET NetworkInterface byte counters (64-bit)
//   every 2 s. It exits when its stdout pipe breaks (this process died) and is also in libuv's job object.
//
// The rate is the busiest adapter's, not the sum: traffic through a tunnel (Tailscale, WSL/Hyper-V
// switches) shows up on the virtual adapter and again on the physical one, and summing would double it.
import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
import type { SpawnFn } from './awake.ts'
import { powershellArgs, powershellExe } from './powershell.ts'

/** Bytes sent per network adapter. */
export type Counters = Map<string, number>

/** Transmit bytes per interface from /proc/net/dev (loopback excluded). */
export function parseProcNetDev(text: string): Counters {
  const out: Counters = new Map()
  for (const line of text.split('\n')) {
    const colon = line.indexOf(':')
    if (colon < 0) continue
    const name = line.slice(0, colon).trim()
    const fields = line.slice(colon + 1).trim().split(/\s+/)
    // receive: bytes packets errs drop fifo frame compressed multicast | transmit: bytes …
    if (!name || name === 'lo' || fields.length < 16) continue
    const tx = Number(fields[8])
    if (Number.isFinite(tx)) out.set(name, tx)
  }
  return out
}

/** Prints `S <adapter id> <bytes sent>` per adapter, then `E`, every 2 s. */
export const WINDOWS_SAMPLER_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  'try {',
  '  while ($true) {',
  '    $lines = @()',
  '    foreach ($n in [System.Net.NetworkInformation.NetworkInterface]::GetAllNetworkInterfaces()) {',
  "      if ($n.OperationalStatus -ne 'Up' -or $n.NetworkInterfaceType -eq 'Loopback') { continue }",
  '      try { $lines += "S $($n.Id) $($n.GetIPStatistics().BytesSent)" } catch { }',
  '    }',
  "    $lines += 'E'",
  '    [Console]::Out.Write(($lines -join "`n") + "`n")',
  '    [Console]::Out.Flush()',
  '    Start-Sleep -Seconds 2',
  '  }',
  '} catch { exit 0 }', // stdout closed: our parent is gone
].join('\n')

/** Turns successive counter samples into Mbit/s. */
export class RateMeter {
  private prev: { at: number; counters: Counters } | null = null

  /**
   * Adds a sample taken at `atMs` and returns the upload since the previous one in Mbit/s: the busiest
   * adapter's. Adapters that are new or whose counter went backwards (reset, driver reload) are skipped.
   * Undefined for the first sample, or when no adapter can be compared.
   */
  push(counters: Counters, atMs: number): number | undefined {
    const prev = this.prev
    this.prev = { at: atMs, counters }
    if (!prev) return undefined
    const seconds = (atMs - prev.at) / 1000
    if (!(seconds > 0)) return undefined
    let best: number | undefined
    for (const [name, bytes] of counters) {
      const before = prev.counters.get(name)
      if (before === undefined || bytes < before) continue
      best = Math.max(best ?? 0, bytes - before)
    }
    return best === undefined ? undefined : (best * 8) / seconds / 1e6
  }
}

export interface UploadMeter {
  /** Current PC upload in Mbit/s, or undefined when unknown. */
  mbps(): number | undefined
  stop(): void
}

export interface UploadMeterOptions {
  log: (line: string) => void
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
  spawn?: SpawnFn
  readProcNetDev?: () => string
  now?: () => number
  /** Windows samples older than this are not shown. Default 10 s. */
  maxAgeMs?: number
}

export function startUploadMeter(opts: UploadMeterOptions): UploadMeter {
  const platform = opts.platform ?? process.platform
  const now = opts.now ?? Date.now
  const meter = new RateMeter()

  if (platform === 'linux') {
    const read = opts.readProcNetDev ?? (() => readFileSync('/proc/net/dev', 'utf8'))
    let failed = false
    return {
      mbps() {
        if (failed) return undefined
        try {
          return meter.push(parseProcNetDev(read()), now())
        } catch (err) {
          failed = true
          opts.log(`Can't measure upload: ${(err as Error).message}`)
          return undefined
        }
      },
      stop() {},
    }
  }
  if (platform !== 'win32') return { mbps: () => undefined, stop() {} }

  const spawn = opts.spawn ?? (nodeSpawn as SpawnFn)
  const maxAge = opts.maxAgeMs ?? 10_000
  let last: { mbps: number; at: number } | null = null
  let stopped = false
  let child: ChildProcess | null = null
  try {
    child = spawn(powershellExe(opts.env), powershellArgs(WINDOWS_SAMPLER_SCRIPT), { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true })
  } catch (err) {
    opts.log(`Can't measure upload (${(err as Error).message}); the status line won't show it.`)
  }
  if (child) {
    const proc = child
    let sample: Counters = new Map()
    if (proc.stdout) {
      createInterface({ input: proc.stdout, crlfDelay: Infinity }).on('line', (line) => {
        const m = /^S (\S+) (\d+)$/.exec(line.trim())
        if (m) sample.set(m[1]!, Number(m[2]))
        else if (line.trim() === 'E') {
          const at = now()
          const r = meter.push(sample, at)
          if (r !== undefined) last = { mbps: r, at }
          sample = new Map()
        }
      })
    }
    proc.once('error', (err: NodeJS.ErrnoException) => {
      if (!stopped) opts.log(`Can't measure upload (${err.code === 'ENOENT' ? 'PowerShell not found' : err.message}); the status line won't show it.`)
    })
    proc.once('exit', (code) => {
      child = null
      if (!stopped && proc.pid !== undefined) opts.log(`Upload measurement stopped (exit code ${code}); the status line won't show it.`)
    })
  }
  return {
    mbps: () => (last && now() - last.at <= maxAge ? last.mbps : undefined),
    stop() {
      stopped = true
      child?.kill()
      child = null
    },
  }
}

/**
 * The §7 warning: upload above 80% of the host's `uploadLimitMbps` (config.json). Returns 'warn' once when
 * it crosses 80%, 'ok' once when it drops back under 60% (hysteresis, so it doesn't flap), else null.
 */
export function uploadLimitCheck(state: { warned: boolean }, mbps: number | undefined, limitMbps: number | undefined): 'warn' | 'ok' | null {
  if (mbps === undefined || !limitMbps) return null
  if (!state.warned && mbps > 0.8 * limitMbps) {
    state.warned = true
    return 'warn'
  }
  if (state.warned && mbps < 0.6 * limitMbps) {
    state.warned = false
    return 'ok'
  }
  return null
}
