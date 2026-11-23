// A backend and its window joined by `@apackdev/link` in place of the kernel's link in memory: what the kernel
// promises a window it still keeps when what it says crosses a link of frames, numbered and taken in turn. The two
// ports are put on the link here, in the check; the kernel is unchanged, and putting it on a link is the plan's next
// step. Each way the link goes is a lane of the schedule, so every ordering is of the two packages together.
//
//   npx vitest run link
import { deepStrictEqual, ok, strictEqual } from 'node:assert'
import { join, link, memoryPair, type Port as LinkPort } from '@apackdev/link'
import { rest, run, system } from './checks.mts'
import { explore, sample, type Schedule } from '../src/schedule.ts'
import { answered, reaching, type AnyEvent, type System, type ViewHost, type ViewUpdate } from '../src/index.ts'
import type { AnyOutcome } from '../src/types.ts'
import { nextTurn } from '../src/turn.ts'
import { PORT, type Port } from '../src/port.ts'
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

/** A kernel's port as a link's: what crosses is told, asked and followed on the kernel's side as it arrives. */
const onLink = (port: Port): LinkPort => ({
  tell: (to, event) => port.event(to, event as AnyEvent),
  ask: (to, name, args, heard, ended) => port.ask(to, name, args as object, heard, ended),
  follow: (feature, view, args, shown) => {
    // The kernel holds what it sends a window for its views itself, so a view it runs offers the link nothing to wait on.
    const stop = port.view(feature, view, args as object, shown)
    return { stop }
  },
})
/** A link's port as a kernel's: what the kernel says goes out as frames. A view's ending is a result that is not one. */
const onKernel = (port: LinkPort): Port => ({
  event: (ref, event) => port.tell(ref, event),
  ask: (ref, name, args, heard, settle) => port.ask(ref, name, args, heard, (outcome) => settle(outcome as AnyOutcome)),
  view: (feature, view, args, heard) => {
    const following = port.follow(feature, view, args, (update) => heard(update as ViewUpdate<unknown>), (failure) => heard({ ok: false, error: failure.message }))
    return () => following.stop()
  },
})

/**
 * The lanes a kernel puts what it says to the other system in, and what it hears from it, stand for a link in
 * memory: a real one carries in their place. The window's are named for it; the backend's are the ones handed it
 * here. They run at once, so that across a link nothing has a lane of the kernel's on top of the link's, which
 * would be a second way for things to cross. Everything else goes as it would.
 */
const WINDOW = 'the window'
const kernelLanes = new Set([`${WINDOW} to its backend`, `the backend to ${WINDOW}`, 'to the backend, as it arrives', 'to the window, as it leaves'])
const putOff = (later?: Schedule['later']) => (lane: { readonly label: string }, go: () => void): void => {
  if (kernelLanes.has(lane.label)) go()
  else if (later) later(lane, go)
  else nextTurn(go)
}

/**
 * A window connected to a backend across a link. With a schedule, each way is a lane of it: what the link carries one
 * way keeps its order, and when it arrives, against everything else, is the schedule's to choose.
 */
const across = (window: System, backend: System, later?: Schedule['later']) => {
  const up = { label: 'the link, window to backend' }
  const down = { label: 'the link, backend to window' }
  const [windowSide, backendSide] = later ? memoryPair((go) => later(up, go), (go) => later(down, go)) : memoryPair()
  // A batch leaves at the end of the turn it was said in, as the link's own specs hold it to under every order:
  // which arrives when is what is left to the schedule here.
  const windowEnd = link(windowSide)
  const backendEnd = link(backendSide)
  const ofBackend = backend as unknown as { [PORT]: Port; attach(window: { link: { open: boolean; up: { label: string }; down: { label: string } }; port: Port }): () => void }
  const ofWindow = window as unknown as { [PORT]: Port }
  // The backend sees the window as a port that sends frames, and the window the backend so.
  const toWindow = join(backendEnd, onLink(ofBackend[PORT]))
  const toTheWindow = { open: true, up: { label: 'to the backend, as it arrives' }, down: { label: 'to the window, as it leaves' } }
  const detach = ofBackend.attach({ link: toTheWindow, port: onKernel(toWindow) })
  // When its end of the link has ended, the backend sends that window nothing more, as when a window closes.
  backendEnd.onEnd(() => { toTheWindow.open = false; detach() })
  const toBackend = join(windowEnd, onLink(ofWindow[PORT]))
  // The window closing its connection closes its end of the link.
  const connected = window.connect({ [PORT]: onKernel(toBackend), attach: () => () => { windowEnd.close() } } as unknown as System)
  return { windowEnd, backendEnd, connected }
}

const made = (store: Rows, held: boolean, later?: Schedule['later']) => {
  const traced: string[] = []
  const trace = (line: string): void => { traced.push(line) }
  const backend = system({ side: 'backend', transact: store.transact, views: viewsOf(store, held), trace, later: putOff(later) })
  backend.start('threads', threads(store))
  const window = system({ side: 'window', name: WINDOW, trace, later: putOff(later) })
  const joined = across(window, backend, later)
  const handle = window.start('panel', panel)
  return { backend, window, handle, ...joined, defects: () => traced.filter((line) => line.startsWith('DEFECT')) }
}

/**
 * Two threads asked for, the second once the first is answered or both at once: what the window noted at each answer
 * and each telling. The views are told in a lane of their own, so when they are, against what crosses the link, is
 * the schedule's to choose.
 */
const scenario = (held: boolean, how: 'one after the other' | 'both at once') => (schedule: Schedule) => {
  const views = { label: 'the views are told' }
  const store = memory((go) => schedule.later(views, go))
  const { window, handle, defects } = made(store, held, schedule.later)
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
    const backend = system({ side: 'backend', transact: store.transact, views, trace, later: putOff() })
    backend.start('threads', threads(store))
    const window = system({ side: 'window', name: WINDOW, trace, later: putOff() })
    const { windowEnd } = across(window, backend)
    window.start('panel', panel)
    const asking = window.start('asker', asker)
    await rest()
    const asked = window.ask(asking, 'MAKE', { id: 'a' })
    for (let turns = 0; turns < 50 && store.count('thread') === 0; turns++) await new Promise<void>((resolve) => { nextTurn(resolve) })
    strictEqual(store.count('thread'), 1)
    ok(waiting.length > 0, 'nothing was held')
    windowEnd.close()
    // The ask of the backend ended disconnected, and the window's state was told so.
    deepStrictEqual(await soon(asked), { ok: true, value: 'disconnected' })
    // Asked again with the link gone, it is told at once, and nothing breaks.
    deepStrictEqual(await soon(window.ask(asking, 'MAKE', { id: 'b' })), { ok: true, value: 'disconnected' })
    for (const then of waiting.splice(0)) then()
    await rest()
    // The backend goes on: another window, on a link of its own, asks and is answered.
    const another = system({ side: 'window', name: WINDOW, trace, later: putOff() })
    across(another, backend)
    const again = another.start('asker', asker)
    await rest()
    const answered = another.ask(again, 'MAKE', { id: 'c' })
    for (let turns = 0; turns < 50 && waiting.length === 0; turns++) await new Promise<void>((resolve) => { nextTurn(resolve) })
    for (const then of waiting.splice(0)) then()
    deepStrictEqual(await soon(answered), { ok: true, value: 'made' })
    await rest()
    strictEqual(store.count('thread'), 2)
    deepStrictEqual(traced.filter((line) => line.startsWith('DEFECT')), [])
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
