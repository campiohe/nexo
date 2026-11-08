// Minimal UPnP IGD client (SSDP discovery + SOAP control over node:http) for router port forwarding
// (SPEC-SERVER-CLI §5, §6 step 3, R4). No dependencies; XML is read with tolerant tag extraction.
import { createSocket, type Socket as UdpSocket } from 'node:dgram'
import { request as httpRequest } from 'node:http'
import { isIpv4 } from './ip.ts'
import { lanAddresses } from './interfaces.ts'

export const SSDP_ADDRESS = '239.255.255.250'
export const SSDP_PORT = 1900

/** Search targets sent in M-SEARCH (one datagram each). */
export const SSDP_SEARCH_TARGETS = [
  'urn:schemas-upnp-org:device:InternetGatewayDevice:1',
  'urn:schemas-upnp-org:device:InternetGatewayDevice:2',
  'urn:schemas-upnp-org:service:WANIPConnection:1',
  'urn:schemas-upnp-org:service:WANIPConnection:2',
  'urn:schemas-upnp-org:service:WANPPPConnection:1',
]

/** WAN connection services we can control, in order of preference. */
export const WAN_SERVICE_TYPES = [
  'urn:schemas-upnp-org:service:WANIPConnection:2',
  'urn:schemas-upnp-org:service:WANIPConnection:1',
  'urn:schemas-upnp-org:service:WANPPPConnection:1',
]

export type Protocol = 'TCP' | 'UDP'

/** A router WAN connection service we can send SOAP actions to. Plain data; safe to keep around. */
export interface Gateway {
  /** Absolute SOAP control URL. */
  controlUrl: string
  /** e.g. `urn:schemas-upnp-org:service:WANIPConnection:1`. */
  serviceType: string
  /** Our IPv4 address on the gateway's network (the source address of our TCP connection to it). */
  localAddress: string
  /** Device description URL from SSDP (LOCATION). */
  location: string
  friendlyName?: string
}

// ---------------------------------------------------------------------------------------------
// Errors

const UPNP_ERRORS: Record<number, string> = {
  401: 'the router rejected the request (invalid action or not authorized)',
  402: 'the router rejected the request arguments',
  501: 'the router failed to perform the action',
  606: 'the router does not allow this action (UPnP port forwarding is restricted in its settings)',
  714: 'no such port mapping',
  715: 'the router does not allow a wildcard source address',
  716: 'the router does not allow a wildcard external port',
  718: 'that external port is already forwarded to another device',
  724: 'the router requires the internal and external port to be the same',
  725: 'the router only supports permanent port mappings',
  726: 'the router requires a wildcard remote host',
  727: 'the router requires a wildcard external port',
  728: 'the router has no free port mapping slots',
  729: 'the port conflicts with another forwarding mechanism on the router',
  732: 'the router does not allow a wildcard internal port',
}

/** A SOAP fault from the router (`code` is the UPnP error code) or a transport failure (`code` null). */
export class UpnpError extends Error {
  readonly code: number | null
  readonly action: string
  readonly upnpDescription: string | null
  constructor(action: string, code: number | null, upnpDescription: string | null, message?: string) {
    const human = code !== null ? (UPNP_ERRORS[code] ?? upnpDescription ?? 'unknown router error') : null
    super(message ?? `UPnP ${action} failed: ${human ?? 'no response'}${code !== null ? ` (error ${code})` : ''}`)
    this.name = 'UpnpError'
    this.code = code
    this.action = action
    this.upnpDescription = upnpDescription
  }
  get isConflict(): boolean {
    return this.code === 718
  }
  get isNotAuthorized(): boolean {
    return this.code === 606 || this.code === 401
  }
}

// ---------------------------------------------------------------------------------------------
// XML helpers (namespace-prefix tolerant, whitespace tolerant)

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function decodeXml(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
}

function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;')
}

/** Text content of the first `<tag>` (any namespace prefix), trimmed and entity-decoded; null if absent. */
export function xmlTag(xml: string, tag: string): string | null {
  const re = new RegExp(`<(?:[\\w.-]+:)?${escapeRe(tag)}(?:\\s[^>]*)?(?:/>|>([\\s\\S]*?)</(?:[\\w.-]+:)?${escapeRe(tag)}\\s*>)`, 'i')
  const m = re.exec(xml)
  if (!m) return null
  return decodeXml(m[1] ?? '').trim()
}

