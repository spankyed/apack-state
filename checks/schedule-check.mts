// What the schedule itself has to get right, since every check of order rests on it: each ordering run once, a
// failure that names the ordering it came from, and a run that does not come to rest stopped and said so.
//
//   npx vitest run schedule
import { deepStrictEqual, ok, strictEqual } from 'node:assert'
import { run } from './checks.mts'
import { explore, replay, sample, type Schedule } from '../src/schedule.ts'

/** Two lanes of two things each, and a check that fails when `b` is done first. */
const twoLanes = (schedule: Schedule): (() => void) => {
  const done: string[] = []
  schedule.does('one', ['a', () => done.push('a')], ['b', () => done.push('b')])
  schedule.does('two', ['c', () => done.push('c')], ['d', () => done.push('d')])
  return () => { strictEqual(done[0], 'a') }
}
/** One lane, so there is nothing to choose, and a check that always fails. */
const oneLane = (schedule: Schedule): (() => void) => {
  schedule.does('the user', ['clicks', () => {}], ['clicks again', () => {}])
  return () => { throw new Error('always') }
}

await run([
  ['each ordering is run once: two lanes of two things each are six orderings', async () => {
    const orders = new Set<string>()
    const found = await explore((schedule) => {
      const done: string[] = []
      schedule.does('one', ['a', () => done.push('a')], ['b', () => done.push('b')])
      schedule.does('two', ['c', () => done.push('c')], ['d', () => done.push('d')])
      return () => { orders.add(done.join('')) }
    })
    deepStrictEqual(found, { orderings: 6, complete: true })
    strictEqual(orders.size, 6)
  }],
  ['an exploration stopped at its limit ran that many and says it was not every one', async () => {
    deepStrictEqual(await explore((schedule) => { twoLanes(schedule); return () => {} }, { limit: 4 }), { orderings: 4, complete: false })
  }],
  ['a failure says what was run, in order, and is not complete', async () => {
    const found = await explore(twoLanes)
    ok(found.failure, 'no ordering failed')
    strictEqual(found.complete, false)
    strictEqual(found.failure.taken[0], 'two: c')
    deepStrictEqual([...found.failure.taken].sort(), ['one: a', 'one: b', 'two: c', 'two: d'])
    const again = await replay(twoLanes, found.failure.choices)
    deepStrictEqual(again.taken, found.failure.taken)
    ok(again.error !== undefined)
  }],
  ['a failure with nothing to choose between has no choices to replay', async () => {
    const found = await explore(oneLane)
    deepStrictEqual(found.failure?.choices, [])
    deepStrictEqual(found.failure?.taken, ['the user: clicks', 'the user: clicks again'])
    strictEqual(found.orderings, 1)
  }],
  ['replaying an ordering that holds runs it, and says what was run', async () => {
    deepStrictEqual(await replay(twoLanes, [0, 0]), { taken: ['one: a', 'one: b', 'two: c', 'two: d'] })
  }],
  ['work that breaks fails when the schedule gets to it, as one more thing run', async () => {
    const found = await explore((schedule) => {
      let failed: unknown
      schedule.breaks('the read', new Error('the disk is gone')).catch((error: unknown) => { failed = error })
      return () => { strictEqual((failed as Error | undefined)?.message, 'the disk is gone') }
    })
    deepStrictEqual(found, { orderings: 1, complete: true })
    deepStrictEqual(await replay((schedule) => { void schedule.breaks('the read', new Error('no')).catch(() => {}); return () => {} }, []), { taken: ['the read'] })
  }],
  ['two things telling each other forever are stopped, and the failure says nothing comes to rest', async () => {
    const found = await explore((schedule) => {
      const lane = { label: 'ping' }
      const again = (): void => { schedule.later(lane, again) }
      again()
      return () => {}
    })
    ok(found.failure, 'it never stopped')
    ok(/never comes to rest/.test(String(found.failure.error)), String(found.failure.error))
  }],
  ['a sample runs as many orderings as it is given and does not claim it ran them all', async () => {
    deepStrictEqual(await sample((schedule) => { twoLanes(schedule); return () => {} }, { seed: 3, runs: 10 }), { orderings: 10, complete: false })
  }],
  ['a sample that fails says where, and replaying its choices fails the same way', async () => {
    const found = await sample(twoLanes, { seed: 3, runs: 200 })
    ok(found.failure, 'no ordering failed')
    strictEqual(found.complete, false)
    ok(found.orderings <= 200)
    const again = await replay(twoLanes, found.failure.choices)
    deepStrictEqual(again.taken, found.failure.taken)
    ok(again.error !== undefined)
  }],
])
