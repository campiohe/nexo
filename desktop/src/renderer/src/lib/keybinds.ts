// Keybinds (SPEC §13.2): action list, defaults, conflict detection, storage parsing and the DOM ↔ uiohook
// mapping used by the in-window fallback, in-app shortcuts and in-window recording. Pure: no stores.
import {
  effectiveMods,
  formatKeybindLabel,
  modifierNames,
  modsEqual,
  modsInclude,
  type GlobalHotkeyAction,
  type Keybind,
  type KeybindMods,
  type NexoBridge,
} from '../../../preload/api'

export type InAppAction = 'quickSwitcher' | 'openSettings'
export type HotkeyAction = GlobalHotkeyAction | InAppAction

export interface HotkeyActionInfo {
  id: HotkeyAction
  label: string
  /** global: system-wide hook (works in games); app: only while Nexo is focused. */
  scope: 'global' | 'app'
}

export const HOTKEY_ACTIONS: readonly HotkeyActionInfo[] = [
  { id: 'ptt', label: 'Push to talk', scope: 'global' },
  { id: 'toggleMute', label: 'Toggle mute', scope: 'global' },
  { id: 'toggleDeafen', label: 'Toggle deafen', scope: 'global' },
  { id: 'toggleShare', label: 'Toggle screen share', scope: 'global' },
  { id: 'leaveVoice', label: 'Leave voice', scope: 'global' },
  { id: 'quickSwitcher', label: 'Quick switcher', scope: 'app' },
  { id: 'openSettings', label: 'Open settings', scope: 'app' },
]

export const actionLabel = (id: HotkeyAction): string => HOTKEY_ACTIONS.find((a) => a.id === id)?.label ?? id

export function currentPlatform(): NexoBridge['platform'] {
  const p = (window as { nexo?: NexoBridge }).nexo?.platform
  if (p) return p
  return /Mac/i.test(navigator.platform || navigator.userAgent) ? 'darwin' : /Win/i.test(navigator.platform) ? 'win32' : 'linux'
}

const KEY_K = 0x0025
const KEY_COMMA = 0x0033

function primaryCombo(code: number, key: string): Keybind {
  const mac = currentPlatform() === 'darwin'
  const mods: KeybindMods = { ctrl: !mac, shift: false, alt: false, meta: mac }
  return { kind: 'key', code, mods, label: formatKeybindLabel(mods, key, currentPlatform()) }
}

/** In-app shortcuts' defaults (Ctrl/Cmd+K, Ctrl/Cmd+,). Global actions have none. */
export function defaultInAppBinding(action: InAppAction): Keybind {
  return action === 'quickSwitcher' ? primaryCombo(KEY_K, 'K') : primaryCombo(KEY_COMMA, ',')
}

const MAX_LABEL = 64

/**
 * Parse a stored binding (localStorage). Bindings saved before modifiers existed (no `mods`) load as
 * "no modifiers".
 */
export function parseKeybind(v: unknown): Keybind | null {
  if (!v || typeof v !== 'object') return null
  const b = v as Partial<Record<keyof Keybind, unknown>>
  if (b.kind !== 'key' && b.kind !== 'mouse') return null
  const code = b.code
  if (typeof code !== 'number' || !Number.isInteger(code) || code <= 0 || code > 0xffff) return null
  if (b.kind === 'mouse' && code < 3) return null
  const m = (b.mods && typeof b.mods === 'object' ? b.mods : {}) as Partial<Record<keyof KeybindMods, unknown>>
  const mods = effectiveMods(
    { ctrl: m.ctrl === true, shift: m.shift === true, alt: m.alt === true, meta: m.meta === true },
    b.kind,
    code,
  )
  const label = typeof b.label === 'string' && b.label ? b.label.slice(0, MAX_LABEL) : `Key ${code}`
  return { kind: b.kind, code, mods, label }
}

/** Same main key/button and exactly the same modifiers. */
export function sameCombo(a: Keybind, b: Keybind): boolean {
  return a.kind === b.kind && a.code === b.code && modsEqual(a.mods, b.mods)
}

/** Would pressing `combo` also trigger push to talk bound to `ptt` (which tolerates extra modifiers)? */
function triggersPtt(ptt: Keybind, combo: Keybind): boolean {
  return ptt.kind === combo.kind && ptt.code === combo.code && modsInclude(combo.mods, ptt.mods)
}

