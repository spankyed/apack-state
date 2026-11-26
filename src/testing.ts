/// <reference lib="esnext.disposable" preserve="true" />
// What a pack's checks are written with: the schedule of `@apackdev/orderings`, which runs a scenario under every
// order, a system on it, and scenarios made from the events a state declares. `@apackdev/state/testing`.
//
// A scenario builds systems on the schedule it is handed and returns what must hold once everything has come to rest.
// What each system puts off, and its frames, are lanes of the schedule, as are what a user does and outside work, so
// the schedule chooses the order between them; `everyOrder` runs every one, and `sample` a seed's worth.
import type { Lane } from './port.ts'
import { dial, join, listen, memoryPair, type Link } from '@apackdev/link'
import { sample, type Clock, type Schedule } from '@apackdev/orderings'
import type { AnyEvent, Asks, Handle, RootGiven, Shape, State, Value } from './types.ts'
import { system as kernel, type Defect, type System } from './kernel.ts'

export { everyOrder, explore, replay, sample, type Clock, type Explored, type Scenario, type Schedule } from '@apackdev/orderings'
export type { Defect } from './kernel.ts'

/** A window and a backend joined across `@apackdev/link` over an in-memory transport. */
export interface Connected {
  /** Closes the link: both ends see it end, as when a real connection closes. */
  close(): void
  [Symbol.dispose](): void
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
  return { close: () => { windowLink.close() }, [Symbol.dispose]: () => { windowLink.close() }, window: windowLink, backend: backendLink }
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

export type FromEvents<S extends Shape, E extends AnyEvent, A extends Asks, G extends string = never> = {
  /** The state, and a maker for each event it declares under `on`. A declared event with no maker is refused. */
  readonly state: State<S, E, A, G>
  readonly events: Makers<E>
  /** Sets up what the state runs in: the systems it reaches, started on this one. Optional. */
  readonly around?: (system: System, schedule: Schedule) => void
  /** Holds after every step that changed anything: what is read of the state then, and the events sent so far. */
  readonly always: (value: Value<S>, sent: readonly E[]) => void
  /** How many events a run sends, how many runs, and the seed they are drawn from. */
  readonly steps: number
  readonly runs: number
  readonly seed: number
} & ([G] extends [never] ? { readonly given?: never } : { readonly given: RootGiven<State<S, E, A, G>> })

/**
 * Scenarios made from the events a state declares: each run sends `steps` of them, drawn from the seed, one after
 * another as a user would, under an ordering drawn from the same seed, and `always` is held after every step that
 * changed anything. Throws for the first run that fails, naming the seed that makes it again and the events it sent.
 */
export async function fromEvents<S extends Shape, E extends AnyEvent, A extends Asks, G extends string = never>(options: FromEvents<S, E, A, G>): Promise<void> {
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
        const handle = (running.start as (ref: string, state: State<S, E, A, G>, entering: unknown) => Handle<Value<S>, E, A>)('under test', options.state, options.given)
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

/** Options for `waitFor`: a timeout (in ms, using `clock.after` when given) and/or an `AbortSignal`. */
export interface WaitForOptions {
  /** Reject if the predicate has not matched within this many milliseconds. */
  readonly timeout?: number
  /** Clock whose `after` schedules `timeout` (defaults to `setTimeout`). */
  readonly clock?: Pick<Clock, 'after'>
  /** Reject early if aborted before the predicate matches. */
  readonly signal?: AbortSignal
}

/**
 * Waits until a running state's value matches `predicate`, resolving with that value. Checks the current value first;
 * rejects if `predicate` throws, the state is not running (or stops before matching), `timeout` elapses, or `signal`
 * aborts. Always unsubscribes and clears any timer or abort listener on settlement.
 */
export function waitFor<V, S extends V>(
  sys: System,
  handle: Handle<V, never, Asks, any>,
  predicate: (value: V) => value is S,
  options?: WaitForOptions,
): Promise<S>
export function waitFor<V>(
  sys: System,
  handle: Handle<V, never, Asks, any>,
  predicate: (value: V) => boolean,
  options?: WaitForOptions,
): Promise<V>
export function waitFor<V>(
  sys: System,
  handle: Handle<V, never, Asks, any>,
  predicate: (value: V) => boolean,
  options: WaitForOptions = {},
): Promise<V> {
  if (options.signal?.aborted) return Promise.reject(options.signal.reason)
  const current = sys.read(handle) as V | undefined
  if (current === undefined) return Promise.reject(new Error(`${handle.ref} is not running`))
  try { if (predicate(current)) return Promise.resolve(current) } catch (error) { return Promise.reject(error) }
  return new Promise<V>((resolve, reject) => {
    let cancelTimer: (() => void) | undefined
    const onAbort = (): void => { cleanup(); reject(options.signal!.reason) }
    const cleanup = (): void => {
      unsubscribe()
      cancelTimer?.()
      options.signal?.removeEventListener('abort', onAbort)
    }
    const unsubscribe = sys.subscribe((changed) => {
      if (!changed.includes(handle.ref)) return
      const next = sys.read(handle) as V | undefined
      if (next === undefined) { cleanup(); reject(new Error(`${handle.ref} stopped before waitFor matched`)); return }
      try { if (predicate(next)) { cleanup(); resolve(next) } } catch (error) { cleanup(); reject(error) }
    })
    options.signal?.addEventListener('abort', onAbort)
    if (options.timeout !== undefined) {
      const onTimeout = (): void => { cleanup(); reject(new Error(`waitFor(${handle.ref}) timed out after ${options.timeout}ms`)) }
      if (options.clock) cancelTimer = options.clock.after(options.timeout, onTimeout)
      else { const id = setTimeout(onTimeout, options.timeout); cancelTimer = () => { clearTimeout(id) } }
    }
  })
}

/** Records every structured kernel `Defect` and fails on any that were not explicitly allowed. */
export interface DefectGuard {
  /** Pass directly as `system({ onDefect: guard.onDefect })`. */
  readonly onDefect: (defect: Defect) => void
  /** Every structured defect recorded so far (in order). */
  readonly defects: readonly Defect[]
  /** Allows defects matching `pattern` (substring or regex on `defect.message`, or a predicate on `Defect`). */
  allow(pattern: string | RegExp | ((defect: Defect) => boolean)): void
  /** Throws if any unallowed defect was reported. Also called automatically by `[Symbol.dispose]()`. */
  assertNone(): void
  [Symbol.dispose](): void
}

/**
 * Watches a system's `onDefect` hook so tests cannot silently swallow handler throws or refused changes.
 * Pair with `using` in LIFO order:
 *
 *   using guard = defectGuard()
 *   using sys = system({ side: 'backend', onDefect: guard.onDefect })
 *
 * Disposing stops `sys` first (capturing any teardown defects) and then runs `guard.assertNone()`.
 */
export function defectGuard(forward?: (defect: Defect) => void): DefectGuard {
  const defects: Defect[] = []
  const allowed = new Set<string | RegExp | ((defect: Defect) => boolean)>()
  const matches = (defect: Defect): boolean => {
    for (const pattern of allowed) {
      if (typeof pattern === 'function') { if (pattern(defect)) return true }
      else if (typeof pattern === 'string' ? defect.message.includes(pattern) : defect.message.search(pattern) >= 0) return true
    }
    return false
  }
  const assertNone = (): void => {
    const unexpected = defects.filter((defect) => !matches(defect))
    if (!unexpected.length) return
    const cause = unexpected.find((d) => d.error !== undefined)?.error
    const message = `Unexpected kernel defect(s):\n${unexpected.map((d) => `DEFECT: ${d.message}`).join('\n')}`
    throw cause === undefined ? new Error(message) : new Error(message, { cause })
  }
  return {
    onDefect: (defect) => {
      defects.push(defect)
      forward?.(defect)
    },
    defects,
    allow: (pattern) => { allowed.add(pattern) },
    assertNone,
    [Symbol.dispose]: assertNone,
  }
}
