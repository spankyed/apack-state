// The asks a state calls. These are writes: one is fired once, because a handler called `call`. Nothing in the data
// stands for it, so nothing in the data has to be taken out when it finishes. Which are pending is the kernel's to
// keep, and is read beside the data.
//
//   npx vitest run calls
import { deepStrictEqual, ok, strictEqual, throws } from 'node:assert'
import { effect } from '@vue/reactivity'
import { connect, rest, run, system } from './checks.mts'
import { mirror } from '../src/mirror.ts'
import { commit, git, type CommitEvent } from '../examples/commit.mts'
import { explore, sample, type Schedule } from '@apackdev/orderings'
import { forNet, type StepLog } from '../src/index.ts'
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
    on: { calls: { run: 'each'; save: 'single' } }
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
      calls: ({ single, each }) => ({
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
        save: single('worker', 'SAVE', {
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
  ['typed calls (one, each, many): frozen scope.input, optional args, unkeyed concurrent pending count, cancel-all, mirror reactivity, and StepLog privacy', async () => {
    type SvcAsks = {
      PING: { args: {}; answer: string }
      COMMIT: { args: { message: string; amend?: boolean }; progress: string; answer: string }
      HUNK: { args: { path: string; hunk: number }; progress: string; answer: string }
      UPLOAD: { args: { file: string }; progress: string; answer: string }
    }
    type SvcNet = { systems: { svc: { events: never; asks: SvcAsks } }; surfaces: {}; views: {} }
    const svcState = forNet<SvcNet>()

    const gated = new Map<string, () => void>()
    const started: string[] = []
    const aborted: string[] = []
    const svc = svcState<{}, never, SvcAsks>()({
      answers: {
        PING: async () => { started.push('ping'); await turns(1); return 'pong' },
        COMMIT: async ({ message, amend }, { progress, signal }) => {
          const tag = `commit:${message}:${Boolean(amend)}`
          started.push(tag)
          progress('preparing')
          await new Promise<void>((resolve) => {
            gated.set(tag, resolve)
            signal.addEventListener('abort', () => { aborted.push(tag); resolve() }, { once: true })
          })
          return `committed:${message}`
        },
        HUNK: async ({ path, hunk }, { progress, signal }) => {
          const tag = `hunk:${path}#${hunk}`
          started.push(tag)
          progress(`staging-${hunk}`)
          await new Promise<void>((resolve) => {
            gated.set(tag, resolve)
            signal.addEventListener('abort', () => { aborted.push(tag); resolve() }, { once: true })
          })
          return `staged:${path}#${hunk}`
        },
        UPLOAD: async ({ file }, { progress, signal }) => {
          const tag = `upload:${file}`
          started.push(tag)
          progress(`uploading:${file}`)
          await new Promise<void>((resolve) => {
            gated.set(tag, resolve)
            signal.addEventListener('abort', () => { aborted.push(tag); resolve() }, { once: true })
          })
          return `uploaded:${file}`
        },
      },
    })

    type PanelShape = {
      data: { prefix: string; log: string[]; frozenInput: boolean[] }
      states: {
        on: {
          calls: {
            ping: 'single'
            pingMany: 'many'
            bareEach: 'each'
            commit: { single: { message: string; amend?: boolean } }
            hunk: { each: { hunk: number } }
            upload: { many: { file: string } }
            uploadMapped: { many: { name: string } }
          }
        }
        off: {}
      }
    }
    type PanelEvent =
      | { type: 'PING' }
      | { type: 'PING_MANY' }
      | { type: 'BARE_EACH'; key: string }
      | { type: 'COMMIT'; message: string; amend?: boolean }
      | { type: 'HUNK'; path: string; hunk: number }
      | { type: 'UPLOAD'; file: string }
      | { type: 'UPLOAD_MAPPED'; name: string }
      | { type: 'CANCEL_UPLOADS' }
      | { type: 'LEAVE' }

    const panel = svcState<PanelShape, PanelEvent>()({
      data: { prefix: 'v1/', log: [], frozenInput: [] },
      initial: 'on',
      states: {
        on: {
          calls: ({ single, each, many }) => ({
            // Omitted args for asks accepting `{}`
            ping: single('svc', 'PING', {
              done: (o) => (o.ok ? { data: (d) => { d.log.push(`ping:${o.value}`) } } : undefined),
            }),
            pingMany: many('svc', 'PING', {
              done: (o) => (o.ok ? { data: (d) => { d.log.push(`pingMany:${o.value}`) } } : undefined),
            }),
            // Bare `each` reading `(key, data)` as its 2 arguments (no `input`)
            bareEach: each('svc', 'UPLOAD', {
              args: (key, data) => ({ file: `${data.prefix}${key}` }),
              done: (o, { key }) => (o.ok ? { data: (d) => { d.log.push(`bare:${key}:${o.value}`) } } : undefined),
            }),
            // Direct input pass-through (args omitted) + frozen scope.input in progress & done
            commit: single('svc', 'COMMIT', {
              progress: (u, { input }) => ({
                data: (d) => {
                  d.log.push(`commit-p:${input.message}:${u.join(',')}`)
                  d.frozenInput.push(Object.isFrozen(input))
                },
              }),
              done: (o, { input }) => (o.ok
                ? { data: (d) => { d.log.push(`commit-d:${input.message}:${o.value}`); d.frozenInput.push(Object.isFrozen(input)) } }
                : undefined),
            }),
            // Keyed `each` with typed input + key & frozen input on progress & done
            hunk: each('svc', 'HUNK', {
              args: (path, input) => ({ path, hunk: input.hunk }),
              progress: (u, { key, input }) => ({
                data: (d) => {
                  d.log.push(`hunk-p:${key}#${input.hunk}:${u.join(',')}`)
                  d.frozenInput.push(Object.isFrozen(input))
                },
              }),
              done: (o, { key, input }) => (o.ok
                ? { data: (d) => { d.log.push(`hunk-d:${key}#${input.hunk}:${o.value}`) } }
                : undefined),
            }),
            // Unkeyed concurrent `many` with direct pass-through (args omitted)
            upload: many('svc', 'UPLOAD', {
              progress: (u, { input }) => ({
                data: (d) => {
                  d.log.push(`upload-p:${input.file}:${u.join(',')}`)
                  d.frozenInput.push(Object.isFrozen(input))
                },
              }),
              done: (o, { input }) => (o.ok
                ? { data: (d) => { d.log.push(`upload-d:${input.file}:${o.value}`) } }
                : undefined),
            }),
            // Unkeyed concurrent `many` with mapped args(input, data)
            uploadMapped: many('svc', 'UPLOAD', {
              args: (input, data) => ({ file: `${data.prefix}${input.name}` }),
              done: (o, { input }) => (o.ok
                ? { data: (d) => { d.log.push(`mapped-d:${input.name}:${o.value}`) } }
                : undefined),
            }),
          }),
          on: {
            PING: (_, { call }) => { call('ping') },
            PING_MANY: (_, { call }) => { call('pingMany') },
            BARE_EACH: ({ key }, { call }) => { call('bareEach', key) },
            COMMIT: ({ message, amend }, { call }) => { call('commit', { message, amend }) },
            HUNK: ({ path, hunk }, { call }) => { call('hunk', path, { hunk }) },
            UPLOAD: ({ file }, { call }) => { call('upload', { file }) },
            UPLOAD_MAPPED: ({ name }, { call }) => { call('uploadMapped', { name }) },
            CANCEL_UPLOADS: (_, { cancel }) => { cancel('upload') },
            LEAVE: () => ({ at: 'off' }),
          },
        },
        off: {},
      },
    })

    const logs: StepLog[] = []
    const defects: string[] = []
    const sys = system({ side: 'backend', log: (step) => logs.push(step), onDefect: (d) => defects.push(d.message) })
    sys.start('svc', svc)
    const h = sys.start('panel', panel)
    const held = mirror(sys, h)

    // Initial pending values: boolean for one, {} for each, 0 for many.
    deepStrictEqual(sys.read(h).pending, { ping: false, pingMany: 0, bareEach: {}, commit: false, hunk: {}, upload: 0, uploadMapped: 0 })

    // Reactive mirror tracks `pending.upload` (number) independently of `pending.commit` (boolean).
    const seen = { upload: 0, commit: 0 }
    effect(() => { seen.upload++; void held.value.pending.upload })
    effect(() => { seen.commit++; void held.value.pending.commit })
    const baseline = { ...seen }

    // 1. Omitted args (`single` and `many` for `{}` asks) and bare `each` with `(key, data)`
    sys.send(h, { type: 'PING' })
    sys.send(h, { type: 'PING_MANY' })
    sys.send(h, { type: 'PING_MANY' })
    sys.send(h, { type: 'BARE_EACH', key: 'k.txt' })
    strictEqual(sys.read(h).pending.ping, true)
    strictEqual(sys.read(h).pending.pingMany, 2)
    deepStrictEqual(sys.read(h).pending.bareEach, { 'k.txt': true })
    await turns(2)
    gated.get('upload:v1/k.txt')!()
    await rest()
    strictEqual(sys.read(h).pending.ping, false)
    strictEqual(sys.read(h).pending.pingMany, 0)
    deepStrictEqual(sys.read(h).pending.bareEach, {})
    deepStrictEqual(sys.read(h).data.log.filter((l) => l.startsWith('ping')).sort(), ['ping:pong', 'pingMany:pong', 'pingMany:pong'])
    ok(sys.read(h).data.log.includes('bare:k.txt:uploaded:v1/k.txt'))

    // 2. Typed `single` with direct pass-through + dedup + frozen input
    const SECRET = 'SECRET_PAYLOAD_NEVER_IN_LOG'
    sys.send(h, { type: 'COMMIT', message: SECRET, amend: true })
    sys.send(h, { type: 'COMMIT', message: 'second-deduped' })
    strictEqual(held.value.pending.commit, true)
    strictEqual(seen.commit, baseline.commit + 1)
    strictEqual(seen.upload, baseline.upload)
    await turns(2)
    gated.get(`commit:${SECRET}:true`)!()
    await rest()
    strictEqual(held.value.pending.commit, false)
    ok(sys.read(h).data.log.includes(`commit-p:${SECRET}:preparing`))
    ok(sys.read(h).data.log.includes(`commit-d:${SECRET}:committed:${SECRET}`))

    // 3. Typed `each` with key + input
    sys.send(h, { type: 'HUNK', path: 'a.ts', hunk: 2 })
    sys.send(h, { type: 'HUNK', path: 'a.ts', hunk: 99 }) // deduped for key 'a.ts'
    deepStrictEqual(sys.read(h).pending.hunk, { 'a.ts': true })
    await turns(2)
    gated.get('hunk:a.ts#2')!()
    await rest()
    deepStrictEqual(sys.read(h).pending.hunk, {})
    ok(sys.read(h).data.log.includes('hunk-p:a.ts#2:staging-2'))
    ok(sys.read(h).data.log.includes('hunk-d:a.ts#2:staged:a.ts#2'))

    // 4. Typed `many` concurrent: NOT deduped, count increments/decrements, each gets its own input
    sys.send(h, { type: 'UPLOAD', file: 'one.png' })
    strictEqual(held.value.pending.upload, 1)
    sys.send(h, { type: 'UPLOAD', file: 'two.png' })
    strictEqual(held.value.pending.upload, 2)
    sys.send(h, { type: 'UPLOAD_MAPPED', name: 'doc.md' })
    strictEqual(sys.read(h).pending.uploadMapped, 1)
    await turns(2)
    gated.get('upload:one.png')!()
    await turns(3)
    strictEqual(held.value.pending.upload, 1)
    gated.get('upload:two.png')!()
    gated.get('upload:v1/doc.md')!()
    await rest()
    strictEqual(held.value.pending.upload, 0)
    strictEqual(sys.read(h).pending.uploadMapped, 0)
    ok(sys.read(h).data.log.includes('upload-d:one.png:uploaded:one.png'))
    ok(sys.read(h).data.log.includes('upload-d:two.png:uploaded:two.png'))
    ok(sys.read(h).data.log.includes('mapped-d:doc.md:uploaded:v1/doc.md'))

    // Every scope.input delivered was deeply frozen.
    ok(sys.read(h).data.frozenInput.length >= 4 && sys.read(h).data.frozenInput.every(Boolean))

    // 5. `cancel('upload')` cancels ALL in-flight `many` calls (without cancelling other calls), and cancelling when 0 does not emit a change.
    let notified = 0
    const stopSub = sys.subscribe(() => { notified++ })
    sys.send(h, { type: 'CANCEL_UPLOADS' })
    strictEqual(notified, 0)
    strictEqual(sys.read(h).pending.upload, 0)
    stopSub()
    sys.send(h, { type: 'UPLOAD', file: 'c1.png' })
    sys.send(h, { type: 'UPLOAD', file: 'c2.png' })
    sys.send(h, { type: 'UPLOAD_MAPPED', name: 'keep.md' })
    strictEqual(sys.read(h).pending.upload, 2)
    strictEqual(sys.read(h).pending.uploadMapped, 1)
    await turns(1)
    sys.send(h, { type: 'CANCEL_UPLOADS' })
    strictEqual(sys.read(h).pending.upload, 0)
    strictEqual(sys.read(h).pending.uploadMapped, 1)
    gated.get('upload:v1/keep.md')!()
    await rest()
    deepStrictEqual(aborted.sort(), ['upload:c1.png', 'upload:c2.png'])
    ok(!sys.read(h).data.log.some((l) => l.includes('upload-d:c1.png') || l.includes('upload-d:c2.png')))
    ok(sys.read(h).data.log.includes('mapped-d:keep.md:uploaded:v1/keep.md'))

    // 6. Throwing in call `progress` and `done` reports descriptive defects.
    const badCall = svcState<{ calls: { boom: { single: { file: string } } } }, { type: 'GO' }>()({
      calls: ({ single }) => ({
        boom: single('svc', 'UPLOAD', {
          progress: () => { throw new Error('bad-progress') },
          done: () => { throw new Error('bad-done') },
        }),
      }),
      on: { GO: (_, { call }) => { call('boom', { file: 'boom.png' }) } },
    })
    const bh = sys.start('badCall', badCall)
    sys.send(bh, { type: 'GO' })
    await turns(2)
    gated.get('upload:boom.png')!()
    await rest()
    ok(defects.some((m) => m.includes('badCall threw in boom progress') && m.includes('bad-progress')), defects.join(' | '))
    ok(defects.some((m) => m.includes('badCall threw in boom done') && m.includes('bad-done')), defects.join(' | '))

    // 6. Leaving the state cancels all in-flight `many` calls and resets count to 0.
    sys.send(h, { type: 'UPLOAD', file: 'leave.png' })
    strictEqual(sys.read(h).pending.upload, 1)
    await turns(1)
    sys.send(h, { type: 'LEAVE' })
    strictEqual(sys.read(h).pending.upload, 0)
    await rest()
    ok(aborted.includes('upload:leave.png'))

    // 7. StepLog never leaks `input` payloads and never leaks synthetic counter keys for `many`.
    strictEqual(JSON.stringify(logs).includes(SECRET), false)
    const uploadCalls = logs.flatMap((s) => s.handled).filter((e) => e.kind === 'call' && e.name === 'upload')
    ok(uploadCalls.length >= 2 && uploadCalls.every((e) => e.key === undefined))

    held.stop()
    sys.stop()
  }],

  ['conflicting call kinds across states fail fast on start, matching kinds succeed, and untyped each calls without a string key report a defect', async () => {
    const sys = system({ side: 'backend' })

    // Same kind across sibling states is allowed and runs normally.
    const sameKind = state<{ states: { a: { calls: { save: 'single' } }; b: { calls: { save: 'single' } } } }>()({
      initial: 'a',
      states: {
        a: { calls: ({ single }) => ({ save: single('worker', 'SAVE', { args: () => ({ text: 'a' }), done: () => {} }) }) },
        b: { calls: ({ single }) => ({ save: single('worker', 'SAVE', { args: () => ({ text: 'b' }), done: () => {} }) }) },
      },
    })
    const okHandle = sys.start('same-kind', sameKind)
    deepStrictEqual(sys.read(okHandle).pending, { save: false })

    // Conflicting kinds across nested states fail fast at start() before anything runs.
    const conflicting = {
      def: {
        initial: 'a',
        states: {
          a: { calls: ({ single }: { single: Function }) => ({ save: single('worker', 'SAVE', { args: () => ({ text: '' }), done: () => {} }) }) },
          outer: {
            initial: 'inner',
            states: {
              inner: { calls: ({ each }: { each: Function }) => ({ save: each('worker', 'RUN', { args: (id: string) => ({ id }), done: () => {} }) }) },
            },
          },
        },
      },
    }
    throws(
      () => sys.start('bad-calls', conflicting as never),
      { message: 'bad-calls declares call save with conflicting kinds (single and each)' },
    )

    const directShadow = {
      def: {
        initial: 'a',
        calls: ({ single }: { single: Function }) => ({ save: single('worker', 'SAVE', { args: () => ({ text: '' }), done: () => {} }) }),
        states: {
          a: { calls: ({ single }: { single: Function }) => ({ save: single('worker', 'SAVE', { args: () => ({ text: '' }), done: () => {} }) }) },
        },
      },
    }
    throws(
      () => sys.start('direct-call', directShadow as never),
      { message: 'direct-call declares call save again at a, shadowing an enclosing state' },
    )
    strictEqual('direct-call' in sys.snapshot(), false)

    const deepShadow = {
      def: {
        initial: 'mid',
        calls: ({ single }: { single: Function }) => ({ save: single('worker', 'SAVE', { args: () => ({ text: '' }), done: () => {} }) }),
        states: {
          mid: {
            initial: 'leaf',
            states: {
              leaf: { calls: ({ single }: { single: Function }) => ({ save: single('worker', 'SAVE', { args: () => ({ text: '' }), done: () => {} }) }) },
            },
          },
        },
      },
    }
    throws(
      () => sys.start('deep-call', deepShadow as never),
      { message: 'deep-call declares call save again at mid.leaf, shadowing an enclosing state' },
    )
    strictEqual('deep-call' in sys.snapshot(), false)

    const midShadow = {
      def: {
        initial: 'mid',
        states: {
          mid: {
            initial: 'leaf',
            calls: ({ single }: { single: Function }) => ({ save: single('worker', 'SAVE', { args: () => ({ text: '' }), done: () => {} }) }),
            states: {
              leaf: { calls: ({ single }: { single: Function }) => ({ save: single('worker', 'SAVE', { args: () => ({ text: '' }), done: () => {} }) }) },
            },
          },
        },
      },
    }
    throws(
      () => sys.start('mid-call', midShadow as never),
      { message: 'mid-call declares call save again at mid.leaf, shadowing an enclosing state' },
    )

    // `calls` (`pending`) and `arms` (`armed`) are separate namespaces, so a child timer may share an enclosing call's name.
    const crossNamespace = state<{ calls: { save: 'single' }; states: { a: { arms: { save: 'single' } } } }>()({
      calls: ({ single }) => ({ save: single('worker', 'SAVE', { args: () => ({ text: '' }), done: () => {} }) }),
      initial: 'a',
      states: { a: { arms: ({ single }) => ({ save: single({ after: 100 }) }) } },
    })
    const crossHandle = sys.start('cross', crossNamespace)
    deepStrictEqual(sys.read(crossHandle).pending, { save: false })
    deepStrictEqual(sys.read(crossHandle).armed, { save: false })

    // Untyped call on an `each` entry without a string key reports a defect and does not corrupt `pending`.
    const defects: Array<{ message: string; ref?: string }> = []
    const guarded = system({ side: 'backend', onDefect: (d) => defects.push({ message: d.message, ref: d.ref }) })
    const did: string[] = []
    guarded.start('worker', worker(did))
    const m = state<{ calls: { run: 'each' } }, { type: 'MISSING' } | { type: 'NUM' }>()({
      calls: ({ each }) => ({ run: each('worker', 'RUN', { args: (id) => ({ id }), done: () => {} }) }),
      on: {
        MISSING: (_, { call }) => { (call as (n: string) => void)('run') },
        NUM: (_, { call }) => { (call as (n: string, k: unknown) => void)('run', 42) },
      },
    })
    const mh = guarded.start('m', m)
    guarded.send(mh, { type: 'MISSING' })
    guarded.send(mh, { type: 'NUM' })
    deepStrictEqual(defects, [
      { message: 'm cannot call run without a string key', ref: 'm' },
      { message: 'm cannot call run without a string key', ref: 'm' },
    ])
    deepStrictEqual(guarded.read(mh).pending, { run: {} })
    deepStrictEqual(did, [])
    guarded.stop()
    sys.stop()
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
    deepStrictEqual({ pending: it.pending(), error: it.now().gitError }, { pending: { stage: {}, unstage: {}, revert: 0, push: false }, error: null })
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
