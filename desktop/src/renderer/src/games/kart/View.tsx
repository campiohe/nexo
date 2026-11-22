// Kart Rally view: a Mode-7 style chase camera behind your kart (spectators follow the leader), karts and items
// as depth-sorted billboards, a minimap, and the race HUD. Positions are interpolated between frames; the
// camera yaw is nudged by your own steering right away so turning doesn't feel late.
import { useMemo, useRef } from 'react'
import { GAME_PAD, GAME_SEAT_COLORS } from '@shared/protocol'
import type { GameSeat } from '@shared/protocol'
import type { KartView as View } from '@shared/games/kart/logic'
import {
  EV_BOOST,
  EV_BOX,
  EV_BUMP,
  EV_COUNT,
  EV_FINAL,
  EV_FINISH,
  EV_GO,
  EV_HIT,
  EV_ITEM,
  EV_LAP,
  EV_SHIELD_POP,
  EV_USE,
  EV_WALL,
  F_BOOST,
  F_DRIFT_L,
  F_DRIFT_R,
  F_FIN,
  F_GONE,
  F_OFF,
  F_SHIELD,
  F_SPARK1,
  F_SPARK2,
  F_SPIN,
  F_WRONG,
  ITEM_BOLT,
  ITEM_COUNT,
  ITEM_NITRO,
  ITEM_NITRO3,
  ITEM_SEEKER,
  ITEM_SHIELD,
  ITEM_SLICK,
  LAPS,
  OBJ_BOLT,
  OBJ_SEEKER,
  OBJ_SLICK,
  TICK_HZ,
  TURN,
  VMAX,
} from '@shared/games/kart/model'
import type { GameViewProps } from '../types'
import { RetroCanvas, drawText, eventPlayer, lerp, sfx } from '../retro'
import {
  CAM_D,
  CAM_H,
  FOCAL,
  H,
  HY,
  KART_FRAMES,
  SPRITE_AX,
  SPRITE_AY,
  SPRITE_H,
  SPRITE_UNIT,
  SPRITE_W,
  W,
  drawWorld,
  kartSprites,
  trackArt,
  type Camera,
  type TrackArt,
} from './render'


const TAU = Math.PI * 2
const wrap = (a: number) => {
  a = (a + Math.PI) % TAU
  if (a < 0) a += TAU
  return a - Math.PI
}
const lerpAngle = (a: number, b: number, t: number) => a + wrap(b - a) * t
/** Until measured: how far behind the server's view of our own input we draw (frames.latencyMs() after). */
const DEFAULT_LATENCY_MS = 110

interface Ev {
  id: number
  e: number
  s: number
  v: number
}

interface DrawKart {
  i: number
  x: number
  y: number
  a: number
  m: number
  v: number
  z: number
  f: number
}

interface Local {
  img: ImageData | null
  buf: Uint32Array | null
  camA: number | null
  camFocus: number
  lastNow: number
  steer: { t: number; s: number; dt: number }[]
  banner: { text: string; color: string; until: number; scale: number } | null
  finishAt: number
  focus: number
}

const ORD = ['TH', 'ST', 'ND', 'RD']
const ordinal = (n: number) => (n % 100 >= 11 && n % 100 <= 13 ? 'TH' : (ORD[n % 10] ?? 'TH'))
const PLACE_COLORS = ['#ffd23f', '#d8e0ec', '#e09a5a']

function raceTime(ticks: number): string {
  const tenths = Math.floor((Math.max(0, ticks) * 10) / TICK_HZ)
  const m = Math.floor(tenths / 600)
  const sec = Math.floor((tenths % 600) / 10)
  return `${m}:${sec < 10 ? '0' : ''}${sec}.${tenths % 10}`
}

