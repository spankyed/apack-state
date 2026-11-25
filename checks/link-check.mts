// A backend and its window joined by `@apackdev/link` directly on their ports, with no adapter and one hold owned by
// the link: what the kernel promises a window it keeps when what it says crosses a link of frames, numbered and taken
// in turn. Each way the link goes is a lane of the schedule, so every ordering is of the two packages together.
//
//   npx vitest run link
import { deepStrictEqual, ok, strictEqual, throws } from 'node:assert'
import { connect, rest, run, system } from './checks.mts'
import { explore, sample, type Schedule } from '@apackdev/orderings'
import { answered, reaching, type Each, type Failure, type Port, type StepLog, type ViewHost } from '../src/index.ts'
import { nextTurn } from '../src/turn.ts'
import { memory, type Rows } from './store.mts'

type ThreadAsks = { CREATE: { args: { id: string }; answer: { id: string } } }
type PanelEvents = { type: 'CREATED'; id: string }
type PanelAsks = { ADD: { args: { id: string }; answer: boolean } }
type App = {
  systems: { threads: { events: never; asks: ThreadAsks } }
  surfaces: { panel: { events: PanelEvents } }
  views: { threads: { count: { args: {}; result: number } } }
}
const state = reaching<App>()

/** The backend: a thread is a row, and making one is told to every window as well as answered. */
const threads = (store: Rows) => state<{}, never, ThreadAsks>()({
  asks: {
    CREATE: ({ id }, { broadcast }) => {
      store.put('thread', id, { topic: 'made' })
      broadcast('panel', { type: 'CREATED', id })
      return { id }
    },
  },
})

type Panel = { data: { count: number; atAnswer: number[]; atEvent: number[] } }
/** A window's surface: it follows how many threads there are, and notes that number at each answer and each telling. */
const panel = state<Panel, PanelEvents, PanelAsks>()({
  data: { count: 0, atAnswer: [], atEvent: [] },
  follows: (follow) => ({
    count: follow('threads', 'count', { args: () => ({}), heard: (update) => (update.ok ? { data: { count: update.value } } : undefined) }),
  }),
  on: {
    CREATED: (_, { data }) => ({ data: { atEvent: [...data.atEvent, data.count] } }),
  },
  asks: {
    ADD: async ({ id }, { ask }) => {
      const outcome = await ask('threads', 'CREATE', { id })
      return answered(outcome.ok, { data: (draft) => { draft.atAnswer.push(draft.count) } })
    },
  },
})

/** What a promise settles to within a few turns, or that it did not: a case that would wait for good fails instead. */
const soon = async <T,>(made: Promise<T>): Promise<T | 'never settled'> => {
  let settled: { value: T } | undefined
  void made.then((value) => { settled = { value } })
  for (let turns = 0; turns < 50 && !settled; turns++) await new Promise<void>((resolve) => { nextTurn(resolve) })
  return settled ? settled.value : 'never settled'
}

/** A window's state that says how its ask of the backend ended: what was made, or the kind of failure. */
const asker = state<{}, never, { MAKE: { args: { id: string }; answer: string } }>()({
  asks: { MAKE: async ({ id }, { ask }) => { const outcome = await ask('threads', 'CREATE', { id }); return outcome.ok ? 'made' : outcome.failure.kind } },
})

/** The views a backend runs over its rows, which say when they have caught up; or, taken away, which cannot. */
const viewsOf = (store: Rows, held: boolean): ViewHost => (_feature, _view, _args, heard) => {
  const running = store.watch(() => store.count('thread'), (value) => heard({ ok: true, value }))
  return held ? running : { stop: () => running.stop() }
}

const WINDOW = 'the window'

const made = (store: Rows, held: boolean, schedule?: Schedule) => {
  const traced: string[] = []
  const trace = (line: string): void => { traced.push(line) }
  const backend = system({ side: 'backend', transact: store.transact, views: viewsOf(store, held), trace, ...(schedule ? { later: schedule.later } : {}) })
  backend.start('threads', threads(store))
  const window = system({ side: 'window', name: WINDOW, trace, ...(schedule ? { later: schedule.later } : {}) })
  const joined = connect(window, backend, schedule, WINDOW)
  const handle = window.start('panel', panel)
  return { backend, window, handle, joined, defects: () => traced.filter((line) => line.startsWith('DEFECT')) }
}

