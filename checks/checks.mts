// What a check file is written with. Three things, each because a check that fails has to fail, and not hang.
//
// `system` is the kernel's, with every system a check makes stopped when the check ends, however it ends: a check
// that fails part-way leaves nothing running to keep the process alive.
//
// It is also given a limit on how many steps it will take. A kernel that asks itself round without end would
// otherwise go on for good, and the check would never be heard from. The app sets no limit: an agent's loop is one
// thing leading to the next for as long as it runs.
//
// `run` makes the checks the cases of a spec file, each with its own name, so that one can be run alone
// (`npx vitest run -t "<name>"`) and a failing one is named.
import { beforeAll, it } from 'vitest'
import { type System } from '../src/index.ts'
import { system as kernel } from '../src/kernel.ts'
import type { Explored } from '../src/schedule.ts'
import { nextTurn } from '../src/turn.ts'

const made: System[] = []
/** More steps than this in one check is a kernel that does not come to rest. */
const LIMIT = 200_000

export const system: typeof kernel = (host) => {
  const one = kernel({ limit: LIMIT, ...host })
  made.push(one)
  return one
}
/** More turns than this without coming to rest is waiting on what never comes. */
const TURNS = 5_000
const turn = (): Promise<void> => new Promise<void>((resolve) => { nextTurn(resolve) })

/**
 * Waits until everything a check started has come to rest: every system it made has nothing under way. That is what
 * a check means by waiting, where a count of turns is a guess at how long that takes. One that never comes to rest
 * fails, saying so.
 */
export async function rest(): Promise<void> {
  const atRest = (): boolean => made.every((one) => one.idle())
  for (let turns = 0; turns < TURNS; turns++) {
    await turn()
    // Twice, a turn apart: what one thing ending leads to has had its turn to begin.
    if (atRest() && (await turn(), atRest())) return
  }
  throw new Error(`Still not at rest after ${TURNS} turns: something is waiting on what never comes`)
}

const stopAll = (): void => { for (const one of made.splice(0).reverse()) { try { one.stop() } catch { /* it was stopping anyway */ } } }

/** The first lines of what was thrown, which is what a failure says. */
const said = (error: unknown, lines: number): string => String(error).split('\n').slice(0, lines).join(' ')

export interface Tally {
  /** A scenario run under every ordering, or a seed's worth: it passes if none failed and, unless sampled, all were run. */
  every(name: string, explored: () => Promise<Explored>, how?: 'all' | 'sampled'): Promise<void>
  /** One more check, for what is not one of the list. */
  check(name: string, body: () => void | Promise<void>): Promise<void>
}

/**
 * Makes each check a case of the file it is in, in the order given, and one more after them all: that none of it
 * left a rejection unhandled. A case runs after the ones before it have ended, so one may read what an earlier one
 * left. Each case stops every system it made, however it ends.
 */
export async function run(checks: ReadonlyArray<readonly [string, () => void | Promise<void>]>, more?: (tally: Tally) => Promise<void>): Promise<void> {
  const unhandled: unknown[] = []
  const heard = (reason: unknown): void => { unhandled.push(reason) }
  // Node says so to the process, and a window to itself.
  const inWindow = (event: Event): void => { heard((event as PromiseRejectionEvent).reason) }
  const node = typeof process !== 'undefined' && typeof process.on === 'function'
  beforeAll(() => { if (node) process.on('unhandledRejection', heard); else globalThis.addEventListener('unhandledrejection', inWindow) })
  const check = (name: string, body: () => void | Promise<void>): Promise<void> => {
    it(name, async () => { try { await body() } finally { stopAll() } })
    return Promise.resolve()
  }
  for (const [name, body] of checks) await check(name, body)
  await more?.({
    check,
    every: (name, explored, how = 'all') => {
      it(name, async ({ annotate }) => {
        try {
          const found = await explored()
          if (found.failure) throw new Error(`${said(found.failure.error, 6)}\n  after: ${found.failure.taken.join(' → ')}\n  replay: [${found.failure.choices.join(', ')}]`)
          // An exploration that stopped at its limit proved only what it ran, and says so by failing.
          if (how === 'all' && !found.complete) throw new Error(`stopped at ${found.orderings} orderings with more to run`)
          if (found.orderings < 2) throw new Error('there was only one ordering, so nothing was explored')
          await annotate(`${found.orderings} orderings${how === 'all' ? ', all there are' : ' from one seed, of more than can all be run'}`)
        } finally { stopAll() }
      })
      return Promise.resolve()
    },
  })
  it('none of it left a rejection unhandled', async () => {
    await new Promise<void>((resolve) => nextTurn(resolve))
    if (node) process.off('unhandledRejection', heard); else globalThis.removeEventListener('unhandledrejection', inWindow)
    if (unhandled.length) throw new Error(said(unhandled[0], 8))
  })
}
