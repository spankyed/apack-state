// `outside(work)`: work the kernel did not start, waited for as an ask or a sleep is. It gives what the work ends with
// while its owner is there, and ends with `Cancelled` where it is awaited once the owner has gone, so nothing after
// it runs for a state that was left.
//
//   npx vitest run outside
import { deepStrictEqual, ok, strictEqual } from 'node:assert'
import { rest, run, system } from './checks.mts'
import { Cancelled, forNet } from '../src/index.ts'
import { explore, onSchedule } from '../src/testing.ts'
import { nextTurn } from '../src/turn.ts'

const state = forNet()

/** A system whose work is waiting is not at rest, so what it has done so far is waited for by turns. */
const turns = (count: number): Promise<void> => new Promise((resolve) => { let left = count; const tick = (): void => { if (left-- <= 0) resolve(); else nextTurn(tick) }; tick() })

/** A promise and the two ways to end it. */
const held = <T,>() => {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

type Opening = { data: { found: string | null; failure: string | null }; states: { checking: {}; shown: {}; left: {} } }
type OpeningEvent = { type: 'LEAVE' }

/** A state that waits for outside work and then does something the kernel cannot take back. */
const opening = (work: PromiseLike<string>, saw: string[]) => state<Opening, OpeningEvent>()({
  data: { found: null, failure: null },
  initial: 'checking',
  states: {
    checking: {
      on: { LEAVE: () => ({ at: 'left' }) },
      async run({ outside }) {
        try {
          const found = await outside(work)
          saw.push(`effect ${found}`)
          return { at: 'shown', data: { found } }
        } catch (error) {
          saw.push(error instanceof Cancelled ? `Cancelled: ${error.message}` : `threw ${String(error)}`)
          throw error
        } finally {
          saw.push('finally')
        }
      },
      failed: (error) => ({ data: { failure: String(error) } }),
    },
    shown: {},
    left: {},
  },
})

await run([
  ['it gives what the work ends with, while the state is the case', async () => {
    const saw: string[] = []
    const work = held<string>()
    const sys = system({ side: 'window' })
    const handle = sys.start('o', opening(work.promise, saw))
    await turns(4)
    strictEqual(sys.read(handle).at, 'checking')
    work.resolve('thread')
    await rest()
    deepStrictEqual({ at: sys.read(handle).at, data: sys.read(handle).data }, { at: 'shown', data: { found: 'thread', failure: null } })
    deepStrictEqual(saw, ['effect thread', 'finally'])
  }],

  ['what the work throws is thrown where it is awaited, and is the failure of the state\'s work', async () => {
    const saw: string[] = []
    const work = held<string>()
    const sys = system({ side: 'window' })
    const handle = sys.start('o', opening(work.promise, saw))
    work.reject(new Error('no such entity'))
    await rest()
    strictEqual(sys.read(handle).at, 'checking')
    strictEqual(sys.read(handle).data.failure, 'Error: no such entity')
    deepStrictEqual(saw, ['threw Error: no such entity', 'finally'])
  }],

  ['a state left while it waits is given Cancelled there: finally runs, and nothing after the wait does', async () => {
    const saw: string[] = []
    const work = held<string>()
    const sys = system({ side: 'window' })
    const handle = sys.start('o', opening(work.promise, saw))
    await turns(4)
    sys.send(handle, { type: 'LEAVE' })
    await rest()
    deepStrictEqual(saw, ['Cancelled: outside work was cancelled before it finished', 'finally'])
    // The work is not stopped, and what it ends with later reaches nothing.
    work.resolve('thread')
    await rest()
    deepStrictEqual(saw, ['Cancelled: outside work was cancelled before it finished', 'finally'])
    deepStrictEqual({ at: sys.read(handle).at, data: sys.read(handle).data }, { at: 'left', data: { found: null, failure: null } })
    strictEqual(sys.idle(), true)
  }],

  ['work that fails after its state was left fails nothing', async () => {
    const saw: string[] = []
    const traces: string[] = []
    const work = held<string>()
    const sys = system({ side: 'window', trace: (line) => { traces.push(line) } })
    const handle = sys.start('o', opening(work.promise, saw))
    await turns(4)
    sys.send(handle, { type: 'LEAVE' })
    work.reject(new Error('aborted'))
    await rest()
    strictEqual(sys.read(handle).data.failure, null)
    deepStrictEqual(traces.filter((line) => /DEFECT|failed/.test(line)), [])
  }],

  ['one that was waited for is not heard from when the state is left afterwards', async () => {
    const order: string[] = []
    const first = held<string>()
    const second = held<string>()
    const twice = state<{ states: { working: {}; left: {} } }, { type: 'LEAVE' }>()({
      initial: 'working',
      states: {
        working: {
          on: { LEAVE: () => ({ at: 'left' }) },
          async run({ outside }) {
            const kept = outside(first.promise)
            kept.then((value) => { order.push(`first ${value}`) }, (error) => { order.push(`first ${String(error)}`) })
            await kept
            try { await outside(second.promise) } catch (error) { order.push(`second ${error instanceof Cancelled}`); throw error }
          },
          failed: () => { order.push('failed') },
        },
        left: {},
      },
    })
    const sys = system({ side: 'window' })
    const handle = sys.start('t', twice)
    first.resolve('done')
    await turns(4)
    sys.send(handle, { type: 'LEAVE' })
    await rest()
    deepStrictEqual(order, ['first done', 'second true'])
  }],

  ['one still waiting when its work finishes is cancelled, as a sleep is', async () => {
    const saw: string[] = []
    const slow = held<string>()
    const racing = state<{ states: { working: {}; done: {} } }>()({
      initial: 'working',
      states: {
        working: {
          async run({ outside }) {
            outside(slow.promise).then((value) => { saw.push(`slow ${value}`) }, (error) => { saw.push(error instanceof Cancelled ? 'slow Cancelled' : `slow ${String(error)}`) })
            await outside(Promise.resolve('fast'))
            return { at: 'done' }
          },
          failed: () => { saw.push('failed') },
        },
        done: {},
      },
    })
    const sys = system({ side: 'window' })
    const handle = sys.start('r', racing)
    await rest()
    strictEqual(sys.read(handle).at, 'done')
    deepStrictEqual(saw, ['slow Cancelled'])
    slow.resolve('late')
    await rest()
    deepStrictEqual(saw, ['slow Cancelled'])
  }],

  ['called by work whose state was already left, it is Cancelled at once and takes what the work ends with', async () => {
    const saw: string[] = []
    const gate = held<void>()
    const late = held<string>()
    const lingering = state<{ states: { working: {}; left: {} } }, { type: 'LEAVE' }>()({
      initial: 'working',
      states: {
        working: {
          on: { LEAVE: () => ({ at: 'left' }) },
          async run({ outside }) {
            // A wait the kernel does not own: the body goes on after its state was left.
            await gate.promise
            try { await outside(late.promise) } catch (error) { saw.push(error instanceof Cancelled ? 'Cancelled' : String(error)) }
            saw.push('went on')
          },
          failed: () => { saw.push('failed') },
        },
        left: {},
      },
    })
    const sys = system({ side: 'window' })
    const handle = sys.start('l', lingering)
    await turns(4)
    sys.send(handle, { type: 'LEAVE' })
    gate.resolve()
    await rest()
    deepStrictEqual(saw, ['Cancelled', 'went on'])
    // Nothing is waiting for it by now, and its failing is still not the process's.
    late.reject(new Error('too late'))
    await rest()
    strictEqual(sys.idle(), true)
  }],

  ['a value that is not a promise is given as it is', async () => {
    const saw: string[] = []
    const sys = system({ side: 'window' })
    const handle = sys.start('o', opening('plain' as unknown as PromiseLike<string>, saw))
    await rest()
    strictEqual(sys.read(handle).data.found, 'plain')
  }],

  ['in an ask\'s handler, the answering state being left ends the wait and the ask is abandoned', async () => {
    const saw: string[] = []
    const work = held<string>()
    type Asks = { FIND: { args: {}; answer: string } }
    const answerer = state<{ states: { open: {}; shut: {} } }, { type: 'SHUT' }, Asks>()({
      initial: 'open',
      states: {
        open: {
          on: { SHUT: () => ({ at: 'shut' }) },
          answers: {
            FIND: async (_, { outside }) => {
              try { return await outside(work.promise) } catch (error) { saw.push(error instanceof Cancelled ? 'Cancelled' : String(error)); throw error }
            },
          },
        },
        shut: {},
      },
    })
    const sys = system({ side: 'backend' })
    const handle = sys.start('a', answerer)
    const finding = sys.ask(handle, 'FIND', {})
    await turns(4)
    sys.send(handle, { type: 'SHUT' })
    const found = await finding
    await rest()
    strictEqual(!found.ok && found.failure.kind, 'abandoned')
    deepStrictEqual(saw, ['Cancelled'])
    work.resolve('late')
    await rest()
    strictEqual(sys.idle(), true)
  }],

  ['in an ask\'s handler, whoever asked going ends the wait, and the state that was answering stays where it was', async () => {
    const saw: string[] = []
    const work = held<string>()
    type Asks = { FIND: { args: {}; answer: string } }
    type AskerNet = { systems: { finder: { events: never; asks: Asks } }; surfaces: {}; views: {} }
    const answerer = state<{ states: { open: {} } }, never, Asks>()({
      initial: 'open',
      states: {
        open: {
          answers: {
            FIND: async (_, { outside }) => {
              try { return await outside(work.promise) } catch (error) { saw.push(error instanceof Cancelled ? 'Cancelled' : String(error)); throw error }
            },
          },
        },
      },
    })
    const asker = forNet<AskerNet>()<{ states: { asking: {}; done: {} } }, { type: 'LEAVE' }>()({
      initial: 'asking',
      states: {
        asking: {
          on: { LEAVE: () => ({ at: 'done' }) },
          async run({ ask }) { await ask('finder', 'FIND', {}) },
          failed: () => { saw.push('asker failed') },
        },
        done: {},
      },
    })
    const sys = system({ side: 'backend' })
    const answering = sys.start('finder', answerer)
    const asking = sys.start('asker', asker)
    await turns(4)
    deepStrictEqual(saw, [])
    sys.send(asking, { type: 'LEAVE' })
    await rest()
    deepStrictEqual(saw, ['Cancelled'])
    strictEqual(sys.read(answering).at, 'open')
    work.resolve('late')
    await rest()
    strictEqual(sys.idle(), true)
  }],

  ['a thenable that throws as it is read is the failure of the work, as one that rejects is', async () => {
    const saw: string[] = []
    const broken = Object.defineProperty({}, 'then', { get: () => { throw new Error('no then') } }) as PromiseLike<string>
    const sys = system({ side: 'window' })
    const handle = sys.start('o', opening(broken, saw))
    await rest()
    strictEqual(sys.read(handle).data.failure, 'Error: no then')
    deepStrictEqual(saw, ['threw Error: no then', 'finally'])
  }],
], async (tally) => {
  await tally.every('outside work racing a leaving event under every ordering has its effect only while the state is the case', () =>
    explore((schedule) => {
      const effects: string[] = []
      const failed: unknown[] = []
      const raced = state<{ states: { checking: {}; shown: {}; left: {} } }, { type: 'LEAVE' }>()({
        initial: 'checking',
        states: {
          checking: {
            on: { LEAVE: () => ({ at: 'left' }) },
            async run({ outside }) {
              const found = await outside(schedule.work('reading the entity', 'thread'))
              effects.push(found)
              return { at: 'shown' }
            },
            failed: (error) => { failed.push(error) },
          },
          shown: { on: { LEAVE: () => ({ at: 'left' }) } },
          left: {},
        },
      })
      const sys = system({ side: 'window', ...onSchedule(schedule, 'the window') })
      const handle = sys.start('o', raced)
      let effectsAtLeaving = -1
      schedule.does('the user', ['LEAVE', () => { sys.send(handle, { type: 'LEAVE' }); effectsAtLeaving = effects.length }])
      return () => {
        deepStrictEqual(failed, [])
        strictEqual(sys.idle(), true)
        strictEqual(sys.read(handle).at, 'left')
        ok(effects.length <= 1)
        // Whatever it did, it had done by the time the state was left.
        strictEqual(effects.length, effectsAtLeaving)
      }
    }))
})
