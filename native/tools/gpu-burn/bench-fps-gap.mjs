#!/usr/bin/env node
// FPS-gap benchmark (docs/benchmarks/beta-m3-fps-gap.md): the beta helper's capture/encode rates against an
// uncapped GPU-bound "game" (gpu-burn), per pipeline configuration, with the NEXO_MEDIA_PROFILE breakdown.
// Same method as bench-gpu-priority.mjs: gpu-burn forced to the foreground (or not), Game preset dry run,
// 4 s warm-up then N seconds recorded, rounds alternating the order.
//
//   node native/tools/gpu-burn/bench-fps-gap.mjs [--seconds 30] [--rounds 2] [--iterations 1500]
//        [--foreground 2|1|0] [--borderless 0|1] [--source window|monitor] [--configs default,legacy,...]
//        [--env K=V,K=V] [--trace] [--json out.json]
//
// --env adds an ad-hoc configuration named "env". Each configuration sets NEXO_MEDIA_PROFILE=1 (the
// instrumentation costs a few queries per frame), unless --no-profile.
import { execSync, spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'
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
const FOREGROUND = opt('--foreground', '2') // 2: gpu-burn takes the focus back if it loses it
const TRACE = args.includes('--trace')
const PROFILE = !args.includes('--no-profile')
const SOURCE = opt('--source', 'window') // window | monitor
// 1: gpu-burn is a 1920x1080 popup (borderless full screen, captured 1:1); 0: a normal window with a title bar
// (the gpu-priority benchmark's setup: captured at 1922x1112, scaled to 1866x1080).
const BORDERLESS = opt('--borderless', '0')
const BURN_ARGS = (opt('--burn-args', '') || '').split(' ').filter(Boolean) // extra gpu-burn args, e.g. "--width 1600 --height 900"

// Every lever the experiments touch, so each configuration states all of them (unset = the helper default).
const LEVERS = [
  'NEXO_MEDIA_PROFILE_RAW',
  'NEXO_MEDIA_WGC_BUFFERS',
  'NEXO_MEDIA_WGC_MIN_INTERVAL_MS',
  'NEXO_MEDIA_RGB_INPUT',
  'NEXO_MEDIA_ZERO_COPY',
  'NEXO_MEDIA_PIPELINE',
  'NEXO_MEDIA_GPU_PRIORITY',
  'NEXO_MEDIA_GPU_SCHED_HIGH',
  'NEXO_MEDIA_ABOVE_NORMAL',
]
const CONFIGS = {
  'no-share': null,
  default: {},
  raw: { NEXO_MEDIA_PROFILE_RAW: '1' },
  // The pipeline before this work: ring copy, video-processor blit, NV12 straight into the MFT.
  legacy: { NEXO_MEDIA_RGB_INPUT: '0', NEXO_MEDIA_ZERO_COPY: '0', NEXO_MEDIA_PIPELINE: '0' },
  'no-min-interval': { NEXO_MEDIA_WGC_MIN_INTERVAL_MS: '0' },
  'buffers-4': { NEXO_MEDIA_WGC_BUFFERS: '4' },
  // Each lever alone on top of legacy, then combinations.
  'rgb-input': { NEXO_MEDIA_RGB_INPUT: '1', NEXO_MEDIA_ZERO_COPY: '0', NEXO_MEDIA_PIPELINE: '0' },
  'zero-copy': { NEXO_MEDIA_ZERO_COPY: '1', NEXO_MEDIA_RGB_INPUT: '0', NEXO_MEDIA_PIPELINE: '0' },
  pipeline: { NEXO_MEDIA_PIPELINE: '1', NEXO_MEDIA_RGB_INPUT: '0', NEXO_MEDIA_ZERO_COPY: '0' },
  'rgb+zero-copy': { NEXO_MEDIA_RGB_INPUT: '1', NEXO_MEDIA_ZERO_COPY: '1', NEXO_MEDIA_PIPELINE: '0' },
  'zero-copy+pipeline': { NEXO_MEDIA_ZERO_COPY: '1', NEXO_MEDIA_PIPELINE: '1', NEXO_MEDIA_RGB_INPUT: '0' },
  all: { NEXO_MEDIA_RGB_INPUT: '1', NEXO_MEDIA_ZERO_COPY: '1', NEXO_MEDIA_PIPELINE: '1' },
}
const adhoc = opt('--env', null)
if (adhoc) CONFIGS.env = Object.fromEntries(adhoc.split(',').map((kv) => kv.split('=')))
const selected = opt('--configs', adhoc ? 'env' : 'no-share,default').split(',')
for (const name of selected) if (!(name in CONFIGS)) throw new Error(`unknown config ${name}`)

const localAppData = execSync('cd /mnt/c && cmd.exe /d /c "echo %LOCALAPPDATA%"').toString().trim()
const OUT = opt('--out', execSync(`wslpath '${localAppData}'`).toString().trim() + '/nexo-dev/native/src/out')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const now = () => Date.now()
const lines = (stream, onLine) => createInterface({ input: stream }).on('line', (l) => onLine(l.replace(/\r$/, '')))
const mean = (v) => (v.length ? v.reduce((a, b) => a + b, 0) / v.length : NaN)
function stats(values) {
  if (!values.length) return { mean: NaN, min: NaN, p5: NaN }
  const sorted = [...values].sort((a, b) => a - b)
  return { mean: mean(values), min: sorted[0], p5: sorted[Math.floor(sorted.length * 0.05)] }
}

/** "profile: wgc 21.0/s gap 47.6/120.0ms copyGpu 0.10/0.20ms … wait 40% … busy 0" → {key: number} */
function parseProfile(message) {
  const out = {}
  const re = /(\w+) ([\d.]+)(\/s|%|\/([\d.]+)ms)?( gap ([\d.]+)\/([\d.]+)ms)?/g
  for (const m of message.replace(/^profile:/, '').matchAll(re)) {
    const [, key, a, unit, max, gap, gapAvg, gapMax] = m
    if (unit === '/s') out[key] = Number(a)
    else if (unit === '%') out[key] = Number(a)
    else if (max !== undefined) {
      out[key] = Number(a)
      out[key + 'Max'] = Number(max)
    } else out[key] = Number(a)
    if (gap) {
      out[key + 'Gap'] = Number(gapAvg)
      out[key + 'GapMax'] = Number(gapMax)
    }
  }
  return out
}

function monitorRect() {
  // The primary monitor, physical pixels (gpu-burn sits at 0,0 on it).
  return { x: 0, y: 0, width: 1920, height: 1080 }
}

async function runOne(name) {
  const levers = CONFIGS[name]
  const burnFps = []
  const helperStats = []
  const profiles = []
  const helperLog = []

  // A spawn through WSL interop occasionally never starts: give gpu-burn 20 s to say ready, then try once more.
  const startBurn = () => {
    const proc = spawn(`${OUT}/gpu-burn.exe`, ['--iterations', String(ITERATIONS), '--x', '0', '--y', '0', '--foreground', FOREGROUND, '--borderless', BORDERLESS, ...BURN_ARGS], { cwd: OUT })
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

  let helper = null
  let helperExited = null
  if (levers) {
    const env = { ...process.env, NEXO_MEDIA_DRY_RUN: '1', NEXO_MEDIA_PROFILE: PROFILE ? '1' : '0' }
    for (const l of LEVERS) {
      if (levers[l] !== undefined) env[l] = levers[l]
      else delete env[l]
    }
    env.WSLENV = [process.env.WSLENV, 'NEXO_MEDIA_DRY_RUN', 'NEXO_MEDIA_PROFILE', ...LEVERS].filter(Boolean).join(':')
    helper = spawn(`${OUT}/nexo-media.exe`, [], { cwd: OUT, env })
    helperExited = new Promise((r) => helper.on('exit', r))
    lines(helper.stdout, (l) => {
      const ev = JSON.parse(l)
      if (ev.type === 'stats') helperStats.push([now(), ev.stats.captureFps, ev.stats.encodeFps])
      else if (ev.type === 'log' && ev.message.startsWith('profile:')) profiles.push([now(), parseProfile(ev.message), ev.message])
      else if (ev.type === 'log' && /capture: started|encoder: |device: |convert|zero-copy|D3D11On12|queue|failed|error|unsupported|fallback/i.test(ev.message))
        helperLog.push(ev.message)
      else if (ev.type === 'error' || ev.type === 'ended') helperLog.push(JSON.stringify(ev))
    })
    const send = (o) => helper.stdin.write(JSON.stringify(o) + '\n')
    send({ id: 1, type: 'hello', protocol: 1 })
    send({
      id: 2,
      type: 'start',
      source: SOURCE === 'monitor' ? { kind: 'monitor', rect: monitorRect() } : { kind: 'window', hwnd },
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
    await Promise.race([helperExited, sleep(10_000)])
  }
  // By Windows PID: killing the WSL interop process doesn't always reach the Windows one.
  try {
    execSync(`cd /mnt/c && taskkill.exe /F /PID ${readyEv.pid}`, { stdio: 'ignore' })
  } catch {}
  burn.kill()
  await Promise.race([burnExited, sleep(5000)])
  await sleep(2000)

  const inWindow = ([t]) => t >= t0 && t <= t1
  const s = helperStats.filter(inWindow)
  const b = burnFps.filter(inWindow)
  const p = profiles.filter(inWindow)
  if (TRACE) {
    process.stderr.write(`    encode/s: ${s.map((x) => x[2].toFixed(0)).join(' ')}\n`)
    const thieves = [...new Set(b.filter((x) => !x[2] && x[3]).map((x) => x[3]))]
    process.stderr.write(`    game fg/s: ${b.map((x) => (x[2] ? 'F' : '.')).join('')}${thieves.length ? ` (focus taken by ${thieves.join(', ')})` : ''}\n`)
    if (p.length) process.stderr.write(`    ${p[Math.floor(p.length / 2)][2]}\n`)
  }
  const keys = [...new Set(p.flatMap((x) => Object.keys(x[1])))]
  const profile = Object.fromEntries(keys.map((k) => [k, mean(p.map((x) => x[1][k]).filter((v) => v !== undefined))]))
  return {
    name,
    foreground: b.length ? b.filter((x) => x[2]).length / b.length : NaN,
    game: stats(b.map((x) => x[1])),
    capture: stats(s.map((x) => x[1])),
    encode: stats(s.map((x) => x[2])),
    profile,
    samples: s.length,
    log: [...new Set(helperLog)],
  }
}

const results = {}
for (let round = 1; round <= ROUNDS; round++) {
  const order = round % 2 ? selected : [...selected].reverse()
  for (const name of order) {
    process.stderr.write(`round ${round}: ${name}… `)
    const r = await runOne(name)
    const wgc = r.profile.wgc !== undefined ? `, wgc ${r.profile.wgc.toFixed(1)}/s` : ''
    process.stderr.write(
      `game ${r.game.mean.toFixed(1)} fps (fg ${(r.foreground * 100).toFixed(0)}%), capture ${r.capture.mean.toFixed(1)}, encode ${r.encode.mean.toFixed(1)} (min ${r.encode.min.toFixed(0)})${wgc}\n`,
    )
    for (const m of r.log) process.stderr.write(`    ${m}\n`)
    ;(results[name] ??= []).push(r)
  }
}

const fmt = (v, d = 1) => (Number.isFinite(v) ? v.toFixed(d) : '–')
const avg = (rs, f) => mean(rs.map(f).filter(Number.isFinite))
const ref = results['no-share'] ? avg(results['no-share'], (r) => r.game.mean) : NaN
console.log(`| Configuration | captureFps mean (min) | encodeFps mean (p5 / min) | gpu-burn fps | game cost | fg |`)
console.log(`|---|---|---|---|---|---|`)
for (const name of selected) {
  const rs = results[name]
  if (!rs) continue
  const game = avg(rs, (r) => r.game.mean)
  const cost = Number.isFinite(ref) && name !== 'no-share' ? `${(((ref - game) / ref) * 100).toFixed(1)}%` : '–'
  const capture = CONFIGS[name] ? `${fmt(avg(rs, (r) => r.capture.mean))} (${fmt(Math.min(...rs.map((r) => r.capture.min)))})` : '–'
  const encode = CONFIGS[name]
    ? `${fmt(avg(rs, (r) => r.encode.mean))} (${fmt(Math.min(...rs.map((r) => r.encode.p5)))} / ${fmt(Math.min(...rs.map((r) => r.encode.min)))})`
    : '–'
  console.log(`| ${name} | ${capture} | ${encode} | ${fmt(game)} | ${cost} | ${fmt(avg(rs, (r) => r.foreground) * 100, 0)}% |`)
}
const profKeys = ['wgc', 'wgcGap', 'wgcGapMax', 'wgcDelay', 'wgcCb', 'copyGpu', 'copyDone', 'convertCpu', 'convertGpu', 'convertDone', 'convertQ', 'encIn', 'encLatency', 'wait', 'age']
if (Object.values(results).some((rs) => rs.some((r) => Object.keys(r.profile).length))) {
  console.log(`\n| Configuration | ${profKeys.join(' | ')} |`)
  console.log(`|---|${profKeys.map(() => '---').join('|')}|`)
  for (const name of selected) {
    const rs = results[name]
    if (!rs || !CONFIGS[name]) continue
    console.log(`| ${name} | ${profKeys.map((k) => fmt(avg(rs, (r) => r.profile[k]), k === 'wgc' || k === 'wait' ? 1 : 2)).join(' | ')} |`)
  }
}
const jsonOut = opt('--json', null)
if (jsonOut) writeFileSync(jsonOut, JSON.stringify(results, null, 2))
