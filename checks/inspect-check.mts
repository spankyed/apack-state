// Unified causal inspector (`@apackdev/state/inspect`): multi-system causal stitching, explain(), inFlight(),
// whyIgnored(), static-vs-runtime graph coverage(), live subscribe(), snapshot capture, formatting, and JSON export.
//
//   npx vitest run inspect
import { deepStrictEqual, ok, strictEqual } from 'node:assert'
import { connect, rest, run, system } from './checks.mts'
import { forNet, given, type Defect, type StepLog, type ViewHost } from '../src/index.ts'
import type { StateGraph } from '../src/graph.ts'
import { createInspector, formatCausalTrace, type InspectorUpdate } from '../src/inspect.ts'

const MARK = 'SECRET-PAYLOAD-91a2'

type WorkAsks = {
  SAVE: { args: { text: string }; progress: string; answer: string }
  HOLD: { args: {}; answer: string }
}
type AppNet = {
  systems: {
    svc: { events: { type: 'PING' } | { type: 'THROW' } | { type: 'ONLY_BUSY' }; asks: WorkAsks }
  }
  surfaces: {
    panel: { events: { type: 'NOTED'; text: string } | { type: 'SEND'; text: string } | { type: 'TELL_SVC' } | { type: 'START_HOLD' } }
  }
  views: {
    docs: { count: { args: {}; result: number } }
  }
  peers: {
    audit: { events: { type: 'LOG'; text: string } }
    missing: { events: { type: 'LOG'; text: string } }
  }
}

const app = forNet<AppNet>()

const makeSvc = (holdGate: () => Promise<void>) => app<{
  data: { pings: number }
  states: { idle: {}; busy: {} }
  internal: { type: 'SECRET' }
}, { type: 'PING' } | { type: 'THROW' } | { type: 'ONLY_BUSY' }, WorkAsks>()({
  data: { pings: 0 },
  initial: 'idle',
  internal: { SECRET: () => {} },
  on: {
    PING: (_, { data, tell }) => {
      tell({ peer: 'audit' }, { type: 'LOG', text: MARK })
      tell({ peer: 'missing' }, { type: 'LOG', text: MARK })
      return { data: { pings: data.pings + 1 } }
    },
    THROW: () => { throw new Error('svc-exploded') },
  },
  states: {
    idle: {},
    busy: { on: { ONLY_BUSY: () => {} } },
  },
  answers: {
    SAVE: async ({ text }, { progress, broadcast }) => {
      progress(`saving:${text}`)
      broadcast('panel', { type: 'NOTED', text })
      await Promise.resolve()
      return `saved:${text}`
    },
    HOLD: async () => {
      await holdGate()
      return 'released'
    },
  },
})

const panel = app<{
  data: { saved: string; noted: string; count: number }
  states: { idle: {}; saving: { data: { text: string } }; done: {} }
  calls: { save: { one: { text: string } }; hold: 'one' }
}, AppNet['surfaces']['panel']['events']>()({
  data: { saved: '', noted: '', count: 0 },
  initial: 'idle',
  follows: (follow) => ({
    docsCount: follow('docs', 'count', { updated: (u) => (u.ok ? { data: { count: u.value } } : undefined) }),
  }),
  calls: ({ one }) => ({
    save: one('svc', 'SAVE', {
      args: ({ text }) => ({ text }),
      progress: () => undefined,
      done: (o) => (o.ok ? { at: 'done', data: { saved: o.value } } : { at: 'idle' }),
    }),
    hold: one('svc', 'HOLD', { done: () => undefined }),
  }),
  on: {
    SEND: ({ text }, { call }) => { call('save', { text }); return { at: 'saving', data: { text } } },
    NOTED: ({ text }) => ({ data: { noted: text } }),
    TELL_SVC: (_, { tell }) => { tell('svc', { type: 'PING' }) },
    START_HOLD: (_, { call }) => { call('hold') },
  },
  states: {
    idle: {},
    saving: { data: { text: given } },
    done: {},
  },
})

