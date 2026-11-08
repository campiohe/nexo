#!/usr/bin/env node
// Fake nexo-media helper: speaks protocol v1 (desktop/src/main/native-media/protocol.ts) without capturing,
// encoding or publishing anything. Lets the Electron side be developed and tested on any OS.
//
// Electron main uses it when NEXO_MEDIA_FAKE=1: it runs this file with the Electron binary itself
// (ELECTRON_RUN_AS_NODE=1), so no separate Node install is needed (Windows via scripts/win-run.sh, WSLg,
// Linux, macOS). Plain Node works too:  node desktop/scripts/fake-nexo-media.mjs
//
// FAKE_NEXO_MEDIA selects a failure:
//   encoder-unavailable  `start` fails with encoder-unavailable
//   crash                the process exits with code 1 three seconds after going live
//   source-closed        the share ends with `source-closed` five seconds after going live
//   stall                stats report `stalled: true`
//
// It exits on `shutdown`, on stdin EOF, and when the --parent-pid process is gone.
import { createInterface } from 'node:readline'

const PROTOCOL = 1
const MODE = process.env.FAKE_NEXO_MEDIA ?? ''
const ENCODER = 'Fake H.264 Encoder MFT'

const parentArg = process.argv.find((a) => a.startsWith('--parent-pid='))
const parentPid = parentArg ? Number(parentArg.slice('--parent-pid='.length)) : NaN

/** @type {null | { preset: any, cursor: boolean, timers: NodeJS.Timeout[], keyframes: number, startedAt: number }} */
let share = null

function send(event, then) {
  process.stdout.write(`${JSON.stringify(event)}\n`, then)
}

function log(level, message) {
  send({ type: 'log', level, message: `[fake] ${message}` })
}

function result(id, ok, extra = {}) {
  send({ type: 'result', id, ok, ...extra })
}

function fail(id, code, message) {
  result(id, false, { error: { code, message } })
}

function capabilities() {
  return {
    version: '0.0.0-fake',
    protocol: PROTOCOL,
    osBuild: 26100,
    adapter: { name: 'Fake GPU 9000', vendor: 'Fake', luid: '0x00000000:0x0000beef' },
    encoder: { name: ENCODER, vendor: 'Fake' },
    features: { borderless: true, minUpdateInterval: true, cursorToggle: true, processLoopback: true },
  }
}

function clearShare() {
  if (!share) return
  for (const t of share.timers) clearTimeout(t) // also clears intervals in Node
  share = null
}

function endShare(reason) {
  clearShare()
  send({ type: 'state', state: 'stopped' })
  send({ type: 'ended', reason })
}

function sendStats() {
  if (!share) return
  const { preset } = share
  const stalled = MODE === 'stall'
  const fps = stalled ? 0 : preset.fps
  share.keyframes += Math.random() < 0.2 ? 1 : 0
  send({
    type: 'stats',
    stats: {
      captureFps: fps,
      encodeFps: fps,
      targetBitrate: preset.maxBitrate,
      sentBitrate: Math.round(preset.maxBitrate * (0.85 + Math.random() * 0.1)),
      keyframes: share.keyframes,
      droppedFrames: 0,
      stalled,
      encoder: ENCODER,
      width: preset.width,
      height: preset.height,
    },
  })
}

function describeSource(source) {
  if (source?.kind === 'window') return `window hwnd=${source.hwnd}`
  if (source?.kind === 'monitor') {
    const r = source.rect
    return `monitor ${r.width}x${r.height}@${r.x},${r.y}`
  }
  return 'unknown source'
}

function start(cmd) {
  if (share) return fail(cmd.id, 'busy', 'A share is already running')
  if (MODE === 'encoder-unavailable') return fail(cmd.id, 'encoder-unavailable', 'Fake: no hardware H.264 encoder')
  const { source, preset, livekit } = cmd
  if (!source || !preset || !livekit || typeof livekit.url !== 'string' || typeof livekit.token !== 'string')
    return fail(cmd.id, 'protocol', 'start: missing source, preset or livekit')

  // Never print the token, only that one arrived.
  log('info', `start ${describeSource(source)} ${preset.width}x${preset.height}@${preset.fps} ${preset.contentHint} audio=${cmd.audio} url=${livekit.url} token=<${livekit.token.length} chars>`)
  share = { preset: { ...preset }, cursor: !!cmd.cursor, timers: [], keyframes: 1, startedAt: Date.now() }
  const s = share
  result(cmd.id, true)
  send({ type: 'state', state: 'connecting' })
  s.timers.push(
    setTimeout(() => {
      if (share !== s) return
      send({ type: 'state', state: 'live' })
      sendStats()
      s.timers.push(setInterval(sendStats, 1000))
      if (MODE === 'crash') {
        s.timers.push(
          setTimeout(() => {
            log('error', 'simulating a crash')
            process.exit(1)
          }, 3000),
        )
      }
      if (MODE === 'source-closed') s.timers.push(setTimeout(() => share === s && endShare('source-closed'), 5000))
    }, 300),
  )
}

function handle(cmd) {
  switch (cmd.type) {
    case 'hello':
      if (cmd.protocol !== PROTOCOL) return fail(cmd.id, 'protocol', `protocol ${cmd.protocol} not supported`)
      return result(cmd.id, true, { capabilities: capabilities() })
    case 'start':
      return start(cmd)
    case 'update':
      if (share && cmd.preset) Object.assign(share.preset, cmd.preset)
      if (share && typeof cmd.cursor === 'boolean') share.cursor = cmd.cursor
      return result(cmd.id, true)
    case 'stop':
      if (share) endShare('stopped')
      return result(cmd.id, true)
    case 'shutdown':
      clearShare()
      return send({ type: 'result', id: cmd.id, ok: true }, () => process.exit(0))
    default:
      return fail(cmd.id ?? 0, 'protocol', `unknown command ${JSON.stringify(cmd.type)}`)
  }
}

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity })
rl.on('line', (line) => {
  if (!line.trim()) return
  let cmd
  try {
    cmd = JSON.parse(line)
  } catch {
    log('warn', 'ignored a malformed command line')
    return
  }
  if (typeof cmd !== 'object' || cmd === null || !Number.isSafeInteger(cmd.id)) {
    log('warn', 'ignored a command without an id')
    return
  }
  handle(cmd)
})
// Parent watchdog, part 1: stdin EOF.
rl.on('close', () => process.exit(0))

// Parent watchdog, part 2: the parent PID is gone.
if (Number.isSafeInteger(parentPid) && parentPid > 0) {
  setInterval(() => {
    try {
      process.kill(parentPid, 0)
    } catch (err) {
      if (err.code !== 'EPERM') process.exit(0)
    }
  }, 1000).unref()
}

log('info', `fake helper ready (pid ${process.pid}${MODE ? `, FAKE_NEXO_MEDIA=${MODE}` : ''})`)
