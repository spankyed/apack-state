// What a pack's checks are written with (`@apackdev/state/testing`): every ordering, a clock the schedule moves, a
// system on a schedule, and scenarios made from the events a state declares.
import { deepStrictEqual, ok, rejects, strictEqual, throws } from 'node:assert'
import { run } from './checks.mts'
import { given, forNet } from '../src/index.ts'

/** What seed 7 draws: four events of one type, each handed `int(1000)`. */
const DRAWS_FROM_SEVEN = ['ADD 61', 'ADD 699', 'ADD 405', 'ADD 239']
import { connect, defectGuard, everyOrder, explore, fromEvents, onSchedule, replay, waitFor, type Scenario } from '../src/testing.ts'
import { system, type Defect } from '../src/kernel.ts'

const state = forNet()
type CounterEvent = { type: 'ADD'; by: number } | { type: 'RESET' }
const counter = state<{ data: { count: number; resets: number } }, CounterEvent>()({
  data: { count: 0, resets: 0 },
  on: {
    ADD: ({ by }, { data }) => ({ data: { count: data.count + by } }),
    RESET: (_, { data }) => ({ data: { count: 0, resets: data.resets + 1 } }),
  },
})

/** What makers were handed and sent, run by run, for a state that takes these events. */
const drawn = async (types: readonly string[], seed: number, runs = 1): Promise<string[]> => {
  const seen: string[] = []
  const shape = state<{}, { type: string }>()({ on: Object.fromEntries(types.map((type) => [type, () => {}])) as never })
  await fromEvents({
    state: shape,
    events: Object.fromEntries(types.map((type) => [type, (random: { int(below: number): number }) => { seen.push(`${type} ${random.int(1000)}`); return { type } }])) as never,
    always: () => {},
    steps: 4,
    runs,
    seed,
  })
  return seen
}

/** Two lanes of two steps each, and what they ran, in order. */
const twoByTwo = (ran: string[][]): Scenario => (schedule) => {
  const order: string[] = []
  schedule.does('x', ['1', () => { order.push('x1') }], ['2', () => { order.push('x2') }])
  schedule.does('y', ['1', () => { order.push('y1') }], ['2', () => { order.push('y2') }])
  return () => { ran.push(order) }
}

