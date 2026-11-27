/// <reference lib="esnext.disposable" preserve="true" />
// The kernel: systems that run states, steps, asks, and the link between a backend and its windows. What a state's
// code is checked against is `types.ts`; what one system offers another is `port.ts`.
//
// A state's value is where it is and the data there:  { at: 'thread.sending', data: { … } }
//
// States run in a system. A backend system and each window's system are separate, joined by a link. Within a
// system, one message from outside and everything it causes is one step, and nothing leaves until the step commits.
//
//   tell(name, event)        to a backend system: nobody waits
//   ask(name, ask, args)     of a backend system: exactly one answer, refusal or failure comes back
//   progress(update)         from the handler of an ask, to whoever asked, before it answers. It arrives in batches
//   broadcast(name, event)   from the backend to that surface in every window
//   report(event)            from a state that was started, to the state that started it
//
//   call(name, key?)         from a state: fires one of the asks it declares under `calls`, once
//   cancel(name, key?)       cancels an in-flight call
//
// What a state starts, the views it follows and the asks it loads are declared, each naming the fields of the data
// it depends on. Which of them are live follows from the data, and is looked at again only when one of those changes.
// Those are standing: while the data says so, they go on. An imperative call is not, and is fired by saying so.

import { produce } from './draft.ts'
import { nextTurn } from './turn.ts'
import { ANSWERED, given, type AllStarts, type Answered, type AnyEvent, type AnyOutcome, type Asks, type Each, type Handle, type HandleOf, type Net, type OutcomeOf, type ProgressOf, type Read, type RootGiven, type Shape, type Started, type State, type Value, type ViewHost, type ViewUpdate } from './types.ts'
import type { Clock, Following, Lane, PeerPort, Port, PortOutcome } from './port.ts'

// ── the system ──────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * What an ask or a `sleep` is ended with when its owner has gone: the state exited, whoever asked has gone, the
 * work that started it finished, or the system stopped. It is raised where it is awaited, as cancellation is
 * everywhere else, so that `finally` runs and what was held is released. The kernel discards it at the top of `run`
 * and of an ask's handler; nothing has to catch it.
 */
export class Cancelled extends Error {
  constructor(what: string) { super(`${what} was cancelled before it finished`); this.name = 'Cancelled' }
}

/**
 * What the engine says of a write to something frozen: assigning a field, adding or removing one, and what a list's
 * `push`, `pop`, `sort` and the like come to. `kernel-check.mts` makes each kind of write and fails when one of them
 * is no longer said this way, which is what a change of engine would do.
 */
const WRITE_TO_FROZEN = /^Cannot (assign to read only property|add property|delete property|define property|redefine property)\b/
/** What is added to such an error, since what the engine says names neither the mistake nor what to do. @internal */
export const WROTE_TO_WHAT_WAS_READ = 'That is what a write to data read from a state throws. Data is not written where it is read: it is changed by returning a change, `{ data: (d) => { … } }`, and `d` is what may be written to'
/**
 * An error as the kernel reports it. A write to what a state holds throws where it was tried, in a handler or in a
 * helper the handler passed the value to, and the engine's words for it are about a property and an object. So
 * they are followed by what happened and what to write, wherever the kernel reports what was thrown.
 * @internal
 */
export const said = (error: unknown): string => {
  if (!(error instanceof Error)) return String(error)
  return error instanceof TypeError && WRITE_TO_FROZEN.test(error.message) ? `${error.message}. ${WROTE_TO_WHAT_WAS_READ}` : error.message
}
class Refusal extends Error { constructor(readonly kind: string, message: string, readonly data?: object) { super(message) } }
class Question {
  settled = false
  constructor(private readonly settle: (outcome: AnyOutcome) => void) {}
  end(outcome: AnyOutcome): void { if (!this.settled) { this.settled = true; this.settle(outcome) } }
}
/** FIFO queue with O(1) amortized dequeue and mark/cut rollback for `inside` and `outside`. */
class Queue<T> {
  private items: Array<T | undefined> = []
  private head = 0
  get any(): boolean { return this.head < this.items.length }
  peek(): T { return this.items[this.head]! }
  push(item: T): void { this.items.push(item) }
  shift(): T {
    const item = this.items[this.head]!
    this.items[this.head++] = undefined
    if (this.head === this.items.length) { this.items.length = 0; this.head = 0 }
    return item
  }
  drain(): T[] {
    const out = this.items.slice(this.head) as T[]
    this.items.length = 0; this.head = 0
    return out
  }
  mark(): number { return this.items.length }
  cut(since: number): T[] {
    const out = this.items.splice(since) as T[]
    if (this.head === this.items.length) { this.items.length = 0; this.head = 0 }
    return out
  }
}
const refusal = (kind: string, message: string, data?: object): AnyOutcome => ({ ok: false, failure: { ...data, kind, message } })

type Plain = Record<string, unknown>
type LooseDef = { data?: Plain; initial?: string; on?: Record<string, Function>; internal?: Record<string, Function>; answers?: Record<string, Function>; listen?: Function; run?: Function; failed?: Function; states?: Record<string, LooseDef>; starts?: (start: Function) => Record<string, { def: unknown; resolve?: (name: string) => string } | { state: { def: unknown; resolve?: (name: string) => string }; given: Function; each?: string }>
  follows?: (follow: Function) => Record<string, { feature: string; view: string; each?: string; from?: readonly string[]; args?: Function; updated: Function }>
  loads?: (load: Function) => Record<string, { of: string; ask: string; each?: string; from?: readonly string[]; args?: Function; done: Function; progress?: Function }>
  calls?: (calls: { one: Function; each: Function; many: Function }) => Record<string, { kind: 'one' | 'each' | 'many'; of: string; ask: string; args?: Function; done: Function; progress?: Function }>
  waits?: (waits: { one: Function; each: Function }) => Record<string, { kind: 'one' | 'each'; ms?: number; reset?: boolean; done?: Function }>
}

interface Armed { stop?: () => void }

interface Active {
  readonly top: Running
  readonly def: LooseDef
  readonly name: string
  readonly path: string
  readonly around: Active | undefined
  inside: Active | undefined
  readonly controller: AbortController
  readonly releases: Array<() => void>
  readonly questions: Set<Question>
  /** The states it has started, by where each runs. */
  readonly started: Set<string>
  /**
   * The views it follows, by name and key: what each was asked for, how to stop following it, and which views'
   * deliveries led to it being asked that.
   */
  readonly following: Map<string, Live>
  /** The asks it loads, by name and key, in the same terms. */
  readonly awaiting: Map<string, Live>
  /** The imperative calls currently in flight, by name and key. */
  readonly pending: Map<string, Live>
  /** The imperative timers currently armed, by name and key. */
  readonly waiting: Map<string, Armed>
}
/**
 * One view being followed or one ask loaded: the values of the fields it named when it was asked, how to stop it,
 * and which deliveries led to it being asked.
 */
interface Live { readonly seen: readonly unknown[]; readonly because: ReadonlySet<string>; stop: () => void }
interface Running {
  /** Every imperative ask it can call, whichever of its states declares it, and which kind each is. */
  calls: Map<string, 'one' | 'each' | 'many'>
  /** Every imperative timer it can arm, whichever of its states declares it, and which kind each is. */
  waits: Map<string, 'one' | 'each'>
  /** Optional name resolver attached by `forNet(resolve)` for bare-to-qualified target resolution. */
  readonly resolve?: (name: string) => string
  /** Memoized bare-to-qualified name mappings for this running state's lifetime. */
  readonly resolved: Map<string, string>
  /** Fields of this running state already traced as `LARGE`, freed when the state stops. */
  readonly reported: Set<string>
  ref: string; data: Plain; root: Active; starter?: { readonly ref: string; readonly from: string }
}

type Item =
  | { kind: 'event'; ref: string; event: AnyEvent; /** Sent by the state to itself. */ own?: true }
  | { kind: 'ask'; ref: string; name: string; args: object; question: Question; progress?: (update: unknown) => void; gone?: AbortSignal; chain?: readonly string[] }
  | { kind: 'result'; of: Active; value: unknown }
  | { kind: 'failure'; of: Active; error: unknown }
  | { kind: 'view'; of: Active; name: string; id: string; key: string | undefined; live: Live; update: ViewUpdate<unknown> }
  | { kind: 'done'; made: boolean; of: Active; name: string; id: string; key: string | undefined; hasInput?: boolean; input?: unknown; live: Live; outcome: AnyOutcome }
  | { kind: 'progress'; made: boolean; of: Active; name: string; id: string; key: string | undefined; hasInput?: boolean; input?: unknown; live: Live; updates: unknown[] }
  | { kind: 'call'; of: Active; name: string; key: string | undefined; hasInput: boolean; input: unknown }
  | { kind: 'cancel'; of: Active; name: string; key: string | undefined }
  | { kind: 'arm'; of: Active; name: string; key: string | undefined; ms: number | undefined }
  | { kind: 'disarm'; of: Active; name: string; key: string | undefined }
  | { kind: 'wait'; of: Active; name: string; id: string; key: string | undefined; live: Armed }
  | { kind: 'answer'; question: Question; outcome: AnyOutcome; change?: { of: Active; next: unknown } }
  | { kind: 'out'; leave: () => void; said?: Said }

type Queued = Item | { kind: 'run'; fn: () => void; stopping: boolean }

/**
 * A database's `transact`, which is all the kernel knows of one: it runs a function as one unit, whose writes are kept
 * together when it returns and undone when it throws. One inside another joins it, and is undone alone when it throws.
 */
export type Transact = <T>(run: () => T) => T

/** One thing a step handled, as its log says it: what kind, for which running state, and its name. Never what it carried. */
export interface Handled {
  readonly kind: 'event' | 'ask' | 'result' | 'failure' | 'view' | 'done' | 'progress' | 'call' | 'cancel' | 'arm' | 'disarm' | 'wait' | 'answer'
  readonly ref: string
  /** An event's type, an ask's name, what is followed, loaded, called, or waited on, as the state declares it. */
  readonly name?: string
  /** Which one, for one of many. */
  readonly key?: string
  /** An event the state sent itself. */
  readonly own?: true
}
/** One thing that was sent at a step's commit: what kind, to whom, and its name. Never what it carried. */
export interface Sent {
  readonly kind: 'answer' | 'abandoned' | 'progress' | 'tell' | 'peer' | 'ask' | 'broadcast' | 'follow' | 'unfollow'
  readonly to?: string
  readonly name?: string
  /** How an answer finished (`ok`, or its failure's kind), or `dropped` / `failed` for a peer tell. */
  readonly outcome?: string
}
type Said = Sent | (() => Sent)
/**
 * One step, once it has finished, as a timeline or a devtools panel would read it: what began it and everything it
 * handled after, the fields of each state that changed, and what was sent at its commit. Never what any of it carried.
 */
export interface StepLog {
  /** This system's steps, counted from 1. */
  readonly number: number
  /** When this step began, in milliseconds since 1970, if the system was given a clock. */
  readonly now?: number
  /** `committed`; `lost`, when its rows could not be kept and the system stopped; `halted`, when it ran away. */
  readonly status: 'committed' | 'lost' | 'halted'
  /** Everything it handled, in order: the first is what began it. */
  readonly handled: readonly Handled[]
  /** Each running state that changed: the fields of its data that did, whether it moved and where it is, and whether its pending calls or armed waits changed. */
  readonly changed: Readonly<Record<string, { readonly fields: readonly string[]; readonly moved: boolean; readonly at: string; readonly pending: boolean; readonly waiting: boolean }>>
  /** What was sent at the commit, in order. */
  readonly sent: readonly Sent[]
}


/** What changed in one running state in one step: whether it moved to another state, and whether its pending calls or armed waits changed. */
export interface Changes {
  /** Whether the state moved to a different path. */
  readonly moved: boolean
  /** Whether its pending calls changed. */
  readonly pending: boolean
  /** Whether its armed waits changed. */
  readonly waiting: boolean
}

