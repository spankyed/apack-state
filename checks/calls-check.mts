// The asks a state calls. These are writes: one is fired once, because a handler called `call`. Nothing in the data
// stands for it, so nothing in the data has to be taken out when it finishes. Which are pending is the kernel's to
// keep, and is read beside the data.
//
//   npx vitest run calls
import { deepStrictEqual, ok, strictEqual } from 'node:assert'
import { effect } from '@vue/reactivity'
import { connect, rest, run, system } from './checks.mts'
import { mirror } from '../src/mirror.ts'
import { commit, git, type CommitEvent } from '../examples/commit.mts'
import { explore, sample, type Schedule } from '@apackdev/orderings'
import { forNet } from '../src/index.ts'
import { nextTurn } from '../src/turn.ts'

const turns = (count: number): Promise<void> => new Promise((resolve) => { let left = count; const tick = (): void => { if (left-- <= 0) resolve(); else nextTurn(tick) }; tick() })

type WorkerAsks = {
  /** Runs a job. The one called `flaky` is refused the first time it is run. */
  RUN: { args: { id: string }; progress: string; answer: string; refuses: 'busy' }
  /** Saves what it is given, and answers with what it saved. */
  SAVE: { args: { text: string }; answer: string }
}
type App = { systems: { worker: { events: never; asks: WorkerAsks } }; surfaces: {}; views: {} }
export const state = forNet<App>()

/** What the worker was asked and what it was told to give up, in order. */
const worker = (did: string[]) => {
  const tried = new Set<string>()
  return state<{}, never, WorkerAsks>()({
    answers: {
      RUN: async ({ id }, { progress, refuse, signal }) => {
        did.push(`run ${id}`)
        signal.addEventListener('abort', () => { did.push(`gave up ${id}`) })
        progress(`${id} began`)
        await turns(3)
        if (id === 'flaky' && !tried.has(id)) { tried.add(id); throw refuse('busy', 'Not this time') }
        progress(`${id} ended`)
        return `${id} done`
      },
      SAVE: async ({ text }, { signal }) => {
        did.push(`save ${text}`)
        signal.addEventListener('abort', () => { did.push(`gave up saving ${text}`) })
        await turns(3)
        return text
      },
    },
  })
}

export type JobsEvent =
  | { type: 'ADD'; id: string }
  | { type: 'DROP'; id: string }
  | { type: 'TYPE'; text: string }
  | { type: 'SAVE' }
  | { type: 'TYPE_AND_SAVE'; text: string }
  | { type: 'STOP_SAVING' }
  | { type: 'BREAK'; id: string }
  | { type: 'TURN'; on: boolean }
export type Jobs = {
  data: { text: string; saved: string | null; done: string[]; heard: string[]; tries: Record<string, number>; problem: string | null }
  states: {
    on: { calls: { run: 'each'; save: 'one' } }
    off: {}
  }
}

const jobs = state<Jobs, JobsEvent>()({
  data: { text: '', saved: null, done: [], heard: [], tries: {}, problem: null },
  initial: 'on',

  on: {
    TYPE: ({ text }) => ({ data: { text } }),
    TURN: ({ on }) => ({ at: on ? 'on' : 'off' }),
  },

  states: {
    on: {
      calls: ({ one, each }) => ({
        run: each('worker', 'RUN', {
          args: (id) => ({ id }),
          progress: (updates) => ({ data: (d) => { d.heard.push(updates.join('+')) } }),
          done: (outcome, { key, data, call }) => {
            if (outcome.ok) return { data: (d) => { d.done.push(outcome.value) } }
            // Refused as busy, it is called again, once.
            const tries = (data.tries[key] ?? 0) + 1
            if (outcome.failure.kind === 'busy' && tries < 2) { call('run', key); return { data: (d) => { d.tries[key] = tries } } }
            return { data: { problem: `${key}: ${outcome.failure.message}` } }
          },
        }),

        // What it saves is the text as it is when the save is called.
        save: one('worker', 'SAVE', {
          args: (data) => ({ text: data.text }),
          done: (outcome) => (outcome.ok ? { data: { saved: outcome.value } } : { data: { problem: outcome.failure.message } }),
        }),
      }),

      on: {
        ADD: ({ id }, { call }) => { call('run', id) },
        DROP: ({ id }, { cancel }) => { cancel('run', id) },
        SAVE: (_, { call }) => { call('save') },
        // The text is changed and saved in one handler: what is saved is the text it was changed to.
        TYPE_AND_SAVE: ({ text }, { call }) => { call('save'); return { data: { text } } },
        STOP_SAVING: (_, { cancel }) => { cancel('save') },
        // Calls one, and then throws.
        BREAK: ({ id }, { call }) => { call('run', id); throw new Error('the handler broke') },
      },
    },
    off: {},
  },
})

