// Controller input for the emulator: keyboard (while the game is on screen and you aren't typing) and gamepads
// (standard mapping), merged into one GAME_PAD bitmask. `onChange` gets every new mask (send it to the server).
import { GAME_PAD } from '@shared/protocol'

/** KeyboardEvent.code → button. Arrows / WASD move; A = Space, J, Z; B = K, X; X = L, C; Y = I, V; Select = Backspace, right Shift. */
export const KEY_MAP: Record<string, number> = {
  ArrowUp: GAME_PAD.UP,
  KeyW: GAME_PAD.UP,
  ArrowDown: GAME_PAD.DOWN,
  KeyS: GAME_PAD.DOWN,
  ArrowLeft: GAME_PAD.LEFT,
  KeyA: GAME_PAD.LEFT,
  ArrowRight: GAME_PAD.RIGHT,
  KeyD: GAME_PAD.RIGHT,
  Space: GAME_PAD.A,
  KeyJ: GAME_PAD.A,
  KeyZ: GAME_PAD.A,
  KeyK: GAME_PAD.B,
  KeyX: GAME_PAD.B,
  KeyL: GAME_PAD.X,
  KeyC: GAME_PAD.X,
  KeyI: GAME_PAD.Y,
  KeyV: GAME_PAD.Y,
  KeyQ: GAME_PAD.L,
  KeyE: GAME_PAD.R,
  Enter: GAME_PAD.START,
  Backspace: GAME_PAD.SELECT,
  ShiftRight: GAME_PAD.SELECT,
}

/** How each button reads on the keyboard (help texts: "A" → "Space / J"). */
export const BUTTON_KEYS: Record<keyof typeof GAME_PAD, string> = {
  UP: '↑ / W',
  DOWN: '↓ / S',
  LEFT: '← / A',
  RIGHT: '→ / D',
  A: 'Space / J',
  B: 'K / X',
  X: 'L / C',
  Y: 'I / V',
  L: 'Q',
  R: 'E',
  START: 'Enter',
  SELECT: 'Backspace',
}

/** Standard gamepad button index → button. */
const PAD_BUTTONS: [number, number][] = [
  [0, GAME_PAD.A],
  [1, GAME_PAD.B],
  [2, GAME_PAD.X],
  [3, GAME_PAD.Y],
  [4, GAME_PAD.L],
  [5, GAME_PAD.R],
  [6, GAME_PAD.L],
  [7, GAME_PAD.R],
  [8, GAME_PAD.SELECT],
  [9, GAME_PAD.START],
  [12, GAME_PAD.UP],
  [13, GAME_PAD.DOWN],
  [14, GAME_PAD.LEFT],
  [15, GAME_PAD.RIGHT],
]
const STICK = 0.45

function isEditable(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null
  return !!el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName))
}

function gamepadMask(): number {
  let mask = 0
  const pads = navigator.getGamepads?.() ?? []
  for (const gp of pads) {
    if (!gp || !gp.connected) continue
    for (const [i, bit] of PAD_BUTTONS) if (gp.buttons[i]?.pressed) mask |= bit
    const [x = 0, y = 0] = gp.axes
    if (x < -STICK) mask |= GAME_PAD.LEFT
    if (x > STICK) mask |= GAME_PAD.RIGHT
    if (y < -STICK) mask |= GAME_PAD.UP
    if (y > STICK) mask |= GAME_PAD.DOWN
  }
  return mask
}

export interface PadInput {
  /** The buttons held now. */
  buttons(): number
  stop(): void
}

/** Starts listening; `onChange(mask)` on every change (and 0 when stopped or the window loses focus). */
export function startPadInput(onChange: (mask: number) => void): PadInput {
  let keys = 0
  let pad = 0
  let sent = 0
  let raf = 0
  const held = new Set<string>()

  const update = () => {
    const mask = keys | pad
    if (mask === sent) return
    sent = mask
    onChange(mask)
  }
  const recomputeKeys = () => {
    keys = 0
    for (const code of held) keys |= KEY_MAP[code] ?? 0
  }
  const onKeyDown = (e: KeyboardEvent) => {
    if (!(e.code in KEY_MAP) || e.ctrlKey || e.metaKey || e.altKey || isEditable(e.target)) return
    // Buttons keep Space / Enter for clicking unless the game has focus of the page (it does while playing).
    e.preventDefault()
    held.add(e.code)
    recomputeKeys()
    update()
  }
  const onKeyUp = (e: KeyboardEvent) => {
    if (!held.delete(e.code)) return
    recomputeKeys()
    update()
  }
  const releaseAll = () => {
    held.clear()
    keys = 0
    update()
  }
  const poll = () => {
    pad = gamepadMask()
    update()
    raf = requestAnimationFrame(poll)
  }
  window.addEventListener('keydown', onKeyDown, true)
  window.addEventListener('keyup', onKeyUp, true)
  window.addEventListener('blur', releaseAll)
  raf = requestAnimationFrame(poll)

  return {
    buttons: () => keys | pad,
    stop() {
      cancelAnimationFrame(raf)
      window.removeEventListener('keydown', onKeyDown, true)
      window.removeEventListener('keyup', onKeyUp, true)
      window.removeEventListener('blur', releaseAll)
      held.clear()
      keys = pad = 0
      update()
    },
  }
}