/** Raw inner XML of every `<tag>…</tag>` block (any namespace prefix). Not suitable for self-nesting tags. */
export function xmlBlocks(xml: string, tag: string): string[] {
  const re = new RegExp(`<(?:[\\w.-]+:)?${escapeRe(tag)}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[\\w.-]+:)?${escapeRe(tag)}\\s*>`, 'gi')
  const out: string[] = []
  for (let m = re.exec(xml); m; m = re.exec(xml)) out.push(m[1])
  return out
}

// ---------------------------------------------------------------------------------------------
// SSDP

export interface SsdpResponse {
  location: string
  st: string | null
  usn: string | null
  server: string | null
}

/** Parses an SSDP M-SEARCH response (HTTP/1.1 200 over UDP). Returns null if it has no usable LOCATION. */
export function parseSsdpResponse(msg: Buffer | string): SsdpResponse | null {
  const text = typeof msg === 'string' ? msg : msg.toString('utf8')
  const lines = text.split(/\r?\n/)
  if (!/^HTTP\/1\.[01]\s+200\b/i.test(lines[0]?.trim() ?? '') && !/^NOTIFY\s/i.test(lines[0] ?? '')) return null
  const headers: Record<string, string> = {}
  for (const line of lines.slice(1)) {
    const i = line.indexOf(':')
    if (i <= 0) continue
    headers[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim()
  }
  const location = headers.location
  if (!location) return null
  try {
    const u = new URL(location)
    if (u.protocol !== 'http:') return null
  } catch {
    return null
  }
  return { location, st: headers.st ?? headers.nt ?? null, usn: headers.usn ?? null, server: headers.server ?? null }
}

/** True when an SSDP response advertises something an IGD client cares about. */
export function isIgdResponse(r: SsdpResponse): boolean {
  const hay = `${r.st ?? ''} ${r.usn ?? ''}`
  return /InternetGatewayDevice|WANIPConnection|WANPPPConnection/i.test(hay)
}

function mSearch(st: string, mx: number, host: string, port: number): Buffer {
  return Buffer.from(
    `M-SEARCH * HTTP/1.1\r\nHOST: ${host}:${port}\r\nMAN: "ssdp:discover"\r\nMX: ${mx}\r\nST: ${st}\r\n\r\n`,
  )
}

// ---------------------------------------------------------------------------------------------
// HTTP

interface HttpResult {
  status: number
  body: string
  localAddress: string | null
}

const MAX_BODY = 512 * 1024

function httpCall(
  url: string,
  init: { method: 'GET' | 'POST'; headers?: Record<string, string>; body?: string; timeoutMs: number },
): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    let u: URL
    try {
      u = new URL(url)
    } catch {
      return reject(new Error(`invalid URL ${url}`))
    }
    if (u.protocol !== 'http:') return reject(new Error(`unsupported URL ${url}`))
    const body = init.body !== undefined ? Buffer.from(init.body, 'utf8') : undefined
    const headers: Record<string, string> = { ...init.headers, Connection: 'close' }
    if (body) headers['Content-Length'] = String(body.length) // explicit: some routers choke on chunked bodies
    let settled = false
    const req = httpRequest(
      {
        hostname: u.hostname,
        port: u.port || 80,
        path: `${u.pathname}${u.search}`,
        method: init.method,
        headers,
        agent: false,
      },
      (res) => {
        const localAddress = res.socket?.localAddress ?? null
        const chunks: Buffer[] = []
        let size = 0
        res.on('data', (c: Buffer) => {
          size += c.length
          if (size > MAX_BODY) {
            fail(new Error('response too large'))
            req.destroy()
            return
          }
          chunks.push(c)
        })
        res.on('end', () => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8'), localAddress })
        })
        res.on('error', (e) => fail(e))
      },
    )
    const fail = (e: Error): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(e)
    }
    const timer = setTimeout(() => {
      fail(new Error(`timed out after ${init.timeoutMs} ms`))
      req.destroy()
    }, init.timeoutMs)
    req.on('error', fail)
    req.end(body)
  })
}

