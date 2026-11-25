// What updating one child among many running children costs per step.
//
//   npx tsx measure/children-cost.mts
//
// Commit rebuilds values only for the states that changed in the step, reusing each state's already-frozen data, so
// updating one dynamic child out of hundreds or thousands scales with the changed state rather than total children.
import { given, forNet, system, type Each } from '../src/index.ts'
import { reading, under } from './record.mts'

const state = forNet()
const card = state<{ data: { id: string; bumps: number } }, { type: 'BUMP' }>()({
  data: { id: given, bumps: 0 },
  on: { BUMP: (_, { data }) => ({ data: { bumps: data.bumps + 1 } }) },
})
const board = state<{ data: { ids: string[] }; starts: { card: Each<typeof card> } }, { type: 'SET'; ids: string[] } | { type: 'BUMP'; id: string }>()({
  data: { ids: [] },
  starts: (start) => ({ card: start(card, { each: 'ids', given: (id) => ({ id }) }) }),
  on: {
    SET: ({ ids }) => ({ data: { ids } }),
    BUMP: ({ id }, { tell, child }) => { tell(child('card', id), { type: 'BUMP' }) },
  },
})

const STEPS = 1_000

under('updating one child among many')
console.log('updating one child among many')
for (const children of [10, 300, 1_000]) {
  const sys = system({ side: 'window' })
  const handle = sys.start('board', board)
  const ids = Array.from({ length: children }, (_, i) => `c${i}`)
  sys.send(handle, { type: 'SET', ids })
  const target = ids[Math.floor(children / 2)]!
  // Warm up
  for (let i = 0; i < 50; i++) sys.send(handle, { type: 'BUMP', id: target })
  const started = process.hrtime.bigint()
  for (let i = 0; i < STEPS; i++) sys.send(handle, { type: 'BUMP', id: target })
  const us = Number(process.hrtime.bigint() - started) / 1e3 / STEPS
  reading(`${children} children, 1 updated`, Number(us.toFixed(1)), 'µs/step')
  console.log(`  ${String(children).padStart(4)} children, 1 updated: ${us.toFixed(1).padStart(7)} µs/step`)
  sys.stop()
}
