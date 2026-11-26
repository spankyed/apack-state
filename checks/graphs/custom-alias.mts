// Fixture for `checks/graph-check.mts`: states built with non-`state` aliases (`hostState`, inline `forNet<Net>()`,
// and bare `state()` with inferred shape) must all be discovered by their resolved `State<...>` return type.
import { forNet, state } from '../../src/index.ts'

type HostNet = {
  systems: { 'host/settings': { events: { type: 'RELOAD' }; asks: { GET: { args: {}; answer: string } } } }
  surfaces: {}
  views: {}
}

const hostState = forNet<HostNet>()

type SettingsShape = {
  data: { theme: string }
  states: { ready: {}; saving: {} }
}

export const settings = hostState<SettingsShape, { type: 'SAVE' }, { GET: { args: {}; answer: string } }>()({
  data: { theme: 'dark' },
  initial: 'ready',
  states: {
    ready: { on: { SAVE: () => ({ at: 'saving' }) } },
    saving: { on: { SAVE: () => ({ at: 'ready' }) } },
  },
  answers: { GET: (_, { data }) => data.theme },
})

type InlineShape = { data: { n: number } }
export const inlineNet = forNet<HostNet>()<InlineShape, { type: 'PING' }>()({
  data: { n: 0 },
  on: { PING: (_, { tell }) => { tell('host/settings', { type: 'RELOAD' }) } },
})

export const bare = state()({})
