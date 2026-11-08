import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import { createLogger, redact } from '../src/cli/log.ts'

function sink() {
  const s = new PassThrough()
  let text = ''
  s.on('data', (c: Buffer) => (text += c.toString()))
  return { stream: s, text: () => text }
}

test('redact masks secrets, longest first, ignores tiny values', () => {
  assert.equal(redact('key=abcdef1234 pw=moss-tiger-41', ['abcdef1234', 'moss-tiger-41']), 'key=*** pw=***')
  assert.equal(redact('abcdefgh', ['abcd', 'abcdefgh']), '***')
  assert.equal(redact('a b c', ['a', 'b']), 'a b c')
})

test('logger: plain console lines, timestamped file lines, secrets masked, print() console-only', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'nexo-cli-log-'))
  try {
    const out = sink()
    const err = sink()
    const file = path.join(dir, 'logs', 'nexo-server.log')
    const log = createLogger({ file, stdout: out.stream, stderr: err.stream, secrets: ['s3cr3t-value'], now: () => new Date('2026-11-08T12:00:00Z') })
    log.info('[nexo] listening with s3cr3t-value')
    log.warn('careful')
    log.error('boom', new Error('bad'))
    log.addSecret('moss-tiger-41')
    log.info('pw moss-tiger-41')
    log.print('Password: moss-tiger-41')

    assert.match(out.text(), /^\[nexo\] listening with \*\*\*\n/)
    assert.match(out.text(), /Password: moss-tiger-41/) // print() is unredacted
    assert.match(err.text(), /careful\nboom\nError: bad/)
    const f = readFileSync(file, 'utf8')
    assert.match(f, /^2026-11-08T12:00:00\.000Z INFO {2}\[nexo\] listening with \*\*\*$/m)
    assert.match(f, /WARN {2}careful/)
    assert.match(f, /ERROR boom/)
    assert.match(f, /pw \*\*\*/)
    assert.ok(!f.includes('s3cr3t-value'))
    assert.ok(!f.includes('moss-tiger-41')) // print() never reaches the file
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('log rotation by size keeps N files', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'nexo-cli-log-'))
  try {
    const file = path.join(dir, 'nexo-server.log')
    const quiet = new PassThrough()
    quiet.resume()
    const log = createLogger({ file, maxBytes: 1000, maxFiles: 3, stdout: quiet, stderr: quiet })
    const line = 'x'.repeat(100)
    for (let i = 0; i < 100; i++) log.info(`${String(i).padStart(3, '0')} ${line}`)
    assert.deepEqual(readdirSync(dir).sort(), ['nexo-server.log', 'nexo-server.log.1', 'nexo-server.log.2', 'nexo-server.log.3'])
    for (const f of readdirSync(dir)) assert.ok(statSync(path.join(dir, f)).size <= 1000, f)
    // newest lines in the current file, older ones shifted up
    assert.match(readFileSync(file, 'utf8'), / 099 /)
    const n1 = readFileSync(`${file}.1`, 'utf8').match(/ (\d{3}) /)![1]
    const n3 = readFileSync(`${file}.3`, 'utf8').match(/ (\d{3}) /)![1]
    assert.ok(Number(n3) < Number(n1))

    // a new logger continues the existing file's size
    const log2 = createLogger({ file, maxBytes: 1000, maxFiles: 3, stdout: quiet, stderr: quiet })
    for (let i = 0; i < 20; i++) log2.info(line)
    assert.ok(statSync(file).size <= 1000)
    assert.equal(existsSync(`${file}.4`), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
