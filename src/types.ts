// What a state's code is checked against: a state's shape and definition, what a handler is handed and may return,
// and how one state reaches another by name. Nothing here runs a state; `kernel.ts` does.
//
// A state's value is where it is and the data there:  { at: 'thread.sending', data: { … } }

import type { Failure, Following } from './port.ts'

export type AnyEvent = { readonly type: string }
/**
 * One ask. `refuses` names the ways it may be refused that an asker can act on: kinds alone
 * (`'not-found' | 'no-access'`), or each kind with the data its refusal carries
 * (`{ 'name-taken': { existingId: string } }`).
 */
export type AskShape = { args: object; answer: unknown; refuses?: string | Record<string, object>; progress?: unknown }
export type Asks = Record<string, AskShape>

/**
 * What a state is, declared as a type: its own data, the states inside it, and the states it starts. The same shape
 * all the way down.
 */
export type Shape = {
  data?: object
  states?: Record<string, Shape>
  starts?: Record<string, AnyState | Each<AnyState>>
  /** At the outermost state only: what it tells whichever state started it. */
  reports?: AnyEvent
  /**
   * At the outermost state only: the events it raises, and nothing else may send it. They are taken by its
   * `internal` handlers. What others may send it is the events it is declared with.
   */
  internal?: AnyEvent
  /**
   * The imperative asks it can call on demand, by name:
   * - `'single'` / `{ single: In }`: single-flight (deduped), `pending.<name>: boolean`
   * - `'each'` / `{ each: In }`: keyed concurrent (one per key), `pending.<name>: Readonly<Record<string, true>>`
   * - `'many'` / `{ many: In }`: unkeyed concurrent, `pending.<name>: number`
   */
  calls?: Record<string, 'single' | 'each' | 'many' | { readonly single: unknown } | { readonly each: unknown } | { readonly many: unknown }>
  /**
   * The imperative timers it can arm on demand, by name:
   * - `'single'` / `{ single: 'at arm' }`: single timer, `armed.<name>: boolean`
   * - `'each'` / `{ each: 'at arm' }`: keyed timers (one per key), `armed.<name>: Readonly<Record<string, true>>`
   *
   * `'at arm'` says the timer declares no duration of its own: each `arm` gives one.
   */
  arms?: Record<string, 'single' | 'each' | { readonly single: 'at arm' } | { readonly each: 'at arm' }>
}

/** Any state, as something another can start. */
export type AnyState = State<any, any, any, any>
/** In a shape's `starts`: one of these for each key, where a bare state is the one. */
export interface Each<T> { readonly _each?: T }

/** What some code can reach by name: the backend's systems, the surfaces a window runs, views, and named peers. */
export type Net = {
  systems: Record<string, { events: AnyEvent; asks: Asks }>
  surfaces: Record<string, { events: AnyEvent }>
  /** The live reads a feature offers, by feature and then by name. */
  views: Record<string, Record<string, { args: object; result: unknown }>>
  /** The non-window peers a system may be given by name (tell-only). Optional. */
  peers?: Record<string, { events: AnyEvent }>
}
type Nothing = { systems: {}; surfaces: {}; views: {} }

/** What a view delivers: its result, and each changed result after it, or why it could not be read. */
export type ViewUpdate<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly failure: Failure }
/**
 * What runs a view: it calls `updated` with the result and every changed result until it is stopped. It returns what
 * stops it, or a `Following`: one that can say when it has caught up is what a backend holds what it sends windows for.
 */
export type ViewHost = (feature: string, view: string, args: object, updated: (update: ViewUpdate<unknown>) => void) => (() => void) | Following

export type AskEnd =
  | 'failed'        // the handler threw
  | 'abandoned'     // whatever was answering ended first
  | 'unavailable'   // nothing takes this ask where it was sent
  | 'disconnected'  // the link to whoever was answering closed
/** An ask's refusals by kind, with what each carries: nothing, where only kinds were declared. */
type Refusals<A> = A extends { refuses: infer R } ? ([R] extends [string] ? { [K in R]: {} } : R) : {}
type Refuses<A> = keyof Refusals<A> & string
type RefusalData<D> = [keyof D] extends [never] ? [] : {} extends D ? [data?: D] : [data: D]
/**
 * Why an ask was not done, as its asker gets it: a kind to branch on, a message to show, and whatever data the ask
 * declares for that kind. Checking `kind` narrows to that data.
 */
export type AskFailure<A = {}> =
  | { [K in Refuses<A>]: { readonly kind: K; readonly message: string } & Readonly<Refusals<A>[K]> }[Refuses<A>]
  | { readonly kind: AskEnd; readonly message: string }
export type Outcome<V, F = AskFailure> = { readonly ok: true; readonly value: V } | { readonly ok: false; readonly failure: F }
/** @internal */
export type AnyOutcome = Outcome<unknown, { readonly kind: string; readonly message: string }>
/** What an ask says before it answers. */
export type ProgressOf<A extends AskShape> = A extends { progress: infer P } ? P : never
/** How an ask ends: its answer, or a failure of one of the kinds it may fail with. */
export type OutcomeOf<A extends AskShape> = Outcome<A['answer'], AskFailure<A>>

/** In a state's `data`, marks a field that whoever enters the state has to give. */
export const given: unique symbol = Symbol.for('@apackdev/state/given')
type Given = typeof given

// ── what a state's code is checked against ──────────────────────────────────────────────────────────────────────────

type DataOf<S> = S extends { data: infer D extends object } ? D : {}
type StatesOf<S> = S extends { states: infer T extends Record<string, Shape> } ? T : {}
type Names<S> = keyof StatesOf<S> & string
type Sub<S, K> = K extends keyof StatesOf<S> ? StatesOf<S>[K] : never
type StartsOf<S> = S extends { starts: infer C extends object } ? C : {}
type StartsBelow<S, P> = P extends `${infer H}.${infer T}` ? StartsOf<Sub<S, H>> & StartsBelow<Sub<S, H>, T> : StartsOf<Sub<S, P>>
/** Everything started where a handler sits: by its own state and by every state around it. */
type CallKind<C> = C extends 'each' | { readonly each: unknown } ? 'each' : C extends 'many' | { readonly many: unknown } ? 'many' : 'single'
type CallInput<C> = C extends { readonly single: infer I } | { readonly each: infer I } | { readonly many: infer I } ? I : never
type InputScope<I> = [I] extends [never] ? {} : { readonly input: Read<I> }
type CallParams<C> =
  CallKind<C> extends 'each'
    ? ([CallInput<C>] extends [never] ? [key: string] : [key: string, input: Read<CallInput<C>>])
    : ([CallInput<C>] extends [never] ? [] : [input: Read<CallInput<C>>])
