// The causal inspector's edges between systems, under the schedule. An edge says one step caused another, and what
// crosses a link is told apart only by where it went and what it was called: two windows telling a backend the same
// thing, or a backend sending itself what a window also tells it, are orders in which a guess is wrong. Each scenario
// has every message say who sent it, so what was handled is known, and holds every edge to that under every ordering.
//
//   npx vitest run inspect-order
import { deepStrictEqual, strictEqual } from 'node:assert'
import { connect, run } from './checks.mts'
import { explore, sample, type Schedule } from '@apackdev/orderings'
import { forNet, system } from '../src/index.ts'
import { createInspector, type CausalEdge, type InspectedStep, type Inspector } from '../src/inspect.ts'

type Asks = { WORK: { args: { from: string }; answer: string } }
type SvcEvent = { type: 'PING'; from: string } | { type: 'KICK' } | { type: 'SHOUT'; n: number }
type PanelEvent = { type: 'TELL' } | { type: 'ASK' } | { type: 'NOTE'; n: number }
type Net = {
  systems: { svc: { events: SvcEvent; asks: Asks } }
  surfaces: { panel: { events: PanelEvent } }
  views: {}
}
const net = forNet<Net>()

/** Keeps who pinged it and who asked it, in the order it took them. */
const svc = (asked: string[]) => net<{ data: { pinged: string[] } }, SvcEvent, Asks>()({
  data: { pinged: [] },
  on: {
    PING: ({ from }) => ({ data: (d) => { d.pinged.push(from) } }),
    KICK: (_, { raise }) => { raise({ type: 'PING', from: 'itself' }) },
    SHOUT: ({ n }, { broadcast }) => { broadcast('panel', { type: 'NOTE', n }) },
  },
  answers: { WORK: ({ from }) => { asked.push(from); return from } },
})
/** Tells and asks the backend in its own name, and keeps the notes it is sent in the order they came. */
const panel = (name: string) => net<{ data: { notes: number[]; got: string }; calls: { work: 'single' } }, PanelEvent>()({
  data: { notes: [], got: '' },
  calls: ({ single }) => ({ work: single('svc', 'WORK', { args: () => ({ from: name }), done: (outcome) => (outcome.ok ? { data: { got: outcome.value } } : undefined) }) }),
  on: {
    TELL: (_, { tell }) => { tell('svc', { type: 'PING', from: name }) },
    ASK: (_, { call }) => { call('work') },
    NOTE: ({ n }) => ({ data: (d) => { d.notes.push(n) } }),
  },
})

const wired = (schedule: Schedule, names: readonly string[]) => {
  const inspector = createInspector()
  const asked: string[] = []
  const backend = system({ side: 'backend', later: schedule.later, ...inspector.hooks('backend') })
  const made = backend.start('svc', svc(asked))
  const windows = names.map((name) => {
    const window = system({ side: 'window', name, later: schedule.later, ...inspector.hooks(name) })
    connect(window, backend, schedule, name)
    return { name, window, handle: window.start('panel', panel(name)) }
  })
  return { inspector, asked, backend, made, windows }
}
/** The steps of a system that handled something of this kind and name, once for each time one did, in order. */
const took = (inspector: Inspector, of: string, kind: string, name: string): InspectedStep[] =>
  inspector.steps.filter((step) => step.system === of).flatMap((step) => step.log.handled.filter((each) => each.kind === kind && each.name === name).map(() => step))
/** The one step of a system that sent something of this kind. */
const sent = (inspector: Inspector, of: string, kind: string): InspectedStep => {
  const found = inspector.steps.filter((step) => step.system === of && step.log.sent.some((each) => each.kind === kind))
  strictEqual(found.length, 1)
  return found[0]!
}
/** The edges into a step from another system, of one kind. */
const across = (step: InspectedStep, kind: CausalEdge['kind']): CausalEdge[] => step.causes.filter((edge) => edge.kind === kind && edge.fromSystem !== step.system)
const from = (edge: CausalEdge): string => `${edge.fromSystem}#${edge.fromStep}`
const WINDOWS = ['one', 'two'] as const

/** How many orderings gave each window's message its edge: a rule that gave none would hold every edge and say nothing. */
const stitched = { tells: 0, asks: 0, answers: 0, notes: 0 }

