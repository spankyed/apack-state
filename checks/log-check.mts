// A step's log: what a system tells whoever gave it `log` of each step once it has ended. What began it and what it
// handled after, what changed, and what left at the commit; never what any of it carried.
//
//   npx vitest run log
import { deepStrictEqual, ok, strictEqual } from 'node:assert'
import { rest, run, system } from './checks.mts'
import { given, reaching, type Handled, type Sent, type StepLog, type ViewHost } from '../src/index.ts'
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
const state = reaching<App>()

const notes = (store: Rows) => state<{ data: { written: string[] } }, never, NotesAsks>()({
  data: { written: [] },
  asks: {
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
  start: 'idle',
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
      async run({ data, ask, send }) {
        const done = await ask('notes', 'WRITE', { text: data.text })
        send({ type: 'SENT', text: done.ok ? done.value.text : '' })
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
const kinds = reaching<Kinds>()

/** Answers a run once its id is let go: `now` at once, anything else when this check says. */
const worker = (letGo: (id: string) => Promise<void>) => kinds<{}, { type: 'PING' }, WorkAsks>()({
  on: { PING: () => {} },
  asks: { RUN: async ({ id }, { progress }) => { progress(`on ${id}`); await letGo(id); return id } },
})
/** Makes a run of the worker for each id it is given, and lets one go. */
const jobs = kinds<{ data: { done: string[] }; states: { on: { makes: { run: 'each' } } } }, { type: 'ADD'; id: string } | { type: 'DROP'; id: string }>()({
  data: { done: [] },
  start: 'on',
  states: {
    on: {
      makes: ({ each }) => ({
        run: each('worker', 'RUN', {
          args: (id) => ({ id }),
          heard: () => undefined,
          ended: (outcome) => (outcome.ok ? { data: (d) => { d.done.push(outcome.value) } } : undefined),
        }),
      }),
      on: { ADD: ({ id }, { make }) => { make('run', id) }, DROP: ({ id }, { drop }) => { drop('run', id) } },
    },
  },
})
/** Work that ends, or throws. */
const runs = (breaks: boolean) => kinds<{ states: { busy: {}; idle: {} } }, never>()({
  start: 'busy',
  states: { busy: { async run() { if (breaks) throw new Error('it broke') }, failed: () => ({ at: 'idle' }) }, idle: {} },
})
/** Work in a state inside another: named by its path. */
const nested = kinds<{ states: { outer: { states: { inner: {}; done: {} } } } }, never>()({
  start: 'outer',
  states: { outer: { start: 'inner', states: { inner: { async run() {}, failed: () => ({ at: 'outer.done' }) }, done: {} } } },
})
/** Asks the worker to run something that is never let go. */
const asker = kinds<{ states: { asking: {}; asked: {} } }, never>()({
  start: 'asking',
  states: { asking: { async run({ ask }) { await ask('worker', 'RUN', { id: 'never' }) }, failed: () => ({ at: 'asked' }) }, asked: {} },
})
/** Sends itself the same event as it handles it, without end. */
const runaway = kinds<{}, { type: 'AGAIN' }>()({ on: { AGAIN: (_, { send }) => { send({ type: 'AGAIN' }) } } })
/** Follows how many threads there are. */
const watcher = kinds<{ data: { count: number } }, never>()({
  data: { count: 0 },
  follows: (follow) => ({ count: follow('threads', 'count', { args: () => ({}), heard: (update) => (update.ok ? { data: { count: update.value } } : undefined) }) }),
})
/** Once its work has waited a turn, outside any step, tells the worker something. */
const teller = kinds<{ states: { telling: {}; told: {} } }, never>()({
  start: 'telling',
  states: { telling: { async run({ tell }) { await Promise.resolve(); tell('worker', { type: 'PING' }) }, failed: () => ({ at: 'told' }) }, told: {} },
})
const countOf = (store: Rows): ViewHost => (_feature, _view, _args, heard) => store.watch(() => store.count('thread'), (value) => heard({ ok: true, value }))
const handledIn = (logs: readonly StepLog[]): Handled[] => logs.flatMap((step) => step.handled)
const leftIn = (logs: readonly StepLog[]): Sent[] => logs.flatMap((step) => step.left)
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
  window.connect(backend)
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
    strictEqual(typed.ended, 'committed')
    deepStrictEqual(logs.window.map((step) => step.number), logs.window.map((_, at) => at + 1))
  }],
  ['what changed is each state\'s fields that did, whether it moved, and where it is', async () => {
    const { window, handle, logs } = wired()
    window.send(handle, { type: 'TYPE', text: 'hello' })
    await rest()
    deepStrictEqual(logs.window.at(-1)!.changed, { panel: { fields: ['draft'], moved: false, making: false, at: 'idle' } })
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
    const left = (of: StepLog[]) => of.flatMap((step) => step.left)
    ok(left(logs.window).some((sent) => sent.kind === 'ask' && sent.to === 'notes' && sent.name === 'WRITE'), JSON.stringify(left(logs.window)))
    const answered = logs.backend.find((step) => step.handled[0]?.kind === 'ask')!
    deepStrictEqual(answered.handled[0], { kind: 'ask', ref: 'notes', name: 'WRITE' })
    deepStrictEqual(answered.left.map((sent) => sent.kind).sort(), ['answer', 'broadcast', 'progress'])
    deepStrictEqual(answered.left.find((sent) => sent.kind === 'answer'), { kind: 'answer', to: 'notes', name: 'WRITE', outcome: 'ok' })
    deepStrictEqual(answered.left.find((sent) => sent.kind === 'broadcast'), { kind: 'broadcast', to: 'panel', name: 'NOTED' })
    // The window's state sent itself what its work found: an event of its own.
    ok(logs.window.some((step) => step.handled.some((one) => one.kind === 'event' && one.name === 'SENT' && one.own === true)))
  }],
  ['an answer that is a refusal is logged with its kind', async () => {
    const { backend, logs } = wired()
    const asker = system({ side: 'window', log: () => {} })
    asker.connect(backend)
    const empty = asker.start('panel', panel)
    asker.send(empty, { type: 'SEND' })
    await rest()
    ok(logs.backend.flatMap((step) => step.left).some((sent) => sent.kind === 'answer' && sent.outcome === 'empty'))
  }],
  ['a step whose rows could not be kept is logged as lost', async () => {
    const { window, handle, logs } = wired({ failNext: 'the disk is full' })
    window.send(handle, { type: 'TYPE', text: 'hello' })
    window.send(handle, { type: 'SEND' })
    await rest()
    ok(logs.backend.some((step) => step.ended === 'lost'), JSON.stringify(logs.backend.map((step) => step.ended)))
  }],
  ['nothing any of it carried is in a log', async () => {
    const { window, handle, logs } = wired()
    window.send(handle, { type: 'TYPE', text: MARK })
    window.send(handle, { type: 'SEND' })
    await rest()
    const refusing = system({ side: 'window', log: (step) => { logs.window.push(step) } })
    refusing.connect(wired().backend)
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
    has(handled, { kind: 'make', ref: 'jobs', name: 'run', key: 'now' })
    has(handled, { kind: 'progressed', ref: 'jobs', name: 'run', key: 'now' })
    has(handled, { kind: 'answer', ref: 'worker', name: 'RUN' })
    has(handled, { kind: 'ended', ref: 'jobs', name: 'run', key: 'now' })
    has(handled, { kind: 'drop', ref: 'jobs', name: 'run', key: 'later' })
    has(handled, { kind: 'result', ref: 'ends', name: 'busy' })
    has(handled, { kind: 'failure', ref: 'breaks', name: 'busy' })
    has(handled, { kind: 'view', ref: 'watcher', name: 'count' })
    // A state that moved and changed none of its fields says so, and where it is.
    const broke = logs.find((step) => step.handled.some((one) => one.kind === 'failure'))!
    deepStrictEqual(broke.changed.breaks, { fields: [], moved: true, making: false, at: 'idle' })
    for (const resolve of held.values()) resolve()
    await rest()
    // A state that ended is nowhere.
    backend.stop()
    await rest()
    strictEqual(logs.at(-1)!.changed.ends?.at, '')
  }],
  ['what left is said by kind, to whom and by name: a follow and an unfollow, a tell made outside a step, and an ask its state stopped before answering', async () => {
    const store = memory()
    const logs = { backend: [] as StepLog[], window: [] as StepLog[] }
    const backend = system({ side: 'backend', transact: store.transact, views: countOf(store), log: (step) => { logs.backend.push(step) } })
    backend.start('worker', worker(() => new Promise(() => {})))
    const made = backend.start('jobs', jobs)
    const window = system({ side: 'window', log: (step) => { logs.window.push(step) } })
    window.connect(backend)
    window.start('watcher', watcher)
    window.start('teller', teller)
    await rest()
    has(leftIn(logs.window), { kind: 'follow', to: 'threads', name: 'count' })
    has(leftIn(logs.window), { kind: 'tell', to: 'worker', name: 'PING' })
    window.stop()
    await rest()
    has(leftIn(logs.window), { kind: 'unfollow', to: 'threads', name: 'count' })
    // The worker is asked, and never answers: it stops first.
    backend.send(made, { type: 'ADD', id: 'never' })
    await turns()
    backend.stop()
    await turns()
    has(leftIn(logs.backend), { kind: 'abandoned', to: 'worker', name: 'RUN' })
  }],
  ['an ask across the link that the link ends is logged as answered: which ask it was, and that it ended', async () => {
    const store = memory()
    const logs: StepLog[] = []
    const backend = system({ side: 'backend', transact: store.transact })
    backend.start('worker', worker(() => new Promise(() => {})))
    const window = system({ side: 'window', log: (step) => { logs.push(step) } })
    const link = window.connect(backend)
    window.start('asker', asker)
    await turns()
    link.close()
    await turns()
    has(handledIn(logs), { kind: 'answer', ref: 'worker', name: 'RUN' })
  }],
  ['a step that runs away is logged as cut short', async () => {
    const logs: StepLog[] = []
    const window = system({ side: 'window', log: (step) => { logs.push(step) }, trace: () => {} })
    window.send(window.start('runaway', runaway), { type: 'AGAIN' })
    await turns()
    ok(logs.some((step) => step.ended === 'cut short'), JSON.stringify(logs.map((step) => step.ended)))
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
])