type CancelParams<C> = CallKind<C> extends 'each' ? [key: string] : []
type CallsOf<S> = S extends { calls: infer M extends object } ? M : {}
type CallsBelow<S, P> = P extends `${infer H}.${infer T}` ? CallsOf<Sub<S, H>> & CallsBelow<Sub<S, H>, T> : CallsOf<Sub<S, P>>
/** The asks that can be called where a handler sits: its own state's and those of every state around it. */
type CallsAt<S, P extends string> = P extends '' ? CallsOf<S> : CallsOf<S> & CallsBelow<S, P>
type CallKindsOf<S> = { [K in keyof CallsOf<S>]: CallKind<CallsOf<S>[K]> }
/** Every imperative ask a state declares, whichever of its states declares it, mapped to its cardinality kind. */
type AllCallKinds<S> = CallKindsOf<S> & ([Names<S>] extends [never] ? {} : UnionToIntersection<{ [K in Names<S>]: AllCallKinds<StatesOf<S>[K]> }[Names<S>]>)
/** Which of them are in flight: by key for `each`, in-flight count for `many`, and boolean for `single`. */
type PendingOf<M> = {
  readonly [K in keyof M]:
    M[K] extends 'each' ? Readonly<Record<string, true>>
    : M[K] extends 'many' ? number
    : boolean
}
type ArmKind<W> = W extends 'each' | { readonly each: 'at arm' } ? 'each' : 'single'
type ArmNeedsMs<W> = W extends { readonly single: 'at arm' } | { readonly each: 'at arm' } ? true : false
type ArmParams<W> =
  ArmKind<W> extends 'each'
    ? (ArmNeedsMs<W> extends true ? [key: string, ms: number] : [key: string, ms?: number])
    : (ArmNeedsMs<W> extends true ? [ms: number] : [ms?: number])
type DisarmParams<W> = ArmKind<W> extends 'each' ? [key?: string] : []
type ArmsOf<S> = S extends { arms: infer M extends object } ? M : {}
type ArmsBelow<S, P> = P extends `${infer H}.${infer T}` ? ArmsOf<Sub<S, H>> & ArmsBelow<Sub<S, H>, T> : ArmsOf<Sub<S, P>>
/** The timers that can be armed where a handler sits: its own state's and those of every state around it. */
type ArmsAt<S, P extends string> = P extends '' ? ArmsOf<S> : ArmsOf<S> & ArmsBelow<S, P>
type ArmKindsOf<S> = { [K in keyof ArmsOf<S>]: ArmKind<ArmsOf<S>[K]> }
/** Every imperative timer a state declares, whichever of its states declares it, mapped to its cardinality kind. */
type AllArmKinds<S> = ArmKindsOf<S> & ([Names<S>] extends [never] ? {} : UnionToIntersection<{ [K in Names<S>]: AllArmKinds<StatesOf<S>[K]> }[Names<S>]>)
/** Which of them are armed: by key for `each`, and boolean for `single`. */
type ArmedOf<M> = {
  readonly [K in keyof M]: M[K] extends 'each' ? Readonly<Record<string, true>> : boolean
}
type StartsAt<S, P extends string> = P extends '' ? StartsOf<S> : StartsOf<S> & StartsBelow<S, P>
type ReportsOf<S> = S extends { reports: infer P extends AnyEvent } ? P : never
type InternalOf<S> = S extends { internal: infer P extends AnyEvent } ? P : never
/** A field that says which there are: by its keys, or by its items. */
type KeysField<D> = { [K in keyof D & string]: D[K] extends readonly string[] | Readonly<Record<string, unknown>> ? K : never }[keyof D & string]
type UnionToIntersection<U> = (U extends unknown ? (of: U) => void : never) extends (of: infer I) => void ? I : never
/** Everything a state starts, whichever of its states declares it: what can be reached from outside it. */
export type AllStarts<S> = StartsOf<S> & ([Names<S>] extends [never] ? {} : UnionToIntersection<{ [K in Names<S>]: AllStarts<StatesOf<S>[K]> }[Names<S>]>)
export type HandleOf<T> = T extends Each<infer X> ? HandleOf<X> : T extends State<infer S2, infer E2, infer A2, any> ? Started<Value<S2>, E2, A2, AllStarts<S2>> : never
type Join<H extends string, K extends string> = H extends '' ? K : `${H}.${K}`

type Paths<S> = [Names<S>] extends [never] ? never : { [K in Names<S>]: K | `${K}.${Paths<StatesOf<S>[K]>}` }[Names<S>]
type Leaves<S> = [Names<S>] extends [never] ? never : { [K in Names<S>]: [Names<StatesOf<S>[K]>] extends [never] ? K : `${K}.${Leaves<StatesOf<S>[K]>}` }[Names<S>]
type Below<S, P> = P extends `${infer H}.${infer T}` ? DataOf<Sub<S, H>> & Below<Sub<S, H>, T> : DataOf<Sub<S, P>>
type DataAt<S, P extends string> = P extends '' ? DataOf<S> : DataOf<S> & Below<S, P>

/**
 * A value as it is read. No field of it can be assigned, at any depth, and a field that is a list, a map or a set
 * cannot be changed in place. A list further in than a field is typed as it was declared.
 *
 * Each half goes as far as it costs nothing. A read-only object is taken wherever a writable one is expected, so
 * read-only fields at every depth ask nothing of a helper that takes the object. A read-only list is refused where a
 * writable one is expected, which is the one thing TypeScript holds a caller to: said of a field's own list it is
 * kept across a call, and said of every list inside an entity it would refuse the entity wherever its declared type
 * is asked for. What holds at every depth, whatever the types say, is that the value is frozen.
 */
/** What has nothing inside it to write. Asked first, so that a string marked as a kind of id, which is a string and an object at once, stays the string it is. */
type Whole = string | number | bigint | boolean | symbol | null | undefined
export type Read<T> =
  T extends Whole ? T
  : T extends (...given: never[]) => unknown ? T
  : T extends ReadonlyMap<infer Key, infer Held> ? ReadonlyMap<Key, Inside<Held>>
  : T extends ReadonlySet<infer Item> ? ReadonlySet<Item>
  : T extends object ? { readonly [K in keyof T]: ReadHeld<T[K]> }
  : T
/** What a field holds, as it is read: a list, a map or a set that cannot be changed in place, and an object whose fields cannot be assigned. */
type ReadHeld<T> =
  T extends Whole ? T
  : T extends (...given: never[]) => unknown ? T
  : T extends ReadonlyMap<infer Key, infer Held> ? ReadonlyMap<Key, Inside<Held>>
  : T extends ReadonlySet<infer Item> ? ReadonlySet<Item>
  : T extends object ? { readonly [K in keyof T]: Inside<T[K]> }
  : T
/**
 * What is further in than a field: an object's fields cannot be assigned, at any depth, and a list, a map or a set
 * is as it was declared. A read-only object is taken wherever a writable one is expected, so saying it costs no
 * caller anything. A read-only list is not, so one further in is left writable in its type, and frozen.
 */
type Inside<T> =
  T extends Whole ? T
  : T extends (...given: never[]) => unknown ? T
  : T extends ReadonlyMap<unknown, unknown> | ReadonlySet<unknown> ? T
  : T extends readonly unknown[] ? { [K in keyof T]: Inside<T[K]> }
  : T extends object ? { readonly [K in keyof T]: Inside<T[K]> }
  : T
/** What a field may be given: its own type, or that read from somewhere it cannot be written. */
type Givable<D> = { [K in keyof D]: D[K] | Read<D[K]> }

/** A state as it is read: where it is, and the data there. */
export type Value<S> = ([Names<S>] extends [never]
  ? { readonly data: Read<DataOf<S>> }
  : { [L in Leaves<S>]: { readonly at: L; readonly data: Read<DataAt<S, L>> } }[Leaves<S>])
  // What it has called and has not yet finished. The kernel keeps this, and nothing else writes it.
  & ([keyof AllCallKinds<S>] extends [never] ? {} : { readonly pending: PendingOf<AllCallKinds<S>> })
  // What timers it has armed and have not yet expired or been disarmed. The kernel keeps this, and nothing else writes it.
  & ([keyof AllArmKinds<S>] extends [never] ? {} : { readonly armed: ArmedOf<AllArmKinds<S>> })

