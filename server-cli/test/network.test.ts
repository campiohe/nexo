// Network helpers: IPv4 ranges, reachability classification, LAN / Tailscale interface detection.
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import type { NetworkInterfaceInfo } from 'node:os'
import {
  classifyReachability,
  detectTailscale,
  isCgnatRange,
  isIpv4,
  isLinkLocal,
  isPrivateIp,
  isPublicIpv4,
  lanAddresses,
  parseIpv4,
  type InterfaceMap,
} from '../src/network/index.ts'

function v4(address: string, internal = false): NetworkInterfaceInfo {
  return { address, netmask: '255.255.255.0', family: 'IPv4', mac: '00:00:00:00:00:00', internal, cidr: `${address}/24` }
}
function v6(address: string): NetworkInterfaceInfo {
  return { address, netmask: 'ffff:ffff:ffff:ffff::', family: 'IPv6', mac: '00:00:00:00:00:00', internal: false, cidr: `${address}/64`, scopeid: 0 }
}

describe('IPv4 range helpers', () => {
  const cases: Array<[string, { valid: boolean; priv: boolean; cgnat: boolean; ll: boolean; pub: boolean }]> = [
    ['192.168.1.10', { valid: true, priv: true, cgnat: false, ll: false, pub: false }],
    ['10.0.0.1', { valid: true, priv: true, cgnat: false, ll: false, pub: false }],
    ['172.16.0.1', { valid: true, priv: true, cgnat: false, ll: false, pub: false }],
    ['172.31.255.255', { valid: true, priv: true, cgnat: false, ll: false, pub: false }],
    ['172.32.0.1', { valid: true, priv: false, cgnat: false, ll: false, pub: true }],
    ['172.15.255.255', { valid: true, priv: false, cgnat: false, ll: false, pub: true }],
    ['100.64.0.1', { valid: true, priv: false, cgnat: true, ll: false, pub: false }],
    ['100.127.255.254', { valid: true, priv: false, cgnat: true, ll: false, pub: false }],
    ['100.128.0.1', { valid: true, priv: false, cgnat: false, ll: false, pub: true }],
    ['100.63.255.255', { valid: true, priv: false, cgnat: false, ll: false, pub: true }],
    ['169.254.10.20', { valid: true, priv: false, cgnat: false, ll: true, pub: false }],
    ['127.0.0.1', { valid: true, priv: false, cgnat: false, ll: false, pub: false }],
    ['8.8.8.8', { valid: true, priv: false, cgnat: false, ll: false, pub: true }],
    ['187.12.34.56', { valid: true, priv: false, cgnat: false, ll: false, pub: true }],
    ['224.0.0.1', { valid: true, priv: false, cgnat: false, ll: false, pub: false }],
    ['255.255.255.255', { valid: true, priv: false, cgnat: false, ll: false, pub: false }],
    ['0.0.0.0', { valid: true, priv: false, cgnat: false, ll: false, pub: false }],
    ['203.0.113.5', { valid: true, priv: false, cgnat: false, ll: false, pub: false }],
    ['256.1.1.1', { valid: false, priv: false, cgnat: false, ll: false, pub: false }],
    ['1.2.3', { valid: false, priv: false, cgnat: false, ll: false, pub: false }],
    ['1.2.3.4.5', { valid: false, priv: false, cgnat: false, ll: false, pub: false }],
    ['a.b.c.d', { valid: false, priv: false, cgnat: false, ll: false, pub: false }],
    ['', { valid: false, priv: false, cgnat: false, ll: false, pub: false }],
    ['::1', { valid: false, priv: false, cgnat: false, ll: false, pub: false }],
  ]
  for (const [ip, want] of cases) {
    test(`${ip || '(empty)'}`, () => {
      assert.equal(isIpv4(ip), want.valid, 'isIpv4')
      assert.equal(isPrivateIp(ip), want.priv, 'isPrivateIp')
      assert.equal(isCgnatRange(ip), want.cgnat, 'isCgnatRange')
      assert.equal(isLinkLocal(ip), want.ll, 'isLinkLocal')
      assert.equal(isPublicIpv4(ip), want.pub, 'isPublicIpv4')
    })
  }
  test('parseIpv4', () => {
    assert.equal(parseIpv4('1.2.3.4'), 0x01020304)
    assert.equal(parseIpv4('255.255.255.255'), 0xffffffff)
    assert.equal(parseIpv4('1.2.3.-4'), null)
  })
})

