// Telling a named peer is checked against the peers and events declared on Net.
// Compiled by `npm run typecheck`, never run: each `@ts-expect-error` is a line that must not compile, and one that
// compiled would fail the check as an unused directive.

import { forNet, peersFor, type System } from '../src/index.ts'
import type * as from from '../checks/peers-check.mts'
declare const state: typeof from.state
declare const attachPeer: typeof from.attachPeer
declare const sys: System

const noPeers = forNet<{ systems: {}; surfaces: {}; views: {} }>()
const attachNone = peersFor<{ systems: {}; surfaces: {}; views: {} }>()

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

// Valid typed peer attachments compile and narrow event payloads as readonly.
attachPeer(sys, 'runHistory', (event) => {
  if (event.type === 'STEP_RECORDED') {
    const detail: string = event.detail
    void detail
    // @ts-expect-error peer events are readonly
    event.detail = 'mutated'
  }
})
attachPeer(sys, 'audit', {
  tell: (_peer, event) => {
    const text: string = event.text
    void text
  },
})

// @ts-expect-error unknown peer name is rejected at attach time
attachPeer(sys, 'unknown', () => {})
// @ts-expect-error wrong event union for the named peer
attachPeer(sys, 'audit', (_event: { type: 'STEP_RECORDED'; id: string; detail: string }) => {})
// @ts-expect-error Net with no peers rejects every peer name
attachNone(sys, 'runHistory', () => {})