export default function KartView({ lobby, seats, seat, frames, localButtons }: GameViewProps<View>) {
  const local = useRef<Local>({
    img: null,
    buf: null,
    camA: null,
    camFocus: -1,
    lastNow: 0,
    steer: [],
    banner: null,
    finishAt: 0,
    focus: -1,
  })

  const play = useMemo(() => {
    void lobby.matchId
    return eventPlayer<Ev>((e) => {
      const L = local.current
      const now = performance.now()
      const mine = e.s === L.focus
      switch (e.e) {
        case EV_COUNT:
          sfx.countdown(false)
          break
        case EV_GO:
          sfx.countdown(true)
          break
        case EV_LAP:
          if (mine) {
            sfx.coin()
            L.banner = { text: `LAP ${e.v}`, color: '#ffffff', until: now + 1500, scale: 3 }
          }
          break
        case EV_FINAL:
          if (mine) {
            sfx.powerup()
            L.banner = { text: 'FINAL LAP', color: '#ff5a5f', until: now + 2200, scale: 3 }
          }
          break
        case EV_FINISH:
          if (mine) {
            sfx.win()
            L.finishAt = now
            L.banner = { text: 'FINISH!', color: '#ffd23f', until: now + 2600, scale: 4 }
          }
          break
        case EV_ITEM:
          if (mine) sfx.select()
          break
        case EV_BOX:
          if (mine) sfx.blip()
          break
        case EV_USE:
          if (!mine) break
          if (e.v === ITEM_SLICK) sfx.noise({ ms: 160, volume: 0.6, lowpass: 900 })
          else if (e.v === ITEM_BOLT) sfx.tone({ freq: 900, to: 1800, ms: 140, type: 'sawtooth', volume: 0.45 })
          else if (e.v === ITEM_SEEKER) sfx.tone({ freq: 400, to: 1200, ms: 260, volume: 0.45 })
          else if (e.v === ITEM_SHIELD) sfx.tone({ freq: 500, to: 1000, ms: 220, type: 'triangle', volume: 0.6 })
          break
        case EV_BOOST:
          if (mine) sfx.tone({ freq: 180, to: 760, ms: e.v >= 2 ? 320 : 220, type: 'sawtooth', volume: 0.4 })
          break
        case EV_BUMP:
          if (mine || e.v === L.focus) sfx.hit()
          break
        case EV_WALL:
          if (mine) sfx.noise({ ms: 90, volume: 0.6, lowpass: 1400 })
          break
        case EV_HIT:
          if (!mine) break
          if (e.v === OBJ_SLICK) sfx.tone({ freq: 700, to: 200, ms: 500, type: 'triangle', volume: 0.6 })
          else sfx.explode()
          break
        case EV_SHIELD_POP:
          if (mine) sfx.tone({ freq: 1400, to: 500, ms: 160, type: 'square', volume: 0.5 })
          break
      }
    })
  }, [lobby.matchId])

  const colorOf = (i: number) => seats[i]?.color ?? GAME_SEAT_COLORS[i % GAME_SEAT_COLORS.length]

  const draw = (ctx: CanvasRenderingContext2D, now: number) => {
    const L = local.current
    const dtMs = L.lastNow ? Math.min(100, now - L.lastNow) : 16
    L.lastNow = now
    const latest = frames.latest()
    const sample = frames.sample(now)
    if (!latest || !sample) {
      ctx.fillStyle = '#0c0f1a'
      ctx.fillRect(0, 0, W, H)
      drawText(ctx, 'GET READY', W / 2, H / 2 - 4, { align: 'center', color: '#ffd23f', scale: 2 })
      return
    }
    const cur = latest.view
    const A = sample.a.view
    const B = sample.b.view
    const t = sample.t
    if (!L.img || !L.buf) {
      L.img = ctx.createImageData(W, H)
      L.buf = new Uint32Array(L.img.data.buffer)
    }
    const art = trackArt(cur.tr)

    // Interpolated karts.
    const karts: DrawKart[] = cur.k.map((kc, i) => {
      const ka = A.k[i] ?? kc
      const kb = B.k[i] ?? kc
      return {
        i,
        x: lerp(ka[0], kb[0], t) / 10,
        y: lerp(ka[1], kb[1], t) / 10,
        a: lerpAngle(ka[2] / 1000, kb[2] / 1000, t),
        m: lerpAngle(ka[3] / 1000, kb[3] / 1000, t),
        v: lerp(ka[4], kb[4], t),
        z: lerp(ka[5], kb[5], t) / 10,
        f: kb[6],
      }
    })

    // Whom the camera follows: you, or the leader when you're watching.
    const mineOk = seat !== null && cur.k[seat] && !(cur.k[seat][6] & F_GONE)
    let focus = mineOk && seat !== null ? seat : 0
    if (!mineOk) {
      for (let i = 0; i < cur.k.length; i++) if (!(cur.k[i][6] & F_GONE) && cur.k[i][11] === 1) focus = i
    }
    L.focus = focus
    play(cur.ev)
    const fk = karts[focus]
    const fv = cur.k[focus]

    // Yaw prediction from our own steering not yet reflected by the server.
    let pred = 0
    const racing = cur.ph === 1 && mineOk && !(fv[6] & (F_FIN | F_SPIN))
    const btn = racing ? localButtons() : 0
    const dir = (btn & GAME_PAD.RIGHT ? 1 : 0) - (btn & GAME_PAD.LEFT ? 1 : 0)
    L.steer.push({ t: now, s: dir, dt: dtMs })
    const latency = frames.latencyMs?.() ?? DEFAULT_LATENCY_MS
    while (L.steer.length > 0 && L.steer[0].t < now - latency) L.steer.shift()
    if (racing) {
      const sp = Math.abs(fk.v)
      const drifting = (fv[6] & (F_DRIFT_L | F_DRIFT_R)) !== 0
      const w = drifting ? TURN * 0.48 : TURN * Math.min(1, sp / 28) * (1 - 0.18 * Math.min(1, sp / VMAX))
      let sum = 0
      for (const s of L.steer) sum += s.s * (s.dt / 1000)
      pred = sum * w * 0.75 * (fk.v < 0 ? -1 : 1)
    }
    const spinning = (fv[6] & F_SPIN) !== 0
    const target = (spinning ? fk.m : lerpAngle(fk.m, fk.a, 0.45)) + pred
    if (L.camA === null || L.camFocus !== focus) L.camA = target
    else L.camA = wrap(L.camA + wrap(target - L.camA) * Math.min(1, (dtMs / 1000) * 9))
    L.camFocus = focus
    const ca = L.camA
    const cam: Camera = {
      x: fk.x - Math.cos(ca) * CAM_D,
      y: fk.y - Math.sin(ca) * CAM_D,
      a: ca,
      h: CAM_H + fk.z * 0.5,
    }
    if (mineOk) fk.a += pred

    drawWorld(L.buf, art, cam)
    ctx.putImageData(L.img, 0, 0)
    drawSprites(ctx, now, art, cam, cur, karts, focus, colorOf)
    drawHud(ctx, now, art, cur, karts, focus, mineOk, seats, colorOf, L)
  }

  return <RetroCanvas width={W} height={H} draw={draw} />
}