const wired = () => {
  const did: string[] = []
  const defects: string[] = []
  const sys = system({ side: 'backend', trace: (line) => { if (line.startsWith('DEFECT')) defects.push(line) } })
  sys.start('worker', worker(did))
  const it = sys.start('jobs', jobs)
  const steps: Array<{ pending: boolean; moved: boolean; data: boolean }> = []
  sys.subscribe((_, fields, changes) => { const mine = changes.jobs; if (mine) steps.push({ pending: mine.pending, moved: mine.moved, data: (fields.jobs ?? []).length > 0 }) })
  return { sys, it, did, defects, steps, send: (event: JobsEvent): void => sys.send(it, event), now: () => sys.read(it).data, pending: () => sys.read(it).pending }
}

const checks: Array<[string, () => Promise<void>]> = [
  ['one is called for each key it is told to, and is pending for that key until it finishes', async () => {
    const { send, now, pending, did } = wired()
    send({ type: 'ADD', id: 'a' })
    send({ type: 'ADD', id: 'b' })
    deepStrictEqual(pending(), { run: { a: true, b: true }, save: false })
    await rest()
    deepStrictEqual(pending(), { run: {}, save: false })
    deepStrictEqual({ done: [...now().done].sort(), did }, { done: ['a done', 'b done'], did: ['run a', 'run b'] })
  }],
  ['a reader of whether one is pending runs for that one, and not for another or for the data', async () => {
    const { sys, it, send } = wired()
    const held = mirror(sys, it)
    const runs = { a: 0, b: 0, save: 0, done: 0 }
    effect(() => { runs.a++; void held.value.pending.run.a })
    effect(() => { runs.b++; void held.value.pending.run.b })
    effect(() => { runs.save++; void held.value.pending.save })
    effect(() => { runs.done++; void held.value.data.done })
    const since = { ...runs }
    const ran = (): string[] => { const names = (Object.keys(runs) as Array<keyof typeof runs>).filter((name) => runs[name] !== since[name]); Object.assign(since, runs); return names }
    send({ type: 'ADD', id: 'a' })
    deepStrictEqual(ran(), ['a'])
    strictEqual(held.value.pending.run.a, true)
    send({ type: 'SAVE' })
    deepStrictEqual(ran(), ['save'])
    send({ type: 'ADD', id: 'b' })
    deepStrictEqual(ran(), ['b'])
    await rest()
    // Each finished: its reader ran again, and so did the reader of what the runs left in the data.
    deepStrictEqual(ran(), ['a', 'b', 'save', 'done'])
    strictEqual(held.value.pending.run.a, undefined)
    held.stop()
  }],
  ['what is pending is not data: calling one changes none of it', async () => {
    const { send, now, steps } = wired()
    const before = now()
    steps.length = 0
    send({ type: 'ADD', id: 'a' })
    deepStrictEqual(steps, [{ pending: true, moved: false, data: false }])
    deepStrictEqual(now(), before)
    await rest()
  }],
  ['one that is pending is the same one: it is not called twice', async () => {
    const { send, did } = wired()
    send({ type: 'ADD', id: 'a' })
    send({ type: 'ADD', id: 'a' })
    send({ type: 'SAVE' })
    send({ type: 'SAVE' })
    await rest()
    deepStrictEqual(did.sort(), ['run a', 'save '])
  }],
  ['once it has finished it can be called again', async () => {
    const { send, did } = wired()
    send({ type: 'ADD', id: 'a' })
    await rest()
    send({ type: 'ADD', id: 'a' })
    await rest()
    deepStrictEqual(did, ['run a', 'run a'])
  }],
  ['cancelling one tells the one answering, and done is not called', async () => {
    const { send, now, pending, did } = wired()
    send({ type: 'ADD', id: 'a' })
    await turns(1)
    send({ type: 'DROP', id: 'a' })
    deepStrictEqual(pending().run, {})
    await rest()
    deepStrictEqual(did, ['run a', 'gave up a'])
    deepStrictEqual({ done: now().done, problem: now().problem }, { done: [], problem: null })
  }],
  ['done may call it again', async () => {
    const { send, now, pending, did } = wired()
    send({ type: 'ADD', id: 'flaky' })
    await rest()
    deepStrictEqual(did.filter((line) => line.startsWith('run')), ['run flaky', 'run flaky'])
    deepStrictEqual({ done: now().done, pending: pending().run, problem: now().problem }, { done: ['flaky done'], pending: {}, problem: null })
  }],
  ['what one says before it finishes is delivered to progress, as a list', async () => {
    const { send, now } = wired()
    send({ type: 'ADD', id: 'a' })
    await rest()
    deepStrictEqual(now().heard, ['a began', 'a ended'])
  }],
  ['it is called when the step commits, with the data as the handler left it', async () => {
    const { send, now, did } = wired()
    send({ type: 'TYPE', text: 'before' })
    send({ type: 'TYPE_AND_SAVE', text: 'after' })
    await rest()
    deepStrictEqual({ did, saved: now().saved }, { did: ['save after'], saved: 'after' })
  }],
  ['one at a time is pending or it is not', async () => {
    const { send, pending, did } = wired()
    send({ type: 'SAVE' })
    strictEqual(pending().save, true)
    send({ type: 'STOP_SAVING' })
    strictEqual(pending().save, false)
    await rest()
    deepStrictEqual(did, ['save ', 'gave up saving '])
  }],
  ['leaving the state cancels what it had pending, and entering it again calls nothing', async () => {
    const { send, now, pending, did, steps } = wired()
    send({ type: 'ADD', id: 'a' })
    await turns(1)
    steps.length = 0
    send({ type: 'TURN', on: false })
    deepStrictEqual(pending(), { run: {}, save: false })
    // Whoever reads what is pending is told that it changed.
    deepStrictEqual(steps.map((step) => step.pending), [true])
    send({ type: 'TURN', on: true })
    await rest()
    // A write was called once. It is not called again by the state being the case again, as a load would be.
    deepStrictEqual({ did, done: now().done }, { did: ['run a', 'gave up a'], done: [] })
  }],
  ['a handler that throws has said nothing: what it called is not called', async () => {
    const { send, now, pending, did, defects } = wired()
    send({ type: 'BREAK', id: 'a' })
    await rest()
    strictEqual(defects.length, 1)
    deepStrictEqual({ did, done: now().done, pending: pending() }, { did: [], done: [], pending: { run: {}, save: false } })
  }],
]