// ---------------------------------------------------------------------------------------------
// Device description

export interface WanService {
  serviceType: string
  controlUrl: string
}

/**
 * Extracts the WAN connection services (WANIPConnection / WANPPPConnection) and their absolute
 * control URLs from a device description, best first. Relative URLs resolve against `<URLBase>`
 * if present, else against the description's own URL.
 */
export function parseDeviceDescription(xml: string, descriptionUrl: string): { friendlyName: string | null; services: WanService[] } {
  const urlBase = xmlTag(xml, 'URLBase')
  let base = descriptionUrl
  if (urlBase) {
    try {
      base = new URL(urlBase, descriptionUrl).toString()
    } catch {
      // ignore a malformed URLBase
    }
  }
  const services: WanService[] = []
  for (const block of xmlBlocks(xml, 'service')) {
    const serviceType = xmlTag(block, 'serviceType')
    const control = xmlTag(block, 'controlURL')
    if (!serviceType || !control) continue
    if (!/:service:WAN(IP|PPP)Connection:\d+$/i.test(serviceType)) continue
    let controlUrl: string
    try {
      controlUrl = new URL(control, base).toString()
    } catch {
      continue
    }
    if (!services.some((s) => s.controlUrl === controlUrl && s.serviceType === serviceType)) services.push({ serviceType, controlUrl })
  }
  const rank = (t: string): number => {
    const i = WAN_SERVICE_TYPES.findIndex((w) => w.toLowerCase() === t.toLowerCase())
    return i === -1 ? WAN_SERVICE_TYPES.length : i
  }
  services.sort((a, b) => rank(a.serviceType) - rank(b.serviceType))
  return { friendlyName: xmlTag(xml, 'friendlyName'), services }
}

export interface GatewayFromLocationOptions {
  /** Per HTTP request timeout, default 1500 ms. */
  timeoutMs?: number
}

/**
 * Fetches a device description (the SSDP LOCATION) and returns a controllable Gateway, or null if
 * it has no WAN connection service. When the device has several WAN services (e.g. an inactive PPP
 * one next to the IP one), the first that answers GetExternalIPAddress with an address is picked.
 * Throws on network errors.
 */
export async function gatewayFromLocation(location: string, opts: GatewayFromLocationOptions = {}): Promise<Gateway | null> {
  const timeoutMs = opts.timeoutMs ?? 1500
  const res = await httpCall(location, { method: 'GET', timeoutMs })
  if (res.status !== 200) throw new Error(`device description returned HTTP ${res.status}`)
  const { friendlyName, services } = parseDeviceDescription(res.body, location)
  if (services.length === 0) return null
  const localAddress = res.localAddress && isIpv4(res.localAddress.replace(/^::ffff:/, '')) ? res.localAddress.replace(/^::ffff:/, '') : ''
  const make = (s: WanService): Gateway => ({
    controlUrl: s.controlUrl,
    serviceType: s.serviceType,
    localAddress,
    location,
    ...(friendlyName ? { friendlyName } : {}),
  })
  if (services.length === 1) return make(services[0])
  for (const s of services) {
    try {
      const ip = await getExternalIp(make(s), { timeoutMs })
      if (ip) return make(s)
    } catch {
      // try the next one
    }
  }
  return make(services[0])
}

export interface DiscoverOptions {
  /** Overall deadline, default 3000 ms. */
  timeoutMs?: number
  /** M-SEARCH MX value (seconds a device may wait before answering), default 1. */
  mx?: number
  /** Where to send M-SEARCH; default the SSDP multicast group. Tests point this at a fake on 127.0.0.1. */
  ssdpAddress?: string
  ssdpPort?: number
  /** Local IPv4 addresses whose interfaces get an M-SEARCH (multicast). Default: `lanAddresses()`. */
  interfaces?: string[]
  /** Per HTTP request timeout for the description fetch, default 1500 ms. */
  httpTimeoutMs?: number
}

