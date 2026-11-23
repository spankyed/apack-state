// What a pack's checks are written with (`@apackdev/state/testing`): every ordering, a clock the schedule moves, a
// system on a schedule, and scenarios made from the events a state declares.
import { deepStrictEqual, ok, rejects, strictEqual } from 'node:assert'
import { run } from './checks.mts'
import { reaching } from '../src/index.ts'
import { everyOrdering, explore, fromEvents, onSchedule, replay, type Scenario } from '../src/testing.ts'
import { system } from '../src/kernel.ts'

const state = reaching()
type CounterEvent = { type: 'ADD'; by: number } | { type: 'RESET' }
const counter = state<{ data: { count: number; resets: number } }, CounterEvent>()({
  data: { count: 0, resets: 0 },
  on: {
    ADD: ({ by }, { data }) => ({ data: { count: data.count + by } }),
    RESET: (_, { data }) => ({ data: { count: 0, resets: data.resets + 1 } }),
  },
})

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
    strictEqual(await everyOrdering(twoByTwo(ran)), 6)
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
    const error = await everyOrdering(failing).then(() => undefined, (thrown: unknown) => thrown as Error)
    ok(error instanceof Error)
    ok(/replay with \[1\]/.test(error.message) && /y: 1\n {2}x: 1/.test(error.message) && /y went first/.test(error.message), error.message)
    const again = await replay(failing, [1])
    strictEqual(String(again.error), 'Error: y went first')
  }],
  ['more orderings than it may run is said, and not passed', async () => {
    await rejects(everyOrdering(twoByTwo([]), { limit: 3 }), /too many to run them all/)
  }],
  ['the clock moves only as its timers fire, sooner ones first, to the time each was set for', async () => {
    const heard: Array<[string, number]> = []
    await everyOrdering((schedule) => {
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
    const orderings = await everyOrdering((schedule) => {
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
    const orderings = await everyOrdering((schedule) => {
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
    const orderings = await everyOrdering((schedule) => {
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
      start: 'shut',
      states: { shut: { on: { OPEN: () => ({ at: 'open' }) } }, open: { on: { KNOCK: () => {} } } },
    })
    await rejects(fromEvents({ state: door, events: { OPEN: () => ({ type: 'OPEN' }) } as never, always: () => {}, steps: 1, runs: 1, seed: 1 }), /No way to make KNOCK/)
  }],
  ['explore is there for a pack to read how many orderings it ran', async () => {
    const explored = await explore(twoByTwo([]))
    deepStrictEqual({ orderings: explored.orderings, complete: explored.complete }, { orderings: 6, complete: true })
  }],
])
