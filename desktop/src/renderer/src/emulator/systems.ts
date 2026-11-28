// What each console of the Emulator plugin is, and how a Nexo controller (GAME_PAD bits + EmuAxes, standard
// gamepad layout) maps onto its pad. Engines (engine/<system>/) implement exactly this mapping; the UI shows it as
// the controls help. Buttons go by POSITION on an Xbox-style pad: A bottom, B right, X left, Y top.
import type { EmuSystem } from '@shared/protocol'
import { msg } from '../i18n/core'

export interface EmuSystemInfo {
  id: EmuSystem
  /** Display name. */
  name: string
  /** Short label (chips, sidebar). */
  short: string
  /** The console has analog sticks some games need (keyboards drive the left stick from the d-pad). */
  analog: boolean
  /**
   * How each Nexo control maps to the console's pad: [Nexo control (GAME_PAD name or 'Left stick' /
   * 'Right stick' / 'D-pad'), console control]. In display order. A console control that's a description (not
   * the name printed on the button) is a message key (msg): shown with t().
   */
  controls: [string, string][]
}

export const EMU_SYSTEM_INFO: Record<EmuSystem, EmuSystemInfo> = {
  snes: {
    id: 'snes',
    name: 'Super Nintendo', // i18n-ignore
    short: 'SNES',
    analog: false,
    controls: [
      ['D-pad', msg('D-pad (also the left stick)')],
      ['A', 'B'],
      ['B', 'A'],
      ['X', 'Y'],
      ['Y', 'X'],
      ['L', 'L'],
      ['R', 'R'],
      ['START', 'Start'],
      ['SELECT', 'Select'],
    ],
  },
  genesis: {
    id: 'genesis',
    name: 'Mega Drive / Genesis', // i18n-ignore
    short: 'Mega Drive',
    analog: false,
    controls: [
      ['D-pad', msg('D-pad (also the left stick)')],
      ['X', 'A'],
      ['A', 'B'],
      ['B', 'C'],
      ['L', msg('X (6-button pad)')],
      ['Y', msg('Y (6-button pad)')],
      ['R', msg('Z (6-button pad)')],
      ['START', 'Start'],
      ['SELECT', 'Mode'],
    ],
  },
  psx: {
    id: 'psx',
    name: 'PlayStation',
    short: 'PS1',
    analog: true,
    controls: [
      ['D-pad', msg('D-pad')],
      ['Left stick', msg('Left stick (the d-pad in games without analog)')],
      ['Right stick', msg('Right stick (DualShock)')],
      ['A', msg('✕ Cross')],
      ['B', msg('○ Circle')],
      ['X', msg('□ Square')],
      ['Y', msg('△ Triangle')],
      ['L', 'L1'],
      ['R', 'R1'],
      ['L2', 'L2'],
      ['R2', 'R2'],
      ['L3', 'L3'],
      ['R3', 'R3'],
      ['START', 'Start'],
      ['SELECT', msg('Select (L1 + R1 + Select: the ANALOG button)')],
    ],
  },
  n64: {
    id: 'n64',
    name: 'Nintendo 64', // i18n-ignore
    short: 'N64',
    analog: true,
    controls: [
      ['Left stick', msg('Control stick (keyboard: the arrows / WASD)')],
      ['D-pad', msg('D-pad (with a gamepad)')],
      ['A', 'A'],
      ['X', 'B'],
      ['L2', 'Z'],
      ['L', 'L'],
      ['R', 'R'],
      ['Right stick', msg('C buttons')],
      ['Y', 'C-up'],
      ['B', 'C-down'],
      ['R2', 'C-right'],
      ['SELECT', 'C-left'],
      ['START', 'Start'],
    ],
  },
}
