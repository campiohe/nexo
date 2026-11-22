// Blast Arena: an arena battle game for 2–4 players (bots fill seats). Walk the grid, drop bombs whose
// cross-shaped blasts break crates (some hide power-ups), chain other bombs and knock out rivals. Last one
// standing wins the round; first to N round wins takes the match. After 2 minutes, sudden death: blocks fall in a
// spiral from the edges until the round ends. Rules only (pure, deterministic); see core.ts for the types and
// bot.ts for the computer players.
import type { GameSeat } from '../../protocol.ts'
import { GAME_PAD } from '../../protocol.ts'
import type { GameContext, GameDefinition, GameOutcome, TickInput } from '../types.ts'
import {
  BREAK_T,
  DROP_BUFFER,
  DX,
  DY,
  END_T,
  EV_BOOM,
  EV_BURN,
  EV_COUNT,
  EV_DIE,
  EV_DROP,
  EV_GO,
  EV_KICK,
  EV_MATCH,
  EV_PICK,
  EV_ROUND,
  EV_SHIELD,
  EV_SUDDEN,
  EV_THUD,
  FALL_T,
  FIRE_T,
  FUSE,
  H,
  HALF,
  I_BOMB,
  I_KICK,
  I_NONE,
  I_RANGE,
  I_SHIELD,
  I_SPEED,
  I_TRIGGER,
  INTRO_T,
  ITEM_CHARS,
  KICK_SPEED,
  MAX_BOMBS,
  MAX_RANGE,
  MAX_ROUNDS,
  MAX_SPEED_UPS,
  PF_ALIVE,
  PF_GONE,
  PF_INVULN,
  PF_KICK,
  PF_MOVING,
  PF_SHIELD,
  PF_TRIGGER,
  PH_END,
  PH_INTRO,
  PH_OVER,
  PH_PLAY,
  PH_RESULT,
  RESULT_T,
  ROUND_T,
  SD_EVERY,
  SHIELD_INVULN,
  SPAWNS,
  SPIRAL,
  T_BLOCK,
  T_BREAK,
  T_CRATE,
  T_FLOOR,
  T_PILLAR,
  TICK_HZ,
  TILE,
  W,
  bombAt,
  cellOf,
  centerOf,
  idx,
  inside,
  isPillar,
  overlaps,
  speedOf,
  tileOf,
  type BomberBomb,
  type BomberPlayer,
  type BomberState,
  type BomberView,
} from './core.ts'
import { botButtons } from './bot.ts'

export type { BomberState, BomberView } from './core.ts'

const DIR_BITS = [GAME_PAD.UP, GAME_PAD.DOWN, GAME_PAD.LEFT, GAME_PAD.RIGHT]
/** Items hidden in each round's crates. */
const ITEM_POOL: readonly [number, number][] = [
  [I_BOMB, 8],
  [I_RANGE, 8],
  [I_SPEED, 4],
  [I_KICK, 3],
  [I_SHIELD, 2],
  [I_TRIGGER, 2],
]
const CRATE_CHANCE = 0.72
const EVENT_KEEP_TICKS = 20

// ---------------------------------------------------------------------------------------------
// Setup

function emit(s: BomberState, kind: number, a = 0, b = 0) {
  s.events.push([s.nextEvent++, s.tick, kind, a, b])
}

/** Spawn tiles and two tiles along each wall from them: always crate-free (room to drop a first bomb and hide). */
function spawnClear(x: number, y: number): boolean {
  for (const [sx, sy] of SPAWNS) {
    if ((x === sx && Math.abs(y - sy) <= 2) || (y === sy && Math.abs(x - sx) <= 2)) return true
  }
  return false
}

function buildArena(s: BomberState, ctx: GameContext) {
  const crates: number[] = []
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const c = idx(x, y)
      s.items[c] = I_NONE
      s.hidden[c] = I_NONE
      s.fire[c] = 0
      if (isPillar(x, y)) s.grid[c] = T_PILLAR
      else if (!spawnClear(x, y) && ctx.random() < CRATE_CHANCE) {
        s.grid[c] = T_CRATE
        crates.push(c)
      } else s.grid[c] = T_FLOOR
    }
  }
  // Shuffle the crates (Fisher–Yates) and hide the item pool in the first ones.
  for (let i = crates.length - 1; i > 0; i--) {
    const j = Math.floor(ctx.random() * (i + 1))
    const t = crates[i]
    crates[i] = crates[j]
    crates[j] = t
  }
  let k = 0
  for (const [item, n] of ITEM_POOL) for (let i = 0; i < n && k < crates.length; i++) s.hidden[crates[k++]] = item
}

