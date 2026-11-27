// `outside(work)`: work the kernel did not start, waited for as an ask or a sleep is. It gives what the work ends with
// while its owner is there, and ends with `Cancelled` where it is awaited once the owner has gone, so nothing after
// it runs for a state that was left.
//
// No check here waits for a while. `start` runs a state's `run` as far as its first `await`, so its wait is under way
// when `start` returns; where the order of the work and a leaving is the point, every order is run.
//
//   npx vitest run outside
import { deepStrictEqual, ok, strictEqual } from 'node:assert'
import { rest, run, system } from './checks.mts'
import { Cancelled, forNet } from '../src/index.ts'
import { explore, onSchedule } from '../src/testing.ts'
import { nextTurn } from '../src/turn.ts'

const state = forNet()

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
    strictEqual(sys.read(handle).at, 'checking')
    work.resolve('thread')
    await rest()
    deepStrictEqual({ at: sys.read(handle).at, data: sys.read(handle).data }, { at: 'shown', data: { found: 'thread', failure: null } })
    deepStrictEqual(saw, ['effect thread', 'finally'])
  }],

  ['what the work throws is thrown where it is awaited, and is the failure of the state\'s work', async () => {
    const saw: string[] = []
    const traces: string[] = []
    const work = held<string>()
    const sys = system({ side: 'window', trace: (line) => { traces.push(line) } })
    const handle = sys.start('o', opening(work.promise, saw))
    work.reject(new Error('no such entity'))
    await rest()
    strictEqual(sys.read(handle).at, 'checking')
    strictEqual(sys.read(handle).data.failure, 'Error: no such entity')
    deepStrictEqual(saw, ['threw Error: no such entity', 'finally'])
    // It was waited for, so it is the work's failure and not one that came too late.
    deepStrictEqual(traces.filter((line) => /no longer waiting/.test(line)), [])
  }],

  ['a state left while it waits is given Cancelled there: finally runs, and nothing after the wait does', async () => {
    const saw: string[] = []
    const work = held<string>()
    const sys = system({ side: 'window' })
    const handle = sys.start('o', opening(work.promise, saw))
    sys.send(handle, { type: 'LEAVE' })
    await rest()
    deepStrictEqual(saw, ['Cancelled: waiting for outside work was cancelled before it finished', 'finally'])
    // The work is not stopped, and what it ends with later reaches nothing.
    work.resolve('thread')
    await rest()
    deepStrictEqual(saw, ['Cancelled: waiting for outside work was cancelled before it finished', 'finally'])
    deepStrictEqual({ at: sys.read(handle).at, data: sys.read(handle).data }, { at: 'left', data: { found: null, failure: null } })
    strictEqual(sys.idle(), true)
  }],

  ['work that fails after its state was left fails nothing, and is said', async () => {
    const saw: string[] = []
    const traces: string[] = []
    const work = held<string>()
    const sys = system({ side: 'window', trace: (line) => { traces.push(line) } })
    const handle = sys.start('o', opening(work.promise, saw))
    sys.send(handle, { type: 'LEAVE' })
    work.reject(new Error('aborted'))
    await rest()
    strictEqual(sys.read(handle).data.failure, null)
    deepStrictEqual(traces.filter((line) => /DEFECT|failed/.test(line)), ['o in checking was no longer waiting for outside work when it failed: aborted'])
  }],

  ['and a state with no states inside it is named alone when its outside work fails too late', async () => {
    const traces: string[] = []
    const work = held<string>()
    const whole = state<{}>()({ async run({ outside }) { await outside(work.promise) }, failed: () => {} })
    const sys = system({ side: 'window', trace: (line) => { traces.push(line) } })
    const handle = sys.start('w', whole)
    sys.stop(handle)
    work.reject(new Error('aborted'))
    await rest()
    deepStrictEqual(traces.filter((line) => /no longer waiting/.test(line)), ['w was no longer waiting for outside work when it failed: aborted'])
  }],

  ['a state left after its outside work ended, and before its work went on, is Cancelled there: the work does not go on', async () => {
    for (const ending of ['resolve', 'reject'] as const) {
      const saw: string[] = []
      const traces: string[] = []
      const work = held<string>()
      const sys = system({ side: 'window', trace: (line) => { traces.push(line) } })
      const handle = sys.start('o', opening(work.promise, saw))
      if (ending === 'resolve') work.resolve('thread')
      else work.reject(new Error('no such entity'))
      // A leaving sent from a promise callback queued behind the work's ending.
      await Promise.resolve().then(() => { sys.send(handle, { type: 'LEAVE' }) })
      await rest()
      deepStrictEqual(saw, ['Cancelled: waiting for outside work was cancelled before it finished', 'finally'])
      deepStrictEqual({ at: sys.read(handle).at, data: sys.read(handle).data }, { at: 'left', data: { found: null, failure: null } })
      deepStrictEqual(traces.filter((line) => /outside work/.test(line)), ending === 'resolve' ? [] : ['o in checking was no longer waiting for outside work when it failed: no such entity'])
      strictEqual(sys.idle(), true)
    }
  }],

  ['a system is not idle between outside work ending and its work going on', async () => {
    const saw: string[] = []
    const work = held<string>()
    const sys = system({ side: 'window' })
    sys.start('o', opening(work.promise, saw))
    work.resolve('thread')
    await Promise.resolve()
    await Promise.resolve()
    deepStrictEqual(saw, [])
    strictEqual(sys.idle(), false)
    await rest()
    deepStrictEqual(saw, ['effect thread', 'finally'])
  }],

  ['what outside work ends with is put off in a lane of its own, named for the system, so a schedule can order it', async () => {
    const saw: string[] = []
    const lanes: string[] = []
    const work = held<string>()
    const sys = system({ side: 'window', name: 'the shell', later: (lane, go) => { lanes.push(lane.label); nextTurn(go) } })
    sys.start('o', opening(work.promise, saw))
    lanes.length = 0
    work.resolve('thread')
    await rest()
    deepStrictEqual(lanes.filter((label) => /outside/.test(label)), ['the shell\'s outside work'])
    deepStrictEqual(saw, ['effect thread', 'finally'])
  }],

  ['outside work that fails, started and waited for by nothing before its work ends, is said then; one waited for later is thrown there and not said', async () => {
    for (const waitsLater of [false, true]) {
      const saw: string[] = []
      const traces: string[] = []
      const failing = held<string>()
      const gate = held<void>()
      const forgetful = state<{ states: { working: {}; done: {} } }>()({
        initial: 'working',
        states: {
          working: {
            async run({ outside }) {
              const started = outside(failing.promise)
              // One that ends well with nothing waiting for it is nothing to say.
              void outside(Promise.resolve('kept by nobody'))
              await outside(gate.promise)
              saw.push('went on')
              if (waitsLater) await started
              return { at: 'done' }
            },
            failed: (error) => { saw.push(`failed ${String(error)}`) },
          },
          done: {},
        },
      })
      // Both endings have been given once the kernel has run what it put off for each.
      const given = held<void>()
      let toGive = 2
      const sys = system({ side: 'window', trace: (line) => { traces.push(line) }, later: (lane, go) => { nextTurn(() => { go(); if (/outside work/.test(lane.label) && --toGive === 0) given.resolve() }) } })
      const handle = sys.start('f', forgetful)
      failing.reject(new Error('save failed'))
      await given.promise
      // While its work is under way it may yet be waited for, so nothing is said.
      deepStrictEqual(traces.filter((line) => /outside work/.test(line)), [])
      gate.resolve()
      await rest()
      deepStrictEqual(saw, waitsLater ? ['went on', 'failed Error: save failed'] : ['went on'])
      strictEqual(sys.read(handle).at, waitsLater ? 'working' : 'done')
      deepStrictEqual(traces.filter((line) => /outside work/.test(line)), waitsLater ? [] : ['f in working did not wait for outside work it started, which failed: save failed'])
    }
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
    const broken = new Proxy({}, { get: () => { throw new Error('no then') } }) as PromiseLike<string>
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

  // Every way it can end, and each of them is one some ordering ends in.
  const endings = ['first cancelled', 'first gave,second cancelled', 'first gave,second gave']
  const ended = new Set<string>()
  await tally.every('each wait ends once, with what its work gave or with Cancelled, whatever order two works and a leaving come in', () =>
    explore((schedule) => {
      const ends: string[] = []
      const twice = state<{ states: { working: {}; done: {}; left: {} } }, { type: 'LEAVE' }>()({
        initial: 'working',
        states: {
          working: {
            on: { LEAVE: () => ({ at: 'left' }) },
            async run({ outside }) {
              for (const name of ['first', 'second']) {
                await outside(schedule.work(`the ${name} work`, name)).then(
                  (gave) => { ends.push(`${gave} gave`) },
                  (error) => { ends.push(`${name} ${error instanceof Cancelled ? 'cancelled' : 'failed'}`); throw error },
                )
              }
              return { at: 'done' }
            },
            failed: () => { ends.push('failed') },
          },
          done: { on: { LEAVE: () => ({ at: 'left' }) } },
          left: {},
        },
      })
      const sys = system({ side: 'window', ...onSchedule(schedule, 'the window') })
      const handle = sys.start('t', twice)
      schedule.does('the user', ['LEAVE', () => sys.send(handle, { type: 'LEAVE' })])
      return () => {
        strictEqual(sys.idle(), true)
        strictEqual(sys.read(handle).at, 'left')
        // A wait that gave is not heard from again when the state is left after it, and none follows one cancelled.
        ok(endings.includes(ends.join(',')), ends.join(','))
        ended.add(ends.join(','))
      }
    }).then((found) => { deepStrictEqual([...ended].sort(), endings); return found }))
})
