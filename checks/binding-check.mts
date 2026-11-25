// What the Vue binding rests on. A reader is handed the state's own values, a field at a time, and runs again when
// the state replaces a field it read. `effect` here stands for a component's render.
//
//   npx vitest run binding
import { deepStrictEqual, ok, strictEqual, throws } from 'node:assert'
import { computed, effect } from '@vue/reactivity'
import { mirror, mirrors } from '../src/mirror.ts'
import { run, system } from './checks.mts'
import { given, reaching, within, type Each, type Value } from '../src/index.ts'
import { windowFrame } from '../src/window-frame.ts'

/** Not plain data: handed over as it is, and never frozen. */
class Repository { constructor(public directory: string) {} where(): string { return this.directory } }
interface Item { id: string }

type Shape = {
  data: { titles: Record<string, string>; messages: Record<string, string[]>; count: number; known: Item[]; result: { ok: boolean }; repository: Repository }
  states: { list: {}; thread: { data: { threadId: string } } }
}
type Event =
  | { type: 'ADD'; id: string; title: string }
  | { type: 'RENAME'; id: string; title: string }
  | { type: 'SAY'; id: string; text: string }
  | { type: 'FORGET'; id: string }
  | { type: 'TRIM'; id: string }
  | { type: 'OPEN'; id: string }
  | { type: 'CLOSE' }
  | { type: 'COUNT' }
  | { type: 'KNOW'; item: Item }
  | { type: 'DROP'; item: Item }
  | { type: 'RESULT' }

const state = reaching()
const threads = state<Shape, Event>()({
  data: { titles: {}, messages: {}, count: 0, known: [], result: { ok: true }, repository: new Repository('/a') },
  start: 'list',
  on: {
    ADD:    ({ id, title }) => ({ data: (d) => { d.titles[id] = title; d.messages[id] = [] } }),
    RENAME: ({ id, title }) => ({ data: (d) => { d.titles[id] = title } }),
    SAY:    ({ id, text })  => ({ data: (d) => { d.messages[id]?.push(text) } }),
    FORGET: ({ id })        => ({ data: (d) => { delete d.titles[id]; delete d.messages[id] } }),
    TRIM:   ({ id })        => ({ data: (d) => { d.messages[id]?.splice(0, 1) } }),
    OPEN:   ({ id })        => ({ at: 'thread', data: { threadId: id } }),
    CLOSE:  ()              => ({ at: 'list' }),
    COUNT:  (_, { data })   => ({ data: { count: data.count + 1 } }),
    KNOW:   ({ item }, { data }) => ({ data: { known: [...data.known, item] } }),
    // Drops the very one it is handed, as code that keeps a list of what it was told does.
    DROP:   ({ item }, { data }) => ({ data: { known: data.known.filter((each) => each !== item) } }),
    // A result that is the same as the one before, and is another.
    RESULT: ()              => ({ data: { result: { ok: true } } }),
  },
  states: { list: {}, thread: { data: { threadId: given } } },
})

/** A running state, mirrored, with readers that each count how often they ran. */
const watched = () => {
  const sys = system({ side: 'window' })
  const handle = sys.start('threads', threads)
  const send = (event: Event): void => sys.send(handle, event)
  send({ type: 'ADD', id: 'a', title: 'A' })
  send({ type: 'ADD', id: 'b', title: 'B' })
  const held = mirror<Value<Shape>>(sys, handle)
  const runs = { messagesOfA: 0, messagesOfB: 0, titleOfA: 0, where: 0, count: 0, result: 0, partA: 0, partB: 0, partTitleA: 0 }
  const seen: { messagesOfA?: string[]; where?: string } = {}
  effect(() => { runs.messagesOfA++; seen.messagesOfA = [...(held.value.data.messages.a ?? [])] })
  effect(() => { runs.messagesOfB++; void held.value.data.messages.b?.length })
  effect(() => { runs.titleOfA++; void held.value.data.titles.a })
  effect(() => { runs.where++; seen.where = held.value.at })
  effect(() => { runs.count++; void held.value.data.count })
  effect(() => { runs.result++; void held.value.data.result })
  // A reader of one part of a field, through a computed: what the part is is worked out again when the field is
  // replaced, and the reader runs only if it came out another.
  const partA = computed(() => held.value.data.messages.a)
  const partB = computed(() => held.value.data.messages.b)
  const partTitleA = computed(() => held.value.data.titles.a)
  effect(() => { runs.partA++; void partA.value })
  effect(() => { runs.partB++; void partB.value })
  effect(() => { runs.partTitleA++; void partTitleA.value })
  const since = { ...runs }
  /** Which readers ran since the last time this was asked */
  const ran = (): string[] => { const names = (Object.keys(runs) as Array<keyof typeof runs>).filter((name) => runs[name] !== since[name]); Object.assign(since, runs); return names }
  return { send, held, ran, seen, sys, handle }
}

