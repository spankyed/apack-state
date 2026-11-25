// What happens to an ask when whoever made it goes: the state that asked is left while the answer is still coming.
// The ask ends where it is awaited, with `Left`, so the code that asked unwinds the way cancelled code does everywhere.
//
//   npx vitest run leaving
import { deepStrictEqual, ok, strictEqual } from 'node:assert'
import { connect, rest, run, system } from './checks.mts'
import { given, Left, reaching } from '../src/index.ts'
import { nextTurn } from '../src/turn.ts'

type SlowAsks = {
  WAIT: { args: { turns: number }; answer: string }
  /** Work that is passed `signal`, and throws what it aborted with, as `fetch` and a stream do. */
  FETCH: { args: { turns: number }; answer: string }
  RELAY: { args: { turns: number }; answer: string }
  /** Says something before it answers. */
  TALK: { args: {}; answer: string; progress: string }
  /** Says something, and then works a while before it answers. */
  TALK_THEN_WAIT: { args: {}; answer: string; progress: string }
}
type App = { systems: { slow: { events: never; asks: SlowAsks } }; surfaces: {}; views: {} }
export const state = reaching<App>()

const turns = (count: number): Promise<void> => new Promise((resolve) => { let left = count; const tick = (): void => { if (left-- <= 0) resolve(); else nextTurn(tick) }; tick() })

/** What the panel's work was ended with, for the checks to read. */
const thrown: unknown[] = []
/** What the backend did, for the checks to read. */
const backendSaw: string[] = []
const slow = state<{}, never, SlowAsks>()({
  asks: {
    WAIT: async ({ turns: count }, { signal }) => {
      backendSaw.push('WAIT began')
      signal.addEventListener('abort', () => backendSaw.push('WAIT told its asker had gone'))
      await turns(count)
      return 'done'
    },
    FETCH: async ({ turns: count }, { signal }) => {
      for (let turn = 0; turn < count; turn++) { await turns(1); signal.throwIfAborted() }
      return 'done'
    },
    // A handler that itself asks. When whoever asked it goes, the ask it made goes with them.
    RELAY: async ({ turns: count }, { ask }) => {
      try { const inner = await ask('slow', 'WAIT', { turns: count }); return inner.ok ? inner.value : 'failed' }
      finally { backendSaw.push('RELAY unwound') }
    },
    TALK: (_, { progress }) => { progress('one'); return 'done' },
    TALK_THEN_WAIT: async (_, { progress }) => { progress('one'); await turns(30); return 'done' },
  },
})

type How = 'await' | 'all' | 'floating' | 'relay' | 'fetch' | 'answered' | 'late' | 'unheard' | 'tell' | 'talks'
export type PanelEvent = { type: 'START'; how: How } | { type: 'LEAVE' }
export type Panel = { states: { idle: {}; working: { data: { how: How } } } }

const panel = (saw: string[], lock: { held: boolean }) => state<Panel, PanelEvent>()({
  start: 'idle',
  on: {
    START: ({ how }) => ({ at: 'working', data: { how } }),
    LEAVE: () => ({ at: 'idle' }),
  },
  states: {
    idle: {},
    working: {
      data: { how: given },
      async run({ data, ask, tell }) {
        lock.held = true
        try {
          if (data.how === 'await') await ask('slow', 'WAIT', { turns: 30 })
          if (data.how === 'relay') await ask('slow', 'RELAY', { turns: 30 })
          if (data.how === 'fetch') await ask('slow', 'FETCH', { turns: 30 })
          if (data.how === 'all') await Promise.all([ask('slow', 'WAIT', { turns: 30 }), turns(2)])
          if (data.how === 'floating') { void ask('slow', 'WAIT', { turns: 30 }); await turns(40) }
          if (data.how === 'answered') { const outcome = await ask('slow', 'WAIT', { turns: 2 }); saw.push(outcome.ok ? 'answered' : `${outcome.failure.kind}: ${outcome.failure.message}`) }
          // Asked after a wait of its own, outside the step the state was entered in.
          if (data.how === 'late') { await turns(4); await ask('slow', 'WAIT', { turns: 2 }) }
          // Asked with nothing to hear what it says before it answers.
          if (data.how === 'unheard') await ask('slow', 'TALK', {})
          if (data.how === 'tell') tell('slow', { type: 'NOTE' } as never)
          if (data.how === 'talks') await ask('slow', 'TALK_THEN_WAIT', {}, (updates) => { saw.push(...updates.map((update) => `heard ${update}`)) })
          saw.push('ran on after the ask')
        } catch (error) {
          thrown.push(error)
          saw.push(error instanceof Left ? 'unwound with Left' : `unwound with ${String(error)}`)
          throw error
        } finally {
          lock.held = false
          saw.push('finally ran')
        }
        return { at: 'idle' }
      },
      // Given what `run` threw when it is not a `Left`. These checks only ever leave, so it is never called.
      failed: (error) => { saw.push(`failed was given ${String(error)}`); return { at: 'idle' } },
    },
  },
})

