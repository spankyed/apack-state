// Non-window peers: tell-only ports named with `system.peer(name, peer)` and reached with
// `tell({ peer: name }, event)`. Delivered after the step commits with no view hold, passing `name` as `to`.
//
//   npx vitest run peers
import { deepStrictEqual, ok, strictEqual, throws } from 'node:assert'
import { dial, join, listen, memoryPair } from '@apackdev/link'
import { connect, rest, run, system } from './checks.mts'
import { forNet, type Lane, type PeerPort, type StepLog, type ViewHost, type ViewUpdate } from '../src/index.ts'
import { explore, onSchedule } from '../src/testing.ts'

type HistoryEvent = { type: 'STEP_RECORDED'; id: string; detail: string } | { type: 'RUN_ENDED'; id: string }
export type AppNet = {
  systems: { runner: { events: { type: 'RECORD'; id: string; detail: string } | { type: 'FAIL'; id: string } | { type: 'ASYNC_RECORD'; id: string }; asks: {} } }
  surfaces: { panel: { events: { type: 'RUN_CHANGED'; id: string } } }
  views: { runs: { list: { args: {}; result: readonly string[] } } }
  peers: { runHistory: { events: HistoryEvent }; audit: { events: { type: 'NOTE'; text: string } } }
}
export const state = forNet<AppNet>()

const runner = state<{ data: { ids: string[] }; states: { idle: {}; asyncStep: {} } }, { type: 'RECORD'; id: string; detail: string } | { type: 'FAIL'; id: string } | { type: 'ASYNC_RECORD'; id: string }>()({
  data: { ids: [] },
  initial: 'idle',
  on: {
    RECORD: ({ id, detail }, { data, tell, broadcast }) => {
      tell({ peer: 'runHistory' }, { type: 'STEP_RECORDED', id, detail })
      broadcast('panel', { type: 'RUN_CHANGED', id })
      return { data: { ids: [...data.ids, id] } }
    },
    FAIL: ({ id }, { tell }) => {
      tell({ peer: 'runHistory' }, { type: 'STEP_RECORDED', id, detail: 'should never leave' })
      throw new Error('handler failed')
    },
    ASYNC_RECORD: () => ({ at: 'asyncStep' }),
  },
  states: {
    idle: {},
    asyncStep: {
      async run({ tell }) {
        await Promise.resolve()
        tell({ peer: 'runHistory' }, { type: 'RUN_ENDED', id: 'async-1' })
        return { at: 'idle' }
      },
      failed: () => ({ at: 'idle' }),
    },
  },
})

const historyReceiver = (seen: HistoryEvent[]) => state<{}, HistoryEvent>()({
  on: {
    STEP_RECORDED: (event) => { seen.push(event) },
    RUN_ENDED: (event) => { seen.push(event) },
  },
})

