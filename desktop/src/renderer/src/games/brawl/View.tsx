// Ring Out view: a 320×180 pixel canvas with a camera that pans and zooms to keep every fighter in frame,
// parallax backgrounds, code-built sprites, hit sparks, knockback trails, KO blasts, off-screen bubbles and the
// classic damage-% HUD. Positions are interpolated between frames (frames.sample); sounds and effects come
// from the view's events (increasing ids, played once).
import { useRef } from 'react'
import type { GameSeat } from '@shared/protocol'
import type { BrawlView as View } from '@shared/games/brawl/logic'
import { ANIMS, CHARS, EV, FL, STAGES } from '@shared/games/brawl/data'
import type { GameViewProps } from '../types'
import { RetroCanvas, drawText, eventPlayer, lerp, sfx, textWidth } from '../retro'
import { ORIGIN_X, ORIGIN_Y, SPRITE_H, SPRITE_W, headIcon, poseFor, sprite } from './sprites'
import { VH, VW, drawBackground, drawStage, groundBelow, sx, sy, type Cam } from './scene'

interface Fx {
  /** Interpolated fighter. */
  i: number
  x: number
  y: number
  face: number
  anim: number
  t: number
  dmg: number
  stocks: number
  fl: number
  ch: number
  shield: number
  kb: number
}

interface Ev {
  id: number
  k: number
  x: number
  y: number
  s: number
  v: number
}

interface Particle {
  x: number
  y: number
  vx: number
  vy: number
  g: number
  life: number
  max: number
  size: number
  color: string
  /** Screen space (not world). */
  scr: boolean
}

interface Effect {
  kind: 'spark' | 'ring' | 'blast'
  x: number
  y: number
  t0: number
  dur: number
  color: string
  v: number
  side: number
  rot: number
}

const HUD_H = 30
const DEAD = ANIMS.indexOf('dead')
const HURT = ANIMS.indexOf('hurt')

const DMG_STOPS: [number, [number, number, number]][] = [
  [0, [255, 255, 255]],
  [40, [255, 230, 107]],
  [80, [255, 166, 61]],
  [120, [255, 90, 61]],
  [170, [212, 32, 58]],
  [260, [142, 16, 48]],
]

function dmgColor(d: number): string {
  for (let i = 1; i < DMG_STOPS.length; i++) {
    const [p1, c1] = DMG_STOPS[i]
    const [p0, c0] = DMG_STOPS[i - 1]
    if (d <= p1) {
      const k = (d - p0) / (p1 - p0)
      return `rgb(${c0.map((c, j) => Math.round(lerp(c, c1[j], k))).join(',')})`
    }
  }
  return 'rgb(142,16,48)'
}

/** A filled pixel circle (rows of rects, crisp at any size). */
function pixCircle(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number, fill: string | null, ring?: string) {
  const R = Math.max(1, Math.round(r))
  cx = Math.round(cx)
  cy = Math.round(cy)
  for (let dy = -R; dy <= R; dy++) {
    const w = Math.round(Math.sqrt(Math.max(0, R * R - dy * dy)))
    if (w <= 0) continue
    if (fill) {
      ctx.fillStyle = fill
      ctx.fillRect(cx - w, cy + dy, w * 2, 1)
    }
    if (ring) {
      ctx.fillStyle = ring
      ctx.fillRect(cx - w, cy + dy, 1, 1)
      ctx.fillRect(cx + w - 1, cy + dy, 1, 1)
    }
  }
  if (ring) {
    ctx.fillStyle = ring
    ctx.fillRect(cx - 1, cy - R, 2, 1)
    ctx.fillRect(cx - 1, cy + R, 2, 1)
  }
}

function heavyHitSound() {
  sfx.noise({ ms: 220, volume: 1, lowpass: 2200 })
  sfx.tone({ freq: 140, to: 45, ms: 220, type: 'square', volume: 0.8 })
}

