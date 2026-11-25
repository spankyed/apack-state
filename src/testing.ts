// What a pack's checks are written with: the schedule of `@apackdev/orderings`, which runs a scenario under every
// order, a system on it, and scenarios made from the events a state declares. `@apackdev/state/testing`.
//
// A scenario builds systems on the schedule it is handed and returns what must hold once everything has come to rest.
// What each system puts off, and its frames, are lanes of the schedule, as are what a user does and outside work, so
// the schedule chooses the order between them; `everyOrder` runs every one, and `sample` a seed's worth.
import type { Lane } from './port.ts'
import { dial, join, listen, memoryPair, type Link } from '@apackdev/link'
import { sample, type Clock, type Schedule } from '@apackdev/orderings'
import type { AnyEvent, Asks, Shape, State, Value } from './types.ts'
import { system as kernel, type System } from './kernel.ts'

export { everyOrder, explore, replay, sample, type Clock, type Explored, type Scenario, type Schedule } from '@apackdev/orderings'

/** A window and a backend joined across `@apackdev/link` over an in-memory transport. */
export interface Connected {
  /** Closes the link: both ends see it end, as when a real connection closes. */
  close(): void
  readonly window: Link
  readonly backend: Link
}

/**
 * Joins a window and a backend across `@apackdev/link` over an in-memory transport. Given a schedule, each direction
 * of the link is a lane of its own, so every ordering of the two systems and the link is explored together.
 */
export function connect(window: System, backend: System, schedule?: Pick<Schedule, 'later'>, name = 'the window'): Connected {
  const up: Lane = { label: `${name} to its backend` }
  const down: Lane = { label: `the backend to ${name}` }
  const [windowSide, backendSide] = schedule
    ? memoryPair((run) => schedule.later(up, run), (run) => schedule.later(down, run))
    : memoryPair()
  const windowLink = dial(windowSide)
  const backendLink = listen(backendSide)
  const toBackend = join(windowLink, window.port)
  let detachBackend: () => void
  try { detachBackend = window.attach(toBackend) } catch (error) { windowLink.close(); throw error }
  const toWindow = join(backendLink, backend.port)
  let detachWindow: () => void
  try { detachWindow = backend.attach(toWindow) } catch (error) { detachBackend(); windowLink.close(); throw error }
  windowLink.onEnd(detachBackend)
  backendLink.onEnd(detachWindow)
  return { close: () => { windowLink.close() }, window: windowLink, backend: backendLink }
}

/**
 * What a system is given to run on a schedule: what it puts off goes into the lanes it names, its frames into a
 * lane of their own, and its clock is the schedule's clock, so the schedule chooses when each runs. Spread into
 * `system({ side, ...onSchedule(schedule) })`.
 */
export function onSchedule(schedule: Schedule, name = 'a system'): { later(lane: Lane, run: () => void): void; frame(run: () => void): void; clock: Clock } {
  const frames: Lane = { label: `${name}'s frame` }
  return { later: (lane, run) => schedule.later(lane, run), frame: (run) => schedule.later(frames, run), clock: schedule.clock }
}

/** Numbers drawn from a seed: the same seed, the same draws. */
export interface Random {
  /** A whole number from 0 up to, not including, `below`. */
  int(below: number): number
  /** One of these. */
  pick<T>(from: readonly T[]): T
}
const seeded = (seed: number): Random => {
  let state = seed >>> 0
  const next = (): number => { state = (state + 0x6d2b79f5) >>> 0; let t = state; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }
  return {
    int: (below) => Math.floor(next() * below),
    pick: (from) => { if (!from.length) throw new Error('There is nothing to pick from'); return from[Math.floor(next() * from.length)]! },
  }
}

/** Every event a definition takes under `on`, at any depth: what the state declares it may be sent. */
type Declared = { readonly on?: Record<string, unknown>; readonly states?: Record<string, Declared> }
const declared = (def: unknown): Set<string> => {
  const found = new Set<string>()
  // A definition, and every state in it, is an object: what the types let a state be.
  const walk = ({ on, states }: Declared): void => {
    for (const type of Object.keys(on ?? {})) found.add(type)
    for (const inner of Object.values(states ?? {})) walk(inner)
  }
  walk(def as Declared)
  return found
}

/** One way to make each event a state takes, keyed by its type: what `fromEvents` sends. */
export type Makers<E extends AnyEvent> = { readonly [K in E['type']]: (random: Random) => Extract<E, { type: K }> }

export interface FromEvents<S extends Shape, E extends AnyEvent, A extends Asks> {
  /** The state, and a maker for each event it declares under `on`. A declared event with no maker is refused. */
  readonly state: State<S, E, A>
  readonly events: Makers<E>
  /** Sets up what the state runs in: the systems it reaches, started on this one. Optional. */
  readonly around?: (system: System, schedule: Schedule) => void
  /** Holds after every step that changed anything: what is read of the state then, and the events sent so far. */
  readonly always: (value: Value<S>, sent: readonly E[]) => void
  /** How many events a run sends, how many runs, and the seed they are drawn from. */
  readonly steps: number
  readonly runs: number
  readonly seed: number
}

/**
 * Scenarios made from the events a state declares: each run sends `steps` of them, drawn from the seed, one after
 * another as a user would, under an ordering drawn from the same seed, and `always` is held after every step that
 * changed anything. Throws for the first run that fails, naming the seed that makes it again and the events it sent.
 */
export async function fromEvents<S extends Shape, E extends AnyEvent, A extends Asks>(options: FromEvents<S, E, A>): Promise<void> {
  const types = [...declared(options.state.def)].sort()
  const missing = types.filter((type) => !(type in options.events))
  if (missing.length) throw new Error(`No way to make ${missing.join(', ')}, which the state declares it takes`)
  if (!types.length) throw new Error('The state declares no events it takes, so there is nothing to send it')
  for (let run = 0; run < options.runs; run++) {
    const seed = (options.seed + run) >>> 0
    const random = seeded(seed)
    const sent: E[] = []
    const events = Array.from({ length: options.steps }, () => (options.events as Record<string, (random: Random) => E>)[random.pick(types)]!(random))
    // The ordering is drawn from a seed of its own, drawn from the run's after its events: drawn from the run's seed
    // itself, its first choices would be the events' first draws, and some pairings of event and order never made.
    const ordering = random.int(0x100000000)
    let sys: System | undefined
    let explored
    try {
      explored = await sample((schedule) => {
        sys = kernel({ side: 'window', ...onSchedule(schedule, 'the window') })
        const running = sys
        options.around?.(running, schedule)
        const handle = running.start('under test', options.state)
        let failure: unknown
        const unsubscribe = running.subscribe(() => {
          if (failure !== undefined) return
          try { options.always(running.read(handle) as Value<S>, sent) } catch (error) { failure = error }
        })
        // Once something has not held, nothing more is sent: what the run sent is what it failed after.
        schedule.does('the user', ...events.map((event) => [event.type, () => {
          if (failure !== undefined) return
          sent.push(event)
          running.send(handle, event as never)
        }] as const))
        return () => {
          // What stopping does is not a step of the state's.
          unsubscribe()
          if (failure !== undefined) throw failure
        }
      }, { seed: ordering, runs: 1 })
    } finally {
      // However the run ended, what it started is stopped.
      sys?.stop()
    }
    if (explored.failure) {
      const error = explored.failure.error
      throw new Error(`Run ${run + 1}, from seed ${seed}, failed after sending ${sent.map((event) => event.type).join(', ') || 'nothing'}:\n${error instanceof Error ? error.message : String(error)}`, { cause: error })
    }
  }
}
