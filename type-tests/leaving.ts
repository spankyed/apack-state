// Asking is for a state's work and an ask's handler, where a `Cancelled` can be taken.
// Compiled by `npm run typecheck`, never run: each `@ts-expect-error` is a line that must not compile, and one that
// compiled would fail the check as an unused directive.

import { given } from '../src/index.ts'
import type * as from from '../checks/leaving-check.mts'
declare const state: typeof from.state
type Panel = from.Panel
type PanelEvent = from.PanelEvent

// An event's handler is not given `ask`: it could only start one, with nothing around it to take a `Cancelled`.
state<Panel, PanelEvent>()({
  initial: 'idle',
  on: {
    // @ts-expect-error asking is for `run` and for an ask's handler
    START: (_, { ask }) => { void ask },
    LEAVE: () => ({ at: 'idle' }),
  },
  states: { idle: {}, working: { data: { how: given } } },
})