/** Every state a path passes through: `thread` and `thread.idle` for `thread.idle`. */
type Through<A> = A extends `${infer H}.${infer T}` ? H | `${H}.${Through<T>}` : A

/**
 * Whether a value is at a state or anywhere inside it. It narrows the value to the places under that state, so the
 * data that exists there can be read. The path is the structure itself: nothing is declared, and nothing can go stale.
 */
export function within<V extends { readonly at: string }, P extends Through<V['at']>>(value: V, state: P): value is Extract<V, { readonly at: P | `${P}.${string}` }> {
  return value.at === state || value.at.startsWith(`${state}.`)
}

type Gained<S, H, T> = T extends `${infer TH}.${infer TT}`
  ? (H extends `${TH}.${infer HT}` ? Gained<Sub<S, TH>, HT, TT> : H extends TH ? Below<Sub<S, TH>, TT> : Below<S, T>)
  : DataOf<Sub<S, T>>

/**
 * A change to data: the fields to replace, or a function that edits a draft of the data in place. The draft is the way
 * to change something nested: `(d) => { d.titles[id] = title }`. Nothing is mutated; a new value is made from the edits.
 * A move that has nothing to give may edit a draft too: the draft is the data where the handler sits, edited before
 * the move. A move that enters a state needing data says it as fields, since those fields are what it gives.
 */
type Change<D> = Partial<Givable<D>> | ((draft: D) => void)

/** What happens next, in the shape of the value: where to be, and what data changes. */
type Next<R, H extends string> =
  | { at?: never; data: Change<DataAt<R, H>> }
  | { [T in Paths<R>]: {} extends Gained<R, H, T> ? { at: T; data?: Partial<Givable<DataAt<R, T>>> | ((draft: DataAt<R, H>) => void) } : { at: T; data: Givable<Gained<R, H, T>> & Partial<Givable<DataAt<R, T>>> } }[Paths<R>]

/** A state this one started. Only its starter holds it: it can be told, asked and read, never written. */
export interface Handle<V, E extends AnyEvent, A extends Asks, C = {}> { readonly ref: string; readonly _?: { v: V; e: (event: E) => void; a: A; c: C } }
/**
 * A handle to a state that another started. It is a name, and the state it names runs only while its starter is the
 * case and its key is there: reading it gives nothing while it is not running.
 */
export interface Started<V, E extends AnyEvent, A extends Asks, C = {}> extends Handle<V, E, A, C> { readonly _started: true }

type SystemsOf<N extends Net> = keyof N['systems'] & string
type AskOf<N extends Net, K extends SystemsOf<N>, Q extends keyof N['systems'][K]['asks']> = N['systems'][K]['asks'][Q]
type PeersOf<N extends Net> = N['peers'] extends Record<string, { events: AnyEvent }> ? keyof N['peers'] & string : never
type PeerEventOf<N extends Net, K extends PeersOf<N>> = N['peers'] extends Record<string, { events: AnyEvent }> ? N['peers'][K]['events'] : never

export interface Scope<R, H extends string, E extends AnyEvent, N extends Net> {
  /** The data that exists here: this state's own and that of every state around it. */
  readonly data: Read<DataAt<R, H>>
  /** The whole value, as it is now. */
  readonly snapshot: Value<R>
  /**
   * The time in milliseconds since 1970, from the clock the system was given. Inside a step (a handler, or the
   * synchronous start of `run` or an ask's handler), this is the step's stamped time, recorded in `StepLog.now` so
   * handlers stay pure and replayable. In `run` or an ask's handler after an `await`, it reads the clock live: that
   * read is not logged, so a decision that must be replayable belongs in the handler that receives the work's result.
   */
  readonly now: number
  /**
   * Aborted when this state stops being the case (or for an ask, when whoever asked has gone). It does not abort on
   * normal completion: outside work handed `signal` and not awaited is not stopped when `run` or an ask returns.
   */
  readonly signal: AbortSignal

  /**
   * Raises an event in this running state: one only it raises itself, which its `internal` handlers take, or one that
   * others may send it too.
   */
  raise(event: Read<E | InternalOf<R>>): void

  /** Tells a backend system, or a state this one started, an event. Nobody waits. */
  tell<K extends SystemsOf<N>>(to: K, event: Read<N['systems'][K]['events']>): void
  tell<E2 extends AnyEvent>(to: Handle<unknown, E2, Asks>, event: Read<E2>): void
  /**
   * From a window: tells another surface in this window an event that surface says it takes. A surface and a
   * backend system can be called the same, so a surface is named as one. From the backend a surface is broadcast to.
   */
  tell<K extends keyof N['surfaces'] & string>(to: { readonly surface: K }, event: Read<N['surfaces'][K]['events']>): void
  /**
   * Tells a named non-window peer of this system an event. Nobody waits. Delivered after the step commits,
   * with no view hold; dropped (recorded in `StepLog.sent` with `outcome: 'dropped'`) if no peer has
   * that name.
   */
  tell<K extends PeersOf<N>>(to: { readonly peer: K }, event: Read<PeerEventOf<N, K>>): void

  /**
   * Asks a backend system, or a state this one started. `progress` is called with the progress made since it was last
   * called, as a list: however fast updates are produced, they arrive at most once a frame, so that a stream of
   * ten thousand is a few dozen changes and not ten thousand.
   */
  ask<K extends SystemsOf<N>, Q extends keyof N['systems'][K]['asks'] & string>(
    of: K, name: Q, args: Read<AskOf<N, K, Q>['args']>, progress?: (updates: ReadonlyArray<ProgressOf<AskOf<N, K, Q>>>) => void,
  ): Promise<OutcomeOf<AskOf<N, K, Q>>>
  ask<A2 extends Asks, Q extends keyof A2 & string>(
    of: Handle<unknown, never, A2>, name: Q, args: Read<A2[Q]['args']>, progress?: (updates: ReadonlyArray<ProgressOf<A2[Q]>>) => void,
  ): Promise<OutcomeOf<A2[Q]>>

  /** From the backend: tells that surface, in every window, an event. */
  broadcast<K extends keyof N['surfaces'] & string>(to: K, event: Read<N['surfaces'][K]['events']>): void

  /**
   * Tells the state that started this one something. It arrives there as an event, with `from` saying which state
   * told it: its key, where it is one of many. Only its starter hears, as only whoever asked hears an ask's progress.
   */
  report(event: Read<ReportsOf<R>>): void

  /**
   * Fires an ask this state declares under `calls`. It runs when the step commits, with the data as the handler left
   * it. For `single` and `each`, one already in flight (or in flight for that key) is deduped and not started twice; for
   * `many`, each call runs concurrently. How each finishes goes to its declared `done` handler.
   */
  call<K extends keyof CallsAt<R, H> & string>(name: K, ...rest: CallParams<CallsAt<R, H>[K]>): void
  /** Cancels an in-flight call (`single`/`each`), or all in-flight instances (`many`): the responder is aborted and `done` is not called. */
  cancel<K extends keyof CallsAt<R, H> & string>(name: K, ...key: CancelParams<CallsAt<R, H>[K]>): void