const tells = (names: readonly string[]) => (schedule: Schedule): (() => void) => {
  const { inspector, backend, made, windows } = wired(schedule, names)
  for (const { name, window, handle } of windows) schedule.does(`the user of ${name}`, ['has it tell', () => window.send(handle, { type: 'TELL' })])
  schedule.does('the host', ['sends it the same', () => backend.send(made, { type: 'PING', from: 'here' })], ['has it raise the same', () => backend.send(made, { type: 'KICK' })])
  return () => {
    const pinged = backend.read(made).data.pinged
    const steps = took(inspector, 'backend', 'event', 'PING')
    deepStrictEqual([...pinged].sort(), ['here', 'itself', ...names])
    strictEqual(steps.length, pinged.length)
    steps.forEach((step, index) => {
      const who = pinged[index]!
      // What was sent here, or raised, was told by no window; what a window told is from that window's step, or from nothing.
      const expected = who === 'here' || who === 'itself' ? [] : [`${who}#${sent(inspector, who, 'tell').log.number}`]
      const edges = across(step, 'tell').map(from)
      if (edges.length) { deepStrictEqual(edges, expected); stitched.tells++ }
    })
  }
}

const asks = (names: readonly string[]) => (schedule: Schedule): (() => void) => {
  const { inspector, asked, backend, made, windows } = wired(schedule, names)
  for (const { name, window, handle } of windows) schedule.does(`the user of ${name}`, ['has it ask', () => window.send(handle, { type: 'ASK' })])
  schedule.does('the host', ['asks the same', () => { void backend.ask(made, 'WORK', { from: 'here' }) }])
  return () => {
    const steps = took(inspector, 'backend', 'ask', 'WORK')
    deepStrictEqual([...asked].sort(), ['here', ...names])
    strictEqual(steps.length, asked.length)
    steps.forEach((step, index) => {
      const who = asked[index]!
      const expected = who === 'here' ? [] : [`${who}#${sent(inspector, who, 'ask').log.number}`]
      const edges = across(step, 'ask').map(from)
      if (edges.length) { deepStrictEqual(edges, expected); stitched.asks++ }
    })
    // Each window's answer is from the step that answered that window, which is the one that took its ask.
    for (const { name, window, handle } of windows) {
      strictEqual(window.read(handle).data.got, name)
      const [answered] = took(inspector, name, 'answer', 'WORK')
      const edges = across(answered!, 'answer').map(from)
      if (edges.length) { deepStrictEqual(edges, [`backend#${steps[asked.indexOf(name)]!.log.number}`]); stitched.answers++ }
    }
    deepStrictEqual(inspector.inFlight(), [])
  }
}

const notes = (schedule: Schedule): (() => void) => {
  const { inspector, backend, made, windows } = wired(schedule, ['one'])
  const { window, handle } = windows[0]!
  schedule.does('the host', ['has it shout', () => backend.send(made, { type: 'SHOUT', n: 0 })], ['and again', () => backend.send(made, { type: 'SHOUT', n: 1 })])
  schedule.does('the user', ['notes something itself', () => window.send(handle, { type: 'NOTE', n: 99 })])
  return () => {
    const noted = window.read(handle).data.notes
    const steps = took(inspector, 'one', 'event', 'NOTE')
    const shouts = inspector.steps.filter((step) => step.system === 'backend' && step.log.sent.some((each) => each.kind === 'broadcast'))
    deepStrictEqual([...noted].sort(), [0, 1, 99])
    strictEqual(steps.length, 3)
    steps.forEach((step, index) => {
      const n = noted[index]!
      const expected = n === 99 ? [] : [`backend#${shouts[n]!.log.number}`]
      const edges = across(step, 'broadcast').map(from)
      if (edges.length) { deepStrictEqual(edges, expected); stitched.notes++ }
    })
  }
}

await run([], async (tally) => {
  await tally.every('a tell edge is from the window that told it, and what was sent here or raised has none, under every ordering', () => explore(tells(['one'])))
  await tally.every('an ask edge is from the window that asked, and its answer from the step that answered it, under every ordering beside an ask made here', () => explore(asks(['one'])))
  await tally.every('a broadcast edge is from the step that broadcast it, under every ordering of two broadcasts and the same event sent in the window', () => explore(notes))
  // Two windows and a backend have more orderings than can each be run: a seed's worth of them.
  await tally.every('two windows that tell a backend the same thing are each given their own edge or none', () => sample(tells(WINDOWS), { seed: 1, runs: 2_000 }), 'sampled')
  await tally.every('two windows that ask a backend the same thing are each given their own edge and answer or none', () => sample(asks(WINDOWS), { seed: 1, runs: 2_000 }), 'sampled')
  await tally.check('and in some ordering of each, every one of them was given its edge', () => {
    for (const [what, count] of Object.entries(stitched)) strictEqual(count > 0, true, `no ${what} were ever given an edge`)
  })
})
