// Non-window peers: named tell-only ports attached via `system.attach(name, peer)` and reached with
// `tell({ peer: name }, event)`. Delivered after the step commits with no view hold, passing `name` as `to`.
//
//   npx vitest run peers
import { deepStrictEqual, ok, strictEqual, throws } from 'node:assert'
import { dial, join, listen, memoryPair } from '@apackdev/link'
import { connect, rest, run, system } from './checks.mts'
import { reaching, type Lane, type PeerPort, type StepLog, type ViewHost, type ViewUpdate } from '../src/index.ts'
import { explore, onSchedule } from '../src/testing.ts'

type HistoryEvent = { type: 'STEP_RECORDED'; id: string; detail: string } | { type: 'RUN_ENDED'; id: string }
type AppNet = {
  systems: { runner: { events: { type: 'RECORD'; id: string; detail: string } | { type: 'FAIL'; id: string } | { type: 'ASYNC_RECORD'; id: string }; asks: {} } }
  surfaces: { panel: { events: { type: 'RUN_CHANGED'; id: string } } }
  views: { runs: { list: { args: {}; result: readonly string[] } } }
  peers: { runHistory: { events: HistoryEvent }; audit: { events: { type: 'NOTE'; text: string } } }
}
export const state = reaching<AppNet>()