const samplePanelGraph: StateGraph = {
  title: 'Panel',
  states: ['idle', 'saving', 'done'],
  moves: [
    { from: 'anywhere', on: 'SEND', to: ['saving'] },
    { from: 'anywhere', on: 'save (done)', to: ['done', 'idle'] },
  ],
  stays: ['NOTED'],
  answers: [],
  starts: [],
  follows: ['docsCount: docs count, from nothing: once'],
  loads: [],
  calls: ['save: svc SAVE, one at a time'],
  reaches: ["tell 'svc'"],
  findings: [],
  text: 'Panel',
}

await run([
  ['stitches cross-system ask, answer, tell, broadcast, and follow edges, explains causal chains, and stays payload-free', async () => {
    const inspector = createInspector()
    const forwardedLogs: StepLog[] = []
    const forwardedDefects: Defect[] = []
    const forwardedTraces: string[] = []
    const updates: InspectorUpdate[] = []
    const unsubGood = inspector.subscribe((u) => updates.push(u))
    // Throwing subscriber is isolated and does not disrupt inspection.
    const unsubBad = inspector.subscribe(() => { throw new Error('listener-boom') })

    let releaseHold!: () => void
    const holdPromise = new Promise<void>((resolve) => { releaseHold = resolve })
    const views: ViewHost = (_feature, _view, _args, updated) => {
      updated({ ok: true, value: 42 })
      return () => {}
    }

    const backend = system({
      side: 'backend',
      views,
      ...inspector.hooks('backend', {
        log: (s) => forwardedLogs.push(s),
        onDefect: (d) => forwardedDefects.push(d),
        trace: (l) => forwardedTraces.push(l),
      }),
    })
    const win = system({ side: 'window', ...inspector.hooks('window') })
    const unbindBackend = inspector.bind('backend', backend)
    const unbindWin = inspector.bind('window', win)
    connect(win, backend)

    const svcH = backend.start('svc', makeSvc(() => holdPromise))
    const panelH = win.start('panel', panel)
    await rest()

    // While panel is running, docs follow is open inFlight.
    ok(inspector.inFlight().some((op) => op.kind === 'follow' && op.system === 'window' && op.to === 'docs' && op.name === 'count'))

    // Send SAVE across window -> backend -> answer + broadcast -> window done.
    win.send(panelH, { type: 'SEND', text: MARK })
    win.send(panelH, { type: 'TELL_SVC' })
    await rest()

    strictEqual(win.read(panelH).at, 'done')
    strictEqual(win.read(panelH).data.saved, `saved:${MARK}`)
    strictEqual(win.read(panelH).data.noted, MARK)
    strictEqual(backend.read(svcH).data.pings, 1)

    // explain('panel', 'saved') walks backward from window done through backend SAVE to window SEND.
    const explained = inspector.explain('panel', 'saved')
    strictEqual(explained.ref, 'panel')
    strictEqual(explained.field, 'saved')
    ok(explained.steps.some((s) => s.system === 'window' && s.log.handled.some((h) => h.kind === 'event' && h.name === 'SEND')), explained.text)
    ok(explained.steps.some((s) => s.system === 'backend' && s.log.handled.some((h) => h.kind === 'ask' && h.name === 'SAVE')), explained.text)
    ok(explained.steps.some((s) => s.system === 'window' && s.log.handled.some((h) => h.kind === 'done' && h.name === 'save')), explained.text)
    ok(explained.edges.some((e) => e.fromSystem === 'window' && e.toSystem === 'backend' && e.kind === 'ask'))
    ok(explained.edges.some((e) => e.fromSystem === 'backend' && e.toSystem === 'window' && e.kind === 'answer'))

    // explain('svc', 'pings') walks backward from backend PING to window TELL_SVC via cross-system tell edge.
    const explainedTell = inspector.explain('svc', 'pings')
    ok(explainedTell.steps.some((s) => s.system === 'window' && s.log.handled.some((h) => h.kind === 'event' && h.name === 'TELL_SVC')), explainedTell.text)
    ok(explainedTell.edges.some((e) => e.kind === 'tell' && e.fromSystem === 'window' && e.toSystem === 'backend'))

    // explain('panel', 'noted') captures cross-system broadcast edge from backend to window.
    const explainedBcast = inspector.explain('panel', 'noted')
    ok(explainedBcast.edges.some((e) => e.kind === 'broadcast' && e.fromSystem === 'backend' && e.toSystem === 'window'))

    // explain for unknown ref returns clean empty explanation.
    const missingExplain = inspector.explain('nobody', 'x')
    deepStrictEqual(missingExplain.steps, [])
    ok(missingExplain.text.includes('nobody.data.x'))

    // Exported trace is JSON-serializable, populated, and never leaks event/ask payloads.
    const exported = inspector.export()
    strictEqual(exported.version, 1)
    deepStrictEqual([...exported.systems].sort(), ['backend', 'window'])
    ok(exported.steps.length > 0)
    strictEqual(exported.defects.length, 0)
    ok(exported.inFlight.length > 0)
    const serialized = JSON.stringify(exported)
    strictEqual(serialized.includes(MARK), false)

    // Live snapshots read from bound systems.
    const snaps = inspector.snapshots()
    ok('backend' in snaps && 'window' in snaps)

    // Forwarded hooks and live subscribers received events; unsubscribing stops further updates.
    ok(forwardedLogs.length > 0)
    ok(forwardedTraces.length > 0)
    ok(updates.some((u) => u.kind === 'step'))
    strictEqual(forwardedDefects.length, 0)
    unsubGood()
    unsubBad()
    const updatesBeforeUnsub = updates.length

    // Start a held ask and verify inFlight() reports it until released.
    win.send(panelH, { type: 'START_HOLD' })
    await new Promise<void>((r) => { setTimeout(r, 10) })
    ok(inspector.inFlight().some((op) => op.kind === 'ask' && op.to === 'svc' && op.name === 'HOLD'))
    strictEqual(updates.length, updatesBeforeUnsub)
    releaseHold()
    await rest()
    strictEqual(inspector.inFlight().filter((op) => op.kind === 'ask').length, 0)

    // Stopping window unfollows docs and clears open follow from inFlight().
    win.stop()
    await rest()
    strictEqual(inspector.inFlight().length, 0)
    backend.stop()
    unbindBackend()
    unbindWin()
  }],

  ['records whyIgnored() for ignored events, dropped/failed peers, and defects with correlated step numbers', async () => {
    const inspector = createInspector()
    const backend = system({ side: 'backend', ...inspector.hooks('backend') })
    backend.attach('audit', { tell: () => { throw new Error('audit-disk-full') } })
    const svcH = backend.start('svc', makeSvc(() => Promise.resolve()))

    // Ignored events (wrong substate + internal from outside + ghost ref), throwing handler, and peer failure + dropped peer.
    backend.send(svcH, { type: 'ONLY_BUSY' })
    backend.send(svcH, { type: 'SECRET' } as never)
    backend.send({ ref: 'ghost' } as never, { type: 'PING' } as never)
    backend.send(svcH, { type: 'THROW' })
    backend.send(svcH, { type: 'PING' })
    await rest()

    const allIgnored = inspector.whyIgnored()
    ok(allIgnored.some((e) => e.kind === 'event' && e.ref === 'svc' && e.name === 'ONLY_BUSY' && e.detail.includes('ignored')), JSON.stringify(allIgnored))
    ok(allIgnored.some((e) => e.kind === 'event' && e.ref === 'svc' && e.name === 'SECRET' && e.detail.includes('from outside')), JSON.stringify(allIgnored))
    ok(allIgnored.some((e) => e.kind === 'event' && e.ref === 'ghost' && e.name === 'PING'), JSON.stringify(allIgnored))
    ok(allIgnored.some((e) => e.kind === 'peer' && e.ref === 'audit' && e.detail.includes('failed')), JSON.stringify(allIgnored))
    ok(allIgnored.some((e) => e.kind === 'peer' && e.ref === 'missing' && e.detail.includes('dropped')), JSON.stringify(allIgnored))
    ok(allIgnored.some((e) => e.kind === 'defect' && e.ref === 'svc' && e.detail.includes('svc-exploded')), JSON.stringify(allIgnored))

    // Filtering whyIgnored(ref) returns only entries for that ref.
    const svcOnly = inspector.whyIgnored('svc')
    ok(svcOnly.length >= 3 && svcOnly.every((e) => e.ref === 'svc'))

    // Defect is attached directly onto its InspectedStep and rendered in format().
    const throwStep = inspector.steps.find((s) => s.log.handled.some((h) => h.kind === 'event' && h.name === 'THROW'))!
    strictEqual(throwStep.defects.length, 1)
    strictEqual(throwStep.defects[0]!.step, throwStep.log.number)
    strictEqual(throwStep.defects[0]!.error, 'svc-exploded')

    const formatted = inspector.format({ ref: 'svc' })
    ok(formatted.includes('⚠ DEFECT (svc):'), formatted)
    ok(formatted.includes('(ignored)'), formatted)
    // Export includes defects and ignored entries; format filters out defects for non-matching refs/systems.
    const exportedWithDefects = inspector.export()
    ok(exportedWithDefects.defects.length > 0)
    ok(exportedWithDefects.ignored.length > 0)
    strictEqual(inspector.format({ ref: 'nonexistent' }), '(no steps recorded)')
    strictEqual(inspector.format({ system: 'other' }), '(no steps recorded)')
    backend.stop()
  }],

  ['overlays static StateGraph coverage, enforces ring-buffer limit, captures optional snapshots, and clears cleanly', async () => {
    const inspector = createInspector({ limit: 3, captureSnapshots: true })
    const views: ViewHost = (_f, _v, _a, updated) => { updated({ ok: true, value: 1 }); return () => {} }
    const backend = system({ side: 'backend', views, ...inspector.hooks('backend') })
    const win = system({ side: 'window', ...inspector.hooks('window') })
    inspector.bind('backend', backend)
    inspector.bind('window', win)
    connect(win, backend)

    backend.start('svc', makeSvc(() => Promise.resolve()))
    const panelH = win.start('panel', panel)
    await rest()
    win.send(panelH, { type: 'SEND', text: 'v1' })
    await rest()

    // Ring buffer retains at most `limit` (3) steps, and snapshots were captured per step.
    strictEqual(inspector.steps.length, 3)
    ok(inspector.steps.every((s) => s.snapshot !== undefined))

    // Coverage against record map and resolver function both see visited states ('idle', 'saving', 'done') and SEND move.
    const covRecord = inspector.coverage({ panel: samplePanelGraph })
    strictEqual(covRecord.length, 1)
    deepStrictEqual(covRecord[0]!.visitedStates, ['idle', 'saving', 'done'])
    deepStrictEqual(covRecord[0]!.unvisitedStates, [])
    strictEqual(covRecord[0]!.currentAt, 'done')
    ok(covRecord[0]!.declaredMoves.some((m) => m.on === 'SEND' && m.to === 'saving' && m.hit === true))
    ok(covRecord[0]!.declaredMoves.some((m) => m.on === 'save (done)' && m.to === 'done' && m.hit === true))
    ok(covRecord[0]!.declaredMoves.some((m) => m.on === 'save (done)' && m.to === 'idle' && m.hit === false))
    ok(covRecord[0]!.observedMoves.some((m) => m.from === 'idle' && m.on === 'SEND' && m.to === 'saving'))
    ok(covRecord[0]!.observedMoves.some((m) => m.from === 'saving' && m.on === 'save (done)' && m.to === 'done'))

    const covFn = inspector.coverage((ref) => (ref === 'panel' ? samplePanelGraph : undefined))
    strictEqual(covFn.length, 1)
    strictEqual(covFn[0]!.title, 'Panel')

    // format() filters cleanly by system, last, and last=0.
    strictEqual(inspector.format({ last: 0, system: 'none' }), '(no steps recorded)')
    strictEqual(formatCausalTrace([]), '(no steps recorded)')
    const lastOne = inspector.format({ system: 'window', last: 1 })
    strictEqual(lastOne.split('\n').filter((line) => line.startsWith('window#')).length, 1, lastOne)

    // clear() resets all recorded buffers.
    inspector.clear()
    strictEqual(inspector.steps.length, 0)
    strictEqual(inspector.defects.length, 0)
    strictEqual(inspector.edges.length, 0)
    strictEqual(inspector.inFlight().length, 0)
    strictEqual(inspector.whyIgnored().length, 0)

    win.stop()
    backend.stop()
  }],
])
