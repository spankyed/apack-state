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
//   make(name, key?)         from a state: has one of the asks it declares under `makes` made, once
//
// What a state starts, the views it follows and the asks it awaits are declared, each naming the fields of the data
// it depends on. Which of them are live follows from the data, and is looked at again only when one of those changes.
// Those are standing: while the data says so, they go on. An ask to make once is not, and is made by saying so.

import { produce } from './draft.ts'
import { nextTurn } from './turn.ts'
import { ANSWERED, given, type AllStarts, type Answered, type AnyEvent, type AnyOutcome, type Asks, type Each, type Handle, type HandleOf, type OutcomeOf, type ProgressOf, type Read, type Shape, type Started, type State, type Value, type ViewHost, type Viewing, type ViewUpdate } from './types.ts'
import { PORT, type Heard, type Lane, type Link, type Port } from './port.ts'

// ── the system ──────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * What an ask is ended with when whoever made it has gone: the state that asked was left, or the system stopped.
 * It is raised where the ask is awaited, as cancellation is everywhere else, so that `finally` runs and what was
 * held is released. The kernel discards it at the top of `run` and of an ask's handler; nothing has to catch it.
 */
export class Left extends Error {
  constructor(what: string) { super(`${what} was left before this ask was answered`); this.name = 'Left' }
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
const refusal = (kind: string, message: string, data?: object): AnyOutcome => ({ ok: false, failure: { ...data, kind, message } })

type Plain = Record<string, unknown>
type LooseDef = { data?: Plain; start?: string; on?: Record<string, Function>; internal?: Record<string, Function>; asks?: Record<string, Function>; run?: Function; failed?: Function; states?: Record<string, LooseDef>; starts?: (start: Function) => Record<string, { def: unknown } | { state: { def: unknown }; given: Function; each?: string }>
  follows?: (follow: Function) => Record<string, { feature: string; view: string; each?: string; from?: readonly string[]; args: Function; heard: Function }>
  awaits?: (asking: Function) => Record<string, { of: string; ask: string; each?: string; from?: readonly string[]; args: Function; ended: Function; heard?: Function }>
  makes?: (asking: { one: Function; each: Function }) => Record<string, { kind: 'one' | 'each'; of: string; ask: string; args: Function; ended: Function; heard?: Function }>
}

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
  /** The asks it awaits, by name and key, in the same terms. */
  readonly awaiting: Map<string, Live>
  /** The asks it was told to make and that have not ended, by name and key. */
  readonly making: Map<string, Live>
}
/**
 * One view being followed or one ask awaited: the values of the fields it named when it was asked, how to stop it,
 * and which deliveries led to it being asked.
 */
interface Live { readonly seen: readonly unknown[]; readonly because: ReadonlySet<string>; stop: () => void }
interface Running {
  /** Every ask it can be told to make, whichever of its states declares it, and which kind each is. */
  makes: Map<string, 'one' | 'each'>
  ref: string; data: Plain; root: Active; starter?: { readonly ref: string; readonly from: string }
}

type Item =
  | { kind: 'event'; ref: string; event: AnyEvent; /** Sent by the state to itself. */ own?: true }
  | { kind: 'ask'; ref: string; name: string; args: object; question: Question; heard?: Heard; gone?: AbortSignal }
  | { kind: 'result'; of: Active; value: unknown }
  | { kind: 'failure'; of: Active; error: unknown }
  | { kind: 'view'; of: Active; name: string; id: string; key: string | undefined; update: ViewUpdate<unknown> }
  | { kind: 'ended'; made: boolean; of: Active; name: string; id: string; key: string | undefined; live: Live; outcome: AnyOutcome }
  | { kind: 'progressed'; made: boolean; of: Active; name: string; id: string; key: string | undefined; live: Live; updates: unknown[] }
  | { kind: 'make'; of: Active; name: string; key: string | undefined }
  | { kind: 'drop'; of: Active; name: string; key: string | undefined }
  | { kind: 'answer'; question: Question; outcome: AnyOutcome; change?: { of: Active; next: unknown } }
  | { kind: 'out'; leave: () => void; said?: Sent }

/**
 * A database's `transact`, which is all the kernel knows of one: it runs a function as one unit, whose writes are kept
 * together when it returns and undone when it throws. One inside another joins it, and is undone alone when it throws.
 */
export type Transact = <T>(run: () => T) => T

/** One thing a step handled, as its log says it: what kind, for which running state, and its name. Never what it carried. */
export interface Handled {
  readonly kind: 'event' | 'ask' | 'result' | 'failure' | 'view' | 'ended' | 'progressed' | 'make' | 'drop' | 'answer'
  readonly ref: string
  /** An event's type, an ask's name, what is followed, awaited or made, as the state declares it. */
  readonly name?: string
  /** Which one, for one of many. */
  readonly key?: string
  /** An event the state sent itself. */
  readonly own?: true
}
/** One thing that left at a step's commit: what kind, to whom, and its name. Never what it carried. */
export interface Sent {
  readonly kind: 'answer' | 'abandoned' | 'progress' | 'tell' | 'ask' | 'broadcast' | 'follow' | 'unfollow'
  readonly to?: string
  readonly name?: string
  /** How an answer ended: `ok`, or its failure's kind. */
  readonly outcome?: string
}
/**
 * One step, once it has ended, as a timeline or a devtools panel would read it: what began it and everything it
 * handled after, the fields of each state that changed, and what left at its commit. Never what any of it carried.
 */
export interface StepLog {
  /** This system's steps, counted from 1. */
  readonly number: number
  /** `committed`; `lost`, when its rows could not be kept and the system stopped; `cut short`, when it ran away. */
  readonly ended: 'committed' | 'lost' | 'cut short'
  /** Everything it handled, in order: the first is what began it. */
  readonly handled: readonly Handled[]
  /** Each running state that changed: the fields of its data that did, whether it moved and where it is, and whether what it is making changed. */
  readonly changed: Readonly<Record<string, { readonly fields: readonly string[]; readonly moved: boolean; readonly at: string; readonly making: boolean }>>
  /** What left at the commit, in order. */
  readonly left: readonly Sent[]
}


/**
 * What changed in one running state in one step: whether it is somewhere else now, and each place in its data that
 * changed, as a path. `['messages', 'THR-1', '3']` is the fourth message of one thread, and nothing else.
 */
export interface Changes { readonly moved: boolean; /** Whether what it is making changed. */ readonly making: boolean }

