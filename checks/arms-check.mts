// Imperative timers declared under `arms`: armed and disarmed on demand, owned by their state,
// tracked on `armed` beside `at` and `data`, and never blocking `idle()`.
//
//   npx vitest run arms
import { deepStrictEqual, ok, strictEqual, throws } from 'node:assert'
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
  ['one and each timers arm, expose frozen armed, fire done (transitions, data, raise, tell, call), and keep idle() true', async () => {
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
      calls: { save: { single: { tag: string } } }
      arms: {
        debounce: 'single'
        t: 'each' // 1-char name exercises slash index boundary in valueOf
      }
      states: { editing: {}; submitted: {} }
    }
    type Ev = { type: 'TYPE' } | { type: 'MARK'; key: string } | { type: 'RESET' }

    const form = netState<Shape, Ev>()({
      data: { fired: [], saved: [], internalHits: 0 },
      initial: 'editing',
      calls: ({ single }) => ({
        save: single('svc', 'SAVE', {
          done: (outcome) => (outcome.ok ? { data: (d) => { d.saved.push(outcome.value) } } : undefined),
        }),
      }),
      arms: ({ single, each }) => ({
        debounce: single({ after: 200, done: ({ raise, tell, call }) => {
          raise({ type: 'BUMP' })
          tell('svc', { type: 'NOTIFIED', tag: 'debounced' })
          call('save', { tag: 'doc' })
          return { at: 'submitted', data: (d) => { d.fired.push('debounce') } }
        } }),
        t: each({ after: 100, done: ({ key }) => ({ data: (d) => { d.fired.push(`each:${key}`) } }) }),
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
    deepStrictEqual(initial.armed, { debounce: false, t: {} })
    strictEqual(Object.isFrozen(initial.armed), true)
    strictEqual(Object.isFrozen(initial.armed.t), true)
    strictEqual(sys.idle(), true)

    sys.send(h, { type: 'TYPE' })
    sys.send(h, { type: 'MARK', key: 'a' })
    sys.send(h, { type: 'MARK', key: 'dir/file.ts' })
    // sys.idle() MUST remain true while timers are armed!
    strictEqual(sys.idle(), true)
    deepStrictEqual(sys.read(h).armed, { debounce: true, t: { a: true, 'dir/file.ts': true } })
    strictEqual(Object.isFrozen(sys.read(h).armed), true)
    strictEqual(Object.isFrozen(sys.read(h).armed.t), true)

    // Advance 100ms: `t` fires for both keys, `debounce` still armed.
    manual.advance(100)
    await rest()
    deepStrictEqual(sys.read(h).armed, { debounce: true, t: {} })
    deepStrictEqual(sys.read(h).data.fired, ['each:a', 'each:dir/file.ts'])
    strictEqual(sys.read(h).at, 'editing')
    strictEqual(sys.idle(), true)

    // Advance another 100ms: `debounce` fires, transitions to `submitted`, sends internal, tells svc, and calls save.
    manual.advance(100)
    await rest()
    strictEqual(sys.read(h).at, 'submitted')
    deepStrictEqual(sys.read(h).armed, { debounce: false, t: {} })
    deepStrictEqual(sys.read(h).data, { fired: ['each:a', 'each:dir/file.ts', 'debounce'], saved: ['saved:doc'], internalHits: 1 })
    deepStrictEqual(svcEvents, ['debounced'])
    deepStrictEqual(svcCalls, ['doc'])

    // StepLog records arm and expired with key for each and without key for one, never ms payload.
    const allHandled = logs.flatMap((l) => l.handled)
    ok(allHandled.some((x) => x.kind === 'arm' && x.ref === 'form' && x.name === 'debounce' && !('key' in x)))
    ok(allHandled.some((x) => x.kind === 'arm' && x.ref === 'form' && x.name === 't' && x.key === 'a'))
    ok(allHandled.some((x) => x.kind === 'expired' && x.ref === 'form' && x.name === 't' && x.key === 'dir/file.ts'))
    ok(allHandled.some((x) => x.kind === 'expired' && x.ref === 'form' && x.name === 'debounce' && !('key' in x)))
    ok(logs.some((l) => l.changed.form?.armed === true))
    strictEqual(JSON.stringify(allHandled).includes('200'), false)
  }],

  ['omitted done (pure-TTL flags) updates snapshot.armed, notifies subscribers, and drives Vue mirror and useState reactivity', async () => {
    const manual = manualClock()
    type FlagShape = {
      data: { label: string }
      arms: { pulse: 'single'; highlight: 'each' }
    }
    type FlagEv = { type: 'PULSE' } | { type: 'FLASH'; id: string } | { type: 'RENAME'; label: string }
    const flags = state<FlagShape, FlagEv>()({
      data: { label: 'init' },
      arms: ({ single, each }) => ({
        pulse: single({ after: 150 }),
        highlight: each({ after: 300 }),
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

    const notices: Array<{ armed: boolean; data: boolean }> = []
    sys.subscribe((_, f, c) => {
      const mine = c.flags
      if (mine) notices.push({ armed: mine.armed, data: (f.flags ?? []).length > 0 })
    })

    // Fine-grained mirror reactivity check.
    const held = mirror(sys, handle)
    const runs = { pulse: 0, a: 0, b: 0, label: 0 }
    effect(() => { runs.pulse++; void held.value.armed.pulse })
    effect(() => { runs.a++; void held.value.armed.highlight.a })
    effect(() => { runs.b++; void held.value.armed.highlight.b })
    effect(() => { runs.label++; void held.value.data.label })
    const since = { ...runs }
    const ran = (): string[] => {
      const hit = (Object.keys(runs) as Array<keyof typeof runs>).filter((k) => runs[k] !== since[k])
      Object.assign(since, runs)
      return hit
    }

    // Vue component using vueBinding / useState reads armed reactively in both Node and browser.
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
        const line = `${s.value.data.label}|p=${String(s.value.armed.pulse)}|a=${String(Boolean(s.value.armed.highlight.a))}`
        rendered.push(line)
        return h('div', line)
      }
    })
    const app = createApp(Comp)
    provide(app, sys)
    app.mount(mkNode())

    sys.send(handle, { type: 'PULSE' })
    deepStrictEqual(ran(), ['pulse'])
    strictEqual(held.value.armed.pulse, true)
    deepStrictEqual(notices.at(-1), { armed: true, data: false })

    sys.send(handle, { type: 'FLASH', id: 'a' })
    deepStrictEqual(ran(), ['a'])
    strictEqual(held.value.armed.highlight.a, true)

    sys.send(handle, { type: 'FLASH', id: 'b' })
    deepStrictEqual(ran(), ['b'])

    sys.send(handle, { type: 'RENAME', label: 'next' })
    deepStrictEqual(ran(), ['label'])
    await nextTick()
    strictEqual(rendered.at(-1), 'next|p=true|a=true')

    // Expire pulse at 150ms (pure TTL, no done): armed.pulse flips to false and triggers pulse reader only.
    manual.advance(150)
    deepStrictEqual(ran(), ['pulse'])
    strictEqual(held.value.armed.pulse, false)
    strictEqual(sys.read(handle).armed.pulse, false)

    // Expire highlights at 300ms.
    manual.advance(150)
    deepStrictEqual(ran(), ['a', 'b'])
    strictEqual(held.value.armed.highlight.a, undefined)
    strictEqual(held.value.armed.highlight.b, undefined)
    await nextTick()
    strictEqual(rendered.at(-1), 'next|p=false|a=false')
    deepStrictEqual(defects, [])
    app.unmount()
    held.stop()
  }],

  ["whenArmed: 'restart' (default) restarts the timer on re-arm without spurious subscriber notice; whenArmed: 'ignore' throttles and re-arms after expiry or inside done", async () => {
    const manual = manualClock()
    type Shape = {
      data: { debounced: number; throttled: number; selfRearms: number }
      arms: { deb: 'single'; thr: 'single'; loop: 'single' }
    }
    type Ev = { type: 'DEB' } | { type: 'THR' } | { type: 'LOOP' }
    const machine = state<Shape, Ev>()({
      data: { debounced: 0, throttled: 0, selfRearms: 0 },
      arms: ({ single }) => ({
        deb: single({ after: 100, done: ({ data }) => ({ data: { debounced: data.debounced + 1 } }) }),
        thr: single({ after: 100, whenArmed: 'ignore', done: ({ data }) => ({ data: { throttled: data.throttled + 1 } }) }),
        loop: single({
          after: 50,
          whenArmed: 'ignore',
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

    // Debounce (`whenArmed: 'restart'` default): arm at t=0, re-arm at t=60 -> original cancelled, fires at t=160.
    sys.send(h, { type: 'DEB' })
    strictEqual(subCalls, 1)
    manual.advance(60)
    sys.send(h, { type: 'DEB' })
    // Re-arming an already-armed timer does not change snapshot.armed (true -> true), so no spurious subscriber call!
    strictEqual(subCalls, 1)
    strictEqual(manual.cancelCalls(), 1)
    manual.advance(50) // t=110: old 100ms deadline passed, must NOT have fired.
    strictEqual(sys.read(h).data.debounced, 0)
    strictEqual(sys.read(h).armed.deb, true)
    manual.advance(50) // t=160: new deadline reached.
    strictEqual(sys.read(h).data.debounced, 1)
    strictEqual(sys.read(h).armed.deb, false)

    // Throttle (`whenArmed: 'ignore'`): arm at t=160, re-arm at t=210 -> ignored (no extra clock.after, no cancel), fires at t=260.
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
    strictEqual(sys.read(h).armed.thr, false)

    // Can re-arm throttle cleanly after expiry.
    sys.send(h, { type: 'THR' })
    strictEqual(sys.read(h).armed.thr, true)
    manual.advance(100)
    strictEqual(sys.read(h).data.throttled, 2)

    // Self-re-arming a `whenArmed: 'ignore'` timer inside `done` succeeds because the kernel cleared it before invoking `done`.
    sys.send(h, { type: 'LOOP' })
    manual.advance(50)
    strictEqual(sys.read(h).data.selfRearms, 1)
    strictEqual(sys.read(h).armed.loop, true)
    manual.advance(50)
    strictEqual(sys.read(h).data.selfRearms, 2)
    strictEqual(sys.read(h).armed.loop, false)
  }],

  ['a duration given at arm ({ single: "at arm" } / { each: "at arm" }) and an optional ms override on a timer with `after` work with and without done and whenArmed', async () => {
    const manual = manualClock()
    let builtSingleKind: string | undefined
    let builtEachKind: string | undefined
    type Shape = {
      data: { log: string[] }
      arms: {
        fixedSingle: 'single'
        fixedEach: 'each'
        undefinedAfter: 'single'
        dynSingleBare: { single: 'at arm' }
        dynSingleDone: { single: 'at arm' }
        dynSingleOpts: { single: 'at arm' }
        dynEachBare: { each: 'at arm' }
        dynEachDone: { each: 'at arm' }
        dynEachOpts: { each: 'at arm' }
      }
    }
    type Ev =
      | { type: 'FIXED_OVERRIDE' }
      | { type: 'DYN_ALL' }

    const m = state<Shape, Ev>()({
      data: { log: [] },
      arms: ({ single, each }) => {
        const fixedSingle = single({ after: 500, whenArmed: 'restart', done: () => ({ data: (d) => { d.log.push('fixedSingle') } }) })
        const fixedEach = each({ after: 500, whenArmed: 'restart', done: ({ key }) => ({ data: (d) => { d.log.push(`fixedEach:${key}`) } }) })
        builtSingleKind = fixedSingle.kind
        builtEachKind = fixedEach.kind
        return {
          fixedSingle,
          fixedEach,
          undefinedAfter: single({ after: undefined as unknown as number, done: () => ({ data: (d) => { d.log.push('undefinedAfterOverride') } }) }),
          dynSingleBare: single(),
          dynSingleDone: single({ done: () => ({ data: (d) => { d.log.push('dynSingleDone') } }) }),
          dynSingleOpts: single({ whenArmed: 'ignore', done: () => ({ data: (d) => { d.log.push('dynSingleOpts') } }) }),
          dynEachBare: each(),
          dynEachDone: each({ done: ({ key }) => ({ data: (d) => { d.log.push(`dynEachDone:${key}`) } }) }),
          dynEachOpts: each({ whenArmed: 'ignore', done: ({ key }) => ({ data: (d) => { d.log.push(`dynEachOpts:${key}`) } }) }),
        }
      },
      on: {
        FIXED_OVERRIDE: (_, { arm }) => {
          arm('fixedSingle', 25)
          arm('fixedEach', 'k', 40)
          arm('undefinedAfter', 30)
        },
        DYN_ALL: (_, { arm }) => {
          arm('dynSingleBare', 10)
          arm('dynSingleDone', 20)
          arm('dynSingleOpts', 30)
          arm('dynEachBare', 'a', 15)
          arm('dynEachDone', 'b', 25)
          arm('dynEachOpts', 'c', 35)
        },
      },
    })

    const sys = system({ side: 'backend', clock: manual.clock })
    const h = sys.start('m', m)
    strictEqual(builtSingleKind, 'single')
    strictEqual(builtEachKind, 'each')

    sys.send(h, { type: 'FIXED_OVERRIDE' })
    manual.advance(25)
    deepStrictEqual(sys.read(h).data.log, ['fixedSingle'])
    manual.advance(15)
    deepStrictEqual(sys.read(h).data.log, ['fixedSingle', 'undefinedAfterOverride', 'fixedEach:k'])

    sys.send(h, { type: 'DYN_ALL' })
    strictEqual(sys.read(h).armed.dynSingleBare, true)
    strictEqual(sys.read(h).armed.dynEachBare.a, true)
    manual.advance(10)
    strictEqual(sys.read(h).armed.dynSingleBare, false)
    manual.advance(5)
    strictEqual(sys.read(h).armed.dynEachBare.a, undefined)
    manual.advance(20)
    deepStrictEqual(sys.read(h).data.log, ['fixedSingle', 'undefinedAfterOverride', 'fixedEach:k', 'dynSingleDone', 'dynEachDone:b', 'dynSingleOpts', 'dynEachOpts:c'])
  }],

  ['ms === 0 schedules on a subsequent step (never synchronously), and invalid ms or missing clock report exact defects without arming', async () => {
    const manual = manualClock()
    const defects: Defect[] = []
    const order: string[] = []
    type Shape = {
      data: { ran: number }
      arms: { zero: 'single'; dyn: { single: 'at arm' }; keyed: { each: 'at arm' }; fixedKeyed: 'each' }
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
      arms: ({ single, each }) => ({
        zero: single({ after: 0, done: ({ data }) => { order.push('done'); return { data: { ran: data.ran + 1 } } } }),
        dyn: single({ done: () => { order.push('dyn') } }),
        keyed: each({ done: () => { order.push('keyed') } }),
        fixedKeyed: each({ after: 100 }),
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

    // Even if a clock fires ms===0 synchronously inside clock.after, the expiry runs in a subsequent step (after handler ends).
    manual.fireNextSync()
    sys.send(h, { type: 'ZERO' })
    deepStrictEqual(order, ['before-arm', 'after-arm', 'done'])
    strictEqual(sys.read(h).data.ran, 1)
    strictEqual(sys.read(h).armed.zero, false)

    // Standard async ms===0 via manual clock: not fired until advance(0).
    order.length = 0
    sys.send(h, { type: 'ZERO' })
    deepStrictEqual(order, ['before-arm', 'after-arm'])
    strictEqual(sys.read(h).armed.zero, true)
    manual.advance(0)
    deepStrictEqual(order, ['before-arm', 'after-arm', 'done'])
    strictEqual(sys.read(h).data.ran, 2)
    strictEqual(defects.length, 0)

    // Invalid durations and missing/non-string keys for `each` timers report exact defects without corrupting `armed`.
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
    deepStrictEqual(sys.read(h).armed, { zero: false, dyn: false, keyed: {}, fixedKeyed: {} })

    // Missing clock reports exact defect without arming.
    const noClockDefects: Defect[] = []
    const noClockSys = system({ side: 'backend', name: 'headless', onDefect: (d) => noClockDefects.push(d) })
    const nh = noClockSys.start('m', m)
    noClockSys.send(nh, { type: 'ZERO' })
    deepStrictEqual(noClockDefects.map((d) => ({ message: d.message, ref: d.ref })), [
      { message: 'm cannot arm zero: headless was given no clock; pass clock to system()', ref: 'm' },
    ])
    strictEqual(noClockSys.read(nh).armed.zero, false)
  }],

  ['clock.after throwing on fresh arm or re-arm and cancel throwing on disarm/exit are isolated with exact defects', async () => {
    const manual = manualClock()
    const defects: Defect[] = []
    type Shape = { data: { fired: number; bump: number }; states: { on: { arms: { w: 'single' } }; off: {} } }
    type Ev = { type: 'ARM' } | { type: 'DISARM' } | { type: 'LEAVE' } | { type: 'BUMP' }
    const m = state<Shape, Ev>()({
      data: { fired: 0, bump: 0 },
      initial: 'on',
      states: {
        on: {
          arms: ({ single }) => ({ w: single({ after: 100, done: ({ data }) => ({ data: { fired: data.fired + 1 } }) }) }),
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

    // Fresh arm throws in clock.after -> defect reported, armed stays false even after subsequent snapshot recompute.
    const afterErr1 = new Error('clock broken 1')
    manual.failNextAfter(afterErr1)
    sys.send(h, { type: 'ARM' })
    sys.send(h, { type: 'BUMP' })
    strictEqual(sys.read(h).armed.w, false)
    strictEqual(defects.length, 1)
    strictEqual(defects[0]!.message, 'm could not arm w: clock broken 1')
    strictEqual(defects[0]!.ref, 'm')
    strictEqual(defects[0]!.error, afterErr1)

    // Re-arm throws in clock.after -> defect reported, PREVIOUS armed timer remains intact and still fires!
    defects.length = 0
    sys.send(h, { type: 'ARM' })
    strictEqual(sys.read(h).armed.w, true)
    const afterErr2 = new Error('clock broken 2')
    manual.failNextAfter(afterErr2)
    sys.send(h, { type: 'ARM' })
    strictEqual(defects.length, 1)
    strictEqual(defects[0]!.message, 'm could not arm w: clock broken 2')
    strictEqual(sys.read(h).armed.w, true)
    manual.advance(100)
    strictEqual(sys.read(h).data.fired, 1)
    strictEqual(sys.read(h).armed.w, false)

    // Cancel throws on disarm -> defect isolated, armed still cleared.
    defects.length = 0
    sys.send(h, { type: 'ARM' })
    const cancelErr1 = new Error('cancel boom 1')
    manual.failNextCancel(cancelErr1)
    sys.send(h, { type: 'DISARM' })
    strictEqual(sys.read(h).armed.w, false)
    strictEqual(defects.length, 1)
    strictEqual(defects[0]!.message, "disarming m's timer w threw: cancel boom 1")
    strictEqual(defects[0]!.ref, 'm')
    strictEqual(defects[0]!.error, cancelErr1)

    // Cancel throws on state exit -> defect isolated, state still transitions and armed clears.
    defects.length = 0
    sys.send(h, { type: 'ARM' })
    const cancelErr2 = new Error('cancel boom 2')
    manual.failNextCancel(cancelErr2)
    sys.send(h, { type: 'LEAVE' })
    strictEqual(sys.read(h).at, 'off')
    strictEqual(sys.read(h).armed.w, false)
    strictEqual(defects.length, 1)
    strictEqual(defects[0]!.message, "disarming m's timer w threw: cancel boom 2")
  }],

  ['bulk disarm clears all active keys of an each timer without touching other timers, and single-key disarm clears only that key', async () => {
    const manual = manualClock()
    type Shape = {
      data: { fired: string[] }
      arms: { a: 'each'; b: 'each'; c: 'single' }
    }
    type Ev =
      | { type: 'ARM_ALL' }
      | { type: 'DISARM_ONE'; key: string }
      | { type: 'DISARM_BULK' }
      | { type: 'DISARM_C' }
    const m = state<Shape, Ev>()({
      data: { fired: [] },
      arms: ({ single, each }) => ({
        a: each({ after: 100, done: ({ key }) => ({ data: (d) => { d.fired.push(`a:${key}`) } }) }),
        b: each({ after: 100, done: ({ key }) => ({ data: (d) => { d.fired.push(`b:${key}`) } }) }),
        c: single({ after: 100, done: () => ({ data: (d) => { d.fired.push('c') } }) }),
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
    deepStrictEqual(sys.read(h).armed, { a: { k1: true, k2: true }, b: { k1: true }, c: true })

    // Single-key disarm removes only k1 of `a`.
    sys.send(h, { type: 'DISARM_ONE', key: 'k1' })
    deepStrictEqual(sys.read(h).armed, { a: { k2: true }, b: { k1: true }, c: true })

    // Bulk disarm removes all remaining keys of `a` while leaving `b` and `c` untouched.
    const cancelsBefore = manual.cancelCalls()
    sys.send(h, { type: 'DISARM_BULK' })
    strictEqual(manual.cancelCalls(), cancelsBefore + 1)
    deepStrictEqual(sys.read(h).armed, { a: {}, b: { k1: true }, c: true })

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
      arms: { thr: 'single' }
    }
    type Ev = { type: 'ARM' } | { type: 'DISARM_THEN_ARM' } | { type: 'ARM_THEN_DISARM' }
    const m = state<Shape, Ev>()({
      data: { fired: 0 },
      arms: ({ single }) => ({
        // whenArmed: 'ignore' proves `disarm; arm` truly disarmed before arming (restarting it to expire at t+100).
        thr: single({ after: 100, whenArmed: 'ignore', done: ({ data }) => ({ data: { fired: data.fired + 1 } }) }),
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
    strictEqual(sys.read(h).armed.thr, false)
    strictEqual(manual.activeCount(), 0)

    // Arm at t=0, advance to t=60, then `disarm; arm` in one step -> cancels old timer and arms new 100ms timer (t=160).
    sys.send(h, { type: 'ARM' })
    manual.advance(60)
    sys.send(h, { type: 'DISARM_THEN_ARM' })
    strictEqual(sys.read(h).armed.thr, true)
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
      arms: { w: 'single' }
    }
    type Ev =
      | { type: 'ARM' }
      | { type: 'ARM_AND_THROW' }
      | { type: 'DISARM_AND_THROW' }
      | { type: 'ARM_AND_REFUSE' }
      | { type: 'DISARM_AND_REFUSE' }

    const m = state<Shape, Ev>()({
      data: { n: 0 },
      arms: ({ single }) => ({ w: single({ after: 100, done: ({ data }) => ({ data: { n: data.n + 1 } }) }) }),
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
    strictEqual(sys.read(h).armed.w, false)
    strictEqual(manual.afterCalls(), 0)
    strictEqual(store.get('thread', 'a'), undefined)

    sys.send(h, { type: 'ARM_AND_REFUSE' })
    strictEqual(sys.read(h).armed.w, false)
    strictEqual(manual.afterCalls(), 0)

    // Arm legitimately, then fail to disarm via throw and via refused edit: timer stays armed and fires!
    sys.send(h, { type: 'ARM' })
    strictEqual(sys.read(h).armed.w, true)
    sys.send(h, { type: 'DISARM_AND_THROW' })
    sys.send(h, { type: 'DISARM_AND_REFUSE' })
    strictEqual(sys.read(h).armed.w, true)
    strictEqual(manual.cancelCalls(), 0)
    manual.advance(100)
    strictEqual(sys.read(h).data.n, 1)
    strictEqual(defects.length, 4)
  }],

  ['exit cleanup disarms on state leave, stop(handle), same-step arm+leave, late listen callbacks, and unknown timer names', async () => {
    const manual = manualClock()
    const lateArmParent: Array<() => void> = []
    const lateDisarmParent: Array<() => void> = []
    type Shape = {
      data: { fired: number }
      arms: { parentTimer: 'single' }
      states: {
        active: { arms: { w: 'single' } }
        idle: {}
      }
    }
    type Ev = { type: 'ARM' } | { type: 'ARM_PARENT' } | { type: 'ARM_AND_LEAVE' } | { type: 'LEAVE' } | { type: 'ENTER' } | { type: 'UNKNOWN' }
    const m = state<Shape, Ev>()({
      data: { fired: 0 },
      initial: 'active',
      arms: ({ single }) => ({ parentTimer: single({ after: 100 }) }),
      on: {
        ENTER: () => ({ at: 'active' }),
        ARM_PARENT: (_, { arm }) => { arm('parentTimer') },
        UNKNOWN: (_, { arm, disarm }) => {
          ;(arm as (n: string, extra?: string) => void)('missing', 'extra')
          ;(disarm as (n: string) => void)('missing')
        },
      },
      states: {
        active: {
          arms: ({ single }) => ({ w: single({ after: 100, done: ({ data }) => ({ data: { fired: data.fired + 1 } }) }) }),
          listen: ({ arm, disarm }) => {
            lateArmParent.push(() => { arm('parentTimer') })
            lateDisarmParent.push(() => { disarm('parentTimer') })
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
    const armedFlags: boolean[] = []
    sys.subscribe((_, _f, c) => { if (c.m) armedFlags.push(c.m.armed) })

    // Leaving with NO timers armed reports armed: false.
    sys.send(h, { type: 'LEAVE' })
    deepStrictEqual(armedFlags, [false])

    // Late listen callback from exited child ignores arm & disarm even for a still-live parent timer!
    lateArmParent[0]!()
    strictEqual(sys.read(h).armed.parentTimer, false)
    strictEqual(manual.afterCalls(), 0)
    sys.send(h, { type: 'ARM_PARENT' })
    strictEqual(sys.read(h).armed.parentTimer, true)
    lateDisarmParent[0]!()
    strictEqual(sys.read(h).armed.parentTimer, true)
    manual.advance(100)
    strictEqual(sys.read(h).armed.parentTimer, false)

    // Unknown timer name via cast is a safe no-op and does not record a bogus key in StepLog.
    const afterUnknown = manual.afterCalls()
    sys.send(h, { type: 'UNKNOWN' })
    strictEqual(manual.afterCalls(), afterUnknown)
    const unknownHandled = logs.flatMap((l) => l.handled).find((x) => x.kind === 'arm' && x.name === 'missing')
    deepStrictEqual(unknownHandled, { kind: 'arm', ref: 'm', name: 'missing' })

    // Re-enter, arm, then leave: cancel called and armed: true reported.
    sys.send(h, { type: 'ENTER' })
    armedFlags.length = 0
    sys.send(h, { type: 'ARM' })
    strictEqual(sys.read(h).armed.w, true)
    sys.send(h, { type: 'LEAVE' })
    strictEqual(sys.read(h).armed.w, false)
    deepStrictEqual(armedFlags, [true, true])
    strictEqual(manual.cancelCalls(), 1)
    manual.advance(100)
    strictEqual(sys.read(h).data.fired, 0)

    // Arm and leave in the SAME handler: queued arm sees exited state and does NOT schedule timer.
    sys.send(h, { type: 'ENTER' })
    const afterBefore = manual.afterCalls()
    sys.send(h, { type: 'ARM_AND_LEAVE' })
    strictEqual(sys.read(h).at, 'idle')
    strictEqual(sys.read(h).armed.w, false)
    strictEqual(manual.afterCalls(), afterBefore)

    // Stopping the handle (or system) disarms active timers.
    sys.send(h, { type: 'ENTER' })
    sys.send(h, { type: 'ARM' })
    strictEqual(manual.activeCount(), 1)
    sys.stop(h)
    strictEqual(manual.activeCount(), 0)
    manual.advance(200)
  }],

  ['stale expiry is impossible: late firing from buggy clock creates no step, and a queued expiry behind disarm is ignored', async () => {
    const manual = manualClock()
    type StreamNet = {
      systems: { svc: { events: never; asks: { STREAM: { args: {}; progress: string; answer: void } } } }
      surfaces: {}
      views: {}
    }
    const netState = forNet<StreamNet>()
    let emitProgress!: (p: string) => void
    let finishStream!: () => void
    const svc = netState<{}, never, StreamNet['systems']['svc']['asks']>()({
      answers: {
        STREAM: (_, { progress }) => new Promise<void>((resolve) => {
          emitProgress = progress
          finishStream = resolve
        }),
      },
    })
    type Shape = { data: { fired: number; batches: string[][] }; arms: { w: 'single' }; calls: { stream: 'single' } }
    type Ev = { type: 'ARM' } | { type: 'DISARM' } | { type: 'STREAM' }
    const m = netState<Shape, Ev>()({
      data: { fired: 0, batches: [] },
      arms: ({ single }) => ({ w: single({ after: 100, done: ({ data }) => ({ data: { fired: data.fired + 1 } }) }) }),
      calls: ({ single }) => ({
        stream: single('svc', 'STREAM', {
          progress: (updates) => ({ data: (d) => { d.batches.push([...updates]) } }),
          done: () => {},
        }),
      }),
      on: {
        ARM: (_, { arm }) => { arm('w') },
        DISARM: (_, { disarm }) => { disarm('w') },
        STREAM: (_, { call }) => { call('stream') },
      },
    })

    const logs: StepLog[] = []
    const sys = system({ side: 'backend', clock: manual.clock, log: (s) => logs.push(s) })
    sys.start('svc', svc)
    const h = sys.start('m', m)

    // Case A: buggy clock fires cancelled callback after disarm -> no StepLog entry, done never runs,
    // and gathered progress waiting for its frame is NOT flushed early by `handOver()`.
    sys.send(h, { type: 'STREAM' })
    sys.send(h, { type: 'ARM' })
    const firstCallback = manual.timers[0]!.run
    sys.send(h, { type: 'DISARM' })
    emitProgress('u1')
    const logsBefore = logs.length
    firstCallback()
    strictEqual(logs.length, logsBefore)
    strictEqual(sys.read(h).data.fired, 0)
    deepStrictEqual(sys.read(h).data.batches, [])
    finishStream()
    await rest()
    deepStrictEqual(sys.read(h).data.batches, [['u1']])

    // Case B: while flushing a commit, subscriber queues DISARM and THEN fires the timer -> DISARM runs first, the queued expiry is stale and dropped before starting a step!
    sys.send(h, { type: 'ARM' })
    const secondCallback = manual.timers[1]!.run
    const trigger = sys.start('t', state<{ data: { n: number } }, { type: 'GO' }>()({
      data: { n: 0 },
      on: { GO: (_, { data }) => ({ data: { n: data.n + 1 } }) },
    }))
    let triggered = false
    const unsub = sys.subscribe(() => {
      if (triggered) return
      triggered = true
      sys.send(h, { type: 'DISARM' })
      secondCallback()
    })
    const logsBeforeCaseB = logs.length
    sys.send(trigger, { type: 'GO' })
    unsub()
    strictEqual(triggered, true)
    strictEqual(sys.read(h).armed.w, false)
    strictEqual(sys.read(h).data.fired, 0)
    // Only `trigger GO` and `m DISARM` logged steps; the stale queued `expired` emitted no StepLog entry.
    strictEqual(logs.length, logsBeforeCaseB + 2)
    strictEqual(logs.slice(logsBeforeCaseB).some((s) => s.handled.some((x) => x.kind === 'expired')), false)
  }],

  ['done throwing reports exact defect and rolls back its sayings while still clearing armed', async () => {
    const manual = manualClock()
    const store = memory()
    const defects: Defect[] = []
    const boom = new Error('done exploded')
    type Shape = {
      data: { sideEffect: number }
      internal: { type: 'AFTER' }
      arms: { w: 'single' }
    }
    type Ev = { type: 'ARM' }
    const m = state<Shape, Ev>()({
      data: { sideEffect: 0 },
      arms: ({ single }) => ({
        w: single({ after: 50, done: ({ raise }) => {
          store.put('thread', '1', { topic: 'ok' })
          raise({ type: 'AFTER' })
          throw boom
        } }),
      }),
      internal: {
        AFTER: (_, { data }) => ({ data: { sideEffect: data.sideEffect + 1 } }),
      },
      on: { ARM: (_, { arm }) => { arm('w') } },
    })

    const sys = system({ side: 'backend', clock: manual.clock, transact: store.transact, onDefect: (d) => defects.push(d) })
    const h = sys.start('m', m)
    const armedChanges: boolean[] = []
    sys.subscribe((_, _f, c) => { if (c.m) armedChanges.push(c.m.armed) })

    sys.send(h, { type: 'ARM' })
    strictEqual(sys.read(h).armed.w, true)
    armedChanges.length = 0

    manual.advance(50)
    strictEqual(sys.read(h).armed.w, false)
    deepStrictEqual(armedChanges, [true])
    strictEqual(sys.read(h).data.sideEffect, 0)
    strictEqual(store.get('thread', '1'), undefined)
    strictEqual(defects.length, 1)
    strictEqual(defects[0]!.message, 'm threw in w done, and nothing changed: done exploded')
    strictEqual(defects[0]!.ref, 'm')
    strictEqual(defects[0]!.error, boom)
  }],

  ['ancestor resolution: parent timers armed from child survive sibling moves and disarm when leaving parent', async () => {
    const manual = manualClock()
    type Shape = {
      data: { expired: number; tags: string[] }
      states: {
        session: {
          arms: { keepalive: 'single'; tagged: 'each' }
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
          arms: ({ single, each }) => ({
            keepalive: single({ after: 100, done: ({ data }) => ({ data: { expired: data.expired + 1 } }) }),
            tagged: each({ after: 100, done: ({ key }) => ({ data: (d) => { d.tags.push(key) } }) }),
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
    strictEqual(sys.read(h).armed.keepalive, true)
    deepStrictEqual(sys.read(h).armed.tagged, { 'child-k': true })

    // Moving session.a -> session.b keeps `session` alive, so `keepalive` and `tagged` stay armed and fire!
    sys.send(h, { type: 'TO_B' })
    strictEqual(sys.read(h).at, 'session.b')
    strictEqual(sys.read(h).armed.keepalive, true)
    deepStrictEqual(sys.read(h).armed.tagged, { 'child-k': true })
    manual.advance(100)
    strictEqual(sys.read(h).data.expired, 1)
    deepStrictEqual(sys.read(h).data.tags, ['child-k'])
    strictEqual(sys.read(h).armed.keepalive, false)
    deepStrictEqual(sys.read(h).armed.tagged, {})

    // Arming from an `answers` handler (`Scope`) also works, and leaving `session` disarms it.
    const ans = await sys.ask(h, 'PING', {})
    deepStrictEqual(ans, { ok: true, value: 'armed' })
    strictEqual(sys.read(h).armed.keepalive, true)
    sys.send(h, { type: 'SIGN_OUT' })
    strictEqual(sys.read(h).at, 'signedOut')
    strictEqual(sys.read(h).armed.keepalive, false)
    manual.advance(100)
    strictEqual(sys.read(h).data.expired, 1)
  }],

  ['virtual-clock explore determinism across orderings', async () => {
    type Shape = {
      data: { count: number; settled: boolean }
      arms: { settle: 'single' }
    }
    type Ev = { type: 'TOUCH' }
    const debouncer = state<Shape, Ev>()({
      data: { count: 0, settled: false },
      arms: ({ single }) => ({
        settle: single({ after: 50, done: () => ({ data: { settled: true } }) }),
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
        strictEqual(sys.read(h).armed.settle, false)
      }
    })
    ok(explored.orderings >= 1)
  }],

  ['a timer declared with something other than options is refused on start, saying what it was given, and one with none or with options is not', async () => {
    const manual = manualClock()
    const sys = system({ side: 'backend', clock: manual.clock })
    const given = (what: unknown) => ({ def: { arms: ({ single }: { single: Function }) => ({ retry: single(what) }) } })
    throws(() => sys.start('number', given(100) as never), { message: 'number declares timer retry with a number where its options go: a timer takes { after, whenArmed, done }' })
    throws(() => sys.start('function', given(() => {}) as never), { message: 'function declares timer retry with a function where its options go: a timer takes { after, whenArmed, done }' })
    // One inside a state is refused as the one at the top is.
    throws(
      () => sys.start('inner', { def: { initial: 'a', states: { a: { arms: ({ each }: { each: Function }) => ({ flash: each('soon') }) } } } } as never),
      { message: 'inner declares timer flash with a string where its options go: a timer takes { after, whenArmed, done }' },
    )
    deepStrictEqual(sys.read(sys.start('none', given(undefined) as never)), { data: {}, armed: { retry: false } })
    deepStrictEqual(sys.read(sys.start('options', given({ after: 100 }) as never)), { data: {}, armed: { retry: false } })
  }],

  ['conflicting timer kinds across states fail fast on start while matching kinds across sibling states succeed', async () => {
    const manual = manualClock()
    const sys = system({ side: 'backend', clock: manual.clock })

    const sameKind = state<{ states: { a: { arms: { retry: 'single' } }; b: { arms: { retry: { single: 'at arm' } } } } }>()({
      initial: 'a',
      states: {
        a: { arms: ({ single }) => ({ retry: single({ after: 100 }) }) },
        b: { arms: ({ single }) => ({ retry: single() }) },
      },
    })
    const okHandle = sys.start('same-timer', sameKind)
    deepStrictEqual(sys.read(okHandle).armed, { retry: false })

    const conflicting = {
      def: {
        initial: 'a',
        states: {
          a: { arms: ({ single }: { single: Function }) => ({ retry: single({ after: 100 }) }) },
          outer: {
            initial: 'inner',
            states: {
              inner: { arms: ({ each }: { each: Function }) => ({ retry: each({ after: 100 }) }) },
            },
          },
        },
      },
    }
    throws(
      () => sys.start('bad-timers', conflicting as never),
      { message: 'bad-timers declares timer retry with conflicting kinds (single and each)' },
    )

    const directShadow = {
      def: {
        initial: 'a',
        arms: ({ single }: { single: Function }) => ({ retry: single({ after: 100 }) }),
        states: {
          a: { arms: ({ single }: { single: Function }) => ({ retry: single({ after: 100 }) }) },
        },
      },
    }
    throws(
      () => sys.start('direct-timer', directShadow as never),
      { message: 'direct-timer declares timer retry again at a, shadowing an enclosing state' },
    )
    strictEqual('direct-timer' in sys.snapshot(), false)

    const deepShadow = {
      def: {
        initial: 'mid',
        arms: ({ single }: { single: Function }) => ({ retry: single({ after: 100 }) }),
        states: {
          mid: {
            initial: 'leaf',
            states: {
              leaf: { arms: ({ single }: { single: Function }) => ({ retry: single({ after: 100 }) }) },
            },
          },
        },
      },
    }
    throws(
      () => sys.start('deep-timer', deepShadow as never),
      { message: 'deep-timer declares timer retry again at mid.leaf, shadowing an enclosing state' },
    )
    strictEqual('deep-timer' in sys.snapshot(), false)

    const midShadow = {
      def: {
        initial: 'mid',
        states: {
          mid: {
            initial: 'leaf',
            arms: ({ single }: { single: Function }) => ({ retry: single({ after: 100 }) }),
            states: {
              leaf: { arms: ({ single }: { single: Function }) => ({ retry: single({ after: 100 }) }) },
            },
          },
        },
      },
    }
    throws(
      () => sys.start('mid-timer', midShadow as never),
      { message: 'mid-timer declares timer retry again at mid.leaf, shadowing an enclosing state' },
    )
  }],
]

await run(checks)
