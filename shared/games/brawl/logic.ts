// Ring Out: an original platform fighter for 2–4 (bots fill seats). Knock the others out of the blast zones;
// the higher their damage, the farther they fly. 3 stocks, 4 minutes, sudden death on a tie.
// Simulation: engine.ts; tuning (fighters, moves, stages): data.ts; computer players: bot.ts.
import type { GameDefinition } from '../types.ts'
import { MATCH_TICKS, TICK_HZ } from './data.ts'
import { botButtons } from './bot.ts'
import { buildView, createState, leaveSeat, stepState, type BrawlState } from './engine.ts'

export type { BrawlState, BrawlView, Fighter } from './engine.ts'

export const brawl: GameDefinition<BrawlState> = {
  id: 'brawl',
  name: 'Ring Out',
  tagline: 'Knock your friends off the stage. The higher their damage, the farther they fly.',
  minPlayers: 2,
  maxPlayers: 4,
  bots: true,
  controls: 'pad',
  help: [
    ['LEFT', 'Run left (RIGHT: run right)'],
    ['UP', 'Jump; again in the air for a double jump'],
    ['X', 'Jump (Y too)'],
    ['DOWN', 'Crouch, drop through platforms, fast-fall'],
    ['A', 'Light attack: neutral, side, up, down and air variants'],
    ['B', 'Heavy blow. Side: dash strike, up: recovery, down: counter / flip kick / slam'],
    ['L', 'Shield (R too). With a direction: roll, down: dodge, A: grab'],
    ['Goal', `3 stocks, ${MATCH_TICKS / TICK_HZ / 60} minutes: knock everyone out of the blast zones`],
  ],
  tickHz: TICK_HZ,
  frameEvery: 2,
  perSeatView: false,
  create: (seats, ctx) => createState(seats, ctx),
  tick: (state, input) => stepState(state, input),
  bot: (state, seat, ctx) => botButtons(state, seat, ctx),
  leave: (state, seat) => leaveSeat(state, seat),
  view: (state) => buildView(state),
  result: (state) => (state.ph === 'over' ? { winnerSeats: [...state.winners], summary: state.summary } : null),
}