  /**
   * Arms a timer this state declares under `arms`. By default (`whenArmed: 'restart'`), arming one already armed
   * restarts it from now; with `whenArmed: 'ignore'`, arming while already armed is a no-op.
   */
  arm<K extends keyof ArmsAt<R, H> & string>(name: K, ...rest: ArmParams<ArmsAt<R, H>[K]>): void
  /** Disarms an armed timer (`single`, or one key of `each`; omitting `key` on `each` disarms every active key). */
  disarm<K extends keyof ArmsAt<R, H> & string>(name: K, ...key: DisarmParams<ArmsAt<R, H>[K]>): void

  /** A state this one started, as it is now: nothing while it is not running. */
  read<V2>(of: Started<V2, never, Asks, any>): V2 | undefined
  /** A state this one started, as it is now. */
  read<V2>(of: Handle<V2, never, Asks>): V2
  /**
   * A state this one starts, by the name it is declared under, and by key where there is one for each. A handle is
   * a name: asking through one whose state is not running is answered `unavailable`.
   */
  child<K extends keyof StartsAt<R, H> & string>(name: K, ...key: StartsAt<R, H>[K] extends Each<any> ? [key: string] : []): HandleOf<StartsAt<R, H>[K]>
  /**
   * Released, last first, when this state exits. If called from in-flight work after the state has already exited,
   * `release` runs immediately; stray calls after `run` or an ask has already finished are ignored.
   */
  onExit(release: () => void): void
  /**
   * Waits `ms` milliseconds on the clock's monotonic timer. Rejects with `RangeError` if `ms` is non-finite (or
   * `Error` if no clock was given), and cancels with `Cancelled` when this state exits, when whoever asked has gone,
   * or when the work that started it finishes.
   */
  sleep(ms: number): Promise<void>
}

/**
 * What an event's handler is given: everything but `ask` and `sleep`. A handler is synchronous and cannot await, and
 * an ask or sleep it only started would end, if its state were left, with nothing around it to take that. Asking and
 * sleeping are for `run` and for an ask's handler, which the kernel is around.
 */
export type EventScope<R, H extends string, E extends AnyEvent, N extends Net> = Omit<Scope<R, H, E, N>, 'ask' | 'sleep'>

export interface AskScope<R, H extends string, E extends AnyEvent, N extends Net, A extends AskShape> extends Scope<R, H, E, N> {
  /**
   * `throw refuse(kind, message)` answers with one of the refusals the ask declares. A kind that carries data takes
   * it as a third argument: required when the declaration has required fields, and not accepted when it has none.
   */
  refuse<K extends Refuses<A>>(kind: K, message: string, ...data: RefusalData<Refusals<A>[K]>): Error
  /** Tells whoever asked something before the answer. Only they hear it. */
  progress(update: Read<ProgressOf<A>>): void
}

/** Events: synchronous. What a handler returns is what happens next. */
type On<R, H extends string, Taken extends AnyEvent, E extends AnyEvent, N extends Net> =
  { [T in Taken['type']]?: (event: Extract<Taken, { type: T }>, scope: EventScope<R, H, E, N>) => Next<R, H> | void }
/** What marks an answer that also changes something, for the kernel to tell it from an answer alone. */
export const ANSWERED = Symbol.for('@apackdev/state/answered')
/** An answer together with what happens next: what an ask's handler returns when answering also changes something. */
export interface Answered<V, X> { readonly [ANSWERED]: true; readonly answer: V; readonly next: X }
/**
 * Answers, and says what happens next, as one thing. The change is made in the step the answer leaves in, so whoever
 * asked never hears of a change that was not made: if the change is refused, the ask is answered `failed`.
 */
export function answered<V, X>(answer: V, next: X): Answered<V, X> { return { [ANSWERED]: true, answer, next } }

/**
 * What can happen next after an `await`. Data is changed by editing a draft, never by giving fields: fields would be
 * worked out from data as it was before the wait, and would overwrite what changed meanwhile. A draft is edited when
 * the change is made, against the data as it is then. A move still gives the fields the states it enters need.
 *
 * It is also where to check what has to hold when the change is made. What was checked before the wait may not be
 * so after it, and an edit may `throw refuse(...)`: the ask is then answered with that refusal and nothing changes.
 */
type NextAfterAwait<R, H extends string> =
  | { at?: never; data: (draft: DataAt<R, H>) => void }
  | { [T in Paths<R>]: {} extends Gained<R, H, T> ? { at: T; data?: (draft: DataAt<R, H>) => void } : { at: T; data: Givable<Gained<R, H, T>> } }[Paths<R>]

/**
 * Asks: may be async. What a handler returns is the answer. To change something as well it returns
 * `answered(answer, next)`, where `next` is what any handler returns: where to be, and what data changes.
 */
type Answering<R, H extends string, E extends AnyEvent, A extends Asks, N extends Net> =
  { [Q in keyof A]?: (args: A[Q]['args'], scope: AskScope<R, H, E, N, A[Q]>) =>
    | Read<A[Q]['answer']> | Answered<Read<A[Q]['answer']>, Next<R, H>>
    | Promise<Read<A[Q]['answer']> | Answered<Read<A[Q]['answer']>, NextAfterAwait<R, H>>> }

/**
 * Where a state goes when its work fails: what `run` threw, and what happens next. It is an event's handler in every
 * other way: synchronous, and without `ask`. It is never given a `Cancelled`, which is the state having exited and not
 * its work failing, so it is where to handle a failure without a `catch` that could take one.
 */
type Failed<R, H extends string, E extends AnyEvent, N extends Net> = (error: unknown, scope: EventScope<R, H, E, N>) => Next<R, H> | void

/**
 * What a state does while it is the case. Work that awaits can fail long after the state was entered, with nobody
 * around it, so a `run` that returns a promise has to say where the state goes then. A `run` that only sets things up
 * may leave `failed` out: what it throws is reported, and the state stays as it was entered.
 */
type Work<R, H extends string, E extends AnyEvent, N extends Net> =
  | { run?: (scope: Scope<R, H, E, N>) => Next<R, H> | void; failed?: Failed<R, H, E, N> }
  | { run: (scope: Scope<R, H, E, N>) => Promise<Next<R, H> | void>; failed: Failed<R, H, E, N> }

