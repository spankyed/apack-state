// What a handler says is its own until it is made. One that throws, refuses, or returns a change that cannot be made
// has told nobody, sent nothing, asked nothing and reported no progress, as it has written nothing. Whoever asked it
// is still told that it failed: that is the kernel's word, not the handler's.
//
//   npx vitest run unsaid
import { deepStrictEqual, ok, strictEqual } from 'node:assert'
import { connect, rest, run, system } from './checks.mts'
import { answered, given, forNet, type StepLog } from '../src/index.ts'
import { memory } from './store.mts'
import { nextTurn } from '../src/turn.ts'

/** How a handler ends, having said everything it has to say first. */
type Ends = 'made' | 'throws' | 'stray'
type AskEnds = Ends | 'refuses' | 'change throws' | 'change refuses'

type EarEvent = { type: 'NOTE'; text: string }
type EarAsks = {
  ECHO: { args: { text: string }; answer: string }
  SLOW: { args: { text: string }; answer: string; progress: string }
}
type DeskEvent = { type: 'SAY'; how: Ends } | { type: 'COUNT' } | { type: 'WORK'; how: 'at once' | 'in failed' } | { type: 'REST' }
type DeskAsks = {
  DO: { args: { how: AskEnds }; progress: string; answer: string; refuses: 'no' }
  LATER: { args: { how: 'throws' | 'refuses' }; answer: string; refuses: 'no' }
}
type PanelEvent = { type: 'NOTED'; text: string } | { type: 'PASS'; how: Ends }
type PanelAsks = { RELAY: { args: { how: Ends }; answer: string } }
type App = {
  systems: { ear: { events: EarEvent; asks: EarAsks }; desk: { events: DeskEvent; asks: DeskAsks } }
  surfaces: { panel: { events: PanelEvent } }
  views: { notes: { list: { args: {}; result: string } } }
}
const state = forNet<App>()

/** Keeps what it was told and what it was asked, in the order they came. */
const ear = (gate?: Promise<void>) => state<{ data: { heard: string[] } }, EarEvent, EarAsks>()({
  data: { heard: [] },
  on: { NOTE: ({ text }, { data }) => ({ data: { heard: [...data.heard, text] } }) },
  answers: {
    ECHO: ({ text }) => answered(text, { data: (d) => { d.heard.push(`asked ${text}`) } }),
    SLOW: async ({ text }, { progress }) => {
      progress(`working ${text}`)
      await (gate ?? new Promise<void>((resolve) => { nextTurn(resolve) }))
      return answered(text, { data: (d) => { d.heard.push(`slow ${text}`) } })
    },
  },
})

/** Says something every way a backend state can, and then ends as it is told to. `ended` is told how the ask it made ended. */
const desk = (ended: (outcome: unknown) => void) => state<{ data: { count: number; problem: string | null }; states: { idle: {}; working: { data: { how: 'at once' | 'in failed' } } } }, DeskEvent, DeskAsks>()({
  data: { count: 0, problem: null },
  initial: 'idle',
  on: {
    COUNT: (_, { data }) => ({ data: { count: data.count + 1 } }),
    SAY: ({ how }, { tell, send, broadcast }) => {
      tell('ear', { type: 'NOTE', text: 'said' })
      send({ type: 'COUNT' })
      broadcast('panel', { type: 'NOTED', text: 'said' })
      if (how === 'throws') throw new Error('the handler broke')
      if (how === 'stray') return { data: { nothing: 1 } } as never
      return undefined
    },
    WORK: ({ how }) => ({ at: 'working', data: { how } }),
    REST: () => ({ at: 'idle' }),
  },
  answers: {
    DO: ({ how }, { tell, send, broadcast, progress, ask, refuse }) => {
      tell('ear', { type: 'NOTE', text: 'doing' })
      send({ type: 'COUNT' })
      broadcast('panel', { type: 'NOTED', text: 'doing' })
      progress('half way')
      const echo = ask('ear', 'ECHO', { text: 'echo' })
      void echo.then(ended)
      if (how === 'throws') throw new Error('the handler broke')
      if (how === 'refuses') throw refuse('no', 'the handler refused')
      if (how === 'stray') return answered('done', { data: { nothing: 1 } } as never)
      if (how === 'change throws' || how === 'change refuses') {
        return answered('done', { data: () => {
          if (how === 'change throws') throw new Error('the change broke')
          throw refuse('no', 'the change refused')
        } })
      }
      return echo.then(() => 'done')
    },
    LATER: async ({ how }, { tell, refuse }) => {
      // Said before the wait, in the step that took the ask: that step is made, so it stands.
      tell('ear', { type: 'NOTE', text: 'before wait' })
      await new Promise<void>((resolve) => { nextTurn(resolve) })
      if (how === 'refuses') throw refuse('no', 'refused after wait')
      throw new Error('broke after wait')
    },
  },
  states: {
    idle: {},
    working: {
      data: { how: given },
      run({ data, tell }) {
        if (data.how === 'at once') { tell('ear', { type: 'NOTE', text: 'working' }); throw new Error('broke at once') }
        return new Promise<never>((_, reject) => { nextTurn(() => reject(new Error('broke later'))) })
      },
      failed: (error, { data, tell }) => {
        if (data.how === 'in failed') { tell('ear', { type: 'NOTE', text: 'failing' }); throw new Error('failed broke as well') }
        return { at: 'idle', data: { problem: error instanceof Error ? error.message : String(error) } }
      },
    },
  },
})

