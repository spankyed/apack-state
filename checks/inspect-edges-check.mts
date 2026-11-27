// Which edge between systems the causal inspector gives, and when it gives none, with each message delivered by hand:
// the windows and the backend are joined by ports that hold what crosses until the check says which goes next, so
// each case is one ordering, chosen. `inspect-order-check` runs the orderings; this says what each rule is.
//
//   npx vitest run inspect-edges
import { deepStrictEqual, strictEqual } from 'node:assert'
import { rest, run, system } from './checks.mts'
import { forNet, type System } from '../src/index.ts'
import { createInspector, type Inspector } from '../src/inspect.ts'

type Asks = { WORK: { args: {}; answer: string } }
type PaneEvent = { type: 'TELL' } | { type: 'TELL_OTHER' } | { type: 'TELL_THIRD' } | { type: 'ASK'; key: string } | { type: 'DROP'; key: string } | { type: 'BOTH'; key: string } | { type: 'NOTE' }
type Net = {
  systems: { desk: { events: { type: 'PING' } | { type: 'PONG' } | { type: 'SHOUT' }; asks: Asks } }
  surfaces: { pane: { events: PaneEvent } }
  views: {}
}
const net = forNet<Net>()
const desk = net<{}, { type: 'PING' } | { type: 'PONG' } | { type: 'SHOUT' }, Asks>()({
  on: { PING: () => {}, PONG: () => {}, SHOUT: (_, { broadcast }) => { broadcast('pane', { type: 'NOTE' }) } },
  answers: { WORK: () => 'done' },
})
/** Tells the desk, asks it for work under a key and gives that up, and takes the notes it is sent. */
const pane = net<{ data: { got: number }; calls: { work: 'each' } }, PaneEvent>()({
  data: { got: 0 },
  calls: ({ each }) => ({ work: each('desk', 'WORK', { done: (outcome, { data }) => (outcome.ok ? { data: { got: data.got + 1 } } : undefined) }) }),
  on: {
    TELL: (_, { tell }) => { tell('desk', { type: 'PING' }) },
    TELL_OTHER: (_, { tell }) => { tell('desk', { type: 'PONG' }) },
    TELL_THIRD: (_, { tell }) => { tell('desk', { type: 'SHOUT' }) },
    ASK: ({ key }, { call }) => { call('work', key) },
    DROP: ({ key }, { cancel }) => { cancel('work', key) },
    BOTH: ({ key }, { call, cancel }) => { call('work', key); cancel('work', key) },
    NOTE: () => {},
  },
})

/** A backend, and windows joined to it by hand: what a window sends up waits in `up`, and what comes down to it in `down`. */
const byHand = (inspector: Inspector) => {
  const backend = system({ side: 'backend', ...inspector.hooks('backend') })
  const made = backend.start('desk', desk)
  const window = (name: string, joined = true) => {
    const up: Array<() => void> = []
    const down: Array<() => void> = []
    const near: System = system({ side: 'window', ...inspector.hooks(name) })
    const join = (): void => {
      near.attach({
        tell: (to, event) => { up.push(() => backend.port.tell(to, event)) },
        ask: (to, asked, args, progress, done) => {
          let leave = (): void => {}
          up.push(() => { leave = backend.port.ask(to, asked, args, (update) => { down.push(() => progress(update)) }, (outcome) => { down.push(() => done(outcome)) }) })
          // Giving it up crosses too, behind the ask.
          return () => { up.push(() => leave()) }
        },
        follow: (feature, view, args, updated, failed) => backend.port.follow(feature, view, args, updated, failed),
      })
      backend.attach({ tell: (to, event) => { down.push(() => near.port.tell(to, event)) }, ask: () => () => {}, follow: () => ({ stop: () => {} }) })
    }
    if (joined) join()
    const handle = near.start('pane', pane)
    /** Delivers the next that waits, or so many of them. */
    const deliver = (queue: Array<() => void>, count = 1): void => { for (let index = 0; index < count; index++) queue.shift()!() }
    return { name, near, handle, up, down, join, send: (event: PaneEvent): number => { near.send(handle, event); return inspector.steps.at(-1)!.log.number }, deliver }
  }
  /** What each step of a system that took something of this name came of, from another system. */
  const came = (of: string, name: string): string[][] => inspector.steps
    .filter((step) => step.system === of && step.log.handled.some((each) => each.name === name && each.across))
    .map((step) => step.causes.filter((edge) => edge.fromSystem !== of).map((edge) => `${edge.kind} ${edge.fromSystem}#${edge.fromStep}`))
  return { backend, made, window, came }
}

