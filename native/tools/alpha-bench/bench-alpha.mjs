#!/usr/bin/env node
// The alpha (Chromium) baseline under the FPS-gap method (docs/benchmarks/beta-m3-fps-gap.md). Runs from WSL
// after scripts/native-build.sh (for gpu-burn) with the Windows Electron that scripts/win-run.sh downloads.
//
//   node native/tools/alpha-bench/bench-alpha.mjs [--seconds 30] [--rounds 2] [--iterations 1500]
//        [--foreground 2|1|0] [--borderless 0|1] [--configs no-share,alpha,alpha-wgc-texture] [--trace]
//
// Per configuration: start gpu-burn (foreground, like a game being played), start this folder's Electron app
// sharing gpu-burn's window (getDisplayMedia → RTCPeerConnection loopback, H.264, 8 Mbps, 60 fps max), skip 4 s
// of warm-up, then record N seconds of the sender's media-source fps (capture) and outbound-rtp fps (send) next
// to gpu-burn's own fps. alpha-wgc-texture adds --enable-features=WebRtcAllowWgcUsingTexture (the alpha's
// default, prefs.fastCapture).
import { execSync, spawn } from 'node:child_process'
import { cpSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'

const args = process.argv.slice(2)
const opt = (name, fallback) => {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : fallback
}
const SECONDS = Number(opt('--seconds', 30))
const ROUNDS = Number(opt('--rounds', 2))
const ITERATIONS = Number(opt('--iterations', 1500))
const FOREGROUND = opt('--foreground', '2')
const BORDERLESS = opt('--borderless', '0')
const TRACE = args.includes('--trace')
const WARMUP_S = 4
const ELECTRON_VERSION = '45.2.3'

const CONFIGS = {
  'no-share': null,
  alpha: [],
  'alpha-wgc-texture': ['--enable-features=WebRtcAllowWgcUsingTexture'],
}
const selected = opt('--configs', 'no-share,alpha,alpha-wgc-texture').split(',')

const localAppData = execSync('cd /mnt/c && cmd.exe /d /c "echo %LOCALAPPDATA%"').toString().trim()
const devDir = execSync(`wslpath '${localAppData}'`).toString().trim() + '/nexo-dev'
const OUT = opt('--out', `${devDir}/native/src/out`)
const ELECTRON = `${devDir}/electron-v${ELECTRON_VERSION}/electron.exe`
if (!existsSync(ELECTRON)) throw new Error(`${ELECTRON} missing: run scripts/win-run.sh once (it downloads it)`)
// Electron on Windows can't load an app from \\wsl$ reliably: copy this folder to the local disk.
const APP_DIR = `${devDir}/alpha-bench`
mkdirSync(APP_DIR, { recursive: true })
const here = dirname(fileURLToPath(import.meta.url))
for (const f of ['package.json', 'main.js', 'index.html']) cpSync(join(here, f), join(APP_DIR, f))
const APP_DIR_WIN = execSync(`wslpath -w '${APP_DIR}'`).toString().trim()

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const now = () => Date.now()
const lines = (stream, onLine) => createInterface({ input: stream }).on('line', (l) => onLine(l.replace(/\r$/, '')))
const mean = (v) => (v.length ? v.reduce((a, b) => a + b, 0) / v.length : NaN)
function stats(values) {
  if (!values.length) return { mean: NaN, min: NaN, p5: NaN }
  const sorted = [...values].sort((a, b) => a - b)
  return { mean: mean(values), min: sorted[0], p5: sorted[Math.floor(sorted.length * 0.05)] }
}
const tryJson = (l) => {
  try {
    return JSON.parse(l)
  } catch {
    return null
  }
}

async function runOne(name) {
  const extra = CONFIGS[name]
  const burnFps = []
  const samples = [] // [t, captureRate, encodeRate, captureFps, sendFps]
  const info = new Set()

  // A spawn through WSL interop occasionally never starts: give gpu-burn 20 s to say ready, then try once more.
  const startBurn = () => {
    const proc = spawn(`${OUT}/gpu-burn.exe`, ['--iterations', String(ITERATIONS), '--x', '0', '--y', '0', '--foreground', FOREGROUND, '--borderless', BORDERLESS], { cwd: OUT })
    const ready = new Promise((resolve) => {
      lines(proc.stdout, (l) => {
        const ev = JSON.parse(l)
        if (ev.type === 'ready') resolve(ev)
        if (ev.type === 'fps') burnFps.push([now(), ev.fps, ev.foreground, ev.foregroundExe])
      })
    })
    const exited = new Promise((r) => proc.on('exit', r)) // listened from the start: it may exit early
    return { proc, exited, ready: Promise.race([ready, sleep(20_000).then(() => null)]) }
  }
  let { proc: burn, exited: burnExited, ready: started } = startBurn()
  let readyEv = await started
  if (!readyEv) {
    process.stderr.write('(gpu-burn did not start, retrying) ')
    burn.kill()
    ;({ proc: burn, exited: burnExited, ready: started } = startBurn())
    readyEv = await started
    if (!readyEv) throw new Error('gpu-burn did not start')
  }
  const { hwnd } = readyEv
  await sleep(1500)

  let electron = null
  let electronPid = 0 // the Windows PID (electron.pid is the WSL interop process)
  if (extra) {
    electron = spawn(ELECTRON, [APP_DIR_WIN, `--hwnd=${hwnd}`, ...extra], { cwd: APP_DIR })
    lines(electron.stdout, (l) => {
      const ev = tryJson(l)
      if (!ev) return
      if (ev.type === 'stats' && ev.captureRate !== undefined) {
        samples.push([now(), ev.captureRate, ev.encodeRate, ev.captureFps, ev.sendFps])
        info.add(`${ev.encoder} ${ev.codec} ${ev.width}x${ev.height}`)
        if (ev.qualityLimitation && ev.qualityLimitation !== 'none') info.add(`qualityLimitation ${ev.qualityLimitation}`)
      } else if (ev.type === 'ready') electronPid = ev.pid
      else if (ev.type === 'error' || ev.type === 'source') info.add(JSON.stringify(ev))
    })
  }

  const t0 = now() + WARMUP_S * 1000
  await sleep((WARMUP_S + SECONDS) * 1000)
  const t1 = now()
  if (electron) {
    // Only our own tree: a Nexo dev build runs the same electron.exe.
    if (electronPid) {
      try {
        execSync(`cd /mnt/c && taskkill.exe /F /PID ${electronPid} /T`, { stdio: 'ignore' })
      } catch {}
    }
    await Promise.race([new Promise((r) => electron.on('exit', r)), sleep(5000)])
  }
  // By Windows PID: killing the WSL interop process doesn't always reach the Windows one.
  try {
    execSync(`cd /mnt/c && taskkill.exe /F /PID ${readyEv.pid}`, { stdio: 'ignore' })
  } catch {}
  burn.kill()
  await Promise.race([burnExited, sleep(5000)])
  await sleep(2000)

  const inWindow = ([t]) => t >= t0 && t <= t1
  const s = samples.filter(inWindow)
  const b = burnFps.filter(inWindow)
  if (TRACE) {
    process.stderr.write(`    send/s: ${s.map((x) => x[2].toFixed(0)).join(' ')}\n`)
    const thieves = [...new Set(b.filter((x) => !x[2] && x[3]).map((x) => x[3]))]
    process.stderr.write(`    game fg/s: ${b.map((x) => (x[2] ? 'F' : '.')).join('')}${thieves.length ? ` (focus taken by ${thieves.join(', ')})` : ''}\n`)
  }
  return {
    name,
    foreground: b.length ? b.filter((x) => x[2]).length / b.length : NaN,
    game: stats(b.map((x) => x[1])),
    capture: stats(s.map((x) => x[1])),
    send: stats(s.map((x) => x[2])),
    info: [...info],
  }
}

const results = {}
for (let round = 1; round <= ROUNDS; round++) {
  const order = round % 2 ? selected : [...selected].reverse()
  for (const name of order) {
    process.stderr.write(`round ${round}: ${name}… `)
    const r = await runOne(name)
    process.stderr.write(
      `game ${r.game.mean.toFixed(1)} fps (fg ${(r.foreground * 100).toFixed(0)}%), capture ${r.capture.mean.toFixed(1)}, send ${r.send.mean.toFixed(1)} (min ${r.send.min.toFixed(0)})\n`,
    )
    for (const m of r.info) process.stderr.write(`    ${m}\n`)
    ;(results[name] ??= []).push(r)
  }
}

const fmt = (v) => (Number.isFinite(v) ? v.toFixed(1) : '–')
const avg = (rs, f) => mean(rs.map(f).filter(Number.isFinite))
const ref = results['no-share'] ? avg(results['no-share'], (r) => r.game.mean) : NaN
console.log(`| Configuration | capture fps mean (min) | send fps mean (p5 / min) | gpu-burn fps | game cost | fg |`)
console.log(`|---|---|---|---|---|---|`)
for (const name of selected) {
  const rs = results[name]
  if (!rs) continue
  const game = avg(rs, (r) => r.game.mean)
  const cost = Number.isFinite(ref) && name !== 'no-share' ? `${(((ref - game) / ref) * 100).toFixed(1)}%` : '–'
  const capture = CONFIGS[name] ? `${fmt(avg(rs, (r) => r.capture.mean))} (${fmt(Math.min(...rs.map((r) => r.capture.min)))})` : '–'
  const send = CONFIGS[name]
    ? `${fmt(avg(rs, (r) => r.send.mean))} (${fmt(Math.min(...rs.map((r) => r.send.p5)))} / ${fmt(Math.min(...rs.map((r) => r.send.min)))})`
    : '–'
  console.log(`| ${name} | ${capture} | ${send} | ${fmt(game)} | ${cost} | ${(avg(rs, (r) => r.foreground) * 100).toFixed(0)}% |`)
}
