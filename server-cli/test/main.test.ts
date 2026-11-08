import assert from 'node:assert/strict'
import { test } from 'node:test'
import { isOutsideAddress, planNetwork } from '../src/main.ts'

const ts = { tailscale: { ip: '100.92.91.93', source: 'interface' as const } }
const noTs = { tailscale: null }

test('planNetwork: auto prefers Tailscale and opens no router ports when it runs', () => {
  assert.deepEqual(planNetwork('auto', ts), { useExternalIp: false, mapPorts: false })
  assert.deepEqual(planNetwork('auto', noTs), { useExternalIp: true, mapPorts: true })
})

test('planNetwork: forced modes', () => {
  assert.deepEqual(planNetwork('tailscale', ts), { nodeIp: '100.92.91.93', useExternalIp: false, mapPorts: false })
  assert.deepEqual(planNetwork('tailscale', noTs), { nodeIp: undefined, useExternalIp: false, mapPorts: false })
  assert.deepEqual(planNetwork('public', ts), { useExternalIp: true, mapPorts: true })
  assert.deepEqual(planNetwork('lan', noTs), { useExternalIp: false, mapPorts: false })
})

test('isOutsideAddress: loopback and LAN are not outside; Tailscale and public are', () => {
  for (const a of ['127.0.0.1', '::1', '192.168.15.4', '10.0.0.7', '172.20.1.1', '']) assert.equal(isOutsideAddress(a), false, a)
  for (const a of ['100.92.91.93', '187.12.34.56']) assert.equal(isOutsideAddress(a), true, a)
})
