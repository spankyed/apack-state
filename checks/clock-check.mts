// A system's clock: step-stamped `now` in handlers and logs, live `now` after an `await` in work, and monotonic
// `sleep(ms)` cancelled on leaving or when the work that started it finishes.
//
//   npx vitest run clock
import { deepStrictEqual, ok, strictEqual, throws } from 'node:assert'
import { rest, run, system } from './checks.mts'
import { Left, reaching, type Clock, type StepLog } from '../src/index.ts'
import { explore, onSchedule } from '../src/testing.ts'

const state = reaching()

type ConnEvent = { type: 'CONNECTED' } | { type: 'RETRY' }
type Conn = {
  data: { startedAt: number; timedOutAt: number | null; unwound: number; failed: number }
  states: { connecting: {}; connected: {}; unreachable: {} }
}

const connection = state<Conn, ConnEvent>()({
  data: { startedAt: -1, timedOutAt: null, unwound: 0, failed: 0 },
  start: 'connecting',
  states: {
    connecting: {
      on: { CONNECTED: () => ({ at: 'connected' }) },
      async run(scope) {
        try {
          await scope.sleep(30_000)
        } catch (error) {
          if (error instanceof Left) return
          throw error
        }
        return { at: 'unreachable', data: { timedOutAt: scope.now } }
      },
      failed: () => ({ data: (d) => { d.failed++ } }),
    },
    connected: {},
    unreachable: {
      on: { RETRY: (_, { now }) => ({ at: 'connecting', data: { startedAt: now } }) },
    },
  },
})

/** A manual clock for checking clamping, cancellation, synchronous firing and throws. */
const manualClock = (initial = 1_000) => {
  let time = initial
  const timers: Array<{ at: number; run: () => void; cancelled: boolean }> = []
  let afterCalls = 0
  let cancelCalls = 0
  const clock: Clock = {
    now: () => time,
    after: (ms, run) => {
      afterCalls++
      const entry = { at: time + ms, run, cancelled: false }
      timers.push(entry)
      return () => { cancelCalls++; entry.cancelled = true }
    },
  }
  const advance = (ms: number): void => {
    time += ms
    for (const entry of timers.filter((t) => !t.cancelled && t.at <= time)) {
      entry.cancelled = true
      entry.run()
    }
  }
  const setTime = (next: number): void => { time = next }
  return {
    clock, advance, setTime,
    afterCalls: () => afterCalls,
    cancelCalls: () => cancelCalls,
    pending: () => timers.filter((t) => !t.cancelled).length,
  }
}

