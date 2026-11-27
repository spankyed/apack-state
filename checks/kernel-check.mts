// What the kernel does with a change to data. Each check drives a running state and reads what came of it.
//
//   npx vitest run kernel
// This file's own source, as written: what a report's line is counted in. Read the same way in Node and in a window.
import source from './kernel-check.mts?raw'
import { deepStrictEqual, ok, strictEqual, throws } from 'node:assert'
import { rest, run as runChecks, system } from './checks.mts'
import { answered, Cancelled, given, forNet, type Defect, type Each, type StepLog } from '../src/index.ts'
import { said, WROTE_TO_WHAT_WAS_READ } from '../src/kernel.ts'
import { connect } from '../src/testing.ts'

class Repository { constructor(public directory: string) {} }

type Shape = {
  data: { titles: Record<string, string>; messages: Record<string, string[]>; count: number; repository: Repository; kept: { n: number } | null; list: string[] }
  states: {
    list: {}
    thread: { data: { threadId: string } }
  }
}
type Event =
  | { type: 'ADD'; id: string; title: string }
  | { type: 'RENAME'; id: string; title: string }
  | { type: 'NOTHING' }
  | { type: 'OPEN'; id: string }
  | { type: 'CLOSE_AND_COUNT' }
  | { type: 'ADD_A_FIELD' }
  | { type: 'RETURNS_A_VALUE' }
  | { type: 'IS_ASYNC' }
  | { type: 'EDITS_AN_INSTANCE' }
  | { type: 'WRITES_IN_PLACE' }
  | { type: 'KEEP'; item: { n: number } }
  | { type: 'WRITES_THROUGH_A_HELPER' }
  | { type: 'WRITES_FURTHER_IN'; id: string }
  | { type: 'THROWS_ITS_OWN' }
  | { type: 'THROWS_FROM'; stack: string }
  | { type: 'REMOVES_A_FIELD' }
  | { type: 'ONE_BAD_WRITE' }
  | { type: 'GIVES_A_STRAY_FIELD' }
  | { type: 'MOVES_WITH_A_STRAY_FIELD' }
  | { type: 'MOVES_NOWHERE' }
  | { type: 'MOVES_WITHOUT_WHAT_IT_NEEDS' }
  | { type: 'EDITS_AND_MOVES_NOWHERE' }
  | { type: 'WRITES_A_FIELD_IN_PLACE' }
  | { type: 'RETURNS_NULL' }
  | { type: 'KEEPS_A_BARE_OBJECT' }
  | { type: 'GROWS'; by: number }

/** A helper that writes to what it is given, and says so in its type. */
const bump = (item: { n: number }): void => { item.n++ }

const state = forNet()
const made = state<Shape, Event>()({
  data: { titles: {}, messages: {}, count: 0, repository: new Repository('/a'), kept: null, list: [] },
  initial: 'list',
  on: {
    ADD:     ({ id, title }) => ({ data: (d) => { d.titles[id] = title; d.messages[id] = []; d.count++ } }),
    RENAME:  ({ id, title }) => ({ data: (d) => { d.titles[id] = title } }),
    NOTHING: ()              => ({ data: (d) => { d.count = d.count } }),
    OPEN:    ({ id })        => ({ at: 'thread', data: { threadId: id } }),

    // Each of these is a mistake the kernel has to report and not act on.
    ADD_A_FIELD:       () => ({ data: (d) => { (d as Record<string, unknown>).extra = 1 } }),
    RETURNS_A_VALUE:   () => ({ data: ((d: Shape['data']) => ({ ...d, count: 99 })) as (d: Shape['data']) => void }),
    IS_ASYNC:          () => ({ data: (async (d: Shape['data']) => { await null; d.count = 99 }) as (d: Shape['data']) => void }),
    EDITS_AN_INSTANCE: () => ({ data: (d) => { d.repository.directory = '/b' } }),
    // Writes to what the state holds, where it should return a change.
    WRITES_IN_PLACE:   (_, { data }) => { (data.titles as Record<string, string>).written = 'in place' },
    KEEP:              ({ item }) => ({ data: { kept: item } }),
    // The compiler lets a read-only object be passed where one to write to is expected. Freezing is what stops it.
    WRITES_THROUGH_A_HELPER: (_, { data }) => { if (data.kept) bump(data.kept) },
    // A list inside what a field holds is typed as it was declared, so this compiles. It is frozen all the same.
    WRITES_FURTHER_IN: ({ id }, { data }) => { data.messages[id]?.push('written in place') },
    THROWS_ITS_OWN:    () => { throw new TypeError('not a write at all') },
    // An edit that throws what was thrown somewhere with this stack.
    THROWS_FROM:       ({ stack }) => ({ data: () => { throw Object.assign(new Error('thrown in an edit'), { stack }) } }),
    REMOVES_A_FIELD:   () => ({ data: (d) => { delete (d as Partial<Shape['data']>).count } }),
    // A good write, then a bad one: neither is made.
    ONE_BAD_WRITE:     () => ({ data: (d) => { d.count = 5; (d as Record<string, unknown>).extra = 1 } }),
    // The same mistakes made by giving fields. The types refuse each, which is why they are cast.
    GIVES_A_STRAY_FIELD:         () => ({ data: { count: 5, extra: 1 } }) as never,
    MOVES_WITH_A_STRAY_FIELD:    () => ({ at: 'thread', data: { threadId: 'a', count: 5, extra: 1 } }) as never,
    MOVES_NOWHERE:               () => ({ at: 'board', data: { count: 5 } }) as never,
    MOVES_WITHOUT_WHAT_IT_NEEDS: () => ({ at: 'thread', data: { count: 5 } }) as never,
    EDITS_AND_MOVES_NOWHERE:     () => ({ at: 'board', data: (d: Shape['data']) => { d.count = 5 } }) as never,
    // A field of the data itself written, not one inside it.
    WRITES_A_FIELD_IN_PLACE: (_, { data }) => { (data as { count: number }).count = 99 },
    RETURNS_NULL:      () => null as never,
    KEEPS_A_BARE_OBJECT: () => ({ data: { kept: Object.assign(Object.create(null) as { n: number }, { n: 1 }) } }),
    GROWS:             ({ by }) => ({ data: (d) => { d.list.push(...Array.from({ length: by }, () => '')) } }),
  },
  states: {
    list: {},
    thread: {
      data: { threadId: given },
      on: {
        // A move that edits a draft: the draft is the data here, the thread's id included, edited before the move.
        CLOSE_AND_COUNT: () => ({ at: 'list', data: (d) => { d.messages[d.threadId]?.push('closed'); d.count++ } }),
      },
    },
  },
})

const run = (): { send(event: Event): void; data(): Shape['data']; at(): string; notices: Array<readonly string[]>; defects: string[]; large: string[] } => {
  const notices: Array<readonly string[]> = []
  const defects: string[] = []
  const large: string[] = []
  const sys = system({ side: 'backend', trace: (line) => { if (line.startsWith('DEFECT')) defects.push(line); if (line.startsWith('LARGE')) large.push(line) } })
  const handle = sys.start('s', made)
  sys.subscribe((_, fields) => { notices.push(fields.s ?? []) })
  return { send: (event) => sys.send(handle, event), data: () => sys.read(handle).data as Shape['data'], at: () => sys.read(handle).at, notices, defects, large }
}

