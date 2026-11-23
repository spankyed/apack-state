// Work that awaits has to say where the state goes if it fails.
// Compiled by `npm run typecheck`, never run: each `@ts-expect-error` is a line that must not compile, and one that
// compiled would fail the check as an unused directive.

import { given } from '../src/index.ts'
import type * as from from '../checks/failure-check.mts'
declare const state: typeof from.state
type Panel = from.Panel
type PanelEvent = from.PanelEvent

// Work that awaits has to say where the state goes if it fails. Work that does not, need not.
state<Panel, PanelEvent>()({
  data: { count: 0, problem: null },
  start: 'idle',
  states: {
    idle: {},
    // @ts-expect-error its work awaits, and it does not say where it goes when that fails
    working: { data: { how: given }, async run() { await Promise.resolve() } },
    ready: { run() {} },
  },
})