await run([
  ['a state waiting with sleep transitions when the delay elapses, and cancels when left early', async () => {
    const manual = manualClock(10_000)
    const logs: StepLog[] = []
    const sys = system({ side: 'window', clock: manual.clock, log: (step) => logs.push(step) })
    const handle = sys.start('conn', connection)
    strictEqual(sys.read(handle).at, 'connecting')
    strictEqual(manual.pending(), 1)
    strictEqual(sys.idle(), false)

    // Leaving before 30s cancels the timer and comes to rest.
    sys.send(handle, { type: 'CONNECTED' })
    await rest()
    strictEqual(sys.read(handle).at, 'connected')
    strictEqual(manual.pending(), 0)
    strictEqual(manual.cancelCalls(), 1)
    strictEqual(sys.idle(), true)

    // Starting fresh and advancing 30s transitions to unreachable.
    const handle2 = sys.start('conn2', connection)
    manual.advance(30_000)
    await rest()
    strictEqual(sys.read(handle2).at, 'unreachable')
    strictEqual(sys.read(handle2).data.timedOutAt, 40_000)
    strictEqual(sys.read(handle2).data.failed, 0)
    strictEqual(logs[0]!.now, 10_000)
    strictEqual(logs.at(-1)!.now, 40_000)
    strictEqual(sys.idle(), true)
  }],

  ['now is stamped once per step for all handlers and sync run, advances across steps, and reads live after await', async () => {
    let ticks = 100
    const ticking: Clock = {
      now: () => ticks++,
      after: (_ms, fn) => {
        const id = queueMicrotask(fn)
        void id
        return () => {}
      },
    }
    const seen: Record<string, number[]> = { on: [], syncRun: [], afterAwait: [], failed: [] }
    type TickShape = { states: { idle: {}; working: {}; done: {} } }
    type TickEvent = { type: 'GO' } | { type: 'INNER' }
    const ticker = state<TickShape, TickEvent>()({
      start: 'idle',
      on: {
        GO: (_, scope) => {
          strictEqual('key' in scope, false)
          seen.on!.push(scope.now)
          scope.send({ type: 'INNER' })
          return { at: 'working' }
        },
        INNER: (_, scope) => { seen.on!.push(scope.now) },
      },
      states: {
        idle: {},
        working: {
          async run(scope) {
            seen.syncRun!.push(scope.now)
            await scope.sleep(10)
            seen.afterAwait!.push(scope.now)
            return { at: 'done' }
          },
          failed: (_, scope) => { seen.failed!.push(scope.now) },
        },
        done: {},
      },
    })

    const logs: StepLog[] = []
    const sys = system({ side: 'backend', clock: ticking, log: (step) => logs.push(step) })
    const h = sys.start('ticker', ticker)
    const startNow = logs[0]!.now!
    strictEqual(startNow, 100)

    sys.send(h, { type: 'GO' })
    await rest()
    strictEqual(sys.read(h).at, 'done')

    // Step 2 (GO + enter working + INNER) stamped once at 101: every sync read in the step saw 101.
    const goStep = logs[1]!
    strictEqual(goStep.now, 101)
    deepStrictEqual(seen.on, [101, 101])
    deepStrictEqual(seen.syncRun, [101])

    // After await, reading scope.now outside any step reads the clock live (102), and the result step stamps 103.
    deepStrictEqual(seen.afterAwait, [102])
    strictEqual(logs[2]!.now, 103)
  }],

  ['now clamps monotonically if the clock moves backwards and refuses non-finite values', async () => {
    const manual = manualClock(5_000)
    const times: number[] = []
    const probe = state<{}, { type: 'PING' }>()({
      on: { PING: (_, { now }) => { times.push(now) } },
    })
    const logs: StepLog[] = []
    const sys = system({ side: 'backend', clock: manual.clock, log: (step) => logs.push(step) })
    const h = sys.start('probe', probe)

    manual.setTime(4_000) // backwards jump
    sys.send(h, { type: 'PING' })
    manual.setTime(6_500)
    sys.send(h, { type: 'PING' })

    deepStrictEqual(times, [5_000, 6_500])
    deepStrictEqual(logs.map((step) => step.now), [5_000, 5_000, 6_500])

    // Non-finite clock time throws RangeError and does not jam stepping.
    manual.setTime(Number.NaN)
    throws(() => sys.send(h, { type: 'PING' }), /non-finite/)
    manual.setTime(7_000)
    sys.send(h, { type: 'PING' })
    strictEqual(times.at(-1), 7_000)
    strictEqual(sys.idle(), true)
  }],

  ['without a clock, normal handlers and logs omit now while reading now or calling sleep refuses loudly', async () => {
    const traces: string[] = []
    const logs: StepLog[] = []
    let sleepError: unknown
    type NoClockShape = { data: { count: number }; states: { idle: {}; sleeping: {} } }
    type NoClockEvent = { type: 'INC' } | { type: 'READ_NOW' } | { type: 'SLEEP' }
    type NoClockAsks = { PING: { args: {}; answer: string }; NOW: { args: {}; answer: number } }
    const noClock = state<NoClockShape, NoClockEvent, NoClockAsks>()({
      data: { count: 0 },
      start: 'idle',
      on: {
        INC: (_, { data }) => ({ data: { count: data.count + 1 } }),
        READ_NOW: (_, scope) => { void scope.now },
        SLEEP: () => ({ at: 'sleeping' }),
      },
      asks: {
        PING: () => 'pong',
        NOW: (_, scope) => scope.now,
      },
      states: {
        idle: {},
        sleeping: {
          async run({ sleep }) { await sleep(10) },
          failed: (error) => { sleepError = error; return { at: 'idle' } },
        },
      },
    })

    const sys = system({ side: 'backend', trace: (line) => traces.push(line), log: (step) => logs.push(step) })
    const h = sys.start('n', noClock)
    sys.send(h, { type: 'INC' })
    strictEqual(sys.read(h).data.count, 1)
    const pong = await sys.ask(h, 'PING', {})
    deepStrictEqual(pong, { ok: true, value: 'pong' })
    ok(logs.every((step) => !('now' in step)), 'StepLog omits now when no clock was given')

    // Reading scope.now in on throws (caught as handler defect).
    sys.send(h, { type: 'READ_NOW' })
    ok(traces.some((line) => /no clock/i.test(line)), traces.join('\n'))

    // Reading scope.now in asks fails with a message naming clock.
    const askNow = await sys.ask(h, 'NOW', {})
    ok(!askNow.ok && /no clock/i.test(askNow.failure.message), JSON.stringify(askNow))

    // Calling scope.sleep in async run rejects and reaches failed.
    sys.send(h, { type: 'SLEEP' })
    await rest()
    ok(sleepError instanceof Error && /no clock/i.test(sleepError.message), String(sleepError))
    strictEqual(sys.read(h).at, 'idle')
    strictEqual(sys.idle(), true)

    // Calling scope.sleep without a clock returns a rejected promise (not a sync throw) and reaches failed.
    sleepError = undefined
    let returnedPromise = false
    const syncNoClock = state<{ states: { checking: {} } }>()({
      start: 'checking',
      states: {
        checking: {
          run({ sleep }) {
            const p = sleep(10)
            returnedPromise = p instanceof Promise
            return p.then(() => undefined)
          },
          failed: (error) => { sleepError = error },
        },
      },
    })
    const syncHandle = sys.start('syncNoClock', syncNoClock)
    strictEqual(returnedPromise, true, 'sleep without a clock must return a rejected promise instead of throwing synchronously')
    await rest()
    ok(sleepError instanceof Error && /no clock/i.test(sleepError.message), String(sleepError))
    sys.stop()
    void syncHandle
  }],

  ['sleep rejects non-finite delays in the kernel before calling clock.after, including on a schedule', async () => {
    const manual = manualClock()
    const badDelays = [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]
    const errors: unknown[] = []
    let syncReturnedPromise = false
    const badSleep = state<{ states: { idle: {}; checking: {} } }, { type: 'TRY'; ms: number }>()({
      start: 'idle',
      on: { TRY: () => ({ at: 'checking' }) },
      states: {
        idle: {},
        checking: {
          run({ sleep }) {
            const p = sleep(currentMs)
            syncReturnedPromise = p instanceof Promise
            return p.then(() => ({ at: 'idle' as const }))
          },
          failed: (error) => { errors.push(error); return { at: 'idle' } },
        },
      },
    })
    let currentMs = Number.NaN
    const sys = system({ side: 'window', clock: manual.clock })
    const h = sys.start('bad', badSleep)
    for (const ms of badDelays) {
      currentMs = ms
      syncReturnedPromise = false
      sys.send(h, { type: 'TRY', ms })
      strictEqual(syncReturnedPromise, true, `sleep(${String(ms)}) must return a rejected promise`)
      await rest()
      strictEqual(sys.read(h).at, 'idle')
      strictEqual(sys.idle(), true)
    }
    strictEqual(manual.afterCalls(), 0, 'non-finite ms must not reach clock.after')
    strictEqual(errors.length, badDelays.length)
    for (let i = 0; i < badDelays.length; i++) {
      const error = errors[i]
      ok(error instanceof RangeError, String(error))
      ok(/finite/i.test(error.message) && error.message.includes(String(badDelays[i])), error.message)
    }

    // The same validation protects onSchedule(schedule).clock so NaN cannot corrupt timer ordering.
    const found = await explore((schedule) => {
      const seen: unknown[] = []
      const onSched = state<{ states: { checking: {}; done: {} } }>()({
        start: 'checking',
        states: {
          checking: {
            async run({ sleep }) { await sleep(Number.NaN) },
            failed: (error) => { seen.push(error); return { at: 'done' } },
          },
          done: {},
        },
      })
      const scheduled = system({ side: 'window', ...onSchedule(schedule, 'scheduled') })
      const handle = scheduled.start('s', onSched)
      return () => {
        strictEqual(scheduled.read(handle).at, 'done')
        strictEqual(seen.length, 1)
        ok(seen[0] instanceof RangeError && /finite/i.test(seen[0].message))
        strictEqual(scheduled.idle(), true)
      }
    })
    strictEqual(found.failure, undefined)
  }],

  ['sleep on an already-aborted scope rejects with Left without calling clock.after', async () => {
    const manual = manualClock()
    const saw: string[] = []
    const preAborted = state<{ states: { working: {}; idle: {} } }, { type: 'LEAVE' }>()({
      start: 'working',
      states: {
        working: {
          on: { LEAVE: () => ({ at: 'idle' }) },
          async run({ sleep }) {
            try {
              await sleep(1_000)
            } catch (error) {
              saw.push(error instanceof Left && error.message === 'sleep was left before it finished' ? 'cancelled Left' : String(error))
              throw error
            } finally {
              try {
                await sleep(500)
                saw.push('finally sleep resolved')
              } catch (error) {
                saw.push(error instanceof Left && error.message === 'sleep was left before it finished' ? 'finally sleep Left' : String(error))
              }
            }
          },
          failed: () => { saw.push('failed') },
        },
        idle: {},
      },
    })

    const sys = system({ side: 'window', clock: manual.clock })
    const h = sys.start('p', preAborted)
    strictEqual(manual.afterCalls(), 1)
    sys.send(h, { type: 'LEAVE' })
    await rest()
    deepStrictEqual(saw, ['cancelled Left', 'finally sleep Left'])
    strictEqual(manual.afterCalls(), 1, 'second sleep did not register a timer on a dead scope')
    strictEqual(sys.idle(), true)
  }],

  ['a synchronous throw from clock.after rejects cleanly with no leaked listener and comes to rest', async () => {
    const badClock: Clock = {
      now: () => 0,
      after: () => { throw new RangeError('delay must be non-negative') },
    }
    let caught: unknown
    const failing = state<{ states: { waiting: {}; done: {} } }>()({
      start: 'waiting',
      states: {
        waiting: {
          async run({ sleep }) { await sleep(-1) },
          failed: (error) => { caught = error; return { at: 'done' } },
        },
        done: {},
      },
    })

    const sys = system({ side: 'window', clock: badClock })
    const h = sys.start('f', failing)
    await rest()
    ok(caught instanceof RangeError && /non-negative/.test(caught.message))
    strictEqual(sys.read(h).at, 'done')
    strictEqual(sys.idle(), true)
  }],

  ['a throwing cancel callback from clock.after still unwinds sleep with Left and comes to rest', async () => {
    const traces: string[] = []
    const saw: string[] = []
    const throwingCancel: Clock = {
      now: () => 0,
      after: () => () => { throw new Error('cancel broke') },
    }
    const cancellable = state<{ states: { waiting: {}; done: {} } }, { type: 'LEAVE' }>()({
      start: 'waiting',
      states: {
        waiting: {
          on: { LEAVE: () => ({ at: 'done' }) },
          async run({ sleep }) {
            try { await sleep(1_000) } catch (error) {
              saw.push(error instanceof Left && error.message.includes('sleep') ? 'Left' : String(error))
              throw error
            }
          },
          failed: () => { saw.push('failed') },
        },
        done: {},
      },
    })
    const sys = system({ side: 'window', clock: throwingCancel, trace: (line) => traces.push(line) })
    const h = sys.start('c', cancellable)
    sys.send(h, { type: 'LEAVE' })
    await rest()
    deepStrictEqual(saw, ['Left'])
    ok(traces.some((line) => /DEFECT: cancelling a sleep threw: cancel broke/.test(line)), traces.join('\n'))
    strictEqual(sys.idle(), true)
  }],

  ['synchronous clock.after firing inline and normal completion both remove abort listeners cleanly', async () => {
    let syncCancelCalls = 0
    const syncClock: Clock = {
      now: () => 0,
      after: (_ms, fn) => {
        fn()
        return () => { syncCancelCalls++ }
      },
    }
    const syncWait = state<{ states: { waiting: {}; done: {} } }, { type: 'LEAVE' }>()({
      start: 'waiting',
      states: {
        waiting: {
          on: { LEAVE: () => ({ at: 'done' }) },
          async run({ sleep }) { await sleep(0) },
          failed: () => {},
        },
        done: {},
      },
    })
    const sys1 = system({ side: 'window', clock: syncClock })
    const h1 = sys1.start('s', syncWait)
    await rest()
    sys1.send(h1, { type: 'LEAVE' })
    await rest()
    strictEqual(syncCancelCalls, 0, 'leaving after inline fire must not invoke cancel')
    strictEqual(sys1.idle(), true)

    // Async timer completing normally also removes the abort listener so leaving later does not invoke cancel.
    const manual = manualClock()
    const sys2 = system({ side: 'window', clock: manual.clock })
    const h2 = sys2.start('m', syncWait)
    manual.advance(10)
    await rest()
    sys2.send(h2, { type: 'LEAVE' })
    await rest()
    strictEqual(manual.cancelCalls(), 0, 'leaving after normal completion must not invoke cancel')
    strictEqual(sys2.idle(), true)
  }],

  ['unawaited sleep is cancelled when run or an ask handler finishes by returning or throwing', async () => {
    const manual = manualClock()
    type UnawaitedAsks = {
      ASYNC_RETURN: { args: {}; answer: string }
      ASYNC_THROW: { args: {}; answer: string }
      SYNC_RETURN: { args: {}; answer: string }
      SYNC_THROW: { args: {}; answer: string }
      WAIT_AND_CANCEL: { args: {}; answer: string }
    }
    type UnawaitedShape = { states: { idle: {}; asyncReturn: {}; asyncThrow: {}; syncReturn: {}; syncThrow: {} } }
    type UnawaitedEvent = { type: 'GO'; at: 'asyncReturn' | 'asyncThrow' | 'syncReturn' | 'syncThrow' }
    const unawaited = state<UnawaitedShape, UnawaitedEvent, UnawaitedAsks>()({
      start: 'idle',
      on: { GO: ({ at }) => ({ at }) },
      asks: {
        ASYNC_RETURN: async (_, { sleep }) => { void sleep(30_000); await Promise.resolve(); return 'ok' },
        ASYNC_THROW: async (_, { sleep }) => { void sleep(30_000); await Promise.resolve(); throw new Error('boom') },
        SYNC_RETURN: (_, { sleep }) => { void sleep(30_000); return 'ok' },
        SYNC_THROW: (_, { sleep }) => { void sleep(30_000); throw new Error('sync boom') },
        WAIT_AND_CANCEL: async (_, { sleep }) => { await sleep(30_000); return 'late' },
      },
      states: {
        idle: {},
        asyncReturn: {
          async run({ sleep }) { void sleep(30_000); await Promise.resolve() },
          failed: () => {},
        },
        asyncThrow: {
          async run({ sleep }) { void sleep(30_000); await Promise.resolve(); throw new Error('run fail') },
          failed: () => ({ at: 'idle' }),
        },
        syncReturn: {
          run({ sleep }) { void sleep(30_000) },
        },
        syncThrow: {
          run({ sleep }) { void sleep(30_000); throw new Error('sync run fail') },
          failed: () => ({ at: 'idle' }),
        },
      },
    })

    const sys = system({ side: 'backend', clock: manual.clock })
    const h = sys.start('u', unawaited)

    // 1. async ask return
    deepStrictEqual(await sys.ask(h, 'ASYNC_RETURN', {}), { ok: true, value: 'ok' })
    await rest()
    strictEqual(manual.pending(), 0)

    // 2. async ask throw stays classified as 'failed' (not 'abandoned') and cancels sleep
    const r2 = await sys.ask(h, 'ASYNC_THROW', {})
    ok(!r2.ok && r2.failure.kind === 'failed' && /boom/.test(r2.failure.message), JSON.stringify(r2))
    await rest()
    strictEqual(manual.pending(), 0)

    // 3. sync ask return
    deepStrictEqual(await sys.ask(h, 'SYNC_RETURN', {}), { ok: true, value: 'ok' })
    await rest()
    strictEqual(manual.pending(), 0)

    // 4. sync ask throw stays classified as 'failed' and cancels sleep
    const r4 = await sys.ask(h, 'SYNC_THROW', {})
    ok(!r4.ok && r4.failure.kind === 'failed' && /sync boom/.test(r4.failure.message), JSON.stringify(r4))
    await rest()
    strictEqual(manual.pending(), 0)

    // 5-8. run returning/throwing (async and sync)
    for (const at of ['asyncReturn', 'asyncThrow', 'syncReturn', 'syncThrow'] as const) {
      sys.send(h, { type: 'GO', at })
      await rest()
      strictEqual(manual.pending(), 0, `${at} left a pending timer`)
      strictEqual(sys.idle(), true, `${at} did not come to rest`)
    }

    // 9. asker leaving cancels sleep inside an asks handler
    type CallerNet = { systems: { u: { events: never; asks: UnawaitedAsks } }; surfaces: {}; views: {} }
    const callerState = reaching<CallerNet>()<{ states: { asking: {}; done: {} } }, { type: 'LEAVE' }>()({
      start: 'asking',
      states: {
        asking: {
          on: { LEAVE: () => ({ at: 'done' }) },
          async run({ ask }) { await ask('u', 'WAIT_AND_CANCEL', {}) },
          failed: () => {},
        },
        done: {},
      },
    })
    const caller = sys.start('caller', callerState)
    strictEqual(manual.pending(), 1)
    sys.send(caller, { type: 'LEAVE' })
    await rest()
    strictEqual(manual.pending(), 0, 'asker leaving must cancel ask handler sleep')
    strictEqual(sys.idle(), true)
  }],
], async (tally) => {
  await tally.every('sleep racing a leaving event under every ordering leaves no timer and ends in either state', () =>
    explore((schedule) => {
      const unwound: boolean[] = []
      const failed: unknown[] = []
      const raced = state<{ states: { connecting: {}; connected: {}; unreachable: {} } }, { type: 'CONNECTED' }>()({
        start: 'connecting',
        states: {
          connecting: {
            on: { CONNECTED: () => ({ at: 'connected' }) },
            async run({ sleep }) {
              try {
                await sleep(30_000)
              } catch (error) {
                if (error instanceof Left) { unwound.push(true); throw error }
                throw error
              }
              return { at: 'unreachable' }
            },
            failed: (error) => { failed.push(error) },
          },
          connected: {},
          unreachable: {},
        },
      })
      const sys = system({ side: 'window', ...onSchedule(schedule, 'the window') })
      const handle = sys.start('conn', raced)
      schedule.does('the network', ['CONNECTED', () => sys.send(handle, { type: 'CONNECTED' })])
      return () => {
        deepStrictEqual(failed, [])
        strictEqual(sys.idle(), true)
        const at = sys.read(handle).at
        ok(at === 'connected' || at === 'unreachable', `unexpected state ${at}`)
        if (at === 'connected') deepStrictEqual(unwound, [true])
        else deepStrictEqual(unwound, [])
      }
    }))
})
