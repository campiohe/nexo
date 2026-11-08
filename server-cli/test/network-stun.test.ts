// STUN client: packet encode/decode and a fake STUN server on 127.0.0.1.
import { after, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { createSocket, type Socket } from 'node:dgram'
import { randomBytes } from 'node:crypto'
import { decodeBindingResponse, encodeBindingRequest, stunPublicIp, stunQuery } from '../src/network/index.ts'

const COOKIE = 0x2112a442

function attr(type: number, value: Buffer): Buffer {
  const pad = (4 - (value.length % 4)) % 4
  const b = Buffer.alloc(4 + value.length + pad)
  b.writeUInt16BE(type, 0)
  b.writeUInt16BE(value.length, 2)
  value.copy(b, 4)
  return b
}

function ipv4Bytes(ip: string): number {
  return ip.split('.').reduce((n, p) => n * 256 + Number(p), 0)
}

function xorMapped(ip: string, port: number): Buffer {
  const v = Buffer.alloc(8)
  v[1] = 0x01
  v.writeUInt16BE(port ^ (COOKIE >>> 16), 2)
  v.writeUInt32BE((ipv4Bytes(ip) ^ COOKIE) >>> 0, 4)
  return attr(0x0020, v)
}

function mapped(ip: string, port: number): Buffer {
  const v = Buffer.alloc(8)
  v[1] = 0x01
  v.writeUInt16BE(port, 2)
  v.writeUInt32BE(ipv4Bytes(ip), 4)
  return attr(0x0001, v)
}

function response(tid: Buffer, attrs: Buffer[], type = 0x0101): Buffer {
  const body = Buffer.concat(attrs)
  const h = Buffer.alloc(20)
  h.writeUInt16BE(type, 0)
  h.writeUInt16BE(body.length, 2)
  h.writeUInt32BE(COOKIE, 4)
  tid.copy(h, 8)
  return Buffer.concat([h, body])
}

describe('STUN packets', () => {
  test('Binding Request layout', () => {
    const tid = Buffer.from('0102030405060708090a0b0c', 'hex')
    const req = encodeBindingRequest(tid)
    assert.equal(req.length, 20)
    assert.equal(req.readUInt16BE(0), 0x0001)
    assert.equal(req.readUInt16BE(2), 0)
    assert.equal(req.readUInt32BE(4), COOKIE)
    assert.ok(req.subarray(8).equals(tid))
    assert.throws(() => encodeBindingRequest(Buffer.alloc(11)))
  })

  test('decodes XOR-MAPPED-ADDRESS (IPv4)', () => {
    const tid = randomBytes(12)
    const r = decodeBindingResponse(response(tid, [xorMapped('187.12.34.56', 54321)]), tid)
    assert.deepEqual(r, { family: 'IPv4', address: '187.12.34.56', port: 54321 })
  })

  test('prefers XOR-MAPPED-ADDRESS over MAPPED-ADDRESS, skips unknown attributes with padding', () => {
    const tid = randomBytes(12)
    const software = attr(0x8022, Buffer.from('fake stun 1')) // 11 bytes → 1 byte padding
    const msg = response(tid, [software, mapped('10.0.0.1', 1), xorMapped('198.51.100.9', 40000)])
    assert.deepEqual(decodeBindingResponse(msg, tid), { family: 'IPv4', address: '198.51.100.9', port: 40000 })
  })

  test('falls back to MAPPED-ADDRESS (old servers)', () => {
    const tid = randomBytes(12)
    assert.deepEqual(decodeBindingResponse(response(tid, [mapped('203.0.113.77', 3478)]), tid), {
      family: 'IPv4',
      address: '203.0.113.77',
      port: 3478,
    })
  })

  test('decodes XOR-MAPPED-ADDRESS (IPv6)', () => {
    const tid = randomBytes(12)
    const ip = Buffer.from('20010db8000000000000000000000001', 'hex')
    const key = Buffer.concat([Buffer.from([0x21, 0x12, 0xa4, 0x42]), tid])
    const x = Buffer.alloc(16)
    for (let i = 0; i < 16; i++) x[i] = ip[i] ^ key[i]
    const v = Buffer.concat([Buffer.from([0, 0x02, (5000 ^ 0x2112) >> 8, (5000 ^ 0x2112) & 255]), x])
    assert.deepEqual(decodeBindingResponse(response(tid, [attr(0x0020, v)]), tid), {
      family: 'IPv6',
      address: '2001:db8:0:0:0:0:0:1',
      port: 5000,
    })
  })

  test('rejects wrong transaction id, wrong type, bad cookie, truncation', () => {
    const tid = randomBytes(12)
    const good = response(tid, [xorMapped('187.12.34.56', 1)])
    assert.equal(decodeBindingResponse(good, randomBytes(12)), null, 'wrong tid')
    assert.equal(decodeBindingResponse(response(tid, [xorMapped('1.2.3.4', 1)], 0x0111), tid), null, 'error response')
    const badCookie = Buffer.from(good)
    badCookie.writeUInt32BE(0xdeadbeef, 4)
    assert.equal(decodeBindingResponse(badCookie, tid), null, 'cookie')
    assert.equal(decodeBindingResponse(good.subarray(0, 19), tid), null, 'short header')
    assert.equal(decodeBindingResponse(good.subarray(0, 26), tid), null, 'truncated attribute')
    assert.equal(decodeBindingResponse(response(tid, []), tid), null, 'no address')
  })
})

interface FakeStun {
  port: number
  requests: number
  close: () => Promise<void>
}

/** UDP STUN server on 127.0.0.1. `behave` decides what to send for the n-th request (0-based). */
function fakeStun(behave: (tid: Buffer, n: number) => Buffer[] | null): Promise<FakeStun> {
  return new Promise((resolve) => {
    const sock: Socket = createSocket('udp4')
    const state: FakeStun = {
      port: 0,
      requests: 0,
      close: () => new Promise((r) => sock.close(() => r())),
    }
    sock.on('message', (msg, rinfo) => {
      if (msg.length < 20 || msg.readUInt16BE(0) !== 0x0001) return
      const tid = Buffer.from(msg.subarray(8, 20))
      const out = behave(tid, state.requests++)
      for (const p of out ?? []) sock.send(p, rinfo.port, rinfo.address)
    })
    sock.bind(0, '127.0.0.1', () => {
      state.port = sock.address().port
      resolve(state)
    })
  })
}

describe('stunPublicIp against a fake server', () => {
  const servers: FakeStun[] = []
  after(async () => {
    for (const s of servers) await s.close()
  })

  test('answers with the XOR-mapped address; a wrong-tid packet first is ignored', async () => {
    const s = await fakeStun((tid) => [response(randomBytes(12), [xorMapped('6.6.6.6', 1)]), response(tid, [xorMapped('187.12.34.56', 50000)])])
    servers.push(s)
    const r = await stunQuery({ servers: [`127.0.0.1:${s.port}`], timeoutMs: 1500 })
    assert.deepEqual(r, { address: '187.12.34.56', port: 50000, server: `127.0.0.1:${s.port}` })
  })

  test('retransmits when the first request is lost', async () => {
    const s = await fakeStun((tid, n) => (n === 0 ? null : [response(tid, [xorMapped('187.12.0.1', 1234)])]))
    servers.push(s)
    const ip = await stunPublicIp({ servers: [{ host: '127.0.0.1', port: s.port }], timeoutMs: 2000, retryMs: 100 })
    assert.equal(ip, '187.12.0.1')
    assert.ok(s.requests >= 2)
  })

  test('first answer wins across servers (a silent server does not block)', async () => {
    const silent = await fakeStun(() => null)
    const fast = await fakeStun((tid) => [response(tid, [xorMapped('187.1.2.3', 9)])])
    servers.push(silent, fast)
    const started = Date.now()
    const ip = await stunPublicIp({ servers: [`127.0.0.1:${silent.port}`, `127.0.0.1:${fast.port}`], timeoutMs: 2000 })
    assert.equal(ip, '187.1.2.3')
    assert.ok(Date.now() - started < 1000)
  })

  test('times out to null when nobody answers correctly', async () => {
    const s = await fakeStun(() => [response(randomBytes(12), [xorMapped('6.6.6.6', 1)])])
    servers.push(s)
    const started = Date.now()
    const ip = await stunPublicIp({ servers: [`127.0.0.1:${s.port}`], timeoutMs: 400, retryMs: 100 })
    assert.equal(ip, null)
    assert.ok(Date.now() - started < 1000)
  })

  test('unresolvable host → null, no throw', async () => {
    const ip = await stunPublicIp({ servers: ['nonexistent.invalid:3478'], timeoutMs: 500 })
    assert.equal(ip, null)
  })
})
