// What a draft has to get right. Each check is a way a hand-built one goes wrong.
//
//   npx vitest run draft
import { deepStrictEqual, notStrictEqual, ok, strictEqual, throws } from 'node:assert'
import { run } from './checks.mts'
import { freeze, produce } from '../src/draft.ts'

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
  ['freeze mode freezes copied containers and newly assigned plain values without re-walking untouched siblings or non-plain objects', () => {
    const shallowFreeze = <T extends object>(value: T): T => Object.freeze(value)
    // Untouched siblings are deliberately left unfrozen inside shallowly frozen base containers: any O(N) walk would freeze them.
    const untouchedRow = { id: '0', tags: ['a'] }
    const untouchedSibling = { k: 1 }
    const base = shallowFreeze({
      rows: shallowFreeze([untouchedRow]),
      other: untouchedSibling as { k: number } | null,
      when: null as Date | null,
      count: 0,
    })

    const added = { id: '2', tags: [] as string[] }
    const when = new Date(0)
    const { value } = produce(base, (draft) => {
      draft.rows.push(added)
      // Mutating a newly assigned object later inside the same edit must still work.
      added.tags.push('urgent')
      draft.when = when
      draft.count = 1
    }, { freeze: true })

    ok(Object.isFrozen(value) && Object.isFrozen(value.rows))
    ok(Object.isFrozen(added) && Object.isFrozen(added.tags))
    strictEqual(Object.isFrozen(untouchedRow), false)
    strictEqual(Object.isFrozen(untouchedSibling), false)
    strictEqual(Object.isFrozen(when), false)
    deepStrictEqual(value.rows[1], { id: '2', tags: ['urgent'] })

    // A no-op edit leaves base untouched and walks nothing.
    const same = produce(base, (draft) => { draft.count = draft.count }, { freeze: true })
    strictEqual(same.value, base)
    strictEqual(Object.isFrozen(untouchedRow), false)

    // An unfrozen base passed with freeze: true is still deep-frozen completely.
    const unfrozenBase = { a: { n: 1 }, b: { m: 2 } }
    const frozenAll = produce(unfrozenBase, (draft) => { draft.a.n = 2 }, { freeze: true })
    ok(Object.isFrozen(frozenAll.value) && Object.isFrozen(frozenAll.value.a) && Object.isFrozen(frozenAll.value.b))

    // Direct freeze() leaves primitives, null, and non-plain values alone, and terminates on cyclic objects.
    strictEqual(freeze(42), 42)
    strictEqual(freeze(null), null)
    const rawDate = new Date(1)
    strictEqual(freeze(rawDate), rawDate)
    strictEqual(Object.isFrozen(rawDate), false)
    const cycA: Record<string, unknown> = {}
    const cycB: Record<string, unknown> = { a: cycA }
    cycA.b = cycB
    freeze(cycA)
    ok(Object.isFrozen(cycA) && Object.isFrozen(cycB))
  }],
  ['freeze mode does not freeze discarded, overwritten, truncated, or rolled-back objects', () => {
    const base = freeze({
      byId: { a: { n: 1 } } as Record<string, { n: number }>,
      rows: [{ n: 1 }],
    })
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
    }, { freeze: true })

    ok(Object.isFrozen(value) && Object.isFrozen(value.byId) && Object.isFrozen(value.rows))
    ok(Object.isFrozen(kept))
    strictEqual(Object.isFrozen(deleted), false)
    strictEqual(Object.isFrozen(overwritten), false)
    strictEqual(Object.isFrozen(truncated), false)

    const aborted = { n: 6 }
    throws(() => produce(base, (draft) => { draft.byId.fail = aborted; throw new Error('abort') }, { freeze: true }), /abort/)
    strictEqual(Object.isFrozen(aborted), false)
  }],
  ['freeze mode freezes untouched nested fields of freshly assigned and shallowly-frozen external objects edited through a child draft', () => {
    const base = freeze({
      x: { a: { n: 1 }, b: { m: 2 } },
      y: { items: [] as Array<{ k: number }>, meta: { tag: 'old' } },
      box: null as unknown,
      nestedBox: null as unknown,
    })
    const shallowNested = { count: 0 }
    const shallow = Object.freeze({ nested: shallowNested, extra: 1 })
    const deepShallowNested = { count: 0 }
    const deepShallow = Object.freeze({ nested: deepShallowNested, extra: 1 })
    const { value } = produce(base, (draft) => {
      draft.x = { a: { n: 10 }, b: { m: 20 } }
      draft.x.a.n = 99
      draft.y = { items: [{ k: 1 }], meta: { tag: 'new' } }
      draft.y.items.push({ k: 2 })
      draft.box = shallow
      ;(draft.box as { extra: number }).extra = 2
      draft.nestedBox = { inner: deepShallow }
      ;(draft.nestedBox as { inner: { extra: number } }).inner.extra = 2
    }, { freeze: true })

    ok(Object.isFrozen(value))
    ok(Object.isFrozen(value.x) && Object.isFrozen(value.x.a) && Object.isFrozen(value.x.b))
    ok(Object.isFrozen(value.y) && Object.isFrozen(value.y.items) && Object.isFrozen(value.y.items[0]) && Object.isFrozen(value.y.items[1]) && Object.isFrozen(value.y.meta))
    ok(Object.isFrozen(value.box) && Object.isFrozen(shallowNested))
    ok(Object.isFrozen(value.nestedBox) && Object.isFrozen((value.nestedBox as { inner: unknown }).inner) && Object.isFrozen(deepShallowNested))
    deepStrictEqual(value.x, { a: { n: 99 }, b: { m: 20 } })
    deepStrictEqual(value.y, { items: [{ k: 1 }, { k: 2 }], meta: { tag: 'new' } })
  }],
  ['freeze mode handles reassigned child drafts, wrapped aliases, reversed edited arrays, detached truncated drafts, and cycles in O(Δ)', () => {
    const shallowFreeze = <T extends object>(value: T): T => Object.freeze(value)
    const untouched = { sentinel: true }
    const base = shallowFreeze({
      a: shallowFreeze({ n: 1, untouched, self: null as unknown }),
      b: shallowFreeze({ n: 0, peer: null as unknown, wrapped: null as unknown }),
      rows: shallowFreeze<Array<{ n: number; child?: { m: number } | null }>>([freeze({ n: 1 }), freeze({ n: 2 }), freeze({ n: 3, child: null as { m: number } | null })]),
    })
    const truncatedChild = { m: 99 }
    const { value } = produce(base, (draft) => {
      draft.a.n = 2
      draft.a.self = draft.a
      draft.b.peer = draft.a
      draft.b.wrapped = { wrap: draft.a, list: [draft.a] }
      draft.rows[0]!.n = 10
      draft.rows.reverse()
      draft.rows[2]!.n = 20
      draft.rows[2]!.child = truncatedChild
      draft.rows.length = 2
    }, { freeze: true })

    ok(Object.isFrozen(value) && Object.isFrozen(value.a) && Object.isFrozen(value.b) && Object.isFrozen(value.b.wrapped) && Object.isFrozen(value.rows))
    ok(Object.isFrozen((value.b.wrapped as { list: unknown[] }).list))
    ok(Object.isFrozen(value.rows[0]) && Object.isFrozen(value.rows[1]))
    strictEqual(value.a.self, value.a)
    strictEqual(value.b.peer, value.a)
    strictEqual((value.b.wrapped as { wrap: unknown }).wrap, value.a)
    // Untouched sibling on `a` must not be walked through self-cycles, direct aliases, or fresh wrappers.
    strictEqual(Object.isFrozen(untouched), false)
    strictEqual(Object.isFrozen(truncatedChild), false)
    deepStrictEqual(value.rows, [{ n: 3, child: null }, { n: 2 }])
  }],
  ['freeze mode ignores inherited prototype keys (including __proto__) and still freezes own __proto__ on null-prototype objects', () => {
    const protoProbe = { leaked: true }
    Object.defineProperty(Object.prototype, '__draftHasOwnProbe', {
      configurable: true,
      get() { return protoProbe },
      set() {},
    })
    try {
      const base = freeze({
        map: {} as Record<string, unknown>,
        arr: [1, 2] as unknown[],
        nullProto: Object.create(null) as Record<string, unknown>,
      })
      const { value } = produce(base, (draft) => {
        draft.map['__draftHasOwnProbe'] = 123
      }, { freeze: true })
      ok(Object.isFrozen(value) && Object.isFrozen(value.map))
      strictEqual(Object.isFrozen(protoProbe), false)

      const protoRes = produce(base, (draft) => {
        draft.map['__proto__'] = 123
        ;(draft.arr as unknown as Record<string, unknown>)['__proto__'] = 123
        draft.nullProto['__proto__'] = { own: 1 }
      }, { freeze: true })
      strictEqual(Object.isFrozen(Object.prototype), false)
      strictEqual(Object.isFrozen(Array.prototype), false)
      ok(Object.isFrozen(protoRes.value.nullProto) && Object.isFrozen(protoRes.value.nullProto['__proto__']))
    } finally {
      delete (Object.prototype as Record<string, unknown>)['__draftHasOwnProbe']
    }
  }],
  ['freeze mode keeps objects frozen after mid-edit settle, alias removal, and child-draft eviction', () => {
    // 1. Nested draft settled via sibling alias, alias dropped, then settled child re-read.
    const r1 = produce(freeze({ a: { x: { n: 1 } }, b: null as unknown }), (d) => {
      d.a.x.n = 2
      d.b = d.a
      d.b = null
      void d.a.x.n
    }, { fixed: true, topLevel: true, freeze: true })
    ok(Object.isFrozen(r1.value) && Object.isFrozen(r1.value.a) && Object.isFrozen(r1.value.a.x))

    // 2. Fresh nested object edited again after eviction.
    const r2 = produce(freeze({ a: { x: { n: 1, m: { k: 1 } } }, b: null as unknown }), (d) => {
      d.a.x.m = { k: 2 }
      d.b = d.a
      d.b = null
      d.a.x.n = 99
    }, { fixed: true, topLevel: true, freeze: true })
    ok(Object.isFrozen(r2.value.a.x) && Object.isFrozen(r2.value.a.x.m))
    deepStrictEqual(r2.value.a.x, { n: 99, m: { k: 2 } })

    // 3. Single array field: settled via push(d.rows[0]), popped, then re-read.
    const r3 = produce(freeze({ rows: [{ x: { n: 1 } }] }), (d) => {
      d.rows[0]!.x.n = 10
      d.rows.push(d.rows[0]!)
      d.rows.pop()
      void d.rows[0]!.x.n
    }, { fixed: true, topLevel: true, freeze: true })
    ok(Object.isFrozen(r3.value.rows) && Object.isFrozen(r3.value.rows[0]) && Object.isFrozen(r3.value.rows[0]!.x))

    // 4. Root alias settled via d.b = d, dropped, then child re-read.
    const r4 = produce(freeze({ a: { n: 1 }, b: null as unknown }), (d) => {
      d.a.n = 2
      d.b = d
      d.b = null
      void d.a
    }, { fixed: true, topLevel: true, freeze: true })
    ok(Object.isFrozen(r4.value) && Object.isFrozen(r4.value.a))

    // 5. Wrapped alias and self-assignment after eviction.
    const r5 = produce(freeze({ a: { x: { n: 1 } }, b: null as unknown }), (d) => {
      d.a.x.n = 2
      d.b = { wrap: d.a }
      d.b = null
      d.a.x = d.a.x
    }, { fixed: true, topLevel: true, freeze: true })
    ok(Object.isFrozen(r5.value.a) && Object.isFrozen(r5.value.a.x))

    // 6. Retained stale child draft reference mutating after eviction.
    const r6 = produce(freeze({ a: { x: { n: 1, z: null as unknown } }, b: null as unknown }), (d) => {
      const ref = d.a.x
      ref.n = 2
      d.b = d.a
      d.b = null
      void d.a.x
      ref.z = { k: 99 }
    }, { fixed: true, topLevel: true, freeze: true })
    ok(Object.isFrozen(r6.value.a) && Object.isFrozen(r6.value.a.x) && Object.isFrozen(r6.value.a.x.z))
  }],
]

await run(checks)
