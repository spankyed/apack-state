// A state entered at one inside it before it is entered itself: what it starts at is entered when it is.
import { reaching } from '../../src/index.ts'

const state = reaching()
type Event = { type: 'INTO_Y' } | { type: 'INTO_A' }
export const nested = state<{ states: { idle: {}; a: { states: { x: {}; y: {} } } } }, Event>()({
  start: 'idle',
  states: {
    idle: { on: { INTO_Y: () => ({ at: 'a.y' }) } },
    a: { start: 'x', on: { INTO_A: () => ({ at: 'a' }) }, states: { x: {}, y: {} } },
  },
})