await run([
  ['a one-method PeerPort receives tells after commit in FIFO order with peer name as to, on backend or window', async () => {
    const received: Array<{ to: string; event: unknown }> = []
    const sink: PeerPort = { tell: (to, event) => { received.push({ to, event }) } }
    const logs: StepLog[] = []
    const backend = system({ side: 'backend', log: (step) => logs.push(step) })
    backend.peer('runHistory', sink)
    const h = backend.start('runner', runner)

    backend.send(h, { type: 'RECORD', id: 'r1', detail: 'first' })
    backend.send(h, { type: 'RECORD', id: 'r2', detail: 'second' })
    await rest()

    deepStrictEqual(received, [
      { to: 'runHistory', event: { type: 'STEP_RECORDED', id: 'r1', detail: 'first' } },
      { to: 'runHistory', event: { type: 'STEP_RECORDED', id: 'r2', detail: 'second' } },
    ])
    deepStrictEqual(logs[1]!.sent.filter((s) => s.kind === 'peer'), [{ kind: 'peer', to: 'runHistory', name: 'STEP_RECORDED' }])
    ok(!('outcome' in logs[1]!.sent.find((s) => s.kind === 'peer')!))

    // Named peers also work on a window system.
    const winReceived: Array<{ to: string; event: unknown }> = []
    const win = system({ side: 'window' })
    win.peer('audit', { tell: (to, event) => { winReceived.push({ to, event }) } })
    const surface = state<{}, { type: 'LOG'; text: string }>()({
      on: { LOG: ({ text }, { tell }) => { tell({ peer: 'audit' }, { type: 'NOTE', text }) } },
    })
    const sh = win.start('panel', surface)
    win.send(sh, { type: 'LOG', text: 'clicked' })
    await rest()
    deepStrictEqual(winReceived, [{ to: 'audit', event: { type: 'NOTE', text: 'clicked' } }])
  }],

  ['an undone handler or a failed transaction commit sends nothing to a peer and emits no missing-peer trace', async () => {
    const received: unknown[] = []
    const traces: string[] = []
    const logs: StepLog[] = []
    const backend = system({ side: 'backend', trace: (line) => traces.push(line), log: (step) => logs.push(step) })
    // Intentionally NO peer attached when FAIL throws: undone handler must not trace missing peer or log dropped.
    const h = backend.start('runner', runner)
    backend.send(h, { type: 'FAIL', id: 'f1' })
    await rest()
    deepStrictEqual(traces.filter((line) => line.includes('no peer named')), [])
    deepStrictEqual(logs.at(-1)!.sent, [])

    // With a peer attached, a handler that throws still sends nothing.
    backend.peer('runHistory', { tell: (_to, event) => { received.push(event) } })
    backend.send(h, { type: 'FAIL', id: 'f2' })
    await rest()
    deepStrictEqual(received, [])

    // A step whose database transaction fails to commit sends nothing to the peer.
    let failCommit = false
    let depth = 0
    const flaky = system({
      side: 'backend',
      transact: (fn) => {
        depth++
        try {
          const out = fn()
          if (depth === 1 && failCommit) throw new Error('disk full')
          return out
        } finally { depth-- }
      },
    })
    const lostReceived: unknown[] = []
    const fh = flaky.start('runner', runner)
    flaky.peer('runHistory', { tell: (_to, event) => { lostReceived.push(event) } })
    failCommit = true
    flaky.send(fh, { type: 'RECORD', id: 'r-lost', detail: 'never' })
    await rest()
    deepStrictEqual(lostReceived, [])
  }],

  ['telling a missing or detached peer traces and records outcome dropped in StepLog.sent', async () => {
    const traces: string[] = []
    const logs: StepLog[] = []
    const backend = system({ side: 'backend', trace: (line) => traces.push(line), log: (step) => logs.push(step) })
    const h = backend.start('runner', runner)

    backend.send(h, { type: 'RECORD', id: 'r1', detail: 'unattached' })
    await rest()
    ok(traces.some((line) => /no peer named runHistory/.test(line)), traces.join('\n'))
    deepStrictEqual(logs.at(-1)!.sent.filter((s) => s.kind === 'peer'), [
      { kind: 'peer', to: 'runHistory', name: 'STEP_RECORDED', outcome: 'dropped' },
    ])
  }],

  ['a throwing peer is isolated via safely while subsequent work and logging still succeed', async () => {
    const traces: string[] = []
    const logs: StepLog[] = []
    const notified: string[] = []
    const backend = system({ side: 'backend', trace: (line) => traces.push(line), log: (step) => logs.push(step) })
    backend.peer('runHistory', { tell: () => { throw new Error('sink exploded') } })
    backend.subscribe((changed) => { notified.push(...changed) })
    const h = backend.start('runner', runner)

    backend.send(h, { type: 'RECORD', id: 'r1', detail: 'boom' })
    await rest()
    ok(traces.some((line) => /DEFECT: what leaves at the commit threw:.*sink exploded/.test(line)), traces.join('\n'))
    deepStrictEqual(backend.read(h).data.ids, ['r1'])
    ok(notified.includes('runner'))
    deepStrictEqual(logs.at(-1)!.sent.filter((s) => s.kind === 'peer'), [
      { kind: 'peer', to: 'runHistory', name: 'STEP_RECORDED', outcome: 'failed' },
    ])
  }],

  ['naming a peer twice throws, and a stale removal does not remove a peer newly given the same name', async () => {
    const seenA: unknown[] = []
    const seenB: unknown[] = []
    const backend = system({ side: 'backend' })
    const h = backend.start('runner', runner)

    const detachA = backend.peer('runHistory', { tell: (_to, event) => { seenA.push(event) } })
    throws(() => backend.peer('runHistory', { tell: () => {} }), /already has a peer named runHistory/)

    detachA()
    backend.peer('runHistory', { tell: (_to, event) => { seenB.push(event) } })
    // Calling stale detachA again must NOT detach B.
    detachA()

    backend.send(h, { type: 'RECORD', id: 'r1', detail: 'to-b' })
    await rest()
    deepStrictEqual(seenA, [])
    deepStrictEqual(seenB, [{ type: 'STEP_RECORDED', id: 'r1', detail: 'to-b' }])
  }],

  ['a peer that detaches mid-flush drops subsequent queued tells, and re-entering start/send/stop in peer.tell stays consistent', async () => {
    // 1. Mid-flush detach: a step emits two peer tells; the first detaches the peer, so the second is dropped.
    const received: unknown[] = []
    const traces: string[] = []
    const backend = system({ side: 'backend', trace: (line) => traces.push(line) })
    const doubleTeller = state<{}, { type: 'TWO' }>()({
      on: {
        TWO: (_, { tell }) => {
          tell({ peer: 'runHistory' }, { type: 'STEP_RECORDED', id: '1', detail: 'first' })
          tell({ peer: 'runHistory' }, { type: 'STEP_RECORDED', id: '2', detail: 'second' })
        },
      },
    })
    const h = backend.start('double', doubleTeller)
    let detach!: () => void
    detach = backend.peer('runHistory', {
      tell: (_to, event) => {
        received.push(event)
        detach()
      },
    })
    backend.send(h, { type: 'TWO' })
    deepStrictEqual(received, [{ type: 'STEP_RECORDED', id: '1', detail: 'first' }])
    ok(traces.some((line) => line.includes('no peer named runHistory')), traces.join('\n'))

    // 2. Re-entrant start() and send() from inside peer.tell() commit their own steps without clobbering the outer StepLog,
    //    and `flushing` defers pumping `outside` until the outer step finishes flushing its remaining leaving items.
    const logs: StepLog[] = []
    const flushOrder: string[] = []
    const sys2 = system({ side: 'backend', log: (step) => logs.push(step) })
    const counter = state<{ data: { n: number } }, { type: 'INC' }>()({
      data: { n: 0 },
      on: { INC: (_, { data }) => { flushOrder.push('inc'); return { data: { n: data.n + 1 } } } },
    })
    let spawnedHandle: unknown
    let readInCallback: unknown
    let idleInCallback: boolean | undefined
    sys2.peer('runHistory', {
      tell: (_to, event) => {
        const id = (event as { id: string }).id
        flushOrder.push(`peer:${id}`)
        if (!spawnedHandle) {
          idleInCallback = sys2.idle()
          const ch = sys2.start('counter', counter)
          spawnedHandle = ch
          readInCallback = sys2.read(ch)
          sys2.send(ch, { type: 'INC' })
        }
      },
    })
    const twoRunner = state<{}, { type: 'TWO' }>()({
      on: {
        TWO: (_, { tell }) => {
          tell({ peer: 'runHistory' }, { type: 'STEP_RECORDED', id: '1', detail: 'first' })
          tell({ peer: 'runHistory' }, { type: 'STEP_RECORDED', id: '2', detail: 'second' })
        },
      },
    })
    const r2 = sys2.start('runner', twoRunner)
    sys2.send(r2, { type: 'TWO' })
    await rest()
    strictEqual(idleInCallback, false)
    deepStrictEqual(flushOrder, ['peer:1', 'peer:2', 'inc'])
    strictEqual(readInCallback, undefined)
    strictEqual((sys2.snapshot().counter as { data: { n: number } }).data.n, 1)
    // Causal StepLog order: #1 start runner, #2 TWO, #3 start counter, #4 INC.
    deepStrictEqual(logs.map((step) => step.number), [1, 2, 3, 4])
    ok(logs[1]!.handled.some((item) => item.kind === 'event' && item.name === 'TWO'))
    ok('counter' in logs[2]!.changed)
    ok(logs[3]!.handled.some((item) => item.kind === 'event' && item.name === 'INC'))

    // 3. Re-entrant stop() from inside peer.tell() AND from inside a handler ends all states cleanly and drains outside.
    const sys3 = system({ side: 'backend' })
    const r3 = sys3.start('runner', runner)
    sys3.peer('runHistory', {
      tell: () => {
        sys3.send(r3, { type: 'RECORD', id: 'queued-before-stop', detail: 'x' })
        sys3.stop()
      },
    })
    sys3.send(r3, { type: 'RECORD', id: 'r3', detail: 'stop-me' })
    await rest()
    deepStrictEqual(sys3.snapshot(), {})
    strictEqual(sys3.idle(), true)

    const logs4: StepLog[] = []
    const sys4 = system({ side: 'backend', log: (step) => logs4.push(step) })
    const stopper = state<{ data: { n: number } }, { type: 'HALT' }>()({
      data: { n: 0 },
      on: { HALT: () => { sys4.stop() } },
    })
    const h4 = sys4.start('stopper', stopper)
    sys4.send(h4, { type: 'HALT' })
    deepStrictEqual(sys4.snapshot(), {})
    strictEqual(sys4.idle(), true)
    strictEqual(logs4.length, 2)
  }],

  ['telling a peer after await in run delivers in its own step', async () => {
    const seen: unknown[] = []
    const logs: StepLog[] = []
    const backend = system({ side: 'backend', log: (step) => logs.push(step) })
    backend.peer('runHistory', { tell: (_to, event) => { seen.push(event) } })
    const h = backend.start('runner', runner)

    backend.send(h, { type: 'ASYNC_RECORD', id: 'async-1' })
    await rest()
    strictEqual(backend.read(h).at, 'idle')
    deepStrictEqual(seen, [{ type: 'RUN_ENDED', id: 'async-1' }])
    ok(logs.some((step) => step.sent.some((s) => s.kind === 'peer' && s.to === 'runHistory' && s.name === 'RUN_ENDED')))
  }],

  ['a peer over @apackdev/link receives tells immediately while a window broadcast is held for a view', async () => {
    const rows: string[] = []
    const viewListeners: Array<(update: ViewUpdate<unknown>) => void> = []
    const pendingCaughtUp: Array<() => void> = []
    const views: ViewHost = (_feature, _view, _args, heard) => {
      viewListeners.push(heard)
      heard({ ok: true, value: [...rows] })
      return {
        stop: () => {},
        caughtUp: (then) => { pendingCaughtUp.push(then) },
      }
    }

    const backend = system({ side: 'backend', views })
    const window = system({ side: 'window' })
    const peerSystem = system({ side: 'backend', name: 'history' })

    const peerSeen: HistoryEvent[] = []
    peerSystem.start('runHistory', historyReceiver(peerSeen))

    // Wire window <-> backend over @apackdev/link.
    connect(window, backend)

    // Wire peer <-> backend directly over @apackdev/link with zero adapter.
    const [backendSide, peerSide] = memoryPair()
    const backendPeerLink = dial(backendSide)
    const peerLink = listen(peerSide)
    const toPeer = join(backendPeerLink, backend.port)
    const detachPeer = backend.peer('runHistory', toPeer)
    join(peerLink, peerSystem.port)
    backendPeerLink.onEnd(detachPeer)

    const winHeard: string[] = []
    const panel = state<{ data: { rows: readonly string[] } }, { type: 'RUN_CHANGED'; id: string }>()({
      data: { rows: [] },
      follows: (follow) => ({
        list: follow('runs', 'list', {
          args: () => ({}),
          updated: (update) => (update.ok ? { data: { rows: update.value } } : undefined),
        }),
      }),
      on: {
        RUN_CHANGED: ({ id }, { data }) => { winHeard.push(`${id}:${data.rows.join(',')}`) },
      },
    })
    window.start('panel', panel)

    const recorder = state<{}, { type: 'RECORD'; id: string }>()({
      on: {
        RECORD: ({ id }, { tell, broadcast }) => {
          rows.push(id)
          tell({ peer: 'runHistory' }, { type: 'STEP_RECORDED', id, detail: 'payload' })
          broadcast('panel', { type: 'RUN_CHANGED', id })
        },
      },
    })
    const rh = backend.start('recorder', recorder)
    await rest()

    // Trigger a step: broadcast to window is held until view catches up, peer tell is NOT held.
    backend.send(rh, { type: 'RECORD', id: 'run-1' })
    await rest()

    // Peer already received it over @apackdev/link while window's broadcast is still held!
    deepStrictEqual(peerSeen, [{ type: 'STEP_RECORDED', id: 'run-1', detail: 'payload' }])
    deepStrictEqual(winHeard, [])
    ok(pendingCaughtUp.length > 0, 'window broadcast must be waiting on view caughtUp')

    // Deliver the view update and release caughtUp -> window hears RUN_CHANGED with the row visible.
    for (const heard of viewListeners) heard({ ok: true, value: [...rows] })
    for (const release of pendingCaughtUp.splice(0)) release()
    await rest()

    deepStrictEqual(winHeard, ['run-1:run-1'])
    backendPeerLink.close()
  }],

  ['one port given two peer names receives each name as to, and removing one leaves the other', async () => {
    const historySeen: HistoryEvent[] = []
    const auditSeen: Array<{ type: 'NOTE'; text: string }> = []
    const remote = system({ side: 'backend' })
    remote.start('runHistory', historyReceiver(historySeen))
    remote.start('audit', state<{}, { type: 'NOTE'; text: string }>()({
      on: { NOTE: (event) => { auditSeen.push(event) } },
    }))

    const [localSide, remoteSide] = memoryPair()
    const localLink = dial(localSide)
    const remoteLink = listen(remoteSide)
    const backend = system({ side: 'backend' })
    const sharedPort = join(localLink, backend.port)
    join(remoteLink, remote.port)

    const detachHistory = backend.peer('runHistory', sharedPort)
    const detachAudit = backend.peer('audit', sharedPort)
    localLink.onEnd(() => { detachHistory(); detachAudit() })

    const sender = state<{}, { type: 'BOTH'; id: string }>()({
      on: {
        BOTH: ({ id }, { tell }) => {
          tell({ peer: 'runHistory' }, { type: 'STEP_RECORDED', id, detail: 'via shared port' })
          tell({ peer: 'audit' }, { type: 'NOTE', text: `audited ${id}` })
        },
      },
    })
    const h = backend.start('sender', sender)
    backend.send(h, { type: 'BOTH', id: 'one' })
    await rest()
    deepStrictEqual(historySeen, [{ type: 'STEP_RECORDED', id: 'one', detail: 'via shared port' }])
    deepStrictEqual(auditSeen, [{ type: 'NOTE', text: 'audited one' }])

    // Detaching one peer name leaves the other peer on the same port working.
    detachHistory()
    backend.send(h, { type: 'BOTH', id: 'two' })
    await rest()
    strictEqual(historySeen.length, 1)
    deepStrictEqual(auditSeen, [{ type: 'NOTE', text: 'audited one' }, { type: 'NOTE', text: 'audited two' }])

    localLink.close()
  }],

  ['a dropped peer tell on the lost stop path is logged with outcome dropped', async () => {
    const logs: StepLog[] = []
    let depth = 0
    let failCommit = false
    const backend = system({
      side: 'backend',
      transact: (fn) => {
        depth++
        let result: ReturnType<typeof fn>
        try { result = fn() } finally { depth-- }
        if (depth === 0 && failCommit) throw new Error('disk full')
        return result
      },
      log: (step) => logs.push(step),
    })
    let tellFromFirst!: (to: { peer: 'runHistory' }, event: HistoryEvent) => void
    const first = state<{}, { type: 'TRIGGER' }>()({
      on: { TRIGGER: (_, { tell }) => { tellFromFirst = tell } },
    })
    const second = state<{}>()({
      run({ onExit }) {
        onExit(() => { tellFromFirst({ peer: 'runHistory' }, { type: 'RUN_ENDED', id: 'on-stop' }) })
      },
    })
    const h1 = backend.start('first', first)
    backend.start('second', second)
    failCommit = true
    backend.send(h1, { type: 'TRIGGER' })
    await rest()
    const lostStep = logs.at(-1)!
    strictEqual(lostStep.status, 'lost')
    deepStrictEqual(lostStep.sent, [{ kind: 'peer', to: 'runHistory', name: 'RUN_ENDED', outcome: 'dropped' }])

    // The same stop path without a step log also completes cleanly without throwing.
    let unloggedDepth = 0
    let unloggedFail = false
    const unlogged = system({
      side: 'backend',
      transact: (fn) => {
        unloggedDepth++
        let result: ReturnType<typeof fn>
        try { result = fn() } finally { unloggedDepth-- }
        if (unloggedDepth === 0 && unloggedFail) throw new Error('disk full')
        return result
      },
    })
    const h2 = unlogged.start('first', first)
    unlogged.start('second', second)
    unloggedFail = true
    unlogged.send(h2, { type: 'TRIGGER' })
    await rest()
  }],
  ['a peer synchronously calling send or ask during commit flush runs as a separate step after the first flush finishes', async () => {
    const order: string[] = []
    const logs: StepLog[] = []
    let askOutcome: unknown
    type ReentrantNet = {
      systems: { svc: { events: { type: 'FIRST' } | { type: 'FOLLOW_UP' }; asks: { STATUS: { args: {}; answer: number } } } }
      surfaces: {}
      views: {}
      peers: { primary: { events: { type: 'NOTIFIED' } }; secondary: { events: { type: 'ALSO' } } }
    }
    const netState = forNet<ReentrantNet>()
    const svc = netState<{ data: { n: number } }, { type: 'FIRST' } | { type: 'FOLLOW_UP' }, { STATUS: { args: {}; answer: number } }>()({
      data: { n: 0 },
      on: {
        FIRST: (_, { data, tell }) => {
          order.push('handle:FIRST')
          tell({ peer: 'primary' }, { type: 'NOTIFIED' })
          tell({ peer: 'secondary' }, { type: 'ALSO' })
          return { data: { n: data.n + 1 } }
        },
        FOLLOW_UP: (_, { data }) => {
          order.push('handle:FOLLOW_UP')
          return { data: { n: data.n + 10 } }
        },
      },
      answers: {
        STATUS: (_, { data }) => {
          order.push(`answer:STATUS:${data.n}`)
          return data.n
        },
      },
    })
    const backend = system({ side: 'backend', log: (step) => { order.push(`log:${step.number}`); logs.push(step) } })
    const h = backend.start('svc', svc)
    backend.peer('primary', {
      tell: () => {
        order.push('peer:primary')
        backend.send(h, { type: 'FOLLOW_UP' })
        void backend.ask(h, 'STATUS', {}).then((outcome) => { askOutcome = outcome })
      },
    })
    backend.peer('secondary', {
      tell: () => { order.push('peer:secondary') },
    })

    order.length = 0
    logs.length = 0
    backend.send(h, { type: 'FIRST' })
    await rest()

    strictEqual(backend.read(h).data.n, 11)
    deepStrictEqual(askOutcome, { ok: true, value: 11 })
    // The entire first flush (primary peer, secondary peer, and first step log) completes before FOLLOW_UP or STATUS runs.
    deepStrictEqual(order, ['handle:FIRST', 'peer:primary', 'peer:secondary', 'log:2', 'handle:FOLLOW_UP', 'log:3', 'answer:STATUS:11', 'log:4'])
    strictEqual(logs.length, 3)
  }],
  ['system<Net>() type-checks named peers and accepts both direct event callbacks and PeerPort objects', async () => {
    const historyEvents: HistoryEvent[] = []
    const auditNotes: Array<{ peer: string; text: string }> = []
    const backend = system<AppNet>({ side: 'backend' })
    const detachHistory = backend.peer('runHistory', (event) => {
      historyEvents.push(event)
    })
    const detachAudit = backend.peer('audit', {
      tell: (peer, event) => { auditNotes.push({ peer, text: event.text }) },
    })
    throws(() => backend.peer('runHistory', () => {}), /already has a peer named runHistory/)

    const emitter = state<{}, { type: 'GO'; id: string; text: string }>()({
      on: {
        GO: ({ id, text }, { tell }) => {
          tell({ peer: 'runHistory' }, { type: 'STEP_RECORDED', id, detail: text })
          tell({ peer: 'audit' }, { type: 'NOTE', text })
        },
      },
    })
    const h = backend.start('emitter', emitter)
    backend.send(h, { type: 'GO', id: 'g1', text: 'typed' })
    await rest()
    deepStrictEqual(historyEvents, [{ type: 'STEP_RECORDED', id: 'g1', detail: 'typed' }])
    deepStrictEqual(auditNotes, [{ peer: 'audit', text: 'typed' }])

    // Detaching a callback peer stops delivery; a stale detach does not remove a newly attached callback peer.
    detachHistory()
    const replacement: HistoryEvent[] = []
    backend.peer('runHistory', (event) => { replacement.push(event) })
    detachHistory()
    detachAudit()
    backend.send(h, { type: 'GO', id: 'g2', text: 'after-detach' })
    await rest()
    strictEqual(historyEvents.length, 1)
    deepStrictEqual(replacement, [{ type: 'STEP_RECORDED', id: 'g2', detail: 'after-detach' }])
    strictEqual(auditNotes.length, 1)
  }],
], async (tally) => {
  await tally.every('under every ordering over @apackdev/link, a peer receives tells with no view hold while a window waits for its view', () => {
    let sawPeerBeforeWindow = false
    return explore((schedule) => {
      const rows: string[] = []
      const viewLane: Lane = { label: 'view refresh' }
      const viewListeners: Array<(update: ViewUpdate<unknown>) => void> = []
      const views: ViewHost = (_feature, _view, _args, heard) => {
        viewListeners.push(heard)
        heard({ ok: true, value: [...rows] })
        return {
          stop: () => {},
          caughtUp: (then) => {
            schedule.later(viewLane, () => {
              for (const listener of viewListeners) listener({ ok: true, value: [...rows] })
              then()
            })
          },
        }
      }

      const backend = system({ side: 'backend', views, ...onSchedule(schedule, 'backend') })
      const window = system({ side: 'window', ...onSchedule(schedule, 'window') })
      const peerSystem = system({ side: 'backend', ...onSchedule(schedule, 'history') })

      const order: string[] = []
      const peerSeen: HistoryEvent[] = []
      peerSystem.start('runHistory', state<{}, HistoryEvent>()({
        on: {
          STEP_RECORDED: (event) => { order.push('peer'); peerSeen.push(event) },
        },
      }))

      connect(window, backend, schedule)
      const toPeerLane: Lane = { label: 'backend to history' }
      const fromPeerLane: Lane = { label: 'history to backend' }
      const [backendSide, peerSide] = memoryPair(
        (fn) => schedule.later(toPeerLane, fn),
        (fn) => schedule.later(fromPeerLane, fn),
      )
      const backendPeerLink = dial(backendSide)
      const peerLink = listen(peerSide)
      const toPeer = join(backendPeerLink, backend.port)
      const detachPeer = backend.peer('runHistory', toPeer)
      join(peerLink, peerSystem.port)
      backendPeerLink.onEnd(detachPeer)

      const winSaw: string[] = []
      window.start('panel', state<{ data: { rows: readonly string[]; sent: boolean } }, { type: 'RUN_CHANGED'; id: string }>()({
        data: { rows: [], sent: false },
        follows: (follow) => ({
          list: follow('runs', 'list', {
            args: () => ({}),
            updated: (update, { data, tell }) => {
              if (!update.ok) return undefined
              if (!data.sent) {
                tell('runner', { type: 'RECORD', id: 'run-1', detail: 'bulk' })
                return { data: { rows: update.value, sent: true } }
              }
              return { data: { rows: update.value } }
            },
          }),
        }),
        on: {
          RUN_CHANGED: ({ id }, { data }) => { order.push('window'); winSaw.push(`${id}:${data.rows.join(',')}`) },
        },
      }))

      backend.start('runner', state<{}, { type: 'RECORD'; id: string; detail: string }>()({
        on: {
          RECORD: ({ id, detail }, { tell, broadcast }) => {
            rows.push(id)
            tell({ peer: 'runHistory' }, { type: 'STEP_RECORDED', id, detail })
            broadcast('panel', { type: 'RUN_CHANGED', id })
          },
        },
      }))

      return () => {
        backendPeerLink.close()
        deepStrictEqual(peerSeen, [{ type: 'STEP_RECORDED', id: 'run-1', detail: 'bulk' }])
        deepStrictEqual(winSaw, ['run-1:run-1'])
        if (order[0] === 'peer') sawPeerBeforeWindow = true
      }
    }).then((explored) => {
      if (!explored.failure) ok(sawPeerBeforeWindow, 'at least one ordering must deliver to the peer before the window')
      return explored
    })
  })
})