/** The definition of a state. The same keys at every depth, the outermost included. */
export type Def<R, S, H extends string, E extends AnyEvent, A extends Asks, N extends Net> = {
  /** The events it takes while it is the case. An event goes to the innermost state that takes it. */
  on?: On<R, H, E, E, N>
  /**
   * The events it raises, while it is the case. Nothing outside it reaches these: what is told, broadcast or
   * sent to it from outside is looked for in `on` alone.
   */
  internal?: On<R, H, InternalOf<R>, E, N>
  /** The asks it answers while it is the case. An ask goes to the innermost state that answers it. */
  answers?: Answering<R, H, E, A, N>
  /**
   * External push subscriptions held for as long as this state is the case (e.g. event emitters, watchers, DOM
   * listeners). Runs synchronously on entry with a state-lifetime scope (so `raise`/`tell`/`broadcast` stay live
   * until the state exits) without blocking `sys.idle()`. Returning a cleanup function registers it with `onExit`
   * automatically.
   */
  listen?: (scope: EventScope<R, H, E, N>) => (() => void) | void
} & Work<R, H, E, N> & ([keyof DataOf<S>] extends [never] ? { data?: never } : {
  /** Its own data: each field's starting value, or `given` for one whoever enters it has to give. */
  data: { [K in keyof DataOf<S>]-?: DataOf<S>[K] | Given }
}) & ([keyof StartsOf<S>] extends [never] ? { starts?: never } : {
  /**
   * The states it starts. Each runs for exactly as long as this one is the case and, where there is one for each
   * key, for as long as its key is among the keys the data gives. Nothing starts or stops one by hand: change the
   * data, and what runs follows in the same step.
   */
  starts: (start: Start<DataAt<R, H>>) => { [K in keyof StartsOf<S>]: StartsOf<S>[K] extends Each<infer X> ? EachOf<DataAt<R, H>, X>
    : NeedsGiven<StartsOf<S>[K]> extends true ? OneOf<DataAt<R, H>, StartsOf<S>[K]> : StartsOf<S>[K] | OneOf<DataAt<R, H>, StartsOf<S>[K]> }
}) & {
  /**
   * The views it follows while it is the case. What each is asked for comes from the data, and what it delivers goes
   * to a handler, which returns what happens next as any handler does.
   */
  follows?: (follow: Follow<R, H, E, N>) => Record<string, Followed<R, H, E, N>>
  /**
   * The standing asks it loads while it is the case: fetched and refreshed when a named `from` field changes, one
   * for each key of an `each` field, or both. How each finishes goes to `done`.
   */
  loads?: (load: Load<R, H, E, N>) => Record<string, Loaded<R, H, E, N>>
} & ([keyof CallsOf<S>] extends [never] ? { calls?: never } : {
  /**
   * The imperative asks fired when a handler calls `call(name)`. A read is loaded because the data says so, for as
   * long as it does. A write is not like that: it is fired once on demand, and its in-flight state lives on `pending`.
   */
  calls: (calls: { single: CallSingle<R, H, E, N>; each: CallEach<R, H, E, N>; many: CallMany<R, H, E, N> }) => {
    [K in keyof CallsOf<S>]:
      CallKind<CallsOf<S>[K]> extends 'each' ? CalledEach<R, H, E, N, CallInput<CallsOf<S>[K]>>
      : CallKind<CallsOf<S>[K]> extends 'many' ? CalledMany<R, H, E, N, CallInput<CallsOf<S>[K]>>
      : CalledSingle<R, H, E, N, CallInput<CallsOf<S>[K]>>
  }
}) & ([keyof ArmsOf<S>] extends [never] ? { arms?: never } : {
  /**
   * The imperative timers armed when a handler calls `arm(name)`. Each is owned by this state (disarmed on exit),
   * does not block `idle()`, and exposes its armed status on `armed`.
   */
  arms: (arms: { single: ArmSingle<R, H, E, N>; each: ArmEach<R, H, E, N> }) => {
    [K in keyof ArmsOf<S>]:
      ArmKind<ArmsOf<S>[K]> extends 'each'
        ? ArmedEach<R, H, E, N, ArmNeedsMs<ArmsOf<S>[K]>>
        : ArmedSingle<R, H, E, N, ArmNeedsMs<ArmsOf<S>[K]>>
  }
}) & ([Names<S>] extends [never] ? { initial?: never; states?: never } : {
  /**
   * The state inside it that it enters first when whoever enters it does not say. It is entered with nothing given,
   * so no field of its data may be `given`, which `NoInitialGiven` holds the definition to, field by field.
   */
  initial: { [K in Names<S>]: K }[Names<S>]
  /** Every state inside it. */
  states: { [K in Names<S>]: Def<R, StatesOf<S>[K], Join<H, K>, E, A, N> }
})

/** A state, as something that can be started. `G` names the fields of its own data that whoever starts it has to give. */
export interface State<S extends Shape, E extends AnyEvent, A extends Asks, G extends string = never> {
  readonly def: unknown
  /** Optional name resolver attached by `forNet(resolve)` for bare-to-qualified target resolution. */
  readonly resolve?: (name: string) => string
  readonly _?: { s: S; e: E; a: A; g: G }
}
/** Extracts the shape `S` declared by a `State`. */
export type ShapeOf<T> = T extends State<infer S, any, any, any> ? S : never
/** Extracts the external events `E` accepted by a `State`. */
export type EventsOf<T> = T extends State<any, infer E, any, any> ? E : never
/** Extracts the asks `A` answered by a `State`. */
export type AsksOf<T> = T extends State<any, any, infer A, any> ? A : never
/** The fields a definition marks `given` in its own data. */
type GivenIn<D> = D extends { data: infer X } ? { [K in keyof X]: X[K] extends Given ? K : never }[keyof X] & string : never

/** What a started state has to be given: the fields of its own data that it marks `given`. */
export type RootGiven<X> = X extends State<infer S2, any, any, infer G> ? Givable<{ [K in G & keyof DataOf<S2>]: DataOf<S2>[K] }> : never
type NeedsGiven<X> = X extends State<any, any, any, infer G> ? ([G] extends [never] ? false : true) : false

/** One state for each key of a field, each given its data from its key and the starter's data. */
export interface EachOf<D, X> { readonly each: KeysField<D>; readonly state: X; readonly given: (key: string, data: Read<D>) => RootGiven<X> }
/** One state, given its data from the starter's data. */
export interface OneOf<D, X> { readonly state: X; readonly given: (data: Read<D>) => RootGiven<X> }

// ── one grammar for what a state starts, follows and loads ──────────────────────────────────────────────────────────
//
//   starts:  (start)  => ({ thread: start(thread, { each: 'titles', given: (threadId) => ({ threadId }) }) }),
//   follows: (follow) => ({ detail: follow('threads', 'detail', { from: ['id'], args: ({ id }) => ({ id }), updated }) }),
//   loads:   (load)   => ({ diff:   load('code', 'GET_GIT_DIFF', { from: ['selected'], args: ({ selected }) => selected, done }) }),
//
// Each says which fields of the data it depends on: `each`, a field with one of them for each of its keys, or
// `from`, the fields one reads. What is followed or loaded may name both: one for each key, each asked again when
// a field in `from` changes. The kernel looks again only when one of those fields changes. There is
// nothing to work out and nothing to run to find out, so nothing can throw, and the graph can say what depends on
// what. Each is written as a function of the helper it is made with, which is what gives a handler inside it the
// types of the state it is declared in.

/**
 * Makes a state to start. With `each`, one for each key of that field, or each item where the field is a list: a
 * key that appears starts its state, one that goes stops it, and one that stays leaves it as it is. `given` says
 * what the state is given as it starts, once.
 */
export interface Start<D> {
  <X extends AnyState>(state: X, options: { each: KeysField<D>; given: (key: string, data: Read<D>) => RootGiven<X> }): EachOf<D, X>
  <X extends AnyState>(state: X, options: { given: (data: Read<D>) => RootGiven<X> }): OneOf<D, X>
}

/** What `args` is given: the fields it named, after the key for one of many. One of many that names none is given the key alone. */
type Given_<R, H extends string, K extends string, Many> =
  [Many] extends [string] ? ([K] extends [never] ? [key: string] : [key: string, from: Named<R, H, K>]) : [from: Named<R, H, K>]
type Named<R, H extends string, K extends string> = Read<Pick<DataAt<R, H>, K & keyof DataAt<R, H>>>
/** What a handler of one of many is given beside its scope: which one it is. */
type Keyed<Many> = [Many] extends [string] ? { readonly key: string } : {}
type StandingArgsOpt<R, H extends string, K extends string, Many, A> =
  {} extends Read<A>
    ? { args?: (...given: Given_<R, H, K, Many>) => Read<A> | null | undefined | false }
    : { args: (...given: Given_<R, H, K, Many>) => Read<A> | null | undefined | false }