/**
 * The action that already uses `kb` (null when free). Push to talk also conflicts with combinations that
 * add modifiers to its own, since PTT + Shift still talks.
 */
export function findConflict(
  bindings: Partial<Record<HotkeyAction, Keybind | null>>,
  action: HotkeyAction,
  kb: Keybind,
): HotkeyAction | null {
  for (const info of HOTKEY_ACTIONS) {
    const other = bindings[info.id]
    if (info.id === action || !other) continue
    if (sameCombo(other, kb)) return info.id
    if (info.id === 'ptt' && triggersPtt(other, kb)) return info.id
    if (action === 'ptt' && triggersPtt(kb, other)) return info.id
  }
  return null
}

// ── DOM <-> uiohook ─────────────────────────────────────────────────────────────────────────────────────

/** KeyboardEvent.code -> [uiohook keycode, label]. Matches uiohook-napi's `UiohookKey`. */
const DOM_KEYS: Record<string, [number, string]> = {
  Backspace: [0x000e, 'Backspace'],
  Tab: [0x000f, 'Tab'],
  Enter: [0x001c, 'Enter'],
  CapsLock: [0x003a, 'Caps Lock'],
  Escape: [0x0001, 'Esc'],
  Space: [0x0039, 'Space'],
  PageUp: [0x0e49, 'Page Up'],
  PageDown: [0x0e51, 'Page Down'],
  End: [0x0e4f, 'End'],
  Home: [0x0e47, 'Home'],
  ArrowLeft: [0xe04b, 'Left Arrow'],
  ArrowUp: [0xe048, 'Up Arrow'],
  ArrowRight: [0xe04d, 'Right Arrow'],
  ArrowDown: [0xe050, 'Down Arrow'],
  Insert: [0x0e52, 'Insert'],
  Delete: [0x0e53, 'Delete'],
  Numpad0: [0x0052, 'Numpad 0'],
  Numpad1: [0x004f, 'Numpad 1'],
  Numpad2: [0x0050, 'Numpad 2'],
  Numpad3: [0x0051, 'Numpad 3'],
  Numpad4: [0x004b, 'Numpad 4'],
  Numpad5: [0x004c, 'Numpad 5'],
  Numpad6: [0x004d, 'Numpad 6'],
  Numpad7: [0x0047, 'Numpad 7'],
  Numpad8: [0x0048, 'Numpad 8'],
  Numpad9: [0x0049, 'Numpad 9'],
  NumpadMultiply: [0x0037, 'Numpad *'],
  NumpadAdd: [0x004e, 'Numpad +'],
  NumpadSubtract: [0x004a, 'Numpad -'],
  NumpadDecimal: [0x0053, 'Numpad .'],
  NumpadDivide: [0x0e35, 'Numpad /'],
  NumpadEnter: [0x0e1c, 'Numpad Enter'],
  Semicolon: [0x0027, ';'],
  Equal: [0x000d, '='],
  Comma: [0x0033, ','],
  Minus: [0x000c, '-'],
  Period: [0x0034, '.'],
  Slash: [0x0035, '/'],
  Backquote: [0x0029, '`'],
  BracketLeft: [0x001a, '['],
  Backslash: [0x002b, '\\'],
  BracketRight: [0x001b, ']'],
  Quote: [0x0028, "'"],
  ControlLeft: [0x001d, 'Left Ctrl'],
  ControlRight: [0x0e1d, 'Right Ctrl'],
  AltLeft: [0x0038, 'Left Alt'],
  AltRight: [0x0e38, 'Right Alt'],
  ShiftLeft: [0x002a, 'Left Shift'],
  ShiftRight: [0x0036, 'Right Shift'],
  MetaLeft: [0x0e5b, 'Left Meta'],
  MetaRight: [0x0e5c, 'Right Meta'],
  NumLock: [0x0045, 'Num Lock'],
  ScrollLock: [0x0046, 'Scroll Lock'],
  PrintScreen: [0x0e37, 'Print Screen'],
}
const LETTERS: Record<string, number> = {
  A: 0x1e, B: 0x30, C: 0x2e, D: 0x20, E: 0x12, F: 0x21, G: 0x22, H: 0x23, I: 0x17, J: 0x24, K: 0x25, L: 0x26, M: 0x32,
  N: 0x31, O: 0x18, P: 0x19, Q: 0x10, R: 0x13, S: 0x1f, T: 0x14, U: 0x16, V: 0x2f, W: 0x11, X: 0x2d, Y: 0x15, Z: 0x2c,
}
const DIGITS = [0x0b, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a]
const FKEYS = [
  0x3b, 0x3c, 0x3d, 0x3e, 0x3f, 0x40, 0x41, 0x42, 0x43, 0x44, 0x57, 0x58, 0x5b, 0x5c, 0x5d, 0x63, 0x64, 0x65, 0x66, 0x67,
  0x68, 0x69, 0x6a, 0x6b,
]