await run([
  ['every ordering is run once, each lane in its own order', async () => {
    const ran: string[][] = []
    strictEqual(await everyOrder(twoByTwo(ran)), 6)
    strictEqual(new Set(ran.map((order) => order.join(' '))).size, 6)
    for (const order of ran) ok(order.indexOf('x1') < order.indexOf('x2') && order.indexOf('y1') < order.indexOf('y2'))
  }],
  ['an ordering that fails is named, with what was run and the choices that run it again', async () => {
    const failing: Scenario = (schedule) => {
      const order: string[] = []
      schedule.does('x', ['1', () => { order.push('x1') }])
      schedule.does('y', ['1', () => { order.push('y1') }])
      return () => { if (order[0] === 'y1') throw new Error('y went first') }
    }
    const error = await everyOrder(failing).then(() => undefined, (thrown: unknown) => thrown as Error)
    ok(error instanceof Error)
    ok(/replay with \[1\]/.test(error.message) && /y: 1\n {2}x: 1/.test(error.message) && /y went first/.test(error.message), error.message)
    const again = await replay(failing, [1])
    strictEqual(String(again.error), 'Error: y went first')
  }],
  ['more orderings than it may run is said, and not passed', async () => {
    await rejects(everyOrder(twoByTwo([]), { limit: 3 }), /too many to run them all/)
  }],
  ['the clock moves only as its timers fire, sooner ones first, to the time each was set for', async () => {
    const heard: Array<[string, number]> = []
    await everyOrder((schedule) => {
      const { clock } = schedule
      clock.after(30, () => heard.push(['thirty', clock.now()]))
      clock.after(10, () => heard.push(['ten', clock.now()]))
      clock.after(10, () => heard.push(['ten, set second', clock.now()]))
      const cancelled = clock.after(20, () => heard.push(['cancelled', clock.now()]))
      cancelled()
      return () => { strictEqual(clock.now(), 30) }
    })
    deepStrictEqual(heard, [['ten', 10], ['ten, set second', 10], ['thirty', 30]])
  }],
  ['a timer firing falls in every place among what else there is, and nothing waits for the time it is', async () => {
    const seen = new Set<string>()
    const orderings = await everyOrder((schedule) => {
      const order: string[] = []
      schedule.does('the user', ['clicks', () => { order.push('click') }], ['clicks again', () => { order.push('click') }])
      void schedule.clock.sleep(60_000).then(() => { order.push('an hour later') })
      return () => { seen.add(order.join(', ')) }
    })
    strictEqual(orderings, 3)
    deepStrictEqual([...seen].sort(), ['an hour later, click, click', 'click, an hour later, click', 'click, click, an hour later'])
  }],
  ['a system on a schedule has what it puts off run in the schedule\'s order', async () => {
    const counts = new Set<number>()
    const orderings = await everyOrder((schedule) => {
      const sys = system({ side: 'window', ...onSchedule(schedule) })
      const handle = sys.start('counter', counter)
      schedule.does('one user', ['adds', () => sys.send(handle, { type: 'ADD', by: 1 })])
      schedule.does('another', ['resets', () => sys.send(handle, { type: 'RESET' })])
      return () => { counts.add(sys.read(handle).data.count); sys.stop() }
    })
    ok(orderings >= 2)
    deepStrictEqual([...counts].sort(), [0, 1])
  }],
  ['a system\'s frames, like what it puts off, are run when the schedule chooses, in every place among the rest', async () => {
    const seen = new Set<string>()
    const orderings = await everyOrder((schedule) => {
      const order: string[] = []
      const { frame } = onSchedule(schedule, 'the window')
      frame(() => { order.push('frame') })
      ok(order.length === 0, 'a frame ran as it was asked for')
      schedule.does('the user', ['clicks', () => { order.push('click') }])
      return () => { seen.add(order.join(', ')) }
    })
    strictEqual(orderings, 2)
    deepStrictEqual([...seen].sort(), ['click, frame', 'frame, click'])
  }],
  ['scenarios made from the events a state declares send each of them, and hold what is said to always hold', async () => {
    const types = new Set<string>()
    await fromEvents({
      state: counter,
      events: { ADD: (random) => ({ type: 'ADD', by: 1 + random.int(3) }), RESET: () => ({ type: 'RESET' }) },
      always: (value, sent) => {
        for (const event of sent) types.add(event.type)
        const { count } = (value as { data: { count: number } }).data
        ok(count >= 0, `the count went below nothing: ${count}`)
      },
      steps: 12,
      runs: 20,
      seed: 7,
    })
    deepStrictEqual([...types].sort(), ['ADD', 'RESET'])
  }],
  ['one that fails names its seed and the events it sent, and the same seed fails the same way', async () => {
    const failing = () => fromEvents({
      state: counter,
      events: { ADD: (random) => ({ type: 'ADD', by: 1 + random.int(3) }), RESET: () => ({ type: 'RESET' }) },
      always: (value) => { ok((value as { data: { count: number } }).data.count < 5, 'the count reached five') },
      steps: 12,
      runs: 20,
      seed: 7,
    })
    const first = await failing().then(() => undefined, (thrown: unknown) => (thrown as Error).message)
    ok(first !== undefined && /^Run \d+, from seed \d+, failed after sending (ADD|RESET)(, (ADD|RESET))*:\n.*the count reached five/s.test(first), first)
    strictEqual(await failing().then(() => undefined, (thrown: unknown) => (thrown as Error).message), first)
  }],
  ['a declared event with no way to make it is refused, naming it', async () => {
    await rejects(fromEvents({
      state: counter,
      events: { ADD: () => ({ type: 'ADD', by: 1 }) } as never,
      always: () => {},
      steps: 1,
      runs: 1,
      seed: 1,
    }), /No way to make RESET/)
  }],
  ['an event a state inside declares needs a way to make it too', async () => {
    type DoorEvent = { type: 'OPEN' } | { type: 'KNOCK' }
    const door = state<{ states: { shut: {}; open: {} } }, DoorEvent>()({
      initial: 'shut',
      states: { shut: { on: { OPEN: () => ({ at: 'open' }) } }, open: { on: { KNOCK: () => {} } } },
    })
    await rejects(fromEvents({ state: door, events: { OPEN: () => ({ type: 'OPEN' }) } as never, always: () => {}, steps: 1, runs: 1, seed: 1 }), /No way to make KNOCK/)
  }],
  ['a seed draws the same numbers wherever it is run, another seed others, and they fall all over what is asked for', async () => {
    // These are the draws: a run made again from its seed has to be the run it was, on any machine, in any version.
    deepStrictEqual(await drawn(['ADD'], 7), DRAWS_FROM_SEVEN)
    ok(JSON.stringify(await drawn(['ADD'], 8)) !== JSON.stringify(DRAWS_FROM_SEVEN))
    const ints = new Set<number>()
    await fromEvents({ state: counter, events: { ADD: (random) => { ints.add(random.int(3)); return { type: 'ADD', by: 1 } }, RESET: () => ({ type: 'RESET' }) }, always: () => {}, steps: 30, runs: 2, seed: 1 })
    deepStrictEqual([...ints].sort(), [0, 1, 2])
  }],
  ['a seed sends the same events whatever order a state declares them in', async () => {
    deepStrictEqual(await drawn(['A', 'B', 'C'], 3, 3), await drawn(['C', 'A', 'B'], 3, 3))
  }],
  ['each run is one more from the seed, and as many are run as asked', async () => {
    let runs = 0
    await fromEvents({ state: counter, events: { ADD: () => ({ type: 'ADD', by: 1 }), RESET: () => ({ type: 'RESET' }) }, around: () => { runs++ }, always: () => {}, steps: 1, runs: 4, seed: 1 })
    strictEqual(runs, 4)
    // A run that fails names itself and its seed: run n is from the seed plus n less one.
    const error = await fromEvents({
      state: counter,
      events: { ADD: () => ({ type: 'ADD', by: 1 }), RESET: () => ({ type: 'RESET' }) },
      always: (value) => { ok((value as { data: { count: number } }).data.count < 3, 'three') },
      steps: 3, runs: 50, seed: 40,
    }).then(() => undefined, (thrown: unknown) => thrown as Error)
    const [, run, seed] = /^Run (\d+), from seed (\d+),/.exec(error?.message ?? '') ?? []
    ok(run !== undefined, error?.message)
    strictEqual(Number(seed), 40 + Number(run) - 1)
    // And says why with what was thrown, which it is caused by.
    ok(error!.cause instanceof Error && error!.cause.message.includes('three'))
  }],
  ['the first thing that does not hold in a run is what it fails with', async () => {
    let told = 0
    const error = await fromEvents({
      state: counter,
      events: { ADD: () => ({ type: 'ADD', by: 1 }), RESET: () => ({ type: 'ADD', by: 1 }) as never },
      always: () => { throw new Error(`not held, time ${++told}`) },
      steps: 3, runs: 1, seed: 1,
    }).then(() => undefined, (thrown: unknown) => thrown as Error)
    ok(error?.message.endsWith('not held, time 1'), error?.message)
  }],
  ['a run that fails as it is set up, before anything is sent, says it sent nothing', async () => {
    await rejects(fromEvents({
      state: counter,
      events: { ADD: () => ({ type: 'ADD', by: 1 }), RESET: () => ({ type: 'RESET' }) },
      around: () => { throw new Error('could not set up') },
      always: () => {},
      steps: 2, runs: 1, seed: 1,
    }), /failed after sending nothing:\ncould not set up/)
  }],
  ['the order a run is sent in is drawn apart from what it sends: every pairing of the two is made', async () => {
    const pairs = new Set<string>()
    let order: string[] = []
    type Two = { type: 'A' } | { type: 'B' }
    const two = state<{}, Two>()({ on: { A: () => { order.push('A') }, B: () => { order.push('B') } } })
    for (let seed = 0; seed < 40; seed++) {
      await fromEvents({
        state: two,
        events: { A: () => ({ type: 'A' }), B: () => ({ type: 'B' }) },
        // Something else that happens, in a lane of its own: before or after what is sent is the ordering's to say.
        around: (_, schedule) => { order = []; schedule.does('elsewhere', ['happens', () => { order.push('elsewhere') }]) },
        always: () => {},
        steps: 1, runs: 1, seed,
      })
      pairs.add(order.join(' then '))
    }
    deepStrictEqual([...pairs].sort(), ['A then elsewhere', 'B then elsewhere', 'elsewhere then A', 'elsewhere then B'])
  }],
  ['a run that fails names what it had sent when it failed, and sends nothing more', async () => {
    let received = 0
    const counting = state<{ data: { count: number } }, { type: 'ADD' } | { type: 'NONE' }>()({
      data: { count: 0 },
      on: { ADD: (_, { data }) => { received++; return { data: { count: data.count + 1 } } }, NONE: () => {} },
    })
    const error = await fromEvents({
      state: counting,
      events: { ADD: () => ({ type: 'ADD' }), NONE: () => ({ type: 'ADD' }) as never },
      always: (value) => { ok(value.data.count < 2, 'two') },
      steps: 6, runs: 1, seed: 1,
    }).then(() => undefined, (thrown: unknown) => thrown as Error)
    ok(/failed after sending ADD, ADD:\ntwo/.test(error?.message ?? ''), error?.message)
    strictEqual(received, 2)
  }],
  ['a system a run made is stopped however the run ends', async () => {
    let made: { read(handle: never): unknown } | undefined
    let handle: unknown
    await rejects(fromEvents({
      state: counter,
      events: { ADD: () => ({ type: 'ADD', by: 1 }), RESET: () => ({ type: 'RESET' }) },
      around: (sys) => { made = sys; handle = sys.start('beside', counter); throw new Error('could not set up') },
      always: () => {},
      steps: 1, runs: 1, seed: 1,
    }), /could not set up/)
    // A system that has stopped holds no state: what it had started reads as nothing.
    ok(made !== undefined)
    strictEqual(made.read(handle as never), undefined)
  }],
  ['the first thing not held is what a run fails with, whatever changes after it', async () => {
    let told = 0
    const error = await fromEvents({
      state: counter,
      events: { ADD: () => ({ type: 'ADD', by: 1 }), RESET: () => ({ type: 'ADD', by: 1 }) as never },
      // Something beside it keeps changing after the run has failed, and each change is a step always is held to.
      around: (sys, schedule) => {
        const beside = sys.start('beside', counter)
        schedule.does('elsewhere', ...[1, 2, 3].map((n) => [`adds ${n}`, () => { sys.send(beside, { type: 'ADD', by: 1 }) }] as const))
      },
      always: () => { throw new Error(`not held, time ${++told}`) },
      steps: 1, runs: 1, seed: 1,
    }).then(() => undefined, (thrown: unknown) => thrown as Error)
    ok(error?.message.endsWith('not held, time 1'), error?.message)
  }],
  ['a maker that picks from nothing is told so', async () => {
    await rejects(fromEvents({ state: counter, events: { ADD: (random) => ({ type: 'ADD', by: random.pick<number>([]) }), RESET: () => ({ type: 'RESET' }) }, always: () => {}, steps: 5, runs: 1, seed: 1 }), /There is nothing to pick from/)
  }],
  ['a state that declares no events has nothing to be sent, and is refused', async () => {
    await rejects(fromEvents({ state: state<{ data: { n: number } }, never>()({ data: { n: 0 } }), events: {} as never, always: () => {}, steps: 1, runs: 1, seed: 1 }), /declares no events it takes/)
  }],
  ['every declared event with no way to make it is named', async () => {
    type Three = { type: 'A' } | { type: 'B' } | { type: 'C' }
    const three = state<{}, Three>()({ on: { A: () => {}, B: () => {}, C: () => {} } })
    await rejects(fromEvents({ state: three, events: { A: () => ({ type: 'A' }) } as never, always: () => {}, steps: 1, runs: 1, seed: 1 }), /No way to make B, C,/)
  }],
  ['the state is run in a window: a surface it tells there is told', async () => {
    type Windowed = { systems: {}; surfaces: { panel: { events: { type: 'PINGED' } } }; views: {} }
    const windowed = forNet<Windowed>()
    const heard: string[] = []
    const panel = windowed<{}, { type: 'PINGED' }>()({ on: { PINGED: () => { heard.push('pinged') } } })
    const pinger = windowed<{}, { type: 'PING' }>()({ on: { PING: (_, { tell }) => { tell({ surface: 'panel' }, { type: 'PINGED' }) } } })
    await fromEvents({ state: pinger, events: { PING: () => ({ type: 'PING' }) }, around: (sys) => { sys.start('panel', panel) }, always: () => {}, steps: 2, runs: 1, seed: 1 })
    strictEqual(heard.length, 2)
  }],
  ['a failure says it was an ordering, every choice made, and what was thrown, which it is caused by', async () => {
    const thrown = new Error('x went first, then y')
    const error = await everyOrder((schedule) => {
      const order: string[] = []
      schedule.does('x', ['1', () => { order.push('x1') }], ['2', () => { order.push('x2') }])
      schedule.does('y', ['1', () => { order.push('y1') }])
      return () => { if (order.join(' ') === 'x1 y1 x2') throw thrown }
    }).then(() => undefined, (caught: unknown) => caught as Error)
    ok(/^Failed in ordering \d+ \(replay with \[0, 1\]\):/.test(error?.message ?? ''), error?.message)
    strictEqual(error!.cause, thrown)
  }],
  ['a system\'s frames are named for it in what a failure lists, and what it puts off goes into the lane it names', async () => {
    for (const [name, says] of [[undefined, "a system's frame"], ['the window', "the window's frame"]] as const) {
      const error = await everyOrder((schedule) => {
        const { frame, later } = onSchedule(schedule, ...(name ? [name] : []))
        frame(() => {})
        later({ label: 'put off' }, () => {})
        return () => { throw new Error('fails') }
      }).then(() => undefined, (caught: unknown) => caught as Error)
      ok(error?.message.includes(says) && error.message.includes('put off'), error?.message)
    }
  }],
  ['a timer is named for its time in what a failure lists', async () => {
    const error = await everyOrder((schedule) => {
      void schedule.clock.sleep(60_000)
      return () => { throw new Error('fails') }
    }).then(() => undefined, (caught: unknown) => caught as Error)
    ok(error?.message.includes('the clock: 60000 ms'), error?.message)
  }],
  ['a timer called off is the one called off: the first set, or one that has already fired, leaves the rest', async () => {
    const heard: string[] = []
    await everyOrder((schedule) => {
      const { clock } = schedule
      const first = clock.after(5, () => heard.push('first'))
      clock.after(15, () => heard.push('second'))
      first()
      const early = clock.after(10, () => heard.push('early'))
      clock.after(20, () => { early(); heard.push('after calling off what had fired') })
      clock.after(30, () => heard.push('last'))
      return () => {}
    })
    deepStrictEqual(heard, ['early', 'second', 'after calling off what had fired', 'last'])
  }],
  ['explore is there for a pack to read how many orderings it ran', async () => {
    const explored = await explore(twoByTwo([]))
    deepStrictEqual({ orderings: explored.orderings, complete: explored.complete }, { orderings: 6, complete: true })
  }],
  ['fromEvents starts a root state that requires given data', async () => {
    const seededState = state<{ data: { label: string; count: number } }, { type: 'INC' }>()({
      data: { label: given, count: 0 },
      on: { INC: (_, { data }) => ({ data: { count: data.count + 1 } }) },
    })
    const labels: string[] = []
    await fromEvents({
      state: seededState,
      given: { label: 'alpha' },
      events: { INC: () => ({ type: 'INC' }) },
      always: (value, sent) => {
        labels.push(value.data.label)
        strictEqual(value.data.label, 'alpha')
        strictEqual(value.data.count, sent.length)
      },
      steps: 4, runs: 2, seed: 1,
    })
    strictEqual(labels.length, 8)
  }],
  ['waitFor resolves immediately or on a later step with narrowed type, ignores unrelated states, and cleans up on settle', async () => {
    const flow = state<{
      states: { idle: {}; done: { data: { result: string } } }
    }, { type: 'FINISH'; result: string }>()({
      initial: 'idle',
      states: {
        idle: { on: { FINISH: ({ result }) => ({ at: 'done', data: { result } }) } },
        done: { data: { result: given } },
      },
    })
    const sys = system({ side: 'window' })
    const h = sys.start('flow', flow)
    const other = sys.start('other', counter)

    // Synchronous fast-path when already matching.
    const immediate = await waitFor(sys, h, (v) => v.at === 'idle')
    strictEqual(immediate.at, 'idle')

    // Async match with type-predicate narrowing; unrelated state changes must not re-invoke predicate.
    let checks = 0
    const pending = waitFor(
      sys,
      h,
      (v): v is Extract<typeof v, { at: 'done' }> => {
        checks++
        return v.at === 'done'
      },
    )
    strictEqual(checks, 1)
    sys.send(other, { type: 'ADD', by: 1 })
    strictEqual(checks, 1)
    sys.send(h, { type: 'FINISH', result: 'ok' })
    const matched = await pending
    strictEqual(matched.at, 'done')
    strictEqual(matched.data.result, 'ok')
    strictEqual(checks, 2)

    // After settlement, further changes do not call the predicate again (unsubscribed).
    sys.send(other, { type: 'ADD', by: 2 })
    strictEqual(checks, 2)
    sys.stop()
  }],
  ['waitFor rejects on stopped state, predicate throw, timeout (real and custom clock), and AbortSignal', async () => {
    const sys = system({ side: 'window' })
    const h = sys.start('c', counter)

    // Predicate throwing synchronously rejects.
    await rejects(waitFor(sys, h, () => { throw new Error('bad initial') }), /bad initial/)

    // Predicate throwing on a later update rejects and unsubscribes.
    let calls = 0
    const laterThrow = waitFor(sys, h, (v) => {
      calls++
      if (v.data.count === 1) throw new Error('bad update')
      return false
    })
    sys.send(h, { type: 'ADD', by: 1 })
    await rejects(laterThrow, /bad update/)
    sys.send(h, { type: 'ADD', by: 1 })
    strictEqual(calls, 2)

    // Pre-aborted signal rejects immediately without evaluating predicate.
    const preAborted = new AbortController()
    preAborted.abort(new Error('already aborted'))
    let preRan = false
    await rejects(waitFor(sys, h, () => { preRan = true; return true }, { signal: preAborted.signal }), /already aborted/)
    strictEqual(preRan, false)

    // Aborting while waiting rejects and unsubscribes.
    const ac = new AbortController()
    let abortCalls = 0
    const abortedWait = waitFor(sys, h, () => { abortCalls++; return false }, { signal: ac.signal })
    ac.abort(new Error('cancelled'))
    await rejects(abortedWait, /cancelled/)
    sys.send(h, { type: 'ADD', by: 1 })
    strictEqual(abortCalls, 1)

    // Custom clock timeout: fires at 0ms, and cancels cleanly when predicate matches first.
    let timerFired: (() => void) | undefined
    let timerCancelled = 0
    const mockClock = {
      after: (_ms: number, runFn: () => void) => {
        timerFired = runFn
        return () => { timerCancelled++; timerFired = undefined }
      },
    }
    const clockTimeout = waitFor(sys, h, () => false, { timeout: 0, clock: mockClock })
    timerFired!()
    await rejects(clockTimeout, /waitFor\(c\) timed out after 0ms/)
    strictEqual(timerCancelled, 1)

    const clockMatch = waitFor(sys, h, (v) => v.data.count === 4, { timeout: 50, clock: mockClock })
    sys.send(h, { type: 'ADD', by: 1 })
    strictEqual((await clockMatch).data.count, 4)
    strictEqual(timerCancelled, 2)
    strictEqual(timerFired, undefined)

    // Real setTimeout timeout rejects cleanly, and resolving before timeout clears both timer and abort listener.
    await rejects(waitFor(sys, h, () => false, { timeout: 5 }), /waitFor\(c\) timed out after 5ms/)

    // Waiting without a timeout does not arm an implicit 0ms timer.
    const noTimeout = waitFor(sys, h, (v) => v.data.count === 5)
    await new Promise((resolve) => setTimeout(resolve, 15))
    sys.send(h, { type: 'ADD', by: 1 })
    strictEqual((await noTimeout).data.count, 5)

    // Resolving before a real setTimeout clears the timer and removes the `'abort'` listener exactly once.
    const acCleanup = new AbortController()
    const removedEvents: string[] = []
    const origRemove = acCleanup.signal.removeEventListener.bind(acCleanup.signal)
    acCleanup.signal.removeEventListener = ((type: string, listener: EventListenerOrEventListenerObject, opts?: boolean | EventListenerOptions) => {
      removedEvents.push(type)
      return origRemove(type, listener, opts)
    }) as typeof acCleanup.signal.removeEventListener
    const earlyResolve = waitFor(sys, h, (v) => v.data.count === 6, { timeout: 10, signal: acCleanup.signal })
    sys.send(h, { type: 'ADD', by: 1 })
    strictEqual((await earlyResolve).data.count, 6)
    await new Promise((resolve) => setTimeout(resolve, 25))
    deepStrictEqual(removedEvents, ['abort'])

    // Stopping while waiting rejects, and waiting on an already-stopped handle rejects immediately.
    const stopWait = waitFor(sys, h, () => false)
    sys.stop()
    await rejects(stopWait, /c stopped before waitFor matched/)
    await rejects(waitFor(sys, h, () => true), /c is not running/)

    // Concurrent waitFor callers on the same step both settle even though the first unsubscribes mid-flush,
    // both on normal commits and when a failed transaction stops the system (`lost()`).
    const sys2 = system({ side: 'window' })
    const h2 = sys2.start('c', counter)
    const p1 = waitFor(sys2, h2, (v) => v.data.count === 1)
    const p2 = waitFor(sys2, h2, (v) => v.data.count === 1)
    sys2.send(h2, { type: 'ADD', by: 1 })
    const [r1, r2] = await Promise.all([p1, p2])
    strictEqual(r1.data.count, 1)
    strictEqual(r2.data.count, 1)
    sys2.stop()

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
    const fh = flaky.start('c', counter)
    const lp1 = waitFor(flaky, fh, (v) => v.data.count === 99)
    const lp2 = waitFor(flaky, fh, (v) => v.data.count === 99)
    failCommit = true
    flaky.send(fh, { type: 'ADD', by: 1 })
    await rejects(lp1, /c stopped before waitFor matched/)
    await rejects(lp2, /c stopped before waitFor matched/)
  }],
  ['defectGuard captures structured Defects, supports string/RegExp/predicate allow, and disposes via Symbol.dispose', () => {
    // Works with no forward listener as well.
    const quiet = defectGuard()
    quiet.assertNone()
    strictEqual(quiet.defects.length, 0)
    // Calling `onDefect` with no `forward` callback does not throw.
    quiet.onDefect({ message: 'no forward' })
    strictEqual(quiet.defects.length, 1)
    quiet.allow('no forward')
    quiet.assertNone()

    const forwarded: Defect[] = []
    const guard = defectGuard((d) => forwarded.push(d))
    const boomError = new Error('boom!')
    const faulty = state<{ data: { count: number } }, { type: 'BOOM' } | { type: 'BAD_MOVE' } | { type: 'OK' }>()({
      data: { count: 0 },
      on: {
        BOOM: () => { throw boomError },
        BAD_MOVE: () => ({ at: 'nope' }) as never,
        OK: (_, { data }) => ({ data: { count: data.count + 1 } }),
      },
    })
    const sys = system({ side: 'window', onDefect: guard.onDefect })
    const h = sys.start('f', faulty)
    sys.send(h, { type: 'OK' })
    // Unhandled event is not a defect.
    sys.send(h, { type: 'IGNORED' } as never)
    guard.assertNone()
    strictEqual(guard.defects.length, 0)
    strictEqual(forwarded.length, 0)

    sys.send(h, { type: 'BOOM' })
    sys.send(h, { type: 'BOOM' })
    sys.send(h, { type: 'BAD_MOVE' })
    strictEqual(guard.defects.length, 3)
    strictEqual(forwarded.length, 3)
    strictEqual(guard.defects[0]!.ref, 'f')
    strictEqual(guard.defects[0]!.error, boomError)
    strictEqual(guard.defects[2]!.ref, 'f')
    strictEqual(guard.defects[2]!.error, undefined)
    throws(() => guard.assertNone(), /Unexpected kernel defect\(s\):\n.*boom!.*\n.*boom!.*\n.*has no state nope/)

    // A global `/g` regex matching at index 0 matches every occurrence without stateful `lastIndex` drift.
    guard.allow(/^f threw.*boom!/g)
    throws(() => guard.assertNone(), /has no state nope/)

    // String patterns match literally (even with regex metacharacters like `+`).
    guard.onDefect({ message: 'bad a+b' })
    guard.allow('has no state nope')
    throws(() => guard.assertNone(), /bad a\+b/)
    guard.allow('a+b')
    guard.assertNone()

    // Predicate allow matches on structured Defect fields (ref / error) and still rejects non-matching defects.
    const specific = new RangeError('out of bounds')
    guard.onDefect({ message: 'range issue', ref: 'r', error: specific })
    throws(() => guard.assertNone(), /range issue/)
    guard.allow((d) => d.ref === 'r' && d.error === specific)
    guard.assertNone()
    guard.onDefect({ message: 'unmatched issue', ref: 'other' })
    throws(() => guard.assertNone(), /unmatched issue/)
    sys.stop()
  }],
  ['Symbol.dispose tears down System, Connected, and DefectGuard in LIFO order and catches teardown defects', () => {
    let exited = false
    let linkEnded = false
    const tracked = state<{ data: { n: number } }, never>()({
      data: { n: 0 },
      run: ({ onExit }) => { onExit(() => { exited = true }) },
    })
    {
      using guard = defectGuard()
      using backend = system({ side: 'backend', onDefect: guard.onDefect })
      using window = system({ side: 'window', onDefect: guard.onDefect })
      using link = connect(window, backend)
      link.window.onEnd(() => { linkEnded = true })
      backend.start('t', tracked)
      strictEqual(exited, false)
      strictEqual(linkEnded, false)
    }
    strictEqual(exited, true)
    strictEqual(linkEnded, true)

    // Teardown defect during `sys.stop()` is captured before `guard[Symbol.dispose]()` runs `assertNone()`.
    const badExit = state<{ data: { n: number } }, never>()({
      data: { n: 0 },
      run: ({ onExit }) => { onExit(() => { throw new Error('release exploded') }) },
    })
    throws(() => {
      using guard = defectGuard()
      using sys = system({ side: 'backend', onDefect: guard.onDefect })
      sys.start('bad', badExit)
    }, /release exploded/)
  }],
])