const runner = state<{ data: { ids: string[] }; states: { idle: {}; asyncStep: {} } }, { type: 'RECORD'; id: string; detail: string } | { type: 'FAIL'; id: string } | { type: 'ASYNC_RECORD'; id: string }>()({
  data: { ids: [] },
  start: 'idle',
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
    backend.attach('runHistory', sink)
    const h = backend.start('runner', runner)

    backend.send(h, { type: 'RECORD', id: 'r1', detail: 'first' })
    backend.send(h, { type: 'RECORD', id: 'r2', detail: 'second' })
    await rest()

    deepStrictEqual(received, [
      { to: 'runHistory', event: { type: 'STEP_RECORDED', id: 'r1', detail: 'first' } },
      { to: 'runHistory', event: { type: 'STEP_RECORDED', id: 'r2', detail: 'second' } },
    ])
    deepStrictEqual(logs[1]!.left.filter((s) => s.kind === 'peer'), [{ kind: 'peer', to: 'runHistory', name: 'STEP_RECORDED' }])
    ok(!('outcome' in logs[1]!.left.find((s) => s.kind === 'peer')!))

    // Named peers also work on a window system.
    const winReceived: Array<{ to: string; event: unknown }> = []
    const win = system({ side: 'window' })
    win.attach('audit', { tell: (to, event) => { winReceived.push({ to, event }) } })
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
    deepStrictEqual(logs.at(-1)!.left, [])

    // With a peer attached, a handler that throws still sends nothing.
    backend.attach('runHistory', { tell: (_to, event) => { received.push(event) } })
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
    flaky.attach('runHistory', { tell: (_to, event) => { lostReceived.push(event) } })
    failCommit = true
    flaky.send(fh, { type: 'RECORD', id: 'r-lost', detail: 'never' })
    await rest()
    deepStrictEqual(lostReceived, [])
  }],

  ['telling a missing or detached peer traces and records outcome dropped in StepLog.left', async () => {
    const traces: string[] = []
    const logs: StepLog[] = []
    const backend = system({ side: 'backend', trace: (line) => traces.push(line), log: (step) => logs.push(step) })
    const h = backend.start('runner', runner)

    backend.send(h, { type: 'RECORD', id: 'r1', detail: 'unattached' })
    await rest()
    ok(traces.some((line) => /no peer named runHistory/.test(line)), traces.join('\n'))
    deepStrictEqual(logs.at(-1)!.left.filter((s) => s.kind === 'peer'), [
      { kind: 'peer', to: 'runHistory', name: 'STEP_RECORDED', outcome: 'dropped' },
    ])
  }],

  ['a throwing peer is isolated via safely while subsequent work and logging still succeed', async () => {
    const traces: string[] = []
    const logs: StepLog[] = []
    const notified: string[] = []
    const backend = system({ side: 'backend', trace: (line) => traces.push(line), log: (step) => logs.push(step) })
    backend.attach('runHistory', { tell: () => { throw new Error('sink exploded') } })
    backend.subscribe((changed) => { notified.push(...changed) })
    const h = backend.start('runner', runner)

    backend.send(h, { type: 'RECORD', id: 'r1', detail: 'boom' })
    await rest()
    ok(traces.some((line) => /DEFECT: what leaves at the commit threw:.*sink exploded/.test(line)), traces.join('\n'))
    deepStrictEqual(backend.read(h).data.ids, ['r1'])
    ok(notified.includes('runner'))
    deepStrictEqual(logs.at(-1)!.left.filter((s) => s.kind === 'peer'), [
      { kind: 'peer', to: 'runHistory', name: 'STEP_RECORDED' },
    ])
  }],

  ['duplicate attach throws, and a stale detach does not remove a newly attached peer under the same name', async () => {
    const seenA: unknown[] = []
    const seenB: unknown[] = []
    const backend = system({ side: 'backend' })
    const h = backend.start('runner', runner)

    const detachA = backend.attach('runHistory', { tell: (_to, event) => { seenA.push(event) } })
    throws(() => backend.attach('runHistory', { tell: () => {} }), /already has a peer named runHistory/)

    detachA()
    backend.attach('runHistory', { tell: (_to, event) => { seenB.push(event) } })
    // Calling stale detachA again must NOT detach B.
    detachA()

    backend.send(h, { type: 'RECORD', id: 'r1', detail: 'to-b' })
    await rest()
    deepStrictEqual(seenA, [])
    deepStrictEqual(seenB, [{ type: 'STEP_RECORDED', id: 'r1', detail: 'to-b' }])
  }],

  ['telling a peer after await in run delivers in its own step', async () => {
    const seen: unknown[] = []
    const logs: StepLog[] = []
    const backend = system({ side: 'backend', log: (step) => logs.push(step) })
    backend.attach('runHistory', { tell: (_to, event) => { seen.push(event) } })
    const h = backend.start('runner', runner)

    backend.send(h, { type: 'ASYNC_RECORD', id: 'async-1' })
    await rest()
    strictEqual(backend.read(h).at, 'idle')
    deepStrictEqual(seen, [{ type: 'RUN_ENDED', id: 'async-1' }])
    ok(logs.some((step) => step.left.some((s) => s.kind === 'peer' && s.to === 'runHistory' && s.name === 'RUN_ENDED')))
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
    const detachPeer = backend.attach('runHistory', toPeer)
    join(peerLink, peerSystem.port)
    backendPeerLink.onEnd(detachPeer)

    const winHeard: string[] = []
    const panel = state<{ data: { rows: readonly string[] } }, { type: 'RUN_CHANGED'; id: string }>()({
      data: { rows: [] },
      follows: (follow) => ({
        list: follow('runs', 'list', {
          args: () => ({}),
          heard: (update) => (update.ok ? { data: { rows: update.value } } : undefined),
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

  ['one port attached under two peer names receives each name as to, and detaching one leaves the other attached', async () => {
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

    const detachHistory = backend.attach('runHistory', sharedPort)
    const detachAudit = backend.attach('audit', sharedPort)
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
      run({ use }) {
        use(() => { tellFromFirst({ peer: 'runHistory' }, { type: 'RUN_ENDED', id: 'on-stop' }) })
      },
    })
    const h1 = backend.start('first', first)
    backend.start('second', second)
    failCommit = true
    backend.send(h1, { type: 'TRIGGER' })
    await rest()
    const lostStep = logs.at(-1)!
    strictEqual(lostStep.ended, 'lost')
    deepStrictEqual(lostStep.left, [{ kind: 'peer', to: 'runHistory', name: 'RUN_ENDED', outcome: 'dropped' }])

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
      const detachPeer = backend.attach('runHistory', toPeer)
      join(peerLink, peerSystem.port)
      backendPeerLink.onEnd(detachPeer)

      const winSaw: string[] = []
      window.start('panel', state<{ data: { rows: readonly string[]; sent: boolean } }, { type: 'RUN_CHANGED'; id: string }>()({
        data: { rows: [], sent: false },
        follows: (follow) => ({
          list: follow('runs', 'list', {
            args: () => ({}),
            heard: (update, { data, tell }) => {
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
