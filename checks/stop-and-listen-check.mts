// Per-ref `sys.stop(handle)` and state-lifetime `listen` subscriptions.
//
//   npx vitest run stop-and-listen
import { deepStrictEqual, ok, strictEqual, throws } from 'node:assert'
import { createRenderer, defineComponent, h, nextTick } from '@vue/runtime-core'
import { Cancelled, forNet, given, state, type Defect, type Each, type StepLog } from '../src/index.ts'
import { mirror } from '../src/mirror.ts'
import { defectGuard, explore, onSchedule } from '../src/testing.ts'
import { nextTurn } from '../src/turn.ts'
import { vueBinding } from '../src/vue.ts'
import { connect, rest, run, system } from './checks.mts'

interface Node { type: string; text: string; children: Node[]; parent: Node | undefined }
const node = (type: string, text = ''): Node => ({ type, text, children: [], parent: undefined })
const { createApp } = createRenderer<Node, Node>({
  createElement: (type) => node(type),
  createText: (text) => node('#text', text),
  createComment: (text) => node('#comment', text),
  setText: (of, text) => { of.text = text },
  setElementText: (of, text) => { of.children = [Object.assign(node('#text', text), { parent: of })] },
  insert: (child, parent, anchor) => {
    if (child.parent) child.parent.children.splice(child.parent.children.indexOf(child), 1)
    child.parent = parent
    const at = anchor ? parent.children.indexOf(anchor) : -1
    if (at < 0) parent.children.push(child); else parent.children.splice(at, 0, child)
  },
  remove: (child) => { if (child.parent) child.parent.children.splice(child.parent.children.indexOf(child), 1); child.parent = undefined },
  parentNode: (of) => of.parent ?? null,
  nextSibling: (of) => { const among = of.parent?.children ?? []; return among[among.indexOf(of) + 1] ?? null },
  patchProp: () => {},
})
const shown = (of: Node): string => (of.type === '#text' ? of.text : of.type === '#comment' ? '' : of.children.map(shown).filter(Boolean).join(''))

const makeEmitter = <T,>() => {
  const subs = new Set<(value: T) => void>()
  return {
    subscribe: (fn: (value: T) => void): (() => void) => {
      subs.add(fn)
      return () => { subs.delete(fn) }
    },
    emit: (value: T): void => {
      for (const fn of [...subs]) fn(value)
    },
    get size(): number { return subs.size },
  }
}

