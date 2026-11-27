// The states a state starts: what each is given, and from what.
// Compiled by `npm run typecheck`, never run: each `@ts-expect-error` is a line that must not compile, and one that
// compiled would fail the check as an unused directive.

import type * as from from '../checks/starts-check.mts'
import { given, type System } from '../src/index.ts'
import type { fromEvents } from '../src/testing.ts'
declare const runEvents: typeof fromEvents
declare const state: typeof from.state
declare const card: typeof from.card
declare const helper: typeof from.helper
declare const sys: System
type Board = from.Board
type BoardAsks = from.BoardAsks
type BoardEvent = from.BoardEvent

// What must not compile.
state<Board, BoardEvent, BoardAsks>()({
  data: { title: '', items: {}, lastBump: null },
  initial: 'open',
  starts: (start) => ({ card: start(card([]), { each: 'items', given: (id) => ({ id, label: '' }) }) }),
  on: {
    // @ts-expect-error a card is one of many, so reaching one takes its key
    BUMP: (_, { tell, child }) => { tell(child('card'), { type: 'BUMP' }) },
    // @ts-expect-error there is no such state to reach
    ADD: (_, { child }) => { void child('deck') },
    // @ts-expect-error the helper is started by `open`, so only a handler inside `open` can reach it
    CLOSE: (_, { child }) => { void child('helper') },
    // @ts-expect-error the board declares nothing it reports, so it has nothing to report
    RETITLE: (_, { report }) => { report({ type: 'CARD_BUMPED', bumps: 1 }) },
  },
  states: {
    open: {
      starts: (start) => ({ helper: start(helper([]), { given: () => ({ title: '' }) }) }),
      // Inside `open` it can be reached, and there is one, so it takes no key.
      on: { OPEN: (_, { child }) => { void child('helper') } },
    },
    closed: {},
  },
})
// @ts-expect-error a state whose shape says it starts cards has to say which
state<Board, BoardEvent, BoardAsks>()({ data: { title: '', items: {}, lastBump: null }, initial: 'open', states: { open: { starts: (start) => ({ helper: start(helper([]), { given: () => ({ title: '' }) }) }) }, closed: {} } })
state<Board, BoardEvent, BoardAsks>()({
  data: { title: '', items: {}, lastBump: null },
  initial: 'open',
  starts: (start) => ({
    // @ts-expect-error a title is neither a list nor keyed, so it cannot say which cards there are
    card: start(card([]), { each: 'title', given: (id) => ({ id, label: '' }) }),
  }),
  states: { open: { starts: (start) => ({ helper: start(helper([]), { given: () => ({ title: '' }) }) }) }, closed: {} },
})
state<Board, BoardEvent, BoardAsks>()({
  data: { title: '', items: {}, lastBump: null },
  initial: 'open',
  starts: (start) => ({
    // @ts-expect-error a card has to be given its label as well as which it is
    card: start(card([]), { each: 'items', given: (id) => ({ id }) }),
  }),
  states: {
    // @ts-expect-error the helper has to be given its title, so it cannot be named bare
    open: { starts: (_start) => ({ helper: helper([]) }) },
    closed: {},
  },
})

// Starting a root state with and without `given` fields.
const plain = state<{ data: { count: number } }, never>()({ data: { count: 0 } })
sys.start('plain', plain)
sys.start('card', card([]), { id: 'a', label: 'Alpha' })
// @ts-expect-error a root state with given fields cannot be started without them
sys.start('card', card([]))
// @ts-expect-error a root state has to be given every field it marks given
sys.start('card', card([]), { id: 'a' })
// @ts-expect-error a root state with no given fields takes no third argument
sys.start('plain', plain, {})

// A root state that marks an optional field `given` requires that field to be provided at start (preserving `undefined`).
const optGiven = state<{ data: { note?: string } }, never>()({ data: { note: given } })
sys.start('optGiven', optGiven, { note: 'hi' })
sys.start('optGiven', optGiven, { note: undefined })
// @ts-expect-error an optional field marked given cannot be omitted when starting the root state
sys.start('optGiven', optGiven, {})

// `fromEvents` requires `given` for a root state with `given` fields and refuses it when none exist.
const givenCounter = state<{ data: { label: string; count: number } }, { type: 'INC' }>()({
  data: { label: given, count: 0 },
  on: { INC: (_, { data }) => ({ data: { count: data.count + 1 } }) },
})
void runEvents({ state: givenCounter, given: { label: 'a' }, events: { INC: () => ({ type: 'INC' }) }, always: () => {}, steps: 1, runs: 1, seed: 1 })
// @ts-expect-error fromEvents requires given when the state declares given fields
void runEvents({ state: givenCounter, events: { INC: () => ({ type: 'INC' }) }, always: () => {}, steps: 1, runs: 1, seed: 1 })