const checks: Array<[string, () => void]> = [
  ['a draft edit changes the data and says which fields changed', () => {
    const it = run()
    it.send({ type: 'ADD', id: 'a', title: 'A' })
    deepStrictEqual(it.data().titles, { a: 'A' })
    deepStrictEqual(it.notices.at(-1), ['titles', 'messages', 'count'])
  }],
  ['what an edit did not touch is the same object afterwards', () => {
    const it = run()
    it.send({ type: 'ADD', id: 'a', title: 'A' })
    const messages = it.data().messages
    it.send({ type: 'RENAME', id: 'a', title: 'B' })
    strictEqual(it.data().messages, messages)
    deepStrictEqual(it.notices.at(-1), ['titles'])
  }],
  ['an edit that changes nothing tells nobody', () => {
    const it = run()
    const before = it.notices.length
    it.send({ type: 'NOTHING' })
    strictEqual(it.notices.length, before)
  }],
  ['a move can edit a draft, and the edit sees the data of the state being left', () => {
    const it = run()
    it.send({ type: 'ADD', id: 'a', title: 'A' })
    it.send({ type: 'OPEN', id: 'a' })
    strictEqual(it.at(), 'thread')
    it.send({ type: 'CLOSE_AND_COUNT' })
    strictEqual(it.at(), 'list')
    deepStrictEqual(it.data().messages, { a: ['closed'] })
    strictEqual(it.data().count, 2)
    ok(!('threadId' in it.data()))
  }],
  ['an edit cannot add a field: it is reported and the field is not there', () => {
    const it = run()
    it.send({ type: 'ADD_A_FIELD' })
    ok(!('extra' in it.data()))
    ok(it.defects.some((line) => line.includes('no field extra')))
  }],
  ['the report says which line of the handler tried', () => {
    const it = run()
    it.send({ type: 'ADD_A_FIELD' })
    // In Node a stack counts the lines of the file as written; in a window, those of the module Vite made of it.
    const line = typeof window === 'undefined' ? String(source.split('\n').findIndex((each) => each.includes('ADD_A_FIELD:       () =>')) + 1) : '\\d+'
    ok(new RegExp(`There is no field extra to change \\(kernel-check\\.mts:${line}\\)$`).test(it.defects[0]!), it.defects[0])
  }],
  ...([
    ['a module served to a window, with a query after its name', 'at http://localhost:63315/checks/threads.mts?import&t=1700000000000:139:37', 'threads.mts:139'],
    ['a file as Node names it, in parentheses', 'at Object.handler (/app/packs/threads.ts:12:5)', 'threads.ts:12'],
    ['a file built to JavaScript', 'at handler (file:///app/dist/packs/threads.js:40:9)', 'threads.js:40'],
  ] as const).map(([frame, line, says]) => [`the report names the line that threw, in ${frame}`, () => {
    const it = run()
    // The kernel's own frames come first, and are passed over.
    it.send({ type: 'THROWS_FROM', stack: `Error: thrown in an edit\n    at produce (/app/node_modules/@apackdev/state/dist/draft.js:88:11)\n    ${line}` })
    ok(it.defects[0]?.endsWith(`thrown in an edit (${says})`), it.defects[0])
  }] as [string, () => void]),
  ['an edit cannot remove a field', () => {
    const it = run()
    it.send({ type: 'REMOVES_A_FIELD' })
    strictEqual(it.data().count, 0)
    ok(it.defects.some((line) => line.includes('The field count cannot be removed')))
  }],
  ['an edit is all of it or none: a good write before a bad one is not made', () => {
    const it = run()
    const before = it.notices.length
    it.send({ type: 'ONE_BAD_WRITE' })
    strictEqual(it.data().count, 0)
    strictEqual(it.notices.length, before)
    strictEqual(it.defects.length, 1)
  }],
  ['fields are all of them or none, as an edit is: a stray one is reported and the others are not taken', () => {
    const it = run()
    const before = it.notices.length
    it.send({ type: 'GIVES_A_STRAY_FIELD' })
    strictEqual(it.data().count, 0)
    strictEqual(it.notices.length, before)
    deepStrictEqual(it.defects, ['DEFECT: s has no field extra to change'])
  }],
  ['a move is refused before anything is left or entered', () => {
    for (const [type, why] of [
      ['MOVES_WITH_A_STRAY_FIELD', 'DEFECT: s will have no field extra at thread'],
      ['MOVES_NOWHERE', 'DEFECT: s has no state board to go to'],
      ['MOVES_WITHOUT_WHAT_IT_NEEDS', 'DEFECT: s cannot enter thread without threadId'],
      ['EDITS_AND_MOVES_NOWHERE', 'DEFECT: s has no state board to go to'],
    ] as const) {
      const it = run()
      const before = it.notices.length
      it.send({ type })
      strictEqual(it.at(), 'list', type)
      strictEqual(it.data().count, 0, type)
      ok(!('threadId' in it.data()), type)
      strictEqual(it.notices.length, before, type)
      deepStrictEqual(it.defects, [why])
    }
  }],
  ['an edit that returns a value is reported and changes nothing', () => {
    const it = run()
    it.send({ type: 'RETURNS_A_VALUE' })
    strictEqual(it.data().count, 0)
    ok(it.defects.some((line) => line.includes('returns nothing')))
  }],
  ['an async edit is reported and changes nothing', () => {
    const it = run()
    it.send({ type: 'IS_ASYNC' })
    strictEqual(it.data().count, 0)
    ok(it.defects.some((line) => line.includes('cannot be async')))
  }],
  ['what a state holds is frozen all the way down, and what is not plain data is left as it is', () => {
    const it = run()
    it.send({ type: 'ADD', id: 'a', title: 'A' })
    ok(Object.isFrozen(it.data()))
    ok(Object.isFrozen(it.data().titles))
    ok(Object.isFrozen(it.data().messages.a))
    strictEqual(Object.isFrozen(it.data().repository), false)
  }],
  ['a handler that writes to what the state holds, where it should return a change, changes nothing and is reported', () => {
    const it = run()
    const before = it.notices.length
    it.send({ type: 'WRITES_IN_PLACE' })
    deepStrictEqual(it.data().titles, {})
    strictEqual(it.notices.length, before)
    ok(it.defects.some((line) => line.includes('threw handling WRITES_IN_PLACE')), it.defects.join(' / '))
  }],
  ["an object a state is handed is the state's from then on: whoever kept it can no longer write to it", () => {
    const it = run()
    const item = { n: 1 }
    it.send({ type: 'KEEP', item })
    strictEqual(it.data().kept, item)
    throws(() => { item.n = 2 }, TypeError)
    strictEqual(it.data().kept!.n, 1)
  }],
  ['a write the compiler cannot see, through a helper that takes what it is given as writable, still changes nothing', () => {
    const it = run()
    it.send({ type: 'KEEP', item: { n: 1 } })
    it.send({ type: 'WRITES_THROUGH_A_HELPER' })
    strictEqual(it.data().kept!.n, 1)
    ok(it.defects.some((line) => line.includes('threw handling WRITES_THROUGH_A_HELPER')), it.defects.join(' / '))
  }],
  ['a write to what was read is reported with what happened and what to write, from a handler or a helper', () => {
    const it = run()
    it.send({ type: 'ADD', id: 'a', title: 'A' })
    it.send({ type: 'KEEP', item: { n: 1 } })
    for (const type of ['WRITES_IN_PLACE', 'WRITES_THROUGH_A_HELPER'] as const) it.send({ type })
    it.send({ type: 'WRITES_FURTHER_IN', id: 'a' })
    deepStrictEqual(it.data().messages.a, [])
    for (const type of ['WRITES_IN_PLACE', 'WRITES_THROUGH_A_HELPER', 'WRITES_FURTHER_IN']) {
      const line = it.defects.find((defect) => defect.includes(`threw handling ${type}`))
      // What it says is where data is written instead, in words of its own.
      ok(line?.includes(WROTE_TO_WHAT_WAS_READ) && line.includes('Data is not written where it is read'), `${type}: ${line}`)
    }
  }],
  ['an error that is not such a write is reported as it was thrown', () => {
    const it = run()
    it.send({ type: 'THROWS_ITS_OWN' })
    const line = it.defects.find((defect) => defect.includes('threw handling THROWS_ITS_OWN'))
    ok(line?.endsWith('not a write at all'), line)
  }],
  ['every kind of write to something frozen is one the kernel knows for a write', () => {
    const writes: Array<[string, (held: { n: number; list: number[]; byId: Record<string, number> }) => void]> = [
      ['a field assigned', (held) => { held.n = 2 }],
      ['a key added', (held) => { held.byId.b = 2 }],
      ['a key removed', (held) => { delete held.byId.a }],
      ['an item assigned', (held) => { held.list[0] = 9 }],
      ['push', (held) => { held.list.push(4) }],
      ['unshift', (held) => { held.list.unshift(0) }],
      ['pop', (held) => { held.list.pop() }],
      ['shift', (held) => { held.list.shift() }],
      ['splice', (held) => { held.list.splice(0, 1) }],
      ['sort', (held) => { held.list.sort((a, b) => b - a) }],
      ['reverse', (held) => { held.list.reverse() }],
      ['fill', (held) => { held.list.fill(0) }],
      ['a length set', (held) => { held.list.length = 0 }],
    ]
    for (const [name, write] of writes) {
      const held = { n: 1, list: Object.freeze([1, 2, 3]) as number[], byId: Object.freeze({ a: 1 }) as Record<string, number> }
      Object.freeze(held)
      let thrown: unknown
      try { write(held) } catch (error) { thrown = error }
      ok(thrown instanceof TypeError, `${name} did not throw`)
      ok(said(thrown).endsWith(WROTE_TO_WHAT_WAS_READ) && said(thrown).includes('Data is not written where it is read'), `${name}: ${(thrown as Error).message}`)
    }
  }],
  ['after a change, what a state holds is frozen at its top too: a handler that assigns a field of it changes nothing', () => {
    const it = run()
    it.send({ type: 'ADD', id: 'a', title: 'A' })
    it.send({ type: 'KEEP', item: { n: 1 } })
    it.send({ type: 'WRITES_A_FIELD_IN_PLACE' })
    strictEqual(it.data().count, 1)
    ok(it.defects.some((line) => line.includes('threw handling WRITES_A_FIELD_IN_PLACE')), it.defects.join(' / '))
  }],
  ['a handler that returns null changes nothing, and that is not a mistake', () => {
    const it = run()
    const before = it.notices.length
    it.send({ type: 'RETURNS_NULL' })
    deepStrictEqual([it.notices.length, it.defects], [before, []])
  }],
  ['an object made with no prototype is plain data, and is frozen like the rest', () => {
    const it = run()
    it.send({ type: 'KEEPS_A_BARE_OBJECT' })
    ok(Object.isFrozen(it.data().kept))
  }],
  ['a field that grows past ten thousand items is reported once, and one that holds ten thousand is not', () => {
    const it = run()
    const reported = (): string[] => it.large
    it.send({ type: 'GROWS', by: 10_000 })
    deepStrictEqual(reported(), [])
    it.send({ type: 'GROWS', by: 1 })
    strictEqual(reported().length, 1)
    ok(reported()[0]!.includes('10001 items in list'), reported()[0])
    it.send({ type: 'GROWS', by: 1 })
    strictEqual(reported().length, 1)
  }],
  ['editing a value that is not plain is reported and the value is untouched', () => {
    const it = run()
    it.send({ type: 'EDITS_AN_INSTANCE' })
    strictEqual(it.data().repository.directory, '/a')
    ok(it.defects.some((line) => line.includes('repository is not plain data')))
  }],
]

