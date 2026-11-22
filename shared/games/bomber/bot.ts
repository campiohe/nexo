// Blast Arena computer players. Each tick: a danger map (when each tile will burn, chain reactions included, and
// when sudden-death blocks land) shared by every bot, then a BFS from the bot's tile. In danger: run to the
// nearest tile that stays safe, through tiles that won't be burning while it passes. Otherwise: go for power-ups,
// spots where a bomb would break crates or catch a rival, or toward the nearest rival, and drop a bomb only when
// a BFS with that bomb added finds a way out. A few hundred tile visits per bot per tick.
import { GAME_PAD } from '../../protocol.ts'
import type { GameContext } from '../types.ts'
import {
  DX,
  DY,
  FALL_T,
  FIRE_T,
  FUSE,
  H,
  HALF,
  I_NONE,
  PH_END,
  PH_PLAY,
  SD_EVERY,
  SPIRAL,
  T_CRATE,
  T_FLOOR,
  TILE,
  W,
  blastTiles,
  cellOf,
  centerOf,
  idx,
  inside,
  speedOf,
  tileOf,
  type BomberState,
} from './core.ts'

const INF = 1 << 29
const N = W * H
const DIR_BITS = [GAME_PAD.UP, GAME_PAD.DOWN, GAME_PAD.LEFT, GAME_PAD.RIGHT]
/** How far ahead (ticks) the bots look at the sudden-death spiral. */
const SD_HORIZON = 90

interface Danger {
  /** Tick (from now) a blast reaches each tile (0 = burning now), INF = never. */
  from: number[]
  /** Tick it's over. */
  to: number[]
  /** Tick a sudden-death block lands there, INF = not soon. */
  block: number[]
  /** Crates some bomb will already break. */
  doomed: boolean[]
  /** Tiles holding a bomb. */
  bomb: boolean[]
}

function computeDanger(s: BomberState, extra?: { c: number; range: number }): Danger {
  const from = new Array<number>(N).fill(INF)
  const to = new Array<number>(N).fill(-1)
  const block = new Array<number>(N).fill(INF)
  const doomed = new Array<boolean>(N).fill(false)
  const bomb = new Array<boolean>(N).fill(false)
  const list = s.bombs.map((b) => ({ c: tileOf(b), fuse: Math.max(0, b.fuse), range: b.range }))
  if (extra) list.push({ c: extra.c, fuse: FUSE, range: extra.range })
  for (const b of list) bomb[b.c] = true
  const blasts = list.map((b) => blastTiles(s, b.c, b.range))
  // Chain reactions: a bomb inside another's blast goes off no later than it.
  for (let changed = true, guard = 0; changed && guard <= list.length; guard++) {
    changed = false
    for (let i = 0; i < list.length; i++) {
      for (let j = 0; j < list.length; j++) {
        if (i !== j && list[j].fuse > list[i].fuse && blasts[i].includes(list[j].c)) {
          list[j].fuse = list[i].fuse
          changed = true
        }
      }
    }
  }
  for (let i = 0; i < list.length; i++) {
    const t = list[i].fuse
    for (const c of blasts[i]) {
      from[c] = Math.min(from[c], t)
      to[c] = Math.max(to[c], t + FIRE_T + 1)
    }
    markDoomed(s, list[i].c, list[i].range, doomed)
  }
  for (let c = 0; c < N; c++) {
    if (s.fire[c] > 0) {
      from[c] = 0
      to[c] = Math.max(to[c], s.fire[c] + 1)
    }
  }
  // Sudden death: blocks already falling, then the next ones of the spiral.
  for (const f of s.falling) block[f[0]] = f[1]
  const start = s.sdT >= 0 ? SD_EVERY - (s.sdT % SD_EVERY) : s.timeLeft
  if (start < SD_HORIZON) {
    for (let k = s.sdNext; k < SPIRAL.length; k++) {
      const t = start + (k - s.sdNext) * SD_EVERY + FALL_T
      if (t > SD_HORIZON) break
      block[SPIRAL[k]] = Math.min(block[SPIRAL[k]], t)
    }
  }
  return { from, to, block, doomed, bomb }
}

