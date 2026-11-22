// Controller input for the emulator: keyboard (while the game is on screen and you aren't typing) and gamepads
// (standard mapping), merged into one GAME_PAD bitmask plus the gamepad's sticks (EmuAxes). `onChange` gets every
// change (players send it to the server, the host applies it to its own port).
import { GAME_PAD, type EmuAxes } from '@shared/protocol'

/**
 * KeyboardEvent.code → button. Arrows / WASD move; A = Space, J, Z; B = K, X; X = L, C; Y = I, V; L = Q; R = E;
 * L2 = U; R2 = O; L3 = F; R3 = G; Start = Enter; Select = Backspace, right Shift. (A keyboard has no sticks: the
 * engines of analog consoles drive the stick from the d-pad when no axes come.)
 */
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
  KeyU: GAME_PAD.L2,
  KeyO: GAME_PAD.R2,
  KeyF: GAME_PAD.L3,
  KeyG: GAME_PAD.R3,
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
  L2: 'U',
  R2: 'O',
  L3: 'F',
  R3: 'G',
}

/** Standard gamepad button index → button: bumpers = L / R, triggers = L2 / R2, stick clicks = L3 / R3. */
const PAD_BUTTONS: [number, number][] = [
  [0, GAME_PAD.A],
  [1, GAME_PAD.B],
  [2, GAME_PAD.X],
  [3, GAME_PAD.Y],
  [4, GAME_PAD.L],
  [5, GAME_PAD.R],
  [8, GAME_PAD.SELECT],
  [9, GAME_PAD.START],
  [10, GAME_PAD.L3],
  [11, GAME_PAD.R3],
  [12, GAME_PAD.UP],
  [13, GAME_PAD.DOWN],
  [14, GAME_PAD.LEFT],
  [15, GAME_PAD.RIGHT],
]
/** Triggers (analog on most pads): pressed past half way. */
const PAD_TRIGGERS: [number, number][] = [
  [6, GAME_PAD.L2],
  [7, GAME_PAD.R2],
]
const TRIGGER_PRESSED = 0.5
/** Left stick past this tilt = a d-pad direction (consoles without sticks). */
const STICK = 0.45
/** Stick dead zone (fraction of full tilt): smaller tilts read as centered. */
const DEAD_ZONE = 0.15
const AXIS_MAX = 127
/** A stick value must move this much (out of 127) to count as a change, so sensor noise doesn't spam updates. */
const AXIS_HYSTERESIS = 3
/** At most one stick-only update per this many ms (~60 per second; the server drops more than 120 per second). */
const AXES_MIN_INTERVAL_MS = 16

function isEditable(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null
  return !!el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName))
}

/** One stick axis (-1..1) → -127..127 with the dead zone cut out (the range past it is stretched to full scale). */
export function axisValue(v: number): number {
  if (!Number.isFinite(v)) return 0
  const a = Math.abs(v)
  if (a < DEAD_ZONE) return 0
  const scaled = Math.round((Math.min(1, (a - DEAD_ZONE) / (1 - DEAD_ZONE))) * AXIS_MAX)
  return v < 0 ? -scaled : scaled
}

interface PadRead {
  mask: number
  /** Raw (dead-zoned) sticks of all pads merged: per axis the strongest tilt. */
  axes: EmuAxes
}

function readGamepads(stickAsDpad: boolean): PadRead {
  let mask = 0
  const axes: EmuAxes = [0, 0, 0, 0]
  const pads = navigator.getGamepads?.() ?? []
  for (const gp of pads) {
    if (!gp || !gp.connected) continue
    for (const [i, bit] of PAD_BUTTONS) if (gp.buttons[i]?.pressed) mask |= bit
    for (const [i, bit] of PAD_TRIGGERS) {
      const b = gp.buttons[i]
      if (b && (b.value > TRIGGER_PRESSED || (b.pressed && b.value === 0))) mask |= bit
    }
    if (stickAsDpad) {
      const [x = 0, y = 0] = gp.axes
      if (x < -STICK) mask |= GAME_PAD.LEFT
      if (x > STICK) mask |= GAME_PAD.RIGHT
      if (y < -STICK) mask |= GAME_PAD.UP
      if (y > STICK) mask |= GAME_PAD.DOWN
    } else {
      for (let i = 0; i < 4; i++) {
        const v = axisValue(gp.axes[i] ?? 0)
        if (Math.abs(v) > Math.abs(axes[i])) axes[i] = v
      }
    }
  }
  return { mask, axes }
}

/** `next` with the axes that barely moved since `prev` kept at their previous value (centered and full tilt always pass). */
function settleAxes(prev: EmuAxes, next: EmuAxes): EmuAxes {
  return next.map((v, i) =>
    v === 0 || Math.abs(v) === AXIS_MAX || Math.abs(v - prev[i]) >= AXIS_HYSTERESIS ? v : prev[i],
  ) as EmuAxes
}

const centered = (a: EmuAxes) => a[0] === 0 && a[1] === 0 && a[2] === 0 && a[3] === 0
const sameAxes = (a: EmuAxes, b: EmuAxes) => a[0] === b[0] && a[1] === b[1] && a[2] === b[2] && a[3] === b[3]

export interface PadInputOptions {
  /**
   * The console has analog sticks (EMU_SYSTEM_INFO[system].analog): the gamepad's sticks are reported as axes.
   * Otherwise (default) the left stick works as the d-pad and no axes are ever reported.
   */
  analog?: boolean
}

export interface PadInput {
  /** The buttons held now. */
  buttons(): number
  stop(): void
}

/**
 * Starts listening; `onChange(mask, axes)` on every change: `axes` is undefined while the sticks are centered (or
 * there is no gamepad / the console has no sticks). Called with (0, undefined) when stopped; keys are released
 * when the window loses focus. Stick-only changes come at most ~60 times per second.
 */
export function startPadInput(onChange: (mask: number, axes: EmuAxes | undefined) => void, options: PadInputOptions = {}): PadInput {
  const analog = !!options.analog
  let keys = 0
  let pad = 0
  let axes: EmuAxes = [0, 0, 0, 0]
  let sentMask = 0
  let sentAxes: EmuAxes = [0, 0, 0, 0]
  let lastSentAt = 0
  let raf = 0
  let stopped = false
  const held = new Set<string>()

  const update = () => {
    const mask = keys | pad
    const buttonsChanged = mask !== sentMask
    const axesChanged = !sameAxes(axes, sentAxes)
    if (!buttonsChanged && !axesChanged) return
    const now = performance.now()
    // A stick-only change waits for its slot (the next poll sends the latest value); buttons never wait.
    if (!buttonsChanged && !stopped && now - lastSentAt < AXES_MIN_INTERVAL_MS) return
    sentMask = mask
    sentAxes = axes
    lastSentAt = now
    onChange(mask, centered(axes) ? undefined : ([...axes] as EmuAxes))
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
    const read = readGamepads(!analog)
    pad = read.mask
    axes = settleAxes(axes, read.axes)
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
      if (stopped) return
      stopped = true
      cancelAnimationFrame(raf)
      window.removeEventListener('keydown', onKeyDown, true)
      window.removeEventListener('keyup', onKeyUp, true)
      window.removeEventListener('blur', releaseAll)
      held.clear()
      keys = pad = 0
      axes = [0, 0, 0, 0]
      update()
    },
  }
}
