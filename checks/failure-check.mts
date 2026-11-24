// What happens when code that is not the kernel's throws. A state's work that fails goes where the state says. A
// handler that throws changes nothing. And none of it stops the kernel, which goes on taking what comes next.
//
//   npx vitest run failure
import { deepStrictEqual, ok, strictEqual, throws } from 'node:assert'
import { connect, rest, run, system } from './checks.mts'
import { system as unlimited } from '../src/index.ts'
import { given, reaching } from '../src/index.ts'
import { nextTurn } from '../src/turn.ts'

type SlowAsks = { WAIT: { args: { turns: number }; answer: string }; BREAK: { args: {}; answer: string } }
type App = { systems: { slow: { events: never; asks: SlowAsks } }; surfaces: {}; views: { threads: { detail: { args: { id: string }; result: string } } } }
export const state = reaching<App>()

const turns = (count: number): Promise<void> => new Promise((resolve) => { let left = count; const tick = (): void => { if (left-- <= 0) resolve(); else nextTurn(tick) }; tick() })

const slow = state<{}, never, SlowAsks>()({
  asks: {
    WAIT: async ({ turns: count }) => { await turns(count); return 'done' },
    BREAK: async () => { await turns(2); throw new Error('the answer broke') },
  },
})

type How = 'later' | 'at once' | 'while asking' | 'in failed too' | 'not at all'
export type PanelEvent =
  | { type: 'START'; how: How }
  | { type: 'SET_UP' }
  | { type: 'LEAVE' }
  | { type: 'COUNT' }
  | { type: 'BREAK' }
  | { type: 'SPIN' }
export type Panel = {
  data: { count: number; problem: string | null }
  states: {
    idle: {}
    working: { data: { how: How } }
    /** Its work only sets things up, and so it need not say where it goes. */
    ready: {}
  }
}

const panel = (released: string[]) => state<Panel, PanelEvent>()({
  data: { count: 0, problem: null },
  start: 'idle',
  on: {
    START: ({ how }) => ({ at: 'working', data: { how, problem: null } }),
    SET_UP: () => ({ at: 'ready' }),
    LEAVE: () => ({ at: 'idle' }),
    COUNT: (_, { data }) => ({ data: { count: data.count + 1 } }),
    // Tells itself to count, and then throws: it is not made, so it has told itself nothing.
    BREAK: (_, { send }) => { send({ type: 'COUNT' }); throw new Error('the handler broke') },
    // Counts, and tells itself to do it again, without end.
    SPIN: (_, { data, send }) => { send({ type: 'SPIN' }); return { data: { count: data.count + 1 } } },
  },
  states: {
    idle: {},
    working: {
      data: { how: given },
      run({ data, ask, use }) {
        use(() => { released.push('first') })
        use(() => { throw new Error('the release broke') })
        use(() => { released.push('last') })
        if (data.how === 'at once') throw new Error('broke at once')
        return (async () => {
          if (data.how === 'while asking') await ask('slow', 'WAIT', { turns: 30 })
          await turns(4)
          if (data.how !== 'not at all') throw new Error(`broke ${data.how}`)
          return { at: 'idle' as const }
        })()
      },
      failed: (error, { data }) => {
        if (data.how === 'in failed too') throw new Error('failed broke as well')
        return { at: 'idle', data: { problem: error instanceof Error ? error.message : String(error) } }
      },
    },
    ready: {
      run() { throw new Error('could not set up') },
    },
  },
})

const wired = () => {
  const released: string[] = []
  const traced: string[] = []
  const backendTraced: string[] = []
  const backend = system({ side: 'backend', trace: (line) => { if (/failed|DEFECT/.test(line)) backendTraced.push(line) } })
  const theSlow = backend.start('slow', slow)
  const window = system({ side: 'window', trace: (line) => { if (/failed|DEFECT/.test(line)) traced.push(line) } })
  connect(window, backend)
  const handle = window.start('panel', panel(released))
  const value = () => window.read(handle)
  return { released, traced, backendTraced, askBreak: () => backend.ask(theSlow, 'BREAK', {}), send: (event: PanelEvent): void => window.send(handle, event), at: (): string => value().at, problem: (): string | null => value().data.problem, count: (): number => value().data.count, stop: (): void => { window.stop(); backend.stop() } }
}

// ── a state whose declarations throw until it has an id ─────────────────────────────────────────────────────────────