// ── moves between states inside states ─────────────────────────────────────────────────────────────────────────────

type Nest = {
  data: { count: number }
  states: {
    list: {}
    thread: {
      data: { threadId: string }
      states: {
        idle: { data: { draft?: string } }
        sending: { data: { sent: string; reply?: string }; states: { waiting: {}; done: {} } }
      }
    }
  }
}
type NestEvent =
  | { type: 'OPEN'; id: string }
  | { type: 'OPEN_WITH_A_DRAFT'; id: string; draft: string }
  | { type: 'OPEN_IDLE'; id: string }
  | { type: 'OPEN_DONE'; id: string }
  | { type: 'OPEN_WITH_A_STRAY_FIELD'; id: string }
  | { type: 'SEND_DONE' }
  | { type: 'SEND' }
  | { type: 'SEND_TO'; id: string }
  | { type: 'REOPEN' }
  | { type: 'JUMP' }
  | { type: 'GO_NOWHERE' }
  | { type: 'CLOSE' }
  | { type: 'COUNT_THE_SAME' }
const nest = (log: string[]) => state<Nest, NestEvent>()({
  data: { count: 0 },
  initial: 'list',
  on: {
    OPEN: ({ id }) => ({ at: 'thread', data: { threadId: id } }),
    // A field of the state the target starts at, given with the move.
    OPEN_WITH_A_DRAFT: ({ id, draft }) => ({ at: 'thread', data: { threadId: id, draft } }),
    // From outside thread to a state inside it.
    OPEN_IDLE: ({ id }) => ({ at: 'thread.idle', data: { threadId: id } }),
    OPEN_DONE: ({ id }) => ({ at: 'thread.sending.done', data: { threadId: id, sent: 'x' } }),
    // And to one three deep, without what thread needs.
    JUMP: () => ({ at: 'thread.sending.done', data: { sent: 'x' } }) as never,
    OPEN_WITH_A_STRAY_FIELD: ({ id }) => ({ at: 'thread', data: { threadId: id, extra: 1 } }) as never,
    CLOSE: () => ({ at: 'list' }),
    COUNT_THE_SAME: (_, { data }) => ({ data: { count: data.count } }),
  },
  states: {
    list: {},
    thread: {
      data: { threadId: given },
      run({ data, onExit }) { log.push(`entered thread ${data.threadId}`); onExit(() => { log.push('left thread') }) },
      on: {
        SEND: () => ({ at: 'thread.sending', data: { sent: 'hello' } }),
        SEND_DONE: () => ({ at: 'thread.sending.done', data: { sent: 'hello' } }),
        // A field of thread, which the move keeps, given with it.
        SEND_TO: ({ id }) => ({ at: 'thread.sending', data: { threadId: id, sent: 'hello' } }),
        // To thread itself, which is entered afresh, without what it needs.
        REOPEN: () => ({ at: 'thread' }) as never,
        GO_NOWHERE: () => ({ at: 'thread.nope.deeper' }) as never,
      },
      initial: 'idle',
      states: {
        idle: { data: { draft: '' }, run({ onExit }) { log.push('entered idle'); onExit(() => { log.push('left idle') }) } },
        sending: {
          data: { sent: given, reply: undefined as never },
          run({ onExit }) { log.push('entered sending'); onExit(() => { log.push('left sending') }) },
          initial: 'waiting',
          states: { waiting: {}, done: {} },
        },
      },
    },
  },
})
const nested = () => {
  const log: string[] = []
  const defects: string[] = []
  const told: Array<{ fields: string[]; changes: unknown }> = []
  const sys = system({ side: 'backend', trace: (line) => { if (line.startsWith('DEFECT')) defects.push(line) } })
  const handle = sys.start('s', nest(log))
  sys.subscribe((_, fields, changes) => { told.push({ fields: [...(fields.s ?? [])].sort(), changes: changes.s }) })
  return { log, defects, told, send: (event: NestEvent): void => sys.send(handle, event), now: () => sys.read(handle) as { at: string; data: Record<string, unknown> } }
}