/** A surface: keeps what was broadcast to it, and passes word to the backend before ending as it is told to. */
const panel = (ended: (outcome: unknown) => void) => state<{ data: { seen: string[] } }, PanelEvent, PanelAsks>()({
  data: { seen: [] },
  on: {
    NOTED: ({ text }, { data }) => ({ data: { seen: [...data.seen, text] } }),
    PASS: ({ how }, { tell }) => {
      tell('desk', { type: 'COUNT' })
      if (how === 'throws') throw new Error('the handler broke')
      if (how === 'stray') return { data: { nothing: 1 } } as never
      return undefined
    },
  },
  answers: {
    RELAY: ({ how }, { ask }) => {
      const done = ask('desk', 'DO', { how: 'made' })
      void done.then(ended)
      if (how === 'throws') throw new Error('the handler broke')
      if (how === 'stray') return answered('relayed', { data: { nothing: 1 } } as never)
      return done.then(() => 'relayed')
    },
  },
})

/** A backend that keeps rows, so each thing it handles is a unit, and a window that keeps none. */
const wired = () => {
  const store = memory()
  const steps: StepLog[] = []
  const traced: string[] = []
  const backend = system({ side: 'backend', transact: store.transact, log: (step) => { steps.push(step) }, trace: (line) => { traced.push(line) } })
  const theEar = backend.start('ear', ear())
  const ended = { echo: [] as unknown[], relayed: [] as unknown[] }
  const theDesk = backend.start('desk', desk((outcome) => { ended.echo.push(outcome) }))
  const window = system({ side: 'window', trace: (line) => { traced.push(line) } })
  connect(window, backend)
  const thePanel = window.start('panel', panel((outcome) => { ended.relayed.push(outcome) }))
  const progress: string[] = []
  return {
    backend, window, steps, traced, progress, ended,
    say: (how: Ends): void => backend.send(theDesk, { type: 'SAY', how }),
    work: (how: 'at once' | 'in failed'): void => backend.send(theDesk, { type: 'WORK', how }),
    doIt: (how: AskEnds) => backend.ask(theDesk, 'DO', { how }, (updates) => { progress.push(...updates) }),
    later: (how: 'throws' | 'refuses') => backend.ask(theDesk, 'LATER', { how }),
    pass: (how: Ends): void => window.send(thePanel, { type: 'PASS', how }),
    relay: (how: Ends) => window.ask(thePanel, 'RELAY', { how }),
    /** Everything anybody was told, by whoever it was said to. */
    said: () => ({ heard: backend.read(theEar).data.heard, count: backend.read(theDesk).data.count, seen: window.read(thePanel).data.seen, progress }),
    desk: () => backend.read(theDesk),
  }
}
const NOTHING = { heard: [], count: 0, seen: [], progress: [] }
/** How an ask ends when the handler that made it was not made. */
const TAKEN_BACK = { ok: false, failure: { kind: 'abandoned', message: 'What made this ask was not made, so it was never asked' } }

const refused: ReadonlyArray<readonly [AskEnds, string, string]> = [
  ['throws', 'failed', 'the handler broke'],
  ['refuses', 'no', 'the handler refused'],
  ['stray', 'failed', 'The change that came with the answer was refused, so nothing was changed'],
  ['change throws', 'failed', 'The change that came with the answer was refused, so nothing was changed'],
  ['change refuses', 'no', 'the change refused'],
]

