// A state entered at one inside it before it is entered itself: what it starts at is entered when it is.
import { forNet } from '../../src/index.ts'

const state = forNet()
type Event = { type: 'INTO_Y' } | { type: 'INTO_A' }
export const nested = state<{ states: { idle: {}; a: { states: { x: {}; y: {} } } } }, Event>()({
  initial: 'idle',
  states: {
    idle: { on: { INTO_Y: () => ({ at: 'a.y' }) } },
    a: { initial: 'x', on: { INTO_A: () => ({ at: 'a' }) }, states: { x: {}, y: {} } },
  },
})