/** A view a state follows, as `follow` makes it. */
export interface Followed<R, H extends string, E extends AnyEvent, N extends Net> {
  readonly feature: string; readonly view: string; readonly each?: string; readonly from?: readonly string[]
  readonly args?: Function; readonly updated: Function
  readonly _?: { r: R; h: H; e: E; n: N }
}
/**
 * Makes a view to follow. With `from`, it is asked for what `args` makes of those fields, and followed again when
 * one of them changes; where `args` returns nothing (`null`, `undefined`, or `false`), nothing is followed and any
 * previous view stops. With `each`, one is followed for each key of that field, and `args` is given the key: alone, or with the
 * fields named in `from` after it where it names any.
 * With both, each key's view is followed again when a field in `from` changes, and a key that appears or goes
 * starts or stops its own alone. `args` may be omitted when the view accepts `{}`. What it delivers goes to
 * `updated`, which returns what happens next as any handler does.
 */
export type Follow<R, H extends string, E extends AnyEvent, N extends Net> = <
  F extends keyof N['views'] & string, V extends keyof N['views'][F] & string,
  K extends keyof DataAt<R, H> & string = never, Many extends KeysField<DataAt<R, H>> | undefined = undefined,
>(feature: F, view: V, options: StandingArgsOpt<R, H, K, Many, N['views'][F][V]['args']> & {
  /** The fields one reads. It is followed again when one of them changes: every key's, where there is `each`, whose own field is not among them. */
  from?: readonly Exclude<K, Many>[]
  /** A field with one to follow for each of its keys. */
  each?: Many
  updated: (update: ViewUpdate<N['views'][F][V]['result']>, scope: EventScope<R, H, E, N> & Keyed<Many>) => Next<R, H> | void
}) => Followed<R, H, E, N>

type UnkeyedArgsOpt<D, A, I> =
  [I] extends [never]
    ? ({} extends Read<A> ? { args?: (data: Read<D>) => Read<A> } : { args: (data: Read<D>) => Read<A> })
    : ([Read<I>] extends [readonly unknown[]]
        ? { args: (input: Read<I>, data: Read<D>) => Read<A> }
        : [Read<I>] extends [object]
          ? ([Read<I>] extends [Read<A>]
              ? { args?: (input: Read<I>, data: Read<D>) => Read<A> }
              : { args: (input: Read<I>, data: Read<D>) => Read<A> })
          : { args: (input: Read<I>, data: Read<D>) => Read<A> })
type EachArgsOpt<D, A, I> =
  [I] extends [never]
    ? ({} extends Read<A> ? { args?: (key: string, data: Read<D>) => Read<A> } : { args: (key: string, data: Read<D>) => Read<A> })
    : { args: (key: string, input: Read<I>, data: Read<D>) => Read<A> }

/** An imperative ask called one at a time, as `single` builds it. */
export interface CalledSingle<R, H extends string, E extends AnyEvent, N extends Net, I = never> { readonly kind: 'single'; readonly of: string; readonly ask: string; readonly args?: Function; readonly done: Function; readonly progress?: Function; readonly _?: { r: R; h: H; e: E; n: N; i: (input: I) => I } }
/** An imperative ask called per key, as `each` builds it. */
export interface CalledEach<R, H extends string, E extends AnyEvent, N extends Net, I = never> { readonly kind: 'each'; readonly of: string; readonly ask: string; readonly args?: Function; readonly done: Function; readonly progress?: Function; readonly _?: { r: R; h: H; e: E; n: N; i: (input: I) => I } }
/** An imperative ask called concurrently without keys, as `many` builds it. */
export interface CalledMany<R, H extends string, E extends AnyEvent, N extends Net, I = never> { readonly kind: 'many'; readonly of: string; readonly ask: string; readonly args?: Function; readonly done: Function; readonly progress?: Function; readonly _?: { r: R; h: H; e: E; n: N; i: (input: I) => I } }
/** Declares an imperative ask called one at a time (deduped). `args` may be omitted when the ask accepts `{}` or `input` directly. */
export type CallSingle<R, H extends string, E extends AnyEvent, N extends Net> = <S extends SystemsOf<N>, Q extends keyof N['systems'][S]['asks'] & string, I = never>(of: S, ask: Q, options: UnkeyedArgsOpt<DataAt<R, H>, AskOf<N, S, Q>['args'], NoInfer<I>> & {
  done: (outcome: OutcomeOf<AskOf<N, S, Q>>, scope: EventScope<R, H, E, N> & InputScope<NoInfer<I>>) => Next<R, H> | void
  progress?: (updates: ReadonlyArray<ProgressOf<AskOf<N, S, Q>>>, scope: EventScope<R, H, E, N> & InputScope<NoInfer<I>>) => Next<R, H> | void
}) => CalledSingle<R, H, E, N, I>
/** Declares an imperative ask called per key. `args` may be omitted for bare `'each'` when the ask accepts `{}`. */
export type CallEach<R, H extends string, E extends AnyEvent, N extends Net> = <S extends SystemsOf<N>, Q extends keyof N['systems'][S]['asks'] & string, I = never>(of: S, ask: Q, options: EachArgsOpt<DataAt<R, H>, AskOf<N, S, Q>['args'], NoInfer<I>> & {
  done: (outcome: OutcomeOf<AskOf<N, S, Q>>, scope: EventScope<R, H, E, N> & { readonly key: string } & InputScope<NoInfer<I>>) => Next<R, H> | void
  progress?: (updates: ReadonlyArray<ProgressOf<AskOf<N, S, Q>>>, scope: EventScope<R, H, E, N> & { readonly key: string } & InputScope<NoInfer<I>>) => Next<R, H> | void
}) => CalledEach<R, H, E, N, I>
/** Declares an unkeyed concurrent imperative ask. `args` may be omitted when the ask accepts `{}` or `input` directly. */
export type CallMany<R, H extends string, E extends AnyEvent, N extends Net> = <S extends SystemsOf<N>, Q extends keyof N['systems'][S]['asks'] & string, I = never>(of: S, ask: Q, options: UnkeyedArgsOpt<DataAt<R, H>, AskOf<N, S, Q>['args'], NoInfer<I>> & {
  done: (outcome: OutcomeOf<AskOf<N, S, Q>>, scope: EventScope<R, H, E, N> & InputScope<NoInfer<I>>) => Next<R, H> | void
  progress?: (updates: ReadonlyArray<ProgressOf<AskOf<N, S, Q>>>, scope: EventScope<R, H, E, N> & InputScope<NoInfer<I>>) => Next<R, H> | void
}) => CalledMany<R, H, E, N, I>