function markDoomed(s: BomberState, c: number, range: number, doomed: boolean[]) {
  const cx = c % W
  const cy = (c - cx) / W
  for (let d = 0; d < 4; d++) {
    for (let k = 1; k <= range; k++) {
      const x = cx + DX[d] * k
      const y = cy + DY[d] * k
      if (!inside(x, y)) break
      const n = idx(x, y)
      if (s.grid[n] === T_CRATE) doomed[n] = true
      if (s.grid[n] !== T_FLOOR || s.items[n] !== I_NONE) break
    }
  }
}

const cache = new WeakMap<BomberState, { tick: number; danger: Danger }>()
function dangerOf(s: BomberState): Danger {
  const hit = cache.get(s)
  if (hit && hit.tick === s.tick) return hit.danger
  const danger = computeDanger(s)
  cache.set(s, { tick: s.tick, danger })
  return danger
}

interface Search {
  dist: number[]
  /** The first tile of the path to each reached tile (-1 for the start). */
  first: number[]
  order: number[]
}

/**
 * BFS from seat `i`'s tile. `strict`: only tiles with no danger at all. Otherwise: tiles that aren't burning
 * while the bot's center passes through them (and no block lands meanwhile).
 */
function search(s: BomberState, i: number, dz: Danger, strict: boolean): Search {
  const p = s.players[i]
  const start = tileOf(p)
  const sp = speedOf(p)
  const tpt = Math.ceil(TILE / sp)
  const offX = p.x - centerOf(cellOf(p.x))
  const offY = p.y - centerOf(cellOf(p.y))
  const dist = new Array<number>(N).fill(-1)
  const first = new Array<number>(N).fill(-1)
  /** Tick the bot's center enters each tile. */
  const enterAt = new Array<number>(N).fill(0)
  const order = [start]
  dist[start] = 0
  for (let h = 0; h < order.length; h++) {
    const c = order[h]
    const cx = c % W
    const cy = (c - cx) / W
    for (let d = 0; d < 4; d++) {
      const x = cx + DX[d]
      const y = cy + DY[d]
      if (!inside(x, y)) continue
      const n = idx(x, y)
      if (dist[n] >= 0 || s.grid[n] !== T_FLOOR || dz.bomb[n]) continue
      // From the start: the real distance to that edge (straightening up first); further: one tile per tile.
      const enter =
        c === start
          ? Math.ceil((HALF - (offX * DX[d] + offY * DY[d]) + Math.abs(d < 2 ? offX : offY)) / sp)
          : enterAt[c] + tpt
      const leave = enter + tpt
      if (strict) {
        if (dz.from[n] < INF || dz.block[n] < INF) continue
      } else {
        if (dz.from[n] <= leave + 1 && dz.to[n] >= enter - 1) continue
        if (dz.block[n] <= leave + 2) continue
      }
      dist[n] = dist[c] + 1
      enterAt[n] = enter
      first[n] = first[c] < 0 ? n : first[c]
      order.push(n)
    }
  }
  return { dist, first, order }
}

/** Buttons to walk from tile `from` toward its neighbor `to`. */
function toward(from: number, to: number): number {
  const fx = from % W
  const tx = to % W
  if (tx < fx) return GAME_PAD.LEFT
  if (tx > fx) return GAME_PAD.RIGHT
  return to < from ? GAME_PAD.UP : GAME_PAD.DOWN
}

const isSafe = (dz: Danger, c: number) => dz.from[c] >= INF && dz.block[c] >= INF

/** Crates a bomb on tile c would break (not already doomed) and rivals it would catch. */
function bombValue(s: BomberState, c: number, range: number, dz: Danger, enemies: number[]): number {
  const cx = c % W
  const cy = (c - cx) / W
  let crates = 0
  let rivals = enemies.includes(c) ? 1 : 0
  for (let d = 0; d < 4; d++) {
    for (let k = 1; k <= range; k++) {
      const x = cx + DX[d] * k
      const y = cy + DY[d] * k
      if (!inside(x, y)) break
      const n = idx(x, y)
      if (s.grid[n] === T_CRATE) {
        if (!dz.doomed[n]) crates++
        break
      }
      if (s.grid[n] !== T_FLOOR) break
      if (enemies.includes(n)) rivals++
      if (s.items[n] !== I_NONE) break
    }
  }
  return crates * 10 + rivals * 24
}

