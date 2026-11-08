// UPnP IGD client against a fake Internet Gateway Device on 127.0.0.1 (HTTP description + SOAP
// control), plus a fake SSDP responder on unicast UDP (no multicast in tests). Also probeNetwork().
import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import { createSocket, type Socket } from 'node:dgram'
import type { AddressInfo } from 'node:net'
import {
  addPortMapping,
  deletePortMapping,
  discoverGateway,
  gatewayFromLocation,
  getExternalIp,
  getSpecificPortMapping,
  mapPorts,
  parseDeviceDescription,
  parseSsdpResponse,
  probeNetwork,
  UpnpError,
  type Gateway,
} from '../src/network/index.ts'

// ---------------------------------------------------------------------------------------------
// Fake IGD

const IP1 = 'urn:schemas-upnp-org:service:WANIPConnection:1'
const PPP1 = 'urn:schemas-upnp-org:service:WANPPPConnection:1'

function description(opts: { urlBase?: string; pppFirst?: boolean } = {}): string {
  const ipService = `
            <service>
              <serviceType>${IP1}</serviceType>
              <serviceId>urn:upnp-org:serviceId:WANIPConn1</serviceId>
              <controlURL>/ctl/IPConn</controlURL>
              <eventSubURL>/evt/IPConn</eventSubURL>
              <SCPDURL>/WANIPCn.xml</SCPDURL>
            </service>`
  const pppService = `
            <service>
              <serviceType>${PPP1}</serviceType>
              <serviceId>urn:upnp-org:serviceId:WANPPPConn1</serviceId>
              <controlURL>ctl/PPPConn</controlURL>
              <eventSubURL>/evt/PPPConn</eventSubURL>
              <SCPDURL>/WANPPPCn.xml</SCPDURL>
            </service>`
  return `<?xml version="1.0"?>
<root xmlns="urn:schemas-upnp-org:device-1-0">
  <specVersion><major>1</major><minor>0</minor></specVersion>
  ${opts.urlBase ? `<URLBase>${opts.urlBase}</URLBase>` : ''}
  <device>
    <deviceType>urn:schemas-upnp-org:device:InternetGatewayDevice:1</deviceType>
    <friendlyName>Fake Router &amp; Co</friendlyName>
    <manufacturer>Nexo Tests</manufacturer>
    <serviceList>
      <service>
        <serviceType>urn:schemas-upnp-org:service:Layer3Forwarding:1</serviceType>
        <serviceId>urn:upnp-org:serviceId:L3Forwarding1</serviceId>
        <controlURL>/ctl/L3F</controlURL>
        <eventSubURL>/evt/L3F</eventSubURL>
        <SCPDURL>/L3F.xml</SCPDURL>
      </service>
    </serviceList>
    <deviceList>
      <device>
        <deviceType>urn:schemas-upnp-org:device:WANDevice:1</deviceType>
        <serviceList>
          <service>
            <serviceType>urn:schemas-upnp-org:service:WANCommonInterfaceConfig:1</serviceType>
            <serviceId>urn:upnp-org:serviceId:WANCommonIFC1</serviceId>
            <controlURL>/ctl/CmnIfCfg</controlURL>
            <eventSubURL>/evt/CmnIfCfg</eventSubURL>
            <SCPDURL>/WANCfg.xml</SCPDURL>
          </service>
        </serviceList>
        <deviceList>
          <device>
            <deviceType>urn:schemas-upnp-org:device:WANConnectionDevice:1</deviceType>
            <serviceList>${opts.pppFirst ? pppService + ipService : ipService}
            </serviceList>
          </device>
        </deviceList>
      </device>
    </deviceList>
  </device>
</root>`
}

interface Mapping {
  client: string
  internalPort: number
  description: string
  lease: number
}

interface FakeIgd {
  url: string
  port: number
  mappings: Map<string, Mapping>
  calls: Array<{ path: string; action: string; args: Record<string, string> }>
  /** Behaviour switches. */
  externalIp: string
  onlyPermanent: boolean
  denyAll: boolean
  ipConnBroken: boolean
  descriptionOpts: { urlBase?: string; pppFirst?: boolean }
  server: Server
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
  })
}