// ---------------------------------------------------------------------------------------------
// Billboards

interface Proj {
  sx: number
  sy: number
  sc: number
  fz: number
}

function project(cam: Camera, x: number, y: number, z: number): Proj | null {
  const dx = x - cam.x
  const dy = y - cam.y
  const c = Math.cos(cam.a)
  const s = Math.sin(cam.a)
  const fz = dx * c + dy * s
  if (fz < 8 || fz > 1300) return null
  const rx = -dx * s + dy * c
  const sc = FOCAL / fz
  const sx = W / 2 + rx * sc
  if (sx < -80 || sx > W + 80) return null
  return { sx, sy: HY + (cam.h - z) * sc, sc, fz }
}

function shadow(ctx: CanvasRenderingContext2D, cam: Camera, p: Proj, r: number, alpha = 0.35) {
  ctx.fillStyle = `rgba(0,0,0,${alpha})`
  ctx.beginPath()
  ctx.ellipse(Math.round(p.sx), Math.round(p.sy), Math.max(1, r * p.sc), Math.max(0.6, (r * p.sc * cam.h) / p.fz), 0, 0, TAU)
  ctx.fill()
}

function drawSprites(
  ctx: CanvasRenderingContext2D,
  now: number,
  art: TrackArt,
  cam: Camera,
  v: View,
  karts: DrawKart[],
  focus: number,
  colorOf: (i: number) => string,
) {
  const list: { fz: number; draw: () => void }[] = []
  // Item boxes ("prize crystals").
  art.track.boxes.forEach(([bx, by], i) => {
    if (!(v.bx & (1 << i))) return
    const bob = Math.sin(now / 300 + i) * 1.2
    const g = project(cam, bx, by, 0)
    const p = project(cam, bx, by, 6 + bob)
    if (!g || !p) return
    list.push({
      fz: p.fz,
      draw: () => {
        shadow(ctx, cam, g, 4, 0.3)
        const spin = now / 260 + i * 0.7
        const hw = Math.max(1, 4.5 * p.sc * (0.35 + 0.65 * Math.abs(Math.cos(spin))))
        const hh = 6 * p.sc
        const hue = (now / 6 + i * 45) % 360
        ctx.fillStyle = `hsl(${hue},90%,62%)`
        ctx.beginPath()
        ctx.moveTo(p.sx, p.sy - hh)
        ctx.lineTo(p.sx + hw, p.sy)
        ctx.lineTo(p.sx, p.sy + hh)
        ctx.lineTo(p.sx - hw, p.sy)
        ctx.fill()
        ctx.fillStyle = `hsl(${(hue + 60) % 360},95%,80%)`
        ctx.beginPath()
        ctx.moveTo(p.sx, p.sy - hh)
        ctx.lineTo(p.sx + hw * 0.5, p.sy - hh * 0.2)
        ctx.lineTo(p.sx - hw * 0.4, p.sy - hh * 0.1)
        ctx.fill()
        if (p.sc > 1.2) drawText(ctx, '!', p.sx + 1, p.sy - 3, { align: 'center', color: '#ffffff', shadow: '#00000088' })
      },
    })
  })
  // Track objects.
  for (const o of v.o) {
    const [type, x10, y10] = o
    const x = x10 / 10
    const y = y10 / 10
    if (type === OBJ_SLICK) {
      const p = project(cam, x, y, 0)
      if (!p) continue
      list.push({
        fz: p.fz + 4,
        draw: () => {
          const rx = 8 * p.sc
          const ry = Math.max(1, (rx * cam.h) / p.fz)
          ctx.fillStyle = '#2a1640'
          ctx.beginPath()
          ctx.ellipse(p.sx, p.sy, rx, ry, 0, 0, TAU)
          ctx.fill()
          ctx.fillStyle = '#6a3fa8'
          ctx.beginPath()
          ctx.ellipse(p.sx - rx * 0.2, p.sy - ry * 0.2, rx * 0.55, ry * 0.5, 0, 0, TAU)
          ctx.fill()
          ctx.fillStyle = '#c9a8ff'
          ctx.fillRect(Math.round(p.sx - rx * 0.4), Math.round(p.sy - ry * 0.4), Math.max(1, rx * 0.2), 1)
        },
      })
    } else {
      const z = type === OBJ_BOLT ? 4 : 5 + Math.sin(now / 90) * 0.8
      const p = project(cam, x, y, z)
      const g = project(cam, x, y, 0)
      if (!p || !g) continue
      list.push({
        fz: p.fz,
        draw: () => {
          shadow(ctx, cam, g, 2.5, 0.3)
          const r = Math.max(1.5, 3.2 * p.sc)
          if (type === OBJ_BOLT) {
            ctx.fillStyle = 'rgba(80,240,255,0.45)'
            ctx.beginPath()
            ctx.arc(p.sx, p.sy, r * 1.6, 0, TAU)
            ctx.fill()
            ctx.fillStyle = '#7ff6ff'
            ctx.beginPath()
            ctx.arc(p.sx, p.sy, r, 0, TAU)
            ctx.fill()
            ctx.fillStyle = '#ffffff'
            ctx.beginPath()
            ctx.arc(p.sx, p.sy, r * 0.45, 0, TAU)
            ctx.fill()
          } else if (type === OBJ_SEEKER) {
            ctx.fillStyle = '#7a1020'
            ctx.fillRect(Math.round(p.sx - r * 1.6), Math.round(p.sy - r * 0.3), Math.round(r * 3.2), Math.max(1, Math.round(r * 0.6)))
            ctx.fillStyle = '#ff3b4e'
            ctx.beginPath()
            ctx.arc(p.sx, p.sy, r, 0, TAU)
            ctx.fill()
            ctx.fillStyle = Math.floor(now / 120) % 2 ? '#ffffff' : '#ffd23f'
            ctx.fillRect(Math.round(p.sx - 1), Math.round(p.sy - r * 0.6), 2, 2)
          }
        },
      })
    }
  }
  // Karts.
  for (const k of karts) {
    if (k.f & F_GONE) continue
    const g = project(cam, k.x, k.y, 0)
    if (!g) continue
    list.push({ fz: g.fz, draw: () => drawKart(ctx, now, cam, k, g, colorOf(k.i), k.i === focus) })
  }
  list.sort((a, b) => b.fz - a.fz)
  for (const s of list) s.draw()
}