/** A state with no states inside it. */
const flat = state<{ data: { n: number } }, { type: 'GO' } | { type: 'BUMP' }>()({ data: { n: 0 }, on: { GO: () => ({ at: 'away' }) as never, BUMP: (_, { data }) => ({ data: { n: data.n + 1 } }) } })

const moves: Array<[string, () => void]> = [
  ['a move by a state with no states inside it is refused, saying there is no such state', () => {
    const defects: string[] = []
    const sys = system({ side: 'backend', trace: (line) => { if (line.startsWith('DEFECT')) defects.push(line) } })
    const handle = sys.start('f', flat)
    sys.send(handle, { type: 'GO' })
    deepStrictEqual([sys.read(handle), defects], [{ data: { n: 0 } }, ['DEFECT: f has no state away to go to']])
  }],
  ['a state inside a state inside the top is at both: thread.idle', () => {
    const it = nested()
    it.send({ type: 'OPEN', id: 'a' })
    strictEqual(it.now().at, 'thread.idle')
    deepStrictEqual(it.log, ['entered thread a', 'entered idle'])
  }],
  ['a move between two states inside one keeps that one: its data and its work stay', () => {
    const it = nested()
    it.send({ type: 'OPEN', id: 'a' })
    it.log.length = 0
    it.send({ type: 'SEND' })
    strictEqual(it.now().at, 'thread.sending.waiting')
    deepStrictEqual(it.now().data, { count: 0, threadId: 'a', sent: 'hello', reply: undefined })
    deepStrictEqual(it.log, ['left idle', 'entered sending'])
    deepStrictEqual(it.defects, [])
  }],
  ['a move from outside a state to one inside it enters both, and one inside another it keeps enters only what it must', () => {
    const it = nested()
    it.send({ type: 'OPEN_IDLE', id: 'a' })
    strictEqual(it.now().at, 'thread.idle')
    it.log.length = 0
    it.send({ type: 'SEND_DONE' })
    strictEqual(it.now().at, 'thread.sending.done')
    deepStrictEqual(it.log, ['left idle', 'entered sending'])
    it.send({ type: 'CLOSE' })
    it.send({ type: 'OPEN_DONE', id: 'b' })
    deepStrictEqual([it.now().at, it.defects], ['thread.sending.done', []])
  }],
  ['a stray field given with a move to a state that starts somewhere is refused', () => {
    const it = nested()
    it.send({ type: 'OPEN_WITH_A_STRAY_FIELD', id: 'a' })
    strictEqual(it.now().at, 'list')
    deepStrictEqual(it.defects, ['DEFECT: s will have no field extra at thread'])
  }],
  ['leaving a state leaves the states inside it first', () => {
    const it = nested()
    it.send({ type: 'OPEN', id: 'a' })
    it.send({ type: 'SEND' })
    it.log.length = 0
    it.send({ type: 'CLOSE' })
    strictEqual(it.now().at, 'list')
    deepStrictEqual(it.log, ['left sending', 'left thread'])
  }],
  ['a move may give a field of a state it keeps', () => {
    const it = nested()
    it.send({ type: 'OPEN', id: 'a' })
    it.send({ type: 'SEND_TO', id: 'b' })
    deepStrictEqual([it.now().at, it.now().data.threadId, it.defects], ['thread.sending.waiting', 'b', []])
  }],
  ['a move may give a field of the state its target starts at', () => {
    const it = nested()
    it.send({ type: 'OPEN_WITH_A_DRAFT', id: 'a', draft: 'hi' })
    deepStrictEqual([it.now().at, it.now().data.draft, it.defects], ['thread.idle', 'hi', []])
  }],
  ['the state a move goes to is entered afresh, and needs what it needs again', () => {
    const it = nested()
    it.send({ type: 'OPEN', id: 'a' })
    it.send({ type: 'REOPEN' })
    strictEqual(it.now().at, 'thread.idle')
    deepStrictEqual(it.defects, ['DEFECT: s cannot enter thread without threadId'])
  }],
  ['a move into a state inside another that is not the case needs what that one needs', () => {
    const it = nested()
    it.send({ type: 'JUMP' })
    strictEqual(it.now().at, 'list')
    deepStrictEqual(it.defects, ['DEFECT: s cannot enter thread without threadId'])
  }],
  ['a move to a state that is not there names the first part of the path that is not', () => {
    const it = nested()
    it.send({ type: 'OPEN', id: 'a' })
    it.send({ type: 'GO_NOWHERE' })
    strictEqual(it.now().at, 'thread.idle')
    deepStrictEqual(it.defects, ['DEFECT: s has no state thread.nope to go to'])
  }],
  ['a subscriber that unsubscribes is told no more, and the others go on being told, however often it does', () => {
    const sys = system({ side: 'backend' })
    const handle = sys.start('f', flat)
    const told: string[] = []
    const first = sys.subscribe(() => { told.push('first') })
    const second = sys.subscribe(() => { told.push('second') })
    sys.subscribe(() => { told.push('third') })
    first()
    second()
    second()
    sys.send(handle, { type: 'BUMP' })
    deepStrictEqual(told, ['third'])
  }],
  ['a subscriber is told a state moved, and the fields it gained, lost or changed, and no others', () => {
    const it = nested()
    it.send({ type: 'OPEN', id: 'a' })
    deepStrictEqual(it.told.at(-1), { fields: ['draft', 'threadId'], changes: { moved: true, pending: false, armed: false } })
    it.send({ type: 'SEND_TO', id: 'b' })
    // reply is gained though what it holds is undefined.
    deepStrictEqual(it.told.at(-1), { fields: ['draft', 'reply', 'sent', 'threadId'], changes: { moved: true, pending: false, armed: false } })
    const before = it.told.length
    it.send({ type: 'COUNT_THE_SAME' })
    strictEqual(it.told.length, before, 'a field given the value it holds is not a change')
  }],
  ['inherited prototype names and non-object data payloads are refused cleanly', () => {
    const defects: string[] = []
    const sys = system({ side: 'backend', trace: (line) => { if (line.startsWith('DEFECT')) defects.push(line) } })
    const s = state<{ data: { count: number } }, { type: 'PROTO' } | { type: 'NULL_DATA' } | { type: 'ARR_DATA' }>()({
      data: { count: 0 },
      on: {
        PROTO: () => ({ data: { toString: 'bad' } as never }),
        NULL_DATA: () => ({ data: null as never }),
        ARR_DATA: () => ({ data: [] as never }),
      },
    })
    const handle = sys.start('s', s)
    sys.send(handle, { type: 'PROTO' })
    sys.send(handle, { type: 'NULL_DATA' })
    sys.send(handle, { type: 'ARR_DATA' })
    strictEqual(sys.read(handle).data.count, 0)
    strictEqual(Object.hasOwn(sys.read(handle).data, 'toString'), false)
    strictEqual(defects.length, 3)
    ok(defects[0]!.includes('has no field toString'))
    ok(defects[1]!.includes('non-object'))
    ok(defects[2]!.includes('non-object'))
  }],
  ['a move whose target starts at a substate with a missing given field is refused cleanly', () => {
    const defects: string[] = []
    const sys = system({ side: 'backend', trace: (line) => { if (line.startsWith('DEFECT')) defects.push(line) } })
    const badStartMove = {
      def: {
        initial: 'a',
        on: { GO: () => ({ at: 'b' }) },
        states: {
          a: {},
          b: { initial: 'inner', states: { inner: { data: { req: given } } } },
        },
      },
    }
    const handle = sys.start('m', badStartMove as never)
    sys.send(handle as never, { type: 'GO' } as never)
    strictEqual((sys.read(handle as never) as { at: string }).at, 'a')
    deepStrictEqual(defects, ['DEFECT: m cannot enter b.inner without req'])
  }],
  ['an error thrown by a nested transact propagates instead of being swallowed as rollback', () => {
    let depth = 0
    const sys = system({
      side: 'backend',
      transact: (fn) => {
        depth++
        try {
          if (depth === 2) throw new Error('nested db broken')
          return fn()
        } finally { depth-- }
      },
    })
    const handle = sys.start('f', flat)
    throws(() => sys.send(handle, { type: 'BUMP' }), /nested db broken/)
  }],
  ['start, stop, and log re-entrancy during flush defer to the next step without inverting StepLog order', () => {
    const logged: Array<{ number: number; refs: string[] }> = []
    let onLogAction: (() => void) | undefined
    const sys = system({
      side: 'backend',
      log: (step) => {
        logged.push({ number: step.number, refs: Object.keys(step.changed) })
        const fn = onLogAction
        onLogAction = undefined
        fn?.()
      },
    })
    const a = sys.start('a', flat)
    let mode: 'none' | 'start' | 'stop' = 'start'
    let startedHandle: typeof a | undefined
    sys.subscribe(() => {
      if (mode === 'start') {
        mode = 'none'
        startedHandle = sys.start('b', flat)
        // Duplicate start of an already-queued ref must still be refused synchronously.
        throws(() => sys.start('b', flat), /already has a running state named b/)
        // Sending to the handle returned by queued start delivers after `b` begins.
        sys.send(startedHandle, { type: 'BUMP' })
      } else if (mode === 'stop') {
        mode = 'none'
        sys.stop()
      }
    })
    sys.send(a, { type: 'BUMP' })
    strictEqual(sys.read(startedHandle!).data.n, 1)
    // Causal order: #1 start a, #2 bump a, #3 start b, #4 bump b.
    deepStrictEqual(logged, [
      { number: 1, refs: ['a'] },
      { number: 2, refs: ['a'] },
      { number: 3, refs: ['b'] },
      { number: 4, refs: ['b'] },
    ])

    // Re-entrant send from inside host.log also preserves causal StepLog order.
    onLogAction = () => sys.send(startedHandle!, { type: 'BUMP' })
    sys.send(a, { type: 'BUMP' })
    deepStrictEqual(logged.slice(4), [
      { number: 5, refs: ['a'] },
      { number: 6, refs: ['b'] },
    ])

    // Re-entrant stop from a subscriber defers until after the triggering step flushes and logs.
    mode = 'stop'
    sys.send(a, { type: 'BUMP' })
    deepStrictEqual(sys.snapshot(), {})
    deepStrictEqual(logged.slice(6), [
      { number: 7, refs: ['a'] },
      { number: 8, refs: ['b', 'a'] },
    ])

    // After stopping, `b` can be started again (the `starting` reservation was cleared).
    const b2 = sys.start('b', flat)
    strictEqual(sys.read(b2).data.n, 0)

    // If host.transact throws before running `start`, the `starting` reservation is cleared so retrying succeeds.
    let failOnce = true
    const flaky = system({
      side: 'backend',
      transact: (fn) => {
        if (failOnce) { failOnce = false; throw new Error('db unavailable') }
        return fn()
      },
    })
    throws(() => flaky.start('retry', flat), /db unavailable/)
    const okHandle = flaky.start('retry', flat)
    strictEqual(flaky.read(okHandle).data.n, 0)
  }],
  ['plain-object replacement traces LARGE once per running instance and resets when restarted', () => {
    const largeLines: string[] = []
    const sys = system({ side: 'backend', trace: (line) => { if (line.startsWith('LARGE')) largeLines.push(line) } })
    const big = Array.from({ length: 10_001 }, (_, i) => i)
    const holder = state<{ data: { items: number[] } }, { type: 'SET'; items: number[] }>()({
      data: { items: [] },
      on: { SET: ({ items }) => ({ data: { items } }) },
    })
    const h1 = sys.start('holder', holder)
    sys.send(h1, { type: 'SET', items: big })
    sys.send(h1, { type: 'SET', items: [...big, 10_001] })
    strictEqual(largeLines.length, 1)
    ok(largeLines[0]!.includes('holder holds 10001 items in items'))
    sys.stop()
    // Starting a fresh instance traces LARGE again (reported state is scoped to the Running instance, not leaked).
    const h2 = sys.start('holder', holder)
    sys.send(h2, { type: 'SET', items: big })
    strictEqual(largeLines.length, 2)
  }],
  ['rolling back inside-queue items while earlier items remain preserves FIFO order and resets cleanly when emptied', () => {
    const seen: string[] = []
    const sys = system({ side: 'backend' })
    const actor = state<{}, { type: 'START' } | { type: 'FAIL_AND_QUEUE' } | { type: 'NOTE'; tag: string }>()({
      on: {
        START: (_, { raise }) => {
          raise({ type: 'FAIL_AND_QUEUE' })
          raise({ type: 'NOTE', tag: 'after-fail' })
        },
        FAIL_AND_QUEUE: (_, { raise }) => {
          raise({ type: 'NOTE', tag: 'rolled-back' })
          throw new Error('undo me')
        },
        NOTE: ({ tag }) => { seen.push(tag) },
      },
    })
    const h = sys.start('a', actor)
    sys.send(h, { type: 'START' })
    deepStrictEqual(seen, ['after-fail'])
    // Also verify when the rolled-back handler was the last item in `inside` (`head === items.length` after `cut`).
    seen.length = 0
    sys.send(h, { type: 'FAIL_AND_QUEUE' })
    sys.send(h, { type: 'NOTE', tag: 'next-step' })
    deepStrictEqual(seen, ['next-step'])
  }],
  ['a move supplying data for an inner substate does not expose that field to an enclosing state run() before the inner state is entered', () => {
    const outerSawKeys: string[][] = []
    const nested = state<{
      states: {
        idle: {}
        outer: {
          states: {
            a: {}
            inner: { data: { secret: string } }
          }
        }
      }
    }, { type: 'ENTER' }>()({
      initial: 'idle',
      states: {
        idle: {
          on: { ENTER: () => ({ at: 'outer.inner', data: { secret: 'shh' } }) },
        },
        outer: {
          initial: 'a',
          run({ data }) { outerSawKeys.push(Object.keys(data)) },
          states: {
            a: {},
            inner: { data: { secret: given } },
          },
        },
      },
    })
    const sys = system({ side: 'backend' })
    const h = sys.start('nested', nested)
    sys.send(h, { type: 'ENTER' })
    deepStrictEqual(outerSawKeys, [[]])
    strictEqual(sys.read(h).at, 'outer.inner')
    deepStrictEqual(sys.read(h).data, { secret: 'shh' })
  }],
  ['data changed in a handler is frozen before a subsequent handler in the same step reads it', () => {
    const frozenChecks: Array<{ top: boolean; nested: boolean }> = []
    const netState = forNet<{ systems: { self: { events: { type: 'SECOND' }; asks: {} } }; views: {}; surfaces: {} }>()
    const chained = netState<{ data: { items: number[] } }, { type: 'FIRST' } | { type: 'SECOND' }>()({
      data: { items: [] },
      on: {
        FIRST: (_, { tell }) => {
          tell('self', { type: 'SECOND' })
          return { data: { items: [1, 2] } }
        },
        SECOND: (_, { data }) => {
          frozenChecks.push({ top: Object.isFrozen(data), nested: Object.isFrozen(data.items) })
        },
      },
    })
    const sys = system({ side: 'backend' })
    const h = sys.start('self', chained)
    sys.send(h, { type: 'FIRST' })
    deepStrictEqual(frozenChecks, [{ top: true, nested: true }])
  }],
  ['nested states that shadow an enclosing data field are refused at start, while sibling states may share field names', () => {
    const sys = system({ side: 'backend' })
    const directShadow = {
      def: {
        data: { error: null },
        initial: 'clean',
        states: {
          clean: {},
          a: { data: { error: '' } },
        },
      },
    }
    throws(() => sys.start('direct', directShadow as never), /direct declares error again at a, shadowing an enclosing state/)
    strictEqual('direct' in sys.snapshot(), false)

    const deepShadow = {
      def: {
        data: { error: null },
        initial: 'mid',
        states: {
          mid: {
            initial: 'leaf',
            states: {
              leaf: { data: { error: '' } },
            },
          },
        },
      },
    }
    throws(() => sys.start('deep', deepShadow as never), /deep declares error again at mid\.leaf, shadowing an enclosing state/)
    strictEqual('deep' in sys.snapshot(), false)

    // Sibling states sharing a field name are allowed and transition cleanly without losing enclosing data.
    const siblings = state<{
      data: { id: string }
      states: { idle: {}; a: { data: { note: string } }; b: { data: { note: number } } }
    }, { type: 'TO_A' } | { type: 'TO_B' }>()({
      data: { id: 'ok' },
      initial: 'idle',
      states: {
        idle: { on: { TO_A: () => ({ at: 'a', data: { note: 'hi' } }) } },
        a: { data: { note: '' }, on: { TO_B: () => ({ at: 'b', data: { note: 7 } }) } },
        b: { data: { note: 0 } },
      },
    })
    const sh = sys.start('sib', siblings)
    sys.send(sh, { type: 'TO_A' })
    deepStrictEqual(sys.read(sh), { at: 'a', data: { id: 'ok', note: 'hi' } })
    sys.send(sh, { type: 'TO_B' })
    deepStrictEqual(sys.read(sh), { at: 'b', data: { id: 'ok', note: 7 } })
  }],
  ['given and answered markers use Symbol.for keys so cross-bundle copies agree', () => {
    strictEqual(given, Symbol.for('@apackdev/state/given'))
    strictEqual(Object.hasOwn(answered(1, {}), Symbol.for('@apackdev/state/answered')), true)
  }],
  ['forNet(resolve) resolves bare targets per state across tell, surface, broadcast, ask, loads, calls, follows, and started children without altering handles or peers', async () => {
    type SvcAsks = { PING: { args: {}; answer: string }; SAVE: { args: {}; answer: string } }
    type NetA = {
      systems: { svc: { events: { type: 'NOTE'; from: string }; asks: SvcAsks }; 'packB/svc': { events: { type: 'NOTE'; from: string }; asks: SvcAsks } }
      surfaces: { panel: { events: { type: 'BCAST'; text: string } }; other: { events: { type: 'PINGED'; text: string } } }
      views: { docs: { all: { args: {}; result: string } } }
      peers: { 'role:brain': { events: { type: 'THINK'; prompt: string } } }
    }
    type NetB = {
      systems: { svc: { events: { type: 'NOTE'; from: string }; asks: SvcAsks } }
      surfaces: {}
      views: {}
    }
    const resolveA = (name: string): string => (name.includes('/') ? name : `packA/${name}`)
    const resolveB = (name: string): string => (name.includes('/') ? name : `packB/${name}`)
    const stateA = forNet<NetA>(resolveA)
    const stateB = forNet<NetB>(resolveB)

    const notesA: string[] = []
    const notesB: string[] = []
    const peerEvents: Array<{ to: string; event: unknown }> = []
    const followedFeatures: string[] = []

    const svcA = stateA<{}, { type: 'NOTE'; from: string }, SvcAsks>()({
      on: { NOTE: ({ from }, { broadcast }) => { notesA.push(from); broadcast('panel', { type: 'BCAST', text: `from-${from}` }) } },
      answers: {
        PING: () => 'pongA',
        SAVE: () => 'savedA',
      },
    })
    const svcB = stateB<{}, { type: 'NOTE'; from: string }, SvcAsks>()({
      on: { NOTE: ({ from }) => { notesB.push(from) } },
      answers: {
        PING: () => 'pongB',
        SAVE: () => 'savedB',
      },
    })

    // Started children built with Pack B's resolver (bare, one-with-given, each-with-given) inside a Pack A parent.
    const bareChildB = stateB<{}, { type: 'FIRE' }, { GET: { args: {}; answer: string } }>()({
      on: { FIRE: (_, { tell }) => { tell('svc', { type: 'NOTE', from: 'bareB' }) } },
      answers: { GET: () => 'childB-handle' },
    })
    const givenChildB = stateB<{ data: { tag: string } }, never>()({
      data: { tag: given },
      run: ({ data, tell }) => { tell('svc', { type: 'NOTE', from: data.tag }) },
    })

    const panel = stateA<{
      data: { keys: string[]; loaded: string; called: string; asked: string; childAsked: string; viewVal: string; bcast: string[] }
      starts: { bareB: typeof bareChildB; oneB: typeof givenChildB; eachB: Each<typeof givenChildB> }
      calls: { save: 'single' }
    }, { type: 'GO' } | { type: 'BCAST'; text: string }>()({
      data: { keys: ['k1'], loaded: '', called: '', asked: '', childAsked: '', viewVal: '', bcast: [] },
      starts: (start) => ({
        bareB: bareChildB,
        oneB: start(givenChildB, { given: () => ({ tag: 'oneB' }) }),
        eachB: start(givenChildB, { each: 'keys', given: (k) => ({ tag: `eachB:${k}` }) }),
      }),
      follows: (follow) => ({
        docs: follow('docs', 'all', {
          updated: (u) => (u.ok ? { data: { viewVal: u.value } } : undefined),
        }),
      }),
      loads: (load) => ({
        ping: load('svc', 'PING', {
          done: (o) => (o.ok ? { data: { loaded: o.value } } : undefined),
        }),
      }),
      calls: ({ single }) => ({
        save: single('svc', 'SAVE', {
          done: (o) => (o.ok ? { data: { called: o.value } } : undefined),
        }),
      }),
      run: async ({ ask, child }) => {
        const [a, c] = await Promise.all([ask('svc', 'PING', {}), ask(child('bareB'), 'GET', {})])
        return { data: { asked: a.ok ? a.value : '', childAsked: c.ok ? c.value : '' } }
      },
      failed: () => {},
      on: {
        GO: (_, { tell, call, child }) => {
          tell('svc', { type: 'NOTE', from: 'panel' })
          tell('packB/svc', { type: 'NOTE', from: 'qualified' })
          tell(child('bareB'), { type: 'FIRE' })
          tell({ surface: 'other' }, { type: 'PINGED', text: 'hi' })
          tell({ peer: 'role:brain' }, { type: 'THINK', prompt: 'go' })
          call('save')
        },
        BCAST: ({ text }, { data }) => ({ data: { bcast: [...data.bcast, text] } }),
      },
    })

    const otherHeard: string[] = []
    const other = stateA<{}, { type: 'PINGED'; text: string }>()({
      on: { PINGED: ({ text }) => { otherHeard.push(text) } },
    })

    const backendLogs: StepLog[] = []
    const backend = system({
      side: 'backend',
      log: (step) => backendLogs.push(step),
      views: (feature, _view, _args, updated) => {
        followedFeatures.push(feature)
        updated({ ok: true, value: `view:${feature}` })
        return () => {}
      },
    })
    backend.start('packA/svc', svcA)
    backend.start('packB/svc', svcB)

    const win = system({ side: 'window' })
    win.peer('role:brain', { tell: (to, event) => { peerEvents.push({ to, event }) } })
    connect(win, backend)
    const panelH = win.start('packA/panel', panel)
    win.start('packA/other', other)
    win.send(panelH, { type: 'GO' })
    await rest()

    deepStrictEqual(notesA, ['panel'])
    deepStrictEqual([...notesB].sort(), ['bareB', 'eachB:k1', 'oneB', 'qualified'])
    deepStrictEqual(otherHeard, ['hi'])
    deepStrictEqual(peerEvents, [{ to: 'role:brain', event: { type: 'THINK', prompt: 'go' } }])
    deepStrictEqual(followedFeatures, ['packA/docs'])
    deepStrictEqual(win.read(panelH).data, {
      keys: ['k1'],
      loaded: 'pongA',
      called: 'savedA',
      asked: 'pongA',
      childAsked: 'childB-handle',
      viewVal: 'view:packA/docs',
      bcast: ['from-panel'],
    })
    // StepLog records resolved broadcast target (`packA/panel`).
    ok(backendLogs.some((s) => s.sent.some((e) => e.kind === 'broadcast' && e.to === 'packA/panel')))
    win.stop()
    backend.stop()
  }],
  ['forNet(resolve) isolates throwing and invalid resolvers across tell, surface, broadcast, ask, follows, loads, and calls without corrupting pending or awaiting', async () => {
    type SvcAsks = { PING: { args: {}; answer: string }; SAVE: { args: {}; answer: string } }
    type Net = {
      systems: {
        badThrow: { events: { type: 'GO' }; asks: SvcAsks }
        badEmpty: { events: { type: 'GO' }; asks: SvcAsks }
        badType: { events: { type: 'GO' }; asks: SvcAsks }
        good: { events: { type: 'GO' }; asks: SvcAsks }
      }
      surfaces: {
        badSurf: { events: { type: 'HI' } }
        goodSurf: { events: { type: 'HI' } }
      }
      views: {
        badView: { all: { args: {}; result: string } }
        goodView: { all: { args: {}; result: string } }
      }
    }
    const resolver = (name: string): string => {
      if (name === 'badThrow' || name === 'badSurf' || name === 'badView') throw new Error(`boom:${name}`)
      if (name === 'badEmpty') return ''
      if (name === 'badType') return 123 as unknown as string
      return `pack/${name}`
    }
    const netState = forNet<Net>(resolver)

    const goodTells: string[] = []
    const goodBroadcasts: string[] = []
    const goodSurfTells: string[] = []
    const followedFeatures: string[] = []
    const defects: Defect[] = []

    const goodSvc = netState<{}, { type: 'GO' }, SvcAsks>()({
      on: { GO: () => { goodTells.push('good') } },
      answers: {
        PING: () => 'pong',
        SAVE: () => 'saved',
      },
    })
    const broadcaster = netState<{}, { type: 'SEND_BOTH' }>()({
      on: {
        SEND_BOTH: (_, { broadcast }) => {
          broadcast('badSurf', { type: 'HI' })
          broadcast('goodSurf', { type: 'HI' })
        },
      },
    })
    const goodSurf = netState<{}, { type: 'HI' }>()({
      on: { HI: () => { goodBroadcasts.push('HI'); goodSurfTells.push('HI') } },
    })

    let askOutcome: unknown
    let capturedAsk: ((to: 'badThrow', name: 'PING', args: {}) => Promise<unknown>) | undefined
    let brokenFollowUpdates = 0
    let brokenLoadArgs = 0
    let brokenLoadDone = 0
    const panel = netState<{
      data: { goodView: string; goodLoad: string; goodCall: string; rev: number }
      calls: { badCall: 'single'; emptyCall: 'single'; goodCall: 'single' }
    }, { type: 'FIRE' } | { type: 'BUMP' }>()({
      data: { goodView: '', goodLoad: '', goodCall: '', rev: 0 },
      follows: (follow) => ({
        broken: follow('badView', 'all', { updated: () => { brokenFollowUpdates += 1; return undefined } }),
        healthy: follow('goodView', 'all', { updated: (u) => (u.ok ? { data: { goodView: u.value } } : undefined) }),
      }),
      loads: (load) => ({
        broken: load('badThrow', 'PING', { from: ['rev'], args: () => { brokenLoadArgs += 1; return {} }, done: () => { brokenLoadDone += 1; return undefined } }),
        empty: load('badEmpty', 'PING', { from: ['rev'], args: () => { brokenLoadArgs += 1; return {} }, done: () => { brokenLoadDone += 1; return undefined } }),
        healthy: load('good', 'PING', { from: ['rev'], done: (o) => (o.ok ? { data: { goodLoad: o.value } } : undefined) }),
      }),
      calls: ({ single }) => ({
        badCall: single('badThrow', 'SAVE', { done: () => undefined }),
        emptyCall: single('badEmpty', 'SAVE', { done: () => undefined }),
        goodCall: single('good', 'SAVE', { done: (o) => (o.ok ? { data: { goodCall: o.value } } : undefined) }),
      }),
      run: async ({ ask }) => {
        capturedAsk = ask as typeof capturedAsk
        askOutcome = await ask('badThrow', 'PING', {})
      },
      failed: () => {},
      on: {
        FIRE: (_, { tell, call }) => {
          tell('badThrow', { type: 'GO' })
          tell('badEmpty', { type: 'GO' })
          tell('badType', { type: 'GO' })
          tell({ surface: 'badSurf' }, { type: 'HI' })
          tell('good', { type: 'GO' })
          tell({ surface: 'goodSurf' }, { type: 'HI' })
          call('badCall')
          call('emptyCall')
          call('goodCall')
        },
        BUMP: (_, { data }) => ({ data: { rev: data.rev + 1 } }),
      },
    })

    const backendSteps: StepLog[] = []
    const winSteps: StepLog[] = []
    const backend = system({
      side: 'backend',
      onDefect: (d) => defects.push(d),
      log: (step) => backendSteps.push(step),
      views: (feature, _view, _args, updated) => {
        followedFeatures.push(feature)
        updated({ ok: true, value: `v:${feature}` })
        return () => {}
      },
    })
    backend.start('pack/good', goodSvc)
    const bH = backend.start('pack/broadcaster', broadcaster)

    const win = system({
      side: 'window',
      onDefect: (d) => defects.push(d),
      log: (step) => winSteps.push(step),
    })
    connect(win, backend)
    win.start('pack/goodSurf', goodSurf)
    const panelH = win.start('pack/panel', panel)
    win.send(panelH, { type: 'FIRE' })
    backend.send(bH, { type: 'SEND_BOTH' })
    await rest()

    // Healthy siblings all ran cleanly despite broken resolver targets alongside them.
    deepStrictEqual(followedFeatures, ['pack/goodView'])
    deepStrictEqual(goodTells, ['good'])
    strictEqual(goodSurfTells.length, 2) // 1 surface tell + 1 broadcast
    strictEqual(win.read(panelH).data.goodView, 'v:pack/goodView')
    strictEqual(win.read(panelH).data.goodLoad, 'pong')
    strictEqual(win.read(panelH).data.goodCall, 'saved')
    // Failed resolutions never dispatched follow, load, broadcast, or surface-tell operations.
    strictEqual(brokenFollowUpdates, 0)
    strictEqual(brokenLoadArgs, 0)
    strictEqual(brokenLoadDone, 0)
    const allSent = [...backendSteps, ...winSteps].flatMap((s) => s.sent)
    deepStrictEqual(allSent.filter((s) => 'to' in s && s.to === undefined), [])
    deepStrictEqual(backendSteps.flatMap((s) => s.sent).filter((s) => s.kind === 'broadcast'), [
      { kind: 'broadcast', to: 'pack/goodSurf', name: 'HI' },
    ])
    deepStrictEqual(winSteps.flatMap((s) => s.sent).filter((s) => s.kind === 'follow'), [
      { kind: 'follow', to: 'pack/goodView', name: 'all' },
    ])
    const allHandled = [...backendSteps, ...winSteps].flatMap((s) => s.handled)
    deepStrictEqual(allHandled.filter((h) => 'ref' in h && h.ref === undefined), [])
    // Failed calls never poisoned pending state.
    strictEqual(win.read(panelH).pending.badCall, false)
    strictEqual(win.read(panelH).pending.emptyCall, false)
    strictEqual(win.read(panelH).pending.goodCall, false)
    // ask() with a failing resolver resolves cleanly to a failed outcome instead of throwing.
    deepStrictEqual(askOutcome, { ok: false, failure: { kind: 'failed', message: 'Could not resolve badThrow' } })
    // Structured defects were reported for throwing, empty, and non-string resolver outcomes.
    ok(defects.some((d) => d.message.includes('boom:badThrow')), JSON.stringify(defects))
    ok(defects.some((d) => d.message.includes('boom:badSurf')), JSON.stringify(defects))
    ok(defects.some((d) => d.message.includes('boom:badView')), JSON.stringify(defects))
    ok(defects.some((d) => d.message.includes('badEmpty') && d.message.includes('non-empty string')), JSON.stringify(defects))
    ok(defects.some((d) => d.message.includes('badType') && d.message.includes('non-empty string')), JSON.stringify(defects))

    // Triggering another match pass on loads still skips broken loads cleanly without corrupting awaiting.
    win.send(panelH, { type: 'BUMP' })
    await rest()
    strictEqual(win.read(panelH).data.rev, 1)
    strictEqual(win.read(panelH).data.goodLoad, 'pong')
    win.stop()
    // Calling a captured ask after work has aborted rejects with Cancelled without invoking the resolver or logging a defect.
    const defectsBeforeCancelledAsk = defects.length
    let cancelledError: unknown
    try { await capturedAsk!('badThrow', 'PING', {}) } catch (error) { cancelledError = error }
    ok(cancelledError instanceof Cancelled, String(cancelledError))
    strictEqual(defects.length, defectsBeforeCancelledAsk)
    backend.stop()
  }],
  ['forNet(resolve) memoizes resolved targets per running state instance for its lifetime', async () => {
    type Net = {
      systems: { svc: { events: { type: 'PING'; tag: string }; asks: { SAVE: { args: {}; answer: string } } } }
      surfaces: { panel: { events: { type: 'NOTE'; tag: string } } }
      views: { docs: { all: { args: {}; result: string } } }
    }
    let epoch = 1
    const invocations = new Map<string, number>()
    const unstable = (name: string): string => {
      invocations.set(name, (invocations.get(name) ?? 0) + 1)
      return `epoch${epoch}/${name}`
    }
    const netState = forNet<Net>(unstable)

    const seen: string[] = []
    const svc = (label: string) => netState<{}, { type: 'PING'; tag: string }, { SAVE: { args: {}; answer: string } }>()({
      on: { PING: ({ tag }) => { seen.push(`${label}:${tag}`) } },
      answers: { SAVE: () => label },
    })
    const caller = netState<{ data: { rev: number; saved: string[] }; calls: { save: 'many' } }, { type: 'STEP'; tag: string }>()({
      data: { rev: 0, saved: [] },
      follows: (follow) => ({
        docs: follow('docs', 'all', { from: ['rev'], updated: () => undefined }),
      }),
      calls: ({ many }) => ({
        save: many('svc', 'SAVE', { done: (o, { data }) => (o.ok ? { data: { saved: [...data.saved, o.value] } } : undefined) }),
      }),
      on: {
        STEP: ({ tag }, { data, tell, broadcast, call }) => {
          tell('svc', { type: 'PING', tag })
          broadcast('panel', { type: 'NOTE', tag })
          call('save')
          return { data: { rev: data.rev + 1 } }
        },
      },
    })

    const followed: string[] = []
    const sys = system({
      side: 'backend',
      views: (feature, _view, _args, updated) => {
        followed.push(feature)
        updated({ ok: true, value: feature })
        return () => {}
      },
    })
    sys.start('epoch1/svc', svc('epoch1'))
    sys.start('epoch2/svc', svc('epoch2'))

    const h1 = sys.start('caller1', caller)
    sys.send(h1, { type: 'STEP', tag: 'one' })
    await rest()

    // Flip the unstable resolver's output: h1 must keep using its memoized epoch1 targets without re-invoking unstable.
    epoch = 2
    sys.send(h1, { type: 'STEP', tag: 'two' })
    await rest()

    deepStrictEqual(seen, ['epoch1:one', 'epoch1:two'])
    deepStrictEqual(sys.read(h1).data.saved, ['epoch1', 'epoch1'])
    deepStrictEqual(followed, ['epoch1/docs', 'epoch1/docs', 'epoch1/docs'])
    strictEqual(invocations.get('svc'), 1)
    strictEqual(invocations.get('panel'), 1)
    strictEqual(invocations.get('docs'), 1)

    // A fresh running state instance gets its own memo table and resolves under epoch2.
    const h2 = sys.start('caller2', caller)
    sys.send(h2, { type: 'STEP', tag: 'three' })
    await rest()

    deepStrictEqual(seen, ['epoch1:one', 'epoch1:two', 'epoch2:three'])
    deepStrictEqual(sys.read(h2).data.saved, ['epoch2'])
    strictEqual(invocations.get('svc'), 2)
    sys.stop()
  }],
]

await runChecks([...checks, ...moves])
