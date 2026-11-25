// An answer that changes something: what it may change, and that the answer is still checked.
// Compiled by `npm run typecheck`, never run: each `@ts-expect-error` is a line that must not compile, and one that
// compiled would fail the check as an unused directive.

import { answered, given } from '../src/index.ts'
import type * as from from '../checks/answer-check.mts'
declare const state: typeof from.state
type Counter = from.Counter
type CounterAsks = from.CounterAsks
type CounterEvent = from.CounterEvent

// What must not compile.
state<Counter, CounterEvent, CounterAsks>()({
  data: { count: 0 },
  initial: 'open',
  states: {
    open: {
      asks: {
        // @ts-expect-error after a wait, data is changed by editing a draft, not by giving fields worked out before it
        ADD_LATER: async (_, { data }) => answered('added' as const, { data: { count: data.count + 1 } }),
        // @ts-expect-error a move into `closed` has to give its reason
        CLOSE: () => answered('closed' as const, { at: 'closed' }),
        // @ts-expect-error the answer is still checked: this ask answers with a number
        ADD: () => answered('one', { data: { count: 1 } }),
      },
    },
    closed: { data: { reason: given } },
  },
})

// After an await, a move's gained data accepts read-only values straight from `data`.
import { forNet } from '../src/index.ts'
type ListAsks = { FINISH: { args: {}; answer: 'done' } }
forNet()<{ data: { items: string[] }; states: { open: {}; done: { data: { snapshot: string[] } } } }, never, ListAsks>()({
  data: { items: [] },
  initial: 'open',
  states: {
    open: {
      asks: {
        FINISH: async (_, { data }) => answered('done' as const, { at: 'done', data: { snapshot: data.items } }),
      },
    },
    done: { data: { snapshot: given } },
  },
})
