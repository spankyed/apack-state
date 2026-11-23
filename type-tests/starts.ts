// The states a state starts: what each is given, and from what.
// Compiled by `npm run typecheck`, never run: each `@ts-expect-error` is a line that must not compile, and one that
// compiled would fail the check as an unused directive.

import type * as from from '../checks/starts-check.mts'
declare const state: typeof from.state
declare const card: typeof from.card
declare const helper: typeof from.helper
type Board = from.Board
type BoardAsks = from.BoardAsks
type BoardEvent = from.BoardEvent

// What must not compile.
state<Board, BoardEvent, BoardAsks>()({
  data: { title: '', items: {}, lastBump: null },
  start: 'open',
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
state<Board, BoardEvent, BoardAsks>()({ data: { title: '', items: {}, lastBump: null }, start: 'open', states: { open: { starts: (start) => ({ helper: start(helper([]), { given: () => ({ title: '' }) }) }) }, closed: {} } })
state<Board, BoardEvent, BoardAsks>()({
  data: { title: '', items: {}, lastBump: null },
  start: 'open',
  starts: (start) => ({
    // @ts-expect-error a title is neither a list nor keyed, so it cannot say which cards there are
    card: start(card([]), { each: 'title', given: (id) => ({ id, label: '' }) }),
  }),
  states: { open: { starts: (start) => ({ helper: start(helper([]), { given: () => ({ title: '' }) }) }) }, closed: {} },
})
state<Board, BoardEvent, BoardAsks>()({
  data: { title: '', items: {}, lastBump: null },
  start: 'open',
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
