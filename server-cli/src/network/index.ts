// Nexo Server CLI networking (SPEC-SERVER-CLI §5 ports, §6 reachability). Node builtins only.
//
// Typical CLI flow:
//
//   const probe = await probeNetwork()              // ~≤4.5 s, never throws
//   probe.lan             → same-house invites (http://<lan>:3001)
//   probe.tailscale?.ip   → recommended invite when present (LiveKit node_ip)
//   probe.reachability    → 'public' | 'cgnat' | 'unknown'
//   probe.gateway.device  → UPnP router handle (null = no UPnP → print manual forwarding table)
//   probe.notes           → diagnostics to show / log
//
//   // Only when the host chose public mode (changes the router!):
//   const session = await mapPorts(probe.gateway.device, [
//     { externalPort: 3001, protocol: 'TCP' }, { externalPort: 7880, protocol: 'TCP' },
//     { externalPort: 7881, protocol: 'TCP' }, { externalPort: 7882, protocol: 'UDP' },
//   ], { leaseSeconds: 3600, description: 'Nexo Server' })
//   session.results       → per-port 'mapped' | 'conflict' | 'error'
//   const stop = session.startAutoRenew()            // renew at lease/2 while running
//   process.on('SIGINT', async () => { await session.release(); process.exit() })
//
// Timeouts (defaults): STUN 2.5 s overall (retransmit 0.5/1/2 s), SSDP discovery 3 s overall
// (M-SEARCH sent twice, MX 1), HTTP description fetch 1.5 s, SOAP actions 2 s each,
// `tailscale ip -4` 1.5 s per executable, whole probe 4.5 s.

export {
  classifyReachability,
  isCgnatRange,
  isIpv4,
  isLinkLocal,
  isLoopback,
  isPrivateIp,
  isPublicIpv4,
  parseIpv4,
  type Reachability,
} from './ip.ts'

export {
  detectTailscale,
  lanAddresses,
  type DetectTailscaleOptions,
  type InterfaceMap,
  type TailscaleInfo,
} from './interfaces.ts'

export {
  DEFAULT_STUN_SERVERS,
  decodeBindingResponse,
  encodeBindingRequest,
  stunPublicIp,
  stunQuery,
  type StunMappedAddress,
  type StunOptions,
  type StunResult,
  type StunServer,
} from './stun.ts'

export {
  addPortMapping,
  deletePortMapping,
  discoverGateway,
  gatewayFromLocation,
  getExternalIp,
  getSpecificPortMapping,
  mapPorts,
  parseDeviceDescription,
  parseSsdpResponse,
  soapAction,
  UpnpError,
  type DiscoverOptions,
  type ExistingMapping,
  type Gateway,
  type MapPortsOptions,
  type MapStatus,
  type PortMapOutcome,
  type PortMappingRequest,
  type PortMappingResult,
  type PortMappingSession,
  type PortSpec,
  type Protocol,
  type SoapOptions,
} from './upnp.ts'

export { probeNetwork, type NetworkProbe, type ProbeOptions } from './probe.ts'

/** Ports the server needs reachable (SPEC-SERVER-CLI §5), in mapPorts() shape. */
export function defaultPorts(cfg: { http?: number; livekitSignal?: number; livekitTcp?: number; livekitUdp?: number } = {}) {
  return [
    { externalPort: cfg.http ?? 3001, protocol: 'TCP' as const },
    { externalPort: cfg.livekitSignal ?? 7880, protocol: 'TCP' as const },
    { externalPort: cfg.livekitTcp ?? 7881, protocol: 'TCP' as const },
    { externalPort: cfg.livekitUdp ?? 7882, protocol: 'UDP' as const },
  ]
}