function drawKart(ctx: CanvasRenderingContext2D, now: number, cam: Camera, k: DrawKart, g: Proj, color: string, focus: boolean) {
  shadow(ctx, cam, g, 6.5)
  const ray = Math.atan2(k.y - cam.y, k.x - cam.x)
  let phi = k.a - ray
  if (k.f & F_SPIN) phi += now * 0.025
  let frame = Math.round((phi / TAU) * KART_FRAMES) % KART_FRAMES
  if (frame < 0) frame += KART_FRAMES
  const sprite = kartSprites(color)[frame]
  const u = SPRITE_UNIT * g.sc
  const dw = SPRITE_W * u
  const dh = SPRITE_H * u
  const top = g.sy - k.z * g.sc
  const dx = Math.round(g.sx - SPRITE_AX * u)
  const dy = Math.round(top - SPRITE_AY * u)
  const rear = (dist: number, side: number, z: number) =>
    project(cam, k.x - Math.cos(k.a) * dist - Math.sin(k.a) * side, k.y - Math.sin(k.a) * dist + Math.cos(k.a) * side, z + k.z)
  // Boost flame / drift sparks behind the kart when seen from behind are drawn after the body; in front otherwise.
  const behind = Math.cos(phi) > 0
  const effects = () => {
    if (k.f & F_BOOST) {
      const p = rear(8, 0, 2.5)
      if (p) {
        const r = Math.max(1, 2.4 * p.sc)
        const flick = 0.7 + Math.random() * 0.6
        ctx.fillStyle = '#ff7a1a'
        ctx.fillRect(Math.round(p.sx - r), Math.round(p.sy - r), Math.round(r * 2), Math.round(r * 2 * flick))
        ctx.fillStyle = '#fff2a0'
        ctx.fillRect(Math.round(p.sx - r / 2), Math.round(p.sy - r / 2), Math.max(1, Math.round(r)), Math.max(1, Math.round(r * flick)))
      }
    }
    if (k.f & (F_DRIFT_L | F_DRIFT_R)) {
      const c = k.f & F_SPARK2 ? '#ff5cf0' : k.f & F_SPARK1 ? '#4ff0ff' : 'rgba(255,255,255,0.75)'
      for (const side of [-4.5, 4.5]) {
        const p = rear(6, side, 0.5)
        if (!p) continue
        ctx.fillStyle = c
        for (let n = 0; n < 3; n++) {
          const sz = Math.max(1, Math.round(p.sc * (k.f & (F_SPARK1 | F_SPARK2) ? 1.2 : 0.8)))
          ctx.fillRect(Math.round(p.sx + (Math.random() - 0.5) * 6 * p.sc), Math.round(p.sy - Math.random() * 4 * p.sc), sz, sz)
        }
      }
    } else if (k.f & F_OFF && Math.abs(k.v) > 15) {
      const p = rear(6, 0, 0.5)
      if (p) {
        ctx.fillStyle = 'rgba(120,96,60,0.7)'
        for (let n = 0; n < 3; n++) ctx.fillRect(Math.round(p.sx + (Math.random() - 0.5) * 10 * p.sc), Math.round(p.sy - Math.random() * 3 * p.sc), 2, 2)
      }
    }
  }
  if (!behind) effects()
  ctx.drawImage(sprite, dx, dy, Math.round(dw), Math.round(dh))
  if (behind) effects()
  if (k.f & F_SHIELD) {
    const r = 9 * g.sc
    ctx.strokeStyle = `rgba(150,225,255,${0.6 + Math.sin(now / 120) * 0.25})`
    ctx.lineWidth = Math.max(1, g.sc * 0.8)
    ctx.fillStyle = 'rgba(150,225,255,0.14)'
    ctx.beginPath()
    ctx.arc(g.sx, top - 4 * g.sc, r, 0, TAU)
    ctx.fill()
    ctx.stroke()
  }
  if (!focus && g.fz < 220 && g.sc > 0.9) {
    // A small seat-colored marker over other karts.
    ctx.fillStyle = color
    const mx = Math.round(g.sx)
    const my = Math.round(top - 13 * g.sc - 4)
    ctx.fillRect(mx - 2, my, 5, 1)
    ctx.fillRect(mx - 1, my + 1, 3, 1)
    ctx.fillRect(mx, my + 2, 1, 1)
  }
}

