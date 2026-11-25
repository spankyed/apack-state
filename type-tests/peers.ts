// Telling a named peer is checked against the peers and events declared on Net.
// Compiled by `npm run typecheck`, never run: each `@ts-expect-error` is a line that must not compile, and one that
// compiled would fail the check as an unused directive.

import { forNet } from '../src/index.ts'
import type * as from from '../checks/peers-check.mts'
declare const state: typeof from.state

const noPeers = forNet<{ systems: {}; surfaces: {}; views: {} }>()

state<{}, { type: 'GO' }>()({
  on: {
    GO: (_, { tell }) => {
      // @ts-expect-error no peer with this name is declared on Net
      tell({ peer: 'unknown' }, { type: 'STEP_RECORDED', id: '1', detail: 'x' })
      // @ts-expect-error the peer does not declare this event
      tell({ peer: 'runHistory' }, { type: 'NOTE', text: 'wrong peer' })
      // @ts-expect-error missing required field on the peer's event
      tell({ peer: 'runHistory' }, { type: 'STEP_RECORDED', id: '1' })
    },
  },
})

noPeers<{}, { type: 'GO' }>()({
  on: {
    GO: (_, { tell }) => {
      // @ts-expect-error this Net declares no peers at all
      tell({ peer: 'runHistory' }, { type: 'ANY' })
    },
  },
})