await run([
  // ── System.stop(handle) ────────────────────────────────────────────────────────────────────────────────────────────

  ['sys.stop(handle) stops one top-level state and its children LIFO while leaving siblings running', async () => {
    const log: string[] = []
    const grandchild = state<{ data: { id: string } }>()({
      data: { id: given },
      run({ data, onExit }) { log.push(`enter:gc:${data.id}`); onExit(() => { log.push(`exit:gc:${data.id}`) }) },
    })
    const child = state<{ data: { id: string }; starts: { gc: typeof grandchild } }>()({
      data: { id: given },
      starts: (start) => ({ gc: start(grandchild, { given: (d) => ({ id: d.id }) }) }),
      run({ data, onExit }) { log.push(`enter:child:${data.id}`); onExit(() => { log.push(`exit:child:${data.id}`) }) },
    })
    const parent = state<{ data: { ids: string[] }; starts: { kid: Each<typeof child> } }, { type: 'NOOP' }>()({
      data: { ids: ['a', 'b'] },
      starts: (start) => ({ kid: start(child, { each: 'ids', given: (id) => ({ id }) }) }),
      run({ onExit }) { log.push('enter:parent'); onExit(() => { log.push('exit:parent') }) },
    })
    const sibling = state<{ data: { count: number } }, { type: 'INC' }, { GET: { args: {}; answer: number } }>()({
      data: { count: 1 },
      on: { INC: (_, { data }) => ({ data: { count: data.count + 1 } }) },
      answers: { GET: (_, { data }) => data.count },
      run({ onExit }) { log.push('enter:sibling'); onExit(() => { log.push('exit:sibling') }) },
    })

    const notifications: Array<readonly string[]> = []
    const sys = system({ side: 'backend' })
    const hParent = sys.start('parent', parent)
    const hSibling = sys.start('sibling', sibling)
    sys.subscribe((changed) => { notifications.push(changed) })

    strictEqual(sys.read(hParent).data.ids.length, 2)
    strictEqual(sys.read(sys.child(hParent, 'kid', 'a'))?.data.id, 'a')
    strictEqual(sys.read(sys.child(hParent, 'kid', 'b'))?.data.id, 'b')
    ok('parent' in sys.snapshot())
    ok('parent/kid/a' in sys.snapshot())
    ok('parent/kid/a/gc' in sys.snapshot())
    ok('sibling' in sys.snapshot())

    log.length = 0
    sys.stop(hParent)

    // Stopped parent and its descendants LIFO (b then a; gc before child; children before parent release).
    deepStrictEqual(log, [
      'exit:gc:b', 'exit:child:b',
      'exit:gc:a', 'exit:child:a',
      'exit:parent',
    ])
    strictEqual(sys.read(hParent), undefined)
    strictEqual(sys.read(sys.child(hParent, 'kid', 'a')), undefined)
    strictEqual(sys.read(sys.child(hParent, 'kid', 'b')), undefined)
    ok(!('parent' in sys.snapshot()))
    ok(!('parent/kid/a' in sys.snapshot()))
    ok(!('parent/kid/a/gc' in sys.snapshot()))
    ok('sibling' in sys.snapshot())
    strictEqual(notifications.length, 1)
    ok(notifications[0]!.includes('parent'))
    ok(notifications[0]!.includes('parent/kid/a'))
    ok(notifications[0]!.includes('parent/kid/b'))
    ok(!notifications[0]!.includes('sibling'))

    // Sibling keeps working normally.
    sys.send(hSibling, { type: 'INC' })
    strictEqual(sys.read(hSibling).data.count, 2)
    deepStrictEqual(await sys.ask(hSibling, 'GET', {}), { ok: true, value: 2 })
    strictEqual(sys.idle(), true)
  }],

  ['sys.stop(handle) cancels run, follows, loads, calls, abandons in-flight asks, and runs releases LIFO', async () => {
    const events: string[] = []
    const releaseSlowAsks: Array<() => void> = []
    let releaseCallAsk!: () => void
    let viewStops = 0

    type Net = {
      systems: {
        worker: { events: never; asks: { LOAD_SLOW: { args: {}; answer: string }; SAVE_SLOW: { args: {}; answer: string } } }
        target: { events: { type: 'FIRE' }; asks: { HOLD: { args: {}; answer: string } } }
      }
      surfaces: {}
      views: { items: { all: { args: {}; result: string[] } } }
    }
    const netState = forNet<Net>()

    const worker = netState<{}, never, Net['systems']['worker']['asks']>()({
      answers: {
        LOAD_SLOW: async (_, { signal }) => {
          signal.addEventListener('abort', () => { events.push('load:aborted') })
          await new Promise<void>((resolve) => { releaseSlowAsks.push(resolve) })
          return 'loaded'
        },
        SAVE_SLOW: async (_, { signal }) => {
          signal.addEventListener('abort', () => { events.push('call:aborted') })
          await new Promise<void>((resolve) => { releaseCallAsk = resolve })
          return 'saved'
        },
      },
    })

    const target = netState<{ data: { seen: string[] }; calls: { save: 'one' } }, { type: 'FIRE' }, Net['systems']['target']['asks']>()({
      data: { seen: [] },
      follows: (follow) => ({
        items: follow('items', 'all', {
          updated: (u) => (u.ok ? { data: { seen: u.value } } : undefined),
        }),
      }),
      loads: (load) => ({
        slow: load('worker', 'LOAD_SLOW', {
          done: () => { events.push('load:done') },
        }),
      }),
      calls: ({ one }) => ({
        save: one('worker', 'SAVE_SLOW', {
          done: () => { events.push('call:done') },
        }),
      }),
      on: {
        FIRE: (_, { call }) => { call('save') },
      },
      answers: {
        HOLD: async (_, { signal }) => {
          await new Promise<void>((resolve) => {
            signal.addEventListener('abort', () => { events.push('answer:aborted'); resolve() })
          })
          return 'never'
        },
      },
      async run({ ask, onExit, signal }) {
        onExit(() => { events.push('release:1') })
        onExit(() => { events.push('release:2') })
        signal.addEventListener('abort', () => { events.push('run:signal-aborted') })
        try {
          await ask('worker', 'LOAD_SLOW', {})
        } catch (error) {
          events.push(error instanceof Cancelled ? 'run:cancelled' : 'run:other-error')
          throw error
        }
      },
      failed: () => { events.push('run:failed') },
    })

    const sys = system({
      side: 'backend',
      views: (_f, _v, _a, updated) => {
        updated({ ok: true, value: ['v1'] })
        return () => { viewStops++; events.push('view:stopped') }
      },
    })
    const hWorker = sys.start('worker', worker)
    const hTarget = sys.start('target', target)
    sys.send(hTarget, { type: 'FIRE' })
    const holdPromise = sys.ask(hTarget, 'HOLD', {})
    strictEqual(sys.read(hTarget).pending.save, true)
    strictEqual(sys.idle(), false)

    sys.stop(hTarget)
    const holdOutcome = await holdPromise
    deepStrictEqual(holdOutcome, { ok: false, failure: { kind: 'abandoned', message: 'It stopped before answering' } })
    for (const release of releaseSlowAsks) release()
    releaseCallAsk()
    await rest()

    strictEqual(viewStops, 1)
    ok(events.includes('run:signal-aborted'))
    ok(events.includes('run:cancelled'))
    ok(!events.includes('run:failed'))
    ok(events.includes('view:stopped'))
    ok(events.includes('load:aborted'))
    ok(events.includes('call:aborted'))
    ok(events.includes('answer:aborted'))
    ok(!events.includes('load:done'))
    ok(!events.includes('call:done'))
    // LIFO release ordering
    ok(events.indexOf('release:2') < events.indexOf('release:1'), events.join(', '))
    // Worker sibling still alive; system returns to idle.
    ok(sys.read(hWorker) !== undefined)
    strictEqual(sys.read(hTarget), undefined)
    strictEqual(sys.idle(), true)
  }],

  ['sys.stop(handle) updates Vue mirror and useState reactively and survives hot reload', async () => {
    const packA = state<{ data: { version: number } }, { type: 'BUMP' }>()({
      data: { version: 1 },
      on: { BUMP: (_, { data }) => ({ data: { version: data.version + 1 } }) },
    })
    const packAv2 = state<{ data: { version: number } }, { type: 'BUMP' }>()({
      data: { version: 10 },
      on: { BUMP: (_, { data }) => ({ data: { version: data.version + 1 } }) },
    })
    const packB = state<{ data: { label: string } }>()({
      data: { label: 'steady' },
    })

    const sys = system({ side: 'window' })
    const hA = sys.start('packA', packA)
    const hB = sys.start('packB', packB)

    const mA = mirror(sys, hA)
    const mB = mirror(sys, hB)
    const readMirrorA = () => mA.value as { readonly data: { readonly version: number } } | undefined
    strictEqual(readMirrorA()?.data.version, 1)
    strictEqual(mB.value.data.label, 'steady')

    const { provide, useState } = vueBinding<{ packA: typeof packA; packB: typeof packB }>()
    let rendersA = 0
    let rendersB = 0
    const ViewA = defineComponent({
      setup() {
        const { state: s } = useState('packA')
        return () => {
          rendersA++
          const current = s.value as { readonly data: { readonly version: number } } | undefined
          return h('span', current ? `v${current.data.version}` : 'unloaded')
        }
      },
    })
    const ViewB = defineComponent({
      setup() {
        const { state: s } = useState('packB')
        return () => {
          rendersB++
          return h('span', s.value.data.label)
        }
      },
    })
    const root = node('div')
    const app = createApp({ render: () => h('div', [h(ViewA), h(ViewB)]) })
    provide(app, sys)
    app.mount(root)

    strictEqual(shown(root), 'v1steady')
    strictEqual(rendersA, 1)
    strictEqual(rendersB, 1)

    // Unload packA only.
    sys.stop(hA)
    await nextTick()
    strictEqual(readMirrorA(), undefined)
    strictEqual(mB.value.data.label, 'steady')
    strictEqual(shown(root), 'unloadedsteady')
    strictEqual(rendersA, 2)
    strictEqual(rendersB, 1)

    // Hot-reload packA with v2.
    const hAv2 = sys.start('packA', packAv2)
    await nextTick()
    strictEqual(readMirrorA()?.data.version, 10)
    strictEqual(shown(root), 'v10steady')
    strictEqual(rendersA, 3)
    strictEqual(rendersB, 1)

    sys.send(hAv2, { type: 'BUMP' })
    await nextTick()
    strictEqual(shown(root), 'v11steady')
    strictEqual(rendersA, 4)
    strictEqual(rendersB, 1)

    app.unmount()
    mA.stop()
    mB.stop()
  }],

  ['sys.stop(handle) is a safe no-op on unknown or already-stopped handles and throws synchronously on started children', () => {
    const defects: Defect[] = []
    const steps: StepLog[] = []
    const singleKid = state<{}>()({})
    const keyedKid = state<{ data: { id: string } }>()({ data: { id: given } })
    const parent = state<{
      data: { ids: string[] }
      starts: { one: typeof singleKid; many: Each<typeof keyedKid> }
    }, { type: 'ADD'; id: string }>()({
      data: { ids: ['x'] },
      starts: (start) => ({
        one: singleKid,
        many: start(keyedKid, { each: 'ids', given: (id) => ({ id }) }),
      }),
      on: { ADD: ({ id }) => ({ data: (d) => { d.ids.push(id) } }) },
    })

    const sys = system({ side: 'backend', name: 'host', onDefect: (d) => defects.push(d), log: (s) => steps.push(s) })
    const hParent = sys.start('parent', parent)
    const hOne = sys.child(hParent, 'one')
    const hMany = sys.child(hParent, 'many', 'x')
    const stepsBefore = steps.length

    // Passing a child handle throws synchronously with a clear message and leaves both child and parent running.
    throws(
      () => sys.stop(hOne),
      /host cannot stop parent\/one: it was started by parent; change its starter's data to stop it/,
    )
    throws(
      () => sys.stop(hMany),
      /host cannot stop parent\/many\/x: it was started by parent; change its starter's data to stop it/,
    )
    ok(sys.read(hOne) !== undefined)
    ok(sys.read(hMany) !== undefined)
    strictEqual(steps.length, stepsBefore)

    // Unknown / not-running handle is a safe no-op (no step, no throw, no defect).
    sys.stop(sys.child(hParent, 'many', 'missing'))
    strictEqual(steps.length, stepsBefore)

    // Stopping parent succeeds; stopping it a second time is a safe no-op.
    sys.stop(hParent)
    const stepsAfterStop = steps.length
    strictEqual(sys.read(hParent), undefined)
    sys.stop(hParent)
    strictEqual(steps.length, stepsAfterStop)
    deepStrictEqual(defects, [])

    // Queued guard: during subscribe flush, queue spawning child 'y' and immediately call sys.stop(childY).
    const hParent2 = sys.start('parent', parent)
    const hChildY = sys.child(hParent2, 'many', 'y')
    let queuedError: unknown
    const unsub = sys.subscribe(() => {
      unsub()
      sys.send(hParent2, { type: 'ADD', id: 'y' })
      sys.stop(hChildY)
    })
    try {
      sys.send(hParent2, { type: 'ADD', id: 'z' })
    } catch (error) {
      queuedError = error
    }
    ok(queuedError instanceof Error, 'queued stop on newly spawned child should throw')
    ok(/cannot stop parent\/many\/y: it was started by parent/.test(queuedError.message), queuedError.message)
    ok(sys.read(hChildY) !== undefined)

    // Queued duplicate stop(handle) during flush is a safe no-op on the second queued step.
    const unsub2 = sys.subscribe(() => {
      unsub2()
      sys.stop(hParent2)
      sys.stop(hParent2)
    })
    sys.send(hParent2, { type: 'ADD', id: 'w' })
    strictEqual(sys.read(hParent2), undefined)

    // Stopping a handle still succeeds even after host.limit is reached.
    const limited = system({ side: 'backend', limit: 1 })
    const hLim = limited.start('lim', singleKid)
    limited.stop(hLim)
    strictEqual(limited.read(hLim), undefined)
  }],

  ['sys.stop(handle) immediately followed by sys.start(ref, next) ignores stale async settlements from old incarnation', async () => {
    let settleOldRun!: (value: { data: { label: string } }) => void
    const oldState = state<{ data: { label: string } }>()({
      data: { label: 'old' },
      async run() {
        return await new Promise<{ data: { label: string } }>((resolve) => { settleOldRun = resolve })
      },
      failed: () => {},
    })
    const newState = state<{ data: { label: string } }>()({
      data: { label: 'new' },
    })

    const defects: Defect[] = []
    const sys = system({ side: 'backend', onDefect: (d) => defects.push(d) })
    const h1 = sys.start('pack', oldState)
    strictEqual(sys.read(h1).data.label, 'old')

    sys.stop(h1)
    const h2 = sys.start('pack', newState)
    strictEqual(sys.read(h2).data.label, 'new')

    // Old incarnation settles after hot reload — must be ignored cleanly.
    settleOldRun({ data: { label: 'stale-overwrite' } })
    await rest()
    strictEqual(sys.read(h2).data.label, 'new')
    deepStrictEqual(defects, [])
    strictEqual(sys.idle(), true)
  }],

  // ── Def.listen ─────────────────────────────────────────────────────────────────────────────────────────────────────

  ['listen receives external push events across turns while sys.idle() stays true and supports send/tell/broadcast/call/cancel/report', async () => {
    const emitter = makeEmitter<{ op: 'send' | 'internal' | 'tell' | 'broadcast' | 'call' | 'cancel' | 'report'; text: string }>()
    const peerEvents: string[] = []
    let releaseCall!: () => void
    let callAborted = false

    type Net = {
      systems: {
        svc: { events: { type: 'HEARD'; text: string }; asks: { WORK: { args: {}; answer: string } } }
      }
      surfaces: { panel: { events: { type: 'FLASH'; text: string } } }
      views: {}
      peers: { audit: { events: { type: 'LOG'; text: string } } }
    }
    const netState = forNet<Net>()

    const svc = netState<{ data: { heard: string[] } }, { type: 'HEARD'; text: string }, Net['systems']['svc']['asks']>()({
      data: { heard: [] },
      on: { HEARD: ({ text }) => ({ data: (d) => { d.heard.push(text) } }) },
      answers: {
        WORK: async (_, { signal }) => {
          signal.addEventListener('abort', () => { callAborted = true })
          await new Promise<void>((resolve) => { releaseCall = resolve })
          return 'ok'
        },
      },
    })

    const childMachine = netState<{
      data: { own: string[]; internal: string[] }
      internal: { type: 'INT'; text: string }
      reports: { type: 'REPORTED'; text: string }
      calls: { work: 'one' }
    }, { type: 'EXT'; text: string }>()({
      data: { own: [], internal: [] },
      calls: ({ one }) => ({ work: one('svc', 'WORK', { done: () => undefined }) }),
      listen({ send, tell, broadcast, call, cancel, report }) {
        return emitter.subscribe((msg) => {
          if (msg.op === 'send') send({ type: 'EXT', text: msg.text })
          if (msg.op === 'internal') send({ type: 'INT', text: msg.text })
          if (msg.op === 'tell') { tell('svc', { type: 'HEARD', text: msg.text }); tell({ peer: 'audit' }, { type: 'LOG', text: msg.text }) }
          if (msg.op === 'broadcast') broadcast('panel', { type: 'FLASH', text: msg.text })
          if (msg.op === 'call') call('work')
          if (msg.op === 'cancel') cancel('work')
          if (msg.op === 'report') report({ type: 'REPORTED', text: msg.text })
        })
      },
      on: { EXT: ({ text }) => ({ data: (d) => { d.own.push(text) } }) },
      internal: { INT: ({ text }) => ({ data: (d) => { d.internal.push(text) } }) },
    })

    const hostParent = netState<{
      data: { reports: string[] }
      starts: { child: typeof childMachine }
    }, { type: 'REPORTED'; from: string; text: string }>()({
      data: { reports: [] },
      starts: () => ({ child: childMachine }),
      on: { REPORTED: ({ from, text }) => ({ data: (d) => { d.reports.push(`${from}:${text}`) } }) },
    })

    const panel = netState<{ data: { flashes: string[] } }, { type: 'FLASH'; text: string }>()({
      data: { flashes: [] },
      on: { FLASH: ({ text }) => ({ data: (d) => { d.flashes.push(text) } }) },
    })

    const backend = system({ side: 'backend' })
    const win = system({ side: 'window' })
    connect(win, backend)
    backend.attach('audit', { tell: (_to, ev) => { peerEvents.push((ev as { text: string }).text) } })
    const hSvc = backend.start('svc', svc)
    const hParent = backend.start('parent', hostParent)
    const hPanel = win.start('panel', panel)
    const hChild = backend.child(hParent, 'child')

    // Active listener does NOT block sys.idle()!
    strictEqual(emitter.size, 1)
    strictEqual(backend.idle(), true)
    strictEqual(win.idle(), true)

    // Emit across separate turns.
    emitter.emit({ op: 'send', text: 'one' })
    strictEqual(backend.idle(), true)
    await new Promise<void>((resolve) => nextTurn(resolve))

    emitter.emit({ op: 'internal', text: 'two' })
    emitter.emit({ op: 'tell', text: 'three' })
    emitter.emit({ op: 'broadcast', text: 'four' })
    emitter.emit({ op: 'report', text: 'five' })
    await rest()

    deepStrictEqual(backend.read(hChild)?.data.own, ['one'])
    deepStrictEqual(backend.read(hChild)?.data.internal, ['two'])
    deepStrictEqual(backend.read(hSvc).data.heard, ['three'])
    deepStrictEqual(peerEvents, ['three'])
    deepStrictEqual(win.read(hPanel).data.flashes, ['four'])
    deepStrictEqual(backend.read(hParent).data.reports, ['child:five'])
    strictEqual(backend.idle(), true)

    // call + cancel from listen
    emitter.emit({ op: 'call', text: '' })
    strictEqual(backend.read(hChild)?.pending.work, true)
    emitter.emit({ op: 'cancel', text: '' })
    strictEqual(backend.read(hChild)?.pending.work, false)
    strictEqual(callAborted, true)
    releaseCall()
    await rest()
    strictEqual(backend.idle(), true)
  }],

  ['listen runs after data init and before run, and cleans up LIFO with onExit on transition, stop(handle), and stop()', () => {
    const order: string[] = []
    const emitter = makeEmitter<string>()

    const machine = state<{
      data: { label: string; heard: string[] }
      states: { a: {}; b: { data: { sub: string } } }
    }, { type: 'HEAR'; value: string } | { type: 'GO_B'; sub: string } | { type: 'REENTER_A' }>()({
      data: { label: 'root', heard: [] },
      initial: 'a',
      listen({ data, send, onExit }) {
        order.push(`root:listen:${data.label}`)
        onExit(() => { order.push('root:onExit-in-listen') })
        const off = emitter.subscribe((v) => send({ type: 'HEAR', value: `root:${v}` }))
        return () => { off(); order.push('root:listen-return') }
      },
      run({ onExit }) {
        order.push('root:run')
        onExit(() => { order.push('root:onExit-in-run') })
        // Emitting synchronously during run is observed by listen (since listen ran first).
        emitter.emit('from-run')
      },
      on: {
        HEAR: ({ value }) => ({ data: (d) => { d.heard.push(value) } }),
        GO_B: ({ sub }) => ({ at: 'b', data: { sub } }),
        REENTER_A: () => ({ at: 'a' }),
      },
      states: {
        a: {
          listen({ onExit }) {
            order.push('a:listen')
            onExit(() => { order.push('a:onExit-in-listen') })
            return () => { order.push('a:listen-return') }
          },
          run({ onExit }) {
            order.push('a:run')
            onExit(() => { order.push('a:onExit-in-run') })
          },
        },
        b: {
          data: { sub: given },
          listen({ data }) {
            order.push(`b:listen:${data.sub}`)
            return () => { order.push('b:listen-return') }
          },
        },
      },
    })

    const sys = system({ side: 'backend' })
    const h = sys.start('m', machine)
    deepStrictEqual(order, ['root:listen:root', 'root:run', 'a:listen', 'a:run'])
    deepStrictEqual(sys.read(h).data.heard, ['root:from-run'])
    strictEqual(emitter.size, 1)

    // Self-transition re-enters 'a': old 'a' releases LIFO, new 'a' listens again; root stays untouched.
    order.length = 0
    sys.send(h, { type: 'REENTER_A' })
    deepStrictEqual(order, ['a:onExit-in-run', 'a:listen-return', 'a:onExit-in-listen', 'a:listen', 'a:run'])

    // Transition from 'a' to 'b': 'a' exits LIFO, 'b' enters with initialized given data; root stays active.
    order.length = 0
    sys.send(h, { type: 'GO_B', sub: 'beta' })
    deepStrictEqual(order, ['a:onExit-in-run', 'a:listen-return', 'a:onExit-in-listen', 'b:listen:beta'])
    strictEqual(emitter.size, 1)

    // sys.stop(h): innermost ('b') then root, each LIFO.
    order.length = 0
    sys.stop(h)
    deepStrictEqual(order, ['b:listen-return', 'root:onExit-in-run', 'root:listen-return', 'root:onExit-in-listen'])
    strictEqual(emitter.size, 0)

    // Also verify sys.stop() (no arg) cleans up listen.
    order.length = 0
    sys.start('m', machine)
    strictEqual(emitter.size, 1)
    order.length = 0
    sys.stop()
    deepStrictEqual(order, ['a:onExit-in-run', 'a:listen-return', 'a:onExit-in-listen', 'root:onExit-in-run', 'root:listen-return', 'root:onExit-in-listen'])
    strictEqual(emitter.size, 0)
  }],

  ['late listen callback after state exit is silently ignored for send, tell, broadcast, call, cancel, report, and onExit', async () => {
    const defects: Defect[] = []
    let strayFire!: () => void
    let strayReleaseRan = false

    type Net = {
      systems: { svc: { events: { type: 'PING' }; asks: { SAVE: { args: {}; answer: string } } } }
      surfaces: { panel: { events: { type: 'FLASH' } } }
      views: {}
    }
    const netState = forNet<Net>()

    const svc = netState<{ data: { pings: number } }, { type: 'PING' }, Net['systems']['svc']['asks']>()({
      data: { pings: 0 },
      on: { PING: (_, { data }) => ({ data: { pings: data.pings + 1 } }) },
      answers: { SAVE: () => 'ok' },
    })

    const child = netState<{
      data: { count: number }
      calls: { save: 'one' }
      reports: { type: 'PINGED' }
      states: { listening: {}; quiet: {} }
    }, { type: 'BUMP' } | { type: 'QUIET' }>()({
      data: { count: 0 },
      initial: 'listening',
      calls: ({ one }) => ({ save: one('svc', 'SAVE', { done: () => undefined }) }),
      on: {
        BUMP: (_, { data }) => ({ data: { count: data.count + 1 } }),
        QUIET: () => ({ at: 'quiet' }),
      },
      states: {
        listening: {
          listen(scope) {
            strayFire = () => {
              strictEqual(scope.signal.aborted, true)
              scope.send({ type: 'BUMP' })
              scope.tell('svc', { type: 'PING' })
              scope.broadcast('panel', { type: 'FLASH' })
              scope.call('save')
              scope.cancel('save')
              scope.report({ type: 'PINGED' })
              scope.onExit(() => { strayReleaseRan = true })
            }
          },
        },
        quiet: {},
      },
    })

    const parent = netState<{ data: { reports: number }; starts: { child: typeof child } }, { type: 'PINGED'; from: string }>()({
      data: { reports: 0 },
      starts: () => ({ child }),
      on: { PINGED: (_, { data }) => ({ data: { reports: data.reports + 1 } }) },
    })

    const panel = netState<{ data: { flashes: number } }, { type: 'FLASH' }>()({
      data: { flashes: 0 },
      on: { FLASH: (_, { data }) => ({ data: { flashes: data.flashes + 1 } }) },
    })

    const backend = system({ side: 'backend', onDefect: (d) => defects.push(d) })
    const win = system({ side: 'window', onDefect: (d) => defects.push(d) })
    connect(win, backend)
    const hSvc = backend.start('svc', svc)
    const hParent = backend.start('parent', parent)
    const hPanel = win.start('panel', panel)
    const hChild = backend.child(hParent, 'child')

    // Leave 'listening' substate -> enter 'quiet'.
    backend.send(hChild, { type: 'QUIET' })
    strictEqual(backend.read(hChild)?.at, 'quiet')

    // Fire the stale callback from 'listening' after exit.
    strayFire()
    await rest()

    strictEqual(backend.read(hChild)?.data.count, 0)
    strictEqual(backend.read(hSvc).data.pings, 0)
    strictEqual(backend.read(hParent).data.reports, 0)
    strictEqual(win.read(hPanel).data.flashes, 0)
    strictEqual(strayReleaseRan, false)
    deepStrictEqual(defects, [])
  }],

  ['throwing synchronously inside listen rolls back transact, unsay, and partial onExit releases and reports a Defect', async () => {
    const defects: Defect[] = []
    const unwound: string[] = []
    const peerHeard: string[] = []
    const boom = new Error('subscribe exploded')

    // Simple in-memory transactional store with savepoint rollback.
    let committedRows: string[] = []
    const transact = <T,>(fn: () => T): T => {
      const savepoint = [...committedRows]
      try {
        return fn()
      } catch (error) {
        committedRows = savepoint
        throw error
      }
    }

    type Net = {
      systems: { other: { events: { type: 'PING' }; asks: {} } }
      surfaces: {}
      views: {}
      peers: { audit: { events: { type: 'NOTE' } } }
    }
    const netState = forNet<Net>()

    const other = netState<{ data: { pings: number } }, { type: 'PING' }>()({
      data: { pings: 0 },
      on: { PING: (_, { data }) => ({ data: { pings: data.pings + 1 } }) },
    })

    const flaky = netState<{ data: { count: number } }, { type: 'INC' }>()({
      data: { count: 0 },
      listen({ send, tell, onExit }) {
        committedRows.push('uncommitted-row')
        send({ type: 'INC' })
        tell('other', { type: 'PING' })
        tell({ peer: 'audit' }, { type: 'NOTE' })
        onExit(() => { unwound.push('partial-1') })
        onExit(() => { unwound.push('partial-2') })
        throw boom
      },
      on: { INC: (_, { data }) => ({ data: { count: data.count + 1 } }) },
    })

    const sys = system({ side: 'backend', transact, onDefect: (d) => defects.push(d) })
    sys.attach('audit', { tell: () => { peerHeard.push('NOTE') } })
    const hOther = sys.start('other', other)
    const hFlaky = sys.start('flaky', flaky)
    await rest()

    // Everything listen wrote/said before throwing was undone, partial onExit cleanups unwound LIFO, and Defect reported.
    deepStrictEqual(committedRows, [])
    strictEqual(sys.read(hFlaky).data.count, 0)
    strictEqual(sys.read(hOther).data.pings, 0)
    deepStrictEqual(peerHeard, [])
    deepStrictEqual(unwound, ['partial-2', 'partial-1'])
    strictEqual(defects.length, 1)
    strictEqual(defects[0]!.ref, 'flaky')
    strictEqual(defects[0]!.error, boom)
    ok(defects[0]!.message.includes("flaky's listen threw: subscribe exploded"), defects[0]!.message)

    // System and state remain healthy after isolated throw.
    sys.send(hFlaky, { type: 'INC' })
    strictEqual(sys.read(hFlaky).data.count, 1)
    // Stopping later does not re-run already-unwound partial releases.
    sys.stop(hFlaky)
    deepStrictEqual(unwound, ['partial-2', 'partial-1'])

    // Throwing inside a substate's listen includes the substate path in the defect message.
    const subBoom = new Error('sub listen boom')
    const subFlaky = state<{ states: { inner: {} } }>()({
      initial: 'inner',
      states: { inner: { listen() { throw subBoom } } },
    })
    sys.start('subFlaky', subFlaky)
    strictEqual(defects.length, 2)
    ok(defects[1]!.message.includes("subFlaky in inner's listen threw: sub listen boom"), defects[1]!.message)
  }],

  ['listen cleanup throwing on exit is isolated as a Defect, and stopping self inside listen still runs returned cleanup', () => {
    const defects: Defect[] = []
    const ran: string[] = []
    const cleanupBoom = new Error('unsubscribe failed')

    const brokenUnsub = state<{}>()({
      listen({ onExit }) {
        onExit(() => { ran.push('before') })
        return () => { throw cleanupBoom }
      },
    })

    const sys = system({ side: 'backend', onDefect: (d) => defects.push(d) })
    const h = sys.start('brokenUnsub', brokenUnsub)
    sys.stop(h)
    deepStrictEqual(ran, ['before'])
    strictEqual(defects.length, 1)
    strictEqual(defects[0]!.ref, 'brokenUnsub')
    strictEqual(defects[0]!.error, cleanupBoom)

    // Stopping self synchronously inside listen: returned cleanup runs immediately, and run() does not execute.
    let selfStoppedCleanup = false
    let runExecuted = false
    const selfStop = state<{}>()({
      listen() {
        sys.stop({ ref: 'selfStop' } as never)
        return () => { selfStoppedCleanup = true }
      },
      run() { runExecuted = true },
    })
    sys.start('selfStop', selfStop)
    strictEqual(selfStoppedCleanup, true)
    strictEqual(runExecuted, false)
  }],
], async ({ every }) => {
  await every('concurrent stop(handle) and hot reload alongside a sibling produce zero defects under every ordering', () => explore((schedule) => {
    const guard = defectGuard()
    const emitter = makeEmitter<string>()
    const sys = system({ side: 'backend', ...onSchedule(schedule, 'backend'), ...guard })

    const sibling = state<{ data: { n: number } }, { type: 'INC' }, { GET: { args: {}; answer: number } }>()({
      data: { n: 0 },
      on: { INC: (_, { data }) => ({ data: { n: data.n + 1 } }) },
      answers: { GET: (_, { data }) => data.n },
    })

    const makePack = (tag: string) => state<{ data: { tag: string; heard: string[] } }, { type: 'PUSH'; v: string }>()({
      data: { tag, heard: [] },
      listen({ send }) {
        return emitter.subscribe((v) => send({ type: 'PUSH', v }))
      },
      on: { PUSH: ({ v }) => ({ data: (d) => { d.heard.push(v) } }) },
    })

    const hSibling = sys.start('sibling', sibling)
    const hPack1 = sys.start('pack', makePack('v1'))

    schedule.does(
      'reloader',
      ['stop pack v1', () => { sys.stop(hPack1) }],
      ['start pack v2', () => { sys.start('pack', makePack('v2')) }],
    )
    schedule.does(
      'external',
      ['emit e1', () => { emitter.emit('e1') }],
      ['emit e2', () => { emitter.emit('e2') }],
    )
    schedule.does(
      'sibling-user',
      ['inc sibling', () => { sys.send(hSibling, { type: 'INC' }) }],
      ['ask sibling', () => { void sys.ask(hSibling, 'GET', {}) }],
    )

    return () => {
      strictEqual(sys.read(hSibling).data.n, 1)
      strictEqual(sys.read(hPack1).data.tag, 'v2')
      strictEqual(emitter.size, 1)
      strictEqual(sys.idle(), true)
      sys.stop()
      strictEqual(emitter.size, 0)
      guard.assertNone()
    }
  }))
})