function soapFault(code: number, desc: string): string {
  // Prefixed envelope, unprefixed UPnPError with default namespace and whitespace, like real routers.
  return `<?xml version="1.0"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">
  <s:Body>
    <s:Fault>
      <faultcode>s:Client</faultcode>
      <faultstring>UPnPError</faultstring>
      <detail>
        <UPnPError xmlns="urn:schemas-upnp-org:control-1-0">
          <errorCode> ${code} </errorCode>
          <errorDescription>${desc}</errorDescription>
        </UPnPError>
      </detail>
    </s:Fault>
  </s:Body>
</s:Envelope>`
}

function soapOk(action: string, serviceType: string, out: Record<string, string | number>): string {
  const args = Object.entries(out)
    .map(([k, v]) => `\n      <${k}>${v}</${k}>`)
    .join('')
  return `<?xml version="1.0"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">
  <s:Body>
    <u:${action}Response xmlns:u="${serviceType}">${args}
    </u:${action}Response>
  </s:Body>
</s:Envelope>`
}

async function startFakeIgd(): Promise<FakeIgd> {
  const igd = {
    url: '',
    port: 0,
    mappings: new Map<string, Mapping>(),
    calls: [] as FakeIgd['calls'],
    externalIp: '187.12.34.56',
    onlyPermanent: false,
    denyAll: false,
    ipConnBroken: false,
    descriptionOpts: {},
  } as unknown as FakeIgd
  igd.server = createServer(async (req, res) => {
    const body = await readBody(req)
    const send = (status: number, xml: string): void => {
      res.writeHead(status, { 'Content-Type': 'text/xml; charset="utf-8"' })
      res.end(xml)
    }
    if (req.method === 'GET' && req.url === '/rootDesc.xml') return send(200, description(igd.descriptionOpts))
    if (req.method !== 'POST' || !req.url?.startsWith('/ctl/')) return send(404, '')
    const soapAction = String(req.headers.soapaction ?? '').replace(/"/g, '')
    const [serviceType, action] = soapAction.split('#')
    const args: Record<string, string> = {}
    for (const m of body.matchAll(/<(New\w+)>([^<]*)<\/\1>/g)) args[m[1]] = m[2]
    igd.calls.push({ path: req.url, action, args })
    // Content-Length must be explicit (some routers reject chunked request bodies).
    if (!req.headers['content-length']) return send(400, 'no content-length')
    if (req.url === '/ctl/IPConn' && igd.ipConnBroken) return send(500, soapFault(501, 'ActionFailed'))
    if (igd.denyAll && action !== 'GetExternalIPAddress') return send(500, soapFault(606, 'Action not authorized'))
    const key = `${args.NewExternalPort}/${args.NewProtocol}`
    switch (action) {
      case 'GetExternalIPAddress':
        return send(200, soapOk(action, serviceType, { NewExternalIPAddress: igd.externalIp }))
      case 'GetSpecificPortMappingEntry': {
        const m = igd.mappings.get(key)
        if (!m) return send(500, soapFault(714, 'NoSuchEntryInArray'))
        return send(
          200,
          soapOk(action, serviceType, {
            NewInternalPort: m.internalPort,
            NewInternalClient: m.client,
            NewEnabled: 1,
            NewPortMappingDescription: m.description,
            NewLeaseDuration: m.lease,
          }),
        )
      }
      case 'AddPortMapping': {
        const lease = Number(args.NewLeaseDuration)
        if (igd.onlyPermanent && lease !== 0) return send(500, soapFault(725, 'OnlyPermanentLeasesSupported'))
        const existing = igd.mappings.get(key)
        if (existing && existing.client !== args.NewInternalClient) return send(500, soapFault(718, 'ConflictInMappingEntry'))
        igd.mappings.set(key, {
          client: args.NewInternalClient,
          internalPort: Number(args.NewInternalPort),
          description: args.NewPortMappingDescription,
          lease,
        })
        return send(200, soapOk(action, serviceType, {}))
      }
      case 'DeletePortMapping':
        if (!igd.mappings.delete(key)) return send(500, soapFault(714, 'NoSuchEntryInArray'))
        return send(200, soapOk(action, serviceType, {}))
      default:
        return send(500, soapFault(401, 'Invalid Action'))
    }
  })
  await new Promise<void>((r) => igd.server.listen(0, '127.0.0.1', () => r()))
  igd.port = (igd.server.address() as AddressInfo).port
  igd.url = `http://127.0.0.1:${igd.port}/rootDesc.xml`
  return igd
}

/** Unicast SSDP responder: answers any M-SEARCH with the given LOCATION (plus a noise reply first). */
function startFakeSsdp(location: string): Promise<{ port: number; searches: string[]; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const sock: Socket = createSocket('udp4')
    const searches: string[] = []
    sock.on('message', (msg, rinfo) => {
      const text = msg.toString()
      if (!text.startsWith('M-SEARCH')) return
      const st = /^ST:\s*(.+?)\r$/im.exec(text)?.[1] ?? ''
      searches.push(st)
      // A media server answering too: must be ignored.
      sock.send(
        Buffer.from('HTTP/1.1 200 OK\r\nST: urn:schemas-upnp-org:device:MediaServer:1\r\nLOCATION: http://127.0.0.1:1/nope.xml\r\n\r\n'),
        rinfo.port,
        rinfo.address,
      )
      sock.send(
        Buffer.from(
          `HTTP/1.1 200 OK\r\nCACHE-CONTROL: max-age=120\r\nST: ${st}\r\nUSN: uuid:fake::${st}\r\nEXT:\r\nSERVER: Fake/1.0 UPnP/1.1 MiniUPnPd/2.3\r\nLocation: ${location}\r\n\r\n`,
        ),
        rinfo.port,
        rinfo.address,
      )
    })
    sock.bind(0, '127.0.0.1', () =>
      resolve({ port: sock.address().port, searches, close: () => new Promise((r) => sock.close(() => r())) }),
    )
  })
}

