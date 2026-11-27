// A step's log: what a system tells whoever gave it `log` of each step once it has ended. What began it and what it
// handled after, what changed, and what left at the commit; never what any of it carried.
//
//   npx vitest run log
import { deepStrictEqual, ok, strictEqual } from 'node:assert'
import { connect, rest, run, system } from './checks.mts'
import { given, forNet, type Defect, type Handled, type Sent, type StepLog, type ViewHost } from '../src/index.ts'
import { memory, type Rows } from './store.mts'
import { nextTurn } from '../src/turn.ts'

const MARK = 'MARKER-5d0c'

type NotesAsks = {
  /** Writes a note, says how far it got, tells every window, and answers with what it wrote. */
  WRITE: { args: { text: string }; progress: string; answer: { text: string }; refuses: { empty: { text: string } } }
}
type PanelEvent = { type: 'NOTED'; text: string } | { type: 'TYPE'; text: string } | { type: 'SEND' } | { type: 'SENT'; text: string }
type App = {
  systems: { notes: { events: never; asks: NotesAsks } }
  surfaces: { panel: { events: PanelEvent } }
  views: {}
}
const state = forNet<App>()

const notes = (store: Rows) => state<{ data: { written: string[] } }, never, NotesAsks>()({
  data: { written: [] },
  answers: {
    WRITE: ({ text }, { progress, broadcast, refuse }) => {
      if (!text) throw refuse('empty', `Nothing to write: ${MARK}`, { text: MARK })
      store.put('thread', text, { topic: text })
      progress(`writing ${text}`)
      broadcast('panel', { type: 'NOTED', text })
      return { text }
    },
  },
})

const panel = state<{ data: { draft: string; seen: string[] }; states: { idle: {}; sending: { data: { text: string } } }; internal: { type: 'SENT'; text: string } }, PanelEvent>()({
  data: { draft: '', seen: [] },
  initial: 'idle',
  on: {
    TYPE: ({ text }) => ({ data: { draft: text } }),
    SEND: (_, { data }) => ({ at: 'sending', data: { text: data.draft } }),
    NOTED: ({ text }, { data }) => ({ data: { seen: [...data.seen, text] } }),
  },
  internal: { SENT: ({ text }) => ({ at: 'idle', data: { draft: '', seen: [text] } }) },
  states: {
    idle: {},
    sending: {
      data: { text: given },
      async run({ data, ask, raise }) {
        const done = await ask('notes', 'WRITE', { text: data.text })
        raise({ type: 'SENT', text: done.ok ? done.value.text : '' })
      },
      failed: () => ({ at: 'idle' }),
    },
  },
})

type WorkAsks = { RUN: { args: { id: string }; progress: string; answer: string } }
type Kinds = {
  systems: { worker: { events: { type: 'PING' }; asks: WorkAsks } }
  surfaces: {}
  views: { threads: { count: { args: {}; result: number } } }
}
const kinds = forNet<Kinds>()

/** Answers a run once its id is let go: `now` at once, anything else when this check says. */
const worker = (letGo: (id: string) => Promise<void>) => kinds<{}, { type: 'PING' }, WorkAsks>()({
  on: { PING: () => {} },
  answers: { RUN: async ({ id }, { progress }) => { progress(`on ${id}`); await letGo(id); return id } },
})
/** Calls a run of the worker for each id it is given, and cancels one. */
const jobs = kinds<{ data: { done: string[] }; states: { on: { calls: { run: 'each' } } } }, { type: 'ADD'; id: string } | { type: 'DROP'; id: string }>()({
  data: { done: [] },
  initial: 'on',
  states: {
    on: {
      calls: ({ each }) => ({
        run: each('worker', 'RUN', {
          args: (id) => ({ id }),
          progress: () => undefined,
          done: (outcome) => (outcome.ok ? { data: (d) => { d.done.push(outcome.value) } } : undefined),
        }),
      }),
      on: { ADD: ({ id }, { call }) => { call('run', id) }, DROP: ({ id }, { cancel }) => { cancel('run', id) } },
    },
  },
})
/** Answers a run while it is open, once its id is let go; closed, it has left what it was answering. */
const shuttable = (letGo: (id: string) => Promise<void>) => kinds<{ states: { open: {}; shut: {} } }, { type: 'CLOSE' }, WorkAsks>()({
  initial: 'open',
  states: {
    open: { answers: { RUN: async ({ id }) => { await letGo(id); return id } }, on: { CLOSE: () => ({ at: 'shut' }) } },
    shut: {},
  },
})
/** Calls one save at a time, of the id it was told. */
const saver = kinds<{ data: { id: string }; states: { on: { calls: { save: 'single' } } } }, { type: 'SAVE'; id: string }>()({
  data: { id: '' },
  initial: 'on',
  states: {
    on: {
      calls: ({ single }) => ({ save: single('worker', 'RUN', { args: (data) => ({ id: data.id }), done: () => undefined }) }),
      on: { SAVE: ({ id }, { call }) => { call('save'); return { data: { id } } } },
    },
  },
})
/** Work that ends, or throws. */
const runs = (breaks: boolean) => kinds<{ states: { busy: {}; idle: {} } }, never>()({
  initial: 'busy',
  states: { busy: { async run() { if (breaks) throw new Error('it broke') }, failed: () => ({ at: 'idle' }) }, idle: {} },
})
/** Work in a state inside another: named by its path. */
const nested = kinds<{ states: { outer: { states: { inner: {}; done: {} } } } }, never>()({
  initial: 'outer',
  states: { outer: { initial: 'inner', states: { inner: { async run() {}, failed: () => ({ at: 'outer.done' }) }, done: {} } } },
})
/** Asks the worker to run something that is never let go. */
const asker = kinds<{ states: { asking: {}; asked: {} } }, never>()({
  initial: 'asking',
  states: { asking: { async run({ ask }) { await ask('worker', 'RUN', { id: 'never' }) }, failed: () => ({ at: 'asked' }) }, asked: {} },
})
/** Sends itself the same event as it handles it, without end. */
const runaway = kinds<{}, { type: 'AGAIN' }>()({ on: { AGAIN: (_, { raise }) => { raise({ type: 'AGAIN' }) } } })
/** Follows how many threads there are. */
const watcher = kinds<{ data: { count: number } }, never>()({
  data: { count: 0 },
  follows: (follow) => ({ count: follow('threads', 'count', { args: () => ({}), updated: (update) => (update.ok ? { data: { count: update.value } } : undefined) }) }),
})
/** Once its work has waited a turn, outside any step, tells the worker something. */
const teller = kinds<{ states: { telling: {}; told: {} } }, never>()({
  initial: 'telling',
  states: { telling: { async run({ tell }) { await Promise.resolve(); tell('worker', { type: 'PING' }) }, failed: () => ({ at: 'told' }) }, told: {} },
})
const countOf = (store: Rows): ViewHost => (_feature, _view, _args, heard) => store.watch(() => store.count('thread'), (value) => heard({ ok: true, value }))
const handledIn = (logs: readonly StepLog[]): Handled[] => logs.flatMap((step) => step.handled)
const sentIn = (logs: readonly StepLog[]): Sent[] => logs.flatMap((step) => step.sent)
/** While an ask is held unanswered nothing comes to rest, so a few turns are let pass instead. */
const turns = async (): Promise<void> => { for (let turn = 0; turn < 20; turn++) await new Promise<void>((resolve) => { nextTurn(resolve) }) }
const has = <T,>(all: readonly T[], one: T): void => { ok(all.some((each) => { try { deepStrictEqual(each, one); return true } catch { return false } }), `${JSON.stringify(one)} is not among ${JSON.stringify(all)}`) }