export interface System {
  start<S extends Shape, E extends AnyEvent, A extends Asks>(ref: string, made: State<S, E, A>): Handle<Value<S>, E, A, AllStarts<S>>
  /**
   * A state that this one starts, by the name it is declared under, and by key where there is one for each. This is
   * how something outside a handler reaches one: a component reading one card of many.
   */
  child<C, K extends keyof C & string>(of: Handle<unknown, any, any, C>, name: K, ...key: C[K] extends Each<any> ? [key: string] : []): HandleOf<C[K]>
  send<E extends AnyEvent>(to: Handle<unknown, E, Asks>, event: Read<E>): void
  ask<A extends Asks, Q extends keyof A & string>(of: Handle<unknown, never, A>, name: Q, args: Read<A[Q]['args']>, heard?: (updates: ReadonlyArray<ProgressOf<A[Q]>>) => void): Promise<OutcomeOf<A[Q]>>
  read<V>(of: Started<V, never, Asks, any>): V | undefined
  read<V>(of: Handle<V, never, Asks>): V
  /** Every running state here, as of the last commit. */
  snapshot(): Record<string, unknown>
  /** Called once per step that changed anything, after it has committed, until what it returns is called. */
  subscribe(listener: (changed: readonly string[], fields: Readonly<Record<string, readonly string[]>>, changes: Readonly<Record<string, Changes>>) => void): () => void
  /** From a window: joins it to its backend. Closing the link is the window going away. */
  connect(backend: System): { close(): void }
  /**
   * Whether nothing is under way here: no work a state is doing, no ask being answered or waited on, nothing put off
   * and nothing gathered. For a check, to wait until what it did has come to rest and not for a count of turns.
   */
  idle(): boolean
  stop(): void
}

/** More than this handled in one step is states telling each other without end: the step is cut short and reported. */
const RUNAWAY = 10_000

/** A data field holding more items than this is reported: a collection that large belongs in a view. */
const LARGE = 10_000

