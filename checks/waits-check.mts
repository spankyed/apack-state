// Imperative timers declared under `waits`: armed and disarmed on demand, owned by their state,
// tracked on `waiting` beside `at` and `data`, and never blocking `idle()`.
//
//   npx vitest run waits
import { deepStrictEqual, ok, strictEqual } from 'node:assert'
import { effect } from '@vue/reactivity'
import { createRenderer, defineComponent, h, nextTick } from '@vue/runtime-core'
import { rest, run, system } from './checks.mts'
import { mirror } from '../src/mirror.ts'
import { vueBinding } from '../src/vue.ts'
import { explore, onSchedule } from '../src/testing.ts'
import { forNet, state, type Clock, type Defect, type StepLog } from '../src/index.ts'
import { memory } from './store.mts'

/** Manual monotonic clock with full inspection of scheduled timers, cancels, and late/throwing hooks. */
const manualClock = (initial = 1_000) => {
  let time = initial
  const timers: Array<{ id: number; ms: number; at: number; run: () => void; cancelled: boolean }> = []
  let nextId = 0
  let afterCalls = 0
  let cancelCalls = 0
  let throwOnAfter: Error | undefined
  let throwOnCancel: Error | undefined
  let syncFireNext = false
  const clock: Clock = {
    now: () => time,
    after: (ms, cb) => {
      afterCalls++
      if (throwOnAfter) { const err = throwOnAfter; throwOnAfter = undefined; throw err }
      const entry = { id: ++nextId, ms, at: time + ms, run: cb, cancelled: false }
      timers.push(entry)
      if (syncFireNext) {
        syncFireNext = false
        entry.cancelled = true
        cb()
      }
      return () => {
        cancelCalls++
        entry.cancelled = true
        if (throwOnCancel) { const err = throwOnCancel; throwOnCancel = undefined; throw err }
      }
    },
  }
  const advance = (ms: number): void => {
    time += ms
    for (const entry of timers.filter((t) => !t.cancelled && t.at <= time).sort((a, b) => a.at - b.at)) {
      entry.cancelled = true
      entry.run()
    }
  }
  return {
    clock,
    advance,
    timers,
    afterCalls: () => afterCalls,
    cancelCalls: () => cancelCalls,
    activeCount: () => timers.filter((t) => !t.cancelled).length,
    failNextAfter: (err: Error) => { throwOnAfter = err },
    failNextCancel: (err: Error) => { throwOnCancel = err },
    fireNextSync: () => { syncFireNext = true },
  }
}

type SvcNet = {
  systems: { svc: { events: { type: 'NOTIFIED'; tag: string }; asks: { SAVE: { args: { tag: string }; answer: string } } } }
  surfaces: {}
  views: {}
}
const netState = forNet<SvcNet>()