await run([
  ['a handler that is made has said what it said: a state told, itself sent, and a window broadcast to', async () => {
    const it = wired()
    it.say('made')
    await rest()
    deepStrictEqual(it.said(), { heard: ['said'], count: 1, seen: ['said'], progress: [] })
  }],
  ['a handler that throws has said nothing', async () => {
    const it = wired()
    it.say('throws')
    await rest()
    deepStrictEqual(it.said(), NOTHING)
  }],
  ['a handler whose change cannot be made has said nothing', async () => {
    const it = wired()
    it.say('stray')
    await rest()
    deepStrictEqual(it.said(), NOTHING)
  }],
  ['what was said before and after one that was not made is said, in its order', async () => {
    const it = wired()
    it.say('made')
    it.say('throws')
    it.say('made')
    await rest()
    deepStrictEqual(it.said(), { heard: ['said', 'said'], count: 2, seen: ['said', 'said'], progress: [] })
  }],
  ['an ask that is made has said what it said, its progress and the ask it made among it', async () => {
    const it = wired()
    deepStrictEqual(await it.doIt('made'), { ok: true, value: 'done' })
    await rest()
    deepStrictEqual(it.said(), { heard: ['doing', 'asked echo'], count: 1, seen: ['doing'], progress: ['half way'] })
  }],
  ...refused.map(([how, kind, message]) => [`an ask whose handler ${how} has said nothing, and whoever asked is told`, async () => {
    const it = wired()
    deepStrictEqual(await it.doIt(how), { ok: false, failure: { kind, message } })
    // It comes to rest: the ask the handler made is ended, so nothing waits on what will never be asked.
    await rest()
    deepStrictEqual(it.said(), NOTHING)
    deepStrictEqual(it.ended.echo, [TAKEN_BACK])
  }] as const),
  ['what leaves the step of an ask that was not made is its answer, and nothing the handler said', async () => {
    const it = wired()
    await it.doIt('throws')
    await rest()
    const step = it.steps.find((each) => each.handled[0]?.name === 'DO')!
    deepStrictEqual(step.handled, [{ kind: 'ask', ref: 'desk', name: 'DO' }])
    deepStrictEqual(step.sent, [{ kind: 'answer', to: 'desk', name: 'DO', outcome: 'failed' }])
  }],
  ['work that fails at once has said nothing, and goes where the state says', async () => {
    const it = wired()
    it.work('at once')
    await rest()
    deepStrictEqual(it.said(), NOTHING)
    deepStrictEqual(it.desk(), { at: 'idle', data: { count: 0, problem: 'broke at once' } })
  }],
  ['a `failed` that throws has said nothing', async () => {
    const it = wired()
    it.work('in failed')
    await rest()
    deepStrictEqual(it.said(), NOTHING)
    strictEqual(it.desk().at, 'working')
  }],
  ['in a window, a handler that is made has told the backend', async () => {
    const it = wired()
    it.pass('made')
    await rest()
    strictEqual(it.said().count, 1)
  }],
  ['in a window, a handler that throws has told the backend nothing', async () => {
    const it = wired()
    it.pass('throws')
    await rest()
    strictEqual(it.said().count, 0)
  }],
  ['in a window, a handler whose change cannot be made has told the backend nothing', async () => {
    const it = wired()
    it.pass('stray')
    await rest()
    strictEqual(it.said().count, 0)
  }],
  ['in a window, an ask made across the link by a handler that is made is asked', async () => {
    const it = wired()
    deepStrictEqual(await it.relay('made'), { ok: true, value: 'relayed' })
    await rest()
    deepStrictEqual(it.said(), { heard: ['doing', 'asked echo'], count: 1, seen: ['doing'], progress: [] })
  }],
  ['in a window, an ask made across the link by a handler that throws is never asked, and nothing waits on it', async () => {
    const it = wired()
    deepStrictEqual(await it.relay('throws'), { ok: false, failure: { kind: 'failed', message: 'the handler broke' } })
    await rest()
    deepStrictEqual(it.said(), NOTHING)
    deepStrictEqual(it.ended.relayed, [TAKEN_BACK])
    // Closing the link finds no ask waiting on it to end.
    strictEqual(it.window.idle(), true)
  }],
  ['in a window, an ask made across the link by a handler whose change cannot be made is never asked', async () => {
    const it = wired()
    deepStrictEqual(await it.relay('stray'), { ok: false, failure: { kind: 'failed', message: 'The change that came with the answer was refused, so nothing was changed' } })
    await rest()
    deepStrictEqual(it.said(), NOTHING)
    deepStrictEqual(it.ended.relayed, [TAKEN_BACK])
    strictEqual(it.window.idle(), true)
  }],
  ['what an async ask said before it waited stands, though it fails or refuses after', async () => {
    for (const how of ['throws', 'refuses'] as const) {
      const it = wired()
      const outcome = await it.later(how)
      await rest()
      strictEqual(outcome.ok, false)
      deepStrictEqual(it.said().heard, ['before wait'])
    }
  }],
  ['a child state whose handler throws has reported nothing to whoever started it', async () => {
    const child = state<{ reports: { type: 'PING' } }, { type: 'FAIL' }>()({
      on: { FAIL: (_, { report }) => { report({ type: 'PING' }); throw new Error('child broke') } },
    })
    const parent = state<{ data: { pings: number }; starts: { worker: typeof child } }, { type: 'PING'; from: string }>()({
      data: { pings: 0 },
      starts: () => ({ worker: child }),
      on: { PING: (_, { data }) => ({ data: { pings: data.pings + 1 } }) },
    })
    const backend = system({ side: 'backend' })
    const top = backend.start('parent', parent)
    backend.send(backend.child(top, 'worker'), { type: 'FAIL' })
    await rest()
    strictEqual(backend.read(top).data.pings, 0)
  }],
  ['a handler that drops what is being made and then throws has dropped nothing', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const maker = state<{ data: { done: string[] }; calls: { work: 'one' } }, { type: 'START' } | { type: 'FAIL_DROP' }>()({
      data: { done: [] },
      calls: ({ one }) => ({ work: one('ear', 'SLOW', { args: () => ({ text: 'kept' }), done: (outcome) => (outcome.ok ? { data: (d) => { d.done.push(outcome.value) } } : undefined) }) }),
      on: {
        START: (_, { call }) => { call('work') },
        FAIL_DROP: (_, { cancel }) => { cancel('work'); throw new Error('drop broke') },
      },
    })
    const backend = system({ side: 'backend' })
    const theEar = backend.start('ear', ear(gate))
    const theMaker = backend.start('maker', maker)
    backend.send(theMaker, { type: 'START' })
    backend.send(theMaker, { type: 'FAIL_DROP' })
    strictEqual(backend.read(theMaker).pending.work, true)
    release()
    await rest()
    deepStrictEqual(backend.read(theMaker).data.done, ['kept'])
    deepStrictEqual(backend.read(theEar).data.heard, ['slow kept'])
  }],
  ['a view, loaded read, or called ask handler that throws has said nothing', async () => {
    let deliverView!: (update: { ok: true; value: string }) => void
    const reactor = state<{ data: { ready: boolean }; calls: { job: 'one' } }, { type: 'GO' }>()({
      data: { ready: true },
      follows: (follow) => ({
        list: follow('notes', 'list', {
          args: () => ({}),
          update: (_, { tell }) => { tell('ear', { type: 'NOTE', text: 'from view' }); throw new Error('view broke') },
        }),
      }),
      loads: (wait) => ({
        read: wait('ear', 'ECHO', {
          from: ['ready'],
          args: () => ({ text: 'read' }),
          done: (_, { tell }) => { tell('ear', { type: 'NOTE', text: 'from await' }); throw new Error('await broke') },
        }),
      }),
      calls: ({ one }) => ({
        job: one('ear', 'ECHO', {
          args: () => ({ text: 'job' }),
          done: (_, { tell }) => { tell('ear', { type: 'NOTE', text: 'from make' }); throw new Error('make broke') },
        }),
      }),
      on: { GO: (_, { call }) => { call('job') } },
    })
    const backend = system({
      side: 'backend',
      views: (_feature, _view, _args, heard) => { deliverView = heard; return () => {} },
    })
    const theEar = backend.start('ear', ear())
    const theReactor = backend.start('reactor', reactor)
    deliverView({ ok: true, value: 'v1' })
    backend.send(theReactor, { type: 'GO' })
    await rest()
    // Only the asks to ear crossed; none of the throwing reaction handlers told ear anything.
    deepStrictEqual(backend.read(theEar).data.heard, ['asked read', 'asked job'])
  }],
  ['taking back an ask runs no progress listener while the step transaction is still open', async () => {
    let inTransaction = false
    const observed: Array<{ inTransaction: boolean; updates: readonly string[] }> = []
    const frames: Array<() => void> = []
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const ended: unknown[] = []
    const backend = system({
      side: 'backend',
      frame: (fn) => { frames.push(fn) },
      transact: (fn) => {
        const outer = !inTransaction
        inTransaction = true
        try { return fn() } finally { if (outer) inTransaction = false }
      },
    })
    const theEar = backend.start('ear', ear(gate))
    const theDesk = backend.start('desk', desk((outcome) => { ended.push(outcome) }))
    // Gather a progress update and hold its frame so it waits in `gathered` when the failing ask runs.
    const slowAsk = backend.ask(theEar, 'SLOW', { text: 'p' }, (updates) => { observed.push({ inTransaction, updates }) })
    await new Promise<void>((resolve) => { nextTurn(resolve) })
    strictEqual(frames.length > 0, true)
    await backend.ask(theDesk, 'DO', { how: 'throws' })
    release()
    await slowAsk
    await rest()
    deepStrictEqual(observed, [{ inTransaction: false, updates: ['working p'] }])
    deepStrictEqual(ended, [TAKEN_BACK])
  }],
  ['stopping after an ask was taken back does not trace that it was left unanswered', async () => {
    const it = wired()
    await it.doIt('throws')
    await it.relay('throws')
    await rest()
    it.backend.stop()
    it.window.stop()
    await rest()
    deepStrictEqual(it.traced.filter((line) => line.includes('left unanswered')), [])
  }],
  ['an ask taken back in a step whose commit fails is still ended', async () => {
    const ended: unknown[] = []
    let failCommit = false
    let depth = 0
    const backend = system({
      side: 'backend',
      transact: (fn) => {
        depth++
        try {
          const result = fn()
          if (depth === 1 && failCommit) throw new Error('disk full')
          return result
        } finally { depth-- }
      },
    })
    backend.start('ear', ear())
    const theDesk = backend.start('desk', desk((outcome) => { ended.push(outcome) }))
    failCommit = true
    const outer = await backend.ask(theDesk, 'DO', { how: 'throws' })
    await rest()
    strictEqual(outer.ok, false)
    deepStrictEqual(ended, [TAKEN_BACK])
  }],
  ['a synchronous run() returning a refused change rolls back its database writes and everything it said, while valid returns commit cleanly', async () => {
    for (const kind of ['stray', 'bad move', 'draft throws', 'non-object'] as const) {
      const rows = memory()
      const defects: string[] = []
      const sys = system({ side: 'backend', transact: rows.transact, trace: (line) => { if (line.startsWith('DEFECT')) defects.push(line) } })
      const earH = sys.start('ear', ear())
      const actor = state<{ data: { n: number }; states: { idle: {}; bad: {} } }, { type: 'GO' }>()({
        data: { n: 0 },
        initial: 'idle',
        on: { GO: () => ({ at: 'bad' }) },
        states: {
          idle: {},
          bad: {
            run({ tell }) {
              rows.put('thread', kind, { topic: 'must-roll-back' })
              tell('ear', { type: 'NOTE', text: `from ${kind}` })
              if (kind === 'stray') return { data: { nope: 1 } } as never
              if (kind === 'bad move') return { at: 'missing' } as never
              if (kind === 'draft throws') return { at: 'idle', data: () => { throw new Error('draft broke') } }
              return { at: 'idle', data: null as never }
            },
          },
        },
      })
      const h = sys.start('actor', actor)
      sys.send(h, { type: 'GO' })
      strictEqual(rows.get('thread', kind), undefined, `${kind} must roll back DB writes`)
      deepStrictEqual(sys.read(earH).data.heard, [], `${kind} must unsay tell`)
      strictEqual(sys.read(h).at, 'bad', `${kind} keeps entered state without applying refused return`)
      strictEqual(defects.length, 1, `${kind} reports one defect`)
      if (kind === 'non-object') ok(defects[0]!.includes('non-object'), defects[0])
    }
    // A parent state whose synchronous run() returns a move defers the move until its start substate has finished entering.
    const order: string[] = []
    const parentMove = state<{
      states: {
        idle: {}
        outer: { states: { inner: {} } }
        other: {}
      }
    }, { type: 'GO' }>()({
      initial: 'idle',
      on: { GO: () => ({ at: 'outer' }) },
      states: {
        idle: {},
        outer: {
          run() { order.push('outer'); return { at: 'other' } },
          initial: 'inner',
          states: {
            inner: {
              run({ onExit }) { order.push('inner'); onExit(() => { order.push('left-inner') }) },
            },
          },
        },
        other: {
          run() { order.push('other') },
        },
      },
    })
    const psys = system({ side: 'backend' })
    const ph = psys.start('p', parentMove)
    psys.send(ph, { type: 'GO' })
    strictEqual(psys.read(ph).at, 'other')
    deepStrictEqual(order, ['outer', 'inner', 'left-inner', 'other'])
    // Valid synchronous run() returns: null (no-op), data-only, move without data, move with plain data, and move with draft edit.
    for (const kind of ['null', 'data-only', 'move-plain', 'move-data', 'move-draft'] as const) {
      const defects: string[] = []
      const sys = system({ side: 'backend', trace: (line) => { if (line.startsWith('DEFECT')) defects.push(line) } })
      const actor = state<{ data: { n: number }; states: { idle: {}; step: {}; done: { data: { tag?: string | undefined } } } }, { type: 'GO' }>()({
        data: { n: 0 },
        initial: 'idle',
        on: { GO: () => ({ at: 'step' }) },
        states: {
          idle: {},
          step: {
            run() {
              if (kind === 'null') return null as never
              if (kind === 'data-only') return { data: { n: 5 } }
              if (kind === 'move-plain') return { at: 'done' }
              if (kind === 'move-data') return { at: 'done', data: { n: 7, tag: 'ok' } }
              return { at: 'done', data: (d) => { d.n = 9 } }
            },
          },
          done: { data: { tag: undefined as never } },
        },
      })
      const h = sys.start('actor', actor)
      sys.send(h, { type: 'GO' })
      deepStrictEqual(defects, [], kind)
      const snap = sys.read(h)
      if (kind === 'null') deepStrictEqual([snap.at, snap.data.n], ['step', 0])
      if (kind === 'data-only') deepStrictEqual([snap.at, snap.data.n], ['step', 5])
      if (kind === 'move-plain') deepStrictEqual([snap.at, snap.data.n], ['done', 0])
      if (kind === 'move-data') deepStrictEqual([snap.at, snap.data.n, (snap.data as { tag?: string }).tag], ['done', 7, 'ok'])
      if (kind === 'move-draft') deepStrictEqual([snap.at, snap.data.n], ['done', 9])
    }
  }],
  ['a lost commit still settles asks abandoned during exit in the failing step and logs them as abandoned', async () => {
    const logs: StepLog[] = []
    let failCommit = false
    let depth = 0
    const sys = system({
      side: 'backend',
      log: (step) => logs.push(step),
      transact: (fn) => {
        depth++
        try {
          const result = fn()
          if (depth === 1 && failCommit) throw new Error('disk full')
          return result
        } finally { depth-- }
      },
    })
    const worker = state<{ states: { busy: {}; done: {} } }, { type: 'LEAVE' }, { SLOW: { args: {}; answer: string } }>()({
      initial: 'busy',
      states: {
        busy: {
          on: { LEAVE: () => ({ at: 'done' }) },
          answers: { SLOW: async () => new Promise<string>(() => {}) },
        },
        done: {},
      },
    })
    const h = sys.start('worker', worker)
    const pending = sys.ask(h, 'SLOW', {})
    await new Promise<void>((resolve) => { nextTurn(resolve) })
    failCommit = true
    sys.send(h, { type: 'LEAVE' })
    const outcome = await pending
    strictEqual(outcome.ok, false)
    if (!outcome.ok) strictEqual(outcome.failure.kind, 'abandoned')
    const lostLog = logs.at(-1)!
    strictEqual(lostLog.ended, 'lost')
    deepStrictEqual(lostLog.sent.filter((s) => s.to === 'worker' && s.name === 'SLOW'), [{ kind: 'abandoned', to: 'worker', name: 'SLOW' }])
  }],
])
