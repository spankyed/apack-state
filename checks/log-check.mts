// A step's log: what a system tells whoever gave it `log` of each step once it has ended. What began it and what it
// handled after, what changed, and what left at the commit; never what any of it carried.
//
//   npx vitest run log
import { deepStrictEqual, ok, strictEqual } from 'node:assert'
import { rest, run, system } from './checks.mts'
import { given, reaching, type StepLog } from '../src/index.ts'
import { memory, type Rows } from './store.mts'

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
  ['a log that throws is its own to answer for: the system goes on', async () => {
    const window = system({ side: 'window', log: () => { throw new Error('the log broke') } })
    const handle = window.start('panel', panel)
    window.send(handle, { type: 'TYPE', text: 'one' })
    window.send(handle, { type: 'TYPE', text: 'two' })
    await rest()
    strictEqual(window.read(handle).data.draft, 'two')
  }],
])