export function system(host: {
  side: 'backend' | 'window'
  /** What this system is called in a lane's label and nowhere else. */
  name?: string
  views?: ViewHost
  /**
   * The `transact` of the database this system's rows are kept in. With one, a step is a unit of it: a handler's rows,
   * the data it changed and what it sent are kept together, and a handler that changes nothing has written nothing.
   */
  transact?: Transact
  /**
   * Runs something later, after whatever is ahead of it in its lane. The default is the next turn of the event loop.
   * A check gives a schedule here, which decides the order between lanes and can run every one of them.
   */
  later?(lane: Lane, run: () => void): void
  /** Runs something once per frame. A window gives `requestAnimationFrame`; the default is the next turn of the event loop. */
  frame?(run: () => void): void
  trace?(line: string): void
  /** Told of each step once it has ended: what it handled, what it changed, and what left. Never a payload. */
  log?(step: StepLog): void
  /**
   * How many steps it will take before it takes no more. For a check, so that a kernel that never comes to rest is
   * heard from. The app gives none: one thing leading to the next for as long as it runs is what an agent's loop is.
   */
  limit?: number
}): System {
  const trace = (line: string): void => { host.trace?.(line) }
  const called = host.name ?? host.side
  /** How many things are under way: work, asks, and what was put off. Nothing is, when this is nought. */
  let pending = 0
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
  const safely = (what: string, call: () => void): void => {
    try { call() } catch (error) { trace(`DEFECT: ${what} threw: ${said(error)}`) }
  }
  const running = new Map<string, Running>()
  const outside: Item[] = []
  const inside: Item[] = []
  /** What leaves when the step commits: answers, progress, what crosses a link, and word to subscribers. */
  const leaving: Array<(() => void) & { lost?: () => void; said?: Sent }> = []
  /** For each ask a state here was asked, which it was: what its answer is said to be to. */
  const askedOf = new WeakMap<Question, { readonly ref: string; readonly name: string }>()
  /** The state answering each ask it answers later, until the answer is taken; and each ask it left unanswered. */
  const answeringOf = new WeakMap<Question, Active>()
  const abandoned = new WeakSet<Question>()
  /** The step being logged: what it has handled, and, once it ends, what changed and what left. */
  let logging: { handled: Handled[]; changed: StepLog['changed']; left: Sent[]; ended: StepLog['ended'] } | undefined
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
  /** The views this backend runs for its windows that can say when they have caught up: what the hold asks. */
  const forWindows = new Set<Viewing>()
  /**
   * What is waiting to go to windows, in the order it was sent, until the views have been handed what its step kept.
   * One list for every window: what a backend sends them keeps its order across them too.
   */
  const toWindows: Array<() => void> = []
  /** How many of those have been asked after: what was sent since is still to be. */
  let askedAfter = 0
  /**
   * Each asking of the views, oldest first: how many of what waits it lets go, and the views that have not called
   * back. A round leaves when it and every round before it are done, so what is sent keeps its order.
   */
  const rounds: Array<{ count: number; waiting: Set<Viewing> }> = []
  /** Sends something to a window: once the views it follows have been handed the rows of the step it leaves in. */
  const toAWindow = (send: () => void): void => { toWindows.push(send) }
  const letGo = (): void => {
    while (rounds.length && rounds[0]!.waiting.size === 0) {
      const { count } = rounds.shift()!
      askedAfter -= count
      // What was sent before the views were asked, and so before everything kept by then was handed to them.
      for (const send of toWindows.splice(0, count)) safely('what is sent to a window', send)
    }
  }
  /**
   * After a step has left: has what it sent windows go once each view run for a window has caught up with it. A view
   * that cannot say is not waited on, and with none to wait on what was sent goes at once, behind what waits before it.
   */
  const release = (): void => {
    if (toWindows.length === askedAfter) return
    const count = toWindows.length - askedAfter
    askedAfter = toWindows.length
    const round = { count, waiting: new Set(forWindows) }
    rounds.push(round)
    // Counted as the round is made: a view taken out of it before it is asked, stopped by another's call, is counted
    // out as it was counted in.
    pending += round.waiting.size
    /** The view is caught up for this round: once, whether it says so, stops, or cannot be asked. */
    const caught = (viewing: Viewing): void => {
      if (!round.waiting.delete(viewing)) return
      pending--
      letGo()
    }
    for (const viewing of [...round.waiting]) {
      // Something is blocked on it: an asker, or a window to be told. A view that throws when asked cannot say, and
      // is not waited on.
      try { viewing.caughtUp!(() => { caught(viewing) }, true) } catch (error) {
        trace(`DEFECT: a view threw when asked whether it had caught up: ${said(error)}`)
        caught(viewing)
      }
    }
    letGo()
  }
  /** An answer leaves when the step's rows are kept. If they cannot be, whoever asked is told that it failed. */
  const answer = (question: Question, outcome: AnyOutcome): void => {
    const asked = askedOf.get(question)
    const said: Sent = { kind: 'answer', ...(asked ? { to: asked.ref, name: asked.name } : {}), outcome: outcome.ok ? 'ok' : outcome.failure.kind }
    leaving.push(Object.assign(() => question.end(outcome), { lost: () => question.end(refusal('failed', 'What this step wrote could not be kept, so nothing was changed')), said }))
  }
  const changed = new Set<string>()
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
  /** Whether each moved, and whether what it is making changed, in this step. */
  const places = new Map<string, { moved: boolean; making: boolean }>()
  const placesOf = (ref: string) => places.get(ref) ?? places.set(ref, { moved: false, making: false }).get(ref)!
  /** What a state is making changed. That is not its data, so nothing it starts, follows or awaits is looked at again. */
  const madeChanged = (top: Running): void => { changed.add(top.ref); placesOf(top.ref).making = true }
  /** A move can add and remove fields as states are left and entered: each one that differs afterwards changed. */
  const moved = (top: Running, was: Plain): void => {
    mark(top.ref)
    placesOf(top.ref).moved = true
    for (const field of new Set([...Object.keys(was), ...Object.keys(top.data)])) {
      if (field in was !== field in top.data || !Object.is(was[field], top.data[field])) touch(top.ref, field)
    }
  }
  const listeners: Array<(changed: readonly string[], fields: Readonly<Record<string, readonly string[]>>, changes: Readonly<Record<string, Changes>>) => void> = []
  let committed: Record<string, unknown> = {}
  let stepping = false

  /** A window's link to its backend, and the asks waiting on it. */
  let up: { link: Link; port: Port; waiting: Set<Question>; gone: Set<() => void> } | undefined
  /** A backend's links to its windows. */
  const down = new Set<{ link: Link; port: Port }>()
  const carry = (link: Link, way: 'up' | 'down', across: () => void): void => { later(link[way], () => { if (link.open) across() }) }

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
    const value: Plain = at ? { at, data: frozen({ ...top.data }) } : { data: frozen({ ...top.data }) }
    if (!top.makes.size) return Object.freeze(value)
    // Which of the asks it can be told to make are under way, in the states that are the case.
    const making: Plain = Object.fromEntries([...top.makes].map(([name, kind]) => [name, kind === 'each' ? {} : false]))
    for (let active: Active | undefined = top.root; active; active = active.inside) {
      for (const id of active.making.keys()) {
        const cut = id.indexOf('/')
        if (cut < 0) making[id] = true; else (making[id.slice(0, cut)] as Plain)[id.slice(cut + 1)] = true
      }
    }
    return Object.freeze({ ...value, making: frozen(making) })
  }
  const refOf = (to: string | { ref: string }): string => (typeof to === 'string' ? to : to.ref)
  const isSurface = (to: unknown): to is { surface: string } => typeof to === 'object' && to !== null && 'surface' in to

  /** Something to leave at the commit: of this step, or of one of its own if none is running. */
  const out = (leave: () => void, said?: Sent): void => { if (stepping) leaving.push(Object.assign(leave, { said })); else arrive({ kind: 'out', leave, ...(said ? { said } : {}) }) }

  /** A name is a backend system: here on the backend, across the link from a window. A handle is always here. */
  const isAcross = (to: string | { ref: string }): boolean => typeof to === 'string' && host.side === 'window'

  const tell = (to: string | { ref: string } | { surface: string }, event: AnyEvent): void => {
    if (isSurface(to)) {
      // A surface is in a window, and is told there. The backend has one of it in every window, and broadcasts.
      if (host.side !== 'window') { trace(`DEFECT: ${called} told the surface ${to.surface} ${event.type}. A surface is told from its own window, and broadcast to from the backend`); return }
      enqueue({ kind: 'event', ref: to.surface, event })
      return
    }
    const ref = refOf(to)
    if (!isAcross(to)) { enqueue({ kind: 'event', ref, event }); return }
    const mine = up
    if (!mine) { trace(`nothing to tell ${ref}: not connected`); return }
    out(() => carry(mine.link, 'up', () => mine.port.event(ref, event)), { kind: 'tell', to: ref, name: event.type })
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
  const ask = (to: string | { ref: string }, name: string, args: object, signal: AbortSignal | undefined, hears: ((updates: unknown[]) => void) | undefined): Promise<never> => asked(new Promise((resolve, reject) => {
    const ref = refOf(to)
    const heard = hears && gather(hears, signal)
    // What was gathered is handed over before the answer, so an answer is never ahead of progress sent before it.
    const question = new Question((outcome) => { handOver(); if (!signal?.aborted) (resolve as unknown as (outcome: AnyOutcome) => void)(outcome) })
    // Which ask it is, for what is logged of how it ends: here or across the link, it may end without being taken.
    askedOf.set(question, { ref, name })
    // Whoever asked has gone: the ask ends where it is awaited, with `Left`, so the code that asked unwinds.
    const left = (): void => { trace(`an ask of ${ref} for ${name} was left unanswered by whoever made it`); reject(new Left(name)) }
    if (signal?.aborted) { left(); return }
    signal?.addEventListener('abort', left, { once: true })
    // In the same system the asker's own signal tells the answerer; across a link, the port does.
    if (!isAcross(to)) { enqueue({ kind: 'ask', ref, name, args, question, heard, gone: signal }); return }
    const mine = up
    if (!mine) { question.end(refusal('disconnected', `Not connected, so ${ref} cannot be asked`)); return }
    mine.waiting.add(question)
    out(() => carry(mine.link, 'up', () => {
      // Whoever asked may have ended before the ask crossed the link: then it is never started.
      if (signal?.aborted) { mine.waiting.delete(question); return }
      // A port may answer before it returns, as a link that has closed does: what it returns is not there yet then,
      // and an ask that has ended is not one to let go of.
      let gone: (() => void) | undefined
      let ended = false
      gone = mine.port.ask(ref, name, args,
        (update) => carry(mine.link, 'down', () => heard?.(update)),
        (outcome) => carry(mine.link, 'down', () => {
          ended = true
          mine.waiting.delete(question)
          if (gone) mine.gone.delete(gone)
          question.end(outcome)
        }))
      if (ended) return
      mine.gone.add(gone)
      signal?.addEventListener('abort', gone, { once: true })
    }), { kind: 'ask', to: ref, name })
  }))

  const scopeOf = (mine: Active, signal: AbortSignal = mine.controller.signal) => {
    const alive = (): boolean => !mine.controller.signal.aborted
    const ref = mine.top.ref
    return {
      get data() { return mine.top.data },
      get snapshot() { return valueOf(mine.top) },
      signal,
      send: (event: AnyEvent) => { if (alive()) enqueue({ kind: 'event', ref, event, own: true }) },
      tell: (to: string | { ref: string } | { surface: string }, event: AnyEvent) => { if (alive()) tell(to, event) },
      ask: (to: string | { ref: string }, name: string, args: object, hears?: (updates: unknown[]) => void) => {
        const asked = ask(to, name, args, signal, hears)
        // An ask that was started and never awaited ends with `Left` like any other, and that is not a failure of the process.
        asked.catch(() => {})
        return asked
      },
      broadcast: (to: string, event: AnyEvent) => { if (alive()) out(() => toAWindow(() => { for (const window of down) carry(window.link, 'down', () => window.port.event(to, event)) }), { kind: 'broadcast', to, name: event.type }) },
      make: (name: string, key?: string) => { if (alive()) enqueue({ kind: 'make', of: mine, name, key }) },
      drop: (name: string, key?: string) => { if (alive()) enqueue({ kind: 'drop', of: mine, name, key }) },
      report: (event: AnyEvent) => {
        if (!alive()) return
        const starter = mine.top.starter
        if (!starter) { trace(`${ref} was started by nothing, so it has nobody to report ${event.type} to`); return }
        enqueue({ kind: 'event', ref: starter.ref, event: { ...event, from: starter.from } as AnyEvent })
      },
      read: (target: { ref: string }) => valueOf(running.get(target.ref)!),
      child: (name: string, key?: string) => ({ ref: key === undefined ? `${ref}/${name}` : `${ref}/${name}/${key}` }),
      use: (release: () => void) => { mine.releases.push(release) },
    }
  }

  const enter = (top: Running, def: LooseDef, name: string, around: Active | undefined, entering: Plain): Active => {
    const path = around?.path ? `${around.path}.${name}` : name
    const active: Active = { top, def, name, path, around, inside: undefined, controller: new AbortController(), releases: [], questions: new Set(), started: new Set(), following: new Map(), awaiting: new Map(), making: new Map() }
    if (around) around.inside = active; else top.root = active
    for (const [field, initial] of Object.entries(def.data ?? {})) {
      if (field in entering) top.data = { ...top.data, [field]: entering[field] }
      else if (initial === given) trace(`DEFECT: ${top.ref} entered ${path} without ${field}`)
      else top.data = { ...top.data, [field]: initial }
    }
    if (path) trace(`${top.ref} entered ${path}`)
    let made: unknown
    // What `run` throws at once is a failure like any later one, taken up when the entering it is part of is done.
    // And what it wrote before it threw is taken back: work that fails at once has done nothing.
    const begin = (): void => { made = def.run?.(scopeOf(active)) }
    try { if (host.transact) host.transact(begin); else begin() } catch (error) { inside.push({ kind: 'failure', of: active, error }); return active }
    if (made instanceof Promise) {
      under(made, (value) => arrive({ kind: 'result', of: active, value }), (error) => arrive({ kind: 'failure', of: active, error }))
    } else if (made !== undefined) inside.push({ kind: 'result', of: active, value: made })
    return active
  }

  const exit = (active: Active): void => {
    if (active.inside) exit(active.inside)
    if (active.path) trace(`${active.top.ref} left ${active.path}`)
    active.controller.abort()
    for (const live of [...active.following.values(), ...active.awaiting.values()]) live.stop()
    active.following.clear()
    active.awaiting.clear()
    if (active.making.size) { for (const live of active.making.values()) live.stop(); active.making.clear(); madeChanged(active.top) }
    for (const ref of [...active.started].reverse()) end(ref)
    active.started.clear()
    for (const question of active.questions) {
      // Ended as abandoned: an answer its handler gives later has nobody to go to, and is not one.
      abandoned.add(question)
      const asked = askedOf.get(question)
      leaving.push(Object.assign(() => question.end(refusal('abandoned', 'It stopped before answering')), { said: { kind: 'abandoned', ...(asked ? { to: asked.ref, name: asked.name } : {}) } satisfies Sent }))
    }
    for (const release of active.releases.reverse()) safely(`a release of ${active.top.ref}`, release)
    const { ...rest } = active.top.data
    for (const field of Object.keys(active.def.data ?? {})) delete rest[field]
    active.top.data = rest
    if (active.around) active.around.inside = undefined
  }

  const descend = (under: Active, names: readonly string[], entering: Plain): void => {
    let active = under
    for (const name of names) active = enter(active.top, active.def.states?.[name] ?? {}, name, active, entering)
    while (active.def.start !== undefined) active = enter(active.top, active.def.states?.[active.def.start] ?? {}, active.def.start, active, entering)
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

  /** What a definition declares, read from it once: each is a function of the helper its entries are made with. */
  const declared = new WeakMap<LooseDef, { starts: ReturnType<NonNullable<LooseDef['starts']>>; follows: ReturnType<NonNullable<LooseDef['follows']>>; awaits: ReturnType<NonNullable<LooseDef['awaits']>>; makes: ReturnType<NonNullable<LooseDef['makes']>> }>()
  const declaredBy = (def: LooseDef) => {
    let found = declared.get(def)
    if (!found) {
      found = {
        starts: def.starts?.((state: unknown, options: { each?: string; given: Function }) => ({ each: options.each, state, given: options.given })) ?? {},
        follows: def.follows?.((feature: string, view: string, options: object) => ({ feature, view, ...options })) ?? {},
        awaits: def.awaits?.((of: string, ask: string, options: object) => ({ of, ask, ...options })) ?? {},
        makes: def.makes?.({
          one: (of: string, ask: string, options: object) => ({ kind: 'one', of, ask, ...options }),
          each: (of: string, ask: string, options: object) => ({ kind: 'each', of, ask, ...options }),
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
        const start = (ref: string, def: unknown, from: string, given: () => Plain): void => {
          let entering: Plain
          try { entering = given() } catch (error) { trace(`DEFECT: ${top.ref} could not say what to give ${ref}: ${said(error)}`); return }
          at.started.add(ref)
          begin(ref, def as LooseDef, entering, { ref: top.ref, from })
        }
        if ('def' in declared) { if (!at.started.has(under)) start(under, declared.def, name, () => ({})); continue }
        if (declared.each === undefined) { if (!at.started.has(under)) start(under, declared.state.def, name, () => declared.given(top.data) as Plain); continue }
        if (!looks(declared.each)) continue
        trace(`${top.ref} looked at ${declared.each} for which ${name} to run`)
        const wanted = new Map<string, string>()
        for (const key of keysOf(top.data[declared.each])) {
          if (key.includes('/')) trace(`DEFECT: ${top.ref} has a ${name} under ${JSON.stringify(key)}, and a key cannot hold a slash`); else wanted.set(`${under}/${key}`, key)
        }
        for (const ref of [...at.started]) if (ref.startsWith(`${under}/`) && !wanted.has(ref)) { at.started.delete(ref); end(ref) }
        for (const [ref, key] of wanted) if (!at.started.has(ref)) start(ref, declared.state.def, key, () => declared.given(key, top.data) as Plain)
      }

      /**
       * One of what this state follows or awaits, as it should be now. `seen` is the values of the fields it named:
       * the data is never changed in place, so a field that changed is a different value, and comparing the two
       * says whether to ask again without working anything out.
       */
      const settle = (live: Map<string, Live>, id: string, seen: readonly unknown[], begin: (entry: Live) => (() => void) | undefined, nothing = false): void => {
        const now = live.get(id)
        if (now && now.seen.length === seen.length && now.seen.every((value, index) => Object.is(value, seen[index]))) return
        // There is nothing to ask for now: what was asked is given up, and nothing can come round.
        if (nothing) { now?.stop(); live.set(id, { seen, because: new Set(), stop: () => {} }); return }
        const here = `${top.ref}#${id}`
        // A circle would be asked again, deliver again, and never come to rest, each round a read. It is refused
        // where it closes: this one goes on as it was.
        if (now && hearing && (hearing.id === here || hearing.because.has(here))) {
          trace(hearing.id === here
            ? `DEFECT: what ${here} delivered changed a field it is itself asked from. It goes on as it was`
            : `DEFECT: what ${hearing.id} delivered changed a field ${here} is asked from, and ${here} is what led to ${hearing.id} being asked. ${here} goes on as it was`)
          return
        }
        now?.stop()
        live.delete(id)
        const because: ReadonlySet<string> = hearing ? new Set([...hearing.because, hearing.id]) : new Set()
        // In place before it begins, so that whatever it delivers can be told from what an earlier one did.
        const entry: Live = { seen, because, stop: () => {} }
        live.set(id, entry)
        const stop = begin(entry)
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

      // A window with no views of its own follows its backend's, over the link: what a view delivers comes down it
      // in order with everything else the backend sends.
      const linked = up
      const views: ViewHost | undefined = host.views ?? (linked && ((feature, view, args, heard) => {
        let stop: (() => void) | undefined
        let stopped = false
        out(() => carry(linked.link, 'up', () => {
          if (stopped) return
          stop = linked.port.view(feature, view, args, (update) => carry(linked.link, 'down', () => { if (!stopped) heard(update) }))
          linked.gone.add(stop)
        }), { kind: 'follow', to: feature, name: view })
        return () => {
          stopped = true
          const ended = stop
          // It stays among what the link's closing ends until it has crossed: closed first, it is ended then, once.
          if (ended) out(() => carry(linked.link, 'up', () => { if (linked.gone.delete(ended)) ended() }), { kind: 'unfollow', to: feature, name: view })
        }
      }))
      if (views) for (const [name, declared] of Object.entries(declaredBy(at.def).follows)) {
        const followed = (id: string, key: string | undefined, seen: readonly unknown[], args: () => unknown): void => settle(at.following, id, seen, (live) => {
          let asked: object
          try { asked = args() as object } catch (error) { trace(`DEFECT: ${top.ref} could not say what to ask ${id} for: ${said(error)}`); return undefined }
          const running = views(declared.feature, declared.view, asked, (update) => {
            if (!at.controller.signal.aborted && at.following.get(id) === live) arrive({ kind: 'view', of: at, name, id, key, update })
          })
          return typeof running === 'function' ? running : () => running.stop()
        })
        if (declared.each !== undefined) {
          for (const key of keysNow(at.following, name, declared.each, 'follow') ?? []) followed(`${name}/${key}`, key, [key], () => declared.args(key))
        } else {
          const from = declared.from ?? []
          if (!from.some(looks) && at.following.has(name)) continue
          followed(name, undefined, from.map((field) => top.data[field]), () => declared.args(picked(from)))
        }
      }

      for (const [name, declared] of Object.entries(declaredBy(at.def).awaits)) {
        const awaited = (id: string, key: string | undefined, seen: readonly unknown[], args: () => unknown): void => {
          let asked: object | null | undefined | false
          try { asked = args() as object | null | undefined | false } catch (error) { trace(`DEFECT: ${top.ref} could not say what to ask ${id} for: ${said(error)}`); return }
          const what = asked
          // Nothing to ask for is nothing asked, and it is still looked at again when its fields change.
          settle(at.awaiting, id, seen, (live) => {
          if (!what) return () => {}
          const given = new AbortController()
          const signal = AbortSignal.any([at.controller.signal, given.signal])
          const mine = (): boolean => at.awaiting.get(id) === live && !signal.aborted
          const hears = declared.heard && ((updates: unknown[]): void => { if (mine()) arrive({ kind: 'progressed', made: false, of: at, name, id, key, live, updates }) })
          const made = ask(declared.of, declared.ask, what, signal, hears) as unknown as Promise<AnyOutcome>
          // Given up, it ends with `Left`, which is that and nothing to hear of.
          made.then((outcome) => { if (mine()) arrive({ kind: 'ended', made: false, of: at, name, id, key, live, outcome }) }, () => {})
          return () => given.abort()
          }, !what)
        }
        if (declared.each !== undefined) {
          for (const key of keysNow(at.awaiting, name, declared.each, 'await') ?? []) awaited(`${name}/${key}`, key, [key], () => declared.args(key))
        } else {
          const from = declared.from ?? []
          if (!from.some(looks) && at.awaiting.has(name)) continue
          awaited(name, undefined, from.map((field) => top.data[field]), () => declared.args(picked(from)))
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
        if (initial === given && !(field in entering)) return `cannot enter ${path} without ${field}`
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
    for (let path = at; def.start !== undefined; ) {
      path = `${path}.${def.start}`
      def = def.states?.[def.start] ?? {}
      const problem = enters(def, path)
      if (problem) return problem
    }
    const stray = Object.keys(entering).find((field) => !after.has(field))
    return stray === undefined ? undefined : `will have no field ${stray} at ${at}`
  }

  const begin = (ref: string, def: LooseDef, entering: Plain = {}, starter?: Running['starter']): { ref: string } => {
    mark(ref)
    const makes = new Map<string, 'one' | 'each'>()
    const survey = (of: LooseDef): void => {
      for (const [name, made] of Object.entries(declaredBy(of).makes)) makes.set(name, made.kind)
      for (const inner of Object.values(of.states ?? {})) survey(inner)
    }
    survey(def)
    const top: Running = { ref, data: {}, root: undefined as unknown as Active, starter, makes }
    running.set(ref, top)
    descend(enter(top, def, '', undefined, entering), [], {})
    top.data = frozen(top.data)
    return { ref }
  }

  const end = (ref: string): void => {
    const top = running.get(ref)
    if (!top) return
    exit(top.root)
    running.delete(ref)
    changed.add(ref)
  }

  const reported = new Set<string>()
  const large = (top: Running, field: string): void => {
    const held = top.data[field]
    if (!Array.isArray(held) || held.length <= LARGE || reported.has(`${top.ref}.${field}`)) return
    reported.add(`${top.ref}.${field}`)
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
      if (cannot) { trace(`DEFECT: ${top.ref} ${cannot}`); return NOT_MADE }
      // Which fields there are is the states' to say, so the edit may change them and neither add nor remove one.
      // The write that tries throws there and then, and an edit that throws has changed nothing.
      try { made = produce(before, data, { fixed: true }) } catch (error) {
        // A change that came with an answer may refuse, with one of the refusals its ask declares.
        if (mayRefuse && error instanceof Refusal) throw error
        trace(`DEFECT: ${top.ref}: ${said(error)}${whereOf(error)}`)
        return NOT_MADE
      }
      const { value, touched } = made
      for (const path of touched) touch(top.ref, path[0]!)
      top.data = touched.length ? value : before
      for (const field of fields.get(top.ref) ?? []) large(top, field)
      if (at !== undefined) { const was = top.data; go(top, at, {}); moved(top, was) }
      return MADE
    }
    // The same rule for fields as for an edit: every one of them has to be a field there will be, or none is taken.
    // Without a move those are the fields there are. With one, they are the fields of the states the move leaves it in.
    const cannot = at === undefined
      ? Object.keys(data).filter((field) => !(field in top.data)).map((field) => `has no field ${field} to change`)[0]
      : cannotGo(top, at, data)
    if (cannot) { trace(`DEFECT: ${top.ref} ${cannot}`); return NOT_MADE }
    // Data first, then the move: the work of a state that is entered reads the data as the handler left it.
    for (const [field, value] of Object.entries(data)) {
      if (!(field in top.data)) continue
      if (!Object.is(top.data[field], value)) touch(top.ref, field)
      top.data = { ...top.data, [field]: value }
    }
    if (at !== undefined) { const was = top.data; go(top, at, data); moved(top, was) }
    return MADE
  }

  /**
   * A state's work failed. If the state is still the case it goes where its `failed` says, with the error. If it was
   * left first there is nowhere to go: a `Left` is that leaving and nothing more, and anything else is reported.
   */
  const fail = (active: Active, error: unknown): boolean => {
    if (error instanceof Left) return MADE
    const where = `${active.top.ref}${active.path ? ` in ${active.path}` : ''}`
    if (active.controller.signal.aborted) { trace(`${where} failed after it was left: ${said(error)}`); return MADE }
    trace(`${where} failed: ${said(error)}`)
    const failed = active.def.failed
    if (!failed) { trace(`DEFECT: ${where} says nowhere to go when its work fails, and stays as it is`); return MADE }
    const { ask: _, ...scope } = scopeOf(active)
    try { return apply(active, failed(error, scope)) } catch (thrown) { trace(`DEFECT: ${where}'s failed threw: ${said(thrown)}`); return NOT_MADE }
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

  const taker = (top: Running, table: 'on' | 'internal' | 'asks', name: string): { handler: Function; of: Active } | undefined => {
    let of: Active | undefined = innermost(top)
    while (of && !of.def[table]?.[name]) of = of.around
    return of ? { handler: of.def[table]![name]!, of } : undefined
  }

  /**
   * Takes one thing, whole. What a handler wrote is kept only if what it did is: one that threw, refused, or returned
   * a change that could not be made has its rows taken back, and the rows of everything else in the step stay.
   */
  /** What a log says of a thing handled: its kind, the state, and the name it was declared or sent by. */
  const handledOf = (item: Exclude<Item, { kind: 'out' }>): Handled => {
    switch (item.kind) {
      case 'event': return { kind: 'event', ref: item.ref, name: item.event.type, ...(item.own ? { own: true as const } : {}) }
      case 'ask': return { kind: 'ask', ref: item.ref, name: item.name }
      case 'result': case 'failure': return { kind: item.kind, ref: item.of.top.ref, name: item.of.path || item.of.name }
      case 'view': case 'ended': case 'progressed': return { kind: item.kind, ref: item.of.top.ref, name: item.name, ...(item.key === undefined ? {} : { key: item.key }) }
      case 'make': case 'drop': return { kind: item.kind, ref: item.of.top.ref, name: item.name, ...(item.key === undefined ? {} : { key: item.key }) }
      // Every ask an answer comes back to was noted where it was made, or where it arrived to be answered.
      case 'answer': { const asked = askedOf.get(item.question)!; return { kind: 'answer', ref: asked.ref, name: asked.name } }
    }
  }
  const handle = (item: Item): void => {
    const within = host.transact
    if (!within) { take(item); return }
    try { within(() => { if (!take(item)) throw UNDONE }) } catch (error) { if (error !== UNDONE) throw error }
  }
  const take = (item: Item): boolean => {
    if (item.kind === 'out') { leaving.push(Object.assign(item.leave, { said: item.said })); return MADE }
    // An answer to an ask its state left unanswered: whoever asked was told it was abandoned, and nothing happens.
    if (item.kind === 'answer' && abandoned.has(item.question)) return MADE
    // What is handled is logged as it is taken: an event or ask held for a state not running yet is taken later.
    const note = (): void => { if (logging) logging.handled.push(handledOf(item)) }
    if (item.kind !== 'event' && item.kind !== 'ask') note()
    if (item.kind === 'result') return apply(item.of, item.value)
    if (item.kind === 'failure') return fail(item.of, item.error)
    if (item.kind === 'view') {
      const followed = declaredBy(item.of.def).follows[item.name]
      if (!followed || item.of.controller.signal.aborted) return MADE
      const { ask: _, ...scope } = scopeOf(item.of)
      hearing = { id: `${item.of.top.ref}#${item.id}`, because: item.of.following.get(item.id)?.because ?? new Set() }
      try { return apply(item.of, followed.heard(item.update, item.key === undefined ? scope : { ...scope, key: item.key })) } catch (error) {
        trace(`DEFECT: ${item.of.top.ref} threw hearing ${item.id}, and nothing changed: ${said(error)}`)
        return NOT_MADE
      }
    }
    if (item.kind === 'make' || item.kind === 'drop') {
      const { name, key } = item
      // It is made by the state that declares it, which is the one it stops with: here, or a state around here.
      let of: Active | undefined = item.of
      while (of && !(name in declaredBy(of.def).makes)) of = of.around
      if (!of || of.controller.signal.aborted) return MADE
      const at = of
      const top = at.top
      const id = key === undefined ? name : `${name}/${key}`
      const now = at.making.get(id)
      if (item.kind === 'drop') {
        if (!now) return MADE
        now.stop()
        at.making.delete(id)
        madeChanged(top)
        return MADE
      }
      // One that is under way is the same one: a second push while one is being made is that push.
      if (now) return MADE
      const declared = declaredBy(at.def).makes[name]!
      let asked: object
      try { asked = (key === undefined ? declared.args(top.data) : declared.args(key, top.data)) as object } catch (error) {
        trace(`DEFECT: ${top.ref} could not say what to ask ${id} for: ${said(error)}`)
        return NOT_MADE
      }
      const given = new AbortController()
      const signal = AbortSignal.any([at.controller.signal, given.signal])
      const live: Live = { seen: [], because: new Set(), stop: () => given.abort() }
      const mine = (): boolean => at.making.get(id) === live && !signal.aborted
      at.making.set(id, live)
      madeChanged(top)
      const hears = declared.heard && ((updates: unknown[]): void => { if (mine()) arrive({ kind: 'progressed', made: true, of: at, name, id, key, live, updates }) })
      const made = ask(declared.of, declared.ask, asked, signal, hears) as unknown as Promise<AnyOutcome>
      // Given up, it ends with `Left`, which is that and nothing to hear of.
      made.then((outcome) => { if (mine()) arrive({ kind: 'ended', made: true, of: at, name, id, key, live, outcome }) }, () => {})
      return MADE
    }
    if (item.kind === 'ended' || item.kind === 'progressed') {
      const table = item.made ? declaredBy(item.of.def).makes : declaredBy(item.of.def).awaits
      const live = item.made ? item.of.making : item.of.awaiting
      const declared = table[item.name]
      if (!declared || item.of.controller.signal.aborted || live.get(item.id) !== item.live) return MADE
      const top = item.of.top
      const { ask: _, ...scope } = scopeOf(item.of)
      const given = item.key === undefined ? scope : { ...scope, key: item.key }
      // What a read delivers may not lead round to itself. An ask that was made once has nothing to come round to.
      hearing = item.made ? undefined : { id: `${top.ref}#${item.id}`, because: item.live.because }
      if (item.kind === 'progressed') {
        try { return apply(item.of, declared.heard!(item.updates, given)) } catch (error) { trace(`DEFECT: ${top.ref} threw hearing ${item.id}, and nothing changed: ${said(error)}`); return NOT_MADE }
      }
      // One that was made has ended, so it is no longer under way. That is the kernel's to say, and it is said before
      // the handler, which may have it made again.
      if (item.made) { live.delete(item.id); madeChanged(top) }
      // A read that has ended stays as what was asked, so that it is not asked again until its fields change. There
      // is nothing left of it to give up: stopping it later tells nobody.
      else item.live.stop = () => {}
      try { return apply(item.of, declared.ended(item.outcome, given)) } catch (error) { trace(`DEFECT: ${top.ref} threw taking how ${item.id} ended, and nothing changed: ${said(error)}`); return NOT_MADE }
    }
    if (item.kind === 'answer') {
      answeringOf.get(item.question)?.questions.delete(item.question)
      // An answer that came with a change: the change is made here, in the step the answer leaves in. If the state
      // that answered was left meanwhile, its ask was ended as abandoned when it was, and nothing is changed.
      const outcome = item.change && !item.change.of.controller.signal.aborted ? withChange(item.change.of, item.change.next, item.outcome) : item.outcome
      answer(item.question, outcome)
      // An ask that is refused has changed nothing, whichever of its handler and its change refused.
      return outcome.ok
    }
    const top = running.get(item.ref)
    // Sent to a state that is not running. It may be one this step is about to start, so it waits until what runs
    // has been matched to the data.
    if (!top && !settling) { held.push(item); return MADE }
    note()
    if (item.kind === 'event') {
      // What a state sends itself is looked for among what only it sends, and then among what anyone may. What
      // comes from outside is looked for among what anyone may send, and nowhere else.
      const found = top && ((item.own ? taker(top, 'internal', item.event.type) : undefined) ?? taker(top, 'on', item.event.type))
      if (!found) {
        trace(top && !item.own && taker(top, 'internal', item.event.type)
          ? `${item.ref} was sent ${item.event.type} from outside, which only it sends itself: ignored`
          : `${item.ref} ignored ${item.event.type}`)
        return MADE
      }
      const { ask: _, ...scope } = scopeOf(found.of)
      // A handler that throws changes nothing: the state is as it was before the event, which it could handle.
      try { return apply(found.of, found.handler(item.event, scope)) } catch (error) {
        trace(`DEFECT: ${item.ref} threw handling ${item.event.type}, and nothing changed: ${said(error)}`)
        return NOT_MADE
      }
    }
    const { name, args, question, heard, gone } = item
    askedOf.set(question, { ref: item.ref, name })
    const found = top && taker(top, 'asks', name)
    if (!found) { answer(question, refusal('unavailable', `${item.ref} does not take ${name}`)); return MADE }
    const failed = (error: unknown): AnyOutcome => {
      if (error instanceof Refusal) return refusal(error.kind, error.message, error.data)
      // The handler was itself asking, and whoever asked it went: it stopped answering, it did not fail.
      if (error instanceof Left) return refusal('abandoned', error.message)
      // Whoever asked is told it failed. Where it failed is said here, since the asker may be in another process.
      const message = said(error)
      // Work that was passed `signal` throws when it aborts. That is the handler stopping as it was asked to.
      if (signal.aborted) { trace(`${item.ref} stopped answering ${name}, as whoever asked had gone: ${message}`); return refusal('abandoned', message) }
      trace(`${item.ref} failed answering ${name}: ${message}`)
      return refusal('failed', message)
    }
    const signal = gone ? AbortSignal.any([found.of.controller.signal, gone]) : found.of.controller.signal
    try {
      const made = found.handler(args, {
        ...scopeOf(found.of, signal),
        refuse: (kind: string, message: string, data?: object) => new Refusal(kind, message, data),
        progress: (update: unknown) => { if (!signal.aborted) out(() => heard?.(update), { kind: 'progress', to: item.ref, name }) },
      })
      if (made instanceof Promise) {
        found.of.questions.add(question)
        answeringOf.set(question, found.of)
        under(made,
          (value) => arrive(isAnswered(value) ? { kind: 'answer', question, outcome: { ok: true, value: value.answer }, change: { of: found.of, next: value.next } } : { kind: 'answer', question, outcome: { ok: true, value } }),
          (error) => arrive({ kind: 'answer', question, outcome: failed(error) }),
        )
        // What it wrote before it waited is kept: it answers in a later step, and this one is made.
        return MADE
      } else {
        const outcome: AnyOutcome = isAnswered(made) ? withChange(found.of, made.next, { ok: true, value: made.answer }) : { ok: true, value: made }
        answer(question, outcome)
        return outcome.ok
      }
    } catch (error) { answer(question, failed(error)); return NOT_MADE }
  }

  /**
   * Answers every ask among what was waiting to be taken, and lets the rest go: for a system that takes no more
   * steps, so that nobody is left waiting on one.
   */
  const turnAway = (waiting: Item[], why: string): void => {
    for (const item of waiting.splice(0)) if (item.kind === 'ask') safely('answering an ask that will not be taken', () => item.question.end(refusal('unavailable', why)))
  }
  const STOPPED = 'It stopped when it could not keep what a step wrote'
  /**
   * A step's rows could not be kept. Nothing has left yet, so nobody was told of a change that was not made. The
   * states are ahead of the rows now, and the system stops, all of it: an ask in the step is told it failed, one
   * that was waiting to be taken is told there is nothing to take it, and every state ends, which ends the work it
   * was doing and the asks it was answering. Nothing is left that somebody could be waiting on.
   */
  const lost = (error: unknown): void => {
    broken = true
    trace(`DEFECT: ${called} could not keep what a step wrote, and has stopped: its states were ahead of its rows. ${said(error)}`)
    changed.clear(); fields.clear(); places.clear()
    // Whoever asked in this step is told it failed. Nothing else the step would have sent leaves.
    for (const leave of leaving.splice(0)) {
      if (!leave.lost) continue
      safely('what leaves at the commit', leave.lost)
      if (logging && leave.said) logging.left.push({ ...leave.said, outcome: 'failed' })
    }
    if (logging) logging.ended = 'lost'
    turnAway(inside, STOPPED); turnAway(outside, STOPPED); turnAway(held, STOPPED)
    for (const ref of [...running.keys()].reverse()) end(ref)
    const refs = [...changed]
    changed.clear(); fields.clear(); places.clear()
    committed = {}
    for (const leave of leaving.splice(0)) {
      if (logging && leave.said) logging.left.push(leave.said)
      safely('what leaves as it stops', leave)
    }
    release()
    for (const listener of listeners) safely('a subscriber', () => listener(refs, {}, {}))
  }
  const commit = (): void => {
    if (changed.size) {
      const refs = [...changed]
      changed.clear()
      committed = Object.fromEntries([...running].map(([ref, top]) => [ref, valueOf(top)]))
      const which = Object.fromEntries([...fields].map(([ref, touched]) => [ref, [...touched]]))
      fields.clear()
      const where = Object.fromEntries(places)
      places.clear()
      if (logging) logging.changed = Object.fromEntries(refs.map((ref) => [ref, {
        fields: which[ref] ?? [], moved: where[ref]?.moved ?? false, making: where[ref]?.making ?? false,
        at: (committed[ref] as { at?: string } | undefined)?.at ?? '',
      }]))
      leaving.push(() => { for (const listener of listeners) safely('a subscriber', () => listener(refs, which, where)) })
    }
    const now = leaving.splice(0)
    if (logging) for (const leave of now) if (leave.said) logging.left.push(leave.said)
    for (const leave of now) safely('what leaves at the commit', leave)
    release()
  }

  /** One step: something from outside, then everything it caused inside, then the commit. */
  let steps = 0
  let spent = false
  const step = (first: () => void): void => {
    if (host.limit !== undefined && ++steps > host.limit) {
      if (!spent) { spent = true; trace(`DEFECT: ${called} took ${host.limit} steps and takes no more: something leads to something else without end`) }
      // Nothing more is taken: an ask that was waiting to be is answered, or it would wait for good.
      turnAway(inside, 'It has taken every step it is allowed'); turnAway(outside, 'It has taken every step it is allowed')
      // What a window asked is answered on its way to the window, which waits for nothing now.
      release()
      return
    }
    if (broken) { turnAway(inside, STOPPED); turnAway(outside, STOPPED); release(); return }
    stepping = true
    const log = host.log
    logging = log ? { handled: [], changed: {}, left: [], ended: 'committed' } : undefined
    // Whether everything was handled. A throw before that is the kernel's own; one after is the database not keeping it.
    let handled = false
    const all = (): void => {
      first()
      let count = 0
      for (;;) {
        for (; inside.length; count++) {
          const item = inside.shift()!
          if (count < RUNAWAY) { handle(item); continue }
          // What it had done is committed, so that the states can be read and the report says where they got to.
          trace(`DEFECT: a step was cut short after ${RUNAWAY} things, at ${'ref' in item ? item.ref : item.kind}: something tells something else without end`)
          if (logging) logging.ended = 'cut short'
          inside.length = 0
          held.length = 0
        }
        // What runs is matched to the data once everything sent so far is handled, and not in between. So which
        // states run depends on the data the step leaves and not on the way it got there: a key taken out and put
        // back is a key that stayed, whether one handler did both or two did one each.
        matchStale()
        const ready = held.filter((item) => running.has(item.ref))
        if (!ready.length && !inside.length) break
        for (const item of ready) { held.splice(held.indexOf(item), 1); inside.push(item) }
      }
      // What is still waiting was sent to nothing that runs.
      settling = true
      try { for (const item of held.splice(0)) handle(item) } finally { settling = false }
      handled = true
    }
    try {
      // The step is one unit: its rows are kept as `transact` returns, and only then does anything leave.
      try { if (host.transact) host.transact(all); else all() } catch (error) {
        // The kernel's own throw: not a step that ended any way a log says, and not logged.
        if (!handled) { logging = undefined; throw error }
        lost(error)
        return
      }
      commit()
    } finally {
      stepping = false; hearing = undefined
      const told = logging
      logging = undefined
      if (log && told) safely('the step log', () => log({ number: ++logged, ...told }))
    }
  }
  /** What was sent in this step to a state that is not running, until the step's match says whether it is to be. */
  const held: Array<Extract<Item, { ref: string }>> = []
  let settling = false
  const pump = (): void => { while (!stepping && outside.length) step(() => handle(outside.shift()!)) }
  const arrive = (item: Item): void => { handOver(); outside.push(item); pump() }
  const enqueue = (item: Item): void => { if (stepping) inside.push(item); else arrive(item) }

  const port: Port = {
    event: (ref, event) => arrive({ kind: 'event', ref, event }),
    ask: (ref, name, args, heard, settle) => {
      const gone = new AbortController()
      // Whoever asks through the port is across a link: what they hear and how it ends go to a window.
      arrive({ kind: 'ask', ref, name, args, question: new Question((outcome) => toAWindow(() => settle(outcome))), heard: (update) => toAWindow(() => heard(update)), gone: gone.signal })
      return () => gone.abort(new Error('Whoever asked has gone'))
    },
    view: (feature, view, args, heard) => {
      if (!host.views) { heard({ ok: false, error: `${called} runs no views` }); return () => {} }
      const running = host.views(feature, view, args, heard)
      const viewing: Viewing = typeof running === 'function' ? { stop: running } : running
      // A view run for a window is what the hold waits on, while it runs: one stopped has nothing more to hand over,
      // and counts as caught up for every round waiting on it, whether or not whatever ran it says so.
      if (viewing.caughtUp) forWindows.add(viewing)
      return () => {
        forWindows.delete(viewing)
        for (const round of rounds) if (round.waiting.delete(viewing)) pending--
        // Whatever stopping it does, what waited on it is let go.
        safely('stopping a view', () => viewing.stop())
        letGo()
      }
    },
  }

  const self: System & { [PORT]: Port; [key: symbol]: unknown } = {
    [PORT]: port,
    start: (ref, made) => {
      let handleOf: { ref: string }
      if (stepping) handleOf = begin(ref, made.def as LooseDef)
      else { step(() => { handleOf = begin(ref, made.def as LooseDef) }); pump() }
      return handleOf!
    },
    child: ((of: { ref: string }, name: string, key?: string) => ({ ref: key === undefined ? `${of.ref}/${name}` : `${of.ref}/${name}/${key}` })) as unknown as System['child'],
    send: (to, event) => arrive({ kind: 'event', ref: to.ref, event }),
    ask: (of, name, args, hears) => ask(of, name, args, undefined, hears as ((updates: unknown[]) => void) | undefined),
    read: (of) => committed[of.ref] as never,
    snapshot: () => committed,
    subscribe: (listener) => {
      listeners.push(listener)
      return () => { const index = listeners.indexOf(listener); if (index >= 0) listeners.splice(index, 1) }
    },
    connect: (backend) => {
      const link: Link = { open: true, up: { label: `${called} to its backend` }, down: { label: `the backend to ${called}` } }
      const theirs = backend as unknown as { [PORT]: Port; attach(window: { link: Link; port: Port }): () => void }
      const mine = { link, port: theirs[PORT], waiting: new Set<Question>(), gone: new Set<() => void>() }
      up = mine
      const detach = theirs.attach({ link, port })
      return {
        close: () => {
          link.open = false
          detach()
          // The backend learns that whoever asked has gone, and every ask still waiting here is told so.
          for (const gone of mine.gone) gone()
          for (const question of mine.waiting) arrive({ kind: 'answer', question, outcome: refusal('disconnected', 'The connection closed before the answer') })
          up = undefined
        },
      }
    },
    idle: () => pending === 0 && !due && !stepping && outside.length === 0,
    stop: () => step(() => { for (const ref of [...running.keys()].reverse()) end(ref) }),
  }
  ;(self as unknown as { attach(window: { link: Link; port: Port }): () => void }).attach = (window) => { down.add(window); return () => { down.delete(window) } }
  return self
}
