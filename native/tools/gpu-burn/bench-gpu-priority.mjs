#!/usr/bin/env node
// GPU-starvation benchmark (docs/benchmarks/beta-m3-gpu-priority.md). Runs from WSL after scripts/native-build.sh.
//
//   node native/tools/gpu-burn/bench-gpu-priority.mjs [--seconds 30] [--rounds 2] [--iterations 1500]
//                                                     [--configs baseline,gpu-priority,...] [--foreground 1|0]
//                                                     [--trace]
//
// For each configuration: start gpu-burn (an uncapped GPU-bound "game"), share its window with nexo-media at the
// Game preset (1080p60, motion) as a dry run (everything but the network), and record the helper's 1 Hz
// captureFps/encodeFps next to gpu-burn's own fps over the same seconds. A "no-share" run measures the game
// alone. gpu-burn is made the foreground window (--foreground 1, the default) like a game being played: the
// Windows GPU scheduler favours the foreground process, so leaving that to chance makes results bimodal. The
// "fg" column says how much of each run gpu-burn really was in the foreground. The exe must run from the local-disk copy (%LOCALAPPDATA%\nexo-dev\native\src\out): WGC borderless
// capture fails from \\wsl$.
import { execSync, spawn } from 'node:child_process'
import { createInterface } from 'node:readline'

const args = process.argv.slice(2)
const opt = (name, fallback) => {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : fallback
}
const SECONDS = Number(opt('--seconds', 30))
const ROUNDS = Number(opt('--rounds', 2))
const ITERATIONS = Number(opt('--iterations', 1500))
const WARMUP_S = 4
const FOREGROUND = opt('--foreground', '1')
const TRACE = args.includes('--trace')

const LEVERS = ['NEXO_MEDIA_GPU_PRIORITY', 'NEXO_MEDIA_GPU_SCHED_HIGH', 'NEXO_MEDIA_ABOVE_NORMAL']
const CONFIGS = {
  'no-share': null,
  baseline: {},
  'gpu-priority': { NEXO_MEDIA_GPU_PRIORITY: '1' },
  'sched-high': { NEXO_MEDIA_GPU_SCHED_HIGH: '1' },
  'above-normal': { NEXO_MEDIA_ABOVE_NORMAL: '1' },
  all: { NEXO_MEDIA_GPU_PRIORITY: '1', NEXO_MEDIA_GPU_SCHED_HIGH: '1', NEXO_MEDIA_ABOVE_NORMAL: '1' },
  // Pairs, to find the smallest set that holds the frame rate (not in the default run).
  'above-normal+sched-high': { NEXO_MEDIA_GPU_SCHED_HIGH: '1', NEXO_MEDIA_ABOVE_NORMAL: '1' },
  'above-normal+gpu-priority': { NEXO_MEDIA_GPU_PRIORITY: '1', NEXO_MEDIA_ABOVE_NORMAL: '1' },
  'gpu-priority+sched-high': { NEXO_MEDIA_GPU_PRIORITY: '1', NEXO_MEDIA_GPU_SCHED_HIGH: '1' },
}
const DEFAULT_RUN = ['no-share', 'baseline', 'gpu-priority', 'sched-high', 'above-normal', 'all']
const selected = opt('--configs', DEFAULT_RUN.join(',')).split(',')

const localAppData = execSync('cd /mnt/c && cmd.exe /d /c "echo %LOCALAPPDATA%"').toString().trim()
const OUT = opt('--out', execSync(`wslpath '${localAppData}'`).toString().trim() + '/nexo-dev/native/src/out')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const now = () => Date.now()

function lines(stream, onLine) {
  createInterface({ input: stream }).on('line', (l) => onLine(l.replace(/\r$/, '')))
}

function stats(values) {
  if (!values.length) return { mean: NaN, min: NaN, p5: NaN }
  const sorted = [...values].sort((a, b) => a - b)
  return {
    mean: values.reduce((a, b) => a + b, 0) / values.length,
    min: sorted[0],
    p5: sorted[Math.floor(sorted.length * 0.05)],
  }
}

