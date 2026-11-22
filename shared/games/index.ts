// Every game of the Games plugin, by id (server: runs them; desktop: names, player counts, help).
import type { GameId } from '../protocol.ts'
import type { GameDefinition } from './types.ts'
import { bomber } from './bomber/logic.ts'
import { kart } from './kart/logic.ts'
import { brawl } from './brawl/logic.ts'
import { fighter } from './fighter/logic.ts'
import { cards } from './cards/logic.ts'

// Each game's state type is its own; the registry only needs the contract.
export const GAMES: Record<GameId, GameDefinition<any>> = { bomber, kart, brawl, fighter, cards }