/**
 * Looks for a UPnP Internet Gateway Device on the local network: sends SSDP M-SEARCH for IGD v1/v2
 * and the WAN connection services (on every LAN interface, sent twice since UDP is lossy), fetches
 * each advertised description once, and resolves with the first controllable WAN service.
 * Resolves null if none answers before the deadline. Never throws.
 */
export function discoverGateway(opts: DiscoverOptions = {}): Promise<Gateway | null> {
  const timeoutMs = opts.timeoutMs ?? 3000
  const mx = opts.mx ?? 1
  const target = opts.ssdpAddress ?? SSDP_ADDRESS
  const port = opts.ssdpPort ?? SSDP_PORT
  const multicast = target === SSDP_ADDRESS
  const httpTimeoutMs = opts.httpTimeoutMs ?? 1500

  return new Promise((resolve) => {
    let done = false
    const seen = new Set<string>()
    let inflight = 0
    let searchOver = false
    const timers: NodeJS.Timeout[] = []
    let sock: UdpSocket | null = null

    const finish = (gw: Gateway | null): void => {
      if (done) return
      done = true
      for (const t of timers) clearTimeout(t)
      try {
        sock?.close()
      } catch {
        // already closed
      }
      resolve(gw)
    }
    const maybeGiveUp = (): void => {
      if (searchOver && inflight === 0) finish(null)
    }
    timers.push(setTimeout(() => finish(null), timeoutMs))
    // Stop listening a bit before the deadline so a description fetch can still complete.
    timers.push(
      setTimeout(
        () => {
          searchOver = true
          maybeGiveUp()
        },
        Math.max(0, Math.min(timeoutMs - 300, mx * 1000 + 800)),
      ),
    )

    try {
      sock = createSocket({ type: 'udp4', reuseAddr: false })
    } catch {
      return finish(null)
    }
    sock.on('error', () => finish(null))
    sock.on('message', (msg) => {
      if (done) return
      const r = parseSsdpResponse(msg)
      if (!r || !isIgdResponse(r) || seen.has(r.location)) return
      seen.add(r.location)
      inflight++
      gatewayFromLocation(r.location, { timeoutMs: httpTimeoutMs })
        .then((gw) => {
          if (gw) finish(gw)
        })
        .catch(() => {})
        .finally(() => {
          inflight--
          maybeGiveUp()
        })
    })

    const sendAll = (): void => {
      if (done || !sock) return
      const ifaces = multicast ? (opts.interfaces ?? safeLan()) : []
      const outs: Array<string | null> = ifaces.length > 0 ? ifaces : [null]
      for (const iface of outs) {
        try {
          if (iface) sock.setMulticastInterface(iface)
        } catch {
          continue
        }
        for (const st of SSDP_SEARCH_TARGETS) {
          try {
            sock.send(mSearch(st, mx, target, port), port, target, () => {})
          } catch {
            // closed meanwhile
          }
        }
      }
    }

    try {
      sock.bind(0, () => {
        try {
          if (multicast) sock?.setMulticastTTL(2)
        } catch {
          // not fatal
        }
        sendAll()
        timers.push(setTimeout(sendAll, 600))
      })
    } catch {
      finish(null)
    }
  })
}

function safeLan(): string[] {
  try {
    return lanAddresses()
  } catch {
    return []
  }
}

// ---------------------------------------------------------------------------------------------
// SOAP actions

export interface SoapOptions {
  /** Per request timeout, default 2000 ms. */
  timeoutMs?: number
}

/**
 * Sends one SOAP action to the gateway's control URL and returns the response's out-arguments
 * (tag → text). Throws UpnpError with the router's error code on a SOAP fault, or with code null
 * on transport errors.
 */
