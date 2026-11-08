// IPv4 address helpers and the reachability classifier (SPEC-SERVER-CLI §6).
// Pure functions, no I/O.

/** Parses a dotted-quad IPv4 address into an unsigned 32-bit number, or null if it isn't one. */
export function parseIpv4(ip: string): number | null {
  if (typeof ip !== 'string') return null
  const parts = ip.trim().split('.')
  if (parts.length !== 4) return null
  let n = 0
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null
    const v = Number(p)
    if (v > 255) return null
    n = n * 256 + v
  }
  return n
}

/** True for a syntactically valid dotted-quad IPv4 address. */
export function isIpv4(ip: string): boolean {
  return parseIpv4(ip) !== null
}

function inCidr(ip: string, base: string, bits: number): boolean {
  const n = parseIpv4(ip)
  const b = parseIpv4(base)
  if (n === null || b === null) return false
  if (bits === 0) return true
  const size = 2 ** (32 - bits)
  return Math.floor(n / size) === Math.floor(b / size)
}

/** RFC 1918 private ranges: 10/8, 172.16/12, 192.168/16. */
export function isPrivateIp(ip: string): boolean {
  return inCidr(ip, '10.0.0.0', 8) || inCidr(ip, '172.16.0.0', 12) || inCidr(ip, '192.168.0.0', 16)
}

/** RFC 6598 shared address space 100.64.0.0/10 (carrier-grade NAT, also used by Tailscale). */
export function isCgnatRange(ip: string): boolean {
  return inCidr(ip, '100.64.0.0', 10)
}

/** 169.254.0.0/16 (APIPA / link-local). */
export function isLinkLocal(ip: string): boolean {
  return inCidr(ip, '169.254.0.0', 16)
}

/** 127.0.0.0/8. */
export function isLoopback(ip: string): boolean {
  return inCidr(ip, '127.0.0.0', 8)
}

// Special-purpose IPv4 blocks that are never a reachable public address.
const NON_PUBLIC: Array<[string, number]> = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
]

/** True for a valid IPv4 address that is globally routable (not private, CGNAT, loopback, multicast, …). */
export function isPublicIpv4(ip: string): boolean {
  if (!isIpv4(ip)) return false
  return !NON_PUBLIC.some(([base, bits]) => inCidr(ip, base, bits))
}

export type Reachability = 'public' | 'cgnat' | 'unknown'

/**
 * Decides whether router port forwarding can make this host reachable from the internet.
 *
 * - `cgnat`: the router's WAN address is in 100.64.0.0/10 or a private range (the ISP, or another
 *   router upstream, does NAT again), or it differs from the public address a STUN server sees.
 * - `public`: router WAN address and STUN address are equal and globally routable.
 * - `unknown`: anything else (no router answer, no STUN answer, malformed input).
 */
export function classifyReachability(input: { routerExternalIp: string | null; stunIp: string | null }): Reachability {
  const router = input.routerExternalIp && isIpv4(input.routerExternalIp) ? input.routerExternalIp.trim() : null
  const stun = input.stunIp && isIpv4(input.stunIp) ? input.stunIp.trim() : null
  if (router && (isCgnatRange(router) || isPrivateIp(router))) return 'cgnat'
  if (router && stun) {
    if (parseIpv4(router) !== parseIpv4(stun)) return 'cgnat'
    return isPublicIpv4(router) ? 'public' : 'unknown'
  }
  return 'unknown'
}