const helper = state<{ data: { title: string } }, never>()({ data: { title: given } })
type Odd = {
  data: { count: number; id: string | null; waited: string | null }
  starts: { helper: typeof helper }
  makes: { save: 'one' }
}
type OddEvent = { type: 'THROWS_A_STRING' } | { type: 'SET'; id: string } | { type: 'SAVE' }
type OddAsks = { THROWS: { args: {}; answer: string } }
const noId = (id: string | null): string => { if (id === null) throw new Error('no id yet'); return id }
const oddState = state<Odd, OddEvent, OddAsks>()({
  data: { count: 0, id: null, waited: null },
  starts: (start) => ({ helper: start(helper, { given: () => { throw new Error('no title yet') } }) }),
  follows: (follow) => ({ detail: follow('threads', 'detail', { from: ['id'], args: ({ id }) => ({ id: noId(id) }), heard: () => {} }) }),
  awaits: (asking) => ({ wait: asking('slow', 'WAIT', { from: ['id'], args: ({ id }) => ({ turns: noId(id).length }), ended: (outcome) => ({ data: { waited: outcome.ok ? outcome.value : null } }) }) }),
  makes: ({ one }) => ({ save: one('slow', 'WAIT', { args: (data) => ({ turns: noId(data.id).length }), ended: () => {} }) }),
  on: {
    THROWS_A_STRING: () => ({ data: (d) => { d.count++; throw 'not an error' } }),
    SET: ({ id }) => ({ data: { id } }),
    SAVE: (_, { make }) => { make('save') },
  },
  asks: { THROWS: () => { throw 'not an error' } },
})
const brokenAtOnce = state<{ data: { n: number } }, never>()({ data: { n: 0 }, run() { throw new Error('could not start') } })

const odd = () => {
  const defects: string[] = []
  const followed: object[] = []
  const sys = system({ side: 'backend', views: (_, __, args) => { followed.push(args); return () => {} }, trace: (line) => { if (line.startsWith('DEFECT')) defects.push(line) } })
  sys.start('slow', slow)
  const handle = sys.start('odd', oddState)
  return { sys, handle, defects, followed, send: (event: OddEvent): void => sys.send(handle, event), now: () => sys.read(handle) }
}

