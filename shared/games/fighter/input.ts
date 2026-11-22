// Dojo Duel input reading: directions as numpad digits relative to where the fighter faces (6 = toward the
// opponent, 4 = away, 2 = down, 3 = down-forward…), a short history of them per seat, and lenient motion
// matching: the steps of a motion must appear in order within the window, anything may sit between them
// (diagonals are optional, a stray tick doesn't break it).
import { GAME_PAD } from '../../protocol.ts'

export const PUNCHES = GAME_PAD.A | GAME_PAD.B
export const KICKS = GAME_PAD.X | GAME_PAD.Y
export const ATTACKS = PUNCHES | KICKS
export const HEAVIES = GAME_PAD.B | GAME_PAD.Y

/** Held buttons → numpad direction relative to `face` (1 = facing right, -1 = facing left). */
export function numpad(held: number, face: number): number {
  const up = (held & GAME_PAD.UP) !== 0
  const down = (held & GAME_PAD.DOWN) !== 0
  const left = (held & GAME_PAD.LEFT) !== 0
  const right = (held & GAME_PAD.RIGHT) !== 0
  const v = up && !down ? 1 : down && !up ? -1 : 0
  const xr = right && !left ? 1 : left && !right ? -1 : 0
  const h = xr * (face >= 0 ? 1 : -1)
  return 5 + v * 3 + h
}

/** Numpad direction relative to `face` → held buttons (bots). */
export function padOf(dir: number, face: number): number {
  let held = 0
  if (dir >= 7) held |= GAME_PAD.UP
  if (dir <= 3) held |= GAME_PAD.DOWN
  const h = dir % 3 === 0 ? 1 : dir % 3 === 1 ? -1 : 0
  if (h !== 0) held |= h * face > 0 ? GAME_PAD.RIGHT : GAME_PAD.LEFT
  return held
}

export interface Motion {
  /** Each step: the directions that count for it. */
  steps: readonly (readonly number[])[]
  /** Ticks (from the newest) the whole motion must fit in. */
  window: number
}

/** By motion id: chars.ts QCF (0), QCB (1), DP (2), HCB (3). */
export const MOTIONS: readonly Motion[] = [
  { steps: [[2], [3, 6]], window: 15 },
  { steps: [[2], [1, 4]], window: 15 },
  { steps: [[6], [1, 2], [3]], window: 16 },
  { steps: [[6], [1, 2, 3], [4]], window: 22 },
]

/** Whether `hist` (oldest first) ends with `motion` within its window. */
export function matchMotion(hist: readonly number[], motion: Motion): boolean {
  let step = motion.steps.length - 1
  const n = hist.length
  for (let k = n - 1; k >= 0 && k >= n - motion.window; k--) {
    if (motion.steps[step].includes(hist[k])) {
      step--
      if (step < 0) return true
    }
  }
  return false
}
