// Local interface inspection: LAN addresses and Tailscale detection (SPEC-SERVER-CLI §6 steps 1-2).
import { execFile } from 'node:child_process'
import { networkInterfaces, type NetworkInterfaceInfo } from 'node:os'
import { isCgnatRange, isIpv4, isLinkLocal, isPrivateIp } from './ip.ts'

/** Shape of `os.networkInterfaces()`; injectable for tests. */
export type InterfaceMap = NodeJS.Dict<NetworkInterfaceInfo[]>

// Adapters that carry a private address but are not the host's real LAN: Hyper-V / WSL switches,
// hypervisor host-only networks, container bridges, VPN overlays.
const VIRTUAL_NAME =
  /vEthernet|WSL|Hyper-V|VirtualBox|VMware|vmnet|vboxnet|docker|^br-|^veth|virbr|^lxc|^lxd|^cni|^flannel|^cali|^podman|tailscale|ZeroTier|^zt|Npcap|Loopback/i

const TAILSCALE_NAME = /tailscale|^ts\d/i

function isV4(info: NetworkInterfaceInfo): boolean {
  // Node 18.0-18.3 reported family as a number.
  return info.family === 'IPv4' || (info.family as unknown) === 4
}

function rangeRank(ip: string): number {
  if (ip.startsWith('192.168.')) return 0
  if (ip.startsWith('10.')) return 1
  return 2
}

/**
 * Private IPv4 addresses (10/8, 172.16/12, 192.168/16) of the machine's non-internal interfaces,
 * i.e. what friends in the same house would type. Excludes Tailscale (100.64/10), link-local and
 * loopback. Virtual adapters (WSL/Hyper-V "vEthernet", Docker, VirtualBox, VMware, …) are left out
 * unless they are the only candidates (a Hyper-V external switch *is* the real LAN on some PCs).
 * Ordered 192.168 → 10 → 172.16, then interface order. Deduplicated.
 */
export function lanAddresses(ifaces: InterfaceMap = networkInterfaces()): string[] {
  const real: string[] = []
  const virtual: string[] = []
  for (const [name, infos] of Object.entries(ifaces)) {
    for (const info of infos ?? []) {
      if (!isV4(info) || info.internal) continue
      const ip = info.address
      if (!isIpv4(ip) || !isPrivateIp(ip) || isLinkLocal(ip) || isCgnatRange(ip)) continue
      const bucket = VIRTUAL_NAME.test(name) ? virtual : real
      if (!bucket.includes(ip)) bucket.push(ip)
    }
  }
  const out = real.length > 0 ? real : virtual
  return out
    .map((ip, i) => ({ ip, i }))
    .sort((a, b) => rangeRank(a.ip) - rangeRank(b.ip) || a.i - b.i)
    .map((x) => x.ip)
}

export interface TailscaleInfo {
  ip: string
  source: 'interface' | 'cli'
}

export interface DetectTailscaleOptions {
  /** Defaults to `os.networkInterfaces()`. */
  interfaces?: InterfaceMap
  /** Per-attempt timeout for the `tailscale ip -4` CLI, default 1500 ms. */
  cliTimeoutMs?: number
  /** CLI executables to try, in order. Default: `tailscale` on PATH, plus the standard install path on Windows. */
  cliPaths?: string[]
  /** Set false to skip the CLI fallback. */
  useCli?: boolean
}

function defaultCliPaths(): string[] {
  if (process.platform === 'win32') {
    const pf = process.env.ProgramFiles || 'C:\\Program Files'
    return [...new Set(['tailscale', `${pf}\\Tailscale\\tailscale.exe`, 'C:\\Program Files\\Tailscale\\tailscale.exe'])]
  }
  return ['tailscale']
}

function runTailscaleIp(file: string, timeoutMs: number): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      execFile(
        file,
        ['ip', '-4'],
        { timeout: timeoutMs, windowsHide: true, shell: false, maxBuffer: 64 * 1024 },
        (err, stdout) => {
          if (err) return resolve(null)
          const ip = String(stdout)
            .split(/\r?\n/)
            .map((l) => l.trim())
            .find((l) => isIpv4(l) && isCgnatRange(l))
          resolve(ip ?? null)
        },
      )
    } catch {
      resolve(null)
    }
  })
}

/**
 * Finds this machine's Tailscale IPv4 address.
 *
 * 1. An interface named like Tailscale (`Tailscale` on Windows, `tailscale0` on Linux) with a
 *    100.64.0.0/10 address → `{ source: 'interface' }`.
 * 2. `tailscale ip -4` (no shell, short timeout; on Windows also `C:\Program Files\Tailscale\tailscale.exe`)
 *    → `{ source: 'cli' }`. A logged-out or stopped Tailscale makes the CLI fail → skipped.
 * 3. Any other interface with a 100.64.0.0/10 address → `{ source: 'interface' }`.
 *
 * Never throws; resolves null when nothing is found.
 */
export async function detectTailscale(opts: DetectTailscaleOptions = {}): Promise<TailscaleInfo | null> {
  let named: string | null = null
  let other: string | null = null
  try {
    const ifaces = opts.interfaces ?? networkInterfaces()
    for (const [name, infos] of Object.entries(ifaces)) {
      for (const info of infos ?? []) {
        if (!isV4(info) || info.internal || !isCgnatRange(info.address)) continue
        if (TAILSCALE_NAME.test(name)) named ??= info.address
        else other ??= info.address
      }
    }
  } catch {
    // fall through to the CLI
  }
  if (named) return { ip: named, source: 'interface' }

  if (opts.useCli !== false) {
    const timeout = opts.cliTimeoutMs ?? 1500
    for (const file of opts.cliPaths ?? defaultCliPaths()) {
      const ip = await runTailscaleIp(file, timeout)
      if (ip) return { ip, source: 'cli' }
    }
  }
  if (other) return { ip: other, source: 'interface' }
  return null
}