// ── the commit surface's writes, under every ordering ───────────────────────────────────────────────────────────────

const repository = (schedule: Schedule) => {
  const backend = system({ side: 'backend', later: schedule.later })
  const code = backend.start('code', git((what) => schedule.work(what, null)))
  const window = system({ side: 'window', later: schedule.later })
  connect(window, backend, schedule)
  const surface = window.start('commit', commit)
  return { send: (event: CommitEvent): void => window.send(surface, event), now: () => window.read(surface).data, pending: () => window.read(surface).pending, held: () => backend.read(code).data }
}
const staging = (schedule: Schedule): (() => void) => {
  const it = repository(schedule)
  schedule.does('the user', ['stages a', () => it.send({ type: 'commit.STAGE_FILE', path: 'a.ts' })], ['stages b', () => it.send({ type: 'commit.STAGE_FILE', path: 'b.ts' })])
  return () => {
    deepStrictEqual([...it.held().staged].sort(), ['a.ts', 'b.ts'])
    deepStrictEqual({ pending: it.pending(), error: it.now().gitError }, { pending: { stage: {}, unstage: {}, push: false }, error: null })
    // What is shown is what the repository holds: the last read was made after the last write.
    deepStrictEqual({ ...it.now().gitStatus, staged: [...it.now().gitStatus!.staged].sort() }, { staged: ['a.ts', 'b.ts'], unstaged: ['c.ts'], ahead: 2 })
  }
}
const pushing = (schedule: Schedule): (() => void) => {
  const it = repository(schedule)
  schedule.does('the user', ['pushes', () => it.send({ type: 'commit.PUSH_BRANCH' })], ['stops', () => it.send({ type: 'commit.STOP_PUSH' })])
  return () => {
    deepStrictEqual({ push: it.pending().push, phase: it.now().pushPhase, error: it.now().gitError }, { push: false, phase: null, error: null })
    // It was either pushed or it was not: nothing in between is shown.
    strictEqual(it.now().gitStatus?.ahead, it.held().ahead)
  }
}

await run(checks, async (tally) => {
  await tally.every('two files staged at once are both staged, nothing is left under way, and the status shown is the last', () => sample(staging, { seed: 1, runs: 3_000 }), 'sampled')
  await tally.every('a push stopped at any moment leaves no push under way and reports no failure', () => sample(pushing, { seed: 1, runs: 3_000 }), 'sampled')
  void explore
  void ok
})
