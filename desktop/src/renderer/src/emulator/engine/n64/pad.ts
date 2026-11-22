// A Nexo controller (GAME_PAD bits + EmuAxes) → an N64 controller, as described in ../../systems.ts:
// left stick → control stick, D-pad → D-pad, A → A, X → B, L2 → Z, L → L, R → R, right stick → C buttons,
// Y → C-up, B → C-down, R2 → C-right, SELECT → C-left, START → Start. Without axes (a keyboard) the d-pad drives
// the control stick at full tilt instead of the D-pad.
//
// The result is mupen64plus's BUTTONS word: button bits 0–13, stick X in bits 16–23 and Y in 24–31 (signed,
// up = positive), which the patched core reads as is (nexo_n64_keys in mupen64plus_next/nexo_frontend.c).
import { GAME_PAD, type EmuAxes } from '@shared/protocol'

export const N64 = {
  D_RIGHT: 1 << 0,
  D_LEFT: 1 << 1,
  D_DOWN: 1 << 2,
  D_UP: 1 << 3,
  START: 1 << 4,
  Z: 1 << 5,
  B: 1 << 6,
  A: 1 << 7,
  C_RIGHT: 1 << 8,
  C_LEFT: 1 << 9,
  C_DOWN: 1 << 10,
  C_UP: 1 << 11,
  R: 1 << 12,
  L: 1 << 13,
} as const

const BUTTONS: readonly (readonly [number, number])[] = [
  [GAME_PAD.A, N64.A],
  [GAME_PAD.X, N64.B],
  [GAME_PAD.L2, N64.Z],
  [GAME_PAD.L, N64.L],
  [GAME_PAD.R, N64.R],
  [GAME_PAD.START, N64.START],
  [GAME_PAD.Y, N64.C_UP],
  [GAME_PAD.B, N64.C_DOWN],
  [GAME_PAD.R2, N64.C_RIGHT],
  [GAME_PAD.SELECT, N64.C_LEFT],
]

const DPAD: readonly (readonly [number, number])[] = [
  [GAME_PAD.UP, N64.D_UP],
  [GAME_PAD.DOWN, N64.D_DOWN],
  [GAME_PAD.LEFT, N64.D_LEFT],
  [GAME_PAD.RIGHT, N64.D_RIGHT],
]

/** Right stick past this (out of 127) presses that C button. */
const C_STICK_THRESHOLD = 64
/** A real N64 stick reads about ±80 at its gate's corners on the axes and about (±70, ±70) on the diagonals. */
const GATE_AXIS = 80
const GATE_DIAGONAL = 70
/** Tilts past this fraction of 127 count as full tilt (worn sticks and pads that don't quite reach the edge). */
const FULL_TILT = 0.95

/**
 * Radius of the N64's octagonal gate in direction `angle` (radians): 80 along the axes, ~99 on the diagonals, so
 * a round gamepad stick pushed to its rim reaches the same corners a real controller does.
 */
function gateRadius(angle: number): number {
  // The octagon's vertices alternate between the axes (r = 80) and the diagonals (70, 70); find the edge the ray
  // crosses and intersect.
  const sector = Math.PI / 4
  const a = ((angle % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)
  const i = Math.floor(a / sector)
  const v = (k: number): [number, number] => {
    const t = k * sector
    const r = k % 2 === 0 ? GATE_AXIS : Math.SQRT2 * GATE_DIAGONAL
    return [r * Math.cos(t), r * Math.sin(t)]
  }
  const [x1, y1] = v(i)
  const [x2, y2] = v(i + 1)
  const dx = Math.cos(a)
  const dy = Math.sin(a)
  // Ray (s·dx, s·dy) meets the segment P1 + u·(P2 − P1): solve for s.
  const ex = x2 - x1
  const ey = y2 - y1
  const den = dx * ey - dy * ex
  return den === 0 ? GATE_AXIS : (x1 * ey - y1 * ex) / den
}

/**
 * A stick (x, y in -127..127, y down) → N64 stick values (y up). Linear inside the gate (N64 games apply their
 * own response curves; adding one here would make them feel off), with the dead zone already cut by the sender.
 */
export function stickToN64(x: number, y: number): [number, number] {
  const m = Math.hypot(x, y)
  if (!(m > 0)) return [0, 0]
  const angle = Math.atan2(-y, x)
  const tilt = Math.min(1, m / (127 * FULL_TILT))
  const r = tilt * gateRadius(angle)
  const nx = Math.round(r * Math.cos(angle))
  const ny = Math.round(r * Math.sin(angle))
  const clamp = (n: number) => Math.max(-127, Math.min(127, n))
  return [clamp(nx), clamp(ny)]
}

/**
 * The BUTTONS word for one controller. `stickFromDpad`: no sticks on this player's controller (a keyboard): the
 * d-pad moves the control stick at full tilt instead of pressing the D-pad.
 */
export function toN64Keys(buttons: number, axes: EmuAxes | undefined, stickFromDpad: boolean): number {
  let bits = 0
  for (const [pad, n64] of BUTTONS) if (buttons & pad) bits |= n64

  let sx = 0
  let sy = 0
  if (stickFromDpad) {
    const dx = (buttons & GAME_PAD.RIGHT ? 1 : 0) - (buttons & GAME_PAD.LEFT ? 1 : 0)
    const dy = (buttons & GAME_PAD.DOWN ? 1 : 0) - (buttons & GAME_PAD.UP ? 1 : 0)
    if (dx || dy) [sx, sy] = stickToN64(dx * 127, dy * 127)
  } else {
    for (const [pad, n64] of DPAD) if (buttons & pad) bits |= n64
  }
  if (axes) {
    const [lx, ly, rx, ry] = axes.map((v) => (Number.isFinite(v) ? Math.max(-127, Math.min(127, v | 0)) : 0))
    if (lx || ly) [sx, sy] = stickToN64(lx, ly)
    if (rx > C_STICK_THRESHOLD) bits |= N64.C_RIGHT
    if (rx < -C_STICK_THRESHOLD) bits |= N64.C_LEFT
    if (ry > C_STICK_THRESHOLD) bits |= N64.C_DOWN
    if (ry < -C_STICK_THRESHOLD) bits |= N64.C_UP
  }
  return (bits | ((sx & 0xff) << 16) | ((sy & 0xff) << 24)) >>> 0
}
