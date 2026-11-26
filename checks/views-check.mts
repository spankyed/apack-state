// What a window is told of a step, it is told after its views show the step. A backend that runs views for its windows
// holds what a step sends them until the views have been sent the step's rows, and sends both down the same link, so
// the order they arrive in is the order they were sent in. Checked against rows in memory under every ordering, and
// against elmdb, whose views run on its own clock.
//
//   npx vitest run views
import { deepStrictEqual, ok, strictEqual } from 'node:assert'
import { connect, rest, run, system } from './checks.mts'
import { sample, type Schedule } from '@apackdev/orderings'
import { answered, forNet, type ViewHost } from '../src/index.ts'
import { memory, type Rows } from './store.mts'
import { elmdb } from './store-elmdb.mts'
import { nextTurn } from '../src/turn.ts'

type ThreadAsks = { CREATE: { args: { id: string }; answer: { id: string } } }
type PanelEvents = { type: 'CREATED'; id: string }
type PanelAsks = { ADD: { args: { id: string }; answer: boolean } }
type App = {
  systems: { threads: { events: never; asks: ThreadAsks } }
  surfaces: { panel: { events: PanelEvents } }
  views: { threads: { count: { args: {}; result: number } } }
}
const state = forNet<App>()

/** The backend: a thread is a row, and making one is told to every window as well as answered. */
const threads = (store: Rows) => state<{}, never, ThreadAsks>()({
  answers: {
    CREATE: ({ id }, { broadcast }) => {
      store.put('thread', id, { topic: 'made' })
      broadcast('panel', { type: 'CREATED', id })
      return { id }
    },
  },
})

type Panel = { data: { count: number; atAnswer: number[]; atEvent: number[] } }
/**
 * A window's surface: it follows how many threads there are, and notes that number as each thread it asked for is
 * answered and as it is told of each one. Told of a thread its view does not show yet, the number would be behind.
 */
const panel = state<Panel, PanelEvents, PanelAsks>()({
  data: { count: 0, atAnswer: [], atEvent: [] },
  follows: (follow) => ({
    count: follow('threads', 'count', { args: () => ({}), updated: (update) => (update.ok ? { data: { count: update.value } } : undefined) }),
  }),
  on: {
    CREATED: (_, { data }) => ({ data: { atEvent: [...data.atEvent, data.count] } }),
  },
  answers: {
    ADD: async ({ id }, { ask }) => {
      const outcome = await ask('threads', 'CREATE', { id })
      return answered(outcome.ok, { data: (draft) => { draft.atAnswer.push(draft.count) } })
    },
  },
})

/** A backend state that follows a view of its own rows, and writes what it hears: once, it throws after writing. */
const watcher = (store: Rows) => state<{ data: { heard: number[] } }, never>()({
  data: { heard: [] },
  follows: (follow) => ({
    count: follow('threads', 'count', {
      args: () => ({}),
      updated: (update, { data }) => {
        if (!update.ok) return undefined
        store.put('import', `saw-${update.value}`, { state: 'seen' })
        if (update.value === 1) throw new Error('hearing broke')
        return { data: { heard: [...data.heard, update.value] } }
      },
    }),
  }),
})

/** The views a backend runs over its rows. */
const viewsOf = (store: Rows): ViewHost => (_feature, _view, _args, heard) => store.watch(() => store.count('thread'), (value) => heard({ ok: true, value }))
/** The same views, unable to say when they have caught up: what a backend has to hold for, taken away. */
const unheld = (store: Rows): ViewHost => (feature, view, args, heard) => {
  const running = viewsOf(store)(feature, view, args, heard)
  return typeof running === 'function' ? running : { stop: () => running.stop() }
}