// ---------------------------------------------------------------------------------------------
// HUD

function drawIcon(ctx: CanvasRenderingContext2D, item: number, x: number, y: number) {
  const r = (c: string, px: number, py: number, w: number, h: number) => {
    ctx.fillStyle = c
    ctx.fillRect(x + px, y + py, w, h)
  }
  if (item === ITEM_NITRO || item === ITEM_NITRO3) {
    const can = (ox: number, w: number) => {
      r('#9aa3b5', ox + 1, 1, w - 2, 2)
      r('#e8402a', ox, 3, w, 10)
      r('#ffffff', ox, 6, w, 2)
      r('#ffd23f', ox + 1, 13, w - 2, 2)
    }
    if (item === ITEM_NITRO) can(5, 6)
    else {
      can(1, 4)
      can(6, 4)
      can(11, 4)
    }
  } else if (item === ITEM_SLICK) {
    r('#2a1640', 2, 8, 12, 5)
    r('#2a1640', 4, 6, 8, 9)
    r('#6a3fa8', 4, 8, 6, 3)
    r('#c9a8ff', 5, 8, 2, 1)
  } else if (item === ITEM_BOLT) {
    r('#1aa8c8', 4, 4, 8, 8)
    r('#7ff6ff', 5, 5, 6, 6)
    r('#ffffff', 7, 7, 2, 2)
    r('#7ff6ff', 0, 7, 3, 2)
  } else if (item === ITEM_SEEKER) {
    r('#7a1020', 1, 7, 14, 2)
    r('#ff3b4e', 4, 4, 8, 8)
    r('#ffd23f', 7, 5, 2, 2)
    r('#ffffff', 7, 0, 2, 3)
    r('#ffffff', 7, 13, 2, 3)
  } else if (item === ITEM_SHIELD) {
    ctx.strokeStyle = '#96e1ff'
    ctx.lineWidth = 2
    ctx.beginPath()
    ctx.arc(x + 8, y + 8, 6, 0, TAU)
    ctx.stroke()
    r('#ffffff', 5, 4, 2, 2)
  }
}