/** A programming mistake or unrecoverable failure reported by the kernel. */
export interface Defect {
  /** Plain-English description of what went wrong (without any `DEFECT: ` prefix). */
  readonly message: string
  /** The running state involved, when the defect belongs to one. */
  readonly ref?: string
  /** The thrown error or value, when the defect was caused by a throw. */
  readonly error?: unknown
}

/** A typed named-peer handler: either a direct event callback or a `PeerPort`-shaped object. */
export type TypedPeer<E = unknown> =
  | ((event: [AnyEvent] extends [E] ? unknown : Read<E>) => void)
  | { tell(peer: string, event: [AnyEvent] extends [E] ? unknown : Read<E>): void }

export interface System<N extends Net = Net> {
  start<S extends Shape, E extends AnyEvent, A extends Asks, G extends string = never>(ref: string, made: State<S, E, A, G>, ...given: [G] extends [never] ? [] : [given: RootGiven<State<S, E, A, G>>]): Handle<Value<S>, E, A, AllStarts<S>>
  /**
   * A state that this one starts, by the name it is declared under, and by key where there is one for each. This is
   * how something outside a handler reaches one: a component reading one card of many.
   */
  child<C, K extends keyof C & string>(of: Handle<unknown, any, any, C>, name: K, ...key: C[K] extends Each<any> ? [key: string] : []): HandleOf<C[K]>
  send<E extends AnyEvent>(to: Handle<unknown, E, Asks>, event: Read<E>): void
  ask<A extends Asks, Q extends keyof A & string>(of: Handle<unknown, never, A>, name: Q, args: Read<A[Q]['args']>, progress?: (updates: ReadonlyArray<ProgressOf<A[Q]>>) => void): Promise<OutcomeOf<A[Q]>>
  read<V>(of: Started<V, never, Asks, any>): V | undefined
  read<V>(of: Handle<V, never, Asks>): V
  /** Every running state here, as of the last commit. */
  snapshot(): Record<string, unknown>
  /** Called once per step that changed anything, after it has committed, until what it returns is called. */
  subscribe(listener: (changed: readonly string[], fields: Readonly<Record<string, readonly string[]>>, changes: Readonly<Record<string, Changes>>) => void): () => void
  /** What this system offers another across a link: pass straight to `@apackdev/link`'s `join`. */
  readonly port: Port
  /**
   * Attaches another system's port to this one, and returns what detaches it. On a backend, each attached port is a
   * window that `broadcast` reaches; on a window, the attached port is its backend (one at a time).
   */
  attach(peer: Port): () => void
  /**
   * Attaches a named non-window peer to this system, and returns what detaches it. `tell({ peer: name }, event)`
   * delivers the event after the step commits, with no view hold. Accepts either a direct event callback or a
   * `PeerPort`-shaped object. Duplicate names throw.
   */
  attach<K extends NonNullable<N['peers']> extends Record<string, { events: AnyEvent }> ? keyof NonNullable<N['peers']> & string : never>(
    name: K,
    peer: TypedPeer<NonNullable<N['peers']> extends Record<string, { events: AnyEvent }> ? NonNullable<N['peers']>[K]['events'] : never>,
  ): () => void
  /**
   * Whether nothing is under way here: no work a state is doing, no ask being answered or waited on, nothing put off
   * and nothing gathered. For a check, to wait until what it did has come to rest and not for a count of turns.
   */
  idle(): boolean
  /**
   * Stops every running state in reverse start order, or, when given a top-level handle, stops only that state and
   * everything it started. Stopping a handle that is not running is a no-op; child handles started via `starts` are
   * refused at compile time (and throw synchronously or report a defect if passed at runtime).
   */
  stop(of?: Handle<unknown, never, Asks, any> & { readonly _started?: never }): void
  [Symbol.dispose](): void
}

/** More than this handled in one step is states telling each other without end: the step is cut short and reported. */
const RUNAWAY = 10_000

/** More than this many nested local asks in one call chain is cut short and reported. */
const MAX_ASK_DEPTH = 64

/** A data field holding more items than this is reported: a collection that large belongs in a view. */
const LARGE = 10_000

