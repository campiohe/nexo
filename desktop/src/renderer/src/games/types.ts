// The contract between the game area (components/games/GameArea.tsx) and each game's view
// (games/<id>/View.tsx, the default export). The game's logic and view shape live in shared/games/<id>.
import type { GameLobby, GameSeat } from '@shared/protocol'
import type { FrameSource } from './frames'

export interface GameViewProps<V = unknown> {
  /** The session: `seats` (names, colors, who is a bot), `matchId`, `status` ('playing' or 'finished'). */
  lobby: GameLobby
  seats: GameSeat[]
  /** This device's seat in the match, or null when watching. */
  seat: number | null
  /** The match's frames: `sample()` for smooth motion, `latest()` for the newest state. */
  frames: FrameSource<V>
  /**
   * `actions` games: send one move. Resolves with the server's refusal (show it) or null when applied (the
   * next frame shows the result).
   */
  act(action: unknown): Promise<string | null>
  /** `pad` games: the buttons this device holds right now (instant local feedback, e.g. a menu cursor). */
  localButtons(): number
  /** Sound effects on (not deafened, games volume > 0). Use games/retro.ts `sfx`, which already checks it. */
  muted: boolean
}