// ---------------------------------------------------------------------------------------------

describe('SSDP / description parsing', () => {
  test('parseSsdpResponse: headers are case-insensitive', () => {
    const r = parseSsdpResponse(
      'HTTP/1.1 200 OK\r\nCache-Control: max-age=1800\r\nst: urn:schemas-upnp-org:device:InternetGatewayDevice:1\r\nusn: uuid:abc::urn:schemas-upnp-org:device:InternetGatewayDevice:1\r\nLOCATION: http://192.168.1.1:5000/rootDesc.xml\r\nServer: Linux UPnP/1.0\r\n\r\n',
    )
    assert.deepEqual(r, {
      location: 'http://192.168.1.1:5000/rootDesc.xml',
      st: 'urn:schemas-upnp-org:device:InternetGatewayDevice:1',
      usn: 'uuid:abc::urn:schemas-upnp-org:device:InternetGatewayDevice:1',
      server: 'Linux UPnP/1.0',
    })
  })
  test('parseSsdpResponse: rejects non-200, missing or non-http LOCATION', () => {
    assert.equal(parseSsdpResponse('HTTP/1.1 404 Not Found\r\nLOCATION: http://x/\r\n\r\n'), null)
    assert.equal(parseSsdpResponse('HTTP/1.1 200 OK\r\nST: x\r\n\r\n'), null)
    assert.equal(parseSsdpResponse('HTTP/1.1 200 OK\r\nLOCATION: https://x/desc.xml\r\n\r\n'), null)
    assert.equal(parseSsdpResponse('M-SEARCH * HTTP/1.1\r\n\r\n'), null)
  })
  test('parseDeviceDescription: finds WAN services in nested devices, resolves relative URLs, prefers IP over PPP', () => {
    const { friendlyName, services } = parseDeviceDescription(description({ pppFirst: true }), 'http://192.168.1.1:5000/desc/rootDesc.xml')
    assert.equal(friendlyName, 'Fake Router & Co')
    assert.deepEqual(services, [
      { serviceType: IP1, controlUrl: 'http://192.168.1.1:5000/ctl/IPConn' },
      { serviceType: PPP1, controlUrl: 'http://192.168.1.1:5000/desc/ctl/PPPConn' },
    ])
  })
  test('parseDeviceDescription: honours URLBase and namespace prefixes', () => {
    const xml = description({ urlBase: 'http://192.168.0.1:49152/' }).replace(/<(\/?)service>/g, '<$1u:service>')
    const { services } = parseDeviceDescription(xml, 'http://192.168.0.1:1900/whatever.xml')
    assert.equal(services[0].controlUrl, 'http://192.168.0.1:49152/ctl/IPConn')
  })
  test('parseDeviceDescription: no WAN service → empty', () => {
    const xml = '<root><device><serviceList><service><serviceType>urn:schemas-upnp-org:service:ContentDirectory:1</serviceType><controlURL>/c</controlURL></service></serviceList></device></root>'
    assert.deepEqual(parseDeviceDescription(xml, 'http://h/').services, [])
  })
})