type ArmExpired<R, H extends string, E extends AnyEvent, N extends Net> = (scope: EventScope<R, H, E, N>) => Next<R, H> | void
type ArmEachExpired<R, H extends string, E extends AnyEvent, N extends Net> = (scope: EventScope<R, H, E, N> & { readonly key: string }) => Next<R, H> | void
/** What a timer is declared with: how long it runs, what its expiring does, and what arming it while armed does. */
type ArmOptions<D> = {
  /** How long it runs, in milliseconds. Left out, each `arm` gives the duration. */
  readonly after?: number
  /** What happens when it expires. Left out, it only shows on `armed` until then. */
  readonly expired?: D
  /** What arming it while it is armed does: `'restart'` (the default) runs it again from now, `'ignore'` leaves it as it is. */
  readonly whenArmed?: 'restart' | 'ignore'
}
/** Marks the options a builder falls back to when it could not read the ones it was given: no options written out have it. */
declare const unread: unique symbol
/** What a builder reads: a timer's options, or `undefined`. Options it cannot read as either are read as all of this. */
type ArmRead<D> = ArmOptions<D> | ArmUnread | undefined
type ArmUnread = { readonly [unread]?: never }
/** The keys that are not options and that every object the options may be has. */
type ArmSharedExtra<O, D> = Exclude<keyof Exclude<O, undefined>, keyof ArmOptions<D>>
/** The keys that are not options and that any object the options may be has. */
type ArmAnyExtra<O, D> = O extends unknown ? Exclude<keyof O, keyof ArmOptions<D>> : never
/**
 * The options as given, with any key that is not an option refused: a misspelled one does not compile, in whichever
 * of the objects the options may be it is written. Where every key is an option, this is the options and nothing
 * wider, so that a bare number or function in their place is refused as having no option in it.
 */
type StrictArmOptions<O, D> = (O & ArmOptions<D> & ArmNoExtra<ArmSharedExtra<O, D>, Exclude<ArmAnyExtra<O, D>, ArmSharedExtra<O, D>>>) | (O & undefined)
/** Each key that is not an option, refused: one every object has by being there at all, one only some have by holding anything. */
type ArmNoExtra<Shared extends PropertyKey, Some extends PropertyKey> =
  & ([Shared] extends [never] ? unknown : { readonly [K in Shared]: never })
  & ([Some] extends [never] ? unknown : { readonly [K in Some]?: never })
/**
 * Whether each `arm` has to give the duration: `true` when the options give none, `false` when they give one, and
 * `boolean`, which no declared timer takes, when they may or may not: options that may be `undefined`, an `after`
 * that may be, or options of type `any`. Options the builder could not read are refused where they are written, so
 * they fit either kind of timer here and that refusal is the one error.
 */
type ArmGivesNoDuration<O> =
  0 extends 1 & O ? boolean
    : [typeof unread] extends [O extends unknown ? keyof O : never] ? any
    : ArmGivesNoDurationIn<O>
/** The same of options that were read: of each thing they may be, and so `boolean` where those differ. */
type ArmGivesNoDurationIn<O> =
  O extends undefined ? true
    : 'after' extends keyof O ? ([O['after']] extends [number] ? false : [O['after']] extends [undefined] ? true : boolean)
    : true
/** An imperative timer armed one at a time, as `single` builds it. */
export interface ArmedSingle<R, H extends string, E extends AnyEvent, N extends Net, NeedsMs extends boolean = boolean> {
  readonly kind: 'single'; readonly after?: number; readonly whenArmed?: 'restart' | 'ignore'; readonly expired?: Function
  readonly _?: { r: R; h: H; e: E; n: N; m: (needsMs: NeedsMs) => NeedsMs }
}
/** An imperative timer armed per key, as `each` builds it. */
export interface ArmedEach<R, H extends string, E extends AnyEvent, N extends Net, NeedsMs extends boolean = boolean> {
  readonly kind: 'each'; readonly after?: number; readonly whenArmed?: 'restart' | 'ignore'; readonly expired?: Function
  readonly _?: { r: R; h: H; e: E; n: N; m: (needsMs: NeedsMs) => NeedsMs }
}
/** Declares an imperative timer (`single`). Give `after` for `'single'`, or leave it out for `{ single: 'at arm' }`. */
export type ArmSingle<R, H extends string, E extends AnyEvent, N extends Net> = {
  (): ArmedSingle<R, H, E, N, true>
  <O extends ArmRead<ArmExpired<R, H, E, N>>>(options: StrictArmOptions<O, ArmExpired<R, H, E, N>>): ArmedSingle<R, H, E, N, ArmGivesNoDuration<O>>
}
/** Declares an imperative keyed timer (`each`). Give `after` for `'each'`, or leave it out for `{ each: 'at arm' }`. */
export type ArmEach<R, H extends string, E extends AnyEvent, N extends Net> = {
  (): ArmedEach<R, H, E, N, true>
  <O extends ArmRead<ArmEachExpired<R, H, E, N>>>(options: StrictArmOptions<O, ArmEachExpired<R, H, E, N>>): ArmedEach<R, H, E, N, ArmGivesNoDuration<O>>
}

/** A standing ask a state loads, as `load` makes it. */
export interface Loaded<R, H extends string, E extends AnyEvent, N extends Net> {
  readonly of: string; readonly ask: string; readonly each?: string; readonly from?: readonly string[]
  readonly args?: Function; readonly done: Function; readonly progress?: Function
  readonly _?: { r: R; h: H; e: E; n: N }
}
/**
 * Declares a standing ask to load.
 *
 * It is a read: it runs because the data says so, for as long as it does. With `from`, it is asked for what `args`
 * makes of those fields, and asked again when one of them changes, cancelling the previous one. Where `args` returns
 * nothing, nothing is asked. To refresh with nothing else changed, name a counter field and increment it. With `each`
 * there is one for each key of that field: an added key asks, and a removed key cancels, and `args` is given the
 * key, alone or with the fields named in `from` after it. With both, each key's is asked again when a field in `from` changes, the one before for that key
 * cancelled. `args` may be omitted when the ask accepts `{}`.
 *
 * Outcomes go to `done`, and streamed progress to `progress` as a list at most once a frame.
 */
export type Load<R, H extends string, E extends AnyEvent, N extends Net> = <
  S extends SystemsOf<N>, Q extends keyof N['systems'][S]['asks'] & string,
  K extends keyof DataAt<R, H> & string = never, Many extends KeysField<DataAt<R, H>> | undefined = undefined,
>(of: S, ask: Q, options: StandingArgsOpt<R, H, K, Many, AskOf<N, S, Q>['args']> & {
  /** The fields one reads. It is asked again when one of them changes: every key's, where there is `each`, whose own field is not among them. */
  from?: readonly Exclude<K, Many>[]
  /** A field with one ask for each of its keys. */
  each?: Many
  done: (outcome: OutcomeOf<AskOf<N, S, Q>>, scope: EventScope<R, H, E, N> & Keyed<Many>) => Next<R, H> | void
  progress?: (updates: ReadonlyArray<ProgressOf<AskOf<N, S, Q>>>, scope: EventScope<R, H, E, N> & Keyed<Many>) => Next<R, H> | void
}) => Loaded<R, H, E, N>

/**
 * What a declaration that breaks a rule is held to, in place of `never`: nothing written can be it, and the compiler
 * prints it as `Refused<"…">`, so its error says which rule was broken and by which name. `forNet` intersects the
 * refusals ahead of the definition, which puts the reason first in the type the error names. It is held to by the
 * whole of what declares the name (a state's `data`, `calls` or `arms`), not by the one entry: it asks for a property
 * nothing has, so what any entry is written as, `any` included, does not come into it. The property is one of its own
 * making, so there is no reason, not even none at all, that leaves it something a definition can be.
 */
declare const refused: unique symbol
type Refused<Why extends string> = { readonly [refused]: Why }

