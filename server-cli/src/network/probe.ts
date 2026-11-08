// One-shot network probe: everything the CLI needs to tell the host how friends can reach them
// (SPEC-SERVER-CLI §6). Time-bounded, never throws; failures become notes.
import { classifyReachability, isCgnatRange, isPrivateIp, type Reachability } from './ip.ts'
import { detectTailscale, lanAddresses, type DetectTailscaleOptions, type TailscaleInfo } from './interfaces.ts'
import { stunPublicIp, type StunOptions } from './stun.ts'
import {
  discoverGateway,
  getExternalIp,
  mapPorts,
  type DiscoverOptions,
  type Gateway,
  type MapPortsOptions,
  type PortMappingSession,
  type PortSpec,
} from './upnp.ts'

export interface ProbeOptions {
  /** Budget for the whole probe (not counting optional port mapping), default 4500 ms. */
  timeoutMs?: number
  /** STUN options, or false to skip STUN. */
  stun?: StunOptions | false
  /** UPnP discovery options, or false to skip UPnP. */
  upnp?: DiscoverOptions | false
  /** Tailscale detection options, or false to skip. */
  tailscale?: DetectTailscaleOptions | false
  /**
   * Off by default: mapping changes the router, so it's normally a separate explicit `mapPorts()`
   * call. When given and a gateway is found, ports are mapped after the probe and the session is
   * returned in `mapping` (this step has its own SOAP timeouts, outside `timeoutMs`).
   */
  mapPorts?: false | ({ ports: PortSpec[] } & MapPortsOptions)
}

export interface NetworkProbe {
  /** Private LAN addresses (same-house invite). */
  lan: string[]
  tailscale: TailscaleInfo | null
  /** Public IPv4 seen by a STUN server. */
  stunIp: string | null
  gateway: {
    found: boolean
    /** Router's WAN address from UPnP GetExternalIPAddress. */
    externalIp: string | null
    /** Handle for mapPorts()/getExternalIp() later; null when not found. */
    device: Gateway | null
  }
  reachability: Reachability
  /** Only when `mapPorts` was requested and a gateway was found. */
  mapping: PortMappingSession | null
  /** Plain-English diagnostics, one per finding/failure. */
  notes: string[]
  elapsedMs: number
}

function withDeadline<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(fallback), Math.max(0, ms))
    p.then(
      (v) => {
        clearTimeout(t)
        resolve(v)
      },
      () => {
        clearTimeout(t)
        resolve(fallback)
      },
    )
  })
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/**
 * Runs LAN, Tailscale, STUN and UPnP checks in parallel and classifies reachability.
 * Resolves within ~`timeoutMs` (default 4.5 s) and never rejects.
 */
export async function probeNetwork(opts: ProbeOptions = {}): Promise<NetworkProbe> {
  const started = Date.now()
  const budget = opts.timeoutMs ?? 4500
  const notes: string[] = []
  const remaining = (): number => Math.max(0, budget - (Date.now() - started))

  let lan: string[] = []
  try {
    lan = lanAddresses()
  } catch (e) {
    notes.push(`Could not list network interfaces: ${errMsg(e)}`)
  }
  if (lan.length === 0) notes.push('No LAN address found (is this PC connected to a network?).')

  const tailscaleP =
    opts.tailscale === false
      ? Promise.resolve(null)
      : withDeadline(detectTailscale({ cliTimeoutMs: Math.min(1500, budget), ...opts.tailscale }), budget, null)

  const stunP =
    opts.stun === false
      ? Promise.resolve(null)
      : withDeadline(stunPublicIp({ timeoutMs: Math.min(2500, budget), ...opts.stun }), budget, null)

  type UpnpPart = { device: Gateway | null; externalIp: string | null; note: string | null }
  const upnpP: Promise<UpnpPart> =
    opts.upnp === false
      ? Promise.resolve({ device: null, externalIp: null, note: null })
      : withDeadline<UpnpPart>(
          (async () => {
            const device = await discoverGateway({ timeoutMs: Math.min(3000, budget), ...opts.upnp })
            if (!device) {
              return {
                device: null,
                externalIp: null,
                note: 'UPnP: no router answered (UPnP may be off in the router settings, or unsupported).',
              }
            }
            const name = device.friendlyName ? ` (${device.friendlyName})` : ''
            try {
              const externalIp = await getExternalIp(device, { timeoutMs: Math.max(300, Math.min(2000, remaining())) })
              const note = externalIp ? null : `UPnP: router${name} found but reports no internet address (WAN down?).`
              return { device, externalIp, note }
            } catch (e) {
              return { device, externalIp: null, note: `UPnP: router${name} found but did not report its internet address: ${errMsg(e)}` }
            }
          })(),
          budget,
          { device: null, externalIp: null, note: 'UPnP: router check timed out.' },
        )

  const [tailscale, stunIp, gw] = await Promise.all([tailscaleP, stunP, upnpP])
  if (gw.note) notes.push(gw.note)

  if (opts.stun !== false && !stunIp) notes.push('STUN: no answer from public STUN servers (offline, or UDP blocked).')

  const reachability = classifyReachability({ routerExternalIp: gw.externalIp, stunIp })
  const rip = gw.externalIp
  if (rip && isCgnatRange(rip)) {
    notes.push(`Router's internet address ${rip} is in 100.64.0.0/10: the internet provider uses carrier-grade NAT (CGNAT).`)
  } else if (rip && isPrivateIp(rip)) {
    notes.push(
      `Router's internet address ${rip} is private: another router or the provider sits in front of it (double NAT).`,
    )
  } else if (rip && stunIp && rip !== stunIp) {
    notes.push(`Router's internet address ${rip} differs from the address the internet sees (${stunIp}): CGNAT or double NAT.`)
  } else if (rip && !stunIp && reachability === 'unknown') {
    notes.push(`Router reports internet address ${rip}, but it could not be confirmed with STUN.`)
  }

  let mapping: PortMappingSession | null = null
  if (opts.mapPorts && gw.device) {
    const { ports, ...mapOpts } = opts.mapPorts
    try {
      mapping = await mapPorts(gw.device, ports, mapOpts)
      for (const r of mapping.results) {
        if (r.status !== 'mapped') notes.push(`UPnP: ${r.externalPort}/${r.protocol} not forwarded: ${r.error ?? r.status}`)
      }
    } catch (e) {
      notes.push(`UPnP: port mapping failed: ${errMsg(e)}`)
    }
  }

  return {
    lan,
    tailscale,
    stunIp,
    gateway: { found: gw.device !== null, externalIp: gw.externalIp, device: gw.device },
    reachability,
    mapping,
    notes,
    elapsedMs: Date.now() - started,
  }
}
