import assert from 'node:assert/strict'
import { test } from 'node:test'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  approvedDisabled,
  parseRegQuery,
  quoteWindowsArg,
  RUN_KEY,
  runAutostart,
  STARTUP_APPROVED_KEY,
  systemdQuote,
  systemdUnit,
  unitPath,
  windowsRunCommand,
  type AutostartDeps,
  type Exec,
  type ExecResult,
} from '../src/autostart.ts'

const EXE = 'C:\\Users\\Ana Maria\\Nexo Server\\nexo-server.exe'
const DATA = 'C:\\Users\\Ana Maria\\AppData\\Local\\Nexo Server'

test('quoteWindowsArg / windowsRunCommand', () => {
  assert.equal(quoteWindowsArg('C:\\a b\\x.exe'), '"C:\\a b\\x.exe"')
  assert.equal(quoteWindowsArg('D:\\'), '"D:\\\\"') // trailing backslash doubled, or it would escape the quote
  assert.equal(quoteWindowsArg('a"b'), '"a\\"b"')
  assert.equal(windowsRunCommand(EXE, DATA), `"${EXE}" --data "${DATA}"`)
})

test('parseRegQuery / approvedDisabled', () => {
  const out = `\r\nHKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Run\r\n    Nexo Server    REG_SZ    "${EXE}" --data "${DATA}"\r\n\r\n`
  assert.deepEqual(parseRegQuery(out), { type: 'REG_SZ', data: `"${EXE}" --data "${DATA}"` })
  assert.equal(parseRegQuery('\r\nHKEY_CURRENT_USER\\...\\Run\r\n    OneDrive    REG_SZ    x\r\n'), null)
  assert.equal(approvedDisabled('030000000000000000000000'), true)
  assert.equal(approvedDisabled('020000000000000000000000'), false)
  assert.equal(approvedDisabled(''), false)
})

/** A fake reg.exe / systemctl that records calls and answers from a script. */
function fakeExec(answer: (file: string, args: readonly string[]) => Partial<ExecResult> | undefined) {
  const calls: string[][] = []
  const exec: Exec = async (file, args) => {
    calls.push([file, ...args])
    return { code: 0, stdout: '', stderr: '', ...answer(file, args) }
  }
  return { exec, calls }
}

function deps(over: Partial<AutostartDeps>) {
  const lines: string[] = []
  const d: AutostartDeps = {
    platform: 'win32',
    binary: EXE,
    dataDir: DATA,
    configured: true,
    running: false,
    exec: async () => ({ code: 0, stdout: '', stderr: '' }),
    out: (l = '') => lines.push(l),
    err: (l = '') => lines.push(`ERR ${l}`),
    env: { SystemRoot: 'C:\\WINDOWS' },
    ...over,
  }
  return { d, text: () => lines.join('\n') }
}

const REG = 'C:\\WINDOWS\\System32\\reg.exe'

test('Windows: on writes the HKCU Run value with reg.exe (no shell), off deletes it, status reads it', async () => {
  let stored: string | null = null
  const { exec, calls } = fakeExec((_file, args) => {
    const [verb, key] = args
    if (key === RUN_KEY && verb === 'query') {
      return stored === null ? { code: 1, stderr: 'ERROR: The system was unable to find the specified registry key or value.' } : { stdout: `\r\n${RUN_KEY}\r\n    Nexo Server    REG_SZ    ${stored}\r\n` }
    }
    if (key === RUN_KEY && verb === 'add') stored = args[args.indexOf('/d') + 1]!
    if (key === RUN_KEY && verb === 'delete') stored = null
    if (key === STARTUP_APPROVED_KEY) return { code: 1 }
    return undefined
  })

  let t = deps({ exec })
  assert.equal(await runAutostart('status', t.d), 0)
  assert.match(t.text(), /Autostart is off/)

  t = deps({ exec })
  assert.equal(await runAutostart('on', t.d), 0)
  const add = calls.find((c) => c[1] === 'add')!
  assert.deepEqual(add, [REG, 'add', RUN_KEY, '/v', 'Nexo Server', '/t', 'REG_SZ', '/d', `"${EXE}" --data "${DATA}"`, '/f'])
  // Clears a "disabled" mark from Task Manager.
  assert.ok(calls.some((c) => c[1] === 'delete' && c[2] === STARTUP_APPROVED_KEY))
  assert.match(t.text(), /console window/)

  t = deps({ exec })
  assert.equal(await runAutostart('status', t.d), 0)
  assert.match(t.text(), /Autostart is on/)
  assert.match(t.text(), /--data/)

  t = deps({ exec })
  assert.equal(await runAutostart('off', t.d), 0)
  assert.equal(stored, null)
  assert.match(t.text(), /Autostart is off/)
  t = deps({ exec })
  assert.equal(await runAutostart('off', t.d), 0)
  assert.match(t.text(), /already off/)
})

