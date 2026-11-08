import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseArgs, usage, type Command } from '../src/cli/commands.ts'

const ok: [string[], Command][] = [
  [[], { kind: 'start', global: {}, setup: {} }],
  [['--data', 'D:\\Nexo'], { kind: 'start', global: { dataDir: 'D:\\Nexo' }, setup: {} }],
  [['--data=./data'], { kind: 'start', global: { dataDir: './data' }, setup: {} }],
  [['--name', 'VPS', '--no-password'], { kind: 'start', global: {}, setup: { name: 'VPS', noPassword: true } }],
  [['setup'], { kind: 'setup', global: {}, setup: {} }],
  [['setup', '--name', 'The Lounge', '--password', 'moss-tiger-41'], { kind: 'setup', global: {}, setup: { name: 'The Lounge', password: 'moss-tiger-41' } }],
  [['--password=-starts-with-dash', 'setup'], { kind: 'setup', global: {}, setup: { password: '-starts-with-dash' } }],
  [['invite', '--ascii'], { kind: 'invite', global: { ascii: true } }],
  [['status', '--data', '/srv/nexo'], { kind: 'status', global: { dataDir: '/srv/nexo' } }],
  [['backup'], { kind: 'backup', global: {} }],
  [['backup', 'D:\\copy.db'], { kind: 'backup', global: {}, file: 'D:\\copy.db' }],
  [['rename-user', 'Alice', 'Alice-old'], { kind: 'rename-user', global: {}, oldName: 'Alice', newName: 'Alice-old', force: false }],
  [['rename-user', '--force', 'Alice', 'Alice old'], { kind: 'rename-user', global: {}, oldName: 'Alice', newName: 'Alice old', force: true }],
  [['rename-user', '--', '-x-', 'y'], { kind: 'rename-user', global: {}, oldName: '-x-', newName: 'y', force: false }],
  [['autostart', 'on'], { kind: 'autostart', global: {}, action: 'on' }],
  [['autostart', 'OFF'], { kind: 'autostart', global: {}, action: 'off' }],
  [['autostart'], { kind: 'autostart', global: {}, action: 'status' }],
  [['autostart', 'status'], { kind: 'autostart', global: {}, action: 'status' }],
  [['update'], { kind: 'update', global: {} }],
  [['--help'], { kind: 'help', global: {} }],
  [['-h', 'status'], { kind: 'help', global: {} }],
  [['help'], { kind: 'help', global: {} }],
  [['-v'], { kind: 'version', global: {} }],
  [['--version'], { kind: 'version', global: {} }],
]

test('parseArgs: valid command lines', () => {
  for (const [argv, expected] of ok) assert.deepEqual(parseArgs(argv), expected, argv.join(' '))
})

const bad: [string[], RegExp][] = [
  [['frobnicate'], /Unknown command "frobnicate"/],
  [['stat'], /did you mean "status"/],
  [['--nope'], /Unknown option "--nope"/],
  [['--data'], /--data needs a folder/],
  [['--data', '--ascii'], /--data needs a folder/],
  [['setup', '--password'], /--password needs a value/],
  [['setup', '--password', 'x', '--no-password'], /either --password or --no-password/],
  [['invite', '--name', 'x'], /only apply to setup/],
  [['status', '--force'], /--force only applies to rename-user/],
  [['rename-user', 'Alice'], /needs the current name and the new name/],
  [['rename-user', 'a', 'b', 'c'], /Too many arguments/],
  [['backup', 'a', 'b'], /Too many arguments/],
  [['autostart', 'maybe'], /"on", "off" or nothing/],
  [['autostart', 'on', 'now'], /Too many arguments/],
  [['invite', 'extra'], /Too many arguments/],
  [['--ascii=1'], /takes no value/],
]

test('parseArgs: invalid usage gives a helpful error', () => {
  for (const [argv, re] of bad) {
    const c = parseArgs(argv)
    assert.equal(c.kind, 'error', argv.join(' '))
    if (c.kind === 'error') assert.match(c.message, re, argv.join(' '))
  }
})

test('usage lists every command', () => {
  const u = usage()
  for (const c of ['setup', 'invite', 'status', 'backup', 'rename-user', 'autostart', 'update', '--data']) assert.ok(u.includes(c), c)
})
