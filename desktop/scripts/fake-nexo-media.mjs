#!/usr/bin/env node
// Fake nexo-media helper: speaks protocol v1 (desktop/src/main/native-media/protocol.ts) without capturing,
// encoding or publishing anything. Lets the Electron side be developed and tested on any OS.
//
// Electron main uses it when NEXO_MEDIA_FAKE=1: it runs this file with the Electron binary itself
// (ELECTRON_RUN_AS_NODE=1), so no separate Node install is needed (Windows via scripts/win-run.sh, WSLg,
// Linux, macOS). Plain Node works too:  node desktop/scripts/fake-nexo-media.mjs
//
// FAKE_NEXO_MEDIA selects a failure (several can be combined with commas, e.g. `no-audio,idle`):
//   encoder-unavailable  `start` fails with encoder-unavailable
//   crash                the process exits with code 1 three seconds after going live
//   source-closed        the share ends with `source-closed` five seconds after going live
//   stall                stats report `stalled: true`
//   idle                 stats report 0–1 capture fps (an idle monitor), not stalled
//   livekit-connect      the share fails while connecting: `error livekit-connect`, then it ends with `error`
//   encoder-lost         the encoder fails three seconds after going live: `error encoder-unavailable`, then
//                        it ends with `error` (main marks it fallback: the renderer retries on Chromium)
//   device-lost          the share ends with `device-lost` (no `error`) three seconds after going live, as the
//                        real helper does after two failed in-place device rebuilds
//   audio-failed         a share with audio reports `error audio-failed` two seconds after going live; the
//                        video keeps going
//   no-audio             capabilities report processLoopback: false (and an old Windows 10, osBuild 18363)
//
// Like the real helper: `result` of `start` before any event of that share; a share ends with `state stopped`
// then exactly one `ended`; a runtime failure sends its `error` before those. `update` without a share is ok.
//
// It exits on `shutdown`, on stdin EOF, and when the --parent-pid process is gone.
import { createInterface } from 'node:readline'

const PROTOCOL = 1
const MODE = process.env.FAKE_NEXO_MEDIA ?? ''
const MODES = new Set(MODE.split(',').map((m) => m.trim()).filter(Boolean))
const has = (mode) => MODES.has(mode)
const ENCODER = 'Fake H.264 Encoder MFT'

const parentArg = process.argv.find((a) => a.startsWith('--parent-pid='))
const parentPid = parentArg ? Number(parentArg.slice('--parent-pid='.length)) : NaN

/** @type {null | { preset: any, cursor: boolean, audio: string, timers: NodeJS.Timeout[], keyframes: number, startedAt: number }} */
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
    osBuild: has('no-audio') ? 18363 : 26100,
    adapter: { name: 'Fake GPU 9000', vendor: 'Fake', luid: '0x00000000:0x0000beef' },
    encoder: { name: ENCODER, vendor: 'Fake' },
    features: { borderless: true, minUpdateInterval: true, cursorToggle: true, processLoopback: !has('no-audio') },
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

/** A runtime failure: the error first, then the share ends with `error`. */
function failShare(code, message) {
  log('error', `share: ${message}`)
  send({ type: 'error', code, message })
  endShare('error')
}

function sendStats() {
  if (!share) return
  const { preset } = share
  const stalled = has('stall')
  const idle = has('idle')
  const fps = stalled ? 0 : idle ? Math.round(Math.random()) : preset.fps
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
  if (has('encoder-unavailable')) return fail(cmd.id, 'encoder-unavailable', 'Fake: no hardware H.264 encoder')
  const { source, preset, livekit } = cmd
  if (!source || !preset || !livekit || typeof livekit.url !== 'string' || typeof livekit.token !== 'string')
    return fail(cmd.id, 'protocol', 'start: missing source, preset or livekit')

  // Never print the token, only that one arrived.
  log('info', `start ${describeSource(source)} ${preset.width}x${preset.height}@${preset.fps} ${preset.contentHint} audio=${cmd.audio} url=${livekit.url} token=<${livekit.token.length} chars>`)
  share = { preset: { ...preset }, cursor: !!cmd.cursor, audio: cmd.audio, timers: [], keyframes: 1, startedAt: Date.now() }
  const s = share
  result(cmd.id, true)
  send({ type: 'state', state: 'connecting' })
  s.timers.push(
    setTimeout(() => {
      if (share !== s) return
      if (has('livekit-connect')) return failShare('livekit-connect', 'Fake: could not connect to wss://fake (timed out)')
      send({ type: 'state', state: 'live' })
      sendStats()
      s.timers.push(setInterval(sendStats, 1000))
      const after = (ms, fn) => s.timers.push(setTimeout(() => share === s && fn(), ms))
      if (has('audio-failed') && s.audio !== 'off') {
        after(2000, () => {
          log('warn', 'audio: simulating a loopback failure, video keeps going')
          send({ type: 'error', code: 'audio-failed', message: 'Fake: process loopback stopped delivering audio' })
        })
      }
      if (has('encoder-lost')) after(3000, () => failShare('encoder-unavailable', 'Fake: the encoder stopped accepting frames'))
      if (has('device-lost')) {
        after(3000, () => {
          log('warn', 'device: simulating a lost D3D11 device; two rebuilds failed')
          endShare('device-lost')
        })
      }
      if (has('crash')) {
        s.timers.push(
          setTimeout(() => {
            log('error', 'simulating a crash')
            process.exit(1)
          }, 3000),
        )
      }
      if (has('source-closed')) after(5000, () => endShare('source-closed'))
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