// ── one of many: a card for each item, read from outside ────────────────────────────────────────────────────────────

type Card = { data: { id: string; label: string; bumps: number } }
const card = state<Card, { type: 'BUMP' }>()({
  data: { id: given, label: given, bumps: 0 },
  on: { BUMP: (_, { data }) => ({ data: { bumps: data.bumps + 1 } }) },
})
type Board = { data: { items: Record<string, string> }; starts: { card: Each<typeof card> } }
type BoardEvent = { type: 'ADD'; id: string; label: string } | { type: 'REMOVE'; id: string } | { type: 'BUMP'; id: string }
export const board = state<Board, BoardEvent>()({
  data: { items: {} },
  starts: (start) => ({ card: start(card, { each: 'items', given: (id, data) => ({ id, label: data.items[id]! }) }) }),
  on: {
    ADD: ({ id, label }) => ({ data: (d) => { d.items[id] = label } }),
    REMOVE: ({ id }) => ({ data: (d) => { delete d.items[id] } }),
    BUMP: ({ id }, { tell, child }) => { tell(child('card', id), { type: 'BUMP' }) },
  },
})

/** A board with two cards, and a reader of each card, of a third that is not there yet, and of which there are. */
const boarded = () => {
  const sys = system({ side: 'window' })
  const handle = sys.start('board', board)
  const send = (event: BoardEvent): void => sys.send(handle, event)
  send({ type: 'ADD', id: 'a', label: 'Alpha' })
  send({ type: 'ADD', id: 'b', label: 'Beta' })
  // A card is reached from outside by the name it is declared under and its key: what a component would do.
  const held = { board: mirror<Value<Board>>(sys, handle), a: mirror(sys, sys.child(handle, 'card', 'a')), b: mirror(sys, sys.child(handle, 'card', 'b')), c: mirror(sys, sys.child(handle, 'card', 'c')) }
  const runs = { which: 0, a: 0, b: 0, c: 0 }
  const seen: { which?: string[]; a?: number; c?: string } = {}
  effect(() => { runs.which++; seen.which = Object.keys(held.board.value.data.items) })
  effect(() => { runs.a++; seen.a = held.a.value?.data.bumps })
  effect(() => { runs.b++; void held.b.value?.data.bumps })
  effect(() => { runs.c++; seen.c = held.c.value?.data.label })
  const since = { ...runs }
  const ran = (): string[] => { const names = (Object.keys(runs) as Array<keyof typeof runs>).filter((name) => runs[name] !== since[name]); Object.assign(since, runs); return names }
  return { send, ran, seen, sys, handle }
}