export function botButtons(s: BomberState, i: number, ctx: GameContext): number {
  if (s.phase !== PH_PLAY && s.phase !== PH_END) return 0
  const p = s.players[i]
  const mem = s.bots[i]
  if (!p || !p.alive || !mem) return 0
  if (mem.cool > 0) mem.cool--
  const dz = dangerOf(s)
  const start = tileOf(p)

  // In danger: run to the nearest tile that stays safe.
  if (!isSafe(dz, start)) {
    const r = search(s, i, dz, false)
    let best = -1
    let bestScore = -INF
    for (const c of r.order) {
      if (c === start) continue
      const score = isSafe(dz, c) ? 1000 - r.dist[c] : Math.min(dz.from[c], dz.block[c]) - r.dist[c] * 2
      if (score > bestScore) {
        bestScore = score
        best = c
      }
    }
    return best >= 0 ? toward(start, r.first[best]) : 0
  }

  const enemies: number[] = []
  s.players.forEach((q, j) => {
    if (j !== i && q.alive) enemies.push(tileOf(q))
  })

  // Trigger: set off the oldest bomb when it would catch a rival and not this bot.
  if (p.trigger) {
    let oldest = -1
    let oldestId = INF
    for (const b of s.bombs) {
      if (b.owner === i && b.id < oldestId) {
        oldestId = b.id
        oldest = s.bombs.indexOf(b)
      }
    }
    if (oldest >= 0) {
      const b = s.bombs[oldest]
      const tiles = blastTiles(s, tileOf(b), b.range)
      for (const o of s.bombs) if (o !== b && tiles.includes(tileOf(o))) blastTiles(s, tileOf(o), o.range, tiles)
      if (!tiles.includes(start) && enemies.some((e) => tiles.includes(e))) return GAME_PAD.B
    }
  }

  let active = 0
  for (const b of s.bombs) if (b.owner === i) active++
  const canBomb = active < p.bombs && mem.cool === 0

  const r = search(s, i, dz, true)
  let best = -1
  let bestScore = 0
  let bombHere = false
  for (const c of r.order) {
    const dist = r.dist[c]
    let score = 0
    let isBombSpot = false
    if (s.items[c] !== I_NONE) score = 60 - dist * 3
    if (canBomb) {
      const v = bombValue(s, c, p.range, dz, enemies)
      if (v > 0 && v - dist * 3 > score) {
        score = v - dist * 3
        isBombSpot = true
      }
    }
    if (score <= 0) continue
    score += ctx.random() * 2
    if (score > bestScore) {
      bestScore = score
      best = c
      bombHere = isBombSpot
    }
  }

  if (best === start && bombHere) {
    const dz2 = computeDanger(s, { c: start, range: p.range })
    const r2 = search(s, i, dz2, false)
    if (r2.order.some((c) => c !== start && isSafe(dz2, c))) return GAME_PAD.A
    mem.cool = 15 + Math.floor(ctx.random() * 15)
    best = -1
  }
  if (best >= 0 && best !== start) return toward(start, r.first[best])

  // Nothing to do here: head for the nearest rival, or wander.
  let goal = -1
  let goalScore = INF
  for (const c of r.order) {
    let near = INF
    for (const e of enemies) near = Math.min(near, Math.abs((e % W) - (c % W)) + Math.abs(Math.floor(e / W) - Math.floor(c / W)))
    const score = near * 2 + r.dist[c]
    if (score < goalScore) {
      goalScore = score
      goal = c
    }
  }
  if (goal >= 0 && goal !== start) return toward(start, r.first[goal])
  if (mem.wander < 0 || ctx.random() < 0.1) mem.wander = Math.floor(ctx.random() * 4)
  const cx = start % W
  const cy = (start - cx) / W
  const nx = cx + DX[mem.wander]
  const ny = cy + DY[mem.wander]
  if (inside(nx, ny) && r.dist[idx(nx, ny)] > 0) return DIR_BITS[mem.wander]
  mem.wander = -1
  return 0
}