function setupRound(s: BomberState, ctx: GameContext) {
  buildArena(s, ctx)
  s.players.forEach((p, i) => {
    p.moving = false
    if (p.gone) {
      p.alive = false
      return
    }
    const [sx, sy] = SPAWNS[i]
    p.x = centerOf(sx)
    p.y = centerOf(sy)
    p.dir = 1
    p.alive = true
    p.diedAt = -1
    p.bombs = 1
    p.range = 2
    p.speed = 0
    p.kick = false
    p.trigger = false
    p.shield = false
    p.invuln = 0
    p.bufA = 0
    p.pref = -1
  })
  for (const m of s.bots) {
    m.cool = 0
    m.wander = -1
  }
  s.bombs = []
  s.breaking = []
  s.falling = []
  s.timeLeft = ROUND_T
  s.sdT = -1
  s.sdNext = 0
  s.phase = PH_INTRO
  s.phaseT = INTRO_T
  s.roundWinner = -2
  emit(s, EV_COUNT, 3)
}

function create(seats: GameSeat[], ctx: GameContext): BomberState {
  const n = W * H
  const s: BomberState = {
    seats: seats.map((x) => ({ ...x })),
    tick: 0,
    phase: PH_INTRO,
    phaseT: INTRO_T,
    round: 1,
    winsNeeded: seats.length <= 2 ? 3 : 2,
    timeLeft: ROUND_T,
    sdT: -1,
    sdNext: 0,
    grid: new Array<number>(n).fill(T_FLOOR),
    items: new Array<number>(n).fill(I_NONE),
    hidden: new Array<number>(n).fill(I_NONE),
    fire: new Array<number>(n).fill(0),
    breaking: [],
    falling: [],
    bombs: [],
    players: seats.map(() => ({
      x: 0,
      y: 0,
      dir: 1,
      moving: false,
      alive: true,
      gone: false,
      diedAt: -1,
      bombs: 1,
      range: 2,
      speed: 0,
      kick: false,
      trigger: false,
      shield: false,
      invuln: 0,
      wins: 0,
      bufA: 0,
      pref: -1,
    })),
    bots: seats.map(() => ({ cool: 0, wander: -1 })),
    roundWinner: -2,
    matchWinners: null,
    summary: '',
    events: [],
    nextEvent: 0,
    nextBomb: 1,
  }
  setupRound(s, ctx)
  return s
}

// ---------------------------------------------------------------------------------------------
// Movement

/** Whether player `i` may walk onto tile (x, y): floor, no bomb unless it's one they're still standing on. */
function passable(s: BomberState, x: number, y: number, i: number): boolean {
  if (!inside(x, y)) return false
  const c = idx(x, y)
  if (s.grid[c] !== T_FLOOR) return false
  const b = bombAt(s, c)
  return !b || (b.pass & (1 << i)) !== 0
}

/** Whether a kicked bomb can slide onto tile c. */
function bombCanEnter(s: BomberState, c: number, self: BomberBomb): boolean {
  if (s.grid[c] !== T_FLOOR) return false
  for (const b of s.bombs) if (b !== self && tileOf(b) === c) return false
  const x = centerOf(c % W)
  const y = centerOf(Math.floor(c / W))
  for (const p of s.players) if (p.alive && overlaps(p.x, p.y, x, y)) return false
  return true
}

/**
 * Moves player `i` up to `sp` units in direction d. Off-center on the other axis it first slides toward the
 * center of its lane, or (when its lane is blocked ahead) toward the neighboring lane when that one is open:
 * pressing into a wall near a corridor nudges you in. Returns whether it moved.
 */
