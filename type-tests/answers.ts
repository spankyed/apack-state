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
      answers: {
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
import { forNet, type AsksOf, type EventsOf, type ShapeOf } from '../src/index.ts'
type ListAsks = { FINISH: { args: {}; answer: 'done' } }
const listMachine = forNet()<{ data: { items: string[] }; states: { open: {}; done: { data: { snapshot: string[] } } } }, { type: 'RESET' }, ListAsks>()({
  data: { items: [] },
  initial: 'open',
  states: {
    open: {
      answers: {
        FINISH: async (_, { data }) => answered('done' as const, { at: 'done', data: { snapshot: data.items } }),
      },
    },
    done: { data: { snapshot: given } },
  },
})

// `ShapeOf`, `EventsOf`, and `AsksOf` extract the declared type parameters from a `State`.
const _shapeCheck: ShapeOf<typeof listMachine> = { data: { items: [] }, states: { open: {}, done: { data: { snapshot: [] } } } }
const _eventCheck: EventsOf<typeof listMachine> = { type: 'RESET' }
const _asksCheck: AsksOf<typeof listMachine> = { FINISH: { args: {}, answer: 'done' } }
// @ts-expect-error `EventsOf` extracts only the declared event union, not arbitrary event types
const _wrongEvent: EventsOf<typeof listMachine> = { type: 'NOPE' }
// @ts-expect-error `AsksOf` preserves the exact ask answer type
const _wrongAsks: AsksOf<typeof listMachine> = { FINISH: { args: {}, answer: 42 } }
void _shapeCheck; void _eventCheck; void _asksCheck; void _wrongEvent; void _wrongAsks
