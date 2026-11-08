import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { acquireInstance, isProcessAlive, readLock, runningInstance } from '../src/cli/instance.ts'
import { dataLayout } from '../src/cli/paths.ts'

const ports = { http: 3001, livekit: 7880, livekitTcp: 7881, livekitUdp: 7882 }
const tmp = () => mkdtempSync(path.join(tmpdir(), 'nexo-cli-lock-'))

test('isProcessAlive: this process yes, nonsense no', () => {
  assert.equal(isProcessAlive(process.pid), true)
  assert.equal(isProcessAlive(0), false)
  assert.equal(isProcessAlive(-5), false)
  assert.equal(isProcessAlive(2 ** 22 + 12345), false) // above Linux pid_max
})

test('acquire: writes PID, ports and start time; release removes it', () => {
  const dir = tmp()
  try {
    const r = acquireInstance(dir, { version: '0.5.0', ports, now: () => new Date('2026-11-08T12:00:00Z') })
    assert.ok(r.ok)
    const info = readLock(dir)
    assert.deepEqual(info, { pid: process.pid, startedAt: '2026-11-08T12:00:00.000Z', version: '0.5.0', ports })
    assert.equal(r.lock.update({ stats: { online: 2, inVoice: 1, streaming: 0, updatedAt: 'now' } }), true)
    assert.equal(readLock(dir)?.stats?.online, 2)
    r.lock.release()
    assert.equal(existsSync(dataLayout(dir).lock), false)
    r.lock.release() // twice is fine
    assert.equal(r.lock.update({}), false) // no-op after release
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('second acquire while the holder is alive reports alreadyRunning', () => {
  const dir = tmp()
  try {
    const first = acquireInstance(dir, { version: '0.5.0', ports, pid: 4242, isAlive: () => true })
    assert.ok(first.ok)
    const second = acquireInstance(dir, { version: '0.5.0', ports, pid: 5555, isAlive: () => true })
    assert.equal(second.ok, false)
    if (!second.ok) {
      assert.equal(second.alreadyRunning.pid, 4242)
      assert.deepEqual(second.alreadyRunning.ports, ports)
    }
    assert.equal(runningInstance(dir, () => true)?.pid, 4242)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('stale lock (PID not running) is taken over', () => {
  const dir = tmp()
  try {
    const old = acquireInstance(dir, { version: '0.4.0', ports, pid: 4242, isAlive: () => true })
    assert.ok(old.ok)
    assert.equal(runningInstance(dir, () => false), null)
    const next = acquireInstance(dir, { version: '0.5.0', ports, pid: 5555, isAlive: () => false })
    assert.ok(next.ok)
    if (next.ok) {
      assert.equal(next.tookOver?.pid, 4242)
      assert.equal(readLock(dir)?.pid, 5555)
      // the old holder's release must not delete the new lock
      old.lock.release()
      assert.equal(readLock(dir)?.pid, 5555)
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('garbage lock file is treated as stale', () => {
  const dir = tmp()
  try {
    writeFileSync(dataLayout(dir).lock, 'not json')
    const r = acquireInstance(dir, { version: '0.5.0', ports })
    assert.ok(r.ok)
    assert.equal(JSON.parse(readFileSync(dataLayout(dir).lock, 'utf8')).pid, process.pid)
    if (r.ok) r.lock.release()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
