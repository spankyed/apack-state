// Who a state tells, named by a call with nothing passed, and an await whose fields it is from written short.
import { forNet } from '../../src/index.ts'

type Net = {
  systems: { library: { events: { type: 'SHELVED' }; asks: { LOOKUP: { args: { query: string }; answer: string } } } }
  surfaces: {}
  views: {}
}
const state = forNet<Net>()
const where = (): 'library' => 'library'
const from = ['query'] as const
export const reader = state<{ data: { query: string; found: string } }, { type: 'SHELVE' }>()({
  data: { query: '', found: '' },
  on: { SHELVE: (_, { tell }) => { tell(where(), { type: 'SHELVED' }) } },
  loads: (load) => ({
    lookup: load('library', 'LOOKUP', { from, args: ({ query }) => query !== '' && { query }, done: (outcome) => (outcome.ok ? { data: { found: outcome.value } } : undefined) }),
  }),
})