/**
 * Two threads asked for, the second once the first is answered or both at once: what the window noted at each answer
 * and each telling. The views are told in a lane of their own, so when they are, against what crosses the link, is
 * the schedule's to choose.
 */
const scenario = (held: boolean, how: 'one after the other' | 'both at once') => (schedule: Schedule) => {
  const views = { label: 'the views are told' }
  const store = memory((go) => schedule.later(views, go))
  const { window, handle, defects } = made(store, held, schedule)
  const answers: boolean[] = []
  const add = (id: string, then?: () => void) => (): void => { void window.ask(handle, 'ADD', { id }).then((outcome) => { answers.push(outcome.ok && outcome.value); then?.() }) }
  if (how === 'both at once') schedule.does('the user', ['asks for a', add('a')], ['asks for b', add('b')])
  else schedule.does('the user', ['asks for a, and then for b', add('a', add('b'))])
  return () => {
    deepStrictEqual(answers, [true, true])
    const { count, atAnswer, atEvent } = window.read(handle).data
    strictEqual(count, 2)
    // Each thread is in the view by the time the window hears of it: with both under way the view may already show
    // the second when the window hears of the first, which is ahead and never behind.
    for (const noted of [atAnswer, atEvent]) ok(noted.length === 2 && noted[0]! >= 1 && noted[1] === 2, `noted ${JSON.stringify({ atAnswer, atEvent })}`)
    deepStrictEqual(defects(), [])
  }
}