/** A backend and a window, each logging its steps. */
const wired = (host: { failNext?: string } = {}) => {
  const store = memory()
  if (host.failNext) store.failNext(host.failNext)
  const logs = { backend: [] as StepLog[], window: [] as StepLog[] }
  const backend = system({ side: 'backend', transact: store.transact, log: (step) => { logs.backend.push(step) } })
  backend.start('notes', notes(store))
  const window = system({ side: 'window', log: (step) => { logs.window.push(step) } })
  connect(window, backend)
  const handle = window.start('panel', panel)
  return { backend, window, handle, logs }
}

await run([
  ['each step is logged once it has ended, numbered, with what began it and what it handled after', async () => {
    const { window, handle, logs } = wired()
    window.send(handle, { type: 'TYPE', text: 'hello' })
    await rest()
    const typed = logs.window.at(-1)!
    deepStrictEqual(typed.handled, [{ kind: 'event', ref: 'panel', name: 'TYPE' }])
    strictEqual(typed.status, 'committed')
    deepStrictEqual(logs.window.map((step) => step.number), logs.window.map((_, at) => at + 1))
  }],
  ['what changed is each state\'s fields that did, whether it moved, and where it is', async () => {
    const { window, handle, logs } = wired()
    window.send(handle, { type: 'TYPE', text: 'hello' })
    await rest()
    deepStrictEqual(logs.window.at(-1)!.changed, { panel: { fields: ['draft'], moved: false, pending: false, armed: false, at: 'idle' } })
    window.send(handle, { type: 'SEND' })
    await rest()
    const sent = logs.window.find((step) => step.handled[0]?.name === 'SEND')!
    deepStrictEqual(sent.changed.panel?.moved, true)
    strictEqual(sent.changed.panel?.at, 'sending')
  }],
  ['what left is said: an ask across the link, its progress, a broadcast, and the answer, each to whom and by name', async () => {
    const { window, handle, logs } = wired()
    window.send(handle, { type: 'TYPE', text: 'hello' })
    window.send(handle, { type: 'SEND' })
    await rest()
    const left = (of: StepLog[]) => of.flatMap((step) => step.sent)
    ok(left(logs.window).some((sent) => sent.kind === 'ask' && sent.to === 'notes' && sent.name === 'WRITE'), JSON.stringify(left(logs.window)))
    const answered = logs.backend.find((step) => step.handled[0]?.kind === 'ask')!
    deepStrictEqual(answered.handled[0], { kind: 'ask', ref: 'notes', name: 'WRITE', id: 1, across: 'window' })
    // Taken once, and logged once.
    strictEqual(answered.handled.filter((one) => one.kind === 'ask').length, 1)
    deepStrictEqual(answered.sent.map((sent) => sent.kind).sort(), ['answer', 'broadcast', 'progress'])
    deepStrictEqual(answered.sent.find((sent) => sent.kind === 'answer'), { kind: 'answer', to: 'notes', name: 'WRITE', id: 1, outcome: 'ok' })
    deepStrictEqual(answered.sent.find((sent) => sent.kind === 'progress'), { kind: 'progress', to: 'notes', name: 'WRITE', id: 1 })
    deepStrictEqual(answered.sent.find((sent) => sent.kind === 'broadcast'), { kind: 'broadcast', to: 'panel', name: 'NOTED' })
    // The window's state raised what its work found: an event of its own.
    ok(logs.window.some((step) => step.handled.some((one) => one.kind === 'event' && one.name === 'SENT' && one.own === true)))
  }],
  ['an answer that is a refusal is logged with its kind', async () => {
    const { backend, logs } = wired()
    const asker = system({ side: 'window', log: () => {} })
    connect(asker, backend)
    const empty = asker.start('panel', panel)
    asker.send(empty, { type: 'SEND' })
    await rest()
    ok(logs.backend.flatMap((step) => step.sent).some((sent) => sent.kind === 'answer' && sent.outcome === 'empty'))
  }],
  ['a step whose rows could not be kept is logged as lost', async () => {
    const { window, handle, logs } = wired({ failNext: 'the disk is full' })
    window.send(handle, { type: 'TYPE', text: 'hello' })
    window.send(handle, { type: 'SEND' })
    await rest()
    const lost = logs.backend.find((step) => step.status === 'lost')
    ok(lost, JSON.stringify(logs.backend.map((step) => step.status)))
    // Whoever asked in it was told it failed, and the log says so.
    has(lost.sent, { kind: 'answer', to: 'notes', name: 'WRITE', id: 1, outcome: 'failed' })
  }],
  ['a step whose rows could not be kept logs what its states sent as they ended: an ask one was answering, abandoned', async () => {
    const store = memory()
    const logs: StepLog[] = []
    const backend = system({ side: 'backend', transact: store.transact, log: (step) => { logs.push(step) }, trace: () => {} })
    backend.start('worker', worker(() => new Promise(() => {})))
    const made = backend.start('jobs', jobs)
    const writer = backend.start('writer', kinds<{}, { type: 'WRITE' }>()({ on: { WRITE: () => { store.put('thread', 'w', { topic: 'w' }) } } }))
    backend.send(made, { type: 'ADD', id: 'never' })
    await turns()
    store.failNext('the disk is full')
    backend.send(writer, { type: 'WRITE' })
    await turns()
    const lost = logs.find((step) => step.status === 'lost')
    ok(lost, JSON.stringify(logs.map((step) => step.status)))
    has(lost.sent, { kind: 'abandoned', to: 'worker', name: 'RUN', id: 1 })
  }],
  ['what is sent to a state that is not running is logged once, as it is taken', async () => {
    const logs: StepLog[] = []
    const backend = system({ side: 'backend', log: (step) => { logs.push(step) }, trace: () => {} })
    backend.send({ ref: 'nobody' } as never, { type: 'PING' } as never)
    await rest()
    strictEqual(handledIn(logs).filter((one) => one.ref === 'nobody').length, 1)
  }],
  ['an ask its state left unanswered is logged as abandoned, and not as answered when its work ends after', async () => {
    const logs: StepLog[] = []
    const held = new Map<string, () => void>()
    const letGo = (id: string): Promise<void> => new Promise((resolve) => { held.set(id, resolve) })
    const backend = system({ side: 'backend', log: (step) => { logs.push(step) } })
    const open = backend.start('shuttable', shuttable(letGo))
    const asked = backend.ask(open, 'RUN', { id: 'x' })
    await turns()
    backend.send(open, { type: 'CLOSE' })
    await turns()
    const outcome = await asked
    ok(!outcome.ok && outcome.failure.kind === 'abandoned')
    held.get('x')!()
    await rest()
    has(sentIn(logs), { kind: 'abandoned', to: 'shuttable', name: 'RUN', id: 1 })
    ok(!handledIn(logs).some((one) => one.kind === 'answer'), JSON.stringify(handledIn(logs)))
    ok(!sentIn(logs).some((sent) => sent.kind === 'answer'), JSON.stringify(sentIn(logs)))
  }],
  ['one made of one at a time is logged without a key', async () => {
    const logs: StepLog[] = []
    const backend = system({ side: 'backend', log: (step) => { logs.push(step) } })
    backend.start('worker', worker(() => Promise.resolve()))
    const made = backend.start('saver', saver)
    backend.send(made, { type: 'SAVE', id: 'a' })
    await rest()
    has(handledIn(logs), { kind: 'call', ref: 'saver', name: 'save' })
  }],
  ['nothing any of it carried is in a log', async () => {
    const { window, handle, logs } = wired()
    window.send(handle, { type: 'TYPE', text: MARK })
    window.send(handle, { type: 'SEND' })
    await rest()
    const refusing = system({ side: 'window', log: (step) => { logs.window.push(step) } })
    connect(refusing, wired().backend)
    refusing.send(refusing.start('panel', panel), { type: 'SEND' })
    await rest()
    ok(logs.window.length > 3 && logs.backend.length > 0)
    strictEqual(JSON.stringify(logs).includes(MARK), false)
  }],
  ['what a step handled is each thing by its kind, the state it is for and the name it was declared by, and the key of one of each', async () => {
    const store = memory()
    const logs: StepLog[] = []
    const held = new Map<string, () => void>()
    const letGo = (id: string): Promise<void> => (id === 'now' ? Promise.resolve() : new Promise((resolve) => { held.set(id, resolve) }))
    const backend = system({ side: 'backend', transact: store.transact, views: countOf(store), log: (step) => { logs.push(step) } })
    backend.start('worker', worker(letGo))
    const made = backend.start('jobs', jobs)
    backend.start('ends', runs(false))
    backend.start('breaks', runs(true))
    backend.start('watcher', watcher)
    backend.start('nested', nested)
    await rest()
    has(handledIn(logs), { kind: 'result', ref: 'nested', name: 'outer.inner' })
    backend.send(made, { type: 'ADD', id: 'now' })
    backend.send(made, { type: 'ADD', id: 'later' })
    await turns()
    backend.send(made, { type: 'DROP', id: 'later' })
    await turns()
    const handled = handledIn(logs)
    has(handled, { kind: 'call', ref: 'jobs', name: 'run', key: 'now' })
    has(handled, { kind: 'progress', ref: 'jobs', name: 'run', key: 'now', id: 2 })
    has(handled, { kind: 'answer', ref: 'worker', name: 'RUN', id: 2 })
    has(handled, { kind: 'done', ref: 'jobs', name: 'run', key: 'now', id: 2 })
    has(handled, { kind: 'cancel', ref: 'jobs', name: 'run', key: 'later' })
    has(handled, { kind: 'result', ref: 'ends', name: 'busy' })
    has(handled, { kind: 'failure', ref: 'breaks', name: 'busy' })
    has(handled, { kind: 'view', ref: 'watcher', name: 'count', id: 1 })
    // A state that moved and changed none of its fields says so, and where it is.
    const broke = logs.find((step) => step.handled.some((one) => one.kind === 'failure'))!
    deepStrictEqual(broke.changed.breaks, { fields: [], moved: true, pending: false, armed: false, at: 'idle' })
    for (const resolve of held.values()) resolve()
    await rest()
    // Every run was answered: nothing is abandoned when the system stops.
    // A state that ended is nowhere.
    backend.stop()
    await rest()
    strictEqual(logs.at(-1)!.changed.ends?.at, '')
    ok(!sentIn(logs).some((sent) => sent.kind === 'abandoned'), JSON.stringify(sentIn(logs)))
  }],
  ['what left is said by kind, to whom and by name: a follow and an unfollow, a tell made outside a step, and an ask its state stopped before answering', async () => {
    const store = memory()
    const logs = { backend: [] as StepLog[], window: [] as StepLog[] }
    const backend = system({ side: 'backend', transact: store.transact, views: countOf(store), log: (step) => { logs.backend.push(step) } })
    backend.start('worker', worker(() => new Promise(() => {})))
    const made = backend.start('jobs', jobs)
    const window = system({ side: 'window', log: (step) => { logs.window.push(step) } })
    connect(window, backend)
    window.start('watcher', watcher)
    window.start('teller', teller)
    await rest()
    has(sentIn(logs.window), { kind: 'follow', to: 'threads', name: 'count', id: 1 })
    has(sentIn(logs.window), { kind: 'tell', to: 'worker', name: 'PING' })
    window.stop()
    await rest()
    has(sentIn(logs.window), { kind: 'unfollow', to: 'threads', name: 'count', id: 1 })
    // The worker is asked, and never answers: it stops first.
    backend.send(made, { type: 'ADD', id: 'never' })
    await turns()
    backend.stop()
    await turns()
    has(sentIn(logs.backend), { kind: 'abandoned', to: 'worker', name: 'RUN', id: 1 })
  }],
  ['an ask across the link that the link ends is logged as answered: which ask it was, and that it ended', async () => {
    const store = memory()
    const logs: StepLog[] = []
    const backend = system({ side: 'backend', transact: store.transact })
    backend.start('worker', worker(() => new Promise(() => {})))
    const window = system({ side: 'window', log: (step) => { logs.push(step) } })
    const link = connect(window, backend)
    window.start('asker', asker)
    await turns()
    link.close()
    await turns()
    has(handledIn(logs), { kind: 'answer', ref: 'worker', name: 'RUN', id: 1 })
  }],
  ['a step that runs away is logged as halted', async () => {
    const logs: StepLog[] = []
    const window = system({ side: 'window', log: (step) => { logs.push(step) }, trace: () => {} })
    window.send(window.start('runaway', runaway), { type: 'AGAIN' })
    await turns()
    ok(logs.some((step) => step.status === 'halted'), JSON.stringify(logs.map((step) => step.status)))
  }],
  ['a window that starts and stops following in one turn logs both follow and unfollow and stops the view', async () => {
    const store = memory()
    const logs: StepLog[] = []
    let stopped = 0
    const views: ViewHost = (feature, view, args, heard) => {
      const running = countOf(store)(feature, view, args, heard)
      return () => { stopped++; if (typeof running === 'function') running(); else running.stop() }
    }
    const backend = system({ side: 'backend', transact: store.transact, views })
    const window = system({ side: 'window', log: (step) => { logs.push(step) } })
    connect(window, backend)
    // Started and stopped in one turn: the follow leaves on the link, and the unfollow leaves right behind it.
    window.start('watcher', watcher)
    window.stop()
    await rest()
    has(sentIn(logs), { kind: 'follow', to: 'threads', name: 'count', id: 1 })
    has(sentIn(logs), { kind: 'unfollow', to: 'threads', name: 'count', id: 1 })
    strictEqual(stopped, 1)
  }],
  ['what a view delivers to a state that has stopped by its turn is in no log, and the steps are numbered without a gap', async () => {
    const logs: StepLog[] = []
    let deliver!: (value: number) => void
    const window = system({ side: 'window', views: (_feature, _view, _args, heard) => { deliver = (value) => heard({ ok: true, value }); return () => {} }, log: (step) => { logs.push(step) } })
    const handle = window.start('watcher', watcher)
    // As the step that took the first count ends, the watcher is stopped, and behind that comes another count.
    const stop = window.subscribe(() => { stop(); window.stop(handle); deliver(2) })
    deliver(1)
    deepStrictEqual(logs.map((step) => step.handled), [[], [{ kind: 'view', ref: 'watcher', name: 'count', id: 1 }], []])
    deepStrictEqual(logs.map((step) => step.number), [1, 2, 3])
    strictEqual(window.read(handle), undefined)
    // The next step is the fourth: none was taken that the log did not say.
    window.start('watcher', watcher)
    deepStrictEqual(logs.map((step) => step.number), [1, 2, 3, 4])
  }],
  ['a log that throws is its own to answer for: the system goes on', async () => {
    const traced: string[] = []
    const window = system({ side: 'window', log: () => { throw new Error('the log broke') }, trace: (line) => { traced.push(line) } })
    const handle = window.start('panel', panel)
    window.send(handle, { type: 'TYPE', text: 'one' })
    window.send(handle, { type: 'TYPE', text: 'two' })
    await rest()
    strictEqual(window.read(handle).data.draft, 'two')
    ok(traced.some((line) => line.startsWith('DEFECT: the step log threw')), JSON.stringify(traced))
  }],
  ['causal hooks: Defect.step matches StepLog.number, Handled.ignored marks ignored events, and async ids correlate asks/progress/answers/done/follows', async () => {
    const store = memory()
    const defects: Defect[] = []
    const logs = { backend: [] as StepLog[], window: [] as StepLog[] }
    let releaseLate!: () => void
    const latePromise = new Promise<void>((resolve) => { releaseLate = resolve })

    type Net = {
      systems: { svc: { events: { type: 'THROW' } | { type: 'PING' }; asks: { WORK: { args: { tag: string }; progress: string; answer: string } } } }
      surfaces: {}
      views: { threads: { count: { args: {}; result: number } } }
    }
    const net = forNet<Net>()
    const svc = net<{
      states: { idle: {}; busy: {} }
      internal: { type: 'SECRET' }
    }, { type: 'THROW' } | { type: 'PING' }, Net['systems']['svc']['asks']>()({
      initial: 'idle',
      internal: { SECRET: () => {} },
      on: { THROW: () => { throw new Error('boom-in-step') } },
      states: {
        idle: {},
        busy: { on: { PING: () => {} } },
      },
      answers: {
        WORK: async ({ tag }, { progress }) => {
          progress(`p:${tag}`)
          await Promise.resolve()
          return `done:${tag}`
        },
      },
    })
    const caller = net<{
      data: { count: number; results: string[] }
      calls: { run: { many: { tag: string } } }
    }, { type: 'GO'; tag: string }>()({
      data: { count: 0, results: [] },
      follows: (follow) => ({
        count: follow('threads', 'count', { updated: (u) => (u.ok ? { data: { count: u.value } } : undefined) }),
      }),
      calls: ({ many }) => ({
        run: many('svc', 'WORK', {
          args: ({ tag }) => ({ tag }),
          progress: () => undefined,
          done: (o, { data }) => (o.ok ? { data: { results: [...data.results, o.value] } } : undefined),
        }),
      }),
      on: { GO: ({ tag }, { call }) => { call('run', { tag }) } },
    })
    const lateExit = net<{}, never>()({
      run: async ({ onExit }) => {
        await latePromise
        onExit(() => { throw new Error('outside-step-exit') })
      },
      failed: () => {},
    })

    const backend = system({
      side: 'backend',
      transact: store.transact,
      views: countOf(store),
      onDefect: (d) => defects.push(d),
      log: (step) => logs.backend.push(step),
    })
    const win = system({
      side: 'window',
      onDefect: (d) => defects.push(d),
      log: (step) => logs.window.push(step),
    })
    connect(win, backend)
    const svcH = backend.start('svc', svc)
    const callerH = win.start('caller', caller)
    await rest()

    // Ignored events: wrong substate (PING only in busy), internal-from-outside (SECRET), and non-running state.
    backend.send(svcH, { type: 'PING' })
    backend.send(svcH, { type: 'SECRET' } as never)
    backend.send({ ref: 'ghost' } as never, { type: 'PING' } as never)
    // Handled event throwing inside step carries Defect.step matching StepLog.number.
    backend.send(svcH, { type: 'THROW' })
    // Two concurrent `many` calls get distinct monotonic ids that match across ask, progress, answer, and done.
    win.send(callerH, { type: 'GO', tag: 'a' })
    win.send(callerH, { type: 'GO', tag: 'b' })
    await rest()

    const ignoredEvents = handledIn(logs.backend).filter((h) => h.kind === 'event' && h.ignored === true)
    deepStrictEqual(ignoredEvents.map((h) => `${h.ref}:${h.name}`), ['svc:PING', 'svc:SECRET', 'ghost:PING'])
    const throwStep = logs.backend.find((s) => s.handled.some((h) => h.kind === 'event' && h.name === 'THROW'))!
    strictEqual(throwStep.handled[0]?.ignored, undefined)
    const throwDefect = defects.find((d) => d.message.includes('boom-in-step'))!
    strictEqual(throwDefect.step, throwStep.number)

    // Follow -> view -> unfollow share one id on the window, and unkeyed view/call entries omit `key`.
    const followSent = sentIn(logs.window).find((s) => s.kind === 'follow')!
    ok(typeof followSent.id === 'number' && followSent.id > 0)
    const viewHandled = handledIn(logs.window).find((h) => h.kind === 'view' && h.name === 'count')!
    strictEqual(viewHandled.id, followSent.id)
    strictEqual('key' in viewHandled, false)
    const callHandled = handledIn(logs.window).find((h) => h.kind === 'call' && h.ref === 'caller' && h.name === 'run')!
    strictEqual('key' in callHandled, false)

    // Concurrent `many` asks get strictly increasing positive ids correlated across window sent(ask) -> handled(progress/answer/done).
    const winAsks = sentIn(logs.window).filter((s) => s.kind === 'ask' && s.name === 'WORK')
    strictEqual(winAsks.length, 2)
    ok(typeof winAsks[0]!.id === 'number' && typeof winAsks[1]!.id === 'number')
    ok(winAsks[0]!.id! > 0 && winAsks[1]!.id! > winAsks[0]!.id!)
    for (const askSent of winAsks) {
      ok(handledIn(logs.window).some((h) => h.kind === 'progress' && h.id === askSent.id))
      ok(handledIn(logs.window).some((h) => h.kind === 'answer' && h.id === askSent.id))
      ok(handledIn(logs.window).some((h) => h.kind === 'done' && h.id === askSent.id))
    }

    // Backend ask -> progress -> answer share the same backend-local id.
    const backendAsks = handledIn(logs.backend).filter((h) => h.kind === 'ask' && h.name === 'WORK')
    strictEqual(backendAsks.length, 2)
    for (const askHandled of backendAsks) {
      ok(sentIn(logs.backend).some((s) => s.kind === 'progress' && s.id === askHandled.id))
      ok(sentIn(logs.backend).some((s) => s.kind === 'answer' && s.id === askHandled.id && s.outcome === 'ok'))
    }

    // Same-system load preserves one increasing positive opId across ask, progress, answer, and done.
    const localLoader = net<{ data: { out: string } }, never>()({
      data: { out: '' },
      loads: (load) => ({
        w: load('svc', 'WORK', {
          args: () => ({ tag: 'local' }),
          progress: () => undefined,
          done: (o) => (o.ok ? { data: { out: o.value } } : undefined),
        }),
      }),
    })
    backend.start('localLoader', localLoader)
    await rest()
    const localDone = handledIn(logs.backend).find((h) => h.kind === 'done' && h.ref === 'localLoader' && h.name === 'w')!
    ok(typeof localDone.id === 'number' && localDone.id > 0 && localDone.id > backendAsks.at(-1)!.id!)
    ok(handledIn(logs.backend).some((h) => h.kind === 'ask' && h.ref === 'svc' && h.id === localDone.id))
    ok(handledIn(logs.backend).some((h) => h.kind === 'progress' && h.ref === 'localLoader' && h.id === localDone.id))
    ok(sentIn(logs.backend).some((s) => s.kind === 'answer' && s.to === 'svc' && s.id === localDone.id))

    // A defect thrown during commit flush (subscriber) carries the committed step's number.
    const unsub = backend.subscribe(() => { throw new Error('flush-sub-boom') })
    backend.start('subTrigger', net<{ data: { x: number } }, never>()({ data: { x: 1 } }))
    const flushStep = logs.backend.at(-1)!
    const flushDefect = defects.find((d) => d.message.includes('flush-sub-boom'))!
    strictEqual(flushDefect.step, flushStep.number)
    unsub()

    // Stop unfollows with the exact same follow id; a failed start declaration (!handled throw) clears activeStep
    // immediately so an outside-step defect right after it has no `step` field.
    win.start('late', lateExit)
    win.stop()
    const unfollowSent = sentIn(logs.window).find((s) => s.kind === 'unfollow')!
    strictEqual(unfollowSent.id, followSent.id)
    let threwStart = false
    try { win.start('badDecl', { def: { starts: () => { throw new Error('bad-decl') } } } as never) } catch { threwStart = true }
    strictEqual(threwStart, true)
    releaseLate()
    await rest()
    const lateDefect = defects.find((d) => d.message.includes('outside-step-exit'))!
    strictEqual('step' in lateDefect, false)
    backend.stop()
  }],
  ['what came across a port says so, and what was sent or asked here, or raised, does not', async () => {
    const logs = { backend: [] as StepLog[], window: [] as StepLog[] }
    const backend = system({ side: 'backend', log: (step) => { logs.backend.push(step) } })
    const window = system({ side: 'window', log: (step) => { logs.window.push(step) } })
    connect(window, backend)
    const made = backend.start('worker', worker(() => Promise.resolve()))
    window.start('teller', teller)
    window.start('asker', asker)
    await rest()
    backend.send(made, { type: 'PING' })
    await backend.ask(made, 'RUN', { id: 'now' })
    await rest()
    // The window's tell and its ask came across; the send and the ask made here did not.
    deepStrictEqual(handledIn(logs.backend).filter((each) => each.kind === 'event'), [
      { kind: 'event', ref: 'worker', name: 'PING', across: 'window' },
      { kind: 'event', ref: 'worker', name: 'PING' },
    ])
    deepStrictEqual(handledIn(logs.backend).filter((each) => each.kind === 'ask').map((each) => each.across), ['window', undefined])
    // A broadcast comes across to a window, and what a state raises does not.
    const both = wired()
    both.window.send(both.handle, { type: 'TYPE', text: 'a note' })
    both.window.send(both.handle, { type: 'SEND' })
    await rest()
    deepStrictEqual(handledIn(both.logs.window).filter((each) => each.kind === 'event'), [
      { kind: 'event', ref: 'panel', name: 'TYPE' },
      { kind: 'event', ref: 'panel', name: 'SEND' },
      { kind: 'event', ref: 'panel', name: 'NOTED', across: 'backend' },
      { kind: 'event', ref: 'panel', name: 'SENT', own: true },
    ])
  }],
  ['an ask its asker gives up is said as it leaves, by the id it was asked with: cancelled, left with its state, or made and cancelled in one step', async () => {
    const logs = { backend: [] as StepLog[], window: [] as StepLog[] }
    const backend = system({ side: 'backend', log: (step) => { logs.backend.push(step) } })
    const window = system({ side: 'window', log: (step) => { logs.window.push(step) } })
    connect(window, backend)
    backend.start('worker', worker(() => new Promise(() => {})))
    const made = window.start('jobs', jobs)
    window.send(made, { type: 'ADD', id: 'first' })
    await turns()
    window.send(made, { type: 'DROP', id: 'first' })
    await turns()
    const asked = sentIn(logs.window).find((each) => each.kind === 'ask')!
    deepStrictEqual(logs.window.at(-1)!.sent, [{ kind: 'cancelled', to: 'worker', name: 'RUN', id: asked.id }])
    // Made and given up in one step: it is said to be asked and then cancelled, in that order, and was never sent.
    const once = kinds<{ calls: { run: 'single' } }, { type: 'BOTH' }>()({
      calls: ({ single }) => ({ run: single('worker', 'RUN', { args: () => ({ id: 'once' }), done: () => undefined }) }),
      on: { BOTH: (_, { call, cancel }) => { call('run'); cancel('run') } },
    })
    const before = handledIn(logs.backend).filter((each) => each.kind === 'ask').length
    window.send(window.start('once', once), { type: 'BOTH' })
    await turns()
    const step = logs.window.at(-1)!
    deepStrictEqual(step.sent.map((each) => each.kind), ['ask', 'cancelled'])
    strictEqual(step.sent[0]!.id, step.sent[1]!.id)
    strictEqual(handledIn(logs.backend).filter((each) => each.kind === 'ask').length, before)
    // One a state was asking as it stopped is given up with it. One made here, of a state here, is said the same way.
    window.send(made, { type: 'ADD', id: 'second' })
    await turns()
    const second = sentIn(logs.window).filter((each) => each.kind === 'ask').at(-1)!
    window.stop(made)
    deepStrictEqual(logs.window.at(-1)!.sent, [{ kind: 'cancelled', to: 'worker', name: 'RUN', id: second.id }])
    const local = backend.start('jobs', jobs)
    backend.send(local, { type: 'ADD', id: 'here' })
    await turns()
    const here = handledIn(logs.backend).filter((each) => each.kind === 'ask' && !each.across).at(-1)!
    backend.send(local, { type: 'DROP', id: 'here' })
    deepStrictEqual(logs.backend.at(-1)!.sent, [{ kind: 'cancelled', to: 'worker', name: 'RUN', id: here.id }])
    // An ask that was answered was not given up, and nothing says it was.
    const answered = system({ side: 'backend', log: (step) => { logs.backend.push(step) } })
    answered.start('worker', worker(() => Promise.resolve()))
    const start = logs.backend.length
    const quick = answered.start('jobs', jobs)
    answered.send(quick, { type: 'ADD', id: 'now' })
    await turns()
    deepStrictEqual(answered.read(quick).data.done, ['now'])
    answered.stop()
    deepStrictEqual(sentIn(logs.backend.slice(start)).filter((each) => each.kind === 'cancelled'), [])
  }],
  ['a window that leaves its backend takes no step to stop following, and the next step logged says each unfollow before what it sent', async () => {
    const store = memory()
    const logs: StepLog[] = []
    const backend = system({ side: 'backend', transact: store.transact, views: countOf(store) })
    backend.start('worker', worker(() => Promise.resolve()))
    const window = system({ side: 'window', log: (step) => { logs.push(step) } })
    const link = connect(window, backend)
    window.start('watcher', watcher)
    await rest()
    const followed = sentIn(logs).find((each) => each.kind === 'follow')!
    link.close()
    await rest()
    const before = logs.length
    deepStrictEqual(sentIn(logs).filter((each) => each.kind === 'unfollow'), [])
    // Joined again, it follows again in a step, whose log says first what was unfollowed since the one before.
    connect(window, backend)
    await rest()
    deepStrictEqual(logs[before]!.sent, [
      { kind: 'unfollow', to: 'threads', name: 'count', id: followed.id },
      { kind: 'follow', to: 'threads', name: 'count', id: followed.id! + 1 },
    ])
    // Said once: the steps after say nothing more of it.
    window.start('runs', runs(false))
    await rest()
    strictEqual(sentIn(logs).filter((each) => each.kind === 'unfollow').length, 1)
  }],
  ['a view a system serves itself is followed and unfollowed in its log as one across a link is, by one id', async () => {
    const store = memory()
    const logs: StepLog[] = []
    const window = system({ side: 'window', views: countOf(store), log: (step) => { logs.push(step) } })
    const made = window.start('watcher', watcher)
    await rest()
    deepStrictEqual(logs[0]!.sent, [{ kind: 'follow', to: 'threads', name: 'count', id: 1 }])
    deepStrictEqual(handledIn(logs), [{ kind: 'view', ref: 'watcher', name: 'count', id: 1 }])
    window.stop(made)
    deepStrictEqual(logs.at(-1)!.sent, [{ kind: 'unfollow', to: 'threads', name: 'count', id: 1 }])
    // A view that could not be followed was not, and is not said to be.
    const refusing = system({ side: 'window', views: () => { throw new Error('no such view') }, log: (step) => { logs.push(step) } })
    const from = logs.length
    refusing.start('watcher', watcher)
    refusing.stop()
    deepStrictEqual(sentIn(logs.slice(from)), [])
  }],
  ['a step the kernel threw out of is in no log, and its number is not given to the next: a defect it reported names no other step', async () => {
    const logs: StepLog[] = []
    const defects: Defect[] = []
    let unit = 0
    let failAt = 0
    const sys = system({
      side: 'backend',
      // The third unit of a step is the second thing it handles after what began it: failing there is the kernel's own throw.
      transact: (inner) => { unit++; if (unit === failAt) throw new Error('the database went away'); return inner() },
      log: (step) => { logs.push(step) },
      onDefect: (defect) => { defects.push(defect) },
    })
    const chain = kinds<{ data: { hits: number }; internal: { type: 'BREAK' } | { type: 'AFTER' } }, { type: 'GO' } | { type: 'HIT' }>()({
      data: { hits: 0 },
      internal: { BREAK: () => { throw new Error('it broke') }, AFTER: () => {} },
      on: { GO: (_, { raise }) => { raise({ type: 'BREAK' }); raise({ type: 'AFTER' }) }, HIT: (_, { data }) => ({ data: { hits: data.hits + 1 } }) },
    })
    const made = sys.start('chain', chain)
    // Work that outlives its state, and then registers a release that throws: a defect of no step, whenever it comes.
    let release!: () => void
    const waiting = new Promise<void>((resolve) => { release = resolve })
    const late = kinds<{}, never>()({ run: async ({ onExit }) => { await waiting; onExit(() => { throw new Error('too late to release') }) }, failed: () => {} })
    sys.stop(sys.start('late', late))
    // Its units: the step, GO, BREAK, AFTER.
    unit = 0; failAt = 4
    let thrown: unknown
    try { sys.send(made, { type: 'GO' }) } catch (error) { thrown = error }
    failAt = 0
    ok(thrown instanceof Error && thrown.message === 'the database went away', String(thrown))
    const broke = defects.find((each) => each.message.includes('it broke'))!
    // With the step thrown out of, no step is under way: a defect reported now names none.
    release()
    await turns()
    strictEqual('step' in defects.find((each) => each.message.includes('too late to release'))!, false)
    sys.send(made, { type: 'HIT' })
    const next = logs.at(-1)!
    deepStrictEqual(next.handled, [{ kind: 'event', ref: 'chain', name: 'HIT' }])
    deepStrictEqual(logs.map((step) => step.number), [1, 2, 3, 5])
    strictEqual(broke.step, 4)
  }],
  ['an ask given up outside any step takes no step to say so: the next step logged says it first', async () => {
    const logs: StepLog[] = []
    const sys = system({ side: 'backend', log: (step) => { logs.push(step) } })
    sys.start('worker', worker(() => new Promise(() => {})))
    // Answers at once, leaving behind an ask of the worker that nothing waits for: as its work ends, that is given up.
    const leaves = kinds<{}, never, { GO: { args: {}; answer: string } }>()({
      answers: { GO: async (_, { ask }) => { void ask('worker', 'RUN', { id: 'never' }); await Promise.resolve(); return 'gone' } },
    })
    const made = sys.start('leaves', leaves)
    const before = logs.length
    const outcome = await sys.ask(made as never, 'GO' as never, {} as never) as { ok: boolean }
    strictEqual(outcome.ok, true)
    const since = logs.slice(before)
    const asked = handledIn(since).find((each) => each.kind === 'ask' && each.ref === 'worker')!
    // The step that takes the ask, in which the worker is asked, and the step that answers: no step between for the
    // giving up, which the answering step says before its own answer.
    deepStrictEqual(since.map((step) => step.handled.map((each) => `${each.kind} ${each.ref}`)), [['ask leaves', 'ask worker'], ['answer leaves']])
    deepStrictEqual(since[1]!.sent, [
      { kind: 'cancelled', to: 'worker', name: 'RUN', id: asked.id },
      { kind: 'answer', to: 'leaves', name: 'GO', id: 1, outcome: 'ok' },
    ])
  }],
  ['a view a window stops following in a step is stopped at its backend as the step\'s rows are kept, and not before', async () => {
    const order: string[] = []
    let depth = 0
    const window = system({
      side: 'window',
      transact: (inner) => { depth++; try { return inner() } finally { if (--depth === 0) order.push('kept') } },
    })
    window.attach({ tell: () => {}, ask: () => () => {}, follow: () => ({ stop: () => { order.push('stopped') } }) })
    const made = window.start('watcher', watcher)
    order.length = 0
    window.stop(made)
    deepStrictEqual(order, ['kept', 'stopped'])
  }],
])