function createRuntime() {
  const cam: Cam = { x: 0, y: -40, z: 1 }
  let camReady = false
  let last = 0
  let shake = 0
  let goAt = -1e9
  let gameAt = -1e9
  let primed = false
  const particles: Particle[] = []
  const effects: Effect[] = []
  const prevDmg: number[] = []
  const dmgHitAt: number[] = []
  const trailAt: number[] = []
  let nowMs = 0
  let colors: string[] = []

  const burst = (x: number, y: number, n: number, color: string, speed: number, scr = false, g = 0.04) => {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2
      const v = speed * (0.4 + Math.random() * 0.8)
      particles.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, g, life: 0, max: 0.3 + Math.random() * 0.4, size: 1 + Math.round(Math.random()), color, scr })
    }
  }
  const dust = (x: number, y: number, n = 4) => {
    for (let i = 0; i < n; i++) {
      const dir = i % 2 ? 1 : -1
      particles.push({ x, y: y - 1, vx: dir * (0.3 + Math.random() * 0.8), vy: -0.2 - Math.random() * 0.4, g: 0, life: 0, max: 0.35, size: 2, color: '#e9e2d6', scr: false })
    }
  }

  const handle = (e: Ev) => {
    const color = colors[e.s] ?? '#ffffff'
    switch (e.k) {
      case EV.HIT:
        sfx.hit()
        effects.push({ kind: 'spark', x: e.x, y: e.y, t0: nowMs, dur: 170, color: '#ffe66b', v: e.v, side: 0, rot: Math.random() })
        burst(e.x, e.y, 4, '#ffffff', 1.2)
        break
      case EV.HEAVY:
        heavyHitSound()
        effects.push({ kind: 'spark', x: e.x, y: e.y, t0: nowMs, dur: 300, color: '#ff8a3d', v: e.v, side: 1, rot: Math.random() })
        effects.push({ kind: 'ring', x: e.x, y: e.y, t0: nowMs, dur: 260, color: '#ffffff', v: 18, side: 0, rot: 0 })
        burst(e.x, e.y, 10, '#ffe66b', 2)
        shake = Math.max(shake, Math.min(7, e.v / 25))
        break
      case EV.BLOCK:
        sfx.tone({ freq: 1400, to: 900, ms: 70, type: 'triangle', volume: 0.5 })
        effects.push({ kind: 'ring', x: e.x, y: e.y, t0: nowMs, dur: 160, color: '#9fdcff', v: 10, side: 0, rot: 0 })
        break
      case EV.BREAK:
        sfx.tone({ freq: 1600, to: 200, ms: 400, type: 'sawtooth', volume: 0.5 })
        sfx.noise({ ms: 300, volume: 0.7, lowpass: 6000 })
        burst(e.x, e.y, 18, '#9fdcff', 2.4, false, 0.08)
        shake = Math.max(shake, 4)
        break
      case EV.KO:
        sfx.explode()
        sfx.tone({ freq: 900, to: 120, ms: 500, type: 'sawtooth', volume: 0.35, delay: 40 })
        effects.push({ kind: 'blast', x: e.x, y: e.y, t0: nowMs, dur: 900, color, v: 0, side: e.v, rot: 0 })
        shake = Math.max(shake, 8)
        break
      case EV.JUMP:
        sfx.tone({ freq: e.v ? 520 : 380, to: e.v ? 900 : 720, ms: 90, volume: 0.25 })
        if (e.v) effects.push({ kind: 'ring', x: e.x, y: e.y, t0: nowMs, dur: 220, color: '#ffffff', v: 8, side: 1, rot: 0 })
        else dust(e.x, e.y)
        break
      case EV.LAND:
        dust(e.x, e.y, 6)
        sfx.tone({ freq: 110, to: 60, ms: 90, type: 'triangle', volume: 0.5 })
        break
      case EV.COUNT:
        sfx.countdown(false)
        break
      case EV.GO:
        sfx.countdown(true)
        goAt = nowMs
        break
      case EV.GAME:
        gameAt = nowMs
        ;[784, 659, 523, 1047].forEach((f, i) => sfx.tone({ freq: f, ms: 160, volume: 0.5, delay: i * 110 }))
        break
      case EV.COUNTER:
        sfx.tone({ freq: 1800, to: 2400, ms: 120, type: 'triangle', volume: 0.5 })
        effects.push({ kind: 'ring', x: e.x, y: e.y, t0: nowMs, dur: 300, color: '#ffffff', v: 22, side: 0, rot: 0 })
        break
      case EV.GRAB:
        sfx.blip()
        break
      case EV.SUDDEN:
        sfx.powerup()
        break
      case EV.RESPAWN:
        sfx.coin()
        effects.push({ kind: 'ring', x: e.x, y: e.y - 10, t0: nowMs, dur: 500, color, v: 20, side: 0, rot: 0 })
        break
    }
  }
  const play = eventPlayer<Ev>((e) => {
    if (primed) handle(e)
  })

  function draw(ctx: CanvasRenderingContext2D, now: number, props: GameViewProps<View>) {
    const { frames, seats, seat } = props
    const dt = Math.min(0.1, last ? (now - last) / 1000 : 0)
    last = now
    nowMs = now
    colors = seats.map((x) => x.color)
    const sample = frames.sample(now)
    const bv = sample?.b.view
    if (!sample || !bv || !Array.isArray(bv.f)) {
      ctx.fillStyle = '#10131c'
      ctx.fillRect(0, 0, VW, VH)
      drawText(ctx, 'GET READY', VW / 2, VH / 2 - 4, { align: 'center', color: '#ffd23f' })
      return
    }
    const av = Array.isArray(sample.a.view?.f) ? sample.a.view : bv
    const t = sample.t
    const tick = Math.floor(lerp(sample.a.tick, sample.b.tick, t))
    const stageIdx = STAGES[bv.st] ? bv.st : 0
    const st = STAGES[stageIdx]

    play(bv.e?.map((e) => ({ id: e[0], k: e[1], x: e[2], y: e[3], s: e[4], v: e[5] })))
    primed = true

    // Interpolated fighters.
    const fs: Fx[] = bv.f.map((b, i) => {
      const a = av.f[i] ?? b
      const jump = Math.abs(a[0] - b[0]) > 600 || Math.abs(a[1] - b[1]) > 600 || a[3] === DEAD || b[3] === DEAD
      const k = jump ? 1 : t
      return {
        i,
        x: lerp(a[0], b[0], k) / 10,
        y: lerp(a[1], b[1], k) / 10,
        face: b[2],
        anim: b[3],
        t: b[4],
        dmg: b[5],
        stocks: b[6],
        fl: b[7],
        ch: b[8],
        shield: b[9],
        kb: b[10],
      }
    })
    const visible = fs.filter((f) => !(f.fl & FL.OUT) && f.anim !== DEAD)

    // Camera: fit everyone on the field (and the stage's top), smoothly.
    {
      let x0 = Infinity
      let x1 = -Infinity
      let y0 = Infinity
      let y1 = st.main.y + 24
      for (const f of visible) {
        x0 = Math.min(x0, f.x - 28)
        x1 = Math.max(x1, f.x + 28)
        y0 = Math.min(y0, f.y - 48)
        y1 = Math.max(y1, f.y + 16)
      }
      if (!visible.length) {
        x0 = st.main.l
        x1 = st.main.r
        y0 = st.main.y - 100
      }
      const w = x1 - x0
      const h = y1 - y0
      const zt = Math.max(0.6, Math.min(1.5, Math.min(VW / (w + 40), (VH - HUD_H) / (h + 24))))
      let tx = (x0 + x1) / 2
      let ty = (y0 + y1) / 2 + HUD_H / 2 / zt
      const b = st.blast
      const hw = VW / 2 / zt
      const hh = VH / 2 / zt
      tx = b.r - b.l > hw * 2 ? Math.max(b.l + hw, Math.min(b.r - hw, tx)) : 0
      ty = Math.max(b.t + hh, Math.min(b.b + 30 - hh, ty))
      if (!camReady) {
        cam.x = tx
        cam.y = ty
        cam.z = zt
        camReady = true
      } else {
        const k = 1 - Math.exp(-dt * 4)
        cam.x += (tx - cam.x) * k
        cam.y += (ty - cam.y) * k
        cam.z += (zt - cam.z) * (1 - Math.exp(-dt * 3))
      }
    }
    shake = Math.max(0, shake - dt * 22)
    const view: Cam = {
      x: cam.x + ((Math.random() - 0.5) * 2 * shake) / cam.z,
      y: cam.y + ((Math.random() - 0.5) * 2 * shake) / cam.z,
      z: cam.z,
    }
    const z = view.z

    drawBackground(ctx, stageIdx, view, now)
    drawStage(ctx, stageIdx, view, now)

    // Drop shadows.
    for (const f of visible) {
      const gy = groundBelow(stageIdx, f.x, f.y)
      if (gy === null) continue
      const k = 1 - Math.min(1, (gy - f.y) / 160)
      const w = Math.round((CHARS[f.ch]?.hw ?? 6) * 2 * z * (0.5 + k * 0.6))
      ctx.fillStyle = `rgba(10, 6, 20, ${(0.2 + k * 0.25).toFixed(2)})`
      const cx = Math.round(sx(view, f.x))
      const cy = Math.round(sy(view, gy))
      ctx.fillRect(cx - w, cy, w * 2, 1)
      ctx.fillRect(cx - w + 2, cy + 1, Math.max(0, w * 2 - 4), 1)
    }

    // Knockback trails.
    for (const f of visible) {
      if (f.anim === HURT && f.kb > 40 && now - (trailAt[f.i] ?? 0) > 22) {
        trailAt[f.i] = now
        const h = CHARS[f.ch]?.h ?? 22
        particles.push({ x: f.x, y: f.y - h / 2, vx: 0, vy: 0, g: 0, life: 0, max: 0.4, size: 4, color: f.kb > 90 ? colors[f.i] ?? '#fff' : '#f2efe8', scr: false })
      }
    }
    drawParticles(ctx, view, dt, false)

    // Fighters (yours on top).
    const order = [...visible].sort((p, q) => (p.i === seat ? 1 : 0) - (q.i === seat ? 1 : 0) || p.i - q.i)
    for (const f of order) drawFighter(ctx, view, f, seats[f.i], now, tick)
    for (const f of order) drawTag(ctx, view, f, seats[f.i], f.i === seat)

    drawEffects(ctx, view, now)
    drawParticles(ctx, view, dt, true)

    // Fighters out of the frame: a bubble at the edge.
    for (const f of visible) {
      const X = sx(view, f.x)
      const Y = sy(view, f.y - (CHARS[f.ch]?.h ?? 22) / 2)
      if (X >= -2 && X <= VW + 2 && Y >= -2 && Y <= VH - HUD_H) continue
      const bx = Math.max(13, Math.min(VW - 13, X))
      const by = Math.max(13, Math.min(VH - HUD_H - 13, Y))
      const color = seats[f.i]?.color ?? '#fff'
      pixCircle(ctx, bx, by, 11, 'rgba(12, 14, 24, 0.85)', color)
      const icon = headIcon(f.ch, color)
      ctx.drawImage(icon, Math.round(bx - icon.width / 2), Math.round(by - icon.height / 2))
      // Arrow toward the fighter.
      const ang = Math.atan2(Y - by, X - bx)
      ctx.fillStyle = color
      for (let d = 12; d < 15; d++) ctx.fillRect(Math.round(bx + Math.cos(ang) * d) - (15 - d) + 1, Math.round(by + Math.sin(ang) * d) - (15 - d) + 1, (15 - d) * 2 - 1, (15 - d) * 2 - 1)
    }

    drawHud(ctx, bv, fs, seats, now)
    drawOverlay(ctx, bv, seats, now)
  }

  function drawFighter(ctx: CanvasRenderingContext2D, view: Cam, f: Fx, s: GameSeat | undefined, now: number, tick: number) {
    const z = view.z
    const color = s?.color ?? '#ffffff'
    const c = CHARS[f.ch] ?? CHARS[0]
    const X = Math.round(sx(view, f.x)) + (f.fl & FL.HITLAG && f.anim === HURT ? (Math.floor(now / 30) % 2 ? 1 : -1) : 0)
    const Y = Math.round(sy(view, f.y))
    if (f.fl & FL.HALO) {
      // The respawn halo: a glowing disc under the feet.
      const w = Math.max(6, Math.round(15 * z))
      const th = Math.max(2, Math.round(3 * z))
      ctx.fillStyle = '#140f1a'
      ctx.fillRect(X - w - 1, Y - 1, w * 2 + 2, th + 2)
      ctx.fillStyle = color
      ctx.fillRect(X - w, Y, w * 2, th)
      ctx.fillStyle = '#ffffff'
      ctx.fillRect(X - w + 2, Y, w * 2 - 4, 1)
      ctx.fillStyle = `rgba(255, 255, 255, ${(0.3 + Math.sin(now / 120) * 0.2).toFixed(2)})`
      for (let k = 1; k <= 3; k++) ctx.fillRect(X - w + k * 3, Y + th + k * 2, Math.max(0, w * 2 - k * 6), 1)
    }
    const pose = poseFor(f.anim, f.t, f.fl, tick)
    const flash = f.fl & FL.HITLAG && f.anim === HURT && Math.floor(now / 45) % 2 === 0
    const variant = flash ? 'flash' : f.fl & FL.HELPLESS ? 'dim' : 'normal'
    const img = sprite(f.ch, pose, color, variant)
    const blit = (ox: number, oy: number, im: HTMLCanvasElement) => {
      ctx.save()
      ctx.translate(X + ox, Y + oy)
      if (f.face < 0) ctx.scale(-1, 1)
      ctx.drawImage(im, Math.round(-ORIGIN_X * z), Math.round(-ORIGIN_Y * z), Math.round(SPRITE_W * z), Math.round(SPRITE_H * z))
      ctx.restore()
    }
    if (f.fl & FL.COUNTER) {
      const glow = sprite(f.ch, pose, color, 'flash')
      ctx.globalAlpha = 0.7
      for (const [ox, oy] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) blit(ox, oy, glow)
      ctx.globalAlpha = 1
    }
    if (f.fl & FL.INV && !(f.fl & FL.HALO) && Math.floor(now / 70) % 2) ctx.globalAlpha = 0.45
    blit(0, 0, img)
    ctx.globalAlpha = 1
    if (f.fl & FL.SHIELD) {
      const r = (5 + (11 * Math.max(0, f.shield)) / 50) * z * (c.h / 22)
      ctx.globalAlpha = 0.38
      pixCircle(ctx, X, Y - (c.h / 2) * z, r, color)
      ctx.globalAlpha = 0.9
      pixCircle(ctx, X, Y - (c.h / 2) * z, r, null, '#ffffff')
      ctx.globalAlpha = 1
    }
    if (f.fl & FL.DIZZY) {
      for (let k = 0; k < 3; k++) {
        const a = now / 140 + k * 2.09
        ctx.fillStyle = k === 1 ? '#ffffff' : '#ffe66b'
        ctx.fillRect(Math.round(X + Math.cos(a) * 7 * z), Math.round(Y - (c.h + 3) * z + Math.sin(a) * 2 * z), 2, 2)
      }
    }
  }

  function drawTag(ctx: CanvasRenderingContext2D, view: Cam, f: Fx, s: GameSeat | undefined, mine: boolean) {
    const c = CHARS[f.ch] ?? CHARS[0]
    const X = Math.round(sx(view, f.x))
    const top = Math.round(sy(view, f.y - c.h) - 5)
    const color = s?.color ?? '#ffffff'
    ctx.fillStyle = '#140f1a'
    ctx.fillRect(X - 3, top - 4, 7, 2)
    ctx.fillRect(X - 2, top - 2, 5, 2)
    ctx.fillStyle = color
    ctx.fillRect(X - 2, top - 4, 5, 1)
    ctx.fillRect(X - 1, top - 3, 3, 1)
    ctx.fillRect(X, top - 2, 1, 1)
    if (mine) {
      const name = (s?.name ?? 'YOU').slice(0, 10)
      drawText(ctx, name, X, top - 13, { align: 'center', color, shadow: '#140f1a' })
    }
  }

  function drawEffects(ctx: CanvasRenderingContext2D, view: Cam, now: number) {
    for (let i = effects.length - 1; i >= 0; i--) {
      const e = effects[i]
      const k = (now - e.t0) / e.dur
      if (k >= 1) {
        effects.splice(i, 1)
        continue
      }
      if (e.kind === 'blast') {
        drawBlast(ctx, view, e, k)
        continue
      }
      const cx = sx(view, e.x)
      const cy = sy(view, e.y)
      if (e.kind === 'spark') {
        const len = (5 + e.v / 12) * view.z * (0.5 + k * 0.8)
        const rays = e.side ? 10 : 7
        for (let r = 0; r < rays; r++) {
          const a = e.rot * 6.28 + (r / rays) * 6.28
          const from = len * (0.2 + k * 0.6)
          for (let d = from; d < len; d += 1) {
            ctx.fillStyle = d < len * 0.6 ? '#ffffff' : e.color
            ctx.fillRect(Math.round(cx + Math.cos(a) * d), Math.round(cy + Math.sin(a) * d), e.side ? 2 : 1, e.side ? 2 : 1)
          }
        }
        if (k < 0.3) pixCircle(ctx, cx, cy, (2 + e.v / 40) * view.z, '#ffffff')
      } else {
        const r = (3 + e.v * k) * view.z
        ctx.globalAlpha = 1 - k
        pixCircle(ctx, cx, cy, r, null, e.color)
        ctx.globalAlpha = 1
      }
    }
  }

  function drawBlast(ctx: CanvasRenderingContext2D, view: Cam, e: Effect, k: number) {
    const px = Math.max(0, Math.min(VW, sx(view, e.x)))
    const py = Math.max(0, Math.min(VH - HUD_H, sy(view, e.y)))
    if (k < 0.02 && e.v === 0) {
      e.v = 1
      const dir = [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ][e.side] ?? [0, -1]
      for (let i = 0; i < 40; i++) {
        const sp = 1 + Math.random() * 5
        const spread = (Math.random() - 0.5) * 1.6
        particles.push({
          x: px,
          y: py,
          vx: (dir[0] + (dir[1] ? spread : 0)) * sp,
          vy: (dir[1] + (dir[0] ? spread : 0)) * sp,
          g: 0.02,
          life: 0,
          max: 0.5 + Math.random() * 0.5,
          size: 1 + Math.floor(Math.random() * 3),
          color: i % 3 === 0 ? '#ffffff' : i % 3 === 1 ? e.color : '#ffe66b',
          scr: true,
        })
      }
    }
    const len = 170 * Math.min(1, k * 4)
    const fade = 1 - k
    const horizontal = e.side < 2
    const sign = e.side === 0 || e.side === 2 ? 1 : -1
    const drawWedge = (half: number, color: string) => {
      ctx.fillStyle = color
      for (let d = 0; d < len; d += 1) {
        const w = Math.max(0, Math.round(half * (1 - d / len) * (0.6 + 0.4 * Math.sin(d / 7 + k * 20))))
        if (w <= 0) continue
        if (horizontal) ctx.fillRect(Math.round(px + sign * d), Math.round(py - w), 1, w * 2)
        else ctx.fillRect(Math.round(px - w), Math.round(py + sign * d), w * 2, 1)
      }
    }
    ctx.globalAlpha = fade * 0.85
    drawWedge(34, e.color)
    ctx.globalAlpha = fade
    drawWedge(14, '#ffe66b')
    drawWedge(6, '#ffffff')
    ctx.globalAlpha = 1
  }

  function drawParticles(ctx: CanvasRenderingContext2D, view: Cam, dt: number, scr: boolean) {
    const steps = dt * 60
    for (let i = particles.length - 1; i >= 0; i--) {
      const p = particles[i]
      if (p.scr !== scr) continue
      p.life += dt
      if (p.life >= p.max) {
        particles.splice(i, 1)
        continue
      }
      p.vy += p.g * steps
      p.x += p.vx * steps
      p.y += p.vy * steps
      const k = 1 - p.life / p.max
      ctx.globalAlpha = Math.min(1, k * 1.5)
      ctx.fillStyle = p.color
      const size = Math.max(1, Math.round(p.size * (scr ? 1 : view.z) * (0.5 + k * 0.5)))
      const X = scr ? p.x : sx(view, p.x)
      const Y = scr ? p.y : sy(view, p.y)
      ctx.fillRect(Math.round(X - size / 2), Math.round(Y - size / 2), size, size)
    }
    ctx.globalAlpha = 1
    if (particles.length > 600) particles.splice(0, particles.length - 600)
  }

  function drawHud(ctx: CanvasRenderingContext2D, v: View, fs: Fx[], seats: GameSeat[], now: number) {
    const n = fs.length
    const cardW = Math.min(78, Math.floor((VW - 4) / Math.max(1, n)))
    const x0 = Math.round((VW - cardW * n) / 2)
    const y0 = VH - HUD_H + 2
    fs.forEach((f, i) => {
      const s = seats[i]
      const color = s?.color ?? '#ffffff'
      const x = x0 + i * cardW + 1
      const w = cardW - 2
      const out = (f.fl & FL.OUT) !== 0
      if (prevDmg[i] !== undefined && f.dmg > prevDmg[i]) dmgHitAt[i] = now
      prevDmg[i] = f.dmg
      ctx.fillStyle = 'rgba(12, 10, 22, 0.72)'
      ctx.fillRect(x, y0, w, HUD_H - 4)
      ctx.fillStyle = out ? '#555a66' : color
      ctx.fillRect(x, y0, 2, HUD_H - 4)
      // Row 1: name, stocks as pips on the right. Row 2: portrait and the damage %.
      const pips = Math.min(f.stocks, 5)
      const maxChars = Math.max(3, Math.floor((w - 8 - pips * 6) / 6))
      drawText(ctx, (s?.name ?? `P${i + 1}`).slice(0, maxChars), x + 5, y0 + 2, { color: out ? '#6b7080' : color, shadow: '#000' })
      if (out) {
        drawText(ctx, 'OUT', x + w - 4, y0 + 14, { align: 'right', color: '#6b7080' })
        return
      }
      for (let k = 0; k < pips; k++) {
        const px = x + w - 5 - k * 6
        ctx.fillStyle = '#140f1a'
        ctx.fillRect(px - 2, y0 + 3, 5, 5)
        ctx.fillStyle = color
        ctx.fillRect(px - 1, y0 + 4, 3, 3)
        ctx.fillStyle = '#ffffff'
        ctx.fillRect(px - 1, y0 + 4, 1, 1)
      }
      const icon = headIcon(f.ch, color)
      ctx.drawImage(icon, x + 4, y0 + 12)
      const label = `${f.dmg}%`
      const jitter = now - (dmgHitAt[i] ?? -1e9) < 160 ? Math.round((Math.random() - 0.5) * 3) : 0
      const scale = textWidth(label, 2) <= w - icon.width - 10 ? 2 : 1
      drawText(ctx, label, x + w - 3 + jitter, y0 + (scale === 2 ? 11 : 15) + jitter, { align: 'right', color: dmgColor(f.dmg), scale, shadow: '#140f1a' })
    })
    // Timer.
    const tm = Math.max(0, v.tm)
    const text = `${Math.floor(tm / 60)}:${String(tm % 60).padStart(2, '0')}`
    const urgent = v.ph === 1 && tm <= 10
    drawText(ctx, (v.sd ? 'SD ' : '') + text, VW / 2, 4, { align: 'center', color: urgent ? '#ff5a3d' : '#ffffff', scale: urgent ? 2 : 1, shadow: '#140f1a' })
  }

  function drawOverlay(ctx: CanvasRenderingContext2D, v: View, seats: GameSeat[], now: number) {
    const midY = (VH - HUD_H) / 2
    if (v.ph === 0) {
      if (v.sd) drawText(ctx, 'SUDDEN DEATH', VW / 2, midY - 34, { align: 'center', color: '#ff5a3d', scale: 2, shadow: '#140f1a' })
      if (v.cd > 0) drawText(ctx, String(v.cd), VW / 2, midY - 18, { align: 'center', color: '#ffd23f', scale: 6, shadow: '#140f1a' })
    }
    const sinceGo = now - goAt
    if (v.ph === 1 && sinceGo < 900) {
      const scale = sinceGo < 120 ? 7 : 6
      drawText(ctx, 'GO!', VW / 2, midY - 3.5 * scale, { align: 'center', color: '#3ee6b0', scale, shadow: '#140f1a' })
    }
    if (v.ph === 2) {
      const since = now - gameAt
      const scale = since < 150 ? 6 : 5
      drawText(ctx, 'GAME!', VW / 2, midY - 3.5 * scale - 6, { align: 'center', color: '#ffe66b', scale, shadow: '#140f1a' })
      if (v.w.length === 1) {
        const s = seats[v.w[0]]
        if (s) drawText(ctx, `${s.name.slice(0, 16)} WINS`, VW / 2, midY + 20, { align: 'center', color: s.color, scale: 1, shadow: '#140f1a' })
      }
    }
  }

  return { draw }
}

type Runtime = ReturnType<typeof createRuntime>

export default function BrawlView(props: GameViewProps<View>) {
  const rt = useRef<{ matchId: string | null; runtime: Runtime } | null>(null)
  const matchId = props.lobby.matchId
  if (!rt.current || rt.current.matchId !== matchId) rt.current = { matchId, runtime: createRuntime() }
  const runtime = rt.current.runtime
  return <RetroCanvas width={VW} height={VH} draw={(ctx, now) => runtime.draw(ctx, now, props)} />
}