const checks: Array<[string, () => Promise<void>]> = [
  ['one and each waits arm, expose frozen waiting, fire done (transitions, data, send, tell, call), and keep idle() true', async () => {
    const manual = manualClock()
    const svcEvents: string[] = []
    const svcCalls: string[] = []
    const svc = netState<{}, { type: 'NOTIFIED'; tag: string }, SvcNet['systems']['svc']['asks']>()({
      on: { NOTIFIED: ({ tag }) => { svcEvents.push(tag) } },
      answers: { SAVE: ({ tag }) => { svcCalls.push(tag); return `saved:${tag}` } },
    })

    type Shape = {
      data: { fired: string[]; saved: string[]; internalHits: number }
      internal: { type: 'BUMP' }
      calls: { save: { one: { tag: string } } }
      waits: {
        debounce: 'one'
        t: 'each' // 1-char name exercises slash index boundary in valueOf
      }
      states: { editing: {}; submitted: {} }
    }
    type Ev = { type: 'TYPE' } | { type: 'MARK'; key: string } | { type: 'RESET' }

    const form = netState<Shape, Ev>()({
      data: { fired: [], saved: [], internalHits: 0 },
      initial: 'editing',
      calls: ({ one }) => ({
        save: one('svc', 'SAVE', {
          done: (outcome) => (outcome.ok ? { data: (d) => { d.saved.push(outcome.value) } } : undefined),
        }),
      }),
      waits: ({ one, each }) => ({
        debounce: one(200, ({ send, tell, call }) => {
          send({ type: 'BUMP' })
          tell('svc', { type: 'NOTIFIED', tag: 'debounced' })
          call('save', { tag: 'doc' })
          return { at: 'submitted', data: (d) => { d.fired.push('debounce') } }
        }),
        t: each(100, ({ key }) => ({ data: (d) => { d.fired.push(`each:${key}`) } })),
      }),
      internal: {
        BUMP: (_, { data }) => ({ data: { internalHits: data.internalHits + 1 } }),
      },
      on: {
        TYPE: (_, { arm }) => { arm('debounce') },
        MARK: ({ key }, { arm }) => { arm('t', key) },
        RESET: () => ({ at: 'editing' }),
      },
      states: { editing: {}, submitted: {} },
    })

    const logs: StepLog[] = []
    const sys = system({ side: 'backend', clock: manual.clock, log: (s) => logs.push(s) })
    sys.start('svc', svc)
    const h = sys.start('form', form)

    const initial = sys.read(h)
    deepStrictEqual(initial.waiting, { debounce: false, t: {} })
    strictEqual(Object.isFrozen(initial.waiting), true)
    strictEqual(Object.isFrozen(initial.waiting.t), true)
    strictEqual(sys.idle(), true)

    sys.send(h, { type: 'TYPE' })
    sys.send(h, { type: 'MARK', key: 'a' })
    sys.send(h, { type: 'MARK', key: 'dir/file.ts' })
    // sys.idle() MUST remain true while waits are armed!
    strictEqual(sys.idle(), true)
    deepStrictEqual(sys.read(h).waiting, { debounce: true, t: { a: true, 'dir/file.ts': true } })
    strictEqual(Object.isFrozen(sys.read(h).waiting), true)
    strictEqual(Object.isFrozen(sys.read(h).waiting.t), true)

    // Advance 100ms: `t` fires for both keys, `debounce` still armed.
    manual.advance(100)
    await rest()
    deepStrictEqual(sys.read(h).waiting, { debounce: true, t: {} })
    deepStrictEqual(sys.read(h).data.fired, ['each:a', 'each:dir/file.ts'])
    strictEqual(sys.read(h).at, 'editing')
    strictEqual(sys.idle(), true)

    // Advance another 100ms: `debounce` fires, transitions to `submitted`, sends internal, tells svc, and calls save.
    manual.advance(100)
    await rest()
    strictEqual(sys.read(h).at, 'submitted')
    deepStrictEqual(sys.read(h).waiting, { debounce: false, t: {} })
    deepStrictEqual(sys.read(h).data, { fired: ['each:a', 'each:dir/file.ts', 'debounce'], saved: ['saved:doc'], internalHits: 1 })
    deepStrictEqual(svcEvents, ['debounced'])
    deepStrictEqual(svcCalls, ['doc'])

    // StepLog records arm and wait with key for each and without key for one, never ms payload.
    const allHandled = logs.flatMap((l) => l.handled)
    ok(allHandled.some((x) => x.kind === 'arm' && x.ref === 'form' && x.name === 'debounce' && !('key' in x)))
    ok(allHandled.some((x) => x.kind === 'arm' && x.ref === 'form' && x.name === 't' && x.key === 'a'))
    ok(allHandled.some((x) => x.kind === 'wait' && x.ref === 'form' && x.name === 't' && x.key === 'dir/file.ts'))
    ok(allHandled.some((x) => x.kind === 'wait' && x.ref === 'form' && x.name === 'debounce' && !('key' in x)))
    ok(logs.some((l) => l.changed.form?.waiting === true))
    strictEqual(JSON.stringify(allHandled).includes('200'), false)
  }],

  ['omitted done (pure-TTL flags) updates snapshot.waiting, notifies subscribers, and drives Vue mirror and useState reactivity', async () => {
    const manual = manualClock()
    type FlagShape = {
      data: { label: string }
      waits: { pulse: 'one'; highlight: 'each' }
    }
    type FlagEv = { type: 'PULSE' } | { type: 'FLASH'; id: string } | { type: 'RENAME'; label: string }
    const flags = state<FlagShape, FlagEv>()({
      data: { label: 'init' },
      waits: ({ one, each }) => ({
        pulse: one(150),
        highlight: each(300),
      }),
      on: {
        PULSE: (_, { arm }) => { arm('pulse') },
        FLASH: ({ id }, { arm }) => { arm('highlight', id) },
        RENAME: ({ label }) => ({ data: { label } }),
      },
    })

    const defects: Defect[] = []
    const sys = system({ side: 'window', clock: manual.clock, onDefect: (d) => defects.push(d) })
    const handle = sys.start('flags', flags)

    const notices: Array<{ waiting: boolean; data: boolean }> = []
    sys.subscribe((_, f, c) => {
      const mine = c.flags
      if (mine) notices.push({ waiting: mine.waiting, data: (f.flags ?? []).length > 0 })
    })

    // Fine-grained mirror reactivity check.
    const held = mirror(sys, handle)
    const runs = { pulse: 0, a: 0, b: 0, label: 0 }
    effect(() => { runs.pulse++; void held.value.waiting.pulse })
    effect(() => { runs.a++; void held.value.waiting.highlight.a })
    effect(() => { runs.b++; void held.value.waiting.highlight.b })
    effect(() => { runs.label++; void held.value.data.label })
    const since = { ...runs }
    const ran = (): string[] => {
      const hit = (Object.keys(runs) as Array<keyof typeof runs>).filter((k) => runs[k] !== since[k])
      Object.assign(since, runs)
      return hit
    }

    // Vue component using vueBinding / useState reads waiting reactively in both Node and browser.
    interface VNodeHost { text: string; children: VNodeHost[] }
    const mkNode = (text = ''): VNodeHost => ({ text, children: [] })
    const { createApp } = createRenderer<VNodeHost, VNodeHost>({
      createElement: () => mkNode(),
      createText: (t) => mkNode(t),
      createComment: () => mkNode(),
      setText: (el, t) => { el.text = t },
      setElementText: (el, t) => { el.children = [mkNode(t)] },
      insert: (child, parent) => { parent.children.push(child) },
      remove: () => {},
      parentNode: () => null,
      nextSibling: () => null,
      patchProp: () => {},
    })
    const { provide, useState } = vueBinding<{ flags: typeof flags }>()
    const rendered: string[] = []
    const Comp = defineComponent(() => {
      const { state: s } = useState('flags')
      return () => {
        const line = `${s.value.data.label}|p=${String(s.value.waiting.pulse)}|a=${String(Boolean(s.value.waiting.highlight.a))}`
        rendered.push(line)
        return h('div', line)
      }
    })
    const app = createApp(Comp)
    provide(app, sys)
    app.mount(mkNode())

    sys.send(handle, { type: 'PULSE' })
    deepStrictEqual(ran(), ['pulse'])
    strictEqual(held.value.waiting.pulse, true)
    deepStrictEqual(notices.at(-1), { waiting: true, data: false })

    sys.send(handle, { type: 'FLASH', id: 'a' })
    deepStrictEqual(ran(), ['a'])
    strictEqual(held.value.waiting.highlight.a, true)

    sys.send(handle, { type: 'FLASH', id: 'b' })
    deepStrictEqual(ran(), ['b'])

    sys.send(handle, { type: 'RENAME', label: 'next' })
    deepStrictEqual(ran(), ['label'])
    await nextTick()
    strictEqual(rendered.at(-1), 'next|p=true|a=true')

    // Expire pulse at 150ms (pure TTL, no done): waiting.pulse flips to false and triggers pulse reader only.
    manual.advance(150)
    deepStrictEqual(ran(), ['pulse'])
    strictEqual(held.value.waiting.pulse, false)
    strictEqual(sys.read(handle).waiting.pulse, false)

    // Expire highlights at 300ms.
    manual.advance(150)
    deepStrictEqual(ran(), ['a', 'b'])
    strictEqual(held.value.waiting.highlight.a, undefined)
    strictEqual(held.value.waiting.highlight.b, undefined)
    await nextTick()
    strictEqual(rendered.at(-1), 'next|p=false|a=false')
    deepStrictEqual(defects, [])
    app.unmount()
    held.stop()
  }],

  ['reset: true (default) resets deadline on re-arm without spurious subscriber notice; reset: false throttles and re-arms after expiry or inside done', async () => {
    const manual = manualClock()
    type Shape = {
      data: { debounced: number; throttled: number; selfRearms: number }
      waits: { deb: 'one'; thr: 'one'; loop: 'one' }
    }
    type Ev = { type: 'DEB' } | { type: 'THR' } | { type: 'LOOP' }
    const machine = state<Shape, Ev>()({
      data: { debounced: 0, throttled: 0, selfRearms: 0 },
      waits: ({ one }) => ({
        deb: one(100, ({ data }) => ({ data: { debounced: data.debounced + 1 } })),
        thr: one(100, { reset: false, done: ({ data }) => ({ data: { throttled: data.throttled + 1 } }) }),
        loop: one(50, {
          reset: false,
          done: ({ data, arm }) => {
            if (data.selfRearms < 1) arm('loop')
            return { data: { selfRearms: data.selfRearms + 1 } }
          },
        }),
      }),
      on: {
        DEB: (_, { arm }) => { arm('deb') },
        THR: (_, { arm }) => { arm('thr') },
        LOOP: (_, { arm }) => { arm('loop') },
      },
    })

    const sys = system({ side: 'backend', clock: manual.clock })
    const h = sys.start('m', machine)
    let subCalls = 0
    sys.subscribe(() => { subCalls++ })

    // Debounce (`reset: true` default): arm at t=0, re-arm at t=60 -> original cancelled, fires at t=160.
    sys.send(h, { type: 'DEB' })
    strictEqual(subCalls, 1)
    manual.advance(60)
    sys.send(h, { type: 'DEB' })
    // Re-arming an already-armed timer does not change snapshot.waiting (true -> true), so no spurious subscriber call!
    strictEqual(subCalls, 1)
    strictEqual(manual.cancelCalls(), 1)
    manual.advance(50) // t=110: old 100ms deadline passed, must NOT have fired.
    strictEqual(sys.read(h).data.debounced, 0)
    strictEqual(sys.read(h).waiting.deb, true)
    manual.advance(50) // t=160: new deadline reached.
    strictEqual(sys.read(h).data.debounced, 1)
    strictEqual(sys.read(h).waiting.deb, false)

    // Throttle (`reset: false`): arm at t=160, re-arm at t=210 -> ignored (no extra clock.after, no cancel), fires at t=260.
    const afterBefore = manual.afterCalls()
    const cancelBefore = manual.cancelCalls()
    sys.send(h, { type: 'THR' })
    strictEqual(manual.afterCalls(), afterBefore + 1)
    manual.advance(50)
    sys.send(h, { type: 'THR' })
    strictEqual(manual.afterCalls(), afterBefore + 1)
    strictEqual(manual.cancelCalls(), cancelBefore)
    manual.advance(50) // t=260: original deadline fires.
    strictEqual(sys.read(h).data.throttled, 1)
    strictEqual(sys.read(h).waiting.thr, false)

    // Can re-arm throttle cleanly after expiry.
    sys.send(h, { type: 'THR' })
    strictEqual(sys.read(h).waiting.thr, true)
    manual.advance(100)
    strictEqual(sys.read(h).data.throttled, 2)

    // Self-re-arming a `reset: false` timer inside `done` succeeds because the kernel cleared it before invoking `done`.
    sys.send(h, { type: 'LOOP' })
    manual.advance(50)
    strictEqual(sys.read(h).data.selfRearms, 1)
    strictEqual(sys.read(h).waiting.loop, true)
    manual.advance(50)
    strictEqual(sys.read(h).data.selfRearms, 2)
    strictEqual(sys.read(h).waiting.loop, false)
  }],

  ['runtime ms ({ one: "ms" } / { each: "ms" }) and optional ms override on fixed-ms waits work for all builder forms', async () => {
    const manual = manualClock()
    let builtOneKind: string | undefined
    let builtEachKind: string | undefined
    type Shape = {
      data: { log: string[] }
      waits: {
        fixedOne: 'one'
        fixedEach: 'each'
        twoArgUndefinedMs: 'one'
        dynOneBare: { one: 'ms' }
        dynOneFn: { one: 'ms' }
        dynOneOpts: { one: 'ms' }
        dynEachBare: { each: 'ms' }
        dynEachFn: { each: 'ms' }
        dynEachOpts: { each: 'ms' }
      }
    }
    type Ev =
      | { type: 'FIXED_OVERRIDE' }
      | { type: 'DYN_ALL' }

    const m = state<Shape, Ev>()({
      data: { log: [] },
      waits: ({ one, each }) => {
        const fixedOne = one(500, { reset: true, done: () => ({ data: (d) => { d.log.push('fixedOne') } }) })
        const fixedEach = each(500, { reset: true, done: ({ key }) => ({ data: (d) => { d.log.push(`fixedEach:${key}`) } }) })
        builtOneKind = fixedOne.kind
        builtEachKind = fixedEach.kind
        return {
          fixedOne,
          fixedEach,
          twoArgUndefinedMs: one(undefined as unknown as number, () => ({ data: (d) => { d.log.push('twoArgOverride') } })),
          dynOneBare: one(),
          dynOneFn: one(() => ({ data: (d) => { d.log.push('dynOneFn') } })),
          dynOneOpts: one({ reset: false, done: () => ({ data: (d) => { d.log.push('dynOneOpts') } }) }),
          dynEachBare: each(),
          dynEachFn: each(({ key }) => ({ data: (d) => { d.log.push(`dynEachFn:${key}`) } })),
          dynEachOpts: each({ reset: false, done: ({ key }) => ({ data: (d) => { d.log.push(`dynEachOpts:${key}`) } }) }),
        }
      },
      on: {
        FIXED_OVERRIDE: (_, { arm }) => {
          arm('fixedOne', 25)
          arm('fixedEach', 'k', 40)
          arm('twoArgUndefinedMs', 30)
        },
        DYN_ALL: (_, { arm }) => {
          arm('dynOneBare', 10)
          arm('dynOneFn', 20)
          arm('dynOneOpts', 30)
          arm('dynEachBare', 'a', 15)
          arm('dynEachFn', 'b', 25)
          arm('dynEachOpts', 'c', 35)
        },
      },
    })

    const sys = system({ side: 'backend', clock: manual.clock })
    const h = sys.start('m', m)
    strictEqual(builtOneKind, 'one')
    strictEqual(builtEachKind, 'each')

    sys.send(h, { type: 'FIXED_OVERRIDE' })
    manual.advance(25)
    deepStrictEqual(sys.read(h).data.log, ['fixedOne'])
    manual.advance(15)
    deepStrictEqual(sys.read(h).data.log, ['fixedOne', 'twoArgOverride', 'fixedEach:k'])

    sys.send(h, { type: 'DYN_ALL' })
    strictEqual(sys.read(h).waiting.dynOneBare, true)
    strictEqual(sys.read(h).waiting.dynEachBare.a, true)
    manual.advance(10)
    strictEqual(sys.read(h).waiting.dynOneBare, false)
    manual.advance(5)
    strictEqual(sys.read(h).waiting.dynEachBare.a, undefined)
    manual.advance(20)
    deepStrictEqual(sys.read(h).data.log, ['fixedOne', 'twoArgOverride', 'fixedEach:k', 'dynOneFn', 'dynEachFn:b', 'dynOneOpts', 'dynEachOpts:c'])
  }],

  ['ms === 0 schedules on a subsequent step (never synchronously), and invalid ms or missing clock report exact defects without arming', async () => {
    const manual = manualClock()
    const defects: Defect[] = []
    const order: string[] = []
    type Shape = {
      data: { ran: number }
      waits: { zero: 'one'; dyn: { one: 'ms' }; keyed: { each: 'ms' }; fixedKeyed: 'each' }
    }
    type Ev =
      | { type: 'ZERO' }
      | { type: 'BAD'; ms: number }
      | { type: 'MISSING_MS' }
      | { type: 'BAD_KEYED'; ms: number }
      | { type: 'MISSING_KEY' }
      | { type: 'NON_STRING_KEY' }
    const m = state<Shape, Ev>()({
      data: { ran: 0 },
      waits: ({ one, each }) => ({
        zero: one(0, ({ data }) => { order.push('done'); return { data: { ran: data.ran + 1 } } }),
        dyn: one(() => { order.push('dyn') }),
        keyed: each(() => { order.push('keyed') }),
        fixedKeyed: each(100),
      }),
      on: {
        ZERO: (_, { arm }) => {
          order.push('before-arm')
          arm('zero')
          order.push('after-arm')
        },
        BAD: ({ ms }, { arm }) => { arm('dyn', ms) },
        MISSING_MS: (_, { arm }) => { (arm as (n: string) => void)('dyn') },
        BAD_KEYED: ({ ms }, { arm }) => { arm('keyed', 'x', ms) },
        MISSING_KEY: (_, { arm }) => { (arm as (n: string) => void)('fixedKeyed') },
        NON_STRING_KEY: (_, { arm }) => { (arm as (n: string, k: unknown, ms: number) => void)('keyed', 42, 100) },
      },
    })

    const sys = system({ side: 'backend', clock: manual.clock, onDefect: (d) => defects.push(d) })
    const h = sys.start('m', m)

    // Even if a clock fires ms===0 synchronously inside clock.after, wait runs in a subsequent step (after handler ends).
    manual.fireNextSync()
    sys.send(h, { type: 'ZERO' })
    deepStrictEqual(order, ['before-arm', 'after-arm', 'done'])
    strictEqual(sys.read(h).data.ran, 1)
    strictEqual(sys.read(h).waiting.zero, false)

    // Standard async ms===0 via manual clock: not fired until advance(0).
    order.length = 0
    sys.send(h, { type: 'ZERO' })
    deepStrictEqual(order, ['before-arm', 'after-arm'])
    strictEqual(sys.read(h).waiting.zero, true)
    manual.advance(0)
    deepStrictEqual(order, ['before-arm', 'after-arm', 'done'])
    strictEqual(sys.read(h).data.ran, 2)
    strictEqual(defects.length, 0)

    // Invalid durations and missing/non-string keys for `each` waits report exact defects without corrupting `waiting`.
    sys.send(h, { type: 'BAD', ms: Number.NaN })
    sys.send(h, { type: 'BAD', ms: -1 })
    sys.send(h, { type: 'BAD', ms: Number.POSITIVE_INFINITY })
    sys.send(h, { type: 'BAD_KEYED', ms: Number.NEGATIVE_INFINITY })
    sys.send(h, { type: 'MISSING_MS' })
    sys.send(h, { type: 'MISSING_KEY' })
    sys.send(h, { type: 'NON_STRING_KEY' })
    deepStrictEqual(defects.map((d) => ({ message: d.message, ref: d.ref })), [
      { message: 'm cannot arm dyn with invalid duration NaN', ref: 'm' },
      { message: 'm cannot arm dyn with invalid duration -1', ref: 'm' },
      { message: 'm cannot arm dyn with invalid duration Infinity', ref: 'm' },
      { message: 'm cannot arm keyed/x with invalid duration -Infinity', ref: 'm' },
      { message: 'm cannot arm dyn with invalid duration undefined', ref: 'm' },
      { message: 'm cannot arm fixedKeyed without a string key', ref: 'm' },
      { message: 'm cannot arm keyed without a string key', ref: 'm' },
    ])
    deepStrictEqual(sys.read(h).waiting, { zero: false, dyn: false, keyed: {}, fixedKeyed: {} })

    // Missing clock reports exact defect without arming.
    const noClockDefects: Defect[] = []
    const noClockSys = system({ side: 'backend', name: 'headless', onDefect: (d) => noClockDefects.push(d) })
    const nh = noClockSys.start('m', m)
    noClockSys.send(nh, { type: 'ZERO' })
    deepStrictEqual(noClockDefects.map((d) => ({ message: d.message, ref: d.ref })), [
      { message: 'm cannot arm zero: headless was given no clock; pass clock to system()', ref: 'm' },
    ])
    strictEqual(noClockSys.read(nh).waiting.zero, false)
  }],

  ['clock.after throwing on fresh arm or re-arm and cancel throwing on disarm/exit are isolated with exact defects', async () => {
    const manual = manualClock()
    const defects: Defect[] = []
    type Shape = { data: { fired: number; bump: number }; states: { on: { waits: { w: 'one' } }; off: {} } }
    type Ev = { type: 'ARM' } | { type: 'DISARM' } | { type: 'LEAVE' } | { type: 'BUMP' }
    const m = state<Shape, Ev>()({
      data: { fired: 0, bump: 0 },
      initial: 'on',
      states: {
        on: {
          waits: ({ one }) => ({ w: one(100, ({ data }) => ({ data: { fired: data.fired + 1 } })) }),
          on: {
            ARM: (_, { arm }) => { arm('w') },
            DISARM: (_, { disarm }) => { disarm('w') },
            LEAVE: () => ({ at: 'off' }),
            BUMP: (_, { data }) => ({ data: { bump: data.bump + 1 } }),
          },
        },
        off: {},
      },
    })

    const sys = system({ side: 'backend', clock: manual.clock, onDefect: (d) => defects.push(d) })
    const h = sys.start('m', m)

    // Fresh arm throws in clock.after -> defect reported, waiting stays false even after subsequent snapshot recompute.
    const afterErr1 = new Error('clock broken 1')
    manual.failNextAfter(afterErr1)
    sys.send(h, { type: 'ARM' })
    sys.send(h, { type: 'BUMP' })
    strictEqual(sys.read(h).waiting.w, false)
    strictEqual(defects.length, 1)
    strictEqual(defects[0]!.message, 'm could not arm w: clock broken 1')
    strictEqual(defects[0]!.ref, 'm')
    strictEqual(defects[0]!.error, afterErr1)

    // Re-arm throws in clock.after -> defect reported, PREVIOUS armed timer remains intact and still fires!
    defects.length = 0
    sys.send(h, { type: 'ARM' })
    strictEqual(sys.read(h).waiting.w, true)
    const afterErr2 = new Error('clock broken 2')
    manual.failNextAfter(afterErr2)
    sys.send(h, { type: 'ARM' })
    strictEqual(defects.length, 1)
    strictEqual(defects[0]!.message, 'm could not arm w: clock broken 2')
    strictEqual(sys.read(h).waiting.w, true)
    manual.advance(100)
    strictEqual(sys.read(h).data.fired, 1)
    strictEqual(sys.read(h).waiting.w, false)

    // Cancel throws on disarm -> defect isolated, waiting still cleared.
    defects.length = 0
    sys.send(h, { type: 'ARM' })
    const cancelErr1 = new Error('cancel boom 1')
    manual.failNextCancel(cancelErr1)
    sys.send(h, { type: 'DISARM' })
    strictEqual(sys.read(h).waiting.w, false)
    strictEqual(defects.length, 1)
    strictEqual(defects[0]!.message, "disarming m's wait w threw: cancel boom 1")
    strictEqual(defects[0]!.ref, 'm')
    strictEqual(defects[0]!.error, cancelErr1)

    // Cancel throws on state exit -> defect isolated, state still transitions and waiting clears.
    defects.length = 0
    sys.send(h, { type: 'ARM' })
    const cancelErr2 = new Error('cancel boom 2')
    manual.failNextCancel(cancelErr2)
    sys.send(h, { type: 'LEAVE' })
    strictEqual(sys.read(h).at, 'off')
    strictEqual(sys.read(h).waiting.w, false)
    strictEqual(defects.length, 1)
    strictEqual(defects[0]!.message, "disarming m's wait w threw: cancel boom 2")
  }],

  ['bulk disarm clears all active keys of an each wait without touching other waits, and single-key disarm clears only that key', async () => {
    const manual = manualClock()
    type Shape = {
      data: { fired: string[] }
      waits: { a: 'each'; b: 'each'; c: 'one' }
    }
    type Ev =
      | { type: 'ARM_ALL' }
      | { type: 'DISARM_ONE'; key: string }
      | { type: 'DISARM_BULK' }
      | { type: 'DISARM_C' }
    const m = state<Shape, Ev>()({
      data: { fired: [] },
      waits: ({ one, each }) => ({
        a: each(100, ({ key }) => ({ data: (d) => { d.fired.push(`a:${key}`) } })),
        b: each(100, ({ key }) => ({ data: (d) => { d.fired.push(`b:${key}`) } })),
        c: one(100, () => ({ data: (d) => { d.fired.push('c') } })),
      }),
      on: {
        ARM_ALL: (_, { arm }) => {
          arm('a', 'k1')
          arm('a', 'k2')
          arm('b', 'k1')
          arm('c')
        },
        DISARM_ONE: ({ key }, { disarm }) => { disarm('a', key) },
        DISARM_BULK: (_, { disarm }) => { disarm('a') },
        DISARM_C: (_, { disarm }) => { disarm('c') },
      },
    })

    const logs: StepLog[] = []
    const sys = system({ side: 'backend', clock: manual.clock, log: (s) => logs.push(s) })
    const h = sys.start('m', m)
    let subCalls = 0
    sys.subscribe(() => { subCalls++ })

    // Disarming when nothing is armed is a no-op (no subscriber notification).
    sys.send(h, { type: 'DISARM_BULK' })
    sys.send(h, { type: 'DISARM_ONE', key: 'missing' })
    sys.send(h, { type: 'DISARM_C' })
    strictEqual(subCalls, 0)

    sys.send(h, { type: 'ARM_ALL' })
    deepStrictEqual(sys.read(h).waiting, { a: { k1: true, k2: true }, b: { k1: true }, c: true })

    // Single-key disarm removes only k1 of `a`.
    sys.send(h, { type: 'DISARM_ONE', key: 'k1' })
    deepStrictEqual(sys.read(h).waiting, { a: { k2: true }, b: { k1: true }, c: true })

    // Bulk disarm removes all remaining keys of `a` while leaving `b` and `c` untouched.
    const cancelsBefore = manual.cancelCalls()
    sys.send(h, { type: 'DISARM_BULK' })
    strictEqual(manual.cancelCalls(), cancelsBefore + 1)
    deepStrictEqual(sys.read(h).waiting, { a: {}, b: { k1: true }, c: true })

    // Second bulk disarm when `a` is already empty does not notify subscribers.
    const subBefore = subCalls
    sys.send(h, { type: 'DISARM_BULK' })
    strictEqual(subCalls, subBefore)

    // Only `b:k1` and `c` fire.
    manual.advance(100)
    deepStrictEqual(sys.read(h).data.fired, ['b:k1', 'c'])
    ok(logs.flatMap((l) => l.handled).some((x) => x.kind === 'disarm' && x.name === 'a' && !('key' in x)))
    ok(logs.flatMap((l) => l.handled).some((x) => x.kind === 'disarm' && x.name === 'a' && x.key === 'k1'))
  }],

  ['same-step disarm; arm and arm; disarm follow exact FIFO order', async () => {
    const manual = manualClock()
    type Shape = {
      data: { fired: number }
      waits: { thr: 'one' }
    }
    type Ev = { type: 'ARM' } | { type: 'DISARM_THEN_ARM' } | { type: 'ARM_THEN_DISARM' }
    const m = state<Shape, Ev>()({
      data: { fired: 0 },
      waits: ({ one }) => ({
        // reset: false proves `disarm; arm` truly disarmed before arming (resetting deadline to t+100).
        thr: one(100, { reset: false, done: ({ data }) => ({ data: { fired: data.fired + 1 } }) }),
      }),
      on: {
        ARM: (_, { arm }) => { arm('thr') },
        DISARM_THEN_ARM: (_, { disarm, arm }) => { disarm('thr'); arm('thr') },
        ARM_THEN_DISARM: (_, { arm, disarm }) => { arm('thr'); disarm('thr') },
      },
    })

    const sys = system({ side: 'backend', clock: manual.clock })
    const h = sys.start('m', m)

    // `arm; disarm` in one step leaves it disarmed and cancels the timer.
    sys.send(h, { type: 'ARM_THEN_DISARM' })
    strictEqual(sys.read(h).waiting.thr, false)
    strictEqual(manual.activeCount(), 0)

    // Arm at t=0, advance to t=60, then `disarm; arm` in one step -> cancels old timer and arms new 100ms timer (t=160).
    sys.send(h, { type: 'ARM' })
    manual.advance(60)
    sys.send(h, { type: 'DISARM_THEN_ARM' })
    strictEqual(sys.read(h).waiting.thr, true)
    manual.advance(50) // t=110: old deadline did not fire.
    strictEqual(sys.read(h).data.fired, 0)
    manual.advance(50) // t=160: new deadline fires.
    strictEqual(sys.read(h).data.fired, 1)
  }],

  ['transactional unsay rolls back arm and disarm when a handler throws or returns a refused edit', async () => {
    const manual = manualClock()
    const store = memory()
    const defects: Defect[] = []
    type Shape = {
      data: { n: number }
      waits: { w: 'one' }
    }
    type Ev =
      | { type: 'ARM' }
      | { type: 'ARM_AND_THROW' }
      | { type: 'DISARM_AND_THROW' }
      | { type: 'ARM_AND_REFUSE' }
      | { type: 'DISARM_AND_REFUSE' }

    const m = state<Shape, Ev>()({
      data: { n: 0 },
      waits: ({ one }) => ({ w: one(100, ({ data }) => ({ data: { n: data.n + 1 } })) }),
      on: {
        ARM: (_, { arm }) => { arm('w') },
        ARM_AND_THROW: (_, { arm }) => {
          store.put('thread', 'a', { topic: 'v1' })
          arm('w')
          throw new Error('handler boom')
        },
        DISARM_AND_THROW: (_, { disarm }) => {
          disarm('w')
          throw new Error('disarm boom')
        },
        ARM_AND_REFUSE: (_, { arm }) => {
          arm('w')
          return { data: { nope: 1 } } as never
        },
        DISARM_AND_REFUSE: (_, { disarm }) => {
          disarm('w')
          return { data: { nope: 1 } } as never
        },
      },
    })

    const sys = system({ side: 'backend', clock: manual.clock, transact: store.transact, onDefect: (d) => defects.push(d) })
    const h = sys.start('m', m)

    sys.send(h, { type: 'ARM_AND_THROW' })
    strictEqual(sys.read(h).waiting.w, false)
    strictEqual(manual.afterCalls(), 0)
    strictEqual(store.get('thread', 'a'), undefined)

    sys.send(h, { type: 'ARM_AND_REFUSE' })
    strictEqual(sys.read(h).waiting.w, false)
    strictEqual(manual.afterCalls(), 0)

    // Arm legitimately, then fail to disarm via throw and via refused edit: timer stays armed and fires!
    sys.send(h, { type: 'ARM' })
    strictEqual(sys.read(h).waiting.w, true)
    sys.send(h, { type: 'DISARM_AND_THROW' })
    sys.send(h, { type: 'DISARM_AND_REFUSE' })
    strictEqual(sys.read(h).waiting.w, true)
    strictEqual(manual.cancelCalls(), 0)
    manual.advance(100)
    strictEqual(sys.read(h).data.n, 1)
    strictEqual(defects.length, 4)
  }],

  ['exit cleanup disarms on state leave, stop(handle), same-step arm+leave, late listen callbacks, and unknown wait names', async () => {
    const manual = manualClock()
    const lateArmParent: Array<() => void> = []
    const lateDisarmParent: Array<() => void> = []
    type Shape = {
      data: { fired: number }
      waits: { parentWait: 'one' }
      states: {
        active: { waits: { w: 'one' } }
        idle: {}
      }
    }
    type Ev = { type: 'ARM' } | { type: 'ARM_PARENT' } | { type: 'ARM_AND_LEAVE' } | { type: 'LEAVE' } | { type: 'ENTER' } | { type: 'UNKNOWN' }
    const m = state<Shape, Ev>()({
      data: { fired: 0 },
      initial: 'active',
      waits: ({ one }) => ({ parentWait: one(100) }),
      on: {
        ENTER: () => ({ at: 'active' }),
        ARM_PARENT: (_, { arm }) => { arm('parentWait') },
        UNKNOWN: (_, { arm, disarm }) => {
          ;(arm as (n: string, extra?: string) => void)('missing', 'extra')
          ;(disarm as (n: string) => void)('missing')
        },
      },
      states: {
        active: {
          waits: ({ one }) => ({ w: one(100, ({ data }) => ({ data: { fired: data.fired + 1 } })) }),
          listen: ({ arm, disarm }) => {
            lateArmParent.push(() => { arm('parentWait') })
            lateDisarmParent.push(() => { disarm('parentWait') })
            return () => {}
          },
          on: {
            ARM: (_, { arm }) => { arm('w') },
            ARM_AND_LEAVE: (_, { arm }) => { arm('w'); return { at: 'idle' } },
            LEAVE: () => ({ at: 'idle' }),
          },
        },
        idle: {},
      },
    })

    const logs: StepLog[] = []
    const sys = system({ side: 'backend', clock: manual.clock, log: (s) => logs.push(s) })
    const h = sys.start('m', m)
    const waitingFlags: boolean[] = []
    sys.subscribe((_, _f, c) => { if (c.m) waitingFlags.push(c.m.waiting) })

    // Leaving with NO waits armed reports waiting: false.
    sys.send(h, { type: 'LEAVE' })
    deepStrictEqual(waitingFlags, [false])

    // Late listen callback from exited child ignores arm & disarm even for a still-live parent wait!
    lateArmParent[0]!()
    strictEqual(sys.read(h).waiting.parentWait, false)
    strictEqual(manual.afterCalls(), 0)
    sys.send(h, { type: 'ARM_PARENT' })
    strictEqual(sys.read(h).waiting.parentWait, true)
    lateDisarmParent[0]!()
    strictEqual(sys.read(h).waiting.parentWait, true)
    manual.advance(100)
    strictEqual(sys.read(h).waiting.parentWait, false)

    // Unknown wait name via cast is a safe no-op and does not record a bogus key in StepLog.
    const afterUnknown = manual.afterCalls()
    sys.send(h, { type: 'UNKNOWN' })
    strictEqual(manual.afterCalls(), afterUnknown)
    const unknownHandled = logs.flatMap((l) => l.handled).find((x) => x.kind === 'arm' && x.name === 'missing')
    deepStrictEqual(unknownHandled, { kind: 'arm', ref: 'm', name: 'missing' })

    // Re-enter, arm, then leave: cancel called and waiting: true reported.
    sys.send(h, { type: 'ENTER' })
    waitingFlags.length = 0
    sys.send(h, { type: 'ARM' })
    strictEqual(sys.read(h).waiting.w, true)
    sys.send(h, { type: 'LEAVE' })
    strictEqual(sys.read(h).waiting.w, false)
    deepStrictEqual(waitingFlags, [true, true])
    strictEqual(manual.cancelCalls(), 1)
    manual.advance(100)
    strictEqual(sys.read(h).data.fired, 0)

    // Arm and leave in the SAME handler: queued arm sees exited state and does NOT schedule timer.
    sys.send(h, { type: 'ENTER' })
    const afterBefore = manual.afterCalls()
    sys.send(h, { type: 'ARM_AND_LEAVE' })
    strictEqual(sys.read(h).at, 'idle')
    strictEqual(sys.read(h).waiting.w, false)
    strictEqual(manual.afterCalls(), afterBefore)

    // Stopping the handle (or system) disarms active timers.
    sys.send(h, { type: 'ENTER' })
    sys.send(h, { type: 'ARM' })
    strictEqual(manual.activeCount(), 1)
    sys.stop(h)
    strictEqual(manual.activeCount(), 0)
    manual.advance(200)
  }],

  ['stale expiry is impossible: late firing from buggy clock creates no step, and queued wait behind disarm is ignored', async () => {
    const manual = manualClock()
    type Shape = { data: { fired: number }; waits: { w: 'one' } }
    type Ev = { type: 'ARM' } | { type: 'DISARM' } | { type: 'PING' }
    const m = state<Shape, Ev>()({
      data: { fired: 0 },
      waits: ({ one }) => ({ w: one(100, ({ data }) => ({ data: { fired: data.fired + 1 } })) }),
      on: {
        ARM: (_, { arm }) => { arm('w') },
        DISARM: (_, { disarm }) => { disarm('w') },
        PING: () => ({ data: { fired: 0 } }),
      },
    })

    const logs: StepLog[] = []
    const sys = system({ side: 'backend', clock: manual.clock, log: (s) => logs.push(s) })
    const h = sys.start('m', m)

    // Case A: buggy clock fires cancelled callback after disarm -> no StepLog entry and done never runs.
    sys.send(h, { type: 'ARM' })
    const firstCallback = manual.timers[0]!.run
    sys.send(h, { type: 'DISARM' })
    const logsBefore = logs.length
    firstCallback()
    strictEqual(logs.length, logsBefore)
    strictEqual(sys.read(h).data.fired, 0)

    // Case B: while flushing a commit, subscriber queues DISARM and THEN fires the timer -> DISARM runs first, queued wait is stale and ignored!
    sys.send(h, { type: 'ARM' })
    const secondCallback = manual.timers[1]!.run
    let triggered = false
    const unsub = sys.subscribe(() => {
      if (triggered) return
      triggered = true
      sys.send(h, { type: 'DISARM' })
      secondCallback()
    })
    // Trigger a data change (actually wait: PING doesn't change fired if already 0, so arm a second state or re-trigger via disarm/arm)
    // Use a separate state to trigger flush cleanly!
    const trigger = sys.start('t', state<{ data: { n: number } }, { type: 'GO' }>()({
      data: { n: 0 },
      on: { GO: (_, { data }) => ({ data: { n: data.n + 1 } }) },
    }))
    sys.send(trigger, { type: 'GO' })
    unsub()
    strictEqual(triggered, true)
    strictEqual(sys.read(h).waiting.w, false)
    strictEqual(sys.read(h).data.fired, 0)
  }],

  ['done throwing reports exact defect and rolls back its sayings while still clearing waiting', async () => {
    const manual = manualClock()
    const store = memory()
    const defects: Defect[] = []
    const boom = new Error('done exploded')
    type Shape = {
      data: { sideEffect: number }
      internal: { type: 'AFTER' }
      waits: { w: 'one' }
    }
    type Ev = { type: 'ARM' }
    const m = state<Shape, Ev>()({
      data: { sideEffect: 0 },
      waits: ({ one }) => ({
        w: one(50, ({ send }) => {
          store.put('thread', '1', { topic: 'ok' })
          send({ type: 'AFTER' })
          throw boom
        }),
      }),
      internal: {
        AFTER: (_, { data }) => ({ data: { sideEffect: data.sideEffect + 1 } }),
      },
      on: { ARM: (_, { arm }) => { arm('w') } },
    })

    const sys = system({ side: 'backend', clock: manual.clock, transact: store.transact, onDefect: (d) => defects.push(d) })
    const h = sys.start('m', m)
    const waitingChanges: boolean[] = []
    sys.subscribe((_, _f, c) => { if (c.m) waitingChanges.push(c.m.waiting) })

    sys.send(h, { type: 'ARM' })
    strictEqual(sys.read(h).waiting.w, true)
    waitingChanges.length = 0

    manual.advance(50)
    strictEqual(sys.read(h).waiting.w, false)
    deepStrictEqual(waitingChanges, [true])
    strictEqual(sys.read(h).data.sideEffect, 0)
    strictEqual(store.get('thread', '1'), undefined)
    strictEqual(defects.length, 1)
    strictEqual(defects[0]!.message, 'm threw in w done, and nothing changed: done exploded')
    strictEqual(defects[0]!.ref, 'm')
    strictEqual(defects[0]!.error, boom)
  }],

  ['ancestor resolution: parent waits armed from child survive sibling moves and disarm when leaving parent', async () => {
    const manual = manualClock()
    type Shape = {
      data: { expired: number; tags: string[] }
      states: {
        session: {
          waits: { keepalive: 'one'; tagged: 'each' }
          states: { a: {}; b: {} }
        }
        signedOut: {}
      }
    }
    type Ev = { type: 'ARM_IN_CHILD' } | { type: 'TO_B' } | { type: 'SIGN_OUT' }
    type Asks = { PING: { args: {}; answer: string } }
    const m = state<Shape, Ev, Asks>()({
      data: { expired: 0, tags: [] },
      initial: 'session',
      states: {
        session: {
          initial: 'a',
          waits: ({ one, each }) => ({
            keepalive: one(100, ({ data }) => ({ data: { expired: data.expired + 1 } })),
            tagged: each(100, ({ key }) => ({ data: (d) => { d.tags.push(key) } })),
          }),
          answers: {
            PING: (_, { arm }) => { arm('keepalive'); return 'armed' },
          },
          on: {
            TO_B: () => ({ at: 'session.b' }),
            SIGN_OUT: () => ({ at: 'signedOut' }),
          },
          states: {
            a: {
              on: { ARM_IN_CHILD: (_, { arm }) => { arm('keepalive'); arm('tagged', 'child-k') } },
            },
            b: {},
          },
        },
        signedOut: {},
      },
    })

    const sys = system({ side: 'backend', clock: manual.clock })
    const h = sys.start('m', m)

    sys.send(h, { type: 'ARM_IN_CHILD' })
    strictEqual(sys.read(h).waiting.keepalive, true)
    deepStrictEqual(sys.read(h).waiting.tagged, { 'child-k': true })

    // Moving session.a -> session.b keeps `session` alive, so `keepalive` and `tagged` stay armed and fire!
    sys.send(h, { type: 'TO_B' })
    strictEqual(sys.read(h).at, 'session.b')
    strictEqual(sys.read(h).waiting.keepalive, true)
    deepStrictEqual(sys.read(h).waiting.tagged, { 'child-k': true })
    manual.advance(100)
    strictEqual(sys.read(h).data.expired, 1)
    deepStrictEqual(sys.read(h).data.tags, ['child-k'])
    strictEqual(sys.read(h).waiting.keepalive, false)
    deepStrictEqual(sys.read(h).waiting.tagged, {})

    // Arming from an `answers` handler (`Scope`) also works, and leaving `session` disarms it.
    const ans = await sys.ask(h, 'PING', {})
    deepStrictEqual(ans, { ok: true, value: 'armed' })
    strictEqual(sys.read(h).waiting.keepalive, true)
    sys.send(h, { type: 'SIGN_OUT' })
    strictEqual(sys.read(h).at, 'signedOut')
    strictEqual(sys.read(h).waiting.keepalive, false)
    manual.advance(100)
    strictEqual(sys.read(h).data.expired, 1)
  }],

  ['virtual-clock explore determinism across orderings', async () => {
    type Shape = {
      data: { count: number; settled: boolean }
      waits: { settle: 'one' }
    }
    type Ev = { type: 'TOUCH' }
    const debouncer = state<Shape, Ev>()({
      data: { count: 0, settled: false },
      waits: ({ one }) => ({
        settle: one(50, () => ({ data: { settled: true } })),
      }),
      on: {
        TOUCH: (_, { data, arm }) => {
          arm('settle')
          return { data: { count: data.count + 1, settled: false } }
        },
      },
    })

    const explored = await explore((schedule) => {
      const sys = system({ side: 'window', ...onSchedule(schedule) })
      const h = sys.start('d', debouncer)
      schedule.does('user',
        ['touch-1', () => { sys.send(h, { type: 'TOUCH' }) }],
        ['touch-2', () => { sys.send(h, { type: 'TOUCH' }) }],
      )
      return () => {
        strictEqual(sys.idle(), true)
        strictEqual(sys.read(h).data.count, 2)
        strictEqual(sys.read(h).data.settled, true)
        strictEqual(sys.read(h).waiting.settle, false)
      }
    })
    ok(explored.orderings >= 1)
  }],
]

await run(checks)