export function system<N extends Net = Net>(host: {
  side: 'backend' | 'window'
  /** What this system is called in a lane's label and nowhere else. */
  name?: string
  views?: ViewHost
  /**
   * The `transact` of the database this system's rows are kept in. With one, a step is a unit of it: a handler's rows,
   * the data it changed and what it sent are kept together, and a handler that changes nothing has written nothing.
   * Without one, such a handler has still said nothing.
   */
  transact?: Transact
  /**
   * Runs something later, after whatever is ahead of it in its lane. The default is the next turn of the event loop.
   * A check gives a schedule here, which decides the order between lanes and can run every one of them.
   */
  later?(lane: Lane, run: () => void): void
  /** Runs something once per frame. A window gives `requestAnimationFrame`; the default is the next turn of the event loop. */
  frame?(run: () => void): void
  /** Called for diagnostic lines and kernel defects. Exceptions thrown by `trace` itself are ignored. */
  trace?(line: string): void
  /**
   * Called for every kernel defect (a throwing handler/callback, refused data/move, cycle, runaway step, or lost
   * transaction), in addition to `trace`. Exceptions thrown by `onDefect` itself are ignored.
   */
  onDefect?(defect: Defect): void
  /** Told of each step once it has finished: what it handled, what it changed, and what was sent. Never a payload. */
  log?(step: StepLog): void
  /**
   * The clock this system takes `now` and `sleep` from (`new ClockController().clock` from `@apackdev/clock`, or
   * `schedule.clock` via `onSchedule(schedule)`). Without one, reading `now` throws and calling `sleep` rejects.
   */
  clock?: Clock
  /**
   * How many steps it will take before it takes no more. For a check, so that a kernel that never comes to rest is
   * heard from. The app gives none: one thing leading to the next for as long as it runs is what an agent's loop is.
   */
  limit?: number
}): System<N> {
  const trace = (line: string): void => { try { host.trace?.(line) } catch {} }
  const defect = (message: string, ref?: string, error?: unknown): void => {
    trace(`DEFECT: ${message}`)
    if (!host.onDefect) return
    const entry: Defect = { message, ...(ref === undefined ? {} : { ref }), ...(error === undefined ? {} : { error }) }
    try { host.onDefect(entry) } catch {}
  }
  const called = host.name ?? host.side
  /** How many things are under way: work, asks, and what was put off. Nothing is, when this is nought. */
  let pending = 0
  /** Deterministic counter for unkeyed concurrent (`many`) calls. */
  let manySeq = 0
  /** Counts a promise as under way until it settles, and whatever its settling does is done. */
  const under = <T,>(made: Promise<T>, done: (value: T) => void, failed: (error: unknown) => void): void => {
    pending++
    made.then((value) => { try { done(value) } finally { pending-- } }, (error) => { try { failed(error) } finally { pending-- } })
  }
  const putOff = host.later ?? ((_: Lane, run: () => void): void => { nextTurn(run) })
  const later = (lane: Lane, run: () => void): void => { pending++; putOff(lane, () => { pending--; run() }) }
  const frames: Lane = { label: `${called}'s frame` }
  const frame = host.frame ?? ((run: () => void): void => later(frames, run))
  /** Code that is not the kernel's, called where its throwing must not stop the step it is in. */
  const safely = (what: string, call: () => void, ref?: string): void => {
    try { call() } catch (error) { defect(`${what} threw: ${said(error)}`, ref, error) }
  }
  const running = new Map<string, Running>()
  const outside = new Queue<Queued>()
  const inside = new Queue<Item>()
  /**
   * What leaves when the step commits: answers, progress, what crosses a link, and word to subscribers. `anyway` is
   * the kernel's own word, which leaves whether or not what it was said while handling was made. `unsaid` is what
   * taking one back has to end: an ask that will now never cross the link.
   */
  const leaving: Array<(() => void) & { lost?: () => void; said?: Said; anyway?: true; unsaid?: () => void }> = []
  const sentOf = (entry: Said): Sent => (typeof entry === 'function' ? entry() : entry)
  /** For each ask a state here was asked, which it was: what its answer is said to be to. */
  const askedOf = new WeakMap<Question, { readonly ref: string; readonly name: string }>()
  /** The state answering each ask it answers later, until the answer is taken; and each ask it left unanswered. */
  const answeringOf = new WeakMap<Question, Active>()
  const abandoned = new WeakSet<Question>()
  /** The step being logged: what it has handled, and, once it finishes, what changed and what was sent. */
  let logging: { now?: number; handled: Handled[]; changed: StepLog['changed']; sent: Sent[]; status: StepLog['status'] } | undefined
  let logged = 0
  /** Thrown inside a unit to have what it wrote undone, and caught around it. */
  const UNDONE = Symbol('undone')
  /**
   * Whether what was handled was made. Everything that takes something says which, as what it returns, so that a path
   * which forgets to does not compile: what was not made has its rows undone, and what was has them kept.
   */
  const MADE = true
  const NOT_MADE = false
  /** Set when a step's rows could not be kept. The states are ahead of the rows then, and no more steps are taken. */
  let broken = false
  const TAKEN_BACK = 'What made this ask was not made, so it was never asked'
  /** Where what has been said in this step stands: what is waiting to be handled in it, and what is waiting to leave. */
  const sayings = (): { readonly inside: number; readonly leaving: number } => ({ inside: inside.mark(), leaving: leaving.length })
  /** Ends an ask whose handler was not made, once the step ends: nothing runs while a transaction is open. */
  const abandon = (question: Question): void => {
    const done = (): void => { question.end(refusal('abandoned', TAKEN_BACK)) }
    leaving.push(Object.assign(done, { lost: done }))
  }
  /**
   * Takes back everything said since: what a handler sent, told, asked, called or cancelled, broadcast and reported
   * as progress. What it says is its own until it is made, as its rows are, so one that threw, refused, or returned a
   * change that could not be made has said nothing. An ask among it is ended, since nothing will now answer it. The
   * kernel's own word stays: whoever asked is still told that it failed.
   */
  const unsay = (since: { readonly inside: number; readonly leaving: number }): void => {
    const cut = leaving.splice(since.leaving)
    for (const item of inside.cut(since.inside)) if (item.kind === 'ask') abandon(item.question)
    for (const leave of cut) { if (leave.anyway) leaving.push(leave); else leave.unsaid?.() }
  }
  /** An answer leaves when the step's rows are kept. If they cannot be, whoever asked is told that it failed. */
  const answer = (question: Question, outcome: AnyOutcome): void => {
    const asked = askedOf.get(question)
    const said: Sent = { kind: 'answer', ...(asked ? { to: asked.ref, name: asked.name } : {}), outcome: outcome.ok ? 'ok' : outcome.failure.kind }
    leaving.push(Object.assign(() => question.end(outcome), { lost: () => question.end(refusal('failed', 'What this step wrote could not be kept, so nothing was changed')), said, anyway: true as const }))
  }
  const changed = new Set<string>()
  /** Running states that were committed before this step and started afresh within it, so commit diffs them against their prior snapshot. */
  const restarted = new Set<string>()
  /** For each running state that changed in this step, the fields of its data that did. */
  const fields = new Map<string, Set<string>>()
  /**
   * The running states that changed since what they start and follow was last matched to their data, and which of
   * their fields did: all of them, where a state moved or has only begun.
   */
  const stale = new Map<string, Set<string> | 'all'>()
  const mark = (ref: string, field?: string): void => {
    changed.add(ref)
    const now = stale.get(ref)
    if (field === undefined) stale.set(ref, 'all'); else if (now !== 'all') stale.set(ref, (now ?? new Set<string>()).add(field))
  }
  const touch = (ref: string, field: string): void => { mark(ref, field); fields.set(ref, (fields.get(ref) ?? new Set()).add(field)) }
  /** Whether each moved, and whether its pending calls or armed waits changed, in this step. */
  const places = new Map<string, { moved: boolean; pending: boolean; waiting: boolean }>()
  const placesOf = (ref: string) => places.get(ref) ?? places.set(ref, { moved: false, pending: false, waiting: false }).get(ref)!
  /** What a state has pending changed. That is not its data, so nothing it starts, follows or loads is looked at again. */
  const pendingChanged = (top: Running): void => { changed.add(top.ref); placesOf(top.ref).pending = true }
  /** What timers a state has armed changed. That is not its data, so nothing it starts, follows or loads is looked at again. */
  const waitingChanged = (top: Running): void => { changed.add(top.ref); placesOf(top.ref).waiting = true }
  /** A move can add and remove fields as states are left and entered: each one that differs afterwards changed. */
  const moved = (top: Running, was: Plain): void => {
    mark(top.ref)
    placesOf(top.ref).moved = true
    for (const field of new Set([...Object.keys(was), ...Object.keys(top.data)])) {
      if (Object.hasOwn(was, field) !== Object.hasOwn(top.data, field) || !Object.is(was[field], top.data[field])) touch(top.ref, field)
    }
  }
  const listeners: Array<(changed: readonly string[], fields: Readonly<Record<string, readonly string[]>>, changes: Readonly<Record<string, Changes>>) => void> = []
  const committed = new Map<string, unknown>()
  let stepping = false
  let flushing = false

  /** A window's attached backend port. */
  let up: Port | undefined
  /** A backend's attached window ports. */
  const down = new Set<Port>()
  /** Named non-window peers attached to this system. */
  const peers = new Map<string, PeerPort>()

  /**
   * What a state holds is a value: once it is the state's, nothing changes it but a handler, which makes another.
   * So it is frozen, all the way down, and a write to it throws on the line that tried. A component is handed these
   * very objects, and so is whatever a handler passes on. Freezing stops at what is frozen already, which is all of
   * what a step did not change, and leaves alone what is not plain data: a class instance, a component, a map.
   */
  const frozen = <T,>(value: T): T => {
    if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value
    const prototype = Object.getPrototypeOf(value)
    if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) return value
    Object.freeze(value)
    for (const inner of Array.isArray(value) ? value : Object.values(value)) frozen(inner)
    return value
  }

  const innermost = (top: Running): Active => { let active = top.root; while (active.inside) active = active.inside; return active }
  const valueOf = (top: Running): Plain => {
    const at = innermost(top).path
    const data = frozen(top.data)
    const value: Plain = at ? { at, data } : { data }
    if (top.calls.size) {
      // Which of the imperative asks it declares are currently in flight, in the active states.
      const pending: Plain = Object.fromEntries([...top.calls].map(([name, kind]) => [name, kind === 'each' ? {} : kind === 'many' ? 0 : false]))
      for (let active: Active | undefined = top.root; active; active = active.inside) {
        for (const id of active.pending.keys()) {
          const cut = id.indexOf('/')
          if (cut < 0) pending[id] = true
          else {
            const name = id.slice(0, cut)
            if (top.calls.get(name) === 'many') pending[name] = (pending[name] as number) + 1
            else (pending[name] as Plain)[id.slice(cut + 1)] = true
          }
        }
      }
      value.pending = frozen(pending)
    }
    if (top.waits.size) {
      // Which of the imperative timers it declares are currently armed, in the active states.
      const waiting: Plain = Object.fromEntries([...top.waits].map(([name, kind]) => [name, kind === 'each' ? {} : false]))
      for (let active: Active | undefined = top.root; active; active = active.inside) {
        for (const id of active.waiting.keys()) {
          const cut = id.indexOf('/')
          if (cut === -1) waiting[id] = true
          else (waiting[id.slice(0, cut)] as Plain)[id.slice(cut + 1)] = true
        }
      }
      value.waiting = frozen(waiting)
    }
    return Object.freeze(value)
  }
  const refOf = (to: string | { ref: string }): string => (typeof to === 'string' ? to : to.ref)
  const isSurface = (to: unknown): to is { surface: string } => typeof to === 'object' && to !== null && 'surface' in to
  const isPeer = (to: string | { ref: string } | { surface: string } | { peer: string }): to is { peer: string } => typeof to === 'object' && 'peer' in to

  /** Something to leave at the commit: of this step, or of one of its own if none is running. */
  const out = (leave: () => void, said?: Said, unsaid?: () => void): void => { if (stepping) leaving.push(Object.assign(leave, { said, unsaid })); else arrive({ kind: 'out', leave, ...(said ? { said } : {}) }) }

  /** A name is a backend system: here on the backend, across the link from a window. A handle is always here. */
  const isAcross = (to: string | { ref: string }): boolean => typeof to === 'string' && host.side === 'window'

  const tell = (to: string | { ref: string } | { surface: string } | { peer: string }, event: AnyEvent): void => {
    if (isSurface(to)) {
      // A surface is in a window, and is told there. The backend has one of it in every window, and broadcasts.
      if (host.side !== 'window') { defect(`${called} told the surface ${to.surface} ${event.type}. A surface is told from its own window, and broadcast to from the backend`); return }
      enqueue({ kind: 'event', ref: to.surface, event })
      return
    }
    if (isPeer(to)) {
      let outcome: 'dropped' | 'failed' | undefined
      out(
        () => {
          const target = peers.get(to.peer)
          if (!target) { outcome = 'dropped'; trace(`no peer named ${to.peer} to tell ${event.type}`); return }
          try { target.tell(to.peer, event) } catch (error) { outcome = 'failed'; throw error }
        },
        () => ({ kind: 'peer', to: to.peer, name: event.type, ...(outcome ? { outcome } : {}) }),
      )
      return
    }
    const ref = refOf(to)
    if (!isAcross(to)) { enqueue({ kind: 'event', ref, event }); return }
    const mine = up
    if (!mine) { trace(`nothing to tell ${ref}: not connected`); return }
    out(() => mine.tell(ref, event), { kind: 'tell', to: ref, name: event.type })
  }

  /**
   * Progress gathered for this system, in the order it arrived: each entry is one ask's updates that came in a row.
   *
   * One change per update is quadratic for a collection that grows, and nothing reads a state faster than a frame, so
   * progress is handed over once a frame, as a list. **It is the only thing that waits.** And it never waits behind
   * anything: whatever else arrives here hands over what was gathered first (`handOver`), so progress is merged only
   * with progress that came straight after it, and its order against every other message is the order it was sent in.
   */
  const gathered: Array<{ hears: (updates: unknown[]) => void; signal: AbortSignal | undefined; updates: unknown[] }> = []
  let due = false
  const handOver = (): void => {
    due = false
    for (const each of gathered.splice(0)) if (!each.signal?.aborted) safely('what hears progress', () => each.hears(each.updates))
  }
  const gather = (hears: (updates: unknown[]) => void, signal: AbortSignal | undefined) => (update: unknown): void => {
    const last = gathered[gathered.length - 1]
    if (last?.hears === hears) last.updates.push(update); else gathered.push({ hears, signal, updates: [update] })
    if (!due) { due = true; frame(handOver) }
  }

  /** An ask is under way from when it is made until it ends, however it ends. */
  const asked = <T,>(made: Promise<T>): Promise<T> => { under(made, () => {}, () => {}); return made }
  const ask = (to: string | { ref: string }, name: string, args: object, signal: AbortSignal | undefined, onProgress: ((updates: unknown[]) => void) | undefined, chain?: readonly string[]): Promise<never> => asked(new Promise((resolve, reject) => {
    const ref = refOf(to)
    const progress = onProgress && gather(onProgress, signal)
    // Whoever asked has gone: the ask ends where it is awaited, with `Cancelled`, so the code that asked unwinds.
    const left = (): void => { trace(`an ask of ${ref} for ${name} was left unanswered by whoever made it`); reject(new Cancelled(name)) }
    // What was gathered is handed over before the answer, so an answer is never ahead of progress sent before it.
    const question = new Question((outcome) => { handOver(); signal?.removeEventListener('abort', left); if (!signal?.aborted) (resolve as unknown as (outcome: AnyOutcome) => void)(outcome) })
    // Which ask it is, for what is logged of how it ends: here or across the link, it may end without being taken.
    askedOf.set(question, { ref, name })
    if (signal?.aborted) { left(); return }
    signal?.addEventListener('abort', left, { once: true })
    // In the same system the asker's own signal tells the answerer; across a link, the port does.
    if (!isAcross(to)) { enqueue({ kind: 'ask', ref, name, args, question, progress, gone: signal, chain }); return }
    const peer = up
    if (!peer) { question.end(refusal('disconnected', `Not connected, so ${ref} cannot be asked`)); return }
    // Only a state asks across a link, so it always has a signal.
    const abort = signal!
    out(() => {
      // Whoever asked may have left before the step committed: then the ask is never sent.
      if (abort.aborted) return
      // What lets the ask go is only wired once the port returns without already settling: if `peer.ask` throws, the
      // question still settles as `failed` instead of stranding `pending`, and the defect is logged by `safely`.
      let settled = false
      let leave: () => void
      const gone = (): void => { leave() }
      try {
        leave = peer.ask(ref, name, args,
          (update) => progress?.(update),
          (outcome) => { settled = true; abort.removeEventListener('abort', gone); arrive({ kind: 'answer', question, outcome: outcome as AnyOutcome }) })
      } catch (error) {
        if (!settled) arrive({ kind: 'answer', question, outcome: refusal('failed', said(error)) })
        throw error
      }
      if (settled) return
      abort.addEventListener('abort', gone, { once: true })
    }, { kind: 'ask', to: ref, name }, () => abandon(question))
  }))

  let lastNow: number | undefined
  let stepNow: number | undefined
  const readNow = (): number => {
    if (!host.clock) throw new Error(`${called} was given no clock; pass clock to system()`)
    const raw = host.clock.now()
    if (!Number.isFinite(raw)) throw new RangeError(`${called}'s clock returned a non-finite time: ${String(raw)}`)
    lastNow = lastNow === undefined ? raw : Math.max(lastNow, raw)
    return lastNow
  }
  const sleep = (ms: number, signal: AbortSignal): Promise<void> => {
    const clock = host.clock
    if (!clock) return Promise.reject(new Error(`${called} was given no clock; pass clock to system()`))
    if (!Number.isFinite(ms)) return Promise.reject(new RangeError(`${called}'s sleep delay must be finite: ${String(ms)}`))
    return asked(new Promise<void>((resolve, reject) => {
      if (signal.aborted) { reject(new Cancelled('sleep')); return }
      let fired = false
      let cancel!: () => void
      const aborted = (): void => { safely('cancelling a sleep', cancel); reject(new Cancelled('sleep')) }
      try {
        cancel = clock.after(ms, () => {
          fired = true
          signal.removeEventListener('abort', aborted)
          resolve()
        })
      } catch (error) {
        reject(error)
        return
      }
      if (!fired) {
        if (signal.aborted) aborted()
        else signal.addEventListener('abort', aborted)
      }
    }))
  }

  const resolveFor = (top: Running, name: string): string | undefined => {
    if (!top.resolve) return name
    const cached = top.resolved.get(name)
    if (cached !== undefined) return cached
    let target: unknown
    try { target = top.resolve(name) } catch (error) {
      defect(`${top.ref} could not resolve ${name}: ${said(error)}`, top.ref, error)
      return undefined
    }
    if (typeof target !== 'string' || !target) {
      defect(`${top.ref} could not resolve ${name}: resolver must return a non-empty string`, top.ref)
      return undefined
    }
    top.resolved.set(name, target)
    return target
  }

  const eventScopeOf = (mine: Active, key?: string, own?: AbortSignal) => {
    const alive = (): boolean => !mine.controller.signal.aborted && !own?.aborted
    const ref = mine.top.ref
    const scope = {
      get data() { return mine.top.data },
      get snapshot() { return valueOf(mine.top) },
      get now() { return stepNow ?? readNow() },
      signal: mine.controller.signal,
      send: (event: AnyEvent) => { if (alive()) enqueue({ kind: 'event', ref, event, own: true }) },
      tell: (to: string | { ref: string } | { surface: string } | { peer: string }, event: AnyEvent) => {
        if (!alive()) return
        if (typeof to === 'string') {
          const target = resolveFor(mine.top, to)
          if (target !== undefined) tell(target, event)
          return
        }
        if (isSurface(to)) {
          const target = resolveFor(mine.top, to.surface)
          if (target !== undefined) tell({ surface: target }, event)
          return
        }
        tell(to, event)
      },
      broadcast: (to: string, event: AnyEvent) => {
        if (!alive()) return
        const target = resolveFor(mine.top, to)
        if (target === undefined) return
        out(() => { for (const window of [...down]) safely('what is sent to a window', () => window.tell(target, event)) }, { kind: 'broadcast', to: target, name: event.type })
      },
      call: (name: string, ...rest: unknown[]) => {
        if (!alive()) return
        const kind = mine.top.calls.get(name)
        const key = kind === 'each' ? rest[0] as string : undefined
        const hasInput = kind === 'each' ? rest.length > 1 : rest.length > 0
        const input = hasInput ? frozen(kind === 'each' ? rest[1] : rest[0]) : undefined
        enqueue({ kind: 'call', of: mine, name, key, hasInput, input })
      },
      cancel: (name: string, k?: string) => { if (alive()) enqueue({ kind: 'cancel', of: mine, name, key: k }) },
      arm: (name: string, ...rest: unknown[]) => {
        if (!alive()) return
        let of: Active | undefined = mine
        while (of && !(name in declaredBy(of.def).waits)) of = of.around
        const each = of ? declaredBy(of.def).waits[name]!.kind === 'each' : false
        enqueue({ kind: 'arm', of: mine, name, key: each ? rest[0] as string : undefined, ms: (each ? rest[1] : rest[0]) as number | undefined })
      },
      disarm: (name: string, k?: string) => { if (alive()) enqueue({ kind: 'disarm', of: mine, name, key: k }) },
      report: (event: AnyEvent) => {
        if (!alive()) return
        const starter = mine.top.starter
        if (!starter) { trace(`${ref} was started by nothing, so it has nobody to report ${event.type} to`); return }
        enqueue({ kind: 'event', ref: starter.ref, event: { ...event, from: starter.from } as AnyEvent })
      },
      read: (target: { ref: string }) => { const found = running.get(target.ref); return found ? valueOf(found) : undefined },
      child: (name: string, k?: string) => ({ ref: k === undefined ? `${ref}/${name}` : `${ref}/${name}/${k}` }),
      onExit: (release: () => void) => {
        if (alive()) mine.releases.push(release)
        else if (mine.controller.signal.aborted && !own?.aborted) safely(`a release of ${ref}`, release, ref)
      },
    }
    return key === undefined ? scope : Object.assign(scope, { key })
  }
  const workScopeOf = (mine: Active, signal: AbortSignal, own: AbortSignal, workSignal: AbortSignal, chain?: readonly string[]) => Object.assign(eventScopeOf(mine, undefined, own), {
    signal,
    ask: (to: string | { ref: string }, name: string, args: object, hears?: (updates: unknown[]) => void) => {
      const target = typeof to === 'string' && !workSignal.aborted ? resolveFor(mine.top, to) : to
      if (target === undefined) return Promise.resolve(refusal('failed', `Could not resolve ${to as string}`))
      if (!workSignal.aborted && chain && !isAcross(target) && chain.length >= MAX_ASK_DEPTH) {
        const edge = `${refOf(target)} ${name}`
        const repeat = chain.lastIndexOf(edge)
        const message = repeat !== -1
          ? `Ask cycle (depth ${MAX_ASK_DEPTH}): ${[...chain.slice(repeat), edge].join(' -> ')}`
          : `Ask depth exceeded (${MAX_ASK_DEPTH}): ${[...chain.slice(-4), edge].join(' -> ')}`
        defect(message, mine.top.ref)
        return Promise.resolve(refusal('failed', message))
      }
      const asked = ask(target, name, args, workSignal, hears, chain)
      // An ask that was started and never awaited ends with `Cancelled` like any other, and that is not a failure of the process.
      asked.catch(() => {})
      return asked
    },
    sleep: (ms: number) => {
      const waiting = sleep(ms, workSignal)
      // A sleep that was started and never awaited ends with `Cancelled` like any other, and that is not a failure of the process.
      waiting.catch(() => {})
      return waiting
    },
  })
  /** Aborts a handler's own signal after `unsay` has ended any taken-back asks, so taken-back asks resolve before aborting. */
  const abortAfterUnsay = (own: AbortController): void => {
    const stop = (): void => { own.abort() }
    leaving.push(Object.assign(stop, { anyway: true as const, lost: stop }))
  }

  const isPlainObject = (value: unknown): value is Plain => typeof value === 'object' && value !== null && !Array.isArray(value)

  const enter = (top: Running, def: LooseDef, name: string, around: Active | undefined, entering: Plain): Active => {
    const path = around?.path ? `${around.path}.${name}` : name
    const active: Active = { top, def, name, path, around, inside: undefined, controller: new AbortController(), releases: [], questions: new Set(), started: new Set(), following: new Map(), awaiting: new Map(), pending: new Map(), waiting: new Map() }
    if (around) around.inside = active; else top.root = active
    const entries = Object.entries(def.data ?? {})
    if (entries.length) {
      const nextData: Plain = { ...top.data }
      for (const [field, initial] of entries) nextData[field] = Object.hasOwn(entering, field) ? entering[field] : initial
      top.data = nextData
    }
    if (path) trace(`${top.ref} entered ${path}`)
    if (def.listen) {
      let release: unknown
      const listenNow = (): unknown => def.listen!(eventScopeOf(active))
      const before = sayings()
      try {
        release = host.transact ? host.transact(listenNow) : listenNow()
      } catch (error) {
        unsay(before)
        for (const cleanup of active.releases.splice(0).reverse()) safely(`a release of ${top.ref}`, cleanup, top.ref)
        inside.push({ kind: 'failure', of: active, error })
        return active
      }
      if (typeof release === 'function') {
        const cleanup = release as () => void
        if (active.controller.signal.aborted) safely(`a release of ${top.ref}`, cleanup, top.ref)
        else active.releases.push(cleanup)
      } else if (release !== undefined) {
        defect(`${top.ref}${path ? ` in ${path}` : ''}'s listen returned a non-function value`, top.ref)
      }
    }
    if (def.run && !active.controller.signal.aborted) {
      const own = new AbortController()
      const workSignal = AbortSignal.any([active.controller.signal, own.signal])
      let made: unknown
      let deferred: unknown
      // What `run` throws at once is a failure like any later one, taken up when the entering it is part of is done.
      // And what it wrote and said before it threw — or returned a refused change — is taken back whole.
      const runNow = (): void => {
        made = def.run!(workScopeOf(active, active.controller.signal, own.signal, workSignal))
        if (made === undefined || made === null || made instanceof Promise) return
        const { at, data } = made as { at?: string; data?: Plain | ((draft: Plain) => void) }
        if (at === undefined) {
          if (!apply(active, made)) throw UNDONE
          return
        }
        const nextData = data === undefined || typeof data === 'function' ? {} : data
        if (!isPlainObject(nextData)) {
          defect(`${top.ref} cannot change data with a non-object value`, top.ref)
          throw UNDONE
        }
        const cannot = cannotGo(top, at, nextData)
        if (cannot) { defect(`${top.ref} ${cannot}`, top.ref); throw UNDONE }
        if (typeof data === 'function') {
          if (!apply(active, { data })) throw UNDONE
          deferred = { at }
        } else {
          deferred = made
        }
      }
      const before = sayings()
      try { if (host.transact) host.transact(runNow); else runNow() } catch (error) {
        unsay(before)
        abortAfterUnsay(own)
        if (error !== UNDONE && !(error instanceof Cancelled)) inside.push({ kind: 'failure', of: active, error })
        return active
      }
      if (made instanceof Promise) {
        under(made,
          (value) => { own.abort(); if (!active.controller.signal.aborted) arrive({ kind: 'result', of: active, value }) },
          (error) => {
            own.abort()
            if (error instanceof Cancelled) return
            if (active.controller.signal.aborted) { leftFailed(active, error); return }
            arrive({ kind: 'failure', of: active, error })
          },
        )
      } else {
        own.abort()
        if (deferred !== undefined) inside.push({ kind: 'result', of: active, value: deferred })
      }
    }
    return active
  }

  const exit = (active: Active): void => {
    if (active.inside) exit(active.inside)
    if (active.path) trace(`${active.top.ref} left ${active.path}`)
    active.controller.abort()
    for (const live of [...active.following.values(), ...active.awaiting.values()]) live.stop()
    active.following.clear()
    active.awaiting.clear()
    if (active.pending.size) { for (const live of active.pending.values()) live.stop(); active.pending.clear(); pendingChanged(active.top) }
    if (active.waiting.size) {
      const armed = [...active.waiting.values()]
      active.waiting.clear()
      for (const live of armed) live.stop!()
      waitingChanged(active.top)
    }
    for (const ref of [...active.started].reverse()) end(ref)
    active.started.clear()
    for (const question of active.questions) {
      // Ended as abandoned: an answer its handler gives later has nobody to go to, and is not one.
      abandoned.add(question)
      const asked = askedOf.get(question)
      const endAbandoned = (): void => question.end(refusal('abandoned', 'It stopped before answering'))
      leaving.push(Object.assign(endAbandoned, {
        lost: endAbandoned,
        anyway: true as const,
        said: { kind: 'abandoned', ...(asked ? { to: asked.ref, name: asked.name } : {}) } satisfies Sent,
      }))
    }
    for (const release of active.releases.splice(0).reverse()) safely(`a release of ${active.top.ref}`, release, active.top.ref)
    const { ...rest } = active.top.data
    for (const field of Object.keys(active.def.data ?? {})) delete rest[field]
    active.top.data = rest
    if (active.around) active.around.inside = undefined
  }

  const descend = (under: Active, names: readonly string[], entering: Plain): void => {
    let active = under
    for (const name of names) {
      if (active.controller.signal.aborted) return
      active = enter(active.top, active.def.states?.[name] ?? {}, name, active, entering)
    }
    while (!active.controller.signal.aborted && active.def.initial !== undefined) {
      active = enter(active.top, active.def.states?.[active.def.initial] ?? {}, active.def.initial, active, entering)
    }
  }

  /**
   * Goes to a path. The states on the way that are already the case are kept; everything else that was the case
   * ends, innermost first; the rest of the path is entered, outermost first. The target itself is entered afresh.
   */
  const go = (top: Running, at: string, entering: Plain): void => {
    const names = at.split('.')
    let kept = top.root
    let shared = 0
    while (shared < names.length - 1 && kept.inside?.name === names[shared]) { kept = kept.inside!; shared++ }
    if (kept.inside) exit(kept.inside)
    descend(kept, names.slice(shared), entering)
  }

  const waitEntry = (kind: 'one' | 'each', args: unknown[]): { kind: 'one' | 'each'; ms?: number; reset?: boolean; done?: Function } => {
    const hasMs = args.length > 1 || typeof args[0] === 'number'
    const rest = hasMs ? args[1] : args[0]
    const opts = typeof rest === 'function' ? { done: rest } : (rest as { reset?: boolean; done?: Function } | undefined)
    return { kind, ms: hasMs ? args[0] as number : undefined, reset: opts?.reset, done: opts?.done }
  }
  /** What a definition declares, read from it once: each is a function of the helper its entries are made with. */
  const declared = new WeakMap<LooseDef, { starts: ReturnType<NonNullable<LooseDef['starts']>>; follows: ReturnType<NonNullable<LooseDef['follows']>>; loads: ReturnType<NonNullable<LooseDef['loads']>>; calls: ReturnType<NonNullable<LooseDef['calls']>>; waits: ReturnType<NonNullable<LooseDef['waits']>> }>()
  const declaredBy = (def: LooseDef) => {
    let found = declared.get(def)
    if (!found) {
      found = {
        starts: def.starts?.((state: unknown, options: { each?: string; given: Function }) => ({ each: options.each, state, given: options.given })) ?? {},
        follows: def.follows?.((feature: string, view: string, options: object) => ({ feature, view, ...options })) ?? {},
        loads: def.loads?.((of: string, ask: string, options: object) => ({ of, ask, ...options })) ?? {},
        calls: def.calls?.({
          one: (of: string, ask: string, options: object) => ({ kind: 'one', of, ask, ...options }),
          each: (of: string, ask: string, options: object) => ({ kind: 'each', of, ask, ...options }),
          many: (of: string, ask: string, options: object) => ({ kind: 'many', of, ask, ...options }),
        }) ?? {},
        waits: def.waits?.({
          one: (...args: unknown[]) => waitEntry('one', args),
          each: (...args: unknown[]) => waitEntry('each', args),
        }) ?? {},
      }
      declared.set(def, found)
    }
    return found
  }
  const keysOf = (held: unknown): string[] => [...new Set(Array.isArray(held) ? held as string[] : Object.keys((held ?? {}) as object))]
  /** Where an error was thrown, outside the kernel and the draft: the line of the handler that did it. */
  const whereOf = (error: unknown): string => {
    const frames = error instanceof Error && error.stack ? error.stack.split('\n').slice(1) : []
    // The first frame not in the kernel's own files, as source or as built.
    const frame = frames.find((line) => !/[/\\](kernel|draft|types|port)\.[cm]?[jt]s\b/.test(line) && /\.[cm]?[jt]s/.test(line))
    // A window's frames name a file as it was served, with a query after it: `kernel-check.mts?import&t=1:139:37`.
    const found = frame?.match(/([^/\\(\s?]+\.[cm]?[jt]s)(?:\?[^:\s)]*)?:(\d+)/)
    return found ? ` (${found[1]}:${found[2]})` : ''
  }
  /**
   * The view whose delivery this step began with, and the views whose deliveries led to it being asked what it is.
   * Everything in the step follows from that delivery. Whatever it leads to being asked is asked because of it, and
   * it may not lead back to itself or to any of those: what views ask for may not depend on each other in a circle.
   */
  let hearing: { readonly id: string; readonly because: ReadonlySet<string> } | undefined

  /**
   * Makes what a running state has started, and the views it follows, match what it declares and the data it holds
   * now. This is all that ever starts or stops either. `touched` is which of its fields changed since last time:
   * what there is one of for each key of a field is looked at again only if that field did.
   */
  const match = (top: Running, touched: Set<string> | 'all'): void => {
    const looks = (field: string): boolean => touched === 'all' || touched.has(field)
    for (let active: Active | undefined = top.root; active; active = active.inside) {
      const at = active
      for (const [name, declared] of Object.entries(declaredBy(at.def).starts)) {
        const under = `${top.ref}/${name}`
        const start = (ref: string, def: unknown, from: string, given: () => Plain, resolve?: (name: string) => string): void => {
          let entering: Plain
          try { entering = given() } catch (error) { defect(`${top.ref} could not say what to give ${ref}: ${said(error)}`, top.ref, error); return }
          const problem = cannotBegin(def as LooseDef, entering)
          if (problem) { defect(`${ref} ${problem}`, ref); return }
          at.started.add(ref)
          begin(ref, def as LooseDef, entering, { ref: top.ref, from }, resolve)
        }
        if ('def' in declared) { if (!at.started.has(under)) start(under, declared.def, name, () => ({}), declared.resolve); continue }
        if (declared.each === undefined) { if (!at.started.has(under)) start(under, declared.state.def, name, () => declared.given(top.data) as Plain, declared.state.resolve); continue }
        if (!looks(declared.each)) continue
        trace(`${top.ref} looked at ${declared.each} for which ${name} to run`)
        const wanted = new Map<string, string>()
        for (const key of keysOf(top.data[declared.each])) {
          if (key.includes('/')) defect(`${top.ref} has a ${name} under ${JSON.stringify(key)}, and a key cannot hold a slash`, top.ref); else wanted.set(`${under}/${key}`, key)
        }
        for (const ref of [...at.started]) if (ref.startsWith(`${under}/`) && !wanted.has(ref)) { at.started.delete(ref); end(ref) }
        for (const [ref, key] of wanted) if (!at.started.has(ref)) start(ref, declared.state.def, key, () => declared.given(key, top.data) as Plain, declared.state.resolve)
      }

      /**
       * One of what this state follows or loads, as it should be now. `seen` is the values of the fields it named:
       * the data is never changed in place, so a field that changed is a different value, and comparing the two
       * says whether to ask again without working anything out.
       */
      const settle = (live: Map<string, Live>, id: string, seen: readonly unknown[], args: () => unknown, begin: (what: object, entry: Live) => (() => void) | undefined): void => {
        const now = live.get(id)
        if (now && now.seen.length === seen.length && now.seen.every((value, index) => Object.is(value, seen[index]))) return
        let what: object | null | undefined | false
        try { what = args() as object | null | undefined | false } catch (error) { defect(`${top.ref} could not say what to ask ${id} for: ${said(error)}`, top.ref, error); return }
        // There is nothing to ask for now: what was asked is given up, and nothing can come round.
        if (!what) { now?.stop(); live.set(id, { seen, because: new Set(), stop: () => {} }); return }
        const here = `${top.ref}#${id}`
        // A circle would be asked again, deliver again, and never come to rest, each round a read. It is refused
        // where it closes: this one goes on as it was.
        if (now && hearing && (hearing.id === here || hearing.because.has(here))) {
          defect(hearing.id === here
            ? `what ${here} delivered changed a field it is itself asked from. It goes on as it was`
            : `what ${hearing.id} delivered changed a field ${here} is asked from, and ${here} is what led to ${hearing.id} being asked. ${here} goes on as it was`, top.ref)
          return
        }
        now?.stop()
        live.delete(id)
        const because: ReadonlySet<string> = hearing ? new Set([...hearing.because, hearing.id]) : new Set()
        // In place before it begins, so that whatever it delivers can be told from what an earlier one did.
        const entry: Live = { seen, because, stop: () => {} }
        live.set(id, entry)
        const stop = begin(what, entry)
        if (stop) entry.stop = stop; else live.delete(id)
      }
      const picked = (from: readonly string[]): Plain => Object.fromEntries(from.map((field) => [field, top.data[field]]))
      /** For one declared with `each`: the keys there are now, with what went stopped. Nothing if the field did not change. */
      const keysNow = (live: Map<string, Live>, name: string, field: string, what: string): string[] | undefined => {
        if (!looks(field)) return undefined
        trace(`${top.ref} looked at ${field} for which ${name} to ${what}`)
        const keys = keysOf(top.data[field])
        const wanted = new Set(keys.map((key) => `${name}/${key}`))
        for (const [id, entry] of [...live]) if (id.startsWith(`${name}/`) && !wanted.has(id)) { entry.stop(); live.delete(id) }
        return keys
      }

      // A window with no views of its own follows its backend's, over the attached port: what a view delivers comes
      // back in order with everything else the backend sends, held by the link.
      const peer = up
      const views: ViewHost | undefined = host.views ?? (peer && ((feature, view, args, updated) => {
        let following: Following | undefined
        let stopped = false
        out(() => {
          if (stopped) return
          following = peer.follow(
            feature, view, args,
            (update) => updated(update as ViewUpdate<unknown>),
            (failure) => { following = undefined; updated({ ok: false, failure }) },
          )
        }, { kind: 'follow', to: feature, name: view })
        return () => {
          stopped = true
          if (!following) return
          const live = following
          following = undefined
          if (stepping) out(() => live.stop(), { kind: 'unfollow', to: feature, name: view })
          else live.stop()
        }
      }))
      if (views) for (const [name, declared] of Object.entries(declaredBy(at.def).follows)) {
        const feature = resolveFor(top, declared.feature)
        if (feature === undefined) continue
        const followed = (id: string, key: string | undefined, seen: readonly unknown[], args: () => unknown): void => {
          settle(at.following, id, seen, args, (what, live) => {
            let runningView: (() => void) | Following
            try {
              runningView = views(feature, declared.view, what, (update) => {
                if (!at.controller.signal.aborted && at.following.get(id) === live) arrive({ kind: 'view', of: at, name, id, key, live, update })
              })
            } catch (error) {
              defect(`${top.ref} could not follow ${id}: ${said(error)}`, top.ref, error)
              return undefined
            }
            const stop = typeof runningView === 'function' ? runningView : () => runningView.stop()
            return () => safely(`stopping ${top.ref}'s view ${id}`, stop, top.ref)
          })
        }
        if (declared.each !== undefined) {
          for (const key of keysNow(at.following, name, declared.each, 'follow') ?? []) followed(`${name}/${key}`, key, [key], () => (declared.args ? declared.args(key) : {}))
        } else {
          const from = declared.from ?? []
          if (!from.some(looks) && at.following.has(name)) continue
          followed(name, undefined, from.map((field) => top.data[field]), () => (declared.args ? declared.args(picked(from)) : {}))
        }
      }

      for (const [name, declared] of Object.entries(declaredBy(at.def).loads)) {
        const of = resolveFor(top, declared.of)
        if (of === undefined) continue
        const awaited = (id: string, key: string | undefined, seen: readonly unknown[], args: () => unknown): void => {
          // Nothing to ask for is nothing asked, and it is still looked at again when its fields change.
          settle(at.awaiting, id, seen, args, (what, live) => {
            const given = new AbortController()
            const signal = AbortSignal.any([at.controller.signal, given.signal])
            const mine = (): boolean => at.awaiting.get(id) === live && !signal.aborted
            const hears = declared.progress && ((updates: unknown[]): void => { if (mine()) arrive({ kind: 'progress', made: false, of: at, name, id, key, live, updates }) })
            const made = ask(of, declared.ask, what, signal, hears) as unknown as Promise<AnyOutcome>
            // Given up, it ends with `Cancelled`, which is that and nothing to hear of.
            made.then((outcome) => { if (mine()) arrive({ kind: 'done', made: false, of: at, name, id, key, live, outcome }) }, () => {})
            return () => given.abort()
          })
        }
        if (declared.each !== undefined) {
          for (const key of keysNow(at.awaiting, name, declared.each, 'await') ?? []) awaited(`${name}/${key}`, key, [key], () => (declared.args ? declared.args(key) : {}))
        } else {
          const from = declared.from ?? []
          if (!from.some(looks) && at.awaiting.has(name)) continue
          awaited(name, undefined, from.map((field) => top.data[field]), () => (declared.args ? declared.args(picked(from)) : {}))
        }
      }
    }
  }
  /** Matches every state that changed, and whatever that starts, until nothing is left to match. */
  const matchStale = (): void => {
    while (stale.size) for (const [ref, touched] of [...stale]) { stale.delete(ref); const top = running.get(ref); if (top) match(top, touched) }
  }

  /**
   * Why a move cannot be made, if it cannot: worked out from the definition before anything is left or entered, so
   * that a move that is refused has done nothing. It follows `go`: the states on the way that are the case are kept,
   * the rest of the path is entered, and then whatever each of those starts at.
   */
  const cannotGo = (top: Running, at: string, entering: Plain): string | undefined => {
    const names = at.split('.')
    let def = top.root.def
    let kept: Active | undefined = top.root
    const after = new Set(Object.keys(def.data ?? {}))
    const enters = (inner: LooseDef, path: string): string | undefined => {
      for (const [field, initial] of Object.entries(inner.data ?? {})) {
        after.add(field)
        if (initial === given && !Object.hasOwn(entering, field)) return `cannot enter ${path} without ${field}`
      }
      return undefined
    }
    for (const [index, name] of names.entries()) {
      const inner = def.states?.[name]
      const path = names.slice(0, index + 1).join('.')
      if (!inner) return `has no state ${path} to go to`
      // A state on the way that is already the case is kept, with its data. The last is entered afresh.
      kept = index < names.length - 1 && kept?.inside?.name === name ? kept.inside : undefined
      if (kept) for (const field of Object.keys(inner.data ?? {})) after.add(field)
      else { const problem = enters(inner, path); if (problem) return problem }
      def = inner
    }
    for (let path = at; def.initial !== undefined; ) {
      path = `${path}.${def.initial}`
      def = def.states?.[def.initial] ?? {}
      const problem = enters(def, path)
      if (problem) return problem
    }
    const stray = Object.keys(entering).find((field) => !after.has(field))
    return stray === undefined ? undefined : `will have no field ${stray} at ${at}`
  }

  /** Why a state cannot start with what it is given, checked before anything registers or runs. */
  const cannotBegin = (def: LooseDef, entering: unknown): string | undefined => {
    if (entering !== undefined && !isPlainObject(entering)) return 'cannot start with non-object given data'
    const provided: Plain = entering ?? {}
    for (const [field, initial] of Object.entries(def.data ?? {})) {
      if (initial === given && !Object.hasOwn(provided, field)) return `cannot start without ${field}`
    }
    const shadowed = (node: LooseDef, above: ReadonlySet<string>, path: string): string | undefined => {
      const own = Object.keys(node.data ?? {})
      for (const field of own) if (above.has(field)) return `declares ${field} again at ${path}, shadowing an enclosing state`
      if (!node.states) return undefined
      const next = new Set([...above, ...own])
      for (const [name, inner] of Object.entries(node.states)) {
        const problem = shadowed(inner, next, path ? `${path}.${name}` : name)
        if (problem) return problem
      }
      return undefined
    }
    const shadow = shadowed(def, new Set(), '')
    if (shadow) return shadow
    for (let cur = def, path = ''; cur.initial !== undefined; ) {
      const nextName = cur.initial
      path = path ? `${path}.${nextName}` : nextName
      const inner = cur.states?.[nextName]
      if (!inner) return `has no state ${path} to start at`
      for (const [field, initial] of Object.entries(inner.data ?? {})) {
        if (initial === given) return `cannot start at ${path} without ${field}`
      }
      cur = inner
    }
    return undefined
  }

  const begin = (ref: string, def: LooseDef, entering: Plain = {}, starter?: Running['starter'], resolve?: (name: string) => string): void => {
    const calls = new Map<string, 'one' | 'each' | 'many'>()
    const waits = new Map<string, 'one' | 'each'>()
    const survey = (of: LooseDef): void => {
      for (const [name, called] of Object.entries(declaredBy(of).calls)) calls.set(name, called.kind)
      for (const [name, waited] of Object.entries(declaredBy(of).waits)) waits.set(name, waited.kind)
      for (const inner of Object.values(of.states ?? {})) survey(inner)
    }
    survey(def)
    restarted.add(ref)
    mark(ref)
    const top: Running = { ref, data: {}, root: undefined as unknown as Active, starter, calls, waits, resolve, resolved: new Map(), reported: new Set() }
    running.set(ref, top)
    descend(enter(top, def, '', undefined, entering), [], {})
    top.data = frozen(top.data)
  }

  const end = (ref: string): void => {
    const top = running.get(ref)
    if (!top) return
    exit(top.root)
    running.delete(ref)
    changed.add(ref)
  }

  const large = (top: Running, field: string): void => {
    const held = top.data[field]
    if (!Array.isArray(held) || held.length <= LARGE || top.reported.has(field)) return
    top.reported.add(field)
    trace(`LARGE: ${top.ref} holds ${held.length} items in ${field}. A collection this size belongs in a view`)
  }

  /** Makes a change, and freezes what the state holds afterwards, however the change went. */
  const apply = (active: Active, next: unknown, mayRefuse = false): boolean => {
    try { return change(active, next, mayRefuse) } finally { active.top.data = frozen(active.top.data) }
  }
  const change = (active: Active, next: unknown, mayRefuse: boolean): boolean => {
    if (next === undefined || next === null || active.controller.signal.aborted) return MADE
    const { at, data = {} } = next as { at?: string; data?: Plain | ((draft: Plain) => void) }
    const top = active.top
    if (typeof data === 'function') {
      // Edits to a draft. A field can be edited, never added or removed: which fields exist is the states' to say.
      const before = top.data
      let made: ReturnType<typeof produce<Plain>>
      // An edit that is refused changes nothing, and the move it came with is not made either.
      // A move is looked at before the edit is made: one that cannot be made takes its edit with it.
      const cannot = at === undefined ? undefined : cannotGo(top, at, {})
      if (cannot) { defect(`${top.ref} ${cannot}`, top.ref); return NOT_MADE }
      // Which fields there are is the states' to say, so the edit may change them and neither add nor remove one.
      // The write that tries throws there and then, and an edit that throws has changed nothing.
      try { made = produce(before, data, { fixed: true, topLevel: true }) } catch (error) {
        // A change that came with an answer may refuse, with one of the refusals its ask declares.
        if (mayRefuse && error instanceof Refusal) throw error
        defect(`${top.ref}: ${said(error)}${whereOf(error)}`, top.ref, error)
        return NOT_MADE
      }
      const { value, touched } = made
      for (const path of touched) touch(top.ref, path[0]!)
      top.data = touched.length ? value : before
      for (const field of fields.get(top.ref) ?? []) large(top, field)
      if (at !== undefined) { const was = top.data; go(top, at, {}); moved(top, was) }
      return MADE
    }
    if (!isPlainObject(data)) { defect(`${top.ref} cannot change data with a non-object value`, top.ref); return NOT_MADE }
    // The same rule for fields as for an edit: every one of them has to be a field there will be, or none is taken.
    // Without a move those are the fields there are. With one, they are the fields of the states the move leaves it in.
    const cannot = at === undefined
      ? Object.keys(data).filter((field) => !Object.hasOwn(top.data, field)).map((field) => `has no field ${field} to change`)[0]
      : cannotGo(top, at, data)
    if (cannot) { defect(`${top.ref} ${cannot}`, top.ref); return NOT_MADE }
    // Data first, then the move: the work of a state that is entered reads the data as the handler left it.
    let nextData: Plain | undefined
    for (const [field, value] of Object.entries(data)) {
      if (!Object.hasOwn(top.data, field)) continue
      if (!Object.is(top.data[field], value)) {
        touch(top.ref, field)
        ;(nextData ??= { ...top.data })[field] = value
      }
    }
    if (nextData) {
      top.data = nextData
      for (const field of fields.get(top.ref) ?? []) large(top, field)
    }
    if (at !== undefined) { const was = top.data; go(top, at, data); moved(top, was) }
    return MADE
  }

  const leftFailed = (active: Active, error: unknown): void => {
    trace(`${active.top.ref}${active.path ? ` in ${active.path}` : ''} failed after it was left: ${said(error)}`)
  }
  /**
   * A state's work failed. If the state is still the case it goes where its `failed` says, with the error. If it was
   * left first (for example, an enclosing state's failure moved away in the same step), there is nowhere to go and the
   * failure is only reported.
   */
  const fail = (active: Active, error: unknown): boolean => {
    if (active.controller.signal.aborted) { leftFailed(active, error); return MADE }
    const where = `${active.top.ref}${active.path ? ` in ${active.path}` : ''}`
    trace(`${where} failed: ${said(error)}`)
    const failed = active.def.failed
    if (!failed) { defect(`${where} says nowhere to go when its work fails, and stays as it is`, active.top.ref, error); return MADE }
    try { return apply(active, failed(error, eventScopeOf(active))) } catch (thrown) { defect(`${where}'s failed threw: ${said(thrown)}`, active.top.ref, thrown); return NOT_MADE }
  }

  /**
   * Makes the change an answer came with. The change is where to check what has to hold when it is made, since it is
   * made against the data as it is then: an edit that throws one of the ask's refusals answers with that refusal, and
   * nothing is changed. An answer whose change could not be made at all is not given either: the ask failed.
   */
  const withChange = (of: Active, next: unknown, outcome: AnyOutcome): AnyOutcome => {
    let made: boolean
    try { made = apply(of, next, true) } catch (error) {
      if (error instanceof Refusal) return refusal(error.kind, error.message, error.data)
      throw error
    }
    return made ? outcome : refusal('failed', 'The change that came with the answer was refused, so nothing was changed')
  }
  const isAnswered = (made: unknown): made is Answered<unknown, unknown> => typeof made === 'object' && made !== null && ANSWERED in made

  const taker = (top: Running, table: 'on' | 'internal' | 'answers', name: string): { handler: Function; of: Active } | undefined => {
    let of: Active | undefined = innermost(top)
    while (of && !of.def[table]?.[name]) of = of.around
    return of ? { handler: of.def[table]![name]!, of } : undefined
  }

  /** What a log says of a thing handled: its kind, the state, and the name it was declared or sent by. */
  const handledOf = (item: Exclude<Item, { kind: 'out' }>): Handled => {
    switch (item.kind) {
      case 'event': return { kind: 'event', ref: item.ref, name: item.event.type, ...(item.own ? { own: true as const } : {}) }
      case 'ask': return { kind: 'ask', ref: item.ref, name: item.name }
      case 'result': case 'failure': return { kind: item.kind, ref: item.of.top.ref, name: item.of.path || item.of.name }
      case 'view': case 'done': case 'progress': return { kind: item.kind, ref: item.of.top.ref, name: item.name, ...(item.key === undefined ? {} : { key: item.key }) }
      case 'call': case 'cancel': case 'arm': case 'disarm': case 'wait': return { kind: item.kind, ref: item.of.top.ref, name: item.name, ...(item.key === undefined ? {} : { key: item.key }) }
      // Every ask an answer comes back to was noted where it was made, or where it arrived to be answered.
      case 'answer': { const asked = askedOf.get(item.question)!; return { kind: 'answer', ref: asked.ref, name: asked.name } }
    }
  }
  /**
   * Takes one thing, whole. What a handler wrote and what it said are kept only if what it did is: one that threw,
   * refused, or returned a change that could not be made has its rows and its word taken back, and those of
   * everything else in the step stay.
   */
  const handle = (item: Item): void => {
    const before = sayings()
    const within = host.transact
    let made = NOT_MADE
    if (!within) made = take(item)
    else try { within(() => { made = take(item); if (!made) throw UNDONE }) } catch (error) { if (error !== UNDONE) throw error }
    if (!made) unsay(before)
  }
  const take = (item: Item): boolean => {
    if (item.kind === 'out') { leaving.push(Object.assign(item.leave, { said: item.said })); return MADE }
    // What is handled is logged as it is taken: an event or ask held for a state not running yet is taken later.
    const note = (): void => { if (logging) logging.handled.push(handledOf(item)) }
    if (item.kind !== 'event' && item.kind !== 'ask') note()
    if (item.kind === 'result') return apply(item.of, item.value)
    if (item.kind === 'failure') return fail(item.of, item.error)
    if (item.kind === 'view') {
      const followed = declaredBy(item.of.def).follows[item.name]
      if (!followed || item.of.following.get(item.id) !== item.live) return MADE
      hearing = { id: `${item.of.top.ref}#${item.id}`, because: item.live.because }
      try { return apply(item.of, followed.updated(item.update, eventScopeOf(item.of, item.key))) } catch (error) {
        defect(`${item.of.top.ref} threw in ${item.id} updated, and nothing changed: ${said(error)}`, item.of.top.ref, error)
        return NOT_MADE
      }
    }
    if (item.kind === 'call' || item.kind === 'cancel') {
      const { name, key } = item
      // It is called by the state that declares it, which is the one it stops with: here, or a state around here.
      let of: Active | undefined = item.of
      while (of && !(name in declaredBy(of.def).calls)) of = of.around
      if (!of || of.controller.signal.aborted) return MADE
      const at = of
      const top = at.top
      const declared = declaredBy(at.def).calls[name]!
      if (item.kind === 'cancel') {
        if (declared.kind === 'many') {
          const prefix = `${name}/`
          let any = false
          for (const [entryId, live] of [...at.pending]) {
            if (!entryId.startsWith(prefix)) continue
            live.stop()
            at.pending.delete(entryId)
            any = true
          }
          if (any) pendingChanged(top)
          return MADE
        }
        const id = key === undefined ? name : `${name}/${key}`
        const now = at.pending.get(id)
        if (!now) return MADE
        now.stop()
        at.pending.delete(id)
        pendingChanged(top)
        return MADE
      }
      const id = declared.kind === 'many' ? `${name}/${++manySeq}` : key === undefined ? name : `${name}/${key}`
      // For `one` and `each`, one already in flight is the same one: a second push while one is pending is that push.
      if (at.pending.has(id)) return MADE
      let asked: object
      try {
        if (declared.args) {
          asked = (declared.kind === 'each'
            ? (item.hasInput ? declared.args(key, item.input, top.data) : declared.args(key, top.data))
            : (item.hasInput ? declared.args(item.input, top.data) : declared.args(top.data))) as object
        } else {
          asked = (item.hasInput ? item.input : {}) as object
        }
      } catch (error) {
        defect(`${top.ref} could not say what to ask ${id} for: ${said(error)}`, top.ref, error)
        return NOT_MADE
      }
      const target = resolveFor(top, declared.of)
      if (target === undefined) return NOT_MADE
      const given = new AbortController()
      const signal = AbortSignal.any([at.controller.signal, given.signal])
      const live: Live = { seen: [], because: new Set(), stop: () => given.abort() }
      const mine = (): boolean => at.pending.get(id) === live && !signal.aborted
      at.pending.set(id, live)
      pendingChanged(top)
      const { hasInput, input } = item
      const hears = declared.progress && ((updates: unknown[]): void => { if (mine()) arrive({ kind: 'progress', made: true, of: at, name, id, key, hasInput, input, live, updates }) })
      const made = ask(target, declared.ask, asked, signal, hears) as unknown as Promise<AnyOutcome>
      // Cancelled, it ends with `Cancelled`, which is that and nothing to hear of.
      made.then((outcome) => { if (mine()) arrive({ kind: 'done', made: true, of: at, name, id, key, hasInput, input, live, outcome }) }, () => {})
      return MADE
    }
    if (item.kind === 'arm' || item.kind === 'disarm') {
      const { name, key } = item
      let of: Active | undefined = item.of
      while (of && !(name in declaredBy(of.def).waits)) of = of.around
      if (!of || of.controller.signal.aborted) return MADE
      const at = of
      const top = at.top
      const declared = declaredBy(at.def).waits[name]!
      if (item.kind === 'disarm') {
        if (declared.kind === 'each' && key === undefined) {
          const prefix = `${name}/`
          let any = false
          for (const [entryId, live] of [...at.waiting]) {
            if (!entryId.startsWith(prefix)) continue
            at.waiting.delete(entryId)
            live.stop!()
            any = true
          }
          if (any) waitingChanged(top)
          return MADE
        }
        const id = key === undefined ? name : `${name}/${key}`
        const now = at.waiting.get(id)
        if (!now) return MADE
        at.waiting.delete(id)
        now.stop!()
        waitingChanged(top)
        return MADE
      }
      if (declared.kind === 'each' && typeof key !== 'string') {
        defect(`${top.ref} cannot arm ${name} without a string key`, top.ref)
        return NOT_MADE
      }
      const id = key === undefined ? name : `${name}/${key}`
      const duration = item.ms ?? declared.ms
      if (!Number.isFinite(duration) || (duration as number) < 0) {
        defect(`${top.ref} cannot arm ${id} with invalid duration ${String(duration)}`, top.ref)
        return NOT_MADE
      }
      if (!host.clock) {
        defect(`${top.ref} cannot arm ${id}: ${called} was given no clock; pass clock to system()`, top.ref)
        return NOT_MADE
      }
      const prev = at.waiting.get(id)
      if (prev && declared.reset === false) return MADE
      const live: Armed = {}
      at.waiting.set(id, live)
      let cancel: () => void
      try {
        cancel = host.clock.after(duration as number, () => {
          if (at.waiting.get(id) === live) arrive({ kind: 'wait', of: at, name, id, key, live })
        })
      } catch (error) {
        if (prev) at.waiting.set(id, prev); else at.waiting.delete(id)
        defect(`${top.ref} could not arm ${id}: ${said(error)}`, top.ref, error)
        return NOT_MADE
      }
      if (prev) prev.stop!()
      live.stop = () => safely(`disarming ${top.ref}'s wait ${id}`, cancel, top.ref)
      if (!prev) waitingChanged(top)
      return MADE
    }
    if (item.kind === 'wait') {
      if (item.of.waiting.get(item.id) !== item.live) return MADE
      const declared = declaredBy(item.of.def).waits[item.name]!
      const top = item.of.top
      item.of.waiting.delete(item.id)
      waitingChanged(top)
      if (!declared.done) return MADE
      try { return apply(item.of, declared.done(eventScopeOf(item.of, item.key))) } catch (error) {
        defect(`${top.ref} threw in ${item.id} done, and nothing changed: ${said(error)}`, top.ref, error)
        return NOT_MADE
      }
    }
    if (item.kind === 'done' || item.kind === 'progress') {
      const table = item.made ? declaredBy(item.of.def).calls : declaredBy(item.of.def).loads
      const live = item.made ? item.of.pending : item.of.awaiting
      const declared = table[item.name]
      if (!declared || live.get(item.id) !== item.live) return MADE
      const top = item.of.top
      const baseScope = eventScopeOf(item.of, item.key)
      const given = item.hasInput ? Object.assign(baseScope, { input: item.input }) : baseScope
      // What a read delivers may not lead round to itself. An imperative call has nothing to come round to.
      hearing = item.made ? undefined : { id: `${top.ref}#${item.id}`, because: item.live.because }
      if (item.kind === 'progress') {
        try { return apply(item.of, declared.progress!(item.updates, given)) } catch (error) { defect(`${top.ref} threw in ${item.id} progress, and nothing changed: ${said(error)}`, top.ref, error); return NOT_MADE }
      }
      // One that was called has finished, so it is no longer pending. That is the kernel's to say, and it is said before
      // the handler, which may call it again.
      if (item.made) { live.delete(item.id); pendingChanged(top) }
      // A read that has ended stays as what was asked, so that it is not asked again until its fields change. There
      // is nothing left of it to give up: stopping it later tells nobody.
      else item.live.stop = () => {}
      try { return apply(item.of, declared.done(item.outcome, given)) } catch (error) { defect(`${top.ref} threw in ${item.id} done, and nothing changed: ${said(error)}`, top.ref, error); return NOT_MADE }
    }
    if (item.kind === 'answer') {
      answeringOf.get(item.question)?.questions.delete(item.question)
      // An answer that came with a change: the change is made here, in the step the answer leaves in.
      const outcome = item.change ? withChange(item.change.of, item.change.next, item.outcome) : item.outcome
      answer(item.question, outcome)
      // An ask that is refused has changed nothing, whichever of its handler and its change refused.
      return outcome.ok
    }
    const top = running.get(item.ref)
    // Sent to a state that is not running. It may be one this step is about to start, so it waits until what runs
    // has been matched to the data.
    if (!top && !settling) { held.push(item); return MADE }
    if (item.kind === 'event') {
      note()
      // What a state sends itself is looked for among what only it sends, and then among what anyone may. What
      // comes from outside is looked for among what anyone may send, and nowhere else.
      const found = top && ((item.own ? taker(top, 'internal', item.event.type) : undefined) ?? taker(top, 'on', item.event.type))
      if (!found) {
        trace(top && !item.own && taker(top, 'internal', item.event.type)
          ? `${item.ref} was sent ${item.event.type} from outside, which only it sends itself: ignored`
          : `${item.ref} ignored ${item.event.type}`)
        return MADE
      }
      // A handler that throws changes nothing: the state is as it was before the event, which it could handle.
      try { return apply(found.of, found.handler(item.event, eventScopeOf(found.of))) } catch (error) {
        defect(`${item.ref} threw handling ${item.event.type}, and nothing changed: ${said(error)}`, item.ref, error)
        return NOT_MADE
      }
    }
    const { name, args, question, progress, gone } = item
    // Whoever asked already left (or finished its work) before this ask was taken: do not run the handler.
    if (gone?.aborted) return MADE
    note()
    askedOf.set(question, { ref: item.ref, name })
    const found = top && taker(top, 'answers', name)
    if (!found) { answer(question, refusal('unavailable', `${item.ref} does not take ${name}`)); return MADE }
    const signal = gone ? AbortSignal.any([found.of.controller.signal, gone]) : found.of.controller.signal
    const own = new AbortController()
    const workSignal = AbortSignal.any([signal, own.signal])
    const failed = (error: unknown): AnyOutcome => {
      if (error instanceof Refusal) return refusal(error.kind, error.message, error.data)
      // The handler was itself asking, and whoever asked it went: it stopped answering, it did not fail.
      if (error instanceof Cancelled) return refusal('abandoned', error.message)
      // Whoever asked is told it failed. Where it failed is said here, since the asker may be in another process.
      const message = said(error)
      // Work that was passed `signal` throws when it aborts. That is the handler stopping as it was asked to.
      if (signal.aborted) { trace(`${item.ref} stopped answering ${name}, as whoever asked had gone: ${message}`); return refusal('abandoned', message) }
      trace(`${item.ref} failed answering ${name}: ${message}`)
      return refusal('failed', message)
    }
    const nextChain = [...(item.chain ?? []), `${item.ref} ${name}`]
    try {
      const made = found.handler(args, Object.assign(workScopeOf(found.of, signal, own.signal, workSignal, nextChain), {
        refuse: (kind: string, message: string, data?: object) => new Refusal(kind, message, data),
        progress: (update: unknown) => { if (!workSignal.aborted) out(() => progress?.(update), { kind: 'progress', to: item.ref, name }) },
      }))
      if (made instanceof Promise) {
        found.of.questions.add(question)
        answeringOf.set(question, found.of)
        under(made,
          (value) => { own.abort(); if (!abandoned.has(question)) arrive(isAnswered(value) ? { kind: 'answer', question, outcome: { ok: true, value: value.answer }, change: { of: found.of, next: value.next } } : { kind: 'answer', question, outcome: { ok: true, value } }) },
          (error) => { const outcome = failed(error); own.abort(); if (!abandoned.has(question)) arrive({ kind: 'answer', question, outcome }) },
        )
        // What it wrote before it waited is kept: it answers in a later step, and this one is made.
        return MADE
      } else {
        const outcome: AnyOutcome = isAnswered(made) ? withChange(found.of, made.next, { ok: true, value: made.answer }) : { ok: true, value: made }
        answer(question, outcome)
        if (outcome.ok) own.abort(); else abortAfterUnsay(own)
        return outcome.ok
      }
    } catch (error) { const outcome = failed(error); abortAfterUnsay(own); answer(question, outcome); return NOT_MADE }
  }

  /**
   * Answers every ask among what was waiting to be taken, and lets the rest go: for a system that takes no more
   * steps, so that nobody is left waiting on one.
   */
  const turnAway = (items: Queued[], why: string): void => {
    for (const item of items) if (item.kind === 'ask') safely('answering an ask that will not be taken', () => item.question.end(refusal('unavailable', why)))
  }
  const STOPPED = 'It stopped when it could not keep what a step wrote'
  const HALTED = 'The step was halted after running away'
  const LIMIT_REACHED = 'It has taken every step it is allowed'
  /**
   * A step's rows could not be kept. Nothing has left yet, so nobody was told of a change that was not made. The
   * states are ahead of the rows now, and the system stops, all of it: an ask in the step is told it failed, one
   * that was waiting to be taken is told there is nothing to take it, and every state ends, which ends the work it
   * was doing and the asks it was answering. Nothing is left that somebody could be waiting on.
   */
  const lost = (error: unknown, told: typeof logging): (() => void) => {
    broken = true
    defect(`${called} could not keep what a step wrote, and has stopped: its states were ahead of its rows. ${said(error)}`, undefined, error)
    changed.clear(); fields.clear(); places.clear(); stale.clear(); restarted.clear()
    // Whoever asked in this step is told it failed. Nothing else the step would have sent leaves.
    if (told) told.status = 'lost'
    for (const leave of leaving.splice(0)) {
      if (!leave.lost) continue
      safely('what leaves at the commit', leave.lost)
      if (told && leave.said) {
        const entry = sentOf(leave.said)
        told.sent.push(entry.kind === 'answer' ? { ...entry, outcome: 'failed' } : entry)
      }
    }
    turnAway(inside.drain(), STOPPED); turnAway(outside.drain(), STOPPED); turnAway(held.splice(0), STOPPED)
    for (const ref of [...running.keys()].reverse()) end(ref)
    const refs = [...changed]
    changed.clear(); fields.clear(); places.clear(); stale.clear(); restarted.clear()
    committed.clear()
    const stopLeaving = leaving.splice(0)
    return () => {
      for (const leave of stopLeaving) {
        safely('what leaves as it stops', leave)
        if (told && leave.said) told.sent.push(sentOf(leave.said))
      }
      for (const listener of [...listeners]) safely('a subscriber', () => listener(refs, {}, {}))
      turnAway(outside.drain(), STOPPED)
    }
  }
  const prepareCommit = (told: typeof logging): (() => void) => {
    if (changed.size) {
      const refs = [...changed]
      changed.clear()
      for (const ref of refs) {
        const before = restarted.has(ref) ? committed.get(ref) as { at?: string; data: Plain } | undefined : undefined
        const top = running.get(ref)
        if (top) {
          const after = valueOf(top) as { at?: string; data: Plain }
          committed.set(ref, after)
          if (before) {
            if (before.at !== after.at) placesOf(ref).moved = true
            for (const field of new Set([...Object.keys(before.data), ...Object.keys(after.data)])) {
              if (Object.hasOwn(before.data, field) !== Object.hasOwn(after.data, field) || !Object.is(before.data[field], after.data[field])) {
                fields.set(ref, (fields.get(ref) ?? new Set()).add(field))
              }
            }
          }
        } else {
          committed.delete(ref)
        }
      }
      restarted.clear()
      const which = Object.fromEntries([...fields].map(([ref, touched]) => [ref, [...touched]]))
      fields.clear()
      const where = Object.fromEntries(places)
      places.clear()
      if (told) told.changed = Object.fromEntries(refs.map((ref) => [ref, {
        fields: which[ref] ?? [], moved: where[ref]?.moved ?? false, pending: where[ref]?.pending ?? false, waiting: where[ref]?.waiting ?? false,
        at: (committed.get(ref) as { at?: string } | undefined)?.at ?? '',
      }]))
      leaving.push(() => { for (const listener of [...listeners]) safely('a subscriber', () => listener(refs, which, where)) })
    }
    const now = leaving.splice(0)
    return () => {
      for (const leave of now) {
        safely('what leaves at the commit', leave)
        if (told && leave.said) told.sent.push(sentOf(leave.said))
      }
    }
  }

  /** One step: something from outside, then everything it caused inside, then the commit. */
  let steps = 0
  let spent = false
  const step = (first: () => void, stopping = false): void => {
    if (!stopping && host.limit !== undefined && steps >= host.limit) {
      if (!spent) { spent = true; defect(`${called} took ${host.limit} steps and takes no more: something leads to something else without end`) }
      // Nothing more is taken: an ask that was waiting to be is answered, or it would wait for good.
      turnAway(inside.drain(), LIMIT_REACHED); turnAway(outside.drain(), LIMIT_REACHED)
      return
    }
    if (broken) { turnAway(inside.drain(), STOPPED); turnAway(outside.drain(), STOPPED); return }
    stepping = true
    const log = host.log
    // Whether everything was handled. A throw before that is the kernel's own; one after is the database not keeping it.
    let handled = false
    let told: typeof logging
    let flush: (() => void) | undefined
    const all = (): void => {
      first()
      let count = 0
      let halted = false
      for (;;) {
        for (; inside.any; count++) {
          const item = inside.shift()
          if (count < RUNAWAY) { handle(item); continue }
          // What it had done is committed, so that the states can be read and the report says where they got to.
          halted = true
          defect(`a step was halted after ${RUNAWAY} things, at ${'ref' in item ? item.ref : item.kind}: something tells something else without end`, 'ref' in item ? item.ref : undefined)
          if (told) told.status = 'halted'
          if (item.kind === 'ask') safely('answering an ask that will not be taken', () => item.question.end(refusal('unavailable', HALTED)))
          turnAway(inside.drain(), HALTED)
          turnAway(held.splice(0), HALTED)
          break
        }
        // What runs is matched to the data once everything sent so far is handled, and not in between. So which
        // states run depends on the data the step leaves and not on the way it got there: a key taken out and put
        // back is a key that stayed, whether one handler did both or two did one each.
        matchStale()
        if (halted) { turnAway(inside.drain(), HALTED); turnAway(held.splice(0), HALTED); break }
        const ready = held.filter((item) => running.has(item.ref))
        if (!ready.length && !inside.any) break
        for (const item of ready) { held.splice(held.indexOf(item), 1); inside.push(item) }
      }
      // What is still waiting was sent to nothing that runs.
      settling = true
      try { for (const item of held.splice(0)) handle(item) } finally { settling = false }
      handled = true
    }
    try {
      if (host.clock) {
        if (stopping) { try { stepNow = readNow() } catch { stepNow = lastNow } }
        else stepNow = readNow()
      }
      steps++
      told = log ? { ...(stepNow === undefined ? {} : { now: stepNow }), handled: [], changed: {}, sent: [], status: 'committed' } : undefined
      logging = told
      // The step is one unit: its rows are kept as `transact` returns, and only then does anything leave.
      try { if (host.transact) host.transact(all); else all() } catch (error) {
        // The kernel's own throw: not a step that ended any way a log says, and not logged.
        if (!handled) {
          told = undefined
          changed.clear(); fields.clear(); places.clear(); stale.clear(); restarted.clear()
          throw error
        }
        flush = lost(error, told)
      }
      if (!flush) flush = prepareCommit(told)
    } finally {
      stepping = false; stepNow = undefined; hearing = undefined; logging = undefined
    }
    flushing = true
    try { flush() } finally {
      if (log && told) safely('the step log', () => log({ number: ++logged, ...told }))
      flushing = false
    }
  }
  /** What was sent in this step to a state that is not running, until the step's match says whether it is to be. */
  const held: Array<Extract<Item, { ref: string }>> = []
  let settling = false
  const starting = new Set<string>()
  const pump = (): void => {
    while (!stepping && !flushing && outside.any) {
      const next = outside.peek()
      if (next.kind === 'run') { outside.shift(); step(next.fn, next.stopping) }
      else step(() => { outside.shift(); handle(next) })
    }
  }
  const run = (fn: () => void, stopping = false): void => {
    if (stepping) { fn(); return }
    outside.push({ kind: 'run', fn, stopping })
    pump()
  }
  const arrive = (item: Item): void => { handOver(); outside.push(item); pump() }
  const enqueue = (item: Item): void => { if (stepping) inside.push(item); else arrive(item) }

  const port: Port = {
    tell: (to, event) => arrive({ kind: 'event', ref: to, event: event as AnyEvent }),
    ask: (to, name, args, progress, done) => {
      const gone = new AbortController()
      arrive({
        kind: 'ask', ref: to, name, args: args as object,
        question: new Question((outcome) => done(outcome as PortOutcome)),
        progress,
        gone: gone.signal,
      })
      return () => gone.abort(new Error('Whoever asked has gone'))
    },
    follow: (feature, view, args, updated, failed) => {
      if (!host.views) { failed({ kind: 'unavailable', message: `${called} runs no views` }); return { stop: () => {} } }
      const running = host.views(feature, view, args as object, (update) => updated(update))
      const following: Following = typeof running === 'function' ? { stop: running } : running
      return {
        stop: () => safely('stopping a view', () => following.stop()),
        ...(following.caughtUp ? { caughtUp: following.caughtUp.bind(following) } : {}),
      }
    },
  }

  const self: System = {
    port,
    start: (ref, made, ...entering) => {
      if (broken) throw new Error(`${called} cannot start ${ref}: ${STOPPED}`)
      if (host.limit !== undefined && steps >= host.limit) throw new Error(`${called} cannot start ${ref}: ${LIMIT_REACHED}`)
      if (running.has(ref) || starting.has(ref)) throw new Error(`${called} already has a running state named ${ref}`)
      const def = made.def as LooseDef
      const initial = entering[0] as Plain | undefined
      const problem = cannotBegin(def, initial)
      if (problem) throw new Error(`${ref} ${problem}`)
      starting.add(ref)
      try {
        run(() => { starting.delete(ref); begin(ref, def, initial, undefined, made.resolve) })
      } catch (error) {
        starting.delete(ref)
        throw error
      }
      return { ref }
    },
    child: ((of: { ref: string }, name: string, key?: string) => ({ ref: key === undefined ? `${of.ref}/${name}` : `${of.ref}/${name}/${key}` })) as unknown as System['child'],
    send: (to, event) => arrive({ kind: 'event', ref: to.ref, event }),
    ask: (of, name, args, hears) => ask(of, name, args, undefined, hears as ((updates: unknown[]) => void) | undefined),
    read: (of) => committed.get(of.ref) as never,
    snapshot: () => Object.fromEntries(committed),
    subscribe: (listener) => {
      listeners.push(listener)
      return () => { const index = listeners.indexOf(listener); if (index >= 0) listeners.splice(index, 1) }
    },
    attach: ((peerOrName: Port | string, peer?: PeerPort | ((event: AnyEvent) => void)) => {
      if (typeof peerOrName === 'string') {
        const port: PeerPort = typeof peer === 'function'
          ? { tell: (_peer, event) => peer(event as AnyEvent) }
          : peer!
        if (peers.has(peerOrName)) throw new Error(`${called} already has a peer named ${peerOrName}`)
        peers.set(peerOrName, port)
        return () => { if (peers.get(peerOrName) === port) peers.delete(peerOrName) }
      }
      if (host.side === 'backend') {
        down.add(peerOrName)
        return () => { down.delete(peerOrName) }
      }
      if (up) throw new Error(`${called} is already attached to a backend`)
      up = peerOrName
      if (!host.views && running.size && !broken) run(() => { for (const ref of running.keys()) stale.set(ref, 'all') })
      return () => {
        if (up !== peerOrName) return
        up = undefined
        if (host.views) return
        for (const top of running.values()) {
          for (let active: Active | undefined = top.root; active; active = active.inside) {
            for (const live of active.following.values()) live.stop()
            active.following.clear()
          }
        }
      }
    }) as System['attach'],
    idle: () => pending === 0 && !due && !stepping && !flushing && !outside.any,
    stop: (of) => {
      if (of === undefined) { run(() => { for (const ref of [...running.keys()].reverse()) end(ref) }, true); return }
      const cannotStopChild = (starterRef: string): string =>
        `${called} cannot stop ${of.ref}: it was started by ${starterRef}; change its starter's data to stop it`
      const existing = running.get(of.ref)
      if (existing?.starter) throw new Error(cannotStopChild(existing.starter.ref))
      if (!existing && !outside.any) return
      run(() => {
        const top = running.get(of.ref)
        if (!top) return
        if (top.starter) { defect(cannotStopChild(top.starter.ref), of.ref); return }
        end(of.ref)
      }, true)
    },
    [Symbol.dispose]: () => { self.stop() },
  }
  return self as System<N>
}