function drawHud(
  ctx: CanvasRenderingContext2D,
  now: number,
  art: TrackArt,
  v: View,
  karts: DrawKart[],
  focus: number,
  mine: boolean,
  seats: GameSeat[],
  colorOf: (i: number) => string,
  L: Local,
) {
  const fv = v.k[focus]
  const flags = fv[6]
  const sh = '#000000aa'
  const nameOf = (i: number) => (seats[i]?.name ?? `KART ${i + 1}`).toUpperCase()

  // Position and lap.
  const rank = fv[11]
  const pc = PLACE_COLORS[rank - 1] ?? '#ffffff'
  drawText(ctx, String(rank), 6, 5, { scale: 3, color: pc, shadow: '#000000' })
  drawText(ctx, ordinal(rank), 6 + (String(rank).length * 6 - 1) * 3 + 2, 5, { color: pc, shadow: '#000000' })
  drawText(ctx, `LAP ${Math.min(LAPS, fv[10])}/${LAPS}`, 6, 29, { shadow: '#000000' })

  // Race time.
  const time = flags & F_FIN ? fv[12] : v.ph === 0 ? 0 : v.t
  drawText(ctx, raceTime(time), W - 5, 5, { align: 'right', shadow: '#000000', color: flags & F_FIN ? '#ffd23f' : '#ffffff' })

  // Item slot.
  const ix = W / 2 - 12
  ctx.fillStyle = 'rgba(10,12,24,0.7)'
  ctx.fillRect(ix, 3, 24, 22)
  ctx.strokeStyle = '#ffffff'
  ctx.lineWidth = 1
  ctx.strokeRect(ix + 0.5, 3.5, 23, 21)
  if (mine) {
    const item = fv[7]
    const roll = fv[9]
    if (roll > 0) drawIcon(ctx, 1 + (Math.floor(now / 70) % (ITEM_COUNT - 1)), ix + 4, 6)
    else if (item) {
      drawIcon(ctx, item, ix + 4, 6)
      if (item === ITEM_NITRO3 && fv[8] > 1) drawText(ctx, `X${fv[8]}`, ix + 25, 18, { shadow: '#000000' })
    }
  }

  // Standings column.
  const order = karts.filter((k) => !(k.f & F_GONE)).sort((a, b) => v.k[a.i][11] - v.k[b.i][11])
  order.forEach((k, r) => {
    const y = 18 + r * 9
    ctx.fillStyle = 'rgba(10,12,24,0.55)'
    ctx.fillRect(W - 44, y - 1, 41, 9)
    ctx.fillStyle = colorOf(k.i)
    ctx.fillRect(W - 43, y, 3, 7)
    drawText(ctx, nameOf(k.i).slice(0, 5), W - 38, y, { color: k.i === focus ? '#ffffff' : '#aab4c8' })
  })

  // Minimap.
  const mx = 4
  const my = H - art.map.height - 4
  ctx.drawImage(art.map, mx, my)
  const ms = art.mapScale
  for (const k of [...karts].reverse()) {
    if (k.f & F_GONE) continue
    const px = Math.round(mx + (k.x - art.ox) * ms)
    const py = Math.round(my + (k.y - art.oy) * ms)
    if (k.i === focus) {
      ctx.fillStyle = '#ffffff'
      ctx.fillRect(px - 2, py - 2, 5, 5)
    }
    ctx.fillStyle = colorOf(k.i)
    ctx.fillRect(px - 1, py - 1, 3, 3)
  }

  // Countdown / GO.
  if (v.ph === 0) {
    const n = Math.max(1, Math.ceil(v.t / TICK_HZ))
    drawText(ctx, String(n), W / 2, 52, { align: 'center', scale: 6, color: '#ffd23f', shadow: '#000000' })
    drawText(ctx, art.track.def.name.toUpperCase(), W / 2, 100, { align: 'center', color: '#ffffff', shadow: '#000000' })
  } else if (v.ph === 1 && v.t < TICK_HZ) {
    drawText(ctx, 'GO!', W / 2, 52, { align: 'center', scale: 6, color: '#3ee6b0', shadow: '#000000' })
  }

  const b = L.banner
  if (b && now < b.until && v.ph === 1) {
    if (Math.floor(now / 150) % 4 !== 3 || b.text === 'FINISH!') {
      drawText(ctx, b.text, W / 2, 60, { align: 'center', scale: b.scale, color: b.color, shadow: '#000000' })
    }
  }
  if (flags & F_WRONG && Math.floor(now / 300) % 2 === 0) {
    drawText(ctx, 'WRONG WAY', W / 2, 90, { align: 'center', scale: 2, color: '#ff5a5f', shadow: '#000000' })
  }
  if (v.end >= 0 && !(flags & F_FIN) && mine) {
    drawText(ctx, `ENDS IN ${Math.ceil(v.end / TICK_HZ)}`, W / 2, 30, { align: 'center', color: '#ff9f43', shadow: sh })
  }
  if (!mine) {
    drawText(ctx, `WATCHING ${nameOf(focus)}`, W / 2, H - 11, { align: 'center', color: '#ffd23f', shadow: '#000000' })
  }

  // Final standings: once you finished (after the banner) or when the race is over.
  const showStandings = v.ph >= 2 || (mine && flags & F_FIN && now - L.finishAt > 2600)
  if (showStandings) {
    const list = v.ord.length > 0 ? v.ord : order.map((k) => k.i)
    const rows = list.length
    const bw = 170
    const bh = 22 + rows * 10
    const bx = Math.round(W / 2 - bw / 2)
    const by = Math.round(H / 2 - bh / 2) + 4
    ctx.fillStyle = 'rgba(8,10,20,0.82)'
    ctx.fillRect(bx, by, bw, bh)
    ctx.strokeStyle = '#ffd23f'
    ctx.strokeRect(bx + 0.5, by + 0.5, bw - 1, bh - 1)
    drawText(ctx, v.ph >= 2 ? 'RESULTS' : 'STANDINGS', W / 2, by + 6, { align: 'center', color: '#ffd23f' })
    list.forEach((i, r) => {
      const y = by + 18 + r * 10
      const k = v.k[i]
      const gone = k[6] & F_GONE
      drawText(ctx, `${r + 1}`, bx + 8, y, { color: PLACE_COLORS[r] ?? '#aab4c8' })
      ctx.fillStyle = colorOf(i)
      ctx.fillRect(bx + 20, y, 3, 7)
      drawText(ctx, nameOf(i).slice(0, 14), bx + 27, y, { color: i === focus ? '#ffffff' : '#c8d0e0' })
      const tt = gone ? 'OUT' : k[12] >= 0 ? raceTime(k[12]) : v.ph >= 2 ? 'DNF' : '--'
      drawText(ctx, tt, bx + bw - 7, y, { align: 'right', color: '#c8d0e0' })
    })
  }
}