test('Windows: status reports a Task Manager-disabled entry; reg.exe failures are explained', async () => {
  const { exec } = fakeExec((_f, args) =>
    args[0] === 'query'
      ? { stdout: `\r\nX\r\n    Nexo Server    ${args[1] === RUN_KEY ? 'REG_SZ    "x" --data "y"' : 'REG_BINARY    030000000000000000000000'}\r\n` }
      : undefined,
  )
  let t = deps({ exec })
  await runAutostart('status', t.d)
  assert.match(t.text(), /disabled in Task Manager/)

  const failing = fakeExec((_f, args) => (args[0] === 'add' ? { code: 1, stderr: 'ERROR: Access is denied.' } : { code: 1 }))
  t = deps({ exec: failing.exec })
  assert.equal(await runAutostart('on', t.d), 1)
  assert.match(t.text(), /Couldn't turn autostart on: ERROR: Access is denied\./)
})

test('autostart on needs the packaged exe and a config', async () => {
  const { exec, calls } = fakeExec(() => undefined)
  let t = deps({ exec, binary: null })
  assert.equal(await runAutostart('on', t.d), 1)
  assert.match(t.text(), /needs the downloaded nexo-server program/)
  t = deps({ exec, configured: false })
  assert.equal(await runAutostart('on', t.d), 1)
  assert.match(t.text(), /Run "nexo-server" once first/)
  assert.equal(calls.length, 0)
  t = deps({ exec, platform: 'darwin' })
  assert.equal(await runAutostart('status', t.d), 1)
})

test('systemd unit: quoting, path', () => {
  assert.equal(systemdQuote('/opt/my nexo/nexo-server'), '"/opt/my nexo/nexo-server"')
  assert.equal(systemdQuote('/d/100%/$HOME/"x"\\'), '"/d/100%%/$$HOME/\\"x\\"\\\\"')
  const unit = systemdUnit('/opt/nexo/nexo-server', '/home/ana/.local/share/nexo-server')
  assert.match(unit, /^ExecStart="\/opt\/nexo\/nexo-server" --data "\/home\/ana\/\.local\/share\/nexo-server"$/m)
  assert.match(unit, /^Restart=on-failure$/m)
  assert.match(unit, /^WantedBy=default\.target$/m)
  assert.equal(unitPath({}, '/home/ana'), '/home/ana/.config/systemd/user/nexo-server.service')
  assert.equal(unitPath({ XDG_CONFIG_HOME: '/cfg' }, '/home/ana'), '/cfg/systemd/user/nexo-server.service')
})

test('Linux: on writes the user unit and enables it; off disables and removes it', async () => {
  const home = mkdtempSync(path.join(tmpdir(), 'nexo-autostart-'))
  try {
    const { exec, calls } = fakeExec((file, args) => (file === 'loginctl' ? { stdout: 'Linger=no\n' } : args[1] === 'is-enabled' ? { stdout: 'enabled\n' } : undefined))
    const base = { platform: 'linux' as const, binary: '/opt/nexo/nexo-server', dataDir: '/home/ana/.local/share/nexo-server', exec, homedir: home, env: { USER: 'ana' } }
    let t = deps(base)
    assert.equal(await runAutostart('on', t.d), 0, t.text())
    const file = path.join(home, '.config/systemd/user/nexo-server.service')
    assert.match(readFileSync(file, 'utf8'), /ExecStart="\/opt\/nexo\/nexo-server" --data/)
    assert.deepEqual(
      calls.filter((c) => c[0] === 'systemctl').map((c) => c.slice(1).join(' ')),
      ['--user daemon-reload', '--user enable --now nexo-server.service'],
    )
    assert.match(t.text(), /loginctl enable-linger ana/)

    // Running in a terminal: enable without --now.
    calls.length = 0
    t = deps({ ...base, running: true })
    await runAutostart('on', t.d)
    assert.ok(calls.some((c) => c.join(' ') === 'systemctl --user enable nexo-server.service'))

    t = deps(base)
    await runAutostart('status', t.d)
    assert.match(t.text(), /Autostart: enabled/)

    calls.length = 0
    t = deps(base)
    assert.equal(await runAutostart('off', t.d), 0)
    assert.ok(!existsSync(file))
    assert.deepEqual(calls.map((c) => c.slice(1).join(' ')), ['--user disable --now nexo-server.service', '--user daemon-reload'])
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('Linux without systemctl: writes the unit and prints instructions', async () => {
  const home = mkdtempSync(path.join(tmpdir(), 'nexo-autostart-'))
  try {
    const { exec } = fakeExec(() => ({ code: -1, missing: true }))
    const t = deps({ platform: 'linux', binary: '/opt/nexo/nexo-server', dataDir: '/data', exec, homedir: home, env: { USER: 'ana' } })
    assert.equal(await runAutostart('on', t.d), 1)
    assert.match(t.text(), /systemctl isn't available here/)
    assert.match(t.text(), /systemctl --user enable --now nexo-server\.service/)
    assert.match(t.text(), /loginctl enable-linger ana/)
    assert.match(t.text(), /ExecStart=/)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})
