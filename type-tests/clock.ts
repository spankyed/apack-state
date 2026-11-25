// Sleeping is for a state's work and an ask's handler, where a `Cancelled` can be taken.
// Compiled by `npm run typecheck`, never run: each `@ts-expect-error` is a line that must not compile, and one that
// compiled would fail the check as an unused directive.

import { forNet } from '../src/index.ts'

const state = forNet()
type Timer = { states: { idle: {}; waiting: {} } }
type TimerEvent = { type: 'START' }

// An event's handler is not given `sleep`: it is synchronous and cannot await, and a timer it only started would
// unwind with `Cancelled` on exit with nothing around it to take that.
state<Timer, TimerEvent>()({
  initial: 'idle',
  on: {
    // @ts-expect-error sleeping is for `run` and for an ask's handler
    START: (_, { sleep }) => { void sleep },
  },
  states: { idle: {}, waiting: {} },
})