await run([
  ['across a link, a window asks, is answered, and is told, with the view showing each thread first', async () => {
    const store = memory()
    const { window, handle, defects } = made(store, true)
    await rest()
    for (const id of ['a', 'b', 'c']) ok((await window.ask(handle, 'ADD', { id })).ok)
    await rest()
    const { count, atAnswer, atEvent } = window.read(handle).data
    strictEqual(count, 3)
    deepStrictEqual({ atAnswer, atEvent }, { atAnswer: [1, 2, 3], atEvent: [1, 2, 3] })
    deepStrictEqual(defects(), [])
  }],
  ['a link that goes while an ask is held ends the ask as disconnected, and the backend goes on for another window', async () => {
    const store = memory()
    // The views say they have caught up when this check says so, and not before: the answer is held until then.
    const waiting: Array<() => void> = []
    const views: ViewHost = (feature, view, args, heard) => {
      const running = viewsOf(store, true)(feature, view, args, heard)
      return { stop: () => (typeof running === 'function' ? running() : running.stop()), caughtUp: (then) => { waiting.push(then) } }
    }
    const traced: string[] = []
    const trace = (line: string): void => { traced.push(line) }
    const backend = system({ side: 'backend', transact: store.transact, views, trace })
    backend.start('threads', threads(store))
    const window = system({ side: 'window', name: WINDOW, trace })
    const joined = connect(window, backend)
    window.start('panel', panel)
    const asking = window.start('asker', asker)
    await rest()
    const asked = window.ask(asking, 'MAKE', { id: 'a' })
    for (let turns = 0; turns < 50 && store.count('thread') === 0; turns++) await new Promise<void>((resolve) => { nextTurn(resolve) })
    strictEqual(store.count('thread'), 1)
    ok(waiting.length > 0, 'nothing was held')
    joined.close()
    // The ask of the backend ended disconnected, and the window's state was told so.
    deepStrictEqual(await soon(asked), { ok: true, value: 'disconnected' })
    // Asked again with the link gone, it is told at once, and nothing breaks.
    deepStrictEqual(await soon(window.ask(asking, 'MAKE', { id: 'b' })), { ok: true, value: 'disconnected' })
    for (const then of waiting.splice(0)) then()
    await rest()
    // The backend goes on: another window, on a link of its own, asks and is answered.
    const another = system({ side: 'window', name: WINDOW, trace })
    connect(another, backend)
    const again = another.start('asker', asker)
    await rest()
    const answered = another.ask(again, 'MAKE', { id: 'c' })
    for (let turns = 0; turns < 50 && store.count('thread') < 2; turns++) await new Promise<void>((resolve) => { nextTurn(resolve) })
    for (const then of waiting.splice(0)) then()
    deepStrictEqual(await soon(answered), { ok: true, value: 'made' })
    await rest()
    strictEqual(store.count('thread'), 2)
    deepStrictEqual(traced.filter((line) => line.startsWith('DEFECT')), [])
  }],
  ['attach enforces one backend per window, detaches cleanly on both sides, and follow on a system without views ends unavailable', async () => {
    const store = memory()
    const backend = system({ side: 'backend', transact: store.transact })
    const threadsHandle = backend.start('threads', threads(store))
    const told: unknown[] = []
    const stub = (): Port => ({
      tell: (_to, event) => { told.push(event) },
      ask: (_to, _name, _args, _heard, ended) => { ended({ ok: true, value: { id: 'stub' } }); return () => {} },
      follow: () => ({ stop: () => {} }),
    })
    const detachWindow = backend.attach(stub())
    await backend.ask(threadsHandle, 'CREATE', { id: 'one' })
    strictEqual(told.length, 1)
    detachWindow()
    await backend.ask(threadsHandle, 'CREATE', { id: 'two' })
    strictEqual(told.length, 1)

    const window = system({ side: 'window', name: WINDOW })
    const first = stub()
    const second = stub()
    const detachFirst = window.attach(first)
    throws(() => window.attach(second), /the window is already attached to a backend/)
    detachFirst()
    const detachSecond = window.attach(second)
    // Detaching the first again leaves the second attached.
    detachFirst()
    const asking = window.start('asker', asker)
    deepStrictEqual(await soon(window.ask(asking, 'MAKE', { id: 'x' })), { ok: true, value: 'made' })
    detachSecond()
    deepStrictEqual(await soon(window.ask(asking, 'MAKE', { id: 'y' })), { ok: true, value: 'disconnected' })

    // Following a view on a backend with no views reports `unavailable` via `over` and returns a callable `stop`.
    const overs: Failure[] = []
    const following = backend.port.follow('threads', 'count', {}, () => {}, (failure) => { overs.push(failure) })
    following.stop()
    strictEqual(overs.length, 1)
    strictEqual(overs[0]!.kind, 'unavailable')
    ok(overs[0]!.message.includes('runs no views'))

    // `connect` closes the link it opened if `window.attach` refuses a second backend.
    const other = system({ side: 'backend', transact: store.transact })
    const joined = connect(window, backend)
    const queued: Array<() => void> = []
    throws(() => connect(window, other, { later: (_lane, run) => { queued.push(run) } }), /the window is already attached to a backend/)
    strictEqual(queued.length, 2, 'expected hello and close to be queued on the aborted link')
    while (queued.length) queued.shift()!()
    // `connect` also detaches the first side and closes the link if `backend.attach` throws.
    const fresh = system({ side: 'window', name: 'fresh window' })
    const secondQueued: Array<() => void> = []
    throws(() => connect(fresh, window, { later: (_lane, run) => { secondQueued.push(run) } }), /the window is already attached to a backend/)
    strictEqual(secondQueued.length, 2, 'expected hello and close to be queued when backend.attach throws')
    while (secondQueued.length) secondQueued.shift()!()
    const recovered = connect(fresh, backend)
    recovered.close()
    joined.close()
  }],
  ['a remote ask whose asker leaves in the same step is never sent, and a completed ask does not call leave on stop', async () => {
    let asked = 0
    let left = 0
    const spy: Port = {
      tell: () => {},
      ask: (_to, _name, _args, _heard, ended) => {
        asked++
        ended({ ok: true, value: { id: 'ok' } })
        return () => { left++ }
      },
      follow: () => ({ stop: () => {} }),
    }
    const window = system({ side: 'window', name: WINDOW })
    window.attach(spy)
    const sameStep = state<{ states: { active: { makes: { create: 'one' } }; done: {} } }, { type: 'GO' } | { type: 'LEAVE' }>()({
      start: 'active',
      states: {
        active: {
          makes: (make) => ({ create: make.one('threads', 'CREATE', { args: () => ({ id: 'a' }), ended: () => undefined }) }),
          on: {
            GO: (_, { make, send }) => { make('create'); send({ type: 'LEAVE' }) },
            LEAVE: () => ({ at: 'done' }),
          },
        },
        done: {},
      },
    })
    const handle = window.start('same', sameStep)
    window.send(handle, { type: 'GO' })
    await rest()
    strictEqual(window.read(handle).at, 'done')
    strictEqual(asked, 0)

    const asking = window.start('asker', asker)
    deepStrictEqual(await soon(window.ask(asking, 'MAKE', { id: 'x' })), { ok: true, value: 'made' })
    strictEqual(asked, 1)
    window.stop()
    await rest()
    strictEqual(left, 0)

    // An async completed remote ask also removes its abort listener so stopping the window does not call `leave`.
    let asyncLeft = 0
    const asyncWindow = system({ side: 'window', name: WINDOW })
    asyncWindow.attach({
      tell: () => {},
      ask: (_to, _name, _args, _heard, ended) => {
        nextTurn(() => ended({ ok: true, value: { id: 'async' } }))
        return () => { asyncLeft++ }
      },
      follow: () => ({ stop: () => {} }),
    })
    const asyncAsker = asyncWindow.start('asker', asker)
    deepStrictEqual(await soon(asyncWindow.ask(asyncAsker, 'MAKE', { id: 'y' })), { ok: true, value: 'made' })
    asyncWindow.stop()
    await rest()
    strictEqual(asyncLeft, 0)

    // A custom `peer.ask` that throws synchronously settles the ask as `failed`, logs a DEFECT, and leaves the system idle.
    const traced: string[] = []
    const broken = system({ side: 'window', name: WINDOW, trace: (line) => { traced.push(line) } })
    broken.attach({
      tell: () => {},
      ask: () => { throw new Error('ask broke') },
      follow: () => ({ stop: () => {} }),
    })
    const failing = broken.start('asker', asker)
    deepStrictEqual(await soon(broken.ask(failing, 'MAKE', { id: 'z' })), { ok: true, value: 'failed' })
    await rest()
    ok(broken.idle())
    strictEqual(traced.filter((line) => line.startsWith('DEFECT') && line.includes('ask broke')).length, 1)
    broken.stop()
    await rest()

    // A custom `peer.ask` that settles synchronously and then throws keeps its first answer without enqueueing a second.
    const doubleTraced: string[] = []
    const doubleSteps: StepLog[] = []
    const doubleBroken = system({ side: 'window', name: WINDOW, trace: (line) => { doubleTraced.push(line) }, log: (step) => { doubleSteps.push(step) } })
    doubleBroken.attach({
      tell: () => {},
      ask: (_to, _name, _args, _heard, ended) => {
        ended({ ok: true, value: { id: 'sync' } })
        throw new Error('ask broke after answering')
      },
      follow: () => ({ stop: () => {} }),
    })
    const doubleAsker = doubleBroken.start('asker', asker)
    deepStrictEqual(await soon(doubleBroken.ask(doubleAsker, 'MAKE', { id: 'w' })), { ok: true, value: 'made' })
    await rest()
    ok(doubleBroken.idle())
    strictEqual(doubleTraced.filter((line) => line.startsWith('DEFECT') && line.includes('ask broke after answering')).length, 1)
    strictEqual(doubleSteps.flatMap((step) => step.handled).filter((item) => item.kind === 'answer' && item.ref === 'threads' && item.name === 'CREATE').length, 1)
    doubleBroken.stop()
    await rest()
  }],
  ['a remote follow stopped before commit is never sent, and stopping after a throwing follow causes no defect', async () => {
    let followed = 0
    let stopped = 0
    const traced: string[] = []
    const spy: Port = {
      tell: () => {},
      ask: () => () => {},
      follow: () => { followed++; return { stop: () => { stopped++ } } },
    }
    const window = system({ side: 'window', name: WINDOW, trace: (line) => { traced.push(line) } })
    window.attach(spy)
    const child = state<{ states: { watching: {}; gone: {} } }, { type: 'CLOSE' }>()({
      start: 'watching',
      states: {
        watching: {
          follows: (follow) => ({ count: follow('threads', 'count', { args: () => ({}), heard: () => undefined }) }),
          on: { CLOSE: () => ({ at: 'gone' }) },
        },
        gone: {},
      },
    })
    const parent = state<{ data: { kids: string[] }; starts: { child: Each<typeof child> } }, { type: 'FLASH' }>()({
      data: { kids: [] },
      starts: (start) => ({ child: start(child, { each: 'kids', given: () => ({}) }) }),
      on: { FLASH: (_, { child: of, tell }) => { tell(of('child', 'one'), { type: 'CLOSE' }); return { data: { kids: ['one'] } } } },
    })
    const host = window.start('parent', parent)
    window.send(host, { type: 'FLASH' })
    await rest()
    strictEqual(window.read(window.child(host, 'child', 'one'))?.at, 'gone')
    strictEqual(followed, 0)
    strictEqual(stopped, 0)
    deepStrictEqual(traced.filter((line) => line.startsWith('DEFECT')), [])

    // A `peer.follow` that throws at commit leaves nothing to unfollow when the window stops.
    const brokenTraced: string[] = []
    const broken = system({ side: 'window', name: WINDOW, trace: (line) => { brokenTraced.push(line) } })
    broken.attach({
      tell: () => {},
      ask: () => () => {},
      follow: () => { throw new Error('follow broke') },
    })
    broken.start('panel', panel)
    await rest()
    strictEqual(brokenTraced.filter((line) => line.startsWith('DEFECT')).length, 1)
    broken.stop()
    await rest()
    strictEqual(brokenTraced.filter((line) => line.startsWith('DEFECT')).length, 1)
  }],
  ['attaching a window port after start follows views immediately, and detach/reconnect re-follows cleanly', async () => {
    let follows = 0
    let stops = 0
    const callbacks: Array<{ shown: (value: unknown) => void; over: (failure: Failure) => void }> = []
    const makePort = (): Port => ({
      tell: () => {},
      ask: () => () => {},
      follow: (_f, _v, _a, shown, over) => {
        follows++
        callbacks.push({ shown, over })
        return { stop: () => { stops++ } }
      },
    })
    const window = system({ side: 'window', name: WINDOW })
    // Start BEFORE attaching any port.
    const ph = window.start('panel', panel)
    await rest()
    strictEqual(follows, 0)

    // Attaching now must immediately match and follow panel's view.
    const detach1 = window.attach(makePort())
    await rest()
    strictEqual(follows, 1)
    callbacks.at(-1)!.shown({ ok: true, value: 10 })
    await rest()
    strictEqual(window.read(ph).data.count, 10)

    // Manual detach stops the old follow cleanly.
    detach1()
    strictEqual(stops, 1)

    // Re-attaching a new port follows again cleanly.
    const detach2 = window.attach(makePort())
    await rest()
    strictEqual(follows, 2)
    callbacks.at(-1)!.shown({ ok: true, value: 25 })
    await rest()
    strictEqual(window.read(ph).data.count, 25)

    // Disconnection via `over` clears the follow so a subsequent detach does NOT double-stop, and re-attach re-follows.
    callbacks.at(-1)!.over({ kind: 'disconnected', message: 'gone' })
    await rest()
    detach2()
    strictEqual(stops, 1)
    window.attach(makePort())
    await rest()
    strictEqual(follows, 3)
    window.stop()
  }],
], async (tally) => {
  for (const how of ['one after the other', 'both at once'] as const) {
    // Two systems and a link have more orderings than a check can run each of: a seed's worth of them, as the checks
    // of two windows are. Without the hold, a failing one is found among all of them.
    await tally.every(`${how}: in any ordering of the kernel and the link, a window is answered and told after its view shows the thread`, () => sample(scenario(true, how), { seed: 1, runs: 5_000 }), 'sampled')
    await tally.check(`${how}: without the hold there is an ordering in which it is told first, so the hold is what the rule rests on`, async () => {
      const found = await explore(scenario(false, how))
      ok(found.failure, 'every ordering passed without the hold, so the scenario proves nothing')
    })
  }
})