export async function soapAction(
  gw: Gateway,
  action: string,
  args: Array<[string, string | number]>,
  opts: SoapOptions = {},
): Promise<Record<string, string>> {
  const argXml = args.map(([k, v]) => `<${k}>${escapeXml(String(v))}</${k}>`).join('')
  const body =
    '<?xml version="1.0" encoding="utf-8"?>\r\n' +
    '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">' +
    `<s:Body><u:${action} xmlns:u="${gw.serviceType}">${argXml}</u:${action}></s:Body></s:Envelope>`
  let res: HttpResult
  try {
    res = await httpCall(gw.controlUrl, {
      method: 'POST',
      timeoutMs: opts.timeoutMs ?? 2000,
      headers: {
        'Content-Type': 'text/xml; charset="utf-8"',
        SOAPAction: `"${gw.serviceType}#${action}"`,
      },
      body,
    })
  } catch (e) {
    throw new UpnpError(action, null, null, `UPnP ${action} failed: ${(e as Error).message}`)
  }
  if (res.status !== 200 || /<(?:[\w.-]+:)?Fault[\s>]/i.test(res.body)) {
    const codeText = xmlTag(res.body, 'errorCode')
    const code = codeText && /^\d+$/.test(codeText) ? Number(codeText) : null
    if (code !== null) throw new UpnpError(action, code, xmlTag(res.body, 'errorDescription'))
    throw new UpnpError(action, null, null, `UPnP ${action} failed: HTTP ${res.status}`)
  }
  const respBlock = xmlBlocks(res.body, `${action}Response`)[0] ?? res.body
  const out: Record<string, string> = {}
  const re = /<(?:[\w.-]+:)?(New\w+)(?:\s[^>]*)?(?:\/>|>([\s\S]*?)<\/(?:[\w.-]+:)?\1\s*>)/g
  for (let m = re.exec(respBlock); m; m = re.exec(respBlock)) out[m[1]] = decodeXml(m[2] ?? '').trim()
  return out
}

/** The router's WAN IPv4 address (GetExternalIPAddress), or null if it reports none / an invalid one. */
export async function getExternalIp(gw: Gateway, opts: SoapOptions = {}): Promise<string | null> {
  const out = await soapAction(gw, 'GetExternalIPAddress', [], opts)
  const ip = out.NewExternalIPAddress ?? ''
  return isIpv4(ip) && ip !== '0.0.0.0' ? ip : null
}

export interface PortMappingRequest {
  externalPort: number
  internalPort: number
  protocol: Protocol
  /** LAN IPv4 address to forward to; defaults to `gw.localAddress`. */
  internalClient?: string
  description: string
  /** 0 = permanent. */
  leaseSeconds: number
}

export interface PortMappingResult {
  /** Lease actually granted: 0 if the router only supports permanent mappings (error 725 retry). */
  leaseSeconds: number
}

/**
 * AddPortMapping. On error 725 (OnlyPermanentLeasesSupported) retries once with lease 0.
 * Throws UpnpError (e.g. `isConflict` for 718, `isNotAuthorized` for 606/401).
 */
export async function addPortMapping(gw: Gateway, req: PortMappingRequest, opts: SoapOptions = {}): Promise<PortMappingResult> {
  const client = req.internalClient ?? gw.localAddress
  if (!client) throw new UpnpError('AddPortMapping', null, null, 'UPnP AddPortMapping failed: unknown local address')
  const send = (lease: number) =>
    soapAction(
      gw,
      'AddPortMapping',
      [
        ['NewRemoteHost', ''],
        ['NewExternalPort', req.externalPort],
        ['NewProtocol', req.protocol],
        ['NewInternalPort', req.internalPort],
        ['NewInternalClient', client],
        ['NewEnabled', 1],
        ['NewPortMappingDescription', req.description],
        ['NewLeaseDuration', lease],
      ],
      opts,
    )
  try {
    await send(req.leaseSeconds)
    return { leaseSeconds: req.leaseSeconds }
  } catch (e) {
    if (e instanceof UpnpError && e.code === 725 && req.leaseSeconds !== 0) {
      await send(0)
      return { leaseSeconds: 0 }
    }
    throw e
  }
}

/** DeletePortMapping. Throws UpnpError (714 = no such mapping). */
export async function deletePortMapping(
  gw: Gateway,
  req: { externalPort: number; protocol: Protocol },
  opts: SoapOptions = {},
): Promise<void> {
  await soapAction(
    gw,
    'DeletePortMapping',
    [
      ['NewRemoteHost', ''],
      ['NewExternalPort', req.externalPort],
      ['NewProtocol', req.protocol],
    ],
    opts,
  )
}

