// What the kernel does with a change to data. Each check drives a running state and reads what came of it.
//
//   npx vitest run kernel
import { readFileSync } from 'node:fs'
import { deepStrictEqual, ok, strictEqual, throws } from 'node:assert'
import { run as runChecks, system } from './checks.mts'
import { given, reaching } from '../src/index.ts'
import { said, WROTE_TO_WHAT_WAS_READ } from '../src/kernel.ts'

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

const state = reaching()
const made = state<Shape, Event>()({
  data: { titles: {}, messages: {}, count: 0, repository: new Repository('/a'), kept: null, list: [] },
  start: 'list',
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
    const line = readFileSync(import.meta.filename, 'utf8').split('\n').findIndex((each) => each.includes('ADD_A_FIELD:       () =>')) + 1
    ok(it.defects[0]!.endsWith(`There is no field extra to change (kernel-check.mts:${line})`), it.defects[0])
  }],
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
      ok(line?.includes(WROTE_TO_WHAT_WAS_READ), `${type}: ${line}`)
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
      ok(said(thrown).endsWith(WROTE_TO_WHAT_WAS_READ), `${name}: ${(thrown as Error).message}`)
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
  start: 'list',
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
      run({ data, use }) { log.push(`entered thread ${data.threadId}`); use(() => { log.push('left thread') }) },
      on: {
        SEND: () => ({ at: 'thread.sending', data: { sent: 'hello' } }),
        SEND_DONE: () => ({ at: 'thread.sending.done', data: { sent: 'hello' } }),
        // A field of thread, which the move keeps, given with it.
        SEND_TO: ({ id }) => ({ at: 'thread.sending', data: { threadId: id, sent: 'hello' } }),
        // To thread itself, which is entered afresh, without what it needs.
        REOPEN: () => ({ at: 'thread' }) as never,
        GO_NOWHERE: () => ({ at: 'thread.nope.deeper' }) as never,
      },
      start: 'idle',
      states: {
        idle: { data: { draft: '' }, run({ use }) { log.push('entered idle'); use(() => { log.push('left idle') }) } },
        sending: {
          data: { sent: given, reply: undefined as never },
          run({ use }) { log.push('entered sending'); use(() => { log.push('left sending') }) },
          start: 'waiting',
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
const flat = state<{ data: { n: number } }, { type: 'GO' }>()({ data: { n: 0 }, on: { GO: () => ({ at: 'away' }) as never } })

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
  ['a subscriber is told a state moved, and the fields it gained, lost or changed, and no others', () => {
    const it = nested()
    it.send({ type: 'OPEN', id: 'a' })
    deepStrictEqual(it.told.at(-1), { fields: ['draft', 'threadId'], changes: { moved: true, making: false } })
    it.send({ type: 'SEND_TO', id: 'b' })
    // reply is gained though what it holds is undefined.
    deepStrictEqual(it.told.at(-1), { fields: ['draft', 'reply', 'sent', 'threadId'], changes: { moved: true, making: false } })
    const before = it.told.length
    it.send({ type: 'COUNT_THE_SAME' })
    strictEqual(it.told.length, before, 'a field given the value it holds is not a change')
  }],
]

await runChecks([...checks, ...moves])