function tryMove(s: BomberState, i: number, d: number, sp: number): boolean {
  const p = s.players[i]
  const horiz = d >= 2
  const sg = d === 0 || d === 2 ? -1 : 1
  let a = horiz ? p.x : p.y
  let b = horiz ? p.y : p.x
  const ca = cellOf(a)
  const cb = cellOf(b)
  const free = (na: number, nb: number) => (horiz ? passable(s, na, nb, i) : passable(s, nb, na, i))
  const offB = b - centerOf(cb)
  const offA = (a - centerOf(ca)) * sg
  let moved = false
  if (offB !== 0) {
    const sb = Math.sign(offB)
    if (free(ca + sg, cb) || offA < 0) {
      // Straighten up in this lane first (also while still short of this tile's center).
      const step = Math.min(Math.abs(offB), sp)
      b -= sb * step
      sp -= step
      moved = true
      if (b !== centerOf(cb)) sp = 0
    } else if (free(ca + sg, cb + sb) && free(ca, cb + sb)) {
      b += sb * sp
      sp = 0
      moved = true
    } else sp = 0
  }
  if (sp > 0) {
    if (free(ca + sg, cb)) {
      a += sg * sp
      moved = true
    } else if (offA < 0) {
      a += sg * Math.min(sp, -offA)
      moved = true
    } else if (p.kick) {
      const nx = horiz ? ca + sg : cb
      const ny = horiz ? cb : ca + sg
      if (inside(nx, ny)) {
        const bomb = bombAt(s, idx(nx, ny))
        if (bomb && bomb.dx === 0 && bomb.dy === 0 && bomb.x % TILE === HALF && bomb.y % TILE === HALF) {
          const bx = nx + (horiz ? sg : 0)
          const by = ny + (horiz ? 0 : sg)
          if (inside(bx, by) && bombCanEnter(s, idx(bx, by), bomb)) {
            bomb.dx = horiz ? sg : 0
            bomb.dy = horiz ? 0 : sg
            emit(s, EV_KICK, i, bomb.id)
          }
        }
      }
    }
  }
  if (horiz) {
    p.x = a
    p.y = b
  } else {
    p.y = a
    p.x = b
  }
  return moved
}

function movePlayer(s: BomberState, i: number, held: number, pressed: number) {
  const p = s.players[i]
  for (let d = 0; d < 4; d++) if (pressed & DIR_BITS[d]) p.pref = d
  if (p.pref >= 0 && !(held & DIR_BITS[p.pref])) p.pref = -1
  let primary = p.pref
  if (primary < 0) for (let d = 0; d < 4 && primary < 0; d++) if (held & DIR_BITS[d]) primary = d
  if (primary < 0) {
    p.moving = false
    return
  }
  let secondary = -1
  const perp = primary < 2 ? [2, 3] : [0, 1]
  for (const d of perp) if (secondary < 0 && held & DIR_BITS[d]) secondary = d
  const sp = speedOf(p)
  let dir = primary
  let moved = tryMove(s, i, primary, sp)
  if (!moved && secondary >= 0 && tryMove(s, i, secondary, sp)) {
    moved = true
    dir = secondary
  }
  p.moving = moved
  p.dir = dir
}

// ---------------------------------------------------------------------------------------------
// Bombs and blasts

function activeBombs(s: BomberState, i: number): number {
  let n = 0
  for (const b of s.bombs) if (b.owner === i) n++
  return n
}

function tryDrop(s: BomberState, i: number): boolean {
  const p = s.players[i]
  const c = tileOf(p)
  if (activeBombs(s, i) >= p.bombs || s.grid[c] !== T_FLOOR || s.fire[c] > 0 || bombAt(s, c)) return false
  const x = centerOf(cellOf(p.x))
  const y = centerOf(cellOf(p.y))
  let pass = 0
  s.players.forEach((q, j) => {
    if (q.alive && overlaps(q.x, q.y, x, y)) pass |= 1 << j
  })
  s.bombs.push({ id: s.nextBomb++, x, y, owner: i, fuse: FUSE, range: p.range, dx: 0, dy: 0, pass })
  emit(s, EV_DROP, i, c)
  return true
}