export interface ExistingMapping {
  internalClient: string
  internalPort: number
  enabled: boolean
  description: string
  leaseSeconds: number
}

/**
 * GetSpecificPortMappingEntry: what the router currently forwards `externalPort/protocol` to,
 * or null if nothing (error 714). Use it to detect a port already forwarded to another machine.
 */
export async function getSpecificPortMapping(
  gw: Gateway,
  req: { externalPort: number; protocol: Protocol },
  opts: SoapOptions = {},
): Promise<ExistingMapping | null> {
  let out: Record<string, string>
  try {
    out = await soapAction(
      gw,
      'GetSpecificPortMappingEntry',
      [
        ['NewRemoteHost', ''],
        ['NewExternalPort', req.externalPort],
        ['NewProtocol', req.protocol],
      ],
      opts,
    )
  } catch (e) {
    if (e instanceof UpnpError && e.code === 714) return null
    throw e
  }
  const internalClient = out.NewInternalClient ?? ''
  if (!internalClient) return null
  return {
    internalClient,
    internalPort: Number(out.NewInternalPort) || 0,
    enabled: out.NewEnabled === '1' || /^true$/i.test(out.NewEnabled ?? ''),
    description: out.NewPortMappingDescription ?? '',
    leaseSeconds: Number(out.NewLeaseDuration) || 0,
  }
}

// ---------------------------------------------------------------------------------------------
// mapPorts: map a set of ports, renew while running, release on exit (SPEC R4)

export interface PortSpec {
  externalPort: number
  /** Defaults to `externalPort`. */
  internalPort?: number
  protocol: Protocol
}

export type MapStatus = 'mapped' | 'conflict' | 'error'

export interface PortMapOutcome {
  externalPort: number
  internalPort: number
  protocol: Protocol
  status: MapStatus
  /** Lease granted (0 = permanent) when mapped. */
  leaseSeconds?: number
  /** True when an existing mapping to our own address was found and refreshed. */
  reused?: boolean
  /** For `conflict`: the LAN address the port is already forwarded to, when known. */
  conflictWith?: string
  /** UPnP error code, when the router gave one. */
  errorCode?: number
  /** Human-readable reason for `conflict` / `error`. */
  error?: string
}

export interface MapPortsOptions {
  /** Default 3600 s. Routers that only accept permanent mappings get 0 (see addPortMapping). */
  leaseSeconds?: number
  /** Mapping description shown in the router UI; the port and protocol are appended. Default "Nexo Server". */
  description?: string
  /** LAN address to forward to; default `gw.localAddress`. */
  internalClient?: string
  /** Per SOAP request timeout, default 2000 ms. */
  timeoutMs?: number
}

export interface PortMappingSession {
  readonly gateway: Gateway
  /** Latest outcome per port (updated by renew()). */
  readonly results: PortMapOutcome[]
  /** True when every port is `mapped`. */
  readonly allMapped: boolean
  /**
   * Re-adds every port that isn't a conflict (refreshes leases; also recovers mappings lost to a
   * router reboot). Never throws; returns the new outcomes.
   */
  renew(): Promise<PortMapOutcome[]>
  /**
   * Calls renew() every `intervalMs` (default: half the lease, min 30 s; no timer for permanent
   * leases). The timer is unref'd. Returns a stop function. release() also stops it.
   */
  startAutoRenew(intervalMs?: number): () => void
  /** Deletes every mapping this session created/refreshed. Never throws. Idempotent. */
  release(): Promise<void>
}