const made = (store: Rows, held: boolean, schedule?: Schedule) => {
  const traced: string[] = []
  const trace = (line: string): void => { traced.push(line) }
  const backend = system({ side: 'backend', transact: store.transact, views: held ? viewsOf(store) : unheld(store), trace, ...(schedule ? { later: schedule.later } : {}) })
  backend.start('threads', threads(store))
  const window = system({ side: 'window', trace, ...(schedule ? { later: schedule.later } : {}) })
  const link = connect(window, backend, schedule)
  const handle = window.start('panel', panel)
  return { backend, window, handle, link, defects: () => traced.filter((line) => line.startsWith('DEFECT')) }
}

/** Waits until the views have been told of what was kept, and what that led to has come to rest. */
const settledAndRest = async (store: Rows): Promise<void> => {
  await new Promise<void>((resolve) => { store.settled(resolve) })
  await rest()
}

/** Whether a promise settles within a few turns: a check that would otherwise wait for good fails instead. */
const settlesSoon = async <T,>(made: Promise<T>): Promise<{ value: T } | undefined> => {
  let settled: { value: T } | undefined
  void made.then((value) => { settled = { value } })
  for (let turns = 0; turns < 50 && !settled; turns++) await new Promise<void>((resolve) => { setImmediate(resolve) })
  return settled
}
/** Views that say they have caught up, and do what is given when stopped or asked. */
const viewsDoing = (store: Rows, does: { stop?: () => void; caughtUp?: (then: () => void) => void }): ViewHost => (feature, view, args, heard) => {
  const running = viewsOf(store)(feature, view, args, heard) as Required<Exclude<ReturnType<ViewHost>, () => void>>
  return { stop: () => { running.stop(); does.stop?.() }, caughtUp: (then, soon) => { if (does.caughtUp) does.caughtUp(then); else running.caughtUp(then, soon) } }
}

