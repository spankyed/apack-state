// States that move for each reason a state can: an event, a timer, a view, how a call went and what it said on the
// way, what its work found, that its work failed, and an ask it answered, at once and later.
import { answered, forNet } from '../../src/index.ts'

type Asks = { SLOW: { args: {}; progress: string; answer: string }; SHIFT: { args: {}; answer: string }; LATER: { args: {}; answer: string } }
type Net = {
  systems: { slow: { events: never; asks: Asks }; shifting: { events: never; asks: Asks } }
  surfaces: {}
  views: { docs: { count: { args: {}; result: number } } }
}
const state = forNet<Net>()

/** Moves when it is sent something, and when the timer that arms expires. */
export const sent = state<{ states: { idle: {}; waiting: {}; late: {} }; arms: { patience: 'single' } }, { type: 'WAIT' }>()({
  initial: 'idle',
  arms: ({ single }) => ({ patience: single({ after: 50, expired: () => ({ at: 'late' }) }) }),
  states: { idle: { on: { WAIT: (_, { arm }) => { arm('patience'); return { at: 'waiting' } } } }, waiting: {}, late: {} },
})
/** Moves when the view it follows says something. */
export const viewing = state<{ states: { waiting: {}; seen: {} } }, never>()({
  initial: 'waiting',
  follows: (follow) => ({ docs: follow('docs', 'count', { updated: () => ({ at: 'seen' }) }) }),
  states: { waiting: {}, seen: {} },
})
/** Says how far it has got, and then answers. */
export const slow = state<{}, never, Pick<Asks, 'SLOW'>>()({
  answers: { SLOW: async (_, { progress }) => { progress('half'); await Promise.resolve(); return 'done' } },
})
/** Moves when what it called says how far it has got, and again when it ends. */
export const calling = state<{ states: { idle: {}; hearing: {}; heard: {} }; calls: { slow: 'single' } }, { type: 'GO' }>()({
  initial: 'idle',
  calls: ({ single }) => ({ slow: single('slow', 'SLOW', { progress: () => ({ at: 'hearing' }), done: () => ({ at: 'heard' }) }) }),
  on: { GO: (_, { call }) => { call('slow') } },
  states: { idle: {}, hearing: {}, heard: {} },
})
/** Moves when its work ends. */
export const resting = state<{ states: { busy: {}; rested: {} } }, never>()({
  initial: 'busy',
  states: { busy: { run: async () => ({ at: 'rested' as const }), failed: () => ({ at: 'rested' }) }, rested: {} },
})
/** Moves when its work fails. */
export const breaking = state<{ states: { busy: {}; upset: {} } }, never>()({
  initial: 'busy',
  states: { busy: { run: async () => { throw new Error('it broke') }, failed: () => ({ at: 'upset' }) }, upset: {} },
})
/** Moves as it answers: at once, and after a wait. */
export const shifting = state<{ states: { idle: {}; shifted: {}; later: {} } }, never, Pick<Asks, 'SHIFT' | 'LATER'>>()({
  initial: 'idle',
  answers: {
    SHIFT: () => answered('ok', { at: 'shifted' }),
    LATER: async () => { await Promise.resolve(); return answered('ok', { at: 'later' }) },
  },
  states: { idle: {}, shifted: {}, later: {} },
})