/** Platform names for the modifier keys themselves ("Left Cmd", "Right Option"…). */
function modifierKeyLabel(code: string, fallback: string): string {
  const m = /^(Alt|Meta)(Left|Right)$/.exec(code)
  if (!m) return fallback
  const names = modifierNames(currentPlatform())
  return `${m[2]} ${m[1] === 'Alt' ? names.alt : names.meta}`
}

/** KeyboardEvent.code -> [uiohook keycode, key name], or null for keys Nexo can't bind. */
export function domKey(code: string): [number, string] | null {
  const known = DOM_KEYS[code]
  if (known) return [known[0], modifierKeyLabel(code, known[1])]
  let m = /^Key([A-Z])$/.exec(code)
  if (m) return [LETTERS[m[1]], m[1]]
  m = /^Digit([0-9])$/.exec(code)
  if (m) return [DIGITS[Number(m[1])], m[1]]
  m = /^F([0-9]{1,2})$/.exec(code)
  if (m && Number(m[1]) >= 1 && Number(m[1]) <= 24) return [FKEYS[Number(m[1]) - 1], `F${m[1]}`]
  return null
}

/** MouseEvent.button (0 left, 1 middle, 2 right, 3 back, 4 forward) -> uiohook button (3..5). */
export function domMouseButton(button: number): number | null {
  if (button === 1) return 3
  if (button === 3) return 4
  if (button === 4) return 5
  return null // left/right are never bindable
}

export const mouseButtonLabel = (button: number): string => (button === 3 ? 'Middle Mouse' : `Mouse ${button}`)

export function domMods(e: KeyboardEvent | MouseEvent): KeybindMods {
  return { ctrl: e.ctrlKey, shift: e.shiftKey, alt: e.altKey, meta: e.metaKey }
}

/** A recorded combination from a DOM key/button with the given (effective) modifiers. */
export function makeKeybind(kind: Keybind['kind'], code: number, key: string, mods: KeybindMods): Keybind {
  return { kind, code, mods, label: formatKeybindLabel(mods, key, currentPlatform()) }
}

/**
 * Does this DOM press match `binding`? `tolerant` (push to talk) allows extra modifiers; otherwise they
 * must be exactly the binding's (left/right equivalent).
 */
export function domPressMatches(
  binding: Keybind | null,
  kind: Keybind['kind'],
  code: number | null,
  e: KeyboardEvent | MouseEvent,
  tolerant = false,
): boolean {
  if (!binding || code === null || binding.kind !== kind || binding.code !== code) return false
  const mods = effectiveMods(domMods(e), kind, code)
  return tolerant ? modsInclude(mods, binding.mods) : modsEqual(mods, binding.mods)
}

/** A key event matching `binding` (exact modifiers). */
export function domKeyMatches(binding: Keybind | null, e: KeyboardEvent): boolean {
  return domPressMatches(binding, 'key', domKey(e.code)?.[0] ?? null, e)
}

/** A mouse event matching `binding` (exact modifiers). */
export function domMouseMatches(binding: Keybind | null, e: MouseEvent): boolean {
  return domPressMatches(binding, 'mouse', domMouseButton(e.button), e)
}

/** Ctrl / Alt / Cmd combos are commands even in a text field; bare keys (or Shift+key) are typing there. */
export function typesText(binding: Keybind): boolean {
  return binding.kind === 'key' && !binding.mods.ctrl && !binding.mods.alt && !binding.mods.meta
}

export function isTypingTarget(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false
  if (t.isContentEditable) return true
  if (t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement) return true
  if (t instanceof HTMLInputElement) {
    return !['checkbox', 'radio', 'range', 'button', 'submit', 'reset', 'color', 'file'].includes(t.type)
  }
  return false
}