async function mapOne(gw: Gateway, p: PortSpec, o: Required<Pick<MapPortsOptions, 'leaseSeconds' | 'description' | 'timeoutMs'>> & { internalClient: string }): Promise<PortMapOutcome> {
  const internalPort = p.internalPort ?? p.externalPort
  const base = { externalPort: p.externalPort, internalPort, protocol: p.protocol }
  let reused = false
  try {
    const existing = await getSpecificPortMapping(gw, { externalPort: p.externalPort, protocol: p.protocol }, { timeoutMs: o.timeoutMs })
    if (existing) {
      if (existing.internalClient !== o.internalClient) {
        return {
          ...base,
          status: 'conflict',
          conflictWith: existing.internalClient,
          error: `port ${p.externalPort}/${p.protocol} is already forwarded to ${existing.internalClient}`,
        }
      }
      reused = true
    }
  } catch {
    // GetSpecificPortMappingEntry is optional on some routers; just try to add.
  }
  try {
    const r = await addPortMapping(
      gw,
      {
        externalPort: p.externalPort,
        internalPort,
        protocol: p.protocol,
        internalClient: o.internalClient,
        description: `${o.description} ${p.externalPort}/${p.protocol}`,
        leaseSeconds: o.leaseSeconds,
      },
      { timeoutMs: o.timeoutMs },
    )
    return { ...base, status: 'mapped', leaseSeconds: r.leaseSeconds, ...(reused ? { reused } : {}) }
  } catch (e) {
    const err = e as Error
    const code = e instanceof UpnpError ? e.code : null
    if (code === 718) {
      return { ...base, status: 'conflict', errorCode: 718, error: `port ${p.externalPort}/${p.protocol} is already forwarded to another device` }
    }
    return { ...base, status: 'error', ...(code !== null ? { errorCode: code } : {}), error: err.message }
  }
}

/**
 * Forwards each port on the router to this machine and returns a session to renew/release them.
 * Per port: checks the existing mapping first (a port forwarded to a *different* LAN address is a
 * `conflict` and is left alone; one already pointing at us is refreshed), then AddPortMapping
 * (725 → permanent lease retry, 718 → `conflict`). Ports are mapped sequentially (cheap routers
 * dislike concurrent SOAP). Never throws.
 */
export async function mapPorts(gw: Gateway, ports: PortSpec[], opts: MapPortsOptions = {}): Promise<PortMappingSession> {
  const o = {
    leaseSeconds: opts.leaseSeconds ?? 3600,
    description: opts.description ?? 'Nexo Server',
    timeoutMs: opts.timeoutMs ?? 2000,
    internalClient: opts.internalClient ?? gw.localAddress,
  }
  let results: PortMapOutcome[] = []
  // Every port we successfully mapped at least once; release() deletes these even if a later renew failed.
  const owned = new Map<string, PortSpec>()
  const run = async (): Promise<PortMapOutcome[]> => {
    const next: PortMapOutcome[] = []
    for (const p of ports) {
      const prev = results.find((r) => r.externalPort === p.externalPort && r.protocol === p.protocol)
      if (prev && prev.status === 'conflict') {
        next.push(prev)
        continue
      }
      const outcome = await mapOne(gw, p, o)
      if (outcome.status === 'mapped') owned.set(`${p.externalPort}/${p.protocol}`, p)
      next.push(outcome)
    }
    results = next
    return next
  }
  await run()

  let timer: NodeJS.Timeout | null = null
  let released = false
  const stop = (): void => {
    if (timer) clearInterval(timer)
    timer = null
  }
  const session: PortMappingSession = {
    gateway: gw,
    get results() {
      return results
    },
    get allMapped() {
      return results.length > 0 && results.every((r) => r.status === 'mapped')
    },
    async renew() {
      if (released) return results
      try {
        return await run()
      } catch {
        return results
      }
    },
    startAutoRenew(intervalMs?: number) {
      stop()
      const lease = Math.min(...results.filter((r) => r.status === 'mapped').map((r) => r.leaseSeconds ?? o.leaseSeconds), o.leaseSeconds)
      const every = intervalMs ?? (lease > 0 ? Math.max(30, Math.floor(lease / 2)) * 1000 : 0)
      if (every <= 0 || released) return stop
      timer = setInterval(() => void session.renew(), every)
      timer.unref()
      return stop
    },
    async release() {
      stop()
      if (released) return
      released = true
      for (const p of owned.values()) {
        try {
          await deletePortMapping(gw, { externalPort: p.externalPort, protocol: p.protocol }, { timeoutMs: o.timeoutMs })
        } catch {
          // gone already, or router unreachable: nothing more we can do
        }
      }
    },
  }
  return session
}
