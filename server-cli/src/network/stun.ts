// Minimal STUN client (RFC 5389 Binding Request over UDP) to learn the public IPv4 address the
// internet sees for this host. Used for CGNAT detection (SPEC-SERVER-CLI §6 step 3).
import { createSocket } from 'node:dgram'
import { randomBytes } from 'node:crypto'

export const STUN_MAGIC_COOKIE = 0x2112a442
const BINDING_REQUEST = 0x0001
const BINDING_SUCCESS = 0x0101
const ATTR_MAPPED_ADDRESS = 0x0001
const ATTR_XOR_MAPPED_ADDRESS = 0x0020
const ATTR_XOR_MAPPED_ADDRESS_OLD = 0x8020 // pre-RFC 5389 servers

export interface StunServer {
  host: string
  port: number
}

/** Same public servers LiveKit / WebRTC clients commonly use. */
export const DEFAULT_STUN_SERVERS: StunServer[] = [
  { host: 'stun.l.google.com', port: 19302 },
  { host: 'stun.cloudflare.com', port: 3478 },
  { host: 'stun1.l.google.com', port: 19302 },
]

/** Builds a 20-byte Binding Request with the given 12-byte transaction id. */
export function encodeBindingRequest(transactionId: Buffer): Buffer {
  if (transactionId.length !== 12) throw new Error('STUN transaction id must be 12 bytes')
  const msg = Buffer.alloc(20)
  msg.writeUInt16BE(BINDING_REQUEST, 0)
  msg.writeUInt16BE(0, 2)
  msg.writeUInt32BE(STUN_MAGIC_COOKIE, 4)
  transactionId.copy(msg, 8)
  return msg
}

export interface StunMappedAddress {
  family: 'IPv4' | 'IPv6'
  address: string
  port: number
}

function formatIpv6(b: Buffer): string {
  const groups: string[] = []
  for (let i = 0; i < 16; i += 2) groups.push(b.readUInt16BE(i).toString(16))
  return groups.join(':')
}