const checks: Array<[string, () => Promise<void>]> = [
  ['work that fails later goes where the state says, with what it threw', async () => {
    const it = wired()
    it.send({ type: 'START', how: 'later' })
    strictEqual(it.at(), 'working')
    await rest()
    strictEqual(it.at(), 'idle')
    strictEqual(it.problem(), 'broke later')
    it.stop()
  }],
  ['work that fails at once goes there too, in the step that entered it', async () => {
    const it = wired()
    it.send({ type: 'START', how: 'at once' })
    strictEqual(it.at(), 'idle')
    strictEqual(it.problem(), 'broke at once')
    it.stop()
  }],
  ['work that succeeds never reaches `failed`', async () => {
    const it = wired()
    it.send({ type: 'START', how: 'not at all' })
    await rest()
    strictEqual(it.at(), 'idle')
    strictEqual(it.problem(), null)
    deepStrictEqual(it.traced.filter((line) => !line.includes('release')), [])
    it.stop()
  }],
  ['a state left while it was asking has not failed: `failed` is not called', async () => {
    const it = wired()
    it.send({ type: 'START', how: 'while asking' })
    await turns(6)
    it.send({ type: 'LEAVE' })
    await rest()
    strictEqual(it.at(), 'idle')
    strictEqual(it.problem(), null)
    deepStrictEqual(it.traced.filter((line) => line.includes('failed')), [])
    it.stop()
  }],
  ['work that fails after its state was left changes nothing, and is reported', async () => {
    const it = wired()
    it.send({ type: 'START', how: 'later' })
    it.send({ type: 'LEAVE' })
    await rest()
    strictEqual(it.problem(), null)
    ok(it.traced.some((line) => line.includes('failed after it was left: broke later')))
    it.stop()
  }],
  ['a handler that throws changes nothing, and the next event is handled', async () => {
    const it = wired()
    it.send({ type: 'COUNT' })
    it.send({ type: 'BREAK' })
    strictEqual(it.at(), 'idle')
    ok(it.traced.some((line) => line.includes('threw handling BREAK')))
    it.send({ type: 'COUNT' })
    // Two counts of its own. The one the broken handler sent itself before it threw was never sent.
    strictEqual(it.count(), 2)
    it.stop()
  }],
  ['a `failed` that throws is reported, and the state takes events as before', async () => {
    const it = wired()
    it.send({ type: 'START', how: 'in failed too' })
    await rest()
    strictEqual(it.at(), 'working')
    ok(it.traced.some((line) => line.includes("failed threw: failed broke as well")))
    it.send({ type: 'LEAVE' })
    strictEqual(it.at(), 'idle')
    it.stop()
  }],
  ['work that only sets up may say nowhere to go: what it throws is reported and the state stays', async () => {
    const it = wired()
    it.send({ type: 'SET_UP' })
    strictEqual(it.at(), 'ready')
    ok(it.traced.some((line) => line.includes('panel in ready failed: could not set up')))
    it.send({ type: 'LEAVE' })
    strictEqual(it.at(), 'idle')
    it.stop()
  }],
  ['an ask whose handler throws is answered `failed`, and where it threw is reported there', async () => {
    const it = wired()
    const outcome = await it.askBreak()
    deepStrictEqual(outcome, { ok: false, failure: { kind: 'failed', message: 'the answer broke' } })
    deepStrictEqual(it.backendTraced, ['slow failed answering BREAK: the answer broke'])
    it.stop()
  }],
  ['a state that tells itself without end is cut short and reported, and takes events afterwards', async () => {
    const it = wired()
    it.send({ type: 'SPIN' })
    ok(it.traced.some((line) => line.includes('a step was cut short after 10000 things, at panel')))
    const spun = it.count()
    ok(spun >= 10_000, `it counted ${spun}`)
    it.send({ type: 'COUNT' })
    strictEqual(it.count(), spun + 1)
    it.stop()
  }],
  ['a system given a limit takes no more steps after it, and says so once', async () => {
    const traced: string[] = []
    const sys = unlimited({ side: 'backend', limit: 5, trace: (line) => { if (line.startsWith('DEFECT')) traced.push(line) } })
    const it = sys.start('panel', panel([]))
    for (let sent = 0; sent < 20; sent++) sys.send(it, { type: 'COUNT' })
    // Starting it was a step, so four of the twenty were taken.
    strictEqual(sys.read(it).data.count, 4)
    // An ask after it is not left waiting: it is told why it will not be taken.
    const asked = await sys.ask(it as never, 'ANYTHING', {}) as { ok: false; failure: { kind: string; message: string } }
    ok(asked.failure.kind === 'unavailable' && /every step it is allowed/.test(asked.failure.message), JSON.stringify(asked))
    deepStrictEqual(traced, ['DEFECT: backend took 5 steps and takes no more: something leads to something else without end'])
  }],
  ['a release that throws does not keep the others from running', async () => {
    const it = wired()
    it.send({ type: 'START', how: 'not at all' })
    it.send({ type: 'LEAVE' })
    deepStrictEqual(it.released, ['last', 'first'])
    ok(it.traced.some((line) => line.includes('the release broke')))
    it.stop()
  }],

  ['a definition whose declarations throw fails where it is started, and the system goes on as it was', async () => {
    const defects: string[] = []
    const sys = system({ side: 'backend', trace: (line) => { if (line.startsWith('DEFECT')) defects.push(line) } })
    // What the types would not let through: its `starts` throws as it is read.
    const declaredBadly = { def: { data: { n: 0 }, starts: () => { throw new Error('declared badly') } } }
    throws(() => sys.start('bad', declaredBadly as never), /declared badly/)
    const fine = sys.start('fine', brokenAtOnce)
    strictEqual(sys.read(fine).data.n, 0)
    deepStrictEqual(defects.filter((line) => !line.includes('nowhere to go')), [])
  }],
  // ── what code a state declares throws, and what is thrown that is not an Error ──────────────────────────────────

  ['an edit that throws what is not an Error is reported with what it threw, and changes nothing', async () => {
    const it = odd()
    const before = it.defects.length
    it.send({ type: 'THROWS_A_STRING' })
    deepStrictEqual([it.now().data.count, it.defects.slice(before)], [0, ['DEFECT: odd: not an error']])
  }],
  ['an ask whose handler throws what is not an Error fails, saying what it threw', async () => {
    const it = odd()
    deepStrictEqual(await it.sys.ask(it.handle, 'THROWS', {}), { ok: false, failure: { kind: 'failed', message: 'not an error' } })
  }],
  ['work that fails in a state that says nowhere to go is reported, naming the state, and the state stays as it is', async () => {
    const defects: string[] = []
    const sys = system({ side: 'backend', trace: (line) => { if (line.startsWith('DEFECT')) defects.push(line) } })
    const handle = sys.start('broken', brokenAtOnce)
    deepStrictEqual(sys.read(handle), { data: { n: 0 } })
    ok(defects.some((line) => line.startsWith('DEFECT: broken says nowhere to go')), defects.join(' / '))
  }],
  ['what a state cannot say to give a state it starts is reported, and that one is not started', async () => {
    const it = odd()
    ok(it.defects.some((line) => line.includes('could not say what to give') && line.includes('no title yet')), it.defects.join(' / '))
    strictEqual('odd/helper' in it.sys.snapshot(), false)
  }],
  ['what a state cannot say to ask a view, a read or a make for is reported, and nothing is asked until it can', async () => {
    const it = odd()
    deepStrictEqual(it.followed, [])
    ok(it.defects.some((line) => line.includes('could not say what to ask detail for: no id yet')), it.defects.join(' / '))
    ok(it.defects.some((line) => line.includes('could not say what to ask wait for: no id yet')), it.defects.join(' / '))
    it.send({ type: 'SAVE' })
    ok(it.defects.some((line) => line.includes('could not say what to ask save for: no id yet')), it.defects.join(' / '))
    strictEqual(it.now().making.save, false)
    it.send({ type: 'SET', id: 'a' })
    deepStrictEqual(it.followed, [{ id: 'a' }])
    await rest()
    strictEqual(it.now().data.waited, 'done')
  }],
]

await run(checks)