await run([
  ['what one window sends is taken in the order it sent it, and each is given its edge', () => {
    const inspector = createInspector()
    const { window, came } = byHand(inspector)
    const one = window('one')
    const first = one.send({ type: 'TELL' })
    const second = one.send({ type: 'TELL' })
    one.deliver(one.up, 2)
    deepStrictEqual(came('backend', 'PING'), [[`tell one#${first}`], [`tell one#${second}`]])
  }],
  ['what two windows have waiting is in no order: none of it is given an edge, nor what joins it, until as many are taken as were waiting', () => {
    const inspector = createInspector()
    const { window, came } = byHand(inspector)
    const one = window('one')
    const two = window('two')
    one.send({ type: 'TELL' })
    two.send({ type: 'TELL' })
    // Two wait, one from each. The first taken could be either, and then one is left that cannot be told from it.
    two.deliver(two.up)
    deepStrictEqual(came('backend', 'PING'), [[]])
    // One more is told while that one waits: it waits with it, and is no more known than it is.
    one.send({ type: 'TELL' })
    one.deliver(one.up)
    one.deliver(one.up)
    deepStrictEqual(came('backend', 'PING'), [[], [], []])
    // All three were taken. The next is the only one waiting.
    const alone = two.send({ type: 'TELL' })
    two.deliver(two.up)
    deepStrictEqual(came('backend', 'PING').at(-1), [`tell two#${alone}`])
  }],
  ['as many wait under one name as the limit, and each is given its edge; one more, and none of them is', () => {
    for (const [waiting, edges] of [[2, 2], [3, 0]] as const) {
      const inspector = createInspector({ limit: 2 })
      const { window, came } = byHand(inspector)
      const one = window('one')
      for (let count = 0; count < waiting; count++) one.send({ type: 'TELL' })
      one.deliver(one.up, waiting)
      strictEqual(came('backend', 'PING').filter((edges) => edges.length).length, edges)
      // Once they are taken, the next alone is known again.
      const next = one.send({ type: 'TELL' })
      one.deliver(one.up)
      deepStrictEqual(came('backend', 'PING').at(-1), [`tell one#${next}`])
    }
  }],
  ['what is taken with nothing waiting was sent by what is not inspected, and its name is given no edge again', () => {
    const inspector = createInspector()
    const { backend, window, came } = byHand(inspector)
    const one = window('one')
    // A port nothing inspects tells the backend what the window also tells it.
    backend.port.tell('desk', { type: 'PING' })
    one.send({ type: 'TELL' })
    one.deliver(one.up)
    one.send({ type: 'TELL' })
    one.deliver(one.up)
    deepStrictEqual(came('backend', 'PING'), [[], [], []])
  }],
  ['an ask is given its edge and its answer the step that answered it, and of two asks waiting, giving one up leaves the other its own', async () => {
    const inspector = createInspector()
    const { window, came } = byHand(inspector)
    const one = window('one')
    const first = one.send({ type: 'ASK', key: 'a' })
    const second = one.send({ type: 'ASK', key: 'b' })
    // The second is given up while both wait. The first is still the oldest, and is not the one given up.
    one.send({ type: 'DROP', key: 'b' })
    one.deliver(one.up)
    deepStrictEqual(came('backend', 'WORK'), [[`ask one#${first}`]])
    // The second is taken before word that it was given up: it waits alone, and is the one.
    one.deliver(one.up)
    deepStrictEqual(came('backend', 'WORK'), [[`ask one#${first}`], [`ask one#${second}`]])
    one.deliver(one.up)
    // The first's answer is from the backend's step that took and answered it.
    const answering = inspector.steps.find((step) => step.system === 'backend' && step.log.handled.some((each) => each.kind === 'ask'))!
    one.deliver(one.down)
    const answered = inspector.steps.find((step) => step.system === 'one' && step.log.handled.some((each) => each.kind === 'answer'))!
    deepStrictEqual(answered.causes, [
      { kind: 'answer', fromSystem: 'one', fromStep: first, toSystem: 'one', toStep: answered.log.number, opId: 1, ref: 'desk', name: 'WORK' },
      { kind: 'answer', fromSystem: 'backend', fromStep: answering.log.number, toSystem: 'one', toStep: answered.log.number, opId: 1, ref: 'desk', name: 'WORK' },
    ])
    // The second was answered too, to nobody: nothing waits for it, and nothing is under way.
    one.deliver(one.down)
    await rest()
    deepStrictEqual(inspector.inFlight(), [])
    strictEqual(one.near.read(one.handle).data.got, 1)
  }],
  ['an ask given up with another behind it may never come: neither is given an edge, whether it comes or not, and none is ever given a wrong one', () => {
    for (const comes of [true, false]) {
      const inspector = createInspector()
      const { window, came } = byHand(inspector)
      const one = window('one')
      one.send({ type: 'ASK', key: 'a' })
      one.send({ type: 'DROP', key: 'a' })
      one.send({ type: 'ASK', key: 'b' })
      // What waits to go up: the first ask, word that it was given up, and the second ask.
      if (comes) one.deliver(one.up, 3)
      else {
        // The first never arrives, as one does not that word of its being given up overtook: it is never taken.
        const [, gone, next] = one.up.splice(0)
        gone!(); next!()
      }
      deepStrictEqual(came('backend', 'WORK'), comes ? [[], []] : [[]])
      one.deliver(one.down, one.down.length)
      // Where both came, as many were taken as waited, and the next alone is known. Where one never came, one is
      // still thought to be waiting, and the name is given no edge again.
      const next = one.send({ type: 'ASK', key: 'c' })
      one.deliver(one.up)
      deepStrictEqual(came('backend', 'WORK').at(-1), comes ? [`ask one#${next}`] : [])
    }
  }],
  ['an ask made and given up in one step never left: it does not wait, and the next is not taken for it', () => {
    const inspector = createInspector()
    const { window, came } = byHand(inspector)
    const one = window('one')
    one.send({ type: 'BOTH', key: 'a' })
    strictEqual(one.up.length, 0)
    deepStrictEqual(inspector.inFlight(), [])
    const next = one.send({ type: 'ASK', key: 'b' })
    one.deliver(one.up)
    deepStrictEqual(came('backend', 'WORK'), [[`ask one#${next}`]])
    deepStrictEqual(inspector.defects, [])
  }],
  ['a name nothing waits under any more takes no room from one something does', () => {
    // Two names are kept. Something waits under one, and under two others something is told and taken at once.
    const inspector = createInspector({ limit: 2 })
    const { window, came } = byHand(inspector)
    const one = window('one')
    const two = window('two')
    const waiting = one.send({ type: 'TELL' })
    for (const type of ['TELL_OTHER', 'TELL_THIRD'] as const) {
      two.send({ type })
      two.deliver(two.up)
    }
    // What was taken left nothing waiting, and what still waits is still known.
    one.deliver(one.up)
    deepStrictEqual(came('backend', 'PING'), [[`tell one#${waiting}`]])
  }],
  ['a broadcast is given its edge in each window that has only it to take, and a window that is hooked again is no further behind', () => {
    const inspector = createInspector()
    const { backend, made, window, came } = byHand(inspector)
    const one = window('one')
    const two = window('two')
    const shout = (): number => { backend.send(made, { type: 'SHOUT' }); return inspector.steps.at(-1)!.log.number }
    const first = shout()
    one.deliver(one.down)
    // Hooked again under its name, as a scenario does that makes its systems afresh: what it had not taken still waits for it.
    inspector.hooks('two')
    two.deliver(two.down)
    deepStrictEqual([came('one', 'NOTE'), came('two', 'NOTE')], [[[`broadcast backend#${first}`]], [[`broadcast backend#${first}`]]])
    // Two wait for one window, which takes them both: neither is known. The other took each as it came.
    const second = shout()
    two.deliver(two.down)
    const third = shout()
    two.deliver(two.down)
    one.deliver(one.down, 2)
    deepStrictEqual(came('two', 'NOTE').slice(1), [[`broadcast backend#${second}`], [`broadcast backend#${third}`]])
    deepStrictEqual(came('one', 'NOTE').slice(1), [[], []])
    // Caught up, the next is known in both.
    const fourth = shout()
    one.deliver(one.down)
    two.deliver(two.down)
    deepStrictEqual([came('one', 'NOTE').at(-1), came('two', 'NOTE').at(-1)], [[`broadcast backend#${fourth}`], [`broadcast backend#${fourth}`]])
  }],
  ['more broadcasts than are kept, taken one at a time, are each still given the step that made them', () => {
    const inspector = createInspector({ limit: 2 })
    const { backend, made, window } = byHand(inspector)
    const one = window('one')
    const from: Array<number | undefined> = []
    for (let count = 0; count < 4; count++) {
      backend.send(made, { type: 'SHOUT' })
      const shouted = inspector.steps.at(-1)!.log.number
      one.deliver(one.down)
      from.push(inspector.steps.at(-1)!.causes[0]?.fromStep === shouted ? shouted : undefined)
    }
    deepStrictEqual(from.includes(undefined), false)
  }],
])
