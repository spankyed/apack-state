// Telling a named peer is checked against the peers and events declared on Net.
// Compiled by `npm run typecheck`, never run: each `@ts-expect-error` is a line that must not compile, and one that
// compiled would fail the check as an unused directive.

import { forNet, system, type System } from '../src/index.ts'
import { connect } from '../src/testing.ts'
import type * as from from '../checks/peers-check.mts'
declare const state: typeof from.state

const noPeers = forNet<{ systems: {}; surfaces: {}; views: {} }>()
const typedSys = system<from.AppNet>({ side: 'backend' })
const typedWin = system<from.AppNet>({ side: 'window' })
const untypedSys = system({ side: 'backend' })
const noPeersSys = system<{ systems: {}; surfaces: {}; views: {} }>({ side: 'backend' })
const optionalPeersSys = system<{
  systems: {}
  surfaces: {}
  views: {}
  peers?: { audit: { events: { type: 'NOTE'; text: string } } }
}>({ side: 'backend' })

// Typed systems remain compatible with generic System helpers such as connect().
const asSystem: System = typedSys
void asSystem
void connect(typedWin, typedSys)

// Default system() stays 100% unchanged and accepts arbitrary peer names with callbacks or PeerPorts.
untypedSys.peer('anything', (event) => { const raw: unknown = event; void raw })
untypedSys.peer('anything', { tell: (_peer, event) => { const raw: unknown = event; void raw } })

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

// Valid typed peers compile and narrow event payloads as readonly.
typedSys.peer('runHistory', (event) => {
  if (event.type === 'STEP_RECORDED') {
    const detail: string = event.detail
    void detail
    // @ts-expect-error peer events are readonly
    event.detail = 'mutated'
  }
})
typedSys.peer('audit', {
  tell: (_peer, event) => {
    const text: string = event.text
    void text
  },
})

// @ts-expect-error unknown peer name is rejected where the peer is named
typedSys.peer('unknown', () => {})
// @ts-expect-error wrong event union for the named peer
typedSys.peer('audit', (_event: { type: 'STEP_RECORDED'; id: string; detail: string }) => {})
// @ts-expect-error Net with no peers rejects every peer name
noPeersSys.peer('runHistory', () => {})

// Optional `peers?: ...` on a Net still resolves its peer names and event unions cleanly.
optionalPeersSys.peer('audit', (event) => {
  const text: string = event.text
  void text
})
// @ts-expect-error optional peers still reject unknown peer names
optionalPeersSys.peer('unknown', () => {})