describe('UPnP against a fake IGD', () => {
  let igd: FakeIgd
  let gw: Gateway
  before(async () => {
    igd = await startFakeIgd()
  })
  after(() => igd.server.close())

  test('gatewayFromLocation fetches the description and records our local address', async () => {
    const g = await gatewayFromLocation(igd.url)
    assert.ok(g)
    gw = g
    assert.equal(gw.controlUrl, `http://127.0.0.1:${igd.port}/ctl/IPConn`)
    assert.equal(gw.serviceType, IP1)
    assert.equal(gw.localAddress, '127.0.0.1')
    assert.equal(gw.friendlyName, 'Fake Router & Co')
  })

  test('picks the WAN service that actually answers when the preferred one is broken', async () => {
    igd.ipConnBroken = true
    igd.descriptionOpts = { pppFirst: true }
    try {
      const g = await gatewayFromLocation(igd.url)
      assert.equal(g?.serviceType, PPP1)
      assert.equal(g?.controlUrl, `http://127.0.0.1:${igd.port}/ctl/PPPConn`)
    } finally {
      igd.ipConnBroken = false
      igd.descriptionOpts = {}
    }
  })

  test('getExternalIp', async () => {
    assert.equal(await getExternalIp(gw), '187.12.34.56')
    igd.externalIp = '0.0.0.0'
    assert.equal(await getExternalIp(gw), null)
    igd.externalIp = '187.12.34.56'
  })

  test('add / get / delete a mapping', async () => {
    const r = await addPortMapping(gw, {
      externalPort: 3001,
      internalPort: 3001,
      protocol: 'TCP',
      internalClient: '192.168.1.23',
      description: 'Nexo <test> & co',
      leaseSeconds: 3600,
    })
    assert.deepEqual(r, { leaseSeconds: 3600 })
    const call = igd.calls.at(-1)
    assert.equal(call?.action, 'AddPortMapping')
    assert.equal(call?.args.NewPortMappingDescription, 'Nexo &lt;test&gt; &amp; co', 'description is XML-escaped')
    assert.equal(call?.args.NewRemoteHost, '', 'empty remote host sent')
    assert.equal(call?.args.NewEnabled, '1')

    const m = await getSpecificPortMapping(gw, { externalPort: 3001, protocol: 'TCP' })
    assert.deepEqual(m, { internalClient: '192.168.1.23', internalPort: 3001, enabled: true, description: 'Nexo <test> & co', leaseSeconds: 3600 })
    assert.equal(await getSpecificPortMapping(gw, { externalPort: 3001, protocol: 'UDP' }), null, '714 → null')

    await deletePortMapping(gw, { externalPort: 3001, protocol: 'TCP' })
    assert.equal(igd.mappings.size, 0)
    await assert.rejects(deletePortMapping(gw, { externalPort: 3001, protocol: 'TCP' }), (e: unknown) => e instanceof UpnpError && e.code === 714)
  })

  test('internalClient defaults to the gateway localAddress', async () => {
    await addPortMapping(gw, { externalPort: 4000, internalPort: 4001, protocol: 'UDP', description: 'x', leaseSeconds: 60 })
    assert.equal(igd.mappings.get('4000/UDP')?.client, '127.0.0.1')
    igd.mappings.clear()
  })

  test('725 OnlyPermanentLeasesSupported → retried with lease 0', async () => {
    igd.onlyPermanent = true
    try {
      const r = await addPortMapping(gw, { externalPort: 7880, internalPort: 7880, protocol: 'TCP', description: 'x', leaseSeconds: 3600 })
      assert.deepEqual(r, { leaseSeconds: 0 })
      assert.equal(igd.mappings.get('7880/TCP')?.lease, 0)
    } finally {
      igd.onlyPermanent = false
      igd.mappings.clear()
    }
  })

  test('718 ConflictInMappingEntry → UpnpError.isConflict with a clear message', async () => {
    igd.mappings.set('7882/UDP', { client: '192.168.1.50', internalPort: 7882, description: 'someone else', lease: 0 })
    try {
      await assert.rejects(
        addPortMapping(gw, { externalPort: 7882, internalPort: 7882, protocol: 'UDP', description: 'x', leaseSeconds: 60 }),
        (e: unknown) => {
          assert.ok(e instanceof UpnpError)
          assert.equal(e.code, 718)
          assert.ok(e.isConflict)
          assert.match(e.message, /already forwarded to another device/)
          return true
        },
      )
    } finally {
      igd.mappings.clear()
    }
  })

  test('606 → isNotAuthorized', async () => {
    igd.denyAll = true
    try {
      await assert.rejects(
        addPortMapping(gw, { externalPort: 1, internalPort: 1, protocol: 'TCP', description: 'x', leaseSeconds: 60 }),
        (e: unknown) => e instanceof UpnpError && e.isNotAuthorized && /does not allow/.test(e.message),
      )
    } finally {
      igd.denyAll = false
    }
  })

  test('transport errors become UpnpError with code null', async () => {
    const dead: Gateway = { ...gw, controlUrl: 'http://127.0.0.1:1/ctl/IPConn' }
    await assert.rejects(getExternalIp(dead, { timeoutMs: 500 }), (e: unknown) => e instanceof UpnpError && e.code === null)
  })

  test('mapPorts: maps, reuses our own mapping, reports conflicts, renews and releases', async () => {
    igd.mappings.set('7882/UDP', { client: '192.168.1.50', internalPort: 7882, description: 'other PC', lease: 0 })
    igd.mappings.set('7880/TCP', { client: '127.0.0.1', internalPort: 7880, description: 'Nexo Server 7880/TCP', lease: 100 })
    const session = await mapPorts(
      gw,
      [
        { externalPort: 3001, protocol: 'TCP' },
        { externalPort: 7880, protocol: 'TCP' },
        { externalPort: 7881, internalPort: 17881, protocol: 'TCP' },
        { externalPort: 7882, protocol: 'UDP' },
      ],
      { leaseSeconds: 1800, description: 'Nexo Server' },
    )
    const byPort = Object.fromEntries(session.results.map((r) => [`${r.externalPort}/${r.protocol}`, r]))
    assert.equal(byPort['3001/TCP'].status, 'mapped')
    assert.equal(byPort['3001/TCP'].leaseSeconds, 1800)
    assert.equal(byPort['7880/TCP'].status, 'mapped')
    assert.equal(byPort['7880/TCP'].reused, true)
    assert.equal(byPort['7881/TCP'].internalPort, 17881)
    assert.equal(igd.mappings.get('7881/TCP')?.internalPort, 17881)
    assert.equal(byPort['7882/UDP'].status, 'conflict')
    assert.equal(byPort['7882/UDP'].conflictWith, '192.168.1.50')
    assert.equal(session.allMapped, false)
    assert.equal(igd.mappings.get('3001/TCP')?.description, 'Nexo Server 3001/TCP')
    assert.equal(igd.mappings.get('7880/TCP')?.lease, 1800, 'own mapping refreshed')

    // Router reboot loses our mappings; renew() restores them, conflict stays untouched.
    igd.mappings.delete('3001/TCP')
    const renewed = await session.renew()
    assert.equal(renewed.find((r) => r.externalPort === 3001)?.status, 'mapped')
    assert.ok(igd.mappings.has('3001/TCP'))
    assert.equal(igd.mappings.get('7882/UDP')?.client, '192.168.1.50')

    const stop = session.startAutoRenew(60_000)
    assert.equal(typeof stop, 'function')

    await session.release()
    assert.deepEqual([...igd.mappings.keys()], ['7882/UDP'], 'only the foreign mapping is left')
    await session.release() // idempotent
    igd.mappings.clear()
  })

  test('mapPorts: router denies everything → per-port errors, never throws', async () => {
    igd.denyAll = true
    try {
      const s = await mapPorts(gw, [{ externalPort: 3001, protocol: 'TCP' }])
      assert.equal(s.results[0].status, 'error')
      assert.equal(s.results[0].errorCode, 606)
      await s.release()
    } finally {
      igd.denyAll = false
    }
  })

  test('mapPorts: permanent-only router', async () => {
    igd.onlyPermanent = true
    try {
      const s = await mapPorts(gw, [{ externalPort: 3001, protocol: 'TCP' }], { leaseSeconds: 600 })
      assert.equal(s.results[0].status, 'mapped')
      assert.equal(s.results[0].leaseSeconds, 0)
      const stop = s.startAutoRenew() // no timer needed for permanent leases
      stop()
      await s.release()
      assert.equal(igd.mappings.size, 0)
    } finally {
      igd.onlyPermanent = false
    }
  })

  describe('discoverGateway via a unicast fake SSDP responder', () => {
    let ssdp: Awaited<ReturnType<typeof startFakeSsdp>>
    before(async () => {
      ssdp = await startFakeSsdp(igd.url)
    })
    after(() => ssdp.close())

    test('finds the gateway, ignoring non-IGD responses', async () => {
      const started = Date.now()
      const g = await discoverGateway({ ssdpAddress: '127.0.0.1', ssdpPort: ssdp.port, timeoutMs: 2000 })
      assert.equal(g?.controlUrl, `http://127.0.0.1:${igd.port}/ctl/IPConn`)
      assert.ok(Date.now() - started < 1500, 'resolves as soon as a gateway is found')
      assert.ok(ssdp.searches.includes('urn:schemas-upnp-org:device:InternetGatewayDevice:1'))
      assert.ok(ssdp.searches.includes('urn:schemas-upnp-org:service:WANIPConnection:1'))
    })

    test('nobody answering → null within the timeout', async () => {
      const silent = createSocket('udp4')
      await new Promise<void>((r) => silent.bind(0, '127.0.0.1', () => r()))
      try {
        const started = Date.now()
        const g = await discoverGateway({ ssdpAddress: '127.0.0.1', ssdpPort: silent.address().port, timeoutMs: 600 })
        assert.equal(g, null)
        assert.ok(Date.now() - started < 1200)
      } finally {
        silent.close()
      }
    })

    test('probeNetwork puts it all together', async () => {
      const stun = createSocket('udp4')
      stun.on('message', (msg, rinfo) => {
        const tid = msg.subarray(8, 20)
        const v = Buffer.alloc(8)
        v[1] = 1
        v.writeUInt16BE(1234 ^ 0x2112, 2)
        v.writeUInt32BE((((187 << 24) | (12 << 16) | (34 << 8) | 56) ^ 0x2112a442) >>> 0, 4)
        const out = Buffer.alloc(32)
        out.writeUInt16BE(0x0101, 0)
        out.writeUInt16BE(12, 2)
        out.writeUInt32BE(0x2112a442, 4)
        tid.copy(out, 8)
        out.writeUInt16BE(0x0020, 20)
        out.writeUInt16BE(8, 22)
        v.copy(out, 24)
        stun.send(out, rinfo.port, rinfo.address)
      })
      await new Promise<void>((r) => stun.bind(0, '127.0.0.1', () => r()))
      try {
        const base = {
          stun: { servers: [`127.0.0.1:${stun.address().port}`] },
          upnp: { ssdpAddress: '127.0.0.1', ssdpPort: ssdp.port },
          tailscale: { useCli: false, interfaces: {} },
        }
        const p = await probeNetwork(base)
        assert.equal(p.stunIp, '187.12.34.56')
        assert.equal(p.gateway.found, true)
        assert.equal(p.gateway.externalIp, '187.12.34.56')
        assert.equal(p.reachability, 'public')
        assert.equal(p.tailscale, null)
        assert.equal(p.mapping, null, 'no mapping unless asked')
        assert.ok(p.elapsedMs < 5000)

        igd.externalIp = '100.72.1.2'
        const cg = await probeNetwork(base)
        assert.equal(cg.reachability, 'cgnat')
        assert.ok(cg.notes.some((n) => /carrier-grade NAT/.test(n)))
        igd.externalIp = '187.12.34.56'

        const mapped = await probeNetwork({ ...base, mapPorts: { ports: [{ externalPort: 3001, protocol: 'TCP' }] } })
        assert.equal(mapped.mapping?.results[0].status, 'mapped')
        await mapped.mapping?.release()
        assert.equal(igd.mappings.size, 0)
      } finally {
        stun.close()
      }
    })

    test('probeNetwork with nothing reachable stays within budget and never throws', async () => {
      const started = Date.now()
      const p = await probeNetwork({
        timeoutMs: 1000,
        stun: { servers: ['127.0.0.1:9'], timeoutMs: 400 },
        upnp: { ssdpAddress: '127.0.0.1', ssdpPort: 9, timeoutMs: 400 },
        tailscale: { useCli: false, interfaces: {} },
      })
      assert.ok(Date.now() - started < 1500)
      assert.equal(p.reachability, 'unknown')
      assert.equal(p.gateway.found, false)
      assert.ok(p.notes.some((n) => /STUN/.test(n)))
      assert.ok(p.notes.some((n) => /UPnP/.test(n)))
    })
  })
})