function explode(s: BomberState, b: BomberBomb) {
  const c = tileOf(b)
  const cx = c % W
  const cy = (c - cx) / W
  emit(s, EV_BOOM, c, b.owner)
  s.fire[c] = FIRE_T
  for (let d = 0; d < 4; d++) {
    for (let k = 1; k <= b.range; k++) {
      const x = cx + DX[d] * k
      const y = cy + DY[d] * k
      if (!inside(x, y)) break
      const n = idx(x, y)
      const t = s.grid[n]
      if (t === T_PILLAR || t === T_BLOCK || t === T_BREAK) break
      if (t === T_CRATE) {
        s.grid[n] = T_BREAK
        s.breaking.push([n, BREAK_T])
        break
      }
      s.fire[n] = FIRE_T
      if (s.items[n] !== I_NONE) {
        s.items[n] = I_NONE
        emit(s, EV_BURN, n)
        break
      }
    }
  }
}

/** Bombs whose fuse ran out or that a blast reaches go off, chaining in the same tick. */
function detonate(s: BomberState) {
  for (let again = true; again; ) {
    again = false
    for (let k = 0; k < s.bombs.length; k++) {
      const b = s.bombs[k]
      if (b.fuse <= 0 || s.fire[tileOf(b)] > 0) {
        s.bombs.splice(k, 1)
        explode(s, b)
        again = true
        break
      }
    }
  }
}

function updateBombs(s: BomberState) {
  for (const b of s.bombs) {
    if (b.pass) {
      s.players.forEach((p, j) => {
        if (b.pass & (1 << j) && (!p.alive || !overlaps(p.x, p.y, b.x, b.y))) b.pass &= ~(1 << j)
      })
    }
    if (b.dx || b.dy) {
      if (b.x % TILE === HALF && b.y % TILE === HALF) {
        const nx = cellOf(b.x) + b.dx
        const ny = cellOf(b.y) + b.dy
        if (!inside(nx, ny) || !bombCanEnter(s, idx(nx, ny), b)) {
          b.dx = b.dy = 0
        }
      }
      b.x += b.dx * KICK_SPEED
      b.y += b.dy * KICK_SPEED
    }
    b.fuse--
  }
}

function kill(s: BomberState, i: number) {
  const p = s.players[i]
  if (!p.alive) return
  p.alive = false
  p.moving = false
  p.diedAt = s.tick
  emit(s, EV_DIE, i)
}

// ---------------------------------------------------------------------------------------------
// Sudden death

function suddenDeath(s: BomberState) {
  if (s.sdT % SD_EVERY === 0 && s.sdNext < SPIRAL.length) s.falling.push([SPIRAL[s.sdNext++], FALL_T])
  for (let k = s.falling.length - 1; k >= 0; k--) {
    const f = s.falling[k]
    if (--f[1] > 0) continue
    s.falling.splice(k, 1)
    const c = f[0]
    s.grid[c] = T_BLOCK
    s.items[c] = I_NONE
    s.hidden[c] = I_NONE
    s.fire[c] = 0
    s.bombs = s.bombs.filter((b) => tileOf(b) !== c)
    s.breaking = s.breaking.filter((x) => x[0] !== c)
    s.players.forEach((p, i) => {
      if (p.alive && tileOf(p) === c) kill(s, i)
    })
    emit(s, EV_THUD, c)
  }
}

// ---------------------------------------------------------------------------------------------
// The round

function pickUp(s: BomberState, i: number) {
  const p = s.players[i]
  const c = tileOf(p)
  const item = s.items[c]
  if (item === I_NONE) return
  s.items[c] = I_NONE
  if (item === I_BOMB) p.bombs = Math.min(MAX_BOMBS, p.bombs + 1)
  else if (item === I_RANGE) p.range = Math.min(MAX_RANGE, p.range + 1)
  else if (item === I_SPEED) p.speed = Math.min(MAX_SPEED_UPS, p.speed + 1)
  else if (item === I_KICK) p.kick = true
  else if (item === I_SHIELD) p.shield = true
  else if (item === I_TRIGGER) p.trigger = true
  emit(s, EV_PICK, i, item)
}