describe('classifyReachability', () => {
  const cases: Array<[string | null, string | null, 'public' | 'cgnat' | 'unknown', string]> = [
    ['187.12.34.56', '187.12.34.56', 'public', 'router WAN = STUN, routable'],
    ['100.72.1.2', '187.12.34.56', 'cgnat', 'router WAN in 100.64/10'],
    ['100.72.1.2', null, 'cgnat', 'router WAN in 100.64/10, no STUN'],
    ['192.168.0.2', '187.12.34.56', 'cgnat', 'router WAN private (double NAT)'],
    ['10.10.0.2', null, 'cgnat', 'router WAN private, no STUN'],
    ['187.12.34.56', '187.12.99.1', 'cgnat', 'router WAN public but differs from STUN'],
    ['187.12.34.56', null, 'unknown', 'no STUN answer'],
    [null, '187.12.34.56', 'unknown', 'no UPnP'],
    [null, null, 'unknown', 'nothing'],
    ['203.0.113.5', '203.0.113.5', 'unknown', 'equal but documentation range (not routable)'],
    ['garbage', '187.12.34.56', 'unknown', 'malformed router IP'],
  ]
  for (const [routerExternalIp, stunIp, want, why] of cases) {
    test(why, () => assert.equal(classifyReachability({ routerExternalIp, stunIp }), want))
  }
})

describe('lanAddresses', () => {
  test('keeps private IPv4 of real adapters, drops Tailscale / WSL / link-local / loopback / IPv6', () => {
    const ifaces: InterfaceMap = {
      'Loopback Pseudo-Interface 1': [v4('127.0.0.1', true)],
      Ethernet: [v6('fe80::1'), v4('192.168.1.23')],
      'Wi-Fi': [v4('169.254.3.4')],
      'vEthernet (WSL (Hyper-V firewall))': [v4('172.26.128.1')],
      'vEthernet (Default Switch)': [v4('172.20.0.1')],
      Tailscale: [v4('100.101.102.103')],
      'VirtualBox Host-Only Network': [v4('192.168.56.1')],
      eth1: [v4('10.0.0.5'), v4('8.8.4.4')],
    }
    assert.deepEqual(lanAddresses(ifaces), ['192.168.1.23', '10.0.0.5'])
  })
  test('falls back to virtual adapters when they are the only candidates (Hyper-V external switch)', () => {
    const ifaces: InterfaceMap = {
      'vEthernet (External)': [v4('192.168.0.40')],
      Tailscale: [v4('100.101.102.103')],
    }
    assert.deepEqual(lanAddresses(ifaces), ['192.168.0.40'])
  })
  test('empty when nothing qualifies', () => {
    assert.deepEqual(lanAddresses({ lo: [v4('127.0.0.1', true)] }), [])
  })
  test('accepts numeric family (old Node)', () => {
    const info = { ...v4('192.168.7.7'), family: 4 } as unknown as NetworkInterfaceInfo
    assert.deepEqual(lanAddresses({ eth0: [info] }), ['192.168.7.7'])
  })
})

describe('detectTailscale', () => {
  test('interface named Tailscale wins', async () => {
    const r = await detectTailscale({
      interfaces: { Ethernet: [v4('192.168.1.2')], Tailscale: [v4('100.90.1.2')] },
      useCli: false,
    })
    assert.deepEqual(r, { ip: '100.90.1.2', source: 'interface' })
  })
  test('tailscale0 on Linux', async () => {
    const r = await detectTailscale({ interfaces: { tailscale0: [v4('100.64.0.9')] }, useCli: false })
    assert.deepEqual(r, { ip: '100.64.0.9', source: 'interface' })
  })
  test('unnamed 100.64/10 interface is used when the CLI finds nothing', async () => {
    const r = await detectTailscale({
      interfaces: { eth0: [v4('100.70.0.1')] },
      cliPaths: ['/nonexistent/tailscale-binary'],
    })
    assert.deepEqual(r, { ip: '100.70.0.1', source: 'interface' })
  })
  test('null when nothing; missing CLI does not throw', async () => {
    const r = await detectTailscale({
      interfaces: { eth0: [v4('192.168.1.2')] },
      cliPaths: ['/nonexistent/tailscale-binary'],
    })
    assert.equal(r, null)
  })
  test('CLI output is parsed (fake tailscale script)', { skip: process.platform === 'win32' }, async () => {
    const { mkdtempSync, writeFileSync, chmodSync, rmSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const path = await import('node:path')
    const dir = mkdtempSync(path.join(tmpdir(), 'nexo-ts-'))
    try {
      const bin = path.join(dir, 'tailscale')
      writeFileSync(bin, '#!/bin/sh\n[ "$1 $2" = "ip -4" ] && echo 100.88.7.6\n')
      chmodSync(bin, 0o755)
      const r = await detectTailscale({ interfaces: {}, cliPaths: [bin] })
      assert.deepEqual(r, { ip: '100.88.7.6', source: 'cli' })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
