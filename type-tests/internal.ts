// Who may send a state what: the events it sends itself, and the surfaces it tells.
// Compiled by `npm run typecheck`, never run: each `@ts-expect-error` is a line that must not compile, and one that
// compiled would fail the check as an unused directive.

import { system } from '../src/index.ts'
import type * as from from '../checks/internal-check.mts'
declare const state: typeof from.state
declare const list: typeof from.list
type List = from.List
type ListEvent = from.ListEvent

// What must not compile.
{
  const window = system({ side: 'window' })
  const theList = window.start('typed', list)
  // @ts-expect-error only the list sends itself a tick
  window.send(theList, { type: 'TICK' })
  window.stop()
}
state<List, ListEvent>()({
  data: { picked: null, ticks: 0 },
  on: {
    // @ts-expect-error a tick is what it sends itself, and is taken under `internal`
    TICK: () => ({ data: { ticks: 1 } }),
    // @ts-expect-error the detail surface takes no such event
    PICK: (_, { tell }) => { tell({ surface: 'detail' }, { type: 'HIDE' }) },
    // @ts-expect-error there is no such surface
    REFRESH: (_, { tell }) => { tell({ surface: 'sidebar' }, { type: 'SHOW', id: 'a' }) },
    // @ts-expect-error it raises a tick, or what others may send it, and nothing else
    PICK_AGAIN: (_, { raise }) => { raise({ type: 'TOCK' }) },
  },
  internal: {
    // @ts-expect-error what others may send it is taken under `on`
    PICK: () => ({ data: { picked: null } }),
  },
})