// A `start` substate cannot mark an optional field `given` (direct or nested).
type OptStart = { states: { a: { data: { note?: string } }; b: { data: { id: string } } } }
state<OptStart, never>()({
  initial: 'a',
  states: {
    // @ts-expect-error a start substate is entered with no supplied data, so it cannot mark a field given
    a: { data: { note: given } },
    b: { data: { id: given } },
  },
})
type DeepOptStart = {
  states: {
    idle: {}
    outer: { states: { inner: { data: { note?: string } } } }
  }
}
state<DeepOptStart, never>()({
  initial: 'idle',
  states: {
    idle: {},
    outer: {
      initial: 'inner',
      states: {
        // @ts-expect-error even inside a non-start branch, its own start substate cannot mark a field given
        inner: { data: { note: given } },
      },
    },
  },
})

// A nested state cannot redeclare a data field name already owned by an enclosing state (direct or nested).
type DirectShadow = {
  data: { error: string | null }
  states: { a: { data: { error: string } }; b: {} }
}
state<DirectShadow, never>()({
  data: { error: null },
  initial: 'b',
  states: {
    // @ts-expect-error a child state cannot shadow a field name declared by its parent
    a: { data: { error: '' } },
    b: {},
  },
})
// A value typed `any` is refused there as any other is: what is refused is declaring the field, whatever is written for it.
declare const untyped: any
state<DirectShadow, never>()({
  data: { error: null },
  initial: 'b',
  states: {
    // @ts-expect-error a child state cannot shadow a field name declared by its parent, whatever its value is typed
    a: { data: { error: untyped } },
    b: {},
  },
})
// Two fields declared again are both named.
state<{ data: { error: string | null; note: string }; states: { a: { data: { error: string; note: string } }; b: {} } }, never>()({
  data: { error: null, note: '' },
  initial: 'b',
  states: {
    // @ts-expect-error each field a child declares again is named in the refusal
    a: { data: { error: '', note: '' } },
    b: {},
  },
})

type DeepShadow = {
  data: { error: string | null }
  states: { mid: { states: { idle: {}; leaf: { data: { error: string } } } } }
}
state<DeepShadow, never>()({
  data: { error: null },
  initial: 'mid',
  states: {
    mid: {
      initial: 'idle',
      states: {
        idle: {},
        // @ts-expect-error a deeply nested state cannot shadow a field name declared by an ancestor
        leaf: { data: { error: '' } },
      },
    },
  },
})


// Sibling states may share field names because they are never active at the same time.
type SiblingFields = {
  data: { id: string }
  states: { idle: {}; a: { data: { note: string } }; b: { data: { note: number } } }
}
state<SiblingFields, never>()({
  data: { id: 'x' },
  initial: 'idle',
  states: {
    idle: {},
    a: { data: { note: 'hi' } },
    b: { data: { note: 1 } },
  },
})

// Reading a started child via `read(child(...))` can return `undefined` when it is not running.
state<Board, BoardEvent, BoardAsks>()({
  data: { title: '', items: {}, lastBump: null },
  initial: 'open',
  starts: (start) => ({ card: start(card([]), { each: 'items', given: (id) => ({ id, label: '' }) }) }),
  on: {
    BUMP: (_, { read, child }) => {
      const okLabel: string | undefined = read(child('card', 'a'))?.data.label
      void okLabel
      // @ts-expect-error a started child might not be running, so read() may be undefined
      const unsafe: string = read(child('card', 'a')).data.label
      void unsafe
    },
  },
  states: { open: { starts: (start) => ({ helper: start(helper([]), { given: () => ({ title: '' }) }) }) }, closed: {} },
})

// A state whose data has values of its own can be entered first, at the top or in a state inside: what cannot be
// there is a field that has to be given, which is refused field by field (above).
state<{ states: { waiting: {}; editing: { data: { draft: string } } } }>()({
  initial: 'editing',
  states: { waiting: {}, editing: { data: { draft: '' } } },
})
state<{ states: { outer: { states: { waiting: {}; editing: { data: { draft: string } } } } } }>()({
  initial: 'outer',
  states: { outer: { initial: 'editing', states: { waiting: {}, editing: { data: { draft: '' } } } } },
})
state<{ states: { waiting: {}; editing: { data: { draft: string } } } }>()({
  // @ts-expect-error a name that is no state is told the states there are
  initial: 'editting',
  states: { waiting: {}, editing: { data: { draft: '' } } },
})