async function runOne(name) {
  const levers = CONFIGS[name]
  const burnFps = [] // [t, fps, foreground]
  const helperStats = [] // [t, captureFps, encodeFps]
  const helperLog = []

  const burn = spawn(`${OUT}/gpu-burn.exe`, ['--iterations', String(ITERATIONS), '--x', '0', '--y', '0', '--foreground', FOREGROUND], { cwd: OUT })
  const ready = new Promise((resolve) => {
    lines(burn.stdout, (l) => {
      const ev = JSON.parse(l)
      if (ev.type === 'ready') resolve(ev)
      if (ev.type === 'fps') burnFps.push([now(), ev.fps, ev.foreground])
    })
  })
  const { hwnd } = await ready
  await sleep(1500)

  let helper = null
  if (levers) {
    // Every lever is set explicitly (0 or 1), so the result doesn't depend on the helper's current defaults.
    const env = { ...process.env, NEXO_MEDIA_DRY_RUN: '1' }
    for (const l of LEVERS) env[l] = levers[l] ?? '0'
    env.WSLENV = [process.env.WSLENV, 'NEXO_MEDIA_DRY_RUN', ...LEVERS].filter(Boolean).join(':')
    helper = spawn(`${OUT}/nexo-media.exe`, [], { cwd: OUT, env })
    lines(helper.stdout, (l) => {
      const ev = JSON.parse(l)
      if (ev.type === 'stats') helperStats.push([now(), ev.stats.captureFps, ev.stats.encodeFps])
      else if (ev.type === 'log' && /priority|scheduling|ABOVE_NORMAL|failed|error/i.test(ev.message)) helperLog.push(ev.message)
      else if (ev.type === 'error' || ev.type === 'ended') helperLog.push(JSON.stringify(ev))
    })
    const send = (o) => helper.stdin.write(JSON.stringify(o) + '\n')
    send({ id: 1, type: 'hello', protocol: 1 })
    send({
      id: 2,
      type: 'start',
      source: { kind: 'window', hwnd },
      preset: { width: 1920, height: 1080, fps: 60, maxBitrate: 8_000_000, contentHint: 'motion' },
      cursor: false,
      audio: 'off',
      excludePid: 0,
      livekit: { url: 'ws://unused', token: 'unused' },
    })
  }

  const t0 = now() + WARMUP_S * 1000
  await sleep((WARMUP_S + SECONDS) * 1000)
  const t1 = now()
  if (helper) {
    helper.stdin.write(JSON.stringify({ id: 3, type: 'shutdown' }) + '\n')
    await new Promise((r) => helper.on('exit', r))
  }
  burn.kill()
  await new Promise((r) => burn.on('exit', r))
  await sleep(2000) // let clocks and temperatures settle a little between runs

  const inWindow = ([t]) => t >= t0 && t <= t1
  const s = helperStats.filter(inWindow)
  const b = burnFps.filter(inWindow)
  if (TRACE) {
    process.stderr.write(`    encode/s: ${s.map((x) => x[2].toFixed(0)).join(' ')}\n`)
    process.stderr.write(`    game fg/s: ${b.map((x) => (x[2] ? 'F' : '.')).join('')}\n`)
  }
  return {
    name,
    foreground: b.length ? b.filter((x) => x[2]).length / b.length : NaN,
    game: stats(burnFps.filter(inWindow).map((x) => x[1])),
    capture: stats(s.map((x) => x[1])),
    encode: stats(s.map((x) => x[2])),
    samples: s.length,
    log: [...new Set(helperLog)],
  }
}

const results = {}
for (let round = 1; round <= ROUNDS; round++) {
  // Alternate the order between rounds so thermal drift doesn't favor one configuration.
  const order = round % 2 ? selected : [...selected].reverse()
  for (const name of order) {
    process.stderr.write(`round ${round}: ${name}… `)
    const r = await runOne(name)
    process.stderr.write(
      `game ${r.game.mean.toFixed(1)} fps (fg ${(r.foreground * 100).toFixed(0)}%), capture ${r.capture.mean.toFixed(1)}, encode ${r.encode.mean.toFixed(1)} (min ${r.encode.min.toFixed(0)})\n`,
    )
    for (const m of r.log) process.stderr.write(`    ${m}\n`)
    ;(results[name] ??= []).push(r)
  }
}

const fmt = (v) => (Number.isFinite(v) ? v.toFixed(1) : '–')
const avg = (rs, key, f) => rs.reduce((a, r) => a + r[key][f], 0) / rs.length
const minOf = (rs, key, f) => Math.min(...rs.map((r) => r[key][f]))
const ref = results['no-share'] ? avg(results['no-share'], 'game', 'mean') : NaN
console.log(`| Configuration | captureFps mean (min) | encodeFps mean (p5 / min) | gpu-burn fps | game cost | fg |`)
console.log(`|---|---|---|---|---|---|`)
for (const name of selected) {
  const rs = results[name]
  if (!rs) continue
  const game = avg(rs, 'game', 'mean')
  const cost = Number.isFinite(ref) && name !== 'no-share' ? `${(((ref - game) / ref) * 100).toFixed(1)}%` : '–'
  const capture = CONFIGS[name] ? `${fmt(avg(rs, 'capture', 'mean'))} (${fmt(minOf(rs, 'capture', 'min'))})` : '–'
  const encode = CONFIGS[name]
    ? `${fmt(avg(rs, 'encode', 'mean'))} (${fmt(minOf(rs, 'encode', 'p5'))} / ${fmt(minOf(rs, 'encode', 'min'))})`
    : '–'
  const fg = `${((rs.reduce((a, r) => a + r.foreground, 0) / rs.length) * 100).toFixed(0)}%`
  console.log(`| ${name} | ${capture} | ${encode} | ${fmt(game)} | ${cost} | ${fg} |`)
}
