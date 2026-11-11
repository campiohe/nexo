import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
// The schema comes from the server itself: openDb creates (and migrates) <dataDir>/nexo.db.
import { openDb } from '../../server/src/db.ts'
import { AdminError, backupDatabase, checkUserName, defaultBackupName, makeOwner, renameUser } from '../src/cli/admin.ts'
import { acquireInstance } from '../src/cli/instance.ts'

const ports = { http: 3001, livekit: 7880, livekitTcp: 7881, livekitUdp: 7882 }

/** A data folder with a real server database: Alice (with a message), Bob. */
function fixture() {
  const dir = mkdtempSync(path.join(tmpdir(), 'nexo-cli-admin-'))
  const db = openDb(dir)
  const alice = db.users.create('Alice', '#3ee6b0', 'hash-a')
  const bob = db.users.create('Bob', '#3ee6b0', 'hash-b')
  const general = db.channels.all().find((c) => c.type === 'text')!
  db.messages.create(general.id, alice.id, 'hello')
  db.close()
  return { dir, aliceId: alice.id, bobId: bob.id, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

const names = (dir: string) => {
  const db = new DatabaseSync(path.join(dir, 'nexo.db'))
  try {
    return (db.prepare('SELECT name FROM users ORDER BY name').all() as { name: string }[]).map((r) => r.name)
  } finally {
    db.close()
  }
}

test('checkUserName follows the server rules', () => {
  assert.deepEqual(checkUserName('  Alice   old '), { ok: true, value: 'Alice old' })
  assert.equal(checkUserName('A').ok, false) // too short
  assert.equal(checkUserName('x'.repeat(25)).ok, false) // too long
  assert.equal(checkUserName('bad/name').ok, false)
  assert.equal(checkUserName('Zoë_2.0-ok').ok, true)
})

test('renameUser: case-insensitive match, keeps messages, frees the name', () => {
  const f = fixture()
  try {
    const r = renameUser(f.dir, 'alice', 'Alice-old')
    assert.deepEqual(r, { id: f.aliceId, oldName: 'Alice', newName: 'Alice-old' })
    assert.deepEqual(names(f.dir), ['Alice-old', 'Bob'])
    const db = openDb(f.dir)
    try {
      assert.equal(db.users.byName('alice'), undefined) // free again
      const general = db.channels.all().find((c) => c.type === 'text')!
      assert.equal(db.messages.history(general.id)[0].userId, f.aliceId) // messages kept
    } finally {
      db.close()
    }
    // a case-only change of the same user is allowed
    assert.equal(renameUser(f.dir, 'ALICE-OLD', 'alice-old').newName, 'alice-old')
  } finally {
    f.cleanup()
  }
})

test('renameUser: refuses unknown users, taken names, invalid names', () => {
  const f = fixture()
  try {
    assert.throws(() => renameUser(f.dir, 'Carol', 'Caroline'), /No user named "Carol"/)
    assert.throws(() => renameUser(f.dir, 'Alice', 'bob'), /"Bob" is already taken/)
    assert.throws(() => renameUser(f.dir, 'Alice', 'A'), /Names must be 2-24/)
    assert.throws(() => renameUser(f.dir, 'Alice', 'Alice'), /already called/)
    assert.throws(() => renameUser(f.dir, '', 'Xy'), AdminError)
    assert.deepEqual(names(f.dir), ['Alice', 'Bob'])
  } finally {
    f.cleanup()
  }
})

test('renameUser: refused while the server runs, unless --force', () => {
  const f = fixture()
  try {
    const held = acquireInstance(f.dir, { version: 't', ports, pid: 4242, isAlive: () => true })
    assert.ok(held.ok)
    assert.throws(
      () => renameUser(f.dir, 'Alice', 'Alice-old', { isAlive: () => true }),
      (e: Error) => e instanceof AdminError && /server is running \(PID 4242\)/.test(e.message) && /--force/.test(e.message),
    )
    assert.deepEqual(names(f.dir), ['Alice', 'Bob'])
    renameUser(f.dir, 'Alice', 'Alice-old', { isAlive: () => true, force: true })
    assert.deepEqual(names(f.dir), ['Alice-old', 'Bob'])
    // a stale lock doesn't block
    renameUser(f.dir, 'Bob', 'Bob-old', { isAlive: () => false })
    assert.deepEqual(names(f.dir), ['Alice-old', 'Bob-old'])
  } finally {
    f.cleanup()
  }
})

const roles = (dir: string) => {
  const db = new DatabaseSync(path.join(dir, 'nexo.db'))
  try {
    const rows = db.prepare('SELECT name, role FROM users ORDER BY name').all() as { name: string; role: string }[]
    return Object.fromEntries(rows.map((r) => [r.name, r.role]))
  } finally {
    db.close()
  }
}

test('makeOwner: moves ownership, the previous owner becomes an admin', () => {
  const f = fixture()
  try {
    assert.deepEqual(roles(f.dir), { Alice: 'owner', Bob: 'member' }) // the first account owns the server
    assert.deepEqual(makeOwner(f.dir, '  bob '), { id: f.bobId, name: 'Bob', previous: 'Alice' })
    assert.deepEqual(roles(f.dir), { Alice: 'admin', Bob: 'owner' })
    assert.deepEqual(makeOwner(f.dir, 'Alice'), { id: f.aliceId, name: 'Alice', previous: 'Bob' })
    assert.deepEqual(roles(f.dir), { Alice: 'owner', Bob: 'admin' })
  } finally {
    f.cleanup()
  }
})

test('makeOwner: refuses unknown users, the current owner, and while the server runs', () => {
  const f = fixture()
  try {
    assert.throws(() => makeOwner(f.dir, 'Carol'), /No user named "Carol"/)
    assert.throws(() => makeOwner(f.dir, 'alice'), /"Alice" is already the owner/)
    assert.throws(() => makeOwner(f.dir, '  '), AdminError)
    const held = acquireInstance(f.dir, { version: 't', ports, pid: 4242, isAlive: () => true })
    assert.ok(held.ok)
    assert.throws(
      () => makeOwner(f.dir, 'Bob', { isAlive: () => true }),
      (e: Error) => e instanceof AdminError && /server is running \(PID 4242\)/.test(e.message) && /--force/.test(e.message),
    )
    assert.deepEqual(roles(f.dir), { Alice: 'owner', Bob: 'member' })
    makeOwner(f.dir, 'Bob', { isAlive: () => true, force: true })
    assert.deepEqual(roles(f.dir), { Alice: 'admin', Bob: 'owner' })
  } finally {
    f.cleanup()
  }
})

test('makeOwner: migrates a database from before roles', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'nexo-cli-admin-'))
  try {
    const db = new DatabaseSync(path.join(dir, 'nexo.db'))
    db.exec(`CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE COLLATE NOCASE, color TEXT NOT NULL,
             token_hash TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL)`)
    db.prepare('INSERT INTO users VALUES (?, ?, ?, ?, ?)').run('u1', 'First', '#111111', 'h1', 1)
    db.prepare('INSERT INTO users VALUES (?, ?, ?, ?, ?)').run('u2', 'Second', '#222222', 'h2', 2)
    db.close()
    assert.deepEqual(makeOwner(dir, 'second'), { id: 'u2', name: 'Second', previous: 'First' })
    assert.deepEqual(roles(dir), { First: 'admin', Second: 'owner' })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('no database: clear message', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'nexo-cli-admin-'))
  try {
    assert.throws(() => renameUser(dir, 'a', 'bb'), /No database at .*--data/)
    assert.throws(() => makeOwner(dir, 'Alice'), /No database at .*--data/)
    assert.throws(() => backupDatabase(dir), /No database at/)
    assert.equal(existsSync(path.join(dir, 'nexo.db')), false) // not created by accident
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('backupDatabase: VACUUM INTO a consistent copy, default name in backups/', () => {
  const f = fixture()
  try {
    // keep a writer open, like the running server (WAL)
    const live = openDb(f.dir)
    const r = backupDatabase(f.dir, undefined, new Date(2026, 10, 8, 14, 30, 5))
    assert.equal(r.file, path.join(f.dir, 'backups', 'nexo-backup-2026-11-08_14-30-05.db'))
    assert.ok(r.bytes > 0)
    const copy = new DatabaseSync(r.file, { readOnly: true })
    try {
      assert.equal((copy.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n, 2)
      assert.equal((copy.prepare('SELECT COUNT(*) AS n FROM messages').get() as { n: number }).n, 1)
      assert.equal((copy.prepare('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check, 'ok')
    } finally {
      copy.close()
      live.close()
    }
    assert.throws(() => backupDatabase(f.dir, r.file), /already exists/)
    const custom = path.join(f.dir, 'elsewhere', 'my copy.db')
    assert.equal(backupDatabase(f.dir, custom).file, custom)
    assert.match(defaultBackupName(), /^nexo-backup-\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}\.db$/)
  } finally {
    f.cleanup()
  }
})
