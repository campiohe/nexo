// Each game's view, loaded when a match of it shows (code-split per game).
import type { ComponentType } from 'react'
import type { GameId } from '@shared/protocol'
import type { GameViewProps } from './types'

type ViewModule = { default: ComponentType<GameViewProps<any>> }

export const GAME_VIEWS: Record<GameId, () => Promise<ViewModule>> = {
  bomber: () => import('./bomber/View'),
  kart: () => import('./kart/View'),
  brawl: () => import('./brawl/View'),
  fighter: () => import('./fighter/View'),
  cards: () => import('./cards/View'),
}
