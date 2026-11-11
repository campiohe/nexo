// Remote address helpers for "Welcome back" (docs/SPEC-ACCOUNTS.md §3). Only the TCP peer address is ever
// used: never X-Forwarded-For or any other header. Behind a proxy the peer is the proxy, which is not a
// Tailscale address, so the feature simply stays off.
import { BlockList, isIP } from 'node:net'

/** `::ffff:1.2.3.4` → `1.2.3.4`; IPv6 lowercased; '' for a missing address. */
export function unwrapAddress(address: string | undefined | null): string {
  if (!address) return ''
  const a = address.trim().toLowerCase()
  return a.startsWith('::ffff:') && isIP(a.slice(7)) === 4 ? a.slice(7) : a
}

// Tailscale hands out 100.64.0.0/10 (IPv4) and fd7a:115c:a1e0::/48 (IPv6). Traffic from these addresses
// arrives through WireGuard, so it is authenticated by the sending device's key.
const TAILSCALE = new BlockList()
TAILSCALE.addSubnet('100.64.0.0', 10, 'ipv4')
TAILSCALE.addSubnet('fd7a:115c:a1e0::', 48, 'ipv6')

/** True for a Tailscale address (after unwrapping IPv4-mapped IPv6). */
export function isTailscaleAddress(address: string | undefined | null): boolean {
  const a = unwrapAddress(address)
  const family = isIP(a)
  if (family === 0) return false
  try {
    return TAILSCALE.check(a, family === 4 ? 'ipv4' : 'ipv6')
  } catch {
    return false
  }
}