function decodeAddress(value: Buffer, xor: boolean, transactionId: Buffer): StunMappedAddress | null {
  if (value.length < 8) return null
  const family = value[1]
  let port = value.readUInt16BE(2)
  if (xor) port ^= STUN_MAGIC_COOKIE >>> 16
  if (family === 0x01) {
    let n = value.readUInt32BE(4)
    if (xor) n = (n ^ STUN_MAGIC_COOKIE) >>> 0
    return { family: 'IPv4', address: [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.'), port }
  }
  if (family === 0x02 && value.length >= 20) {
    const addr = Buffer.from(value.subarray(4, 20))
    if (xor) {
      const key = Buffer.alloc(16)
      key.writeUInt32BE(STUN_MAGIC_COOKIE, 0)
      transactionId.copy(key, 4)
      for (let i = 0; i < 16; i++) addr[i] ^= key[i]
    }
    return { family: 'IPv6', address: formatIpv6(addr), port }
  }
  return null
}

/**
 * Parses a Binding Success Response. Returns the mapped address (XOR-MAPPED-ADDRESS preferred,
 * MAPPED-ADDRESS as fallback), or null if the packet isn't a well-formed success response for
 * `transactionId` (when given).
 */
export function decodeBindingResponse(msg: Buffer, transactionId?: Buffer): StunMappedAddress | null {
  if (msg.length < 20) return null
  if (msg.readUInt16BE(0) !== BINDING_SUCCESS) return null
  if (msg.readUInt32BE(4) !== STUN_MAGIC_COOKIE) return null
  const tid = msg.subarray(8, 20)
  if (transactionId && !tid.equals(transactionId)) return null
  const len = msg.readUInt16BE(2)
  const end = Math.min(msg.length, 20 + len)
  let xorMapped: StunMappedAddress | null = null
  let mapped: StunMappedAddress | null = null
  let off = 20
  while (off + 4 <= end) {
    const type = msg.readUInt16BE(off)
    const alen = msg.readUInt16BE(off + 2)
    const vstart = off + 4
    if (vstart + alen > end) break
    const value = msg.subarray(vstart, vstart + alen)
    if (type === ATTR_XOR_MAPPED_ADDRESS || type === ATTR_XOR_MAPPED_ADDRESS_OLD) {
      xorMapped ??= decodeAddress(value, true, tid)
    } else if (type === ATTR_MAPPED_ADDRESS) {
      mapped ??= decodeAddress(value, false, tid)
    }
    off = vstart + alen + ((4 - (alen % 4)) % 4)
  }
  return xorMapped ?? mapped
}

export interface StunOptions {
  /** Servers queried in parallel; first valid answer wins. Strings are "host:port". */
  servers?: Array<StunServer | string>
  /** Overall deadline, default 2500 ms. */
  timeoutMs?: number
  /** Retransmit interval, default 500 ms (doubles each time, RFC 5389-style). */
  retryMs?: number
}

export interface StunResult {
  address: string
  port: number
  server: string
}

function toServer(s: StunServer | string): StunServer | null {
  if (typeof s !== 'string') return s
  const i = s.lastIndexOf(':')
  if (i <= 0) return { host: s, port: 3478 }
  const port = Number(s.slice(i + 1))
  return Number.isInteger(port) && port > 0 && port < 65536 ? { host: s.slice(0, i), port } : null
}

/**
 * Sends Binding Requests to all servers at once (one transaction id each), retransmitting until
 * the deadline; resolves with the first response whose transaction id matches and that carries an
 * IPv4 mapped address. Never throws; resolves null on timeout / DNS failure / no network.
 */
export function stunQuery(opts: StunOptions = {}): Promise<StunResult | null> {
  const servers = (opts.servers ?? DEFAULT_STUN_SERVERS).map(toServer).filter((s): s is StunServer => s !== null)
  const timeoutMs = opts.timeoutMs ?? 2500
  const firstRetry = opts.retryMs ?? 500
  return new Promise((resolve) => {
    if (servers.length === 0) return resolve(null)
    const pending = servers.map((server) => {
      const tid = randomBytes(12)
      return { server, tid, packet: encodeBindingRequest(tid) }
    })
    let done = false
    let retryTimer: NodeJS.Timeout | undefined
    const sock = createSocket({ type: 'udp4' })
    const finish = (r: StunResult | null): void => {
      if (done) return
      done = true
      clearTimeout(deadline)
      clearTimeout(retryTimer)
      try {
        sock.close()
      } catch {
        // already closed
      }
      resolve(r)
    }
    const deadline = setTimeout(() => finish(null), timeoutMs)
    sock.on('error', () => finish(null))
    sock.on('message', (msg) => {
      for (const p of pending) {
        const res = decodeBindingResponse(msg, p.tid)
        if (res && res.family === 'IPv4') {
          return finish({ address: res.address, port: res.port, server: `${p.server.host}:${p.server.port}` })
        }
      }
    })
    const sendAll = (): void => {
      for (const p of pending) {
        if (done) return
        try {
          // DNS resolution happens inside send(); failures arrive in the callback and are ignored.
          sock.send(p.packet, p.server.port, p.server.host, () => {})
        } catch {
          // socket closed meanwhile
        }
      }
    }
    let interval = firstRetry
    const scheduleRetry = (): void => {
      retryTimer = setTimeout(() => {
        if (done) return
        sendAll()
        interval *= 2
        scheduleRetry()
      }, interval)
    }
    try {
      sock.bind(0, () => {
        sendAll()
        scheduleRetry()
      })
    } catch {
      finish(null)
    }
  })
}

/** The host's public IPv4 address as seen by a STUN server, or null. Never throws. See `stunQuery`. */
export async function stunPublicIp(opts: StunOptions = {}): Promise<string | null> {
  const r = await stunQuery(opts)
  return r?.address ?? null
}