/**
 * Refuses `given` in any state entered automatically via `initial` (at any depth): an `initial` substate is entered
 * with no supplied fields, so a `given` field there would never be provided. A state whose data all has values of
 * its own can be entered first like any other.
 */
/**
 * The fields of written data that are `given`: the ones an initial state cannot have. A value typed `any` is not one
 * of them, and nor is one that may be `given` or a value: a field read as its declared type is exactly that, so the
 * two cannot be told apart here, and what either holds is found where the state starts.
 */
type GivenIn_<X> = { [F in keyof X]: 0 extends 1 & X[F] ? never : [X[F]] extends [Given] ? F : never }[keyof X]
type NoInitialGiven<D> =
  D extends { initial: infer K extends string; states: infer T extends Record<string, unknown> }
    ? {
        states: {
          [P in keyof T]: P extends K
            ? (T[P] extends { data: infer X }
                ? ([GivenIn_<X>] extends [never]
                    ? unknown
                    : { data: { [F in GivenIn_<X>]: Refused<`data field '${F & string}' cannot be given: an initial state is entered with nothing given`> } })
                : unknown) & NoInitialGiven<T[P]>
            : NoInitialGiven<T[P]>
        }
      }
    : D extends { states: infer T extends Record<string, unknown> }
      ? { states: { [P in keyof T]: NoInitialGiven<T[P]> } }
      : unknown

/**
 * Refuses any nested state whose `data`, `calls`, or `arms` redeclares a name already declared by an enclosing state:
 * exiting the inner state deletes its declared fields from the running state's data, and active ancestor and child
 * states share one `pending` / `armed` snapshot map so a shared `calls` or `arms` name would alias live entries.
 * Sibling states may share names because they are never active together.
 */
type NoShadowed<S, AboveData extends string = never, AboveCalls extends string = never, AboveArms extends string = never> =
  S extends { states: infer T extends Record<string, Shape> }
    ? {
        states: {
          [P in keyof T]:
            ([Extract<keyof DataOf<T[P]> & string, AboveData | (keyof DataOf<S> & string)>] extends [never]
              ? unknown
              : { data: Refused<`data field '${Extract<keyof DataOf<T[P]> & string, AboveData | (keyof DataOf<S> & string)>}' is already declared by an enclosing state`> })
            & ([Extract<keyof CallsOf<T[P]> & string, AboveCalls | (keyof CallsOf<S> & string)>] extends [never]
              ? unknown
              : { calls: Refused<`call '${Extract<keyof CallsOf<T[P]> & string, AboveCalls | (keyof CallsOf<S> & string)>}' is already declared by an enclosing state`> })
            & ([Extract<keyof ArmsOf<T[P]> & string, AboveArms | (keyof ArmsOf<S> & string)>] extends [never]
              ? unknown
              : { arms: Refused<`timer '${Extract<keyof ArmsOf<T[P]> & string, AboveArms | (keyof ArmsOf<S> & string)>}' is already declared by an enclosing state`> })
            & NoShadowed<
                T[P],
                AboveData | (keyof DataOf<S> & string),
                AboveCalls | (keyof CallsOf<S> & string),
                AboveArms | (keyof ArmsOf<S> & string)
              >
        }
      }
    : unknown

type CallEntries<S, Above extends string = never> =
  | { [K in Exclude<keyof CallsOf<S> & string, Above>]: [K, CallKind<CallsOf<S>[K]>] }[Exclude<keyof CallsOf<S> & string, Above>]
  | (S extends { states: infer T extends Record<string, Shape> } ? { [N in keyof T]: CallEntries<T[N], Above | (keyof CallsOf<S> & string)> }[keyof T] : never)
type ArmEntries<S, Above extends string = never> =
  | { [K in Exclude<keyof ArmsOf<S> & string, Above>]: [K, ArmKind<ArmsOf<S>[K]>] }[Exclude<keyof ArmsOf<S> & string, Above>]
  | (S extends { states: infer T extends Record<string, Shape> } ? { [N in keyof T]: ArmEntries<T[N], Above | (keyof ArmsOf<S> & string)> }[keyof T] : never)
type IsUnion<T, U = T> = T extends unknown ? ([U] extends [T] ? false : true) : never
type ConflictingNames<Entries> =
  ([Entries] extends [[infer K extends string, unknown]]
    ? { [P in K]: IsUnion<Extract<Entries, [P, unknown]>[1]> extends true ? P : never }[K]
    : never) & string
/**
 * Each reason is written where it is used and under no name of its own: the compiler prints an argument that has a
 * name by that name, and one that has none as the sentences it holds. There is a sentence for each kind a name is
 * declared with, made from the kinds as they are declared, so none is spelled here.
 */
type RejectConflicting<S, Calls, Arms, BadCalls extends string, BadArms extends string> =
  ([Extract<keyof CallsOf<S> & string, BadCalls>] extends [never] ? unknown : {
    calls: Refused<{ [K in Extract<keyof CallsOf<S> & string, BadCalls>]: `call '${K}' is declared with more than one kind across states: '${Extract<Calls, [K, unknown]>[1] & string}' is one of them` }[Extract<keyof CallsOf<S> & string, BadCalls>]>
  })
  & ([Extract<keyof ArmsOf<S> & string, BadArms>] extends [never] ? unknown : {
    arms: Refused<{ [K in Extract<keyof ArmsOf<S> & string, BadArms>]: `timer '${K}' is declared with more than one kind across states: '${Extract<Arms, [K, unknown]>[1] & string}' is one of them` }[Extract<keyof ArmsOf<S> & string, BadArms>]>
  })
  & (S extends { states: infer T extends Record<string, Shape> }
    ? { states: { [P in keyof T]: RejectConflicting<T[P], Calls, Arms, BadCalls, BadArms> } }
    : unknown)
/**
 * Refuses declaring the same `calls` or `arms` name with conflicting kinds (`single` vs `each` vs `many`) across
 * states of one machine: `pending` and `armed` each have one flat namespace per machine, so conflicting kinds would
 * clash on the snapshot.
 */
type NoConflictingKinds<S> =
  [ConflictingNames<CallEntries<S>> | ConflictingNames<ArmEntries<S>>] extends [never]
    ? unknown
    : RejectConflicting<S, CallEntries<S>, ArmEntries<S>, ConflictingNames<CallEntries<S>>, ConflictingNames<ArmEntries<S>>>

/**
 * `state`, bound to the network `N` it can reach by name. In the app this is what a pack's generated facade exports.
 * Pass `resolve` to map bare own-pack names to qualified runtime refs (applied to string `tell`, `{ surface }`,
 * `broadcast`, string `ask`, `loads`, `calls`, and `follows`; never to handles or `{ peer }`).
 *
 * `resolve` must be a pure, deterministic function returning a non-empty string. At runtime the kernel memoizes each
 * resolved name per running state instance for its lifetime, validates that the return value is a non-empty string,
 * and isolates thrown errors as defects without corrupting state or pending bookkeeping.
 */
export function forNet<N extends Net = Nothing>(resolve?: (name: string) => string): <S extends Shape, E extends AnyEvent = never, A extends Asks = {}>() => <D extends Def<S, S, '', E, A, N>>(def: NoShadowed<S> & NoConflictingKinds<S> & NoInitialGiven<NoInfer<D>> & D) => State<S, E, A, GivenIn<D>> {
  return () => (def) => (resolve ? { def, resolve } : { def })
}

/** Defines a standalone state that reaches no external systems, surfaces, views, or peers by name. */
export const state = forNet()
