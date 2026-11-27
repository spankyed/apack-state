// Unified causal inspector (`@apackdev/state/inspect`): multi-system causal stitching, explain(), inFlight(),
// whyIgnored(), static-vs-runtime graph coverage(), live subscribe(), snapshot capture, formatting, and JSON export.
//
//   npx vitest run inspect
import { deepStrictEqual, ok, strictEqual } from 'node:assert'
import { connect, rest, run, system } from './checks.mts'
import { forNet, given, type Clock, type Defect, type Port, type StepLog, type ViewHost } from '../src/index.ts'
import type { StateGraph } from '../src/graph.ts'
import { createInspector, formatCausalTrace, type Inspector, type InspectorUpdate } from '../src/inspect.ts'
import { nextTurn } from '../src/turn.ts'

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
  calls: { save: { single: { text: string } }; hold: 'single' }
}, AppNet['surfaces']['panel']['events']>()({
  data: { saved: '', noted: '', count: 0 },
  initial: 'idle',
  follows: (follow) => ({
    docsCount: follow('docs', 'count', { updated: (u) => (u.ok ? { data: { count: u.value } } : undefined) }),
  }),
  calls: ({ single }) => ({
    save: single('svc', 'SAVE', {
      args: ({ text }) => ({ text }),
      progress: () => undefined,
      done: (o) => (o.ok ? { at: 'done', data: { saved: o.value } } : { at: 'idle' }),
    }),
    hold: single('svc', 'HOLD', { done: () => undefined }),
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
  arms: [],
  reaches: ["tell 'svc'"],
  findings: [],
  text: 'Panel',
}


type DeskAsks = { HOLD: { args: {}; answer: string }; NOW: { args: {}; answer: string } }
type DeskEvent = { type: 'PING' } | { type: 'POKE' } | { type: 'PAT' } | { type: 'SHOUT' }
type PaneEvent = { type: 'START' } | { type: 'STOP' } | { type: 'BOTH' } | { type: 'NOW' } | { type: 'SAY'; what: 'PING' | 'POKE' | 'PAT' } | { type: 'NOTE' }
type DeskNet = {
  systems: { desk: { events: DeskEvent; asks: DeskAsks } }
  surfaces: { pane: { events: PaneEvent }; boss: { events: { type: 'GO' } } }
  views: { docs: { count: { args: {}; result: number } } }
}
const desks = forNet<DeskNet>()
/** Answers a hold when its gate opens, whether or not whoever asked is still there, and anything else at once. */
const desk = (gate: () => Promise<void>) => desks<{ data: { pings: number } }, DeskEvent, DeskAsks>()({
  data: { pings: 0 },
  on: {
    PING: (_, { data }) => ({ data: { pings: data.pings + 1 } }),
    POKE: () => {},
    PAT: () => {},
    SHOUT: (_, { broadcast }) => { broadcast('pane', { type: 'NOTE' }) },
  },
  answers: { HOLD: async () => { await gate(); return 'held' }, NOW: () => 'now' },
})
/** Asks the desk to hold, gives that up, asks it something it answers at once, tells it, and counts the notes it is sent. */
const pane = desks<{ data: { got: string; notes: number }; calls: { hold: 'single'; now: 'single' } }, PaneEvent>()({
  data: { got: '', notes: 0 },
  calls: ({ single }) => ({
    hold: single('desk', 'HOLD', { done: (outcome) => (outcome.ok ? { data: { got: outcome.value } } : undefined) }),
    now: single('desk', 'NOW', { done: (outcome) => (outcome.ok ? { data: { got: outcome.value } } : undefined) }),
  }),
  on: {
    START: (_, { call }) => { call('hold') },
    STOP: (_, { cancel }) => { cancel('hold') },
    BOTH: (_, { call, cancel }) => { call('hold'); cancel('hold') },
    NOW: (_, { call }) => { call('now') },
    SAY: ({ what }, { tell }) => { tell('desk', { type: what }) },
    NOTE: (_, { data }) => ({ data: { notes: data.notes + 1 } }),
  },
})
/** Has the pane in its window ask the desk to hold. */
const boss = desks<{ states: { on: {}; off: {} } }, { type: 'GO' }>()({
  initial: 'on',
  on: { GO: (_, { tell }) => { tell({ surface: 'pane' }, { type: 'START' }) } },
  states: { on: {}, off: {} },
})
/** Moves to where it is told, which may be where it is. */
const mover = desks<{ states: { idle: {}; busy: {} } }, { type: 'TO'; at: 'idle' | 'busy' }>()({
  initial: 'idle',
  on: { TO: ({ at }) => ({ at }) },
  states: { idle: {}, busy: {} },
})
const moverGraph: StateGraph = {
  title: 'Mover',
  states: ['idle', 'busy'],
  moves: [{ from: 'idle', on: 'TO', to: ['idle', 'busy'] }, { from: 'busy', on: 'TO', to: ['idle'] }],
  stays: [], answers: [], starts: [], follows: [], loads: [], calls: [], arms: [], reaches: [], findings: [], text: 'Mover',
}
/** Follows how many docs there are. */
const counting = desks<{ data: { count: number } }, never>()({
  data: { count: 0 },
  follows: (follow) => ({ docs: follow('docs', 'count', { updated: (update) => (update.ok ? { data: { count: update.value } } : undefined) }) }),
})
const oneDoc: ViewHost = (_feature, _view, _args, updated) => { updated({ ok: true, value: 1 }); return () => {} }
/** A gate that is opened by hand. */
const gated = (): { gate: () => Promise<void>; open: () => void } => {
  let open!: () => void
  const waiting = new Promise<void>((resolve) => { open = resolve })
  return { gate: () => waiting, open }
}
/** A few turns, for what cannot come to rest while an ask is held. */
const turns = async (): Promise<void> => { for (let turn = 0; turn < 20; turn++) await new Promise<void>((resolve) => { nextTurn(resolve) }) }
/** A window and a backend, joined, both inspected: the desk on the backend and a pane in the window. */
const joined = (inspector: Inspector, gate: () => Promise<void> = () => Promise.resolve(), window = 'window') => {
  const backend = system({ side: 'backend', ...inspector.hooks('backend') })
  const made = backend.start('desk', desk(gate))
  const win = system({ side: 'window', ...inspector.hooks(window) })
  const link = connect(win, backend)
  return { backend, made, win, link, handle: win.start('pane', pane) }
}

await run([
  ['stitches cross-system ask, answer, tell, broadcast, and follow edges, explains causal chains, and stays payload-free', async () => {
    const inspector = createInspector()
    const forwardedLogs: StepLog[] = []
    const forwardedDefects: Defect[] = []
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
    const explained = inspector.explain('panel', { field: 'saved' })
    strictEqual(explained.ref, 'panel')
    strictEqual(explained.field, 'saved')
    ok(explained.steps.some((s) => s.system === 'window' && s.log.handled.some((h) => h.kind === 'event' && h.name === 'SEND')), explained.text)
    ok(explained.steps.some((s) => s.system === 'backend' && s.log.handled.some((h) => h.kind === 'ask' && h.name === 'SAVE')), explained.text)
    ok(explained.steps.some((s) => s.system === 'window' && s.log.handled.some((h) => h.kind === 'done' && h.name === 'save')), explained.text)
    ok(explained.edges.some((e) => e.fromSystem === 'window' && e.toSystem === 'backend' && e.kind === 'ask'))
    ok(explained.edges.some((e) => e.fromSystem === 'backend' && e.toSystem === 'window' && e.kind === 'answer'))

    // explain('svc', 'pings') walks backward from backend PING to window TELL_SVC via cross-system tell edge.
    const explainedTell = inspector.explain('svc', { field: 'pings' })
    ok(explainedTell.steps.some((s) => s.system === 'window' && s.log.handled.some((h) => h.kind === 'event' && h.name === 'TELL_SVC')), explainedTell.text)
    ok(explainedTell.edges.some((e) => e.kind === 'tell' && e.fromSystem === 'window' && e.toSystem === 'backend'))

    // explain('panel', 'noted') captures cross-system broadcast edge from backend to window.
    const explainedBcast = inspector.explain('panel', { field: 'noted' })
    ok(explainedBcast.edges.some((e) => e.kind === 'broadcast' && e.fromSystem === 'backend' && e.toSystem === 'window'))

    // explain for unknown ref returns clean empty explanation.
    const missingExplain = inspector.explain('nobody', { field: 'x' })
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
    backend.peer('audit', { tell: () => { throw new Error('audit-disk-full') } })
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

  ['bounds defects/ignored/edges, cleans cancelled & lost inFlight ops, stitches multi-window broadcasts, and avoids local crossAnswers drift', async () => {
    // 1. Bounded defects, ignored, steps, and pruned edges under small limit.
    const small = createInspector({ limit: 2 })
    const b1 = system({ side: 'backend', ...small.hooks('b1') })
    const s1 = b1.start('svc', makeSvc(() => Promise.resolve()))
    for (let i = 0; i < 4; i++) {
      b1.send(s1, { type: 'ONLY_BUSY' })
      b1.send(s1, { type: 'THROW' })
    }
    await rest()
    strictEqual(small.steps.length, 2)
    strictEqual(small.defects.length, 2)
    strictEqual(small.whyIgnored().length, 2)
    const retainedSteps = new Set(small.steps.map((s) => `${s.system}#${s.log.number}`))
    ok(small.edges.every((e) => retainedSteps.has(`${e.fromSystem}#${e.fromStep}`) && retainedSteps.has(`${e.toSystem}#${e.toStep}`)))
    b1.stop()

    // 2. Local backend ask must not pollute crossAnswers; caller-cancelled ask clears inFlight(); multi-window broadcast links all windows.
    const insp = createInspector()
    const views: ViewHost = (_f, _v, _a, updated) => { updated({ ok: true, value: 1 }); return () => {} }
    let releaseHold!: () => void
    const holdGate = new Promise<void>((resolve) => { releaseHold = resolve })
    const backend = system({ side: 'backend', views, ...insp.hooks('backend') })
    const win1 = system({ side: 'window', ...insp.hooks('win1') })
    const win2 = system({ side: 'window', ...insp.hooks('win2') })
    connect(win1, backend)
    connect(win2, backend)

    const svcH = backend.start('svc', makeSvc(() => holdGate))
    const p1 = win1.start('panel', panel)
    const p2 = win2.start('panel', panel)
    await rest()

    // Local backend ask (not cross-system) must not leave a stale entry in crossAnswers.
    const localAnswer = await backend.ask(svcH, 'SAVE', { text: 'local-only' })
    strictEqual(localAnswer.ok, true)
    await rest()

    // win1 starts HOLD and stops mid-flight -> once backend unwinds, inFlight has no leaked ask from win1 or backend.
    win1.send(p1, { type: 'START_HOLD' })
    await new Promise<void>((r) => { setTimeout(r, 10) })
    ok(insp.inFlight().some((op) => op.kind === 'ask' && op.system === 'win1' && op.name === 'HOLD'))
    win1.stop()
    releaseHold()
    await rest()
    deepStrictEqual(insp.inFlight().filter((op) => op.kind === 'ask'), [])

    // win2 sends SAVE -> its answer edge must link to the backend step that handled win2's SAVE (not the earlier local ask).
    const beforeWin2Steps = insp.steps.length
    win2.send(p2, { type: 'SEND', text: 'from-win2' })
    await rest()
    const explainedWin2 = insp.explain('panel', { field: 'saved' })
    const answerEdge = explainedWin2.edges.find((e) => e.kind === 'answer' && e.fromSystem === 'backend' && e.toSystem === 'win2')
    ok(answerEdge !== undefined, explainedWin2.text)
    const backendAnswerStep = insp.steps.find((s) => s.system === 'backend' && s.log.number === answerEdge!.fromStep)!
    ok(insp.steps.indexOf(backendAnswerStep) >= beforeWin2Steps, 'win2 answer must stitch to win2 SAVE, not earlier local ask')

    // Multi-window broadcast: reconnect a third window alongside win2 and verify BOTH windows get broadcast causal edges.
    const win3 = system({ side: 'window', ...insp.hooks('win3') })
    connect(win3, backend)
    win3.start('panel', panel)
    await rest()
    const bcastBaseline = insp.steps.length
    await backend.ask(svcH, 'SAVE', { text: 'to-both' })
    await rest()
    const newSteps = insp.steps.slice(bcastBaseline)
    ok(newSteps.some((s) => s.system === 'win2' && s.causes.some((c) => c.kind === 'broadcast' && c.fromSystem === 'backend')))
    ok(newSteps.some((s) => s.system === 'win3' && s.causes.some((c) => c.kind === 'broadcast' && c.fromSystem === 'backend')))

    win2.stop()
    win3.stop()
    backend.stop()

    // 3. Transaction failure (`status: 'lost'`) clears open ops for the broken system.
    const lostInsp = createInspector()
    let failCommit = false
    let depth = 0
    const flaky = system({
      side: 'backend',
      transact: (fn) => {
        depth++
        try {
          const out = fn()
          if (depth === 1 && failCommit) throw new Error('disk-full')
          return out
        } finally { depth-- }
      },
      ...lostInsp.hooks('flaky'),
    })
    let releaseLostHold!: () => void
    const lostHold = new Promise<void>((resolve) => { releaseLostHold = resolve })
    const fh = flaky.start('svc', makeSvc(() => lostHold))
    const lostAsk = flaky.ask(fh, 'HOLD', {})
    await new Promise<void>((r) => { setTimeout(r, 10) })
    ok(lostInsp.inFlight().some((op) => op.system === 'flaky' && op.name === 'HOLD'))
    failCommit = true
    flaky.send(fh, { type: 'PING' })
    deepStrictEqual(lostInsp.inFlight(), [])
    releaseLostHold()
    await lostAsk
    await rest()
  }],

  ['scopes format({ last }) defects, matches compound coverage targets without colon collision, and keeps subscribed steps immutable', async () => {
    // 1. format({ last }) excludes older defects outside the slice and clamps last <= 0; forward.log throw does not mutate subscribed step.
    const insp = createInspector()
    const subscribedSteps: Array<{ readonly defects: readonly unknown[] }> = []
    insp.subscribe((u) => { if (u.kind === 'step') subscribedSteps.push(u.step) })
    let throwOnLog = false
    const backend = system({
      side: 'backend',
      ...insp.hooks('backend', {
        log: () => { if (throwOnLog) throw new Error('forward-log-boom') },
      }),
    })
    const svcH = backend.start('svc', makeSvc(() => Promise.resolve()))
    backend.send(svcH, { type: 'THROW' })
    for (let i = 0; i < 4; i++) backend.send(svcH, { type: 'PING' })
    await rest()

    const recentOnly = insp.format({ last: 2 })
    ok(!recentOnly.includes('svc-exploded'), recentOnly)
    strictEqual(insp.format({ last: 0 }), '(no steps recorded)')
    strictEqual(insp.format({ last: -5 }), '(no steps recorded)')

    // Throwing in forward.log attaches the defect immutably on inspector.steps without mutating the step already emitted to subscribers.
    throwOnLog = true
    backend.send(svcH, { type: 'PING' })
    throwOnLog = false
    await rest()
    strictEqual(subscribedSteps.at(-1)!.defects.length, 0)
    ok(insp.steps.at(-1)!.defects.some((d) => d.message.includes('forward-log-boom')))
    backend.stop()

    // 2. coverage() matches compound target states (to: 'working' settling at 'working.fetching') and avoids `:` ref suffix collisions.
    const covInsp = createInspector()
    const compound = app<{
      states: { idle: {}; working: { initial: 'fetching'; states: { fetching: {}; saving: {} } } }
    }, { type: 'GO' }>()({
      initial: 'idle',
      states: {
        idle: { on: { GO: () => ({ at: 'working' }) } },
        working: { initial: 'fetching', states: { fetching: {}, saving: {} } },
      },
    })
    const compoundGraph: StateGraph = {
      title: 'Compound',
      states: ['idle', 'working', 'working.fetching', 'working.saving'],
      moves: [{ from: 'idle', on: 'GO', to: ['working'] }],
      stays: [], answers: [], starts: [], follows: [], loads: [], calls: [], arms: [], reaches: [], findings: [], text: 'Compound',
    }
    const sys = system({ side: 'backend', ...covInsp.hooks('be') })
    const plainH = sys.start('panel', compound)
    const prefixedH = sys.start('role:panel', compound)
    sys.send(prefixedH, { type: 'GO' })
    await rest()

    // `panel` is still in `idle`, while `role:panel` moved to `working.fetching`: `lastAt` must not confuse `role:panel` with `panel`.
    const beforePlainMove = covInsp.coverage({ panel: compoundGraph, 'role:panel': compoundGraph })
    const plainCov = beforePlainMove.find((c) => c.ref === 'panel')!
    const prefixedCov = beforePlainMove.find((c) => c.ref === 'role:panel')!
    strictEqual(plainCov.currentAt, 'idle')
    strictEqual(prefixedCov.currentAt, 'working.fetching')
    ok(prefixedCov.declaredMoves.some((m) => m.from === 'idle' && m.on === 'GO' && m.to === 'working' && m.hit === true))

    // Also move plain `panel` and confirm both visited states and compound target hit.
    sys.send(plainH, { type: 'GO' })
    await rest()
    const afterPlainMove = covInsp.coverage({ panel: compoundGraph })[0]!
    strictEqual(afterPlainMove.currentAt, 'working.fetching')
    ok(afterPlainMove.visitedStates.includes('working') && afterPlainMove.visitedStates.includes('working.fetching'))
    ok(afterPlainMove.declaredMoves.every((m) => m.hit === true))
    sys.stop()
  }],
  ['a timer that expires is the trigger of the move it makes, and a step that arms or disarms one says so', async () => {
    const insp = createInspector()
    const due: Array<() => void> = []
    const clock: Clock = { now: () => 0, after: (_ms, run) => { due.push(run); return () => {} } }
    const timed = app<{
      states: { idle: {}; waiting: {}; late: {} }
      arms: { patience: 'single' }
    }, { type: 'WAIT' }>()({
      initial: 'idle',
      arms: ({ single }) => ({ patience: single({ after: 50, expired: () => ({ at: 'late' }) }) }),
      on: { WAIT: (_, { arm }) => { arm('patience'); return { at: 'waiting' } } },
      states: { idle: {}, waiting: {}, late: {} },
    })
    const timedGraph: StateGraph = {
      title: 'Timed',
      states: ['idle', 'waiting', 'late'],
      moves: [{ from: 'anywhere', on: 'WAIT', to: ['waiting'] }, { from: 'anywhere', on: 'patience (expired)', to: ['late'] }],
      stays: [], answers: [], starts: [], follows: [], loads: [], calls: [], arms: ['patience: 50ms, one at a time'], reaches: [], findings: [], text: 'Timed',
    }
    const sys = system({ side: 'backend', clock, ...insp.hooks('be') })
    const h = sys.start('timed', timed)
    sys.send(h, { type: 'WAIT' })
    await rest()
    for (const run of due.splice(0)) run()
    await rest()
    strictEqual(sys.read(h).at, 'late')

    const [cov] = insp.coverage({ timed: timedGraph })
    deepStrictEqual(cov!.observedMoves, [{ from: 'idle', on: 'WAIT', to: 'waiting' }, { from: 'waiting', on: 'patience (expired)', to: 'late' }])
    deepStrictEqual(cov!.declaredMoves.map((m) => m.hit), [true, true])

    // The step that armed the timer and the step in which it expired each say its timers changed.
    const lines = insp.format().split('\n').filter((line) => line.startsWith('  Δ timed'))
    deepStrictEqual(lines, ['  Δ timed: at=waiting, armed', '  Δ timed: at=late, armed'])
    sys.stop()
  }],
  ['an ask its asker gave up is no longer under way, wherever that is learnt: held and answered anyway, never sent, or with only the window inspected', async () => {
    const inspector = createInspector()
    const held = gated()
    const { win, handle } = joined(inspector, held.gate)
    await rest()
    win.send(handle, { type: 'START' })
    await turns()
    // Under way twice: where it was made, and where it is being answered.
    deepStrictEqual(inspector.inFlight(), [
      { kind: 'ask', system: 'window', opId: 1, startedStep: 2, to: 'desk', name: 'HOLD' },
      { kind: 'ask', system: 'backend', opId: 1, startedStep: 2, to: 'desk', name: 'HOLD' },
    ])
    win.send(handle, { type: 'STOP' })
    await turns()
    deepStrictEqual(inspector.inFlight(), [{ kind: 'ask', system: 'backend', opId: 1, startedStep: 2, to: 'desk', name: 'HOLD' }])
    // The desk answers anyway. Nobody is there to take it: nothing is under way, and nothing waits for an answer.
    held.open()
    await rest()
    deepStrictEqual(inspector.inFlight(), [])
    // Made and given up in one step, it never left: it was never under way, and the next ask is not taken for it.
    win.send(handle, { type: 'BOTH' })
    deepStrictEqual(inspector.inFlight(), [])
    win.send(handle, { type: 'NOW' })
    await rest()
    const asked = inspector.steps.find((step) => step.system === 'window' && step.log.sent.some((sent) => sent.kind === 'ask' && sent.name === 'NOW'))!
    const taken = inspector.steps.find((step) => step.system === 'backend' && step.log.handled.some((each) => each.name === 'NOW'))!
    deepStrictEqual(taken.causes, [{ kind: 'ask', fromSystem: 'window', fromStep: asked.log.number, toSystem: 'backend', toStep: taken.log.number, opId: 3, ref: 'desk', name: 'NOW' }])
    deepStrictEqual(inspector.inFlight(), [])

    // With only the window inspected, what its own log says is all there is, and it says the ask was given up.
    const alone = createInspector()
    const other = gated()
    const backend = system({ side: 'backend' })
    backend.start('desk', desk(other.gate))
    const window = system({ side: 'window', ...alone.hooks('window') })
    connect(window, backend)
    const mine = window.start('pane', pane)
    window.send(mine, { type: 'START' })
    await turns()
    strictEqual(alone.inFlight().length, 1)
    window.send(mine, { type: 'STOP' })
    deepStrictEqual(alone.inFlight(), [])
    other.open()
    await rest()
    deepStrictEqual(alone.inFlight(), [])
  }],
  ['a view is under way from the step that follows it until the one that says it is unfollowed: served by its own system, or left with the link', async () => {
    const inspector = createInspector()
    const own = system({ side: 'window', views: oneDoc, ...inspector.hooks('own') })
    const made = own.start('counting', counting)
    await rest()
    deepStrictEqual(inspector.inFlight(), [{ kind: 'follow', system: 'own', opId: 1, startedStep: 1, to: 'docs', name: 'count' }])
    // What the view delivered came of the step that followed it.
    deepStrictEqual(inspector.edges, [{ kind: 'view', fromSystem: 'own', fromStep: 1, toSystem: 'own', toStep: 2, opId: 1, ref: 'counting', name: 'docs' }])
    own.stop(made)
    deepStrictEqual(inspector.inFlight(), [])

    // A window that leaves its backend takes no step to stop following: the next step it logs says so.
    const backend = system({ side: 'backend', views: oneDoc })
    const window = system({ side: 'window', ...inspector.hooks('window') })
    const link = connect(window, backend)
    window.start('counting', counting)
    await rest()
    deepStrictEqual(inspector.inFlight(), [{ kind: 'follow', system: 'window', opId: 1, startedStep: 1, to: 'docs', name: 'count' }])
    link.close()
    await rest()
    window.start('pane', pane)
    deepStrictEqual(inspector.inFlight(), [])
  }],
  ['what is done with an answer follows the step that answered it, in one system: answered at once in the step that asked, or in a step of its own', async () => {
    const inspector = createInspector()
    const held = gated()
    const sys = system({ side: 'backend', ...inspector.hooks('one') })
    sys.start('desk', desk(held.gate))
    const made = sys.start('pane', pane)
    sys.send(made, { type: 'NOW' })
    await rest()
    strictEqual(sys.read(made).data.got, 'now')
    // Asked and answered in step 3, and what was done with the answer is step 4.
    deepStrictEqual(inspector.edges, [{ kind: 'done', fromSystem: 'one', fromStep: 3, toSystem: 'one', toStep: 4, opId: 1, ref: 'pane', name: 'now' }])
    deepStrictEqual(inspector.inFlight(), [])
    sys.send(made, { type: 'START' })
    await turns()
    deepStrictEqual(inspector.inFlight(), [{ kind: 'ask', system: 'one', opId: 2, startedStep: 5, to: 'desk', name: 'HOLD' }])
    held.open()
    await rest()
    strictEqual(sys.read(made).data.got, 'held')
    // Asked in step 5, answered in step 6, and done with in step 7.
    deepStrictEqual(inspector.edges.slice(1), [
      { kind: 'answer', fromSystem: 'one', fromStep: 5, toSystem: 'one', toStep: 6, opId: 2, ref: 'desk', name: 'HOLD' },
      { kind: 'done', fromSystem: 'one', fromStep: 6, toSystem: 'one', toStep: 7, opId: 2, ref: 'pane', name: 'hold' },
    ])
    deepStrictEqual(inspector.inFlight(), [])
  }],
  ['an ask is its own state\'s: another state that stops in the step it began in, or that began the step, does not end it', async () => {
    const inspector = createInspector()
    const held = gated()
    const { win } = joined(inspector, held.gate)
    const lead = win.start('boss', boss)
    await rest()
    // The boss is sent GO, tells the pane, and the pane asks: one step, begun by the boss.
    win.send(lead, { type: 'GO' })
    await turns()
    const under = [
      { kind: 'ask', system: 'window', opId: 1, startedStep: 3, to: 'desk', name: 'HOLD' },
      { kind: 'ask', system: 'backend', opId: 1, startedStep: 2, to: 'desk', name: 'HOLD' },
    ]
    deepStrictEqual(inspector.inFlight(), under)
    win.stop(lead)
    deepStrictEqual(inspector.inFlight(), under)
    held.open()
    await rest()
    deepStrictEqual(inspector.inFlight(), [])
  }],
  ['a move to the state it is in is a move, and coverage says where each declared move was made from', async () => {
    const inspector = createInspector()
    const sys = system({ side: 'backend', ...inspector.hooks('one') })
    const made = sys.start('mover', mover)
    sys.send(made, { type: 'TO', at: 'idle' })
    deepStrictEqual(inspector.coverage({ mover: moverGraph }), [{
      title: 'Mover',
      system: 'one',
      ref: 'mover',
      declaredStates: ['idle', 'busy'],
      visitedStates: ['idle'],
      unvisitedStates: ['busy'],
      declaredMoves: [
        { from: 'idle', on: 'TO', to: 'idle', hit: true },
        { from: 'idle', on: 'TO', to: 'busy', hit: false },
        { from: 'busy', on: 'TO', to: 'idle', hit: false },
      ],
      observedMoves: [{ from: 'idle', on: 'TO', to: 'idle' }],
      defects: 0,
      currentAt: 'idle',
    }])
    sys.send(made, { type: 'TO', at: 'busy' })
    sys.send(made, { type: 'TO', at: 'idle' })
    // Made again, a move is the one already seen.
    sys.send(made, { type: 'TO', at: 'idle' })
    const [after] = inspector.coverage({ mover: moverGraph })
    deepStrictEqual(after!.declaredMoves.map((move) => move.hit), [true, true, true])
    deepStrictEqual(after!.observedMoves, [{ from: 'idle', on: 'TO', to: 'idle' }, { from: 'idle', on: 'TO', to: 'busy' }, { from: 'busy', on: 'TO', to: 'idle' }])
    deepStrictEqual(after!.unvisitedStates, [])
    // Stopped, it is nowhere, and what it visited is still what it visited.
    sys.stop(made)
    const [stopped] = inspector.coverage({ mover: moverGraph })
    strictEqual('currentAt' in stopped!, false)
    deepStrictEqual(stopped!.visitedStates, ['idle', 'busy'])
    // What is read of it is a copy: changing it changes nothing kept.
    ;(stopped!.observedMoves as unknown[]).length = 0
    strictEqual(inspector.coverage({ mover: moverGraph })[0]!.observedMoves.length, 3)
  }],
  ['what is kept is bounded by the limit: steps, the states covered, what is under way, and the names under way between systems', async () => {
    const inspector = createInspector({ limit: 2 })
    const sys = system({ side: 'window', views: oneDoc, ...inspector.hooks('one') })
    // Five states that move, each under its own name: the last two are covered.
    for (let index = 0; index < 5; index++) sys.send(sys.start(`mover/${index}`, mover), { type: 'TO', at: 'busy' })
    const seen: string[] = []
    deepStrictEqual(inspector.coverage((ref) => { seen.push(ref); return moverGraph }).map((each) => [each.ref, each.observedMoves.length]), [['mover/3', 1], ['mover/4', 1]])
    deepStrictEqual(seen, ['mover/3', 'mover/4'])
    strictEqual(inspector.steps.length, 2)
    // Where eight states are is kept, four for each step. With five more begun, where the first was is forgotten:
    // moved, it is from nobody knows where, which is no move anyone saw. The last is still known.
    for (let index = 5; index < 10; index++) sys.start(`mover/${index}`, mover)
    sys.send({ ref: 'mover/0' } as never, { type: 'TO', at: 'idle' } as never)
    deepStrictEqual(inspector.coverage({ 'mover/0': moverGraph }).map((each) => [each.currentAt, each.observedMoves]), [['idle', []]])
    sys.send({ ref: 'mover/9' } as never, { type: 'TO', at: 'busy' } as never)
    deepStrictEqual(inspector.coverage({ 'mover/9': moverGraph }).map((each) => [each.currentAt, each.observedMoves]), [['busy', [{ from: 'idle', on: 'TO', to: 'busy' }]]])
    // Ten views followed: the last eight are known to be under way, four for each step kept.
    for (let index = 0; index < 10; index++) sys.start(`counting/${index}`, counting)
    deepStrictEqual(inspector.inFlight().map((op) => op.opId), [3, 4, 5, 6, 7, 8, 9, 10])

    // Three things told under three names before any is taken are more names than are kept: none is given an edge.
    const edgesWith = async (limit: number): Promise<string[]> => {
      const between = createInspector({ limit })
      const { win, handle } = joined(between)
      await rest()
      for (const what of ['PING', 'POKE', 'PAT'] as const) win.send(handle, { type: 'SAY', what })
      await rest()
      return between.steps.flatMap((step) => step.causes.map((edge) => `${edge.kind} ${edge.name}`))
    }
    deepStrictEqual(await edgesWith(3), ['tell PING', 'tell POKE', 'tell PAT'])
    deepStrictEqual(await edgesWith(2), [])
  }],
  ['a limit or a count that is not a whole number is taken as the nearest that is, and what is read of the inspector is a copy', async () => {
    const kept = async (limit: number): Promise<number> => {
      const inspector = createInspector({ limit })
      const sys = system({ side: 'backend', ...inspector.hooks('one') })
      const made = sys.start('mover', mover)
      for (let count = 0; count < 4; count++) sys.send(made, { type: 'TO', at: 'busy' })
      return inspector.steps.length
    }
    strictEqual(await kept(Number.NaN), 1)
    strictEqual(await kept(0), 1)
    strictEqual(await kept(-3), 1)
    strictEqual(await kept(2.9), 2)
    strictEqual(await kept(3), 3)
    strictEqual(await kept(Infinity), 5)

    const inspector = createInspector()
    const sys = system({ side: 'backend', ...inspector.hooks('one') })
    const made = sys.start('mover', mover)
    for (const at of ['busy', 'idle', 'busy'] as const) sys.send(made, { type: 'TO', at })
    const headers = (text: string): string[] => text.split('\n').filter((line) => line.startsWith('one#'))
    deepStrictEqual(headers(inspector.format({ last: 2.9 })), ['one#3 [committed]', 'one#4 [committed]'])
    deepStrictEqual(headers(inspector.format({ last: Infinity })).length, 4)
    strictEqual(inspector.format({ last: Number.NaN }), '(no steps recorded)')
    // Emptying what was read empties nothing that is kept.
    sys.send({ ref: 'nobody' } as never, { type: 'TO', at: 'idle' } as never)
    const broken = system({ side: 'backend', ...inspector.hooks('two') })
    broken.send(broken.start('thrower', desks<{}, { type: 'PING' }>()({ on: { PING: () => { throw new Error('it broke') } } })), { type: 'PING' })
    for (const read of [inspector.steps, inspector.defects, inspector.edges, inspector.whyIgnored(), inspector.inFlight(), inspector.export().steps]) (read as unknown[]).length = 0
    strictEqual(inspector.steps.length, 7)
    strictEqual(inspector.defects.length, 1)
    strictEqual(inspector.whyIgnored().length, 2)
    strictEqual(inspector.export().steps.length, 7)
  }],
  ['an ignored event is explained by why the step says it was: sent from outside what only its state raises, or taken by nothing', async () => {
    const inspector = createInspector()
    const sys = system({ side: 'backend', ...inspector.hooks('one') })
    const quiet = desks<{ internal: { type: 'SECRET' } }, { type: 'PING' }>()({ internal: { SECRET: () => {} }, on: { PING: () => {} } })
    sys.start('ab', quiet)
    sys.start('a', quiet)
    // One step in which `ab` and then `a` are each sent what only they raise, and then something neither takes.
    const sender = desks<{}, { type: 'GO' }>()({
      on: { GO: (_, { tell }) => { for (const type of ['SECRET', 'NOPE']) for (const ref of ['ab', 'a']) tell({ ref } as never, { type } as never) } },
    })
    sys.send(sys.start('sender', sender), { type: 'GO' })
    deepStrictEqual(inspector.whyIgnored(), [
      { seq: 4, system: 'one', step: 4, kind: 'event', ref: 'ab', name: 'SECRET', detail: 'ab was sent SECRET from outside, which only it raises: ignored' },
      { seq: 4, system: 'one', step: 4, kind: 'event', ref: 'a', name: 'SECRET', detail: 'a was sent SECRET from outside, which only it raises: ignored' },
      { seq: 4, system: 'one', step: 4, kind: 'event', ref: 'ab', name: 'NOPE', detail: 'ab ignored NOPE' },
      { seq: 4, system: 'one', step: 4, kind: 'event', ref: 'a', name: 'NOPE', detail: 'a ignored NOPE' },
    ])
    deepStrictEqual(inspector.whyIgnored('a').map((entry) => entry.name), ['SECRET', 'NOPE'])
  }],
  ['two systems that each run a state under one ref are covered apart, and explained apart when asked', async () => {
    const inspector = createInspector()
    const flow = desks<{ states: { one: {}; two: {} } }, { type: 'GO' }>()({ initial: 'one', states: { one: { on: { GO: () => ({ at: 'two' }) } }, two: {} } })
    const tint = desks<{ data: { n: number }; states: { red: {}; blue: {} } }, { type: 'GO' }>()({ data: { n: 0 }, initial: 'red', states: { red: { on: { GO: () => ({ at: 'blue', data: { n: 1 } }) } }, blue: {} } })
    const backHooks = inspector.hooks('backend')
    const back = system({ side: 'backend', ...backHooks })
    const win = system({ side: 'window', ...inspector.hooks('window') })
    const inBack = back.start('feature', flow)
    const inWin = win.start('feature', tint)
    back.send(inBack, { type: 'GO' })
    win.send(inWin, { type: 'GO' })
    const flowGraph: StateGraph = { title: 'Flow', states: ['one', 'two'], moves: [{ from: 'one', on: 'GO', to: ['two'] }], stays: [], answers: [], starts: [], follows: [], loads: [], calls: [], arms: [], reaches: [], findings: [], text: '' }
    const tintGraph: StateGraph = { title: 'Tint', states: ['red', 'blue'], moves: [{ from: 'red', on: 'GO', to: ['blue'] }], stays: [], answers: [], starts: [], follows: [], loads: [], calls: [], arms: [], reaches: [], findings: [], text: '' }
    const covered = inspector.coverage((_, system) => (system === 'backend' ? flowGraph : tintGraph))
    deepStrictEqual(covered.map((each) => [each.title, each.system, each.visitedStates, each.observedMoves, each.currentAt]), [
      ['Flow', 'backend', ['one', 'two'], [{ from: 'one', on: 'GO', to: 'two' }], 'two'],
      ['Tint', 'window', ['red', 'blue'], [{ from: 'red', on: 'GO', to: 'blue' }], 'blue'],
    ])
    // One graph given by name is laid over each system that ran the ref: here it fits the backend's and not the window's.
    deepStrictEqual(inspector.coverage({ feature: flowGraph }).map((each) => [each.system, each.visitedStates, each.declaredMoves.map((move) => move.hit)]), [['backend', ['one', 'two'], [true]], ['window', [], [false]]])
    // And one that nothing ran is given once, of no system.
    deepStrictEqual(inspector.coverage({ unseen: flowGraph }).map((each) => ['system' in each, each.unvisitedStates]), [[false, ['one', 'two']]])
    // Explained without saying which, it is the one that stepped last; said, it is that one.
    deepStrictEqual(inspector.explain('feature').steps.map((step) => step.system), ['window'])
    deepStrictEqual(inspector.explain('feature', { system: 'backend' }).steps.map((step) => [step.system, step.log.number]), [['backend', 2]])
    deepStrictEqual(inspector.explain('feature', { system: 'window', field: 'n' }).steps.map((step) => [step.system, step.log.number]), [['window', 2]])
    deepStrictEqual(inspector.explain('feature', { system: 'backend', field: 'n' }).steps, [])
    // A defect is of the system that reported it, and each state one was reported of is asked about, run or not.
    backHooks.onDefect({ message: 'the backend\'s', ref: 'feature' })
    backHooks.onDefect({ message: 'of one never run', ref: 'ghost' })
    backHooks.onDefect({ message: 'of another', ref: 'wraith' })
    deepStrictEqual(inspector.coverage({ feature: flowGraph }).map((each) => [each.system, each.defects]), [['backend', 1], ['window', 0]])
    const asked: string[] = []
    inspector.coverage((ref, system) => { asked.push(`${system} ${ref}`); return undefined })
    deepStrictEqual(asked, ['backend feature', 'window feature', 'backend ghost', 'backend wraith'])
  }],
  ['a move is by what moved the state, in a step that handled more: one thing that did not, and two that each did', async () => {
    const inspector = createInspector()
    const sys = system({ side: 'backend', ...inspector.hooks('one') })
    const hops = desks<{ states: { one: {}; two: {}; three: {} }; internal: { type: 'B' } | { type: 'C' } }, { type: 'A' }>()({
      initial: 'one',
      on: { A: (_, { raise }) => { raise({ type: 'B' }); raise({ type: 'C' }) } },
      internal: { B: () => ({ at: 'two' }), C: () => ({ at: 'three' }) },
      states: { one: {}, two: {}, three: {} },
    })
    sys.send(sys.start('hops', hops), { type: 'A' })
    deepStrictEqual(inspector.steps.at(-1)!.log.handled.map((each) => [each.name, each.at]), [['A', undefined], ['B', 'two'], ['C', 'three']])
    const graph: StateGraph = { title: 'Hops', states: ['one', 'two', 'three'], moves: [{ from: 'anywhere', on: 'A', to: ['two'] }, { from: 'one', on: 'B', to: ['two'] }, { from: 'two', on: 'C', to: ['three'] }], stays: [], answers: [], starts: [], follows: [], loads: [], calls: [], arms: [], reaches: [], findings: [], text: '' }
    const [covered] = inspector.coverage({ hops: graph })
    deepStrictEqual(covered!.observedMoves, [{ from: 'one', on: 'B', to: 'two' }, { from: 'two', on: 'C', to: 'three' }])
    deepStrictEqual(covered!.declaredMoves.map((move) => [move.on, move.hit]), [['A', false], ['B', true], ['C', true]])
    deepStrictEqual([covered!.visitedStates, covered!.currentAt], [['one', 'two', 'three'], 'three'])
  }],
  ['what a step began leads back to it: a timer to the step that armed it, work to the step it began in, and what work sent later to that step', async () => {
    const inspector = createInspector()
    let fire!: () => void
    const clock = { now: () => 0, after: (_: number, expire: () => void) => { fire = expire; return () => {} } }
    let finish!: (value: void) => void
    const timed = desks<{ data: { fired: number; told: number }; states: { idle: {}; working: {}; done: {} }; arms: { poll: 'single' }; internal: { type: 'TOLD' } }, { type: 'START' } | { type: 'WORK' }>()({
      data: { fired: 0, told: 0 },
      arms: ({ single }) => ({ poll: single({ after: 100, expired: () => ({ data: (d) => { d.fired++ } }) }) }),
      internal: { TOLD: () => ({ data: (d) => { d.told++ } }) },
      initial: 'idle',
      states: {
        idle: { on: { START: (_, { arm }) => { arm('poll') }, WORK: () => ({ at: 'working' }) } },
        working: { async run({ raise }) { await new Promise<void>((resolve) => { finish = resolve }); raise({ type: 'TOLD' }); return { at: 'done' } }, failed: () => {} },
        done: {},
      },
    })
    const sys = system({ side: 'backend', clock, ...inspector.hooks('one') })
    const made = sys.start('timed', timed)
    sys.send(made, { type: 'START' })
    const armedIn = inspector.steps.at(-1)!.log.number
    sys.send(made, { type: 'WORK' })
    const beganIn = inspector.steps.at(-1)!.log.number
    fire()
    const expired = inspector.steps.at(-1)!
    deepStrictEqual(expired.causes, [{ kind: 'expired', fromSystem: 'one', fromStep: armedIn, toSystem: 'one', toStep: expired.log.number, ref: 'timed', name: 'poll' }])
    deepStrictEqual(inspector.explain('timed', { field: 'fired' }).steps.map((step) => step.log.number), [armedIn, expired.log.number])
    finish()
    await rest()
    const after = inspector.steps.filter((step) => step.log.number > expired.log.number)
    deepStrictEqual(after.flatMap((step) => step.causes.map((edge) => [edge.kind, edge.name, edge.fromStep])), [['event', 'TOLD', beganIn], ['result', 'working', beganIn]])
    // What a step sent and handled itself leads to nothing: it is that step.
    deepStrictEqual(inspector.steps.find((step) => step.log.number === armedIn)!.causes, [])
    deepStrictEqual(inspector.explain('timed', { field: 'told' }).steps.map((step) => step.log.number), [beganIn, after[0]!.log.number])
  }],
  ['a system hooked under a name another had is another system, recorded under a name of its own: no two steps are one name and number', async () => {
    const inspector = createInspector()
    const quiet = desks<{}, { type: 'PING' }>()({ on: { PING: () => {} } })
    const first = system({ side: 'backend', ...inspector.hooks('backend') })
    first.send(first.start('a', quiet), { type: 'PING' })
    first.stop()
    const secondHooks = inspector.hooks('backend')
    const second = system({ side: 'backend', ...secondHooks })
    const unbind = inspector.bind('backend', second)
    second.send(second.start('a', quiet), { type: 'PING' })
    const names = inspector.steps.map((step) => `${step.system}#${step.log.number}`)
    strictEqual(new Set(names).size, names.length)
    deepStrictEqual([...new Set(inspector.steps.map((step) => step.system))], ['backend', 'backend (2)'])
    deepStrictEqual(inspector.export().systems, ['backend', 'backend (2)'])
    secondHooks.onDefect({ message: 'of the second', step: 1 })
    deepStrictEqual(inspector.steps.filter((step) => step.defects.length).map((step) => step.system), ['backend (2)'])
    deepStrictEqual(inspector.format({ system: 'backend (2)' }).split('\n').filter((line) => !line.startsWith(' ')).map((line) => line.split(' [')[0]), ['backend (2)#1', 'backend (2)#2'])
    // What it is bound by is the name it was hooked under.
    deepStrictEqual(Object.keys(inspector.snapshots()), ['backend'])
    unbind()
  }],
  ['a defect of a step the kernel threw out of stays that step\'s: the next step logged is not given it', async () => {
    const inspector = createInspector()
    let unit = 0
    let failAt = 0
    const sys = system({
      side: 'backend',
      transact: (inner) => { unit++; if (unit === failAt) throw new Error('the database went away'); return inner() },
      ...inspector.hooks('one'),
    })
    const chain = desks<{ internal: { type: 'BREAK' } | { type: 'AFTER' } }, { type: 'GO' } | { type: 'PING' }>()({
      internal: { BREAK: () => { throw new Error('it broke') }, AFTER: () => {} },
      on: { GO: (_, { raise }) => { raise({ type: 'BREAK' }); raise({ type: 'AFTER' }) }, PING: () => {} },
    })
    const made = sys.start('chain', chain)
    // The step's units are the step, GO, BREAK and AFTER: the last is where the database goes away.
    unit = 0; failAt = 4
    try { sys.send(made, { type: 'GO' }) } catch { /* the kernel's own throw */ }
    failAt = 0
    sys.send(made, { type: 'PING' })
    deepStrictEqual(inspector.steps.map((step) => [step.log.number, step.defects.length]), [[1, 0], [3, 0]])
    deepStrictEqual(inspector.format().split('\n'), [
      'one#1 [committed]',
      'one#3 [committed]',
      '  ◀ event chain PING',
      'one#2 ⚠ DEFECT (chain): chain threw handling BREAK, and nothing changed: it broke',
    ])
  }],
  ['a whole run is formatted and exported as it happened: a window asks, tells and is broadcast to, and each step says what it came of', async () => {
    const inspector = createInspector()
    const { backend, made, win, handle } = joined(inspector)
    await rest()
    win.send(handle, { type: 'NOW' })
    await rest()
    win.send(handle, { type: 'SAY', what: 'PING' })
    await rest()
    backend.send(made, { type: 'SHOUT' })
    await rest()
    deepStrictEqual(inspector.format().split('\n'), [
      'backend#1 [committed]',
      'window#1 [committed]',
      'window#2 [committed]',
      '  ◀ event pane NOW',
      '  ◀ call pane now',
      '  Δ pane: pending',
      '  ▶ ask -> desk NOW #1',
      'backend#2 [committed]  ← window#2 (ask#1)',
      '  ◀ ask desk NOW #1 (from a window)',
      '  ▶ answer -> desk NOW #1 [ok]',
      'window#3 [committed]  ← window#2 (answer#1), backend#2 (answer#1)',
      '  ◀ answer desk NOW #1',
      '  ▶ answer -> desk NOW #1 [ok]',
      'window#4 [committed]  ← window#3 (done#1)',
      '  ◀ done pane now #1',
      '  Δ pane: fields=[got], pending',
      'window#5 [committed]',
      '  ◀ event pane SAY',
      '  ▶ tell -> desk PING',
      'backend#3 [committed]  ← window#5 (tell)',
      '  ◀ event desk PING (from a window)',
      '  Δ desk: fields=[pings]',
      'backend#4 [committed]',
      '  ◀ event desk SHOUT',
      '  ▶ broadcast -> pane NOTE',
      'window#6 [committed]  ← backend#4 (broadcast)',
      '  ◀ event pane NOTE (from the backend)',
      '  Δ pane: fields=[notes]',
    ])
    deepStrictEqual(inspector.edges, [
      { kind: 'ask', fromSystem: 'window', fromStep: 2, toSystem: 'backend', toStep: 2, opId: 1, ref: 'desk', name: 'NOW' },
      { kind: 'answer', fromSystem: 'window', fromStep: 2, toSystem: 'window', toStep: 3, opId: 1, ref: 'desk', name: 'NOW' },
      { kind: 'answer', fromSystem: 'backend', fromStep: 2, toSystem: 'window', toStep: 3, opId: 1, ref: 'desk', name: 'NOW' },
      { kind: 'done', fromSystem: 'window', fromStep: 3, toSystem: 'window', toStep: 4, opId: 1, ref: 'pane', name: 'now' },
      { kind: 'tell', fromSystem: 'window', fromStep: 5, toSystem: 'backend', toStep: 3, ref: 'desk', name: 'PING' },
      { kind: 'broadcast', fromSystem: 'backend', fromStep: 4, toSystem: 'window', toStep: 6, ref: 'pane', name: 'NOTE' },
    ])
    // What a field came of is every step back from the one that last changed it, and nothing beside.
    const why = inspector.explain('pane', { field: 'got' })
    deepStrictEqual(why.steps.map((step) => `${step.system}#${step.log.number}`), ['window#2', 'backend#2', 'window#3', 'window#4'])
    deepStrictEqual(why.edges.map((edge) => edge.kind), ['done', 'answer', 'answer', 'ask'])
    strictEqual(why.text, inspector.format().split('\n').slice(2, 16).join('\n'))
    deepStrictEqual({ ref: why.ref, field: why.field }, { ref: 'pane', field: 'got' })
    // Asked of a state and no field, it is from the last step that handled, changed or sent to it.
    deepStrictEqual(inspector.explain('desk').steps.map((step) => `${step.system}#${step.log.number}`), ['backend#4'])
    strictEqual('field' in inspector.explain('desk'), false)
    deepStrictEqual(inspector.explain('pane').steps.map((step) => `${step.system}#${step.log.number}`), ['backend#4', 'window#6'])
    deepStrictEqual(inspector.explain('nobody'), { ref: 'nobody', steps: [], edges: [], text: '(no recorded step touched nobody)' })
    deepStrictEqual(inspector.explain('pane', { field: 'nothing' }), { ref: 'pane', field: 'nothing', steps: [], edges: [], text: '(no recorded step touched pane.data.nothing)' })
    // By system, by state, and the last of them.
    deepStrictEqual(inspector.format({ system: 'backend', last: 2 }).split('\n').filter((line) => !line.startsWith('  ')), ['backend#3 [committed]  ← window#5 (tell)', 'backend#4 [committed]'])
    deepStrictEqual(inspector.format({ ref: 'desk' }).split('\n').filter((line) => !line.startsWith('  ')).map((line) => line.split(' ')[0]), ['backend#1', 'window#2', 'backend#2', 'window#3', 'window#5', 'backend#3', 'backend#4'])
    const exported = inspector.export()
    deepStrictEqual({ ...exported, steps: exported.steps.length }, { version: 1, systems: ['backend', 'window'], steps: 10, defects: [], inFlight: [], ignored: [] })
    deepStrictEqual(exported.steps[3], {
      seq: 4,
      system: 'backend',
      log: { number: 2, handled: [{ kind: 'ask', ref: 'desk', name: 'NOW', id: 1, across: 'window' }], changed: {}, sent: [{ kind: 'answer', to: 'desk', name: 'NOW', id: 1, outcome: 'ok' }], status: 'committed' },
      defects: [],
      causes: [inspector.edges[0]],
    })
  }],
  ['a broadcast is given its edge only where one alone could be the one a window took: not in a burst, and never from before the window was hooked', async () => {
    const inspector = createInspector()
    const { backend, made, win, handle } = joined(inspector)
    await rest()
    const shout = (): number => { backend.send(made, { type: 'SHOUT' }); return inspector.steps.at(-1)!.log.number }
    const noted = (window: string): string[][] => inspector.steps
      .filter((step) => step.system === window && step.log.handled.some((each) => each.name === 'NOTE'))
      .map((step) => step.causes.map((edge) => `${edge.kind} ${edge.fromSystem}#${edge.fromStep}`))
    // Two before the window takes either: which it took first is not in any log, and neither is given an edge.
    shout()
    shout()
    await rest()
    deepStrictEqual(noted('window'), [[], []])
    // Caught up, the next is the only one it has not taken.
    const third = shout()
    await rest()
    deepStrictEqual(noted('window'), [[], [], [`broadcast backend#${third}`]])
    // A window hooked after those was sent none of them: the next broadcast is the first it could take.
    const late = system({ side: 'window', ...inspector.hooks('late') })
    connect(late, backend)
    late.start('pane', pane)
    await rest()
    const fourth = shout()
    await rest()
    deepStrictEqual(noted('late'), [[`broadcast backend#${fourth}`]])
    deepStrictEqual(noted('window').at(-1), [`broadcast backend#${fourth}`])
    // A window hooked before a broadcast and joined after it was not sent it, and cannot say so: it is never caught up, and never given an edge.
    const absent = system({ side: 'window', ...inspector.hooks('absent') })
    absent.start('pane', pane)
    shout()
    await rest()
    connect(absent, backend)
    const sixth = shout()
    await rest()
    shout()
    await rest()
    deepStrictEqual(noted('absent'), [[], []])
    strictEqual(absent.read({ ref: 'pane' } as typeof handle).data.notes, 2)
    deepStrictEqual(noted('window').at(-2), [`broadcast backend#${sixth}`])
    // The same event sent in the window is not a broadcast.
    win.send(handle, { type: 'NOTE' })
    deepStrictEqual(noted('window').at(-1), [])

    // A backend that is not inspected: what its window takes came from nothing known, then and after.
    const alone = createInspector()
    const unseen = system({ side: 'backend' })
    const other = unseen.start('desk', desk(() => Promise.resolve()))
    const window = system({ side: 'window', ...alone.hooks('window') })
    connect(window, unseen)
    window.start('pane', pane)
    unseen.send(other, { type: 'SHOUT' })
    await rest()
    deepStrictEqual(alone.edges, [])
    strictEqual(alone.steps.at(-1)!.log.handled[0]!.across, 'backend')
  }],
  ['what two windows tell a backend alike is told apart only when one is waiting: both waiting, neither is given an edge, and the next alone is', async () => {
    const inspector = createInspector()
    const { backend, made, win, handle } = joined(inspector, undefined, 'one')
    const two = system({ side: 'window', ...inspector.hooks('two') })
    connect(two, backend)
    const other = two.start('pane', pane)
    await rest()
    const pinged = (): string[][] => inspector.steps
      .filter((step) => step.system === 'backend' && step.log.handled.some((each) => each.name === 'PING'))
      .map((step) => step.causes.map((edge) => `${edge.kind} ${edge.fromSystem}#${edge.fromStep}`))
    const say = (window: typeof win, to: typeof handle): number => { window.send(to, { type: 'SAY', what: 'PING' }); return inspector.steps.at(-1)!.log.number }
    // Both tell before the backend takes either.
    say(win, handle)
    say(two, other)
    await rest()
    deepStrictEqual(pinged(), [[], []])
    // Both were taken, so nothing is waiting: the next is the only one, whichever window tells it.
    const third = say(two, other)
    await rest()
    const fourth = say(win, handle)
    await rest()
    deepStrictEqual(pinged().slice(2), [[`tell two#${third}`], [`tell one#${fourth}`]])
    // Two from one window are in the order it told them: a link keeps that.
    const fifth = say(win, handle)
    const sixth = say(win, handle)
    await rest()
    deepStrictEqual(pinged().slice(4), [[`tell one#${fifth}`], [`tell one#${sixth}`]])
    // Sent here, the same event is no window's.
    backend.send(made, { type: 'PING' })
    deepStrictEqual(pinged().at(-1), [])
    strictEqual(backend.read(made).data.pings, 7)

    // More waiting under one name than are kept are not told apart: none is given an edge, and the next alone is.
    const small = createInspector({ limit: 2 })
    const few = joined(small)
    await rest()
    for (let count = 0; count < 3; count++) few.win.send(few.handle, { type: 'SAY', what: 'PING' })
    await rest()
    deepStrictEqual(small.edges.map((edge) => edge.kind), [])
    few.win.send(few.handle, { type: 'SAY', what: 'PING' })
    await rest()
    deepStrictEqual(small.edges.map((edge) => edge.kind), ['tell'])
  }],
  ['an ask given up after it left may or may not be taken: alone it is the one taken, and with another behind it neither is told apart', async () => {
    const inspector = createInspector()
    const held = gated()
    const { win, handle } = joined(inspector, held.gate)
    await rest()
    const taken = (): string[][] => inspector.steps
      .filter((step) => step.system === 'backend' && step.log.handled.some((each) => each.kind === 'ask'))
      .map((step) => step.causes.map((edge) => `${edge.kind} ${edge.fromSystem}#${edge.fromStep} #${edge.opId}`))
    // Asked and given up before the backend takes it: nothing else is waiting, so what is taken is it.
    win.send(handle, { type: 'START' })
    const first = inspector.steps.at(-1)!.log.number
    win.send(handle, { type: 'STOP' })
    await turns()
    deepStrictEqual(taken(), [[`ask window#${first} #1`]])
    // Asked, given up and asked again before the backend takes either: the first may never come, so neither is told apart.
    win.send(handle, { type: 'START' })
    win.send(handle, { type: 'STOP' })
    win.send(handle, { type: 'START' })
    await turns()
    deepStrictEqual(taken().slice(1), [[], []])
    // Both came. Given up and asked once more, the next is alone again.
    win.send(handle, { type: 'STOP' })
    await turns()
    win.send(handle, { type: 'START' })
    const last = inspector.steps.at(-1)!.log.number
    await turns()
    deepStrictEqual(taken().slice(3), [[`ask window#${last} #4`]])
    held.open()
    await rest()
    deepStrictEqual(inspector.inFlight(), [])
    strictEqual(win.read(handle).data.got, 'held')
  }],
  ['an ask is answered from the step its answerer left it in, and one its link ended before it was taken is never taken for the next', async () => {
    const inspector = createInspector()
    const held = gated()
    const { backend, made, win, handle } = joined(inspector, held.gate)
    await rest()
    win.send(handle, { type: 'START' })
    await turns()
    // The desk stops before answering: the window's ask is answered, as abandoned, from the step it stopped in.
    backend.stop(made)
    const stopped = inspector.steps.at(-1)!
    deepStrictEqual(stopped.log.sent, [{ kind: 'abandoned', to: 'desk', name: 'HOLD', id: 1 }])
    await turns()
    const answered = inspector.steps.find((step) => step.system === 'window' && step.log.handled.some((each) => each.kind === 'answer'))!
    deepStrictEqual(answered.causes.map((edge) => `${edge.kind} ${edge.fromSystem}#${edge.fromStep}`), ['answer window#2', `answer backend#${stopped.log.number}`])
    deepStrictEqual(inspector.inFlight(), [])
    held.open()
    await rest()

    // A link that ends with an ask on it: the ask is answered by no step, and is never taken.
    const lossy = createInspector()
    const far = system({ side: 'backend', ...lossy.hooks('backend') })
    far.start('desk', desk(() => Promise.resolve()))
    const near = system({ side: 'window', ...lossy.hooks('window') })
    let dropped = false
    const later = (run: () => void): void => { queueMicrotask(run) }
    const port: Port = {
      tell: (to, event) => later(() => far.port.tell(to, event)),
      ask: (to, name, args, progress, done) => {
        if (!dropped) { dropped = true; later(() => done({ ok: false, failure: { kind: 'disconnected', message: 'the link ended' } })); return () => {} }
        later(() => far.port.ask(to, name, args, progress, (outcome) => later(() => done(outcome))))
        return () => {}
      },
      follow: (feature, view, args, updated, failed) => far.port.follow(feature, view, args, updated, failed),
    }
    near.attach(port)
    const mine = near.start('pane', pane)
    near.send(mine, { type: 'NOW' })
    await rest()
    const ended = lossy.steps.find((step) => step.system === 'window' && step.log.handled.some((each) => each.kind === 'answer'))!
    deepStrictEqual(ended.causes.map((edge) => `${edge.kind} ${edge.fromSystem}`), ['answer window'])
    // Asked again, what the backend takes is the second: with the first still not known to be gone, it is not said to be either.
    near.send(mine, { type: 'NOW' })
    await rest()
    const took = lossy.steps.filter((step) => step.system === 'backend' && step.log.handled.some((each) => each.kind === 'ask'))
    deepStrictEqual(took.map((step) => step.causes), [[]])
    strictEqual(near.read(mine).data.got, 'now')
    deepStrictEqual(lossy.inFlight(), [])
  }],
  ['a step whose rows could not be kept stops its system: nothing of it is under way and its states are nowhere, and another system\'s are as they were', async () => {
    const inspector = createInspector()
    let failing = false
    const backend = system({ side: 'backend', views: oneDoc, ...inspector.hooks('backend') })
    backend.start('desk', desk(() => new Promise(() => {})))
    let depth = 0
    // The whole step's unit fails as it is kept: the units inside it, one for each thing handled, do not.
    const transact = <T,>(inner: () => T): T => { depth++; try { const made = inner(); if (failing && depth === 1) throw new Error('disk full'); return made } finally { depth-- } }
    const flaky = system({ side: 'window', transact, ...inspector.hooks('flaky') })
    const other = system({ side: 'window', views: oneDoc, ...inspector.hooks('other') })
    connect(flaky, backend)
    flaky.start('counting', counting)
    flaky.start('mover', mover)
    flaky.send(flaky.start('pane', pane), { type: 'START' })
    other.start('counting', counting)
    other.start('mover', mover)
    await turns()
    deepStrictEqual(inspector.inFlight().map((op) => `${op.system} ${op.kind} ${op.name}`).sort(), ['backend ask HOLD', 'flaky ask HOLD', 'flaky follow count', 'other follow count'])
    failing = true
    flaky.send({ ref: 'mover' } as never, { type: 'TO', at: 'busy' } as never)
    strictEqual(inspector.steps.at(-1)!.log.status, 'lost')
    deepStrictEqual(inspector.inFlight().filter((op) => op.system !== 'backend'), [{ kind: 'follow', system: 'other', opId: 1, startedStep: 1, to: 'docs', name: 'count' }])
    const where = (): Array<[string | undefined, string | undefined]> => inspector.coverage({ mover: moverGraph }).map((each) => [each.system, each.currentAt])
    deepStrictEqual(where().sort(), [['flaky', undefined], ['other', 'idle']])
    other.stop()
    deepStrictEqual(where().sort(), [['flaky', undefined], ['other', undefined]])
  }],
  ['every line of a trace: a key, an event raised, one ignored, a clock, two fields, a state that stopped, and defects with and without a step', async () => {
    const inspector = createInspector()
    const defects: InspectorUpdate[] = []
    inspector.subscribe((update) => { if (update.kind === 'defect') defects.push(update) })
    const oneHooks = inspector.hooks('one')
    const sys = system({ side: 'backend', clock: { now: () => 7, after: () => () => {} }, ...oneHooks })
    const lines = desks<{
      data: { a: number; b: number }
      states: { on: {}; off: {} }
      internal: { type: 'TWICE' }
      calls: { now: 'each' }
    }, { type: 'GO' } | { type: 'THROW' }>()({
      data: { a: 0, b: 0 },
      initial: 'on',
      calls: ({ each }) => ({ now: each('desk', 'NOW', { done: () => undefined }) }),
      internal: { TWICE: (_, { data }) => ({ data: { a: data.a + 1, b: data.b + 1 } }) },
      on: {
        GO: (_, { raise, call }) => { raise({ type: 'TWICE' }); call('now', 'k') },
        THROW: () => { throw 'a string, thrown' },
      },
      states: { on: {}, off: {} },
    })
    sys.start('desk', desk(() => Promise.resolve()))
    const made = sys.start('lines', lines)
    sys.send(made, { type: 'GO' })
    await rest()
    sys.send(made, { type: 'THROW' })
    sys.send({ ref: 'nobody' } as never, { type: 'GO' } as never)
    sys.stop(made)
    // Of no state: what hears an ask's progress throws, as the step that answered it commits.
    const told = sys.start('slow', desks<{}, never, { SLOW: { args: {}; progress: string; answer: string } }>()({ answers: { SLOW: (_, { progress }) => { progress('half'); return 'done' } } }))
    await sys.ask(told as never, 'SLOW' as never, {} as never, (() => { throw new Error('nobody listens') }) as never)
    await rest()
    // And of no step: reported between two.
    oneHooks.onDefect({ message: 'of no step', ref: 'lines' })
    oneHooks.onDefect({ message: 'of no step or state' })
    deepStrictEqual(inspector.format().split('\n'), [
      'one#1 [committed @ 7ms]',
      'one#2 [committed @ 7ms]',
      'one#3 [committed @ 7ms]',
      '  ◀ event lines GO',
      '  ◀ event lines TWICE (own)',
      '  ◀ call lines now [k]',
      '  ◀ ask desk NOW #1',
      '  Δ lines: fields=[a, b], pending',
      '  ▶ answer -> desk NOW #1 [ok]',
      'one#4 [committed @ 7ms]  ← one#3 (done#1)',
      '  ◀ done lines now [k] #1',
      '  Δ lines: pending',
      'one#5 [committed @ 7ms]',
      '  ◀ event lines THROW',
      '  ⚠ DEFECT (lines): lines threw handling THROW, and nothing changed: a string, thrown',
      'one#6 [committed @ 7ms]',
      '  ◀ event nobody GO (ignored)',
      'one#7 [committed @ 7ms]',
      'one#8 [committed @ 7ms]',
      'one#9 [committed @ 7ms]',
      '  ◀ ask slow SLOW #2',
      '  ▶ progress -> slow SLOW #2',
      '  ▶ answer -> slow SLOW #2 [ok]',
      '  ⚠ DEFECT: what hears progress threw: nobody listens',
      'one ⚠ DEFECT (lines): of no step',
      'one ⚠ DEFECT: of no step or state',
    ])
    deepStrictEqual(inspector.defects, [
      { seq: 5, system: 'one', message: 'lines threw handling THROW, and nothing changed: a string, thrown', ref: 'lines', step: 5, error: 'a string, thrown' },
      { seq: 10, system: 'one', message: 'what hears progress threw: nobody listens', step: 9, error: 'nobody listens' },
      { seq: 12, system: 'one', message: 'of no step', ref: 'lines' },
      { seq: 13, system: 'one', message: 'of no step or state' },
    ])
    deepStrictEqual(defects, inspector.defects.map((defect) => ({ kind: 'defect', defect })))
    deepStrictEqual(inspector.whyIgnored(), [
      { seq: 5, system: 'one', step: 5, kind: 'defect', ref: 'lines', detail: 'lines threw handling THROW, and nothing changed: a string, thrown' },
      { seq: 7, system: 'one', step: 6, kind: 'event', ref: 'nobody', name: 'GO', detail: 'nobody ignored GO' },
      { seq: 10, system: 'one', step: 9, kind: 'defect', ref: 'one', detail: 'what hears progress threw: nobody listens' },
      { seq: 12, system: 'one', kind: 'defect', ref: 'lines', detail: 'of no step' },
      { seq: 13, system: 'one', kind: 'defect', ref: 'one', detail: 'of no step or state' },
    ])
    // Under way while it is, from when the clock said.
    const held = system({ side: 'backend', clock: { now: () => 9, after: () => () => {} }, ...inspector.hooks('two') })
    void held.ask(held.start('desk', desk(() => new Promise(() => {}))), 'HOLD', {})
    deepStrictEqual(inspector.inFlight(), [{ kind: 'ask', system: 'two', opId: 1, startedStep: 2, startedAt: 9, to: 'desk', name: 'HOLD' }])
  }],
  ['a defect is its step\'s, whenever it is reported: before the step is logged, twice in one step, or after, in whichever system it was', async () => {
    const inspector = createInspector()
    const twice = desks<{ internal: { type: 'AGAIN' } }, { type: 'PING' }>()({
      internal: { AGAIN: () => { throw new Error('and again') } },
      on: { PING: (_, { raise }) => { raise({ type: 'AGAIN' }); raise({ type: 'AGAIN' }) } },
    })
    // A log that throws is reported after its step was logged, as a defect of that step.
    let throwing = ''
    const one = system({ side: 'backend', ...inspector.hooks('one', { log: () => { if (throwing === 'one') throw new Error('one\'s log broke') } }) })
    const two = system({ side: 'backend', ...inspector.hooks('two', { log: () => { if (throwing === 'two') throw new Error('two\'s log broke') } }) })
    throwing = 'one'
    const made = one.start('twice', twice)
    throwing = 'two'
    two.start('twice', twice)
    throwing = ''
    // The first step of each was the one whose log threw: each has its own defect, and not the other's.
    deepStrictEqual(inspector.steps.map((step) => [step.system, step.log.number, step.defects.map((defect) => defect.message)]), [
      ['one', 1, ['the step log threw: one\'s log broke']],
      ['two', 1, ['the step log threw: two\'s log broke']],
    ])
    // What it raises twice throws twice: two defects, both of the one step.
    one.send(made, { type: 'PING' })
    deepStrictEqual(inspector.steps.at(-1)!.defects.map((defect) => [defect.seq, defect.step, defect.error]), [[5, 2, 'and again'], [6, 2, 'and again']])
    // The hooks are called by a kernel that keeps what they throw to itself: with nothing to forward to, they throw nothing.
    const bare = createInspector().hooks('bare')
    bare.onDefect({ message: 'nothing forwards this' })
  }],
  ['what is forgotten at the limit is forgotten whole: a step, and each edge from it, while the step it led to still says what it came of', async () => {
    const inspector = createInspector({ limit: 3 })
    const { win, handle } = joined(inspector)
    await rest()
    win.send(handle, { type: 'NOW' })
    await rest()
    const kept = (): string[] => inspector.steps.map((step) => `${step.system}#${step.log.number}`)
    const edges = (): string[] => inspector.edges.map((edge) => `${edge.kind} ${edge.fromSystem}#${edge.fromStep}→${edge.toSystem}#${edge.toStep}`)
    // Kept: the backend's answering, the window's taking the answer, and what it did with it. The window's asking,
    // its second step as the answering is the backend's second, is forgotten, and both edges from it.
    deepStrictEqual(kept(), ['backend#2', 'window#3', 'window#4'])
    deepStrictEqual(edges(), ['answer backend#2→window#3', 'done window#3→window#4'])
    // What the answer came of is still on its step, though one of those steps is gone: asked why, it is the steps that are kept.
    deepStrictEqual(inspector.steps[1]!.causes.map((edge) => `${edge.kind} ${edge.fromSystem}#${edge.fromStep}`), ['answer window#2', 'answer backend#2'])
    deepStrictEqual(inspector.explain('pane', { field: 'got' }).steps.map((step) => `${step.system}#${step.log.number}`), ['backend#2', 'window#3', 'window#4'])
    // The first step kept is found, as the last is.
    deepStrictEqual(inspector.explain('desk').steps.map((step) => `${step.system}#${step.log.number}`), ['backend#2', 'window#3'])
    win.send(handle, { type: 'NOTE' })
    deepStrictEqual(kept(), ['window#3', 'window#4', 'window#5'])
    deepStrictEqual(edges(), ['done window#3→window#4'])
    // The first step kept is the last that touched the desk, and is found: what it came of is gone.
    deepStrictEqual(inspector.explain('desk').steps.map((step) => `${step.system}#${step.log.number}`), ['window#3'])
    win.send(handle, { type: 'NOTE' })
    deepStrictEqual(edges(), [])
    // Nothing the inspector did threw, which a kernel would have kept to itself and said as a defect.
    deepStrictEqual(inspector.defects, [])
  }],
  ['an edge from a step already forgotten is not kept beside the steps, whatever other step has its number or its system', async () => {
    const inspector = createInspector({ limit: 3 })
    const held = gated()
    const { win, handle } = joined(inspector, held.gate)
    await rest()
    // The window asks in its second step, and the backend holds the ask.
    win.send(handle, { type: 'START' })
    await turns()
    // Another system takes its second step, and the window two more: its asking is forgotten, and steps are kept
    // that share its number, and that share its system.
    const other = system({ side: 'backend', ...inspector.hooks('other') })
    win.send(handle, { type: 'NOTE' })
    other.send(other.start('mover', mover), { type: 'TO', at: 'busy' })
    win.send(handle, { type: 'NOTE' })
    deepStrictEqual(inspector.steps.map((step) => `${step.system}#${step.log.number}`), ['other#1', 'other#2', 'window#4'])
    held.open()
    await rest()
    // The answer came of the window's asking, which its step still says, and of the backend's answering, which is kept.
    const answered = inspector.steps.find((step) => step.log.handled.some((each) => each.kind === 'answer' && step.system === 'window'))!
    deepStrictEqual(answered.causes.map((edge) => `${edge.kind} ${edge.fromSystem}#${edge.fromStep}`), ['answer window#2', 'answer backend#3'])
    deepStrictEqual(inspector.edges.map((edge) => `${edge.kind} ${edge.fromSystem}#${edge.fromStep}→${edge.toSystem}#${edge.toStep}`), ['answer backend#3→window#5', 'done window#5→window#6'])
  }],
  ['an ask given up where it was made, in one system, is over there, and nothing else is disturbed by it', async () => {
    const inspector = createInspector()
    const sys = system({ side: 'backend', ...inspector.hooks('one') })
    sys.start('desk', desk(() => new Promise(() => {})))
    const made = sys.start('pane', pane)
    sys.send(made, { type: 'START' })
    await turns()
    deepStrictEqual(inspector.inFlight().map((op) => op.name), ['HOLD'])
    sys.send(made, { type: 'STOP' })
    deepStrictEqual(inspector.steps.at(-1)!.log.sent, [{ kind: 'cancelled', to: 'desk', name: 'HOLD', id: 1 }])
    deepStrictEqual(inspector.inFlight(), [])
    deepStrictEqual(inspector.defects, [])
  }],
  ['coverage counts what a state itself did: its own defects, a move from inside a state, by the event that made it, in a step another state began', async () => {
    const inspector = createInspector()
    const oneHooks = inspector.hooks('one')
    const sys = system({ side: 'backend', ...oneHooks })
    type Deep = { data: { n: number }; states: { out: {}; in: { initial: 'near'; states: { near: {}; far: {} } } } }
    const deep = desks<Deep, { type: 'IN' } | { type: 'OUT' } | { type: 'LEAVE' } | { type: 'COUNT' } | { type: 'THROW' }>()({
      data: { n: 0 },
      initial: 'out',
      on: { COUNT: (_, { data }) => ({ data: { n: data.n + 1 } }), THROW: () => { throw new Error('it broke') } },
      states: {
        out: { on: { IN: () => ({ at: 'in.far' }) } },
        in: { initial: 'near', on: { OUT: () => ({ at: 'out' }), LEAVE: () => ({ at: 'out' }) }, states: { near: {}, far: {} } },
      },
    })
    const deepGraph: StateGraph = {
      title: 'Deep',
      states: ['out', 'in', 'in.near', 'in.far', 'i', 'in.f'],
      moves: [{ from: 'out', on: 'IN', to: ['in'] }, { from: 'in', on: 'OUT', to: ['out'] }, { from: 'in', on: 'LEAVE', to: ['out'] }, { from: 'in.near', on: 'OUT', to: ['out'] }, { from: 'n', on: 'OUT', to: ['out'] }],
      stays: [], answers: [], starts: [], follows: [], loads: [], calls: [], arms: [], reaches: [], findings: [], text: 'Deep',
    }
    const made = sys.start('deep', deep)
    // Told by another state, in a step that state began: what moved it is what it was told.
    const sender = desks<{}, { type: 'GO' }>()({ on: { GO: (_, { tell }) => { tell({ ref: 'deep' } as never, { type: 'IN' } as never) } } })
    sys.send(sys.start('sender', sender), { type: 'GO' })
    // A change to its data where it is is no move.
    sys.send(made, { type: 'COUNT' })
    sys.send(made, { type: 'OUT' })
    sys.send(made, { type: 'THROW' })
    sys.send(made, { type: 'THROW' })
    const flat = sys.start('flat', desks<{}, { type: 'PING' }>()({ on: { PING: () => { throw new Error('flat broke') } } }))
    sys.send(flat, { type: 'PING' })
    deepStrictEqual(inspector.coverage({ deep: deepGraph }), [{
      title: 'Deep',
      system: 'one',
      ref: 'deep',
      declaredStates: ['out', 'in', 'in.near', 'in.far', 'i', 'in.f'],
      visitedStates: ['out', 'in', 'in.far'],
      unvisitedStates: ['in.near', 'i', 'in.f'],
      declaredMoves: [
        { from: 'out', on: 'IN', to: 'in', hit: true },
        { from: 'in', on: 'OUT', to: 'out', hit: true },
        { from: 'in', on: 'LEAVE', to: 'out', hit: false },
        { from: 'in.near', on: 'OUT', to: 'out', hit: false },
        { from: 'n', on: 'OUT', to: 'out', hit: false },
      ],
      observedMoves: [{ from: 'out', on: 'IN', to: 'in.far' }, { from: 'in.far', on: 'OUT', to: 'out' }],
      defects: 2,
      currentAt: 'out',
    }])
    // The same move by another event is another move.
    sys.send(made, { type: 'IN' })
    sys.send(made, { type: 'LEAVE' })
    deepStrictEqual(inspector.coverage({ deep: deepGraph })[0]!.observedMoves.slice(2), [{ from: 'in.far', on: 'LEAVE', to: 'out' }])
    // Asked by a function, it is asked of every state that was somewhere or broke, and of nothing else.
    const asked: string[] = []
    deepStrictEqual(inspector.coverage((ref) => { asked.push(ref); return ref === 'flat' ? moverGraph : undefined }).map((each) => [each.ref, each.defects, each.visitedStates]), [['flat', 1, []]])
    deepStrictEqual(asked, ['deep', 'flat'])
    // A defect of no state asks of none.
    oneHooks.onDefect({ message: 'of no state' })
    asked.length = 0
    inspector.coverage((ref) => { asked.push(ref); return undefined })
    deepStrictEqual(asked, ['deep', 'flat'])
  }],
  ['a trace asked for by system, state or count holds the defects that are theirs: of that system, of that state, and from the first step shown on', async () => {
    const inspector = createInspector({ limit: 3 })
    const thrower = desks<{}, { type: 'PING' } | { type: 'NOTE' }>()({ on: { PING: () => { throw new Error('it broke') }, NOTE: () => {} } })
    const one = system({ side: 'backend', ...inspector.hooks('one') })
    const twoHooks = inspector.hooks('two')
    const two = system({ side: 'backend', ...twoHooks })
    const first = one.start('a', thrower)
    const second = two.start('b', thrower)
    one.send(first, { type: 'PING' })
    two.send(second, { type: 'PING' })
    two.send(second, { type: 'NOTE' })
    two.send(second, { type: 'NOTE' })
    // Kept: two's throw and its two notes. The step in which `a` threw is forgotten, and its defect is not.
    const unattached = 'one#2 ⚠ DEFECT (a): a threw handling PING, and nothing changed: it broke'
    const attached = '  ⚠ DEFECT (b): b threw handling PING, and nothing changed: it broke'
    const marks = (text: string): string[] => text.split('\n').filter((line) => line.includes('DEFECT'))
    deepStrictEqual(marks(inspector.format()), [attached])
    deepStrictEqual(marks(inspector.format({ system: 'one' })), [unattached])
    deepStrictEqual(marks(inspector.format({ ref: 'a' })), [unattached])
    deepStrictEqual(marks(inspector.format({ system: 'two' })), [attached])
    deepStrictEqual(marks(inspector.format({ ref: 'b' })), [attached])
    strictEqual(inspector.format({ system: 'one', last: 1 }), '(no steps recorded)')
    strictEqual(inspector.format({ last: 0 }), '(no steps recorded)')
    // A defect of no step, reported between the steps shown, is shown with them, and not with later ones alone.
    const hooks = twoHooks
    hooks.onDefect({ message: 'between steps' })
    two.send(second, { type: 'NOTE' })
    deepStrictEqual(marks(inspector.format({ last: 2 })), ['two ⚠ DEFECT: between steps'])
    deepStrictEqual(marks(inspector.format({ last: 1 })), [])
  }],
  ['a system that is bound is read as it stands, and as it stood after each step if that is asked for, until it is unbound', async () => {
    const inspector = createInspector({ captureSnapshots: true })
    const sys = system({ side: 'backend', ...inspector.hooks('one') })
    const unbind = inspector.bind('one', sys)
    const made = sys.start('mover', mover)
    sys.send(made, { type: 'TO', at: 'busy' })
    deepStrictEqual(inspector.snapshots(), { one: { mover: { at: 'busy', data: {} } } })
    deepStrictEqual(inspector.steps.map((step) => step.snapshot), [{ mover: { at: 'idle', data: {} } }, { mover: { at: 'busy', data: {} } }])
    deepStrictEqual(inspector.export().systems, ['one'])
    // Bound again to another, the first's unbinding is no longer its to undo.
    const other = { snapshot: () => ({ other: true }) }
    inspector.bind('one', other)
    unbind()
    deepStrictEqual(inspector.snapshots(), { one: { other: true } })
    inspector.bind('one', sys)()
    deepStrictEqual(inspector.snapshots(), {})
    sys.send(made, { type: 'TO', at: 'idle' })
    strictEqual('snapshot' in inspector.steps.at(-1)!, false)
    // Unasked, no step holds one, bound or not; and a system that is only bound is one of the systems.
    const plain = createInspector()
    plain.bind('two', sys)
    const hooked = system({ side: 'backend', ...plain.hooks('three') })
    hooked.start('mover', mover)
    strictEqual('snapshot' in plain.steps[0]!, false)
    deepStrictEqual(plain.export().systems, ['two', 'three'])
  }],
  ['an ask that has ended is forgotten, so that what is still under way is what is kept, and what is cleared mid-way is heard of no more', async () => {
    // One ask kept for each step: four in all, so a fifth would push the oldest out.
    const inspector = createInspector({ limit: 1 })
    const held = gated()
    const { win, handle } = joined(inspector, held.gate)
    await rest()
    win.send(handle, { type: 'START' })
    await turns()
    const under = inspector.inFlight()
    deepStrictEqual(under.map((op) => `${op.system} ${op.name}`), ['window HOLD', 'backend HOLD'])
    // Five asks answered at once, each over on both sides before the next: the held one is still what is kept.
    for (let count = 0; count < 5; count++) { win.send(handle, { type: 'NOW' }); await turns() }
    deepStrictEqual(inspector.inFlight(), under)
    // Cleared while the held ask is under way: its answer, and what is done with it, come of nothing known.
    inspector.clear()
    deepStrictEqual([inspector.steps, inspector.edges, inspector.defects, inspector.inFlight(), inspector.whyIgnored()], [[], [], [], [], []])
    held.open()
    await rest()
    strictEqual(win.read(handle).data.got, 'held')
    deepStrictEqual(inspector.steps.map((step) => step.seq), [3])
    deepStrictEqual(inspector.edges, [])
    deepStrictEqual(inspector.inFlight(), [])
  }],
  ['a peer told is not something ignored, and one that was dropped or failed is, by name', async () => {
    const inspector = createInspector()
    const backend = system({ side: 'backend', ...inspector.hooks('backend') })
    const heard: string[] = []
    backend.peer('audit', (event) => { heard.push((event as { type: string }).type) })
    const made = backend.start('svc', makeSvc(() => Promise.resolve()))
    backend.send(made, { type: 'PING' })
    await backend.ask(made, 'SAVE', { text: 'said' })
    await rest()
    deepStrictEqual(heard, ['LOG'])
    // The tell that was heard is not there, nor the progress the ask sent: only the peer nobody named.
    deepStrictEqual(inspector.whyIgnored(), [{ seq: 2, system: 'backend', step: 2, kind: 'peer', ref: 'missing', name: 'LOG', detail: 'peer missing LOG dropped' }])
  }],
  ['a line the kernel traces that explains nothing is not kept in place of one that does', async () => {
    const inspector = createInspector({ limit: 1 })
    const sys = system({ side: 'backend', ...inspector.hooks('one') })
    sys.start('a', desks<{ internal: { type: 'SECRET' } }, never>()({ internal: { SECRET: () => {} } }))
    sys.start('mover', mover)
    // One step: `a` is sent what only it raises, and then the mover moves, which the kernel also traces.
    const sender = desks<{}, { type: 'GO' }>()({
      on: { GO: (_, { tell }) => { tell({ ref: 'a' } as never, { type: 'SECRET' } as never); tell({ ref: 'mover' } as never, { type: 'TO', at: 'busy' } as never) } },
    })
    sys.send(sys.start('sender', sender), { type: 'GO' })
    deepStrictEqual(inspector.whyIgnored().map((entry) => entry.detail), ['a was sent SECRET from outside, which only it raises: ignored'])
  }],
  ['what an ask says before it ends is given the step that said it, where only one could be; of two steps said before any was heard, the first is and no later one', async () => {
    type StreamAsks = { STREAM: { args: {}; progress: string; answer: null } }
    const streaming = forNet<{ systems: { feed: { events: never; asks: StreamAsks } }; surfaces: {}; views: {} }>()
    const inspector = createInspector()
    const frames: Array<() => void> = []
    let say!: (piece: string) => void
    let end!: (value: null) => void
    const backend = system({ side: 'backend', ...inspector.hooks('backend') })
    backend.start('feed', streaming<{}, never, StreamAsks>()({ answers: { STREAM: (_, { progress }) => { say = progress; return new Promise<null>((resolve) => { end = resolve }) } } }))
    const win = system({ side: 'window', frame: (run) => { frames.push(run) }, ...inspector.hooks('window') })
    connect(win, backend)
    win.start('reader', streaming<{ data: { heard: number }; calls: { stream: 'single' } }>()({
      data: { heard: 0 },
      calls: ({ single }) => ({ stream: single('feed', 'STREAM', { progress: (pieces, { data }) => ({ data: { heard: data.heard + pieces.length } }), done: () => {} }) }),
      run: ({ call }) => { call('stream') },
    }))
    await turns()
    const frame = async (): Promise<void> => { await turns(); for (const run of frames.splice(0)) run(); await turns() }
    /** The step in which the backend said a piece, said in a step of its own. */
    const said = (piece: string): number => { say(piece); return inspector.steps.findLast((step) => step.system === 'backend' && step.log.sent.some((sent) => sent.kind === 'progress'))!.log.number }
    /** For each step in which the window heard something: the step of another system it is said to come of, where one is, and nothing else from outside. */
    const heardFrom = (): Array<number | undefined> => inspector.steps.filter((step) => step.system === 'window' && step.log.handled.some((each) => each.kind === 'progress')).map((step) => {
      const outside = step.causes.filter((edge) => edge.fromSystem !== 'window')
      ok(outside.length <= 1 && outside.every((edge) => edge.kind === 'progress' && edge.fromSystem === 'backend'), JSON.stringify(step.causes))
      return outside[0]?.fromStep
    })

    // One piece, heard alone: it is from the step that said it.
    const first = said('a')
    await frame()
    deepStrictEqual(heardFrom(), [first])
    // Two pieces said in two steps before the window's frame: they are heard as one list. The first is surely in it;
    // whether the second was is not known, so it is given no edge here, and nothing after it is given one.
    const second = said('b')
    said('c')
    await frame()
    deepStrictEqual(heardFrom(), [first, second])
    said('d')
    await frame()
    deepStrictEqual(heardFrom(), [first, second, undefined])
    end(null)
    await rest()
    // How it ended comes of the step that answered, and of nothing that was said before.
    const ended = inspector.steps.findLast((step) => step.system === 'window' && step.log.handled.some((each) => each.kind === 'answer'))!
    deepStrictEqual(ended.causes.filter((edge) => edge.fromSystem === 'backend').map((edge) => edge.kind), ['answer'])
    deepStrictEqual(inspector.defects, [])
    win.stop(); backend.stop()
  }],
  ['what is said of an ask nobody hears with, or of one the inspector no longer knows, is given to no step, and breaks nothing', async () => {
    type StreamAsks = { STREAM: { args: {}; progress: string; answer: null } }
    const streaming = forNet<{ systems: { feed: { events: never; asks: StreamAsks } }; surfaces: {}; views: {} }>()
    const inspector = createInspector()
    let say!: (piece: string) => void
    let end!: (value: null) => void
    const backend = system({ side: 'backend', ...inspector.hooks('backend') })
    backend.start('feed', streaming<{}, never, StreamAsks>()({ answers: { STREAM: (_, { progress }) => { say = progress; return new Promise<null>((resolve) => { end = resolve }) } } }))
    const win = system({ side: 'window', ...inspector.hooks('window') })
    connect(win, backend)
    // It hears nothing said before the end: it has no `progress`.
    win.start('reader', streaming<{ calls: { stream: 'single' } }>()({ calls: ({ single }) => ({ stream: single('feed', 'STREAM', { done: () => {} }) }), run: ({ call }) => { call('stream') } }))
    await turns()
    say('a')
    await turns()
    end(null)
    await rest()
    const ended = inspector.steps.findLast((step) => step.system === 'window' && step.log.handled.some((each) => each.kind === 'answer'))!
    deepStrictEqual(ended.causes.filter((edge) => edge.fromSystem === 'backend').map((edge) => edge.kind), ['answer'])
    const done = inspector.steps.findLast((step) => step.system === 'window' && step.log.handled.some((each) => each.kind === 'done'))!
    deepStrictEqual(done.causes.map((edge) => edge.kind), ['done'])
    // Said of an ask taken before the inspector was cleared: it knows of no such ask, and takes it as nothing.
    win.start('later', streaming<{ calls: { stream: 'single' } }>()({ calls: ({ single }) => ({ stream: single('feed', 'STREAM', { done: () => {} }) }), run: ({ call }) => { call('stream') } }))
    await turns()
    inspector.clear()
    say('b')
    await turns()
    deepStrictEqual(inspector.defects, [])
    strictEqual(inspector.steps.some((step) => step.log.sent.some((sent) => sent.kind === 'progress')), true)
    end(null)
    await rest()
    win.stop(); backend.stop()
  }],
])
