// `listen` takes a state-lifetime `EventScope` (no `ask` or `sleep`) and returns cleanup or nothing; `stop(handle)` accepts any handle.
// Compiled by `npm run typecheck`, never run: each `@ts-expect-error` is a line that must not compile, and one that
// compiled would fail the check as an unused directive.

import { forNet, state, system, type Each } from '../src/index.ts'

type Net = {
  systems: { svc: { events: { type: 'PING' }; asks: { GET: { args: {}; answer: string } } } }
  surfaces: { panel: { events: { type: 'FLASH' } } }
  views: {}
}
const netState = forNet<Net>()

type Shape = {
  data: { count: number }
  internal: { type: 'TICK' }
  states: { a: {}; b: {} }
}
type Event = { type: 'GO' }

// Valid `listen` usages (returns cleanup or void, at root and in substates, independent of `run`).
const validRoot = netState<Shape, Event, { READ: { args: {}; answer: number } }>()({
  data: { count: 0 },
  initial: 'a',
  listen({ send, tell, broadcast, onExit, data, signal }) {
    void data.count
    void signal.aborted
    send({ type: 'TICK' })
    send({ type: 'GO' })
    tell('svc', { type: 'PING' })
    broadcast('panel', { type: 'FLASH' })
    onExit(() => {})
    return () => {}
  },
  on: { GO: () => ({ at: 'b' }) },
  internal: { TICK: (_, { data }) => ({ data: { count: data.count + 1 } }) },
  answers: { READ: (_, { data }) => data.count },
  states: {
    a: {
      listen: ({ send }) => { send({ type: 'TICK' }) },
      async run({ ask }) { await ask('svc', 'GET', {}) },
      failed: () => ({ at: 'b' }),
    },
    b: {},
  },
})

// `stop(handle)` accepts any top-level handle returned by `sys.start(...)` and refuses child handles from `sys.child(...)`.
{
  const kid = state<{ data: { id: string } }>()({ data: { id: '' } })
  const bare = state<{}>()({})
  const withStarts = state<{ data: { ids: string[] }; starts: { kid: Each<typeof kid> } }, { type: 'NOOP' }>()({
    data: { ids: [] },
    starts: (start) => ({ kid: start(kid, { each: 'ids', given: () => ({}) }) }),
  })
  const sys = system({ side: 'backend' })
  const hRich = sys.start('rich', validRoot)
  const hBare = sys.start('bare', bare)
  const hParent = sys.start('parent', withStarts)
  const hChild = sys.child(hParent, 'kid', 'k1')
  sys.stop(hRich)
  sys.stop(hBare)
  sys.stop(hParent)
  // @ts-expect-error child handles belong to their starter; change the starter's data to stop them
  sys.stop(hChild)
  sys.stop()
}

// What must not compile in `listen`:
netState<Shape, Event>()({
  data: { count: 0 },
  initial: 'a',
  // @ts-expect-error asking is for `run` and for an ask's handler, not `listen`
  listen: ({ ask }) => { void ask },
  states: { a: {}, b: {} },
})

netState<Shape, Event>()({
  data: { count: 0 },
  initial: 'a',
  // @ts-expect-error sleeping is for `run` and for an ask's handler, not `listen`
  listen: ({ sleep }) => { void sleep },
  states: { a: {}, b: {} },
})

netState<Shape, Event>()({
  data: { count: 0 },
  initial: 'a',
  // @ts-expect-error `listen` returns a cleanup function or nothing, never a transition
  listen: () => ({ at: 'b' }),
  states: { a: {}, b: {} },
})