const checks: Array<[string, () => void]> = [
  ['a change inside a field runs every reader of that field, and no reader of another', () => {
    const it = watched()
    it.send({ type: 'SAY', id: 'a', text: 'hello' })
    deepStrictEqual(it.ran(), ['messagesOfA', 'messagesOfB', 'partA'])
    deepStrictEqual(it.seen.messagesOfA, ['hello'])
    it.send({ type: 'RENAME', id: 'b', title: 'B2' })
    deepStrictEqual(it.ran(), ['titleOfA'])
  }],
  ['a reader of one part, through a computed, runs only when that part was replaced', () => {
    const it = watched()
    it.send({ type: 'SAY', id: 'a', text: 'hello' })
    deepStrictEqual(it.ran().filter((name) => name.startsWith('part')), ['partA'])
    it.send({ type: 'SAY', id: 'b', text: 'other' })
    deepStrictEqual(it.ran().filter((name) => name.startsWith('part')), ['partB'])
    it.send({ type: 'RENAME', id: 'b', title: 'B2' })
    deepStrictEqual(it.ran().filter((name) => name.startsWith('part')), [])
    it.send({ type: 'RENAME', id: 'a', title: 'A2' })
    deepStrictEqual(it.ran().filter((name) => name.startsWith('part')), ['partTitleA'])
  }],
  ['a field replaced whole runs only its reader', () => {
    const it = watched()
    it.send({ type: 'COUNT' })
    deepStrictEqual(it.ran(), ['count'])
  }],
  ['a move runs the reader of where it is, and the mirror gains and loses the fields the states do', () => {
    const it = watched()
    it.send({ type: 'OPEN', id: 'a' })
    deepStrictEqual(it.ran(), ['where'])
    strictEqual(it.seen.where, 'thread')
    strictEqual((it.held.value.data as { threadId?: string }).threadId, 'a')
    it.send({ type: 'CLOSE' })
    strictEqual(it.seen.where, 'list')
    strictEqual('threadId' in it.held.value.data, false)
  }],
  ['removing from the front of a list, and deleting a key, reach the reader', () => {
    const it = watched()
    it.send({ type: 'SAY', id: 'a', text: 'one' })
    it.send({ type: 'SAY', id: 'a', text: 'two' })
    it.ran()
    it.send({ type: 'TRIM', id: 'a' })
    deepStrictEqual(it.seen.messagesOfA, ['two'])
    it.send({ type: 'FORGET', id: 'a' })
    deepStrictEqual(it.seen.messagesOfA, [])
    strictEqual('a' in it.held.value.data.titles, false)
  }],

  // ── what a reader is handed ──────────────────────────────────────────────────────────────────────────────────────

  ["a reader is handed the state's own values, and what a change did not touch is the same object after it", () => {
    const it = watched()
    const titles = it.held.value.data.titles
    strictEqual(titles, it.sys.read(it.handle).data.titles)
    it.send({ type: 'SAY', id: 'a', text: 'hello' })
    strictEqual(it.held.value.data.titles, titles)
    strictEqual(it.held.value.data.messages, it.sys.read(it.handle).data.messages)
  }],
  ['an object read from a state is the one the state finds when it is sent back', () => {
    const it = watched()
    it.send({ type: 'KNOW', item: { id: 'one' } })
    it.send({ type: 'KNOW', item: { id: 'two' } })
    const first = it.held.value.data.known[0]!
    ok(it.sys.read(it.handle).data.known.includes(first))
    it.send({ type: 'DROP', item: first })
    deepStrictEqual(it.held.value.data.known, [{ id: 'two' }])
  }],
  ['what is read can be cloned', () => {
    const it = watched()
    it.send({ type: 'SAY', id: 'a', text: 'hello' })
    deepStrictEqual(structuredClone(it.held.value.data.messages), { a: ['hello'], b: [] })
  }],
  ['a value that is not plain data is handed over as it is, and is not frozen', () => {
    const it = watched()
    const repository = it.held.value.data.repository
    ok(repository instanceof Repository)
    strictEqual(repository.where(), '/a')
    strictEqual(Object.isFrozen(repository), false)
    strictEqual(repository, it.sys.read(it.handle).data.repository)
  }],
  ['a field replaced by a value equal to the one before runs its reader: replaced is changed', () => {
    const it = watched()
    it.send({ type: 'RESULT' })
    deepStrictEqual(it.ran(), ['result'])
    it.send({ type: 'RESULT' })
    deepStrictEqual(it.ran(), ['result'])
  }],
  ['nothing a reader is handed can be written: a field is not set, and a write inside one throws', () => {
    const it = watched()
    const warn = console.warn
    console.warn = () => {}
    try { (it.held.value.data as { count: number }).count = 99 } finally { console.warn = warn }
    strictEqual(it.held.value.data.count, 0)
    strictEqual(it.sys.read(it.handle).data.count, 0)
    throws(() => { (it.held.value.data.messages.a as string[]).push('written') }, TypeError)
    throws(() => { (it.held.value.data.titles as Record<string, string>).a = 'written' }, TypeError)
    deepStrictEqual(it.sys.read(it.handle).data.messages, { a: [], b: [] })
  }],

  ['within says whether a value is at a state or anywhere inside it', () => {
    const at = (where: string): { at: string } => ({ at: where })
    ok(within(at('thread'), 'thread'))
    ok(within(at('thread.idle'), 'thread'))
    ok(within(at('thread.idle.typing'), 'thread.idle'))
    ok(!within(at('list'), 'thread'))
    ok(!within(at('threads'), 'thread'), 'a state whose name begins with the other is not inside it')
    ok(!within(at('list.thread'), 'thread'), 'a state of the same name inside another is not it')
  }],

  // ── readers coming and going ─────────────────────────────────────────────────────────────────────────────────────

  ['a state read on its own is shown when a step of one nobody reads starts it', () => {
    const sys = system({ side: 'window' })
    const handle = sys.start('board', board)
    const c = mirror(sys, sys.child(handle, 'card', 'c'))
    const shows = (): string => (c.value ? `${c.value.data.label} ${c.value.data.bumps}` : 'nothing')
    strictEqual(shows(), 'nothing')
    sys.send(handle, { type: 'ADD', id: 'c', label: 'Gamma' })
    strictEqual(shows(), 'Gamma 0')
    sys.send(handle, { type: 'BUMP', id: 'c' })
    strictEqual(shows(), 'Gamma 1')
  }],
  ['one reader stopping leaves the others reading', () => {
    const it = watched()
    const other = mirror<Value<Shape>>(it.sys, it.handle)
    other.stop()
    it.send({ type: 'COUNT' })
    strictEqual(it.held.value.data.count, 1)
    deepStrictEqual(it.ran(), ['count'])
  }],
  ['stopping a reader twice is stopping it once, and once the last has stopped the state is not mirrored', () => {
    const it = watched()
    const other = mirror<Value<Shape>>(it.sys, it.handle)
    strictEqual(mirrors(it.sys).size, 1)
    other.stop()
    other.stop()
    it.send({ type: 'COUNT' })
    deepStrictEqual(it.ran(), ['count'])
    it.held.stop()
    strictEqual(mirrors(it.sys).size, 0)
  }],

  // ── a frame, in a window ──────────────────────────────────────────────────────────────────────────────────────────

  ['a change in one of many runs only the reader of that one', () => {
    const it = boarded()
    it.send({ type: 'BUMP', id: 'a' })
    deepStrictEqual(it.ran(), ['a'])
    strictEqual(it.seen.a, 1)
    it.send({ type: 'BUMP', id: 'b' })
    deepStrictEqual(it.ran(), ['b'])
  }],
  ['one that is not running reads as nothing, and its reader runs when it starts and when it stops', () => {
    const it = boarded()
    strictEqual(it.seen.c, undefined)
    it.send({ type: 'ADD', id: 'c', label: 'Gamma' })
    deepStrictEqual(it.ran(), ['which', 'c'])
    strictEqual(it.seen.c, 'Gamma')
    deepStrictEqual(it.seen.which, ['a', 'b', 'c'])
    it.send({ type: 'REMOVE', id: 'c' })
    deepStrictEqual(it.ran(), ['which', 'c'])
    strictEqual(it.seen.c, undefined)
  }],
  ['one that stops and starts again is read afresh, and the readers of the others do not run', () => {
    const it = boarded()
    it.send({ type: 'BUMP', id: 'a' })
    it.send({ type: 'REMOVE', id: 'a' })
    it.ran()
    strictEqual(it.seen.a, undefined)
    it.send({ type: 'ADD', id: 'a', label: 'Alpha again' })
    deepStrictEqual(it.ran(), ['which', 'a'])
    strictEqual(it.seen.a, 0)
  }],
  ['a child restarted within a single step notifies subscribers and mirrors with its new data, state, and making', () => {
    const child = state<{
      data: { label: string; fixed: string }
      states: { a: {}; b: { data: { opt?: string | undefined } } }
    }, { type: 'TO_B' }>()({
      data: { label: given, fixed: 'same' },
      start: 'a',
      on: { TO_B: () => ({ at: 'b', data: { opt: undefined } }) },
      states: { a: {}, b: { data: { opt: undefined as never } } },
    })
    const host = state<{
      data: { gen: number }
      states: { open: { data: { label?: string }; starts: { kid: typeof child } }; closed: {} }
    }, { type: 'REOPEN'; label: string } | { type: 'REOPEN_AND_CLOSE'; label: string } | { type: 'MOVE_KID' } | { type: 'CLOSE' }>()({
      data: { gen: 0 },
      start: 'open',
      states: {
        open: {
          data: { label: 'first' },
          starts: (start) => ({ kid: start(child, { given: (d) => ({ label: d.label ?? 'first' }) }) }),
          on: {
            MOVE_KID: (_, { tell, child: of }) => { tell(of('kid'), { type: 'TO_B' }) },
            REOPEN: ({ label }) => ({ at: 'open', data: { label } }),
            REOPEN_AND_CLOSE: ({ label }, { send }) => { send({ type: 'CLOSE' }); return { at: 'open', data: { label } } },
            CLOSE: () => ({ at: 'closed' }),
          },
        },
        closed: {},
      },
    })
    const logs: Array<{ changed: Record<string, { fields: readonly string[]; moved: boolean; making: boolean }> }> = []
    const sys = system({ side: 'window', log: (step) => logs.push(step) })
    const h = sys.start('host', host)
    const kidHandle = sys.child(h, 'kid')
    const held = mirror(sys, kidHandle)
    const seen: Array<{ label: string | undefined; at: string | undefined }> = []
    effect(() => { seen.push({ label: held.value?.data.label, at: held.value?.at }) })
    sys.send(h, { type: 'MOVE_KID' })
    deepStrictEqual(seen.at(-1), { label: 'first', at: 'b' })
    strictEqual(Object.hasOwn(held.value!.data, 'opt'), true)
    // Self-transition stops and restarts `kid` in the same step: mirror, subscriber, and StepLog must all see the fresh child.
    sys.send(h, { type: 'REOPEN', label: 'second' })
    deepStrictEqual(seen.at(-1), { label: 'second', at: 'a' })
    strictEqual(Object.hasOwn(held.value!.data, 'opt'), false)
    const step1 = logs.at(-1)!.changed['host/kid']!
    strictEqual(step1.moved, true)
    strictEqual(step1.making, false)
    deepStrictEqual([...step1.fields].sort(), ['label', 'opt'])
    // Restarting again while `kid` is ALREADY at `a`: `moved` is false and `fixed` is still omitted from fields.
    sys.send(h, { type: 'REOPEN', label: 'third' })
    const step2 = logs.at(-1)!.changed['host/kid']!
    strictEqual(step2.moved, false)
    strictEqual(step2.making, false)
    deepStrictEqual([...step2.fields], ['label'])
    // Restarting and then closing in the same step leaves `kid` absent (no crash in diff).
    sys.send(h, { type: 'REOPEN_AND_CLOSE', label: 'fourth' })
    strictEqual(held.value, undefined)
    held.stop()

    // Also verify a restarted child that declares `makes` updates `making` in both mirror and StepLog.
    const svc = reaching<{ systems: { worker: { events: never; asks: { SAVE: { args: {}; answer: string } } } }; surfaces: {}; views: {} }>()
    const maker = svc<{ data: { label: string }; makes: { save: 'one' } }, { type: 'GO' }>()({
      data: { label: given },
      makes: ({ one }) => ({ save: one('worker', 'SAVE', { args: () => ({}), ended: () => undefined }) }),
      on: { GO: (_, { make }) => { make('save') } },
    })
    const makerHost = svc<{ states: { open: { data: { label?: string }; starts: { kid: typeof maker } } } }, { type: 'GO' } | { type: 'REOPEN'; label: string }>()({
      start: 'open',
      states: {
        open: {
          data: { label: 'one' },
          starts: (start) => ({ kid: start(maker, { given: (d) => ({ label: d.label ?? 'one' }) }) }),
          on: {
            GO: (_, { tell, child: of }) => { tell(of('kid'), { type: 'GO' }) },
            REOPEN: ({ label }) => ({ at: 'open', data: { label } }),
          },
        },
      },
    })
    const mLogs: Array<{ changed: Record<string, { making: boolean }> }> = []
    const mSys = system({ side: 'window', log: (step) => mLogs.push(step) })
    mSys.attach({ tell: () => {}, ask: () => () => {}, follow: () => ({ stop: () => {} }) })
    const mh = mSys.start('mh', makerHost)
    const mk = mirror(mSys, mSys.child(mh, 'kid'))
    mSys.send(mh, { type: 'GO' })
    strictEqual(mk.value?.making.save, true)
    mSys.send(mh, { type: 'REOPEN', label: 'two' })
    strictEqual(mk.value?.making.save, false)
    strictEqual(mLogs.at(-1)!.changed['mh/kid']?.making, true)
    mk.stop()
    mSys.stop()
  }],
  ['mirrors unsubscribes from the system when its last reader stops, and re-subscribes when a new one starts', () => {
    const sys = system({ side: 'window' })
    const h = sys.start('threads', threads)
    let subscribes = 0
    let unsubscribes = 0
    const spied = Object.assign(Object.create(Object.getPrototypeOf(sys)), sys, {
      subscribe: (...args: Parameters<typeof sys.subscribe>) => {
        subscribes++
        const off = sys.subscribe(...args)
        return () => { unsubscribes++; off() }
      },
    }) as typeof sys
    const m1 = mirror<Value<Shape>>(spied, h)
    const m2 = mirror<Value<Shape>>(spied, h)
    strictEqual(subscribes, 1)
    strictEqual(unsubscribes, 0)
    m1.stop()
    strictEqual(unsubscribes, 0)
    m2.stop()
    strictEqual(unsubscribes, 1)
    const m3 = mirror<Value<Shape>>(spied, h)
    strictEqual(subscribes, 2)
    sys.send(h, { type: 'COUNT' })
    strictEqual(m3.value.data.count, 1)
    m3.stop()
    strictEqual(unsubscribes, 2)
  }],
  ['a mirror deletes a removed substate field named after an Object.prototype key instead of copying the prototype method', () => {
    const protoState = state<{ states: { plain: {}; withProto: { data: { toString: string } } } }, { type: 'ENTER' } | { type: 'LEAVE' }>()({
      start: 'plain',
      states: {
        plain: { on: { ENTER: () => ({ at: 'withProto', data: { toString: 'custom' } }) } },
        withProto: { data: { toString: given }, on: { LEAVE: () => ({ at: 'plain' }) } },
      },
    })
    const sys = system({ side: 'window' })
    const h = sys.start('p', protoState)
    const held = mirror(sys, h)
    sys.send(h, { type: 'ENTER' })
    strictEqual((held.value.data as Record<string, unknown>).toString, 'custom')
    sys.send(h, { type: 'LEAVE' })
    strictEqual(Object.hasOwn(held.value.data, 'toString'), false)
    held.stop()
  }],
  ['a showing window waits for its next paint', () => {
    const page = fakePage()
    const ran: string[] = []
    page.frame(() => ran.push('one'))
    page.turn()
    deepStrictEqual(ran, [])
    page.paint()
    deepStrictEqual(ran, ['one'])
  }],
  ['a hidden window takes the next turn, since no paint is coming', () => {
    const page = fakePage()
    page.hide()
    const ran: string[] = []
    page.frame(() => ran.push('one'))
    page.turn()
    deepStrictEqual(ran, ['one'])
  }],
  ['what was waiting for a paint when the window was hidden is handed over then, once', () => {
    const page = fakePage()
    const ran: string[] = []
    page.frame(() => ran.push('one'))
    page.hide()
    page.turn()
    deepStrictEqual(ran, ['one'])
    page.show()
    page.paint()
    deepStrictEqual(ran, ['one'])
  }],
]

/** A window whose paints and turns come when the check says so. */
function fakePage() {
  let hidden = false
  const paints: Array<() => void> = []
  const turns: Array<() => void> = []
  const hiddenListeners: Array<() => void> = []
  const frame = windowFrame({
    hidden: () => hidden,
    frame: (run) => { paints.push(run) },
    later: (run) => { turns.push(run) },
    onHidden: (listener) => { hiddenListeners.push(listener) },
  })
  return {
    frame,
    paint: () => { if (!hidden) for (const run of paints.splice(0)) run() },
    turn: () => { for (const run of turns.splice(0)) run() },
    hide: () => { hidden = true; for (const listener of hiddenListeners) listener() },
    show: () => { hidden = false },
  }
}

await run(checks)