await run([
  ...(['could not keep a step', 'has taken every step it may'] as const).map((how) => [`a backend that ${how} answers what a window asks after, and it reaches the window`, async () => {
    const store = memory()
    const backend = system({ side: 'backend', transact: store.transact, views: viewsOf(store), trace: () => {}, ...(how === 'has taken every step it may' ? { limit: 6 } : {}) })
    backend.start('threads', threads(store))
    const window = system({ side: 'window', trace: () => {} })
    connect(window, backend)
    const handle = window.start('panel', panel)
    await rest()
    if (how === 'could not keep a step') {
      store.failNext('the disk is full')
      await settlesSoon(window.ask(handle, 'ADD', { id: 'lost' }))
    } else {
      for (let made = 0; made < 6; made++) await settlesSoon(window.ask(handle, 'ADD', { id: `made ${made}` }))
    }
    // Asked now, it is turned away: the window is told so, and is not left waiting.
    const told = await settlesSoon(window.ask(handle, 'ADD', { id: 'after' }))
    ok(told !== undefined, 'the window was never answered')
    ok(told.value.ok && told.value.value === false)
  }] as [string, () => Promise<void>]),
  ['a view that throws when asked whether it has caught up is ended, not waited on, and is reported', async () => {
    const store = memory()
    const traced: string[] = []
    const backend = system({ side: 'backend', transact: store.transact, views: viewsDoing(store, { caughtUp: () => { throw new Error('it cannot say') } }), trace: (line) => { traced.push(line) } })
    backend.start('threads', threads(store))
    const window = system({ side: 'window' })
    connect(window, backend)
    const handle = window.start('panel', panel)
    await rest()
    const told = await settlesSoon(window.ask(handle, 'ADD', { id: 'a' }))
    ok(told?.value.ok && told.value.value === true, 'the answer waited on a view that threw')
    ok(traced.some((line) => line.startsWith('DEFECT') && line.includes('it cannot say')), JSON.stringify(traced))
    await rest()
  }],
  ['a view that throws when stopped still lets go of what waited on it, and is reported', async () => {
    const store = memory()
    // The first view never says it has caught up, and throws when stopped; the second catches up normally.
    let made = 0
    const traced: string[] = []
    const backend = system({ side: 'backend', transact: store.transact, trace: (line) => { traced.push(line) }, views: (feature, view, args, heard) => {
      const first = made++ === 0
      return viewsDoing(store, first ? { caughtUp: () => {}, stop: () => { throw new Error('it would not stop') } } : {})(feature, view, args, heard)
    } })
    backend.start('threads', threads(store))
    const window = system({ side: 'window' })
    connect(window, backend)
    const watcher = window.start('watcher', state<{ data: { ids: string[] } }, { type: 'DROP' }>()({
      data: { ids: ['stuck'] },
      on: { DROP: () => ({ data: { ids: [] } }) },
      follows: (follow) => ({
        item: follow('threads', 'count', { each: 'ids', args: () => ({}), updated: () => undefined }),
      }),
    }))
    const handle = window.start('panel', panel)
    await rest()
    const asked = window.ask(handle, 'ADD', { id: 'a' })
    for (let turns = 0; turns < 20; turns++) await new Promise<void>((resolve) => { setImmediate(resolve) })
    window.send(watcher, { type: 'DROP' })
    const told = await settlesSoon(asked)
    ok(told?.value.ok, 'what waited on the view that threw was never let go')
    ok(traced.some((line) => line.startsWith('DEFECT: stopping a view threw') && line.includes('it would not stop')), JSON.stringify(traced))
  }],
  ['a window that stops following and closes in one turn stops what it followed on the backend', async () => {
    const store = memory()
    let stopped = 0
    const backend = system({ side: 'backend', transact: store.transact, views: viewsDoing(store, { stop: () => { stopped++ } }) })
    backend.start('threads', threads(store))
    const window = system({ side: 'window' })
    const link = connect(window, backend)
    window.start('panel', panel)
    await rest()
    window.stop()
    link.close()
    await rest()
    strictEqual(stopped, 1)
  }],
  ['the views are asked whether they have caught up for a step that sends a window something, and never for one that sends nothing', async () => {
    const store = memory()
    // What each asking says: soon for an answer, and not for a broadcast alone.
    const asked: boolean[] = []
    const views: ViewHost = (feature, view, args, heard) => {
      const running = viewsOf(store)(feature, view, args, heard) as Required<Exclude<ReturnType<ViewHost>, () => void>>
      return { stop: () => running.stop(), caughtUp: (then, soon) => { asked.push(soon); running.caughtUp(then, soon) } }
    }
    const backend = system({ side: 'backend', transact: store.transact, views })
    backend.start('threads', threads(store))
    const maker = backend.start('maker', state<{}, { type: 'MAKE'; id: string }>()({ on: { MAKE: ({ id }) => { store.put('thread', id, { topic: 'made' }) } } }))
    const window = system({ side: 'window' })
    connect(window, backend)
    const handle = window.start('panel', panel)
    await settledAndRest(store)
    asked.length = 0
    // A thread made on the backend alone: its view changes, and nothing is sent to a window to hold.
    backend.send(maker, { type: 'MAKE', id: 'a' })
    await settledAndRest(store)
    deepStrictEqual(asked, [])
    strictEqual(window.read(handle).data.count, 1)
    // A window asks: its broadcast asks with soon = false, and its answer asks with soon = true.
    ok((await window.ask(handle, 'ADD', { id: 'b' })).ok)
    await settledAndRest(store)
    deepStrictEqual(asked, [false, true])
  }],
  ['views that cannot say they have caught up are not waited on: a window is answered and told', async () => {
    const store = memory()
    const { window, handle, defects } = made(store, false)
    await settledAndRest(store)
    ok((await window.ask(handle, 'ADD', { id: 'a' })).ok)
    await settledAndRest(store)
    deepStrictEqual([window.read(handle).data.atAnswer.length, window.read(handle).data.atEvent.length], [1, 1])
    deepStrictEqual(defects(), [])
  }],
  ...(['a function that stops it', 'a view that can say it has caught up'] as const).map((given) => [`a backend state that follows a view stops it when it ends, given ${given}`, async () => {
    const store = memory()
    let stopped = 0
    const views: ViewHost = (feature, view, args, heard) => {
      const running = viewsOf(store)(feature, view, args, heard) as Required<Exclude<ReturnType<ViewHost>, () => void>>
      const stop = (): void => { stopped++; running.stop() }
      return given === 'a function that stops it' ? stop : { stop, caughtUp: (then, soon) => running.caughtUp(then, soon) }
    }
    const backend = system({ side: 'backend', transact: store.transact, views })
    backend.start('counter', state<{ data: { count: number } }, never>()({
      data: { count: 0 },
      follows: (follow) => ({ count: follow('threads', 'count', { args: () => ({}), updated: (update) => (update.ok ? { data: { count: update.value } } : undefined) }) }),
    }))
    await settledAndRest(store)
    strictEqual(stopped, 0)
    backend.stop()
    await rest()
    strictEqual(stopped, 1)
  }] as const),
  ['in elmdb: a thread made is in the window\'s view by the time the window is answered and by the time it is told', async () => {
    const store = elmdb()
    try {
      const { window, handle, defects } = made(store, true)
      await rest()
      for (const id of ['a', 'b', 'c']) ok((await window.ask(handle, 'ADD', { id })).ok)
      await rest()
      const { count, atAnswer, atEvent } = window.read(handle).data
      strictEqual(count, 3)
      deepStrictEqual({ atAnswer, atEvent }, { atAnswer: [1, 2, 3], atEvent: [1, 2, 3] })
      deepStrictEqual(defects(), [])
    } finally { store.close() }
  }],
  ...([['in memory', () => memory()], ['in elmdb', elmdb]] as const).map(([kept, open]) => [`${kept}: what a state hears from a view is a handler too: one that writes and then throws has written nothing`, async () => {
    const store = open()
    try {
      const traced: string[] = []
      const backend = system({ side: 'backend', transact: store.transact, views: viewsOf(store), trace: (line) => { traced.push(line) } })
      backend.start('threads', threads(store))
      const handle = backend.start('watcher', watcher(store))
      const created = backend.start('creator', state<{}, { type: 'MAKE'; id: string }>()({ on: { MAKE: ({ id }) => { store.put('thread', id, { topic: 'made' }) } } }))
      await settledAndRest(store)
      for (const id of ['a', 'b']) { backend.send(created, { type: 'MAKE', id }); await settledAndRest(store) }
      deepStrictEqual(backend.read(handle).data.heard, [0, 2])
      deepStrictEqual([store.get('import', 'saw-0'), store.get('import', 'saw-1'), store.get('import', 'saw-2')], [{ state: 'seen' }, undefined, { state: 'seen' }])
      ok(traced.some((line) => line.startsWith('DEFECT') && line.includes('hearing broke')))
    } finally { store.close() }
  }] as const),
  ['a window that closes while its answer is held is told it was disconnected, is sent nothing after, and the backend goes on', async () => {
    const store = memory()
    // The views say they have been sent what was kept when this check says so, and not before.
    const waiting: Array<() => void> = []
    const views: ViewHost = (feature, view, args, heard) => {
      const running = viewsOf(store)(feature, view, args, heard)
      return { stop: () => (typeof running === 'function' ? running() : running.stop()), caughtUp: (then) => { waiting.push(then) } }
    }
    const traced: string[] = []
    const trace = (line: string): void => { traced.push(line) }
    const backend = system({ side: 'backend', transact: store.transact, views, trace })
    backend.start('threads', threads(store))
    const closing = system({ side: 'window', name: 'the window that closes', trace })
    const link = connect(closing, backend, undefined, 'the window that closes')
    const closed = closing.start('panel', panel)
    const staying = system({ side: 'window', name: 'the window that stays', trace })
    connect(staying, backend, undefined, 'the window that stays')
    const stayed = staying.start('panel', panel)
    const turn = (): Promise<void> => new Promise<void>((resolve) => { nextTurn(resolve) })
    for (let turns = 0; turns < 6; turns++) await turn()
    const asked = closing.ask(closed, 'ADD', { id: 'a' })
    // Until the thread is kept: its answer and the broadcast are held, with the views not yet said to be sent.
    for (let turns = 0; turns < 20 && store.count('thread') === 0; turns++) await turn()
    strictEqual(store.count('thread'), 1)
    ok(waiting.length > 0, 'nothing was held')
    deepStrictEqual([closing.read(closed).data.atAnswer, staying.read(stayed).data.atEvent], [[], []])
    link.close()
    const outcome = await asked
    ok(outcome.ok && outcome.value === false)
    // Now the views are sent it: what was held goes, to the window that is there and not to the one that is not.
    for (const then of waiting.splice(0)) then()
    for (let turns = 0; turns < 6; turns++) await turn()
    for (const then of waiting.splice(0)) then()
    await rest()
    deepStrictEqual(staying.read(stayed).data.atEvent.length, 1)
    deepStrictEqual(closing.read(closed).data.atEvent, [])
    deepStrictEqual(traced.filter((line) => line.startsWith('DEFECT')), [])
    // And the backend still answers: the window that stayed asks, and is answered.
    const again = staying.ask(stayed, 'ADD', { id: 'b' })
    for (let turns = 0; turns < 20 && waiting.length === 0; turns++) await turn()
    for (const then of waiting.splice(0)) then()
    ok((await again).ok)
    strictEqual(store.count('thread'), 2)
  }],
  ['what each step sends a window waits for its own step\'s views, however the waits overlap', async () => {
    const store = memory()
    const waiting: Array<() => void> = []
    // The one view says it has caught up when this check says so, once for each time it is asked.
    const views: ViewHost = (feature, view, args, heard) => {
      const running = viewsOf(store)(feature, view, args, heard)
      return { stop: () => (typeof running === 'function' ? running() : running.stop()), caughtUp: (then) => { waiting.push(then) } }
    }
    const backend = system({ side: 'backend', transact: store.transact, views })
    const made = backend.start('threads', threads(store))
    const window = system({ side: 'window' })
    connect(window, backend)
    const handle = window.start('panel', panel)
    // Waits are still held, so nothing comes to rest: what crossed is read after a few turns.
    const told = async (): Promise<number> => { for (let turn = 0; turn < 10; turn++) await new Promise((resolve) => { setImmediate(resolve) }); return window.read(handle).data.atEvent.length }
    await rest()
    waiting.length = 0
    await backend.ask(made, 'CREATE', { id: 'a' })
    await backend.ask(made, 'CREATE', { id: 'b' })
    // The first step's views have been sent: what it sent goes, and only that.
    waiting.shift()!()
    strictEqual(await told(), 1)
    await backend.ask(made, 'CREATE', { id: 'c' })
    // The second step's have: its own goes, and not the third's, whose views are still to be sent.
    waiting.shift()!()
    strictEqual(await told(), 2)
    waiting.shift()!()
    strictEqual(await told(), 3)
    for (const then of waiting.splice(0)) then()
  }],
  ['an answer waits for every view the window follows, and not for the first of them to catch up', async () => {
    const store = memory()
    // Two views followed by the same window: the first catches up, then the second.
    const waiting: Array<Array<() => void>> = []
    const views: ViewHost = (feature, view, args, heard) => {
      const running = viewsOf(store)(feature, view, args, heard)
      const mine: Array<() => void> = []
      waiting.push(mine)
      return { stop: () => (typeof running === 'function' ? running() : running.stop()), caughtUp: (then) => { mine.push(then) } }
    }
    const backend = system({ side: 'backend', transact: store.transact, views })
    backend.start('threads', threads(store))
    const window = system({ side: 'window', name: 'the window' })
    connect(window, backend)
    const asking = window.start('panel', panel)
    window.start('second', panel)
    await rest()
    strictEqual(waiting.length, 2)
    let answered = false
    void window.ask(asking, 'ADD', { id: 'a' }).then(() => { answered = true })
    const turn = (): Promise<void> => new Promise<void>((resolve) => { nextTurn(resolve) })
    for (let turns = 0; turns < 50 && waiting.some((mine) => mine.length === 0); turns++) await turn()
    ok(waiting.every((mine) => mine.length > 0), 'each view was asked whether it had caught up')
    for (const then of waiting[0]!.splice(0)) then()
    for (let turns = 0; turns < 10; turns++) await turn()
    strictEqual(answered, false, 'answered when one of the two views had caught up')
    for (const then of waiting[1]!.splice(0)) then()
    await rest()
    strictEqual(answered, true)
  }],
  ['a view stopped while it is waited on does not hold what waits, though whatever runs it never says it caught up', async () => {
    const store = memory()
    // The first view never says it has caught up; the second says so when this check does.
    const waiting: Array<() => void> = []
    let made = 0
    const views: ViewHost = (feature, view, args, heard) => {
      const running = viewsOf(store)(feature, view, args, heard)
      const silent = made++ === 0
      return { stop: () => (typeof running === 'function' ? running() : running.stop()), caughtUp: (then) => { if (!silent) waiting.push(then) } }
    }
    const backend = system({ side: 'backend', transact: store.transact, views })
    backend.start('threads', threads(store))
    const window = system({ side: 'window' })
    connect(window, backend)
    const watcher = window.start('watcher', state<{ data: { ids: string[] } }, { type: 'DROP' }>()({
      data: { ids: ['silent'] },
      on: { DROP: () => ({ data: { ids: [] } }) },
      follows: (follow) => ({
        item: follow('threads', 'count', { each: 'ids', args: () => ({}), updated: () => undefined }),
      }),
    }))
    const handle = window.start('panel', panel)
    await rest()
    const asked = window.ask(handle, 'ADD', { id: 'a' })
    const turn = (): Promise<void> => new Promise<void>((resolve) => { nextTurn(resolve) })
    for (let turns = 0; turns < 50 && waiting.length === 0; turns++) await turn()
    for (const then of waiting.splice(0)) then()
    // The answer still waits on the first view. The window stops following it.
    window.send(watcher, { type: 'DROP' })
    // Nothing is left waiting: a link still holding the answer would not come to rest, and that fails.
    await rest()
    ok((await asked).ok)
  }],
  ['a window that closes right after asking is told it disconnected, and neither side is left waiting', async () => {
    const store = memory()
    const { backend, window, handle, link } = made(store, true)
    await rest()
    const asked = window.ask(handle, 'ADD', { id: 'a' })
    // Graceful link close flushes what was already sent before closing, while telling the window its ask disconnected.
    link.close()
    const outcome = await asked
    ok(outcome.ok && outcome.value === false)
    await rest()
    strictEqual(store.count('thread'), 1)
    // Asking after the link closed fails at once without touching the backend.
    const after = await window.ask(handle, 'ADD', { id: 'b' })
    ok(after.ok && after.value === false)
    await rest()
    strictEqual(store.count('thread'), 1)
    ok(backend.idle() && window.idle())
  }],
], async (tally) => {
  // The `one after the other` and `both at once` link-hold orderings (with and without the hold) live in
  // `checks/link-check.mts` so they run in both Node and Chromium.
  await tally.every('a window that stops while what it follows comes and goes stops following, under every ordering', () => sample((schedule) => {
    const store = memory((go) => schedule.later({ label: 'the views are told' }, go))
    const { window, handle, defects } = made(store, true, schedule)
    schedule.does('the user', ['asks for a', () => { void window.ask(handle, 'ADD', { id: 'a' }) }], ['closes the window', () => { window.stop() }])
    return () => { deepStrictEqual(defects(), []) }
  }, { seed: 1, runs: 5_000 }), 'sampled')
})
