// What a draft has to get right. Each check is a way a hand-built one goes wrong.
//
//   npx vitest run draft
import { deepStrictEqual, notStrictEqual, ok, strictEqual, throws } from 'node:assert'
import { run } from './checks.mts'
import { produce } from '../src/draft.ts'

const freeze = <T,>(value: T): T => {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) { Object.freeze(value); for (const inner of Object.values(value)) freeze(inner) }
  return value
}
const paths = (touched: ReadonlyArray<ReadonlyArray<string>>): string[] => touched.map((path) => path.join('.')).sort()

const checks: Array<[string, () => void]> = [
  ['a nested edit makes a new value and leaves the old one alone', () => {
    const base = freeze({ titles: { a: 'A' }, messages: { a: ['one'] }, count: 1 })
    const { value } = produce(base, (draft) => { draft.titles.a = 'B' })
    deepStrictEqual(value, { titles: { a: 'B' }, messages: { a: ['one'] }, count: 1 })
    strictEqual(base.titles.a, 'A')
  }],
  ['what was not edited is the same object as before', () => {
    const base = freeze({ titles: { a: 'A' }, messages: { a: ['one'] } })
    const { value } = produce(base, (draft) => { draft.titles.a = 'B' })
    strictEqual(value.messages, base.messages)
    notStrictEqual(value.titles, base.titles)
    notStrictEqual(value, base)
  }],
  ['an edit that changes nothing returns the very same value', () => {
    const base = freeze({ titles: { a: 'A' }, list: [1, 2] })
    const same = produce(base, (draft) => { draft.titles.a = 'A'; void draft.list[0] })
    strictEqual(same.value, base)
    deepStrictEqual(same.touched, [])
  }],
  ['reading the same place twice gives the same draft', () => {
    produce({ a: { b: { c: 1 } } }, (draft) => { strictEqual(draft.a, draft.a); strictEqual(draft.a.b, draft.a.b) })
  }],
  ['an edit through one reading is seen through another', () => {
    const { value } = produce(freeze({ a: { n: 1 } }), (draft) => { const first = draft.a; const second = draft.a; first.n = 2; strictEqual(second.n, 2) })
    deepStrictEqual(value, { a: { n: 2 } })
  }],
  ['an edit deep inside reaches the top', () => {
    const base = freeze({ a: { b: { c: { d: 1 } } }, other: {} })
    const { value } = produce(base, (draft) => { draft.a.b.c.d = 2 })
    strictEqual(value.a.b.c.d, 2)
    strictEqual(value.other, base.other)
  }],
  ['arrays: push, index assignment, splice, sort and length', () => {
    const base = freeze({ list: [3, 1, 2], rows: [{ n: 1 }, { n: 2 }] })
    const { value } = produce(base, (draft) => {
      draft.list.push(4)
      draft.list[0] = 9
      draft.list.splice(1, 1)
      draft.list.sort()
      draft.rows[1]!.n = 5
      draft.rows.length = 2
    })
    deepStrictEqual(value.list, [2, 4, 9])
    deepStrictEqual(value.rows, [{ n: 1 }, { n: 5 }])
    strictEqual(value.rows[0], base.rows[0])
    deepStrictEqual(base.list, [3, 1, 2])
    ok(Array.isArray(value.list))
  }],
  ['shortening an array drops what was past its end, edited or not', () => {
    const base = freeze({ rows: [{ n: 1 }, { n: 2 }, { n: 3 }] })
    const { value } = produce(base, (draft) => { draft.rows[2]!.n = 9; draft.rows.length = 2 })
    deepStrictEqual(value.rows, [{ n: 1 }, { n: 2 }])
  }],
  ['array reading: map, filter, includes, spread and for-of see the edits', () => {
    produce(freeze({ list: [1, 2, 3] }), (draft) => {
      draft.list.push(4)
      deepStrictEqual(draft.list.map((n) => n * 2), [2, 4, 6, 8])
      deepStrictEqual(draft.list.filter((n) => n > 2), [3, 4])
      ok(draft.list.includes(4))
      deepStrictEqual([...draft.list], [1, 2, 3, 4])
      let sum = 0; for (const n of draft.list) sum += n
      strictEqual(sum, 10)
      ok(Array.isArray(draft.list))
    })
  }],
  ['a draft lists its keys and describes them as an object or array of its own would', () => {
    produce(freeze({ list: [1, 2], titles: { a: 'A' } }), (draft) => {
      deepStrictEqual(Object.keys(draft.list), ['0', '1'])
      deepStrictEqual(Object.entries(draft.titles), [['a', 'A']])
      deepStrictEqual({ ...draft.list }, { 0: 1, 1: 2 })
      // The data it was made from is frozen; the draft is what is written to.
      strictEqual(Object.getOwnPropertyDescriptor(draft.titles, 'a')?.writable, true)
      strictEqual(Object.getOwnPropertyDescriptor(draft.list, 'length')?.value, 2)
    })
  }],
  ['adding and deleting keys, and Object.keys and `in` see it', () => {
    const base = freeze({ tabs: { a: 1, b: 2 } as Record<string, number> })
    const { value } = produce(base, (draft) => {
      draft.tabs.c = 3
      delete draft.tabs.a
      deepStrictEqual(Object.keys(draft.tabs), ['b', 'c'])
      ok(!('a' in draft.tabs) && 'c' in draft.tabs)
    })
    deepStrictEqual(value.tabs, { b: 2, c: 3 })
    deepStrictEqual(base.tabs, { a: 1, b: 2 })
  }],
  ['deleting a key that is not there changes nothing', () => {
    const base = freeze({ tabs: { a: 1 } as Record<string, number> })
    const same = produce(base, (draft) => { delete draft.tabs.b })
    strictEqual(same.value, base)
    deepStrictEqual(same.touched, [])
  }],
  ['a field can be set to null or undefined', () => {
    const { value } = produce(freeze({ a: { n: 1 } as { n: number } | null, b: 1 as number | undefined }), (draft) => { draft.a = null; draft.b = undefined })
    deepStrictEqual(value, { a: null, b: undefined })
  }],
  ['an object made with no prototype is plain data, and is edited as a draft', () => {
    const tabs = Object.assign(Object.create(null) as Record<string, number>, { a: 1 })
    const base = freeze({ tabs })
    const { value, touched } = produce(base, (draft) => { draft.tabs.b = 2 })
    strictEqual(Object.getPrototypeOf(value.tabs), null)
    deepStrictEqual({ ...value.tabs }, { a: 1, b: 2 })
    deepStrictEqual({ ...base.tabs }, { a: 1 })
    deepStrictEqual(paths(touched), ['tabs.b'])
  }],
  ['what is kept under a symbol is not data: setting one is refused, and removing one changes nothing', () => {
    const mark = Symbol('mark')
    const base = freeze({ a: { [mark]: 1, n: 1 } })
    throws(() => produce(base, (draft) => { (draft.a as Record<symbol, number>)[mark] = 2 }))
    const same = produce(base, (draft) => { delete (draft.a as Record<symbol, number>)[mark] })
    strictEqual(same.value, base)
    deepStrictEqual(same.touched, [])
  }],
  ['a draft takes assignments, and says so to what defines a property on it', () => {
    throws(() => produce({ a: { n: 1 } }, (draft) => { Object.defineProperty(draft.a, 'm', { value: 1 }) }), /assign/)
  }],
  ['assigning a new object, and then editing it through the draft', () => {
    const { value } = produce(freeze({ a: { n: 1 } as { n: number; m?: number } }), (draft) => { draft.a = { n: 5 }; draft.a.m = 6 })
    deepStrictEqual(value, { a: { n: 5, m: 6 } })
  }],
  ['assigning one part of the draft to another place', () => {
    const base = freeze({ a: { n: 1 }, b: { n: 0 } })
    const { value } = produce(base, (draft) => { draft.a.n = 2; draft.b = draft.a })
    deepStrictEqual(value, { a: { n: 2 }, b: { n: 2 } })
  }],
  ['placing a part of the draft inside a new object, array, or frozen container unwraps every nested draft, leaving plain and non-plain values untouched', () => {
    class Box { constructor(readonly id: string, readonly other?: Box) {} }
    const box = new Box('x')
    const base = freeze({
      a: { n: 1 },
      box,
      wrapped: null as { inner: { n: number }; box: Box } | null,
      items: [] as Array<{ n: number }>,
      plainObj: null as { k: number } | null,
      plainArr: null as number[] | null,
      frozenObj: null as { readonly v: number } | null,
      frozenWithDraft: null as { readonly inner: { n: number }; readonly box: Box } | null,
      frozenArrWithDraft: null as ReadonlyArray<{ n: number }> | null,
      freshBox: null as Box | null,
      nullProto: null as Record<string, { n: number }> | null,
    })
    const freshObj = { k: 1 }
    const freshArr = [1, 2]
    const frozenObj = Object.freeze({ v: 42 })
    let madeBox!: Box
    const { value } = produce(base, (draft) => {
      draft.a.n = 2
      draft.wrapped = { inner: draft.a, box: draft.box }
      draft.items = [draft.a]
      draft.plainObj = freshObj
      draft.plainArr = freshArr
      draft.frozenObj = frozenObj
      draft.frozenWithDraft = Object.freeze({ inner: draft.a, box: draft.box })
      draft.frozenArrWithDraft = Object.freeze([draft.a])
      madeBox = new Box('fresh', draft.box)
      draft.freshBox = madeBox
      const dict = Object.create(null) as Record<string, { n: number }>
      dict.inner = draft.a
      draft.nullProto = dict
    })
    // Freezing and reading plain results must succeed (no closed draft proxies left inside).
    freeze(value.wrapped)
    freeze(value.items)
    freeze(value.frozenWithDraft)
    freeze(value.frozenArrWithDraft)
    freeze(value.nullProto)
    deepStrictEqual(value.wrapped, { inner: { n: 2 }, box })
    strictEqual(value.wrapped!.box, box)
    deepStrictEqual(value.items, [{ n: 2 }])
    strictEqual(value.plainObj, freshObj)
    strictEqual(value.plainArr, freshArr)
    strictEqual(value.frozenObj, frozenObj)
    deepStrictEqual(value.frozenWithDraft, { inner: { n: 2 }, box })
    strictEqual(value.frozenWithDraft!.box, box)
    strictEqual(value.frozenWithDraft!.inner.n, 2)
    deepStrictEqual(value.frozenArrWithDraft, [{ n: 2 }])
    strictEqual(value.frozenArrWithDraft![0]!.n, 2)
    strictEqual(value.freshBox, madeBox)
    ok(value.freshBox instanceof Box)
    strictEqual(Object.getPrototypeOf(value.nullProto), null)
    deepStrictEqual({ ...value.nullProto }, { inner: { n: 2 } })

    // Reading only a non-plain field still unwraps its whole proxy when placed inside a new object.
    const wholeOnly = produce(freeze({ box, wrapped: null as { box: Box } | null }), (draft) => {
      draft.wrapped = { box: draft.box }
    })
    strictEqual(wholeOnly.value.wrapped!.box, box)
  }],
  ['fresh plain assignments are not walked when no nested draft was handed out', () => {
    let reads = 0
    const fresh = { get big() { reads++; return 1 } }
    const base = freeze({ payload: null as { readonly big: number } | null })
    const { value } = produce(base, (draft) => { draft.payload = fresh })
    strictEqual(value.payload, fresh)
    strictEqual(reads, 0)
  }],
  ['cyclic and shared plain graphs terminate cleanly and unwrap every nested draft', () => {
    const base = freeze({
      a: { n: 1 },
      cyclicObj: null as Record<string, unknown> | null,
      cyclicArr: null as unknown[] | null,
      sharedPlain: null as { left: { k: number }; right: { k: number } } | null,
      sharedPlainArr: null as number[][] | null,
      sharedDraft: null as { left: { inner: { n: number } }; right: { inner: { n: number } } } | null,
      sharedDraftArr: null as Array<Array<{ n: number }>> | null,
    })
    const plainLeaf = { k: 7 }
    const plainPair = { left: plainLeaf, right: plainLeaf }
    const plainArrLeaf = [1, 2]
    const plainArrPair = [plainArrLeaf, plainArrLeaf]
    const { value } = produce(base, (draft) => {
      draft.a.n = 2
      const objLoop: Record<string, unknown> = { inner: draft.a }
      objLoop.self = objLoop
      draft.cyclicObj = objLoop

      const arrLoop: unknown[] = [draft.a]
      arrLoop.push(arrLoop)
      draft.cyclicArr = arrLoop

      draft.sharedPlain = plainPair
      draft.sharedPlainArr = plainArrPair

      const draftLeaf = { inner: draft.a }
      draft.sharedDraft = { left: draftLeaf, right: draftLeaf }

      const draftArrLeaf = [draft.a]
      draft.sharedDraftArr = [draftArrLeaf, draftArrLeaf]
    })
    freeze(value.cyclicObj)
    freeze(value.cyclicArr)
    freeze(value.sharedDraft)
    freeze(value.sharedDraftArr)

    deepStrictEqual(value.cyclicObj!.inner, { n: 2 })
    strictEqual(value.cyclicObj!.self, value.cyclicObj)
    deepStrictEqual(value.cyclicArr![0], { n: 2 })
    strictEqual(value.cyclicArr![1], value.cyclicArr)

    strictEqual(value.sharedPlain, plainPair)
    strictEqual(value.sharedPlain!.right, plainLeaf)
    strictEqual(value.sharedPlainArr, plainArrPair)
    strictEqual(value.sharedPlainArr![1], plainArrLeaf)

    strictEqual(value.sharedDraft!.left, value.sharedDraft!.right)
    deepStrictEqual(value.sharedDraft!.left, { inner: { n: 2 } })
    strictEqual(value.sharedDraftArr![0], value.sharedDraftArr![1])
    deepStrictEqual(value.sharedDraftArr![0], [{ n: 2 }])
  }],
  ['what is not plain reads as itself, runs its methods, and can be replaced', () => {
    class Repository { #opened = 0; constructor(readonly directory: string) {} open(): number { return ++this.#opened } }
    const first = new Repository('/a')
    const { value } = produce({ repository: first as Repository | null, other: null as Repository | null, when: new Date(0) }, (draft) => {
      ok(draft.repository instanceof Repository)
      strictEqual(draft.repository!.directory, '/a')
      strictEqual(draft.repository!.open(), 1)
      strictEqual(draft.when.getTime(), 0)
      draft.other = draft.repository
      draft.repository = new Repository('/b')
    })
    ok(value.repository instanceof Repository && value.repository.directory === '/b')
    strictEqual(value.other, first)
  }],
  ['what is not plain refuses to be edited', () => {
    class Repository { cache: string[] = []; constructor(public directory: string) {} }
    const first = new Repository('/a')
    throws(() => produce({ repository: first }, (draft) => { draft.repository.directory = '/b' }), /repository is not plain data/)
    throws(() => produce({ nested: { repository: first } }, (draft) => { draft.nested.repository.cache = [] }), /nested\.repository is not plain data/)
    strictEqual(first.directory, '/a')
  }],
  ['an edit that returns a value is refused', () => {
    const base = freeze({ count: 1 })
    throws(() => produce(base, ((draft: { count: number }) => ({ ...draft, count: 2 })) as (draft: { count: number }) => void), /returns nothing/)
  }],
  ['an async edit is refused', () => {
    const base = { count: 1 }
    throws(() => produce(base, (async (draft: { count: number }) => { await null; draft.count = 2 }) as (draft: { count: number }) => void), /cannot be async/)
  }],
  ['it reports each place that changed', () => {
    const { touched } = produce(freeze({ titles: { a: 'A' } as Record<string, string>, messages: { a: ['x'] }, count: 1, same: 1 }), (draft) => {
      draft.titles.b = 'B'
      draft.messages.a!.push('y')
      draft.count = 2
      draft.same = 1
    })
    deepStrictEqual(paths(touched), ['count', 'messages.a.1', 'titles.b'])
  }],
  ['a draft kept past its handler cannot be used', () => {
    let kept: { n: number } | undefined
    produce({ a: { n: 1 } }, (draft) => { kept = draft.a })
    throws(() => kept!.n, /after the handler/)
    throws(() => { kept!.n = 2 }, /after the handler/)
    throws(() => { delete (kept as { n?: number }).n }, /after the handler/)
    throws(() => 'n' in kept!, /after the handler/)
    throws(() => Object.keys(kept!), /after the handler/)
    throws(() => Reflect.ownKeys(kept!), /after the handler/)
    throws(() => Object.getOwnPropertyDescriptor(kept!, 'n'), /after the handler/)
    throws(() => Object.getPrototypeOf(kept!), /after the handler/)
    throws(() => Object.defineProperty(kept!, 'n', { value: 2 }), /after the handler/)
  }],
  ['inherited Object.prototype names are not own fields: fixed drafts refuse them, open drafts can set them', () => {
    const base = freeze({ count: 0 } as Record<string, unknown>)
    throws(() => produce(base, (draft) => { draft['toString'] = 'x' }, { fixed: true }), /no field toString/)
    throws(() => produce(base, (draft) => { delete draft['count'] }, { fixed: true }), /cannot be removed/)
    const fixedDelProto = produce(base, (draft) => { delete draft['toString'] }, { fixed: true })
    strictEqual(fixedDelProto.value, base)
    const open = produce(base, (draft) => { draft['toString'] = 'own' })
    strictEqual(Object.hasOwn(open.value, 'toString'), true)
    strictEqual(open.value['toString'], 'own')
    const delMissing = produce(base, (draft) => { delete draft['toString'] })
    strictEqual(delMissing.value, base)
    deepStrictEqual(delMissing.touched, [])
  }],
  ['an edit that throws leaves nothing behind', () => {
    const base = freeze({ a: { n: 1 } })
    throws(() => produce(base, (draft) => { draft.a.n = 2; throw new Error('no') }), /no/)
    strictEqual(base.a.n, 1)
  }],
  ['topLevel mode reports each touched top-level field once without building deep paths', () => {
    const base = freeze({ titles: { a: 'A' } as Record<string, string>, messages: { a: ['x'] }, count: 1 })
    const { value, touched } = produce(base, (draft) => {
      draft.titles.b = 'B'
      draft.titles.c = 'C'
      draft.messages.a!.push('y', 'z')
      draft.count = 2
    }, { fixed: true, topLevel: true })
    deepStrictEqual(value, { titles: { a: 'A', b: 'B', c: 'C' }, messages: { a: ['x', 'y', 'z'] }, count: 2 })
    deepStrictEqual(paths(touched), ['count', 'messages', 'titles'])
  }],
  ['freeze mode freezes copied containers and newly assigned values without re-walking untouched siblings from base', () => {
    const r0 = freeze({ id: '0', tags: ['a'] })
    const r1 = freeze({ id: '1', tags: ['b'] })
    const untouched = freeze({ k: 1 })
    const base = freeze({ rows: [r0, r1], other: untouched })
    const seen: unknown[] = []
    const spyFreeze = (v: unknown): void => { seen.push(v); freeze(v) }

    const added = { id: '2', tags: [] as string[] }
    const { value } = produce(base, (draft) => {
      draft.rows.push(added)
      // Mutating a newly assigned object later inside the same edit must still work.
      added.tags.push('urgent')
    }, { freeze: spyFreeze })

    ok(Object.isFrozen(value))
    ok(Object.isFrozen(value.rows))
    ok(Object.isFrozen(added))
    ok(Object.isFrozen(added.tags))
    deepStrictEqual(value.rows[2], { id: '2', tags: ['urgent'] })
    ok(seen.includes(added))
    ok(!seen.includes(r0) && !seen.includes(r1) && !seen.includes(untouched))

    // A no-op edit touches nothing and freezes nothing.
    seen.length = 0
    const same = produce(base, (draft) => { draft.rows[0] = draft.rows[0]! }, { freeze: spyFreeze })
    strictEqual(same.value, base)
    deepStrictEqual(seen, [])
  }],
  ['freeze mode does not freeze discarded, overwritten, truncated, or rolled-back objects', () => {
    const base = freeze({
      byId: { a: { n: 1 } } as Record<string, { n: number }>,
      rows: [{ n: 1 }],
    })
    const seen: unknown[] = []
    const spyFreeze = (v: unknown): void => { seen.push(v); freeze(v) }
    const deleted = { n: 2 }
    const overwritten = { n: 3 }
    const kept = { n: 4 }
    const truncated = { n: 5 }

    const { value } = produce(base, (draft) => {
      draft.byId.tmp = deleted
      delete draft.byId.tmp
      draft.byId.a = overwritten
      draft.byId.a = kept
      draft.rows.push(truncated)
      draft.rows.length = 1
    }, { freeze: spyFreeze })

    ok(Object.isFrozen(value) && Object.isFrozen(value.byId) && Object.isFrozen(value.rows))
    ok(Object.isFrozen(kept))
    strictEqual(Object.isFrozen(deleted), false)
    strictEqual(Object.isFrozen(overwritten), false)
    strictEqual(Object.isFrozen(truncated), false)
    ok(!seen.includes(undefined) && !seen.includes(deleted) && !seen.includes(overwritten) && !seen.includes(truncated))

    const aborted = { n: 6 }
    throws(() => produce(base, (draft) => { draft.byId.fail = aborted; throw new Error('abort') }, { freeze: spyFreeze }), /abort/)
    strictEqual(Object.isFrozen(aborted), false)
  }],
  ['freeze mode freezes untouched nested fields of a freshly assigned object edited through a child draft', () => {
    const base = freeze({
      x: { a: { n: 1 }, b: { m: 2 } },
      y: { items: [] as Array<{ k: number }>, meta: { tag: 'old' } },
    })
    const { value } = produce(base, (draft) => {
      draft.x = { a: { n: 10 }, b: { m: 20 } }
      draft.x.a.n = 99
      draft.y = { items: [{ k: 1 }], meta: { tag: 'new' } }
      draft.y.items.push({ k: 2 })
    }, { freeze })

    ok(Object.isFrozen(value))
    ok(Object.isFrozen(value.x) && Object.isFrozen(value.x.a) && Object.isFrozen(value.x.b))
    ok(Object.isFrozen(value.y) && Object.isFrozen(value.y.items) && Object.isFrozen(value.y.items[0]) && Object.isFrozen(value.y.items[1]) && Object.isFrozen(value.y.meta))
    deepStrictEqual(value.x, { a: { n: 99 }, b: { m: 20 } })
    deepStrictEqual(value.y, { items: [{ k: 1 }, { k: 2 }], meta: { tag: 'new' } })
  }],
  ['freeze mode handles reassigned child drafts, reversed edited arrays, and detached truncated drafts', () => {
    const base = freeze({
      a: { n: 1 },
      b: { n: 0 },
      rows: [{ n: 1 }, { n: 2 }, { n: 3, child: null as { m: number } | null }],
    })
    const truncatedChild = { m: 99 }
    const { value } = produce(base, (draft) => {
      draft.a.n = 2
      draft.b = draft.a
      draft.a.n = 3
      draft.rows[0]!.n = 10
      draft.rows.reverse()
      draft.rows[2]!.n = 20
      draft.rows[2]!.child = truncatedChild
      draft.rows.length = 2
    }, { freeze })

    ok(Object.isFrozen(value) && Object.isFrozen(value.a) && Object.isFrozen(value.b) && Object.isFrozen(value.rows))
    ok(Object.isFrozen(value.rows[0]) && Object.isFrozen(value.rows[1]))
    strictEqual(Object.isFrozen(truncatedChild), false)
    deepStrictEqual({ a: value.a, b: value.b, rows: value.rows }, { a: { n: 3 }, b: { n: 3 }, rows: [{ n: 3, child: null }, { n: 2 }] })
  }],
]

await run(checks)