function simulate(s: BomberState, input: TickInput) {
  if (s.timeLeft > 0) {
    if (--s.timeLeft === 0) {
      s.sdT = 0
      emit(s, EV_SUDDEN)
    }
  } else s.sdT++

  s.players.forEach((p, i) => {
    if (!p.alive) return
    if (p.invuln > 0) p.invuln--
    const held = input.held[i] ?? 0
    const pressed = input.pressed[i] ?? 0
    movePlayer(s, i, held, pressed)
    if (pressed & GAME_PAD.A) p.bufA = DROP_BUFFER
    if (p.bufA > 0) p.bufA = tryDrop(s, i) ? 0 : p.bufA - 1
    if (pressed & GAME_PAD.B && p.trigger) {
      let oldest: BomberBomb | undefined
      for (const b of s.bombs) if (b.owner === i && (!oldest || b.id < oldest.id)) oldest = b
      if (oldest) oldest.fuse = 0
    }
  })

  updateBombs(s)
  for (let c = 0; c < s.fire.length; c++) if (s.fire[c] > 0) s.fire[c]--
  for (let k = s.breaking.length - 1; k >= 0; k--) {
    const br = s.breaking[k]
    if (--br[1] > 0) continue
    s.breaking.splice(k, 1)
    s.grid[br[0]] = T_FLOOR
    s.items[br[0]] = s.hidden[br[0]]
    s.hidden[br[0]] = I_NONE
  }
  detonate(s)
  if (s.sdT >= 0) suddenDeath(s)

  s.players.forEach((p, i) => {
    if (!p.alive) return
    pickUp(s, i)
    if (s.fire[tileOf(p)] > 0 && p.invuln === 0) {
      if (p.shield) {
        p.shield = false
        p.invuln = SHIELD_INVULN
        emit(s, EV_SHIELD, i)
      } else kill(s, i)
    }
  })
}

const standing = (s: BomberState) => s.players.flatMap((p, i) => (p.alive && !p.gone ? [i] : []))

function nameOf(s: BomberState, i: number): string {
  const n = s.seats[i]?.name ?? `Player ${i + 1}`
  return n.length > 24 ? n.slice(0, 23) + '…' : n
}

function decideMatch(s: BomberState) {
  const top = Math.max(...s.players.map((p) => p.wins))
  const leaders = s.players.flatMap((p, i) => (p.wins === top ? [i] : []))
  if (top >= s.winsNeeded || s.round >= MAX_ROUNDS) {
    s.matchWinners = top > 0 ? leaders : []
    if (leaders.length === 1 && top > 0) {
      const w = leaders[0]
      const other = Math.max(0, ...s.players.filter((_, i) => i !== w).map((p) => p.wins))
      s.summary = `${nameOf(s, w)} wins ${top}–${other}`
    } else if (top > 0) s.summary = `Draw: ${leaders.map((i) => nameOf(s, i)).join(' & ')} tie at ${top}`
    else s.summary = 'Draw: nobody won a round'
    emit(s, EV_MATCH, s.matchWinners.length === 1 ? s.matchWinners[0] : -1)
  }
}

function finishRound(s: BomberState) {
  const alive = standing(s)
  s.roundWinner = alive.length === 1 ? alive[0] : -1
  if (s.roundWinner >= 0) s.players[s.roundWinner].wins++
  emit(s, EV_ROUND, s.roundWinner)
  decideMatch(s)
  s.phase = PH_RESULT
  s.phaseT = RESULT_T
}

function tick(s: BomberState, input: TickInput, ctx: GameContext) {
  s.tick++
  if (s.events.length && s.events[0][1] < s.tick - EVENT_KEEP_TICKS) s.events = s.events.filter((e) => e[1] >= s.tick - EVENT_KEEP_TICKS)
  switch (s.phase) {
    case PH_INTRO:
      s.phaseT--
      if (s.phaseT > 0 && s.phaseT % TICK_HZ === 0) emit(s, EV_COUNT, s.phaseT / TICK_HZ)
      if (s.phaseT <= 0) {
        s.phase = PH_PLAY
        emit(s, EV_GO)
      }
      break
    case PH_PLAY:
    case PH_END:
      simulate(s, input)
      if (s.phase === PH_PLAY) {
        if (standing(s).length <= 1) {
          s.phase = PH_END
          s.phaseT = END_T
        }
      } else if (--s.phaseT <= 0) finishRound(s)
      break
    case PH_RESULT:
      // The arena freezes; blasts and crates finish their animation.
      for (let c = 0; c < s.fire.length; c++) if (s.fire[c] > 0) s.fire[c]--
      if (--s.phaseT <= 0) {
        if (s.matchWinners) s.phase = PH_OVER
        else {
          s.round++
          setupRound(s, ctx)
        }
      }
      break
    default:
      break
  }
}