const wired = (connected = true, frame?: (run: () => void) => void) => {
  const saw: string[] = []
  const lock = { held: false }
  const traced: string[] = []
  backendSaw.length = 0
  const backendTraced: string[] = []
  const backend = system({ side: 'backend', trace: (line) => { if (/answering/.test(line)) backendTraced.push(line) } })
  backend.start('slow', slow)
  const window = system({ side: 'window', ...(frame ? { frame } : {}), trace: (line) => { if (/left unanswered|failed|DEFECT/.test(line)) traced.push(line) } })
  const link = connected ? connect(window, backend) : undefined
  const handle = window.start('panel', panel(saw, lock))
  return { saw, lock, traced, backendTraced, link, send: (event: PanelEvent): void => window.send(handle, event), at: (): string => window.read(handle).at, stop: (): void => { window.stop(); backend.stop() } }
}

// ── a state's work and an answer that go on after the state was left ───────────────────────────────────────────────

type Lingering = {
  data: { heard: string[] }
  makes: { save: 'one' }
  reports: { type: 'REPORTED' }
  states: { working: {}; idle: {} }
}
type LingerEvent = { type: 'STOP_WORKING' } | { type: 'SELF' } | { type: 'SAVE' }
type LingerAsks = { TALK_LATER: { args: {}; answer: string; progress: string } }
type Lingered = { systems: { slow: { events: never; asks: SlowAsks } }; surfaces: { listener: { events: { type: 'NOTE' } } }; views: {} }
const lingers = reaching<Lingered>()
/** Its work, and its answer to TALK_LATER, wait for the gate, and then say everything there is to say. */
const lingering = (gate: Promise<void>) => lingers<Lingering, LingerEvent, LingerAsks>()({
  data: { heard: [] },
  start: 'working',
  makes: ({ one }) => ({ save: one('slow', 'WAIT', { args: () => ({ turns: 1 }), ended: () => ({ data: (d) => { d.heard.push('saved') } }) }) }),
  on: {
    STOP_WORKING: () => ({ at: 'idle' }),
    SELF: () => ({ data: (d) => { d.heard.push('SELF') } }),
  },
  states: {
    working: {
      on: { SAVE: (_, { make }) => { make('save') } },
      asks: { TALK_LATER: async (_, { progress }) => { await gate; progress('late'); return 'talked' } },
      async run({ send, tell, report, broadcast, make, drop }) {
        await gate
        send({ type: 'SELF' })
        tell('slow', { type: 'NOTE' } as never)
        report({ type: 'REPORTED' })
        broadcast('listener', { type: 'NOTE' })
        make('save')
        drop('save')
      },
      failed: () => {},
    },
    idle: {},
  },
})
type Holder = { data: { reported: number }; starts: { linger: ReturnType<typeof lingering> } }
const holder = (gate: Promise<void>) => lingers<Holder, { type: 'REPORTED'; from: string }>()({
  data: { reported: 0 },
  starts: () => ({ linger: lingering(gate) }),
  on: { REPORTED: (_, { data }) => ({ data: { reported: data.reported + 1 } }) },
})
const listener = (notes: string[]) => lingers<{}, { type: 'NOTE' }>()({ on: { NOTE: () => { notes.push('NOTE') } } })

const lingered = () => {
  let open!: () => void
  const gate = new Promise<void>((resolve) => { open = resolve })
  const ignored: string[] = []
  const notes: string[] = []
  const backend = system({ side: 'backend', trace: (line) => { if (line.includes(' ignored ')) ignored.push(line) } })
  backend.start('slow', slow)
  const parent = backend.start('holder', holder(gate))
  const window = system({ side: 'window' })
  connect(window, backend)
  window.start('listener', listener(notes))
  const child = backend.child(parent, 'linger')
  const read = () => backend.read(child)!
  return { open, ignored, notes, backend, parent, child, read, send: (event: LingerEvent): void => backend.send(child, event) }
}