function leave(s: BomberState, seat: number) {
  const p = s.players[seat]
  if (!p || p.gone) return
  p.gone = true
  if (p.alive) {
    p.alive = false
    p.moving = false
    p.diedAt = s.tick
  }
  if (s.matchWinners) return
  const left = s.players.flatMap((q, i) => (q.gone ? [] : [i]))
  if (left.length <= 1) {
    s.matchWinners = left
    s.summary = left.length === 1 ? `${nameOf(s, left[0])} wins: everyone else left` : 'Everyone left'
    s.phase = PH_OVER
    emit(s, EV_MATCH, left.length === 1 ? left[0] : -1)
  }
}

function view(s: BomberState): BomberView {
  let g = ''
  let f = ''
  for (let c = 0; c < W * H; c++) {
    const t = s.grid[c]
    g +=
      t === T_PILLAR ? '#' : t === T_CRATE ? '%' : t === T_BLOCK ? 'X' : t === T_BREAK ? '*' : ITEM_CHARS[s.items[c]]
    f += s.fire[c] > 0 ? String.fromCharCode(96 + Math.min(26, s.fire[c])) : '.'
  }
  const p = s.players.map((q: BomberPlayer) => [
    q.x,
    q.y,
    q.dir,
    (q.alive ? PF_ALIVE : 0) |
      (q.moving ? PF_MOVING : 0) |
      (q.gone ? PF_GONE : 0) |
      (q.kick ? PF_KICK : 0) |
      (q.trigger ? PF_TRIGGER : 0) |
      (q.shield ? PF_SHIELD : 0) |
      (q.invuln > 0 ? PF_INVULN : 0),
    q.diedAt,
    q.wins,
    q.bombs,
    q.range,
    q.speed,
  ])
  return {
    ph: s.phase,
    pt: s.phaseT,
    rd: s.round,
    wn: s.winsNeeded,
    tl: s.timeLeft,
    sd: s.sdT,
    rw: s.roundWinner,
    mw: s.matchWinners ? [...s.matchWinners] : [],
    g,
    f,
    br: s.breaking.flat(),
    fl: s.falling.flat(),
    b: s.bombs.map((b) => [b.id, b.x, b.y, b.fuse, b.owner, b.dx || b.dy ? 1 : 0]),
    p,
    e: s.events.map((e) => [e[0], e[2], e[3], e[4]]),
  }
}

function result(s: BomberState): GameOutcome | null {
  if (s.phase !== PH_OVER || !s.matchWinners) return null
  return { winnerSeats: [...s.matchWinners], summary: s.summary || 'Match over' }
}

export const bomber: GameDefinition<BomberState> = {
  id: 'bomber',
  name: 'Blast Arena',
  tagline: 'Drop bombs, blow up crates and each other. Last one standing wins.',
  minPlayers: 2,
  maxPlayers: 4,
  bots: true,
  controls: 'pad',
  help: [
    ['Arrows', 'Move (hold two directions to take the next turn)'],
    ['A', 'Drop a bomb'],
    ['B', 'With the Trigger power-up: set off your oldest bomb'],
    ['Items', 'Bomb +1, Flame +1, Speed, Boot (walk into a bomb to kick it), Shield (survives one blast), Trigger'],
  ],
  tickHz: TICK_HZ,
  frameEvery: 1,
  perSeatView: false,
  create,
  tick,
  bot: (s, seat, ctx) => botButtons(s, seat, ctx),
  leave: (s, seat) => leave(s, seat),
  view: (s) => view(s),
  result,
}