const lingeringChecks: Array<[string, () => Promise<void>]> = [
  ['work that goes on after its state was left says nothing: it sends, tells, reports, broadcasts and makes nothing', async () => {
    const it = lingered()
    const heard: string[] = []
    const talking = it.backend.ask(it.child, 'TALK_LATER', {}, (updates) => { heard.push(...updates) })
    it.send({ type: 'STOP_WORKING' })
    it.open()
    const talked = await talking
    await rest()
    strictEqual(!talked.ok && talked.failure.kind, 'abandoned')
    deepStrictEqual({ heard: it.read().data.heard, making: it.read().making.save, reported: it.backend.read(it.parent).data.reported, ignored: it.ignored, notes: it.notes, progress: heard },
      { heard: [], making: false, reported: 0, ignored: [], notes: [], progress: [] })
  }],
  ['and it gives up nothing either: what was being made goes on to its end', async () => {
    const it = lingered()
    it.send({ type: 'SAVE' })
    strictEqual(it.read().making.save, true)
    it.send({ type: 'STOP_WORKING' })
    it.open()
    await rest()
    deepStrictEqual(it.read().data.heard, ['saved'])
  }],
]

const checks: Array<[string, () => Promise<void>]> = [
  ['leaving mid-ask unwinds the code that asked: `finally` runs, what it held is let go, and nothing after the ask runs', async () => {
    const it = wired()
    it.send({ type: 'START', how: 'await' })
    await turns(6)
    strictEqual(it.lock.held, true)
    it.send({ type: 'LEAVE' })
    await turns(4)
    deepStrictEqual(it.saw, ['unwound with Left', 'finally ran'])
    strictEqual(it.lock.held, false)
    strictEqual(it.at(), 'idle')
    it.stop()
  }],
  ['the kernel says an ask was left, and does not call the unwinding a failure', async () => {
    const it = wired()
    it.send({ type: 'START', how: 'await' })
    await turns(6)
    it.send({ type: 'LEAVE' })
    await turns(4)
    strictEqual(it.traced.length, 1)
    ok(it.traced[0]!.includes('left unanswered'))
    it.stop()
  }],
  ['an ask combined with other work ends too, and does not hang', async () => {
    const it = wired()
    it.send({ type: 'START', how: 'all' })
    await turns(6)
    it.send({ type: 'LEAVE' })
    await turns(4)
    deepStrictEqual(it.saw, ['unwound with Left', 'finally ran'])
    it.stop()
  }],
  ['the backend is told, and a handler that was itself asking unwinds as well', async () => {
    const it = wired()
    it.send({ type: 'START', how: 'relay' })
    await turns(8)
    it.send({ type: 'LEAVE' })
    await rest()
    ok(backendSaw.includes('RELAY unwound'))
    ok(backendSaw.includes('WAIT told its asker had gone'))
    it.stop()
  }],
  ['a handler that stops because its `signal` aborted has stopped, and is not reported as having failed', async () => {
    const it = wired()
    it.send({ type: 'START', how: 'fetch' })
    await turns(8)
    it.send({ type: 'LEAVE' })
    await rest()
    strictEqual(it.backendTraced.length, 1)
    ok(it.backendTraced[0]!.startsWith('slow stopped answering FETCH'))
    it.stop()
  }],
  ['an ask that was started and never awaited does not take the process down', async () => {
    const it = wired()
    it.send({ type: 'START', how: 'floating' })
    await turns(6)
    it.send({ type: 'LEAVE' })
    await rest()
    // The code went on, since nothing it awaited was the ask. What it returned came after its state was left, and was dropped.
    deepStrictEqual(it.saw, ['ran on after the ask', 'finally ran'])
    strictEqual(it.at(), 'idle')
    it.stop()
  }],
  ['an answer that arrives in time is unaffected', async () => {
    const it = wired()
    it.send({ type: 'START', how: 'await' })
    await rest()
    deepStrictEqual(it.saw, ['ran on after the ask', 'finally ran'])
    strictEqual(it.at(), 'idle')
    it.stop()
  }],
  ['an ask made after a wait, outside the step its state was entered in, crosses and is answered', async () => {
    const it = wired()
    it.send({ type: 'START', how: 'late' })
    await rest()
    deepStrictEqual(it.saw, ['ran on after the ask', 'finally ran'])
    it.stop()
  }],
  ['an ask made after its state was left ends with Left at once, and is never sent', async () => {
    const it = wired()
    it.send({ type: 'START', how: 'late' })
    it.send({ type: 'LEAVE' })
    await rest()
    deepStrictEqual(it.saw, ['unwound with Left', 'finally ran'])
    strictEqual(backendSaw.includes('WAIT began'), false)
    it.stop()
  }],
  ['an ask whose asker leaves in the next turn tells the backend it has gone and unwinds cleanly', async () => {
    const it = wired()
    it.send({ type: 'START', how: 'await' })
    it.send({ type: 'LEAVE' })
    await rest()
    deepStrictEqual(it.saw, ['unwound with Left', 'finally ran'])
    deepStrictEqual(backendSaw, ['WAIT began', 'WAIT told its asker had gone'])
    it.stop()
  }],
  ['what is said before an answer, to an asker with nothing to hear it, is dropped and nothing breaks', async () => {
    const it = wired()
    it.send({ type: 'START', how: 'unheard' })
    await rest()
    deepStrictEqual(it.saw, ['ran on after the ask', 'finally ran'])
    deepStrictEqual(it.traced.filter((line) => line.startsWith('DEFECT')), [])
    it.stop()
  }],
  ['a window with no backend is told so when it asks, and what it tells goes nowhere, which is not a defect', async () => {
    const it = wired(false)
    it.send({ type: 'START', how: 'answered' })
    await rest()
    strictEqual(it.saw.length, 3)
    ok(/^disconnected: .*not connected/i.test(it.saw[0]!), it.saw[0])
    it.send({ type: 'LEAVE' })
    it.send({ type: 'START', how: 'tell' })
    await rest()
    deepStrictEqual(it.traced.filter((line) => line.startsWith('DEFECT')), [])
    it.stop()
  }],
  ['what an ask that was left ends with is a Left, which names the ask', async () => {
    const it = wired()
    thrown.length = 0
    it.send({ type: 'START', how: 'await' })
    await turns(6)
    it.send({ type: 'LEAVE' })
    await rest()
    const [left] = thrown as Error[]
    ok(left instanceof Left)
    strictEqual(left.name, 'Left')
    ok(left.message.includes('WAIT'), left.message)
    it.stop()
  }],
  ['an ask still waiting when the link of its window closes is told the connection closed', async () => {
    const it = wired()
    it.send({ type: 'START', how: 'answered' })
    it.link!.close()
    await rest()
    ok(/^disconnected: .*closed/i.test(it.saw[0] ?? ''), it.saw.join(' / '))
    it.stop()
  }],
  ['what is said before an answer is heard while the answer is still to come, with no frame given', async () => {
    const it = wired()
    it.send({ type: 'START', how: 'talks' })
    for (let turn = 0; turn < 20 && !it.saw.includes('heard one'); turn++) await turns(1)
    deepStrictEqual([it.saw, it.lock.held], [['heard one'], true])
    await rest()
    it.stop()
  }],
  ['what was said to an asker that has gone by the time it would be heard is not heard', async () => {
    const frames: Array<() => void> = []
    const it = wired(true, (run) => { frames.push(run) })
    it.send({ type: 'START', how: 'talks' })
    for (let turn = 0; turn < 20 && frames.length === 0; turn++) await turns(1)
    ok(frames.length > 0, 'nothing waited for a frame')
    it.stop()
    for (const run of frames.splice(0)) run()
    ok(!it.saw.includes('heard one'), it.saw.join(' / '))
  }],
  ['finishing run or an ask cancels unawaited asks without aborting public scope.signal', async () => {
    const publicAborted: string[] = []
    const startedAsks: string[] = []
    const unwoundAsks: string[] = []
    const straySent: string[] = []
    const strayAsks: Array<() => Promise<unknown>> = []
    const straySends: Array<() => void> = []
    type ScAsks = {
      SLOW: { args: { label: string }; answer: string }
      ASYNC_RETURN: { args: {}; answer: string }
      ASYNC_THROW: { args: {}; answer: string }
      SYNC_RETURN: { args: {}; answer: string }
      SYNC_THROW: { args: {}; answer: string }
    }
    type ScNet = { systems: { svc: { events: { type: 'STRAY' }; asks: ScAsks } }; surfaces: {}; views: {} }
    const scState = reaching<ScNet>()
    type ScShape = { states: { idle: {}; asyncReturn: {}; asyncThrow: {}; syncReturn: {}; syncThrow: {} } }
    type ScEvent = { type: 'GO'; at: 'asyncReturn' | 'asyncThrow' | 'syncReturn' | 'syncThrow' } | { type: 'STRAY' }
    const svc = scState<ScShape, ScEvent, ScAsks>()({
      start: 'idle',
      on: {
        GO: ({ at }) => ({ at }),
        STRAY: () => { straySent.push('STRAY') },
      },
      asks: {
        SLOW: async ({ label }, { signal }) => {
          startedAsks.push(label)
          signal.addEventListener('abort', () => { unwoundAsks.push(label) })
          await turns(30)
          return 'late'
        },
        ASYNC_RETURN: async (_, { signal, ask }) => {
          signal.addEventListener('abort', () => publicAborted.push('ask:asyncReturn'))
          void ask('svc', 'SLOW', { label: 'ask:asyncReturn' })
          await turns(1)
          return 'ok'
        },
        ASYNC_THROW: async (_, { signal, ask }) => {
          signal.addEventListener('abort', () => publicAborted.push('ask:asyncThrow'))
          void ask('svc', 'SLOW', { label: 'ask:asyncThrow' })
          await turns(1)
          throw new Error('boom')
        },
        SYNC_RETURN: (_, { signal, ask }) => {
          signal.addEventListener('abort', () => publicAborted.push('ask:syncReturn'))
          void ask('svc', 'SLOW', { label: 'ask:syncReturn' })
          return 'ok'
        },
        SYNC_THROW: (_, { signal, ask, send }) => {
          signal.addEventListener('abort', () => publicAborted.push('ask:syncThrow'))
          straySends.push(() => send({ type: 'STRAY' }))
          strayAsks.push(() => ask('svc', 'SLOW', { label: 'stray:ask:syncThrow' }))
          throw new Error('sync boom')
        },
      },
      states: {
        idle: {},
        asyncReturn: {
          async run({ signal, ask }) {
            signal.addEventListener('abort', () => publicAborted.push('run:asyncReturn'))
            void ask('svc', 'SLOW', { label: 'run:asyncReturn' })
            await turns(1)
          },
          failed: () => {},
        },
        asyncThrow: {
          async run({ signal, ask }) {
            signal.addEventListener('abort', () => publicAborted.push('run:asyncThrow'))
            void ask('svc', 'SLOW', { label: 'run:asyncThrow' })
            await turns(1)
            throw new Error('run boom')
          },
          failed: () => {},
        },
        syncReturn: {
          run({ signal, ask }) {
            signal.addEventListener('abort', () => publicAborted.push('run:syncReturn'))
            void ask('svc', 'SLOW', { label: 'run:syncReturn' })
          },
        },
        syncThrow: {
          run({ signal, ask, send }) {
            signal.addEventListener('abort', () => publicAborted.push('run:syncThrow'))
            straySends.push(() => send({ type: 'STRAY' }))
            strayAsks.push(() => ask('svc', 'SLOW', { label: 'stray:run:syncThrow' }))
            throw new Error('sync run boom')
          },
          failed: () => {},
        },
      },
    })

    const sys = system({ side: 'backend' })
    const h = sys.start('svc', svc)

    deepStrictEqual(await sys.ask(h, 'ASYNC_RETURN', {}), { ok: true, value: 'ok' })
    const r2 = await sys.ask(h, 'ASYNC_THROW', {})
    ok(!r2.ok && r2.failure.kind === 'failed', JSON.stringify(r2))
    deepStrictEqual(await sys.ask(h, 'SYNC_RETURN', {}), { ok: true, value: 'ok' })
    const r4 = await sys.ask(h, 'SYNC_THROW', {})
    ok(!r4.ok && r4.failure.kind === 'failed', JSON.stringify(r4))

    // None of the ask handlers aborted public scope.signal on normal completion or throw.
    deepStrictEqual([...publicAborted], [])

    // Transitioning across run states checks both unawaited ask cancellation and non-aborting public signal on stay.
    for (const at of ['asyncReturn', 'asyncThrow', 'syncReturn', 'syncThrow'] as const) {
      sys.send(h, { type: 'GO', at })
      await rest()
      // Staying in `at` after `run` finishes did NOT abort `at`'s public signal; leaving the previous state did.
      ok(!publicAborted.includes(`run:${at}`), `run:${at} must not abort public scope.signal on completion`)
    }

    // Even while still in `syncThrow`, stray calls saved before throwing are blocked by the private work signal.
    for (const call of straySends) call()
    for (const call of strayAsks) {
      let err: unknown
      try { await call() } catch (e) { err = e }
      ok(err instanceof Left, String(err))
    }
    await rest()
    deepStrictEqual(straySent, [])
    deepStrictEqual(startedAsks, [
      'ask:asyncReturn', 'ask:asyncThrow', 'run:asyncReturn', 'run:asyncThrow',
    ])
    deepStrictEqual(unwoundAsks, [
      'ask:asyncReturn', 'ask:asyncThrow', 'run:asyncReturn', 'run:asyncThrow',
    ])
    strictEqual(sys.idle(), true)
    sys.stop()
    await rest()
  }],
  ['a finished ask or run scope drops any stray progress, send, tell, broadcast or use, while in-flight post-leave use releases immediately', async () => {
    const heard: string[] = []
    const events: string[] = []
    const broadcasts: string[] = []
    const released: string[] = []
    const traced: string[] = []
    let strayAsk!: () => void
    let strayRun!: () => void
    let onUse!: (fn: () => void) => void
    let finishInFlight!: () => void
    let syncLeftFailed = 0
    type StrayAsks = { PING: { args: {}; answer: string; progress: string } }
    type StrayNet = { systems: { svc: { events: { type: 'NOTE' } | { type: 'SAVE_USE' }; asks: StrayAsks } }; surfaces: { panel: { events: { type: 'BCAST' } } }; views: {} }
    const strayState = reaching<StrayNet>()
    const svc = strayState<{}, { type: 'NOTE' } | { type: 'SAVE_USE' }, StrayAsks>()({
      on: {
        NOTE: () => { events.push('NOTE') },
        SAVE_USE: (_, { use }) => { onUse = use },
      },
      run({ send, tell, broadcast, use }) {
        strayRun = () => { send({ type: 'NOTE' }); tell('svc', { type: 'NOTE' }); broadcast('panel', { type: 'BCAST' }); use(() => { released.push('stray-run') }) }
      },
      asks: {
        PING: async (_, { progress, send, tell, broadcast, use }) => {
          progress('live')
          strayAsk = () => { progress('stale'); send({ type: 'NOTE' }); tell('svc', { type: 'NOTE' }); broadcast('panel', { type: 'BCAST' }); use(() => { released.push('stray-ask') }) }
          return 'ok'
        },
      },
    })
    const inFlight = strayState<{}>()({
      async run({ use }) {
        await new Promise<void>((resolve) => { finishInFlight = resolve })
        use(() => { released.push('after-leave') })
        use(() => { throw new Error('late boom') })
      },
      failed: () => {},
    })
    const syncLeft = strayState<{}>()({
      run() { throw new Left('sync-left') },
      failed: () => { syncLeftFailed++ },
    })
    const backend = system({ side: 'backend', trace: (line) => { traced.push(line) } })
    const win = system({ side: 'window' })
    win.start('panel', strayState<{}, { type: 'BCAST' }>()({ on: { BCAST: () => { broadcasts.push('BCAST') } } }))
    connect(win, backend)
    const h = backend.start('svc', svc)
    backend.send(h, { type: 'SAVE_USE' })
    backend.start('syncLeft', syncLeft)
    deepStrictEqual(await backend.ask(h, 'PING', {}, (updates) => heard.push(...updates)), { ok: true, value: 'ok' })
    await rest()
    // Synchronous throw of Left in run() is discarded and never passed to failed().
    strictEqual(syncLeftFailed, 0)
    strayAsk()
    strayRun()
    await rest()
    deepStrictEqual(heard, ['live'])
    deepStrictEqual(events, [])
    deepStrictEqual(broadcasts, [])
    deepStrictEqual([...released], [])

    // Start in-flight async work, then stop the system before it finishes.
    backend.start('inflight', inFlight)
    backend.stop()
    deepStrictEqual([...released], [])

    // Stray use() from already-finished work remains ignored even after the state has left.
    strayAsk()
    strayRun()
    deepStrictEqual([...released], [])

    // In-flight async work (and event-scope use without own) calling use() after its state left runs immediately.
    finishInFlight()
    await rest()
    onUse(() => { released.push('on-after-leave') })
    deepStrictEqual(released, ['after-leave', 'on-after-leave'])
    ok(traced.some((line) => /DEFECT: a release of inflight threw: late boom/.test(line)), traced.join('\n'))
  }],
]

await run([...checks, ...lingeringChecks])
