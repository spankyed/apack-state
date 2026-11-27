// The timers a state arms: where one may be armed or disarmed, its duration, and its armed record.
// Compiled by `npm run typecheck`, never run: each `@ts-expect-error` is a line that must not compile, and one that
// compiled would fail the check as an unused directive.

import { forNet, state, type Value } from '../src/index.ts'

type TimersShape = {
  data: { count: number; lastKey: string | null }
  arms: {
    pulse: 'single'
    backoff: { single: 'at arm' }
    readonly fixedReadonly: { readonly single: 'at arm' }
    flash: 'each'
    retry: { each: 'at arm' }
    readonly retryReadonly: { readonly each: 'at arm' }
  }
  states: {
    idle: {}
    active: {
      arms: { inner: 'single' }
    }
  }
}

type TimersEvent =
  | { type: 'ARM_ALL' }
  | { type: 'DISARM_ALL' }
  | { type: 'BAD_1' }
  | { type: 'BAD_2' }
  | { type: 'BAD_3' }
  | { type: 'BAD_4' }
  | { type: 'BAD_5' }
  | { type: 'BAD_6' }
  | { type: 'BAD_7' }
  | { type: 'BAD_8' }
  | { type: 'BAD_9' }

// Positive check: a declared duration, one given at arm (mutable and readonly), pure-TTL (no done), `done`, `whenArmed`, and nested timers.
state<TimersShape, TimersEvent>()({
  data: { count: 0, lastKey: null },
  initial: 'idle',
  arms: ({ single, each }) => ({
    pulse: single({ after: 300 }),
    backoff: single({ done: ({ data }) => ({ data: { count: data.count + 1 } }) }),
    fixedReadonly: single({ whenArmed: 'ignore', done: () => ({ at: 'idle' }) }),
    flash: each({ after: 500, done: ({ key, data }) => ({ data: { lastKey: key, count: data.count + 1 } }) }),
    retry: each({ whenArmed: 'ignore', done: ({ key }) => ({ data: { lastKey: key } }) }),
    retryReadonly: each(),
  }),
  on: {
    ARM_ALL: (_, { arm }) => {
      arm('pulse')
      arm('pulse', 100)
      arm('backoff', 250)
      arm('fixedReadonly', 50)
      arm('flash', 'k1')
      arm('flash', 'k1', 200)
      arm('retry', 'k2', 400)
      arm('retryReadonly', 'k3', 10)
    },
    DISARM_ALL: (_, { disarm }) => {
      disarm('pulse')
      disarm('backoff')
      disarm('flash', 'k1')
      disarm('flash')
      disarm('retry')
      disarm('retry', 'k2')
    },
    // @ts-expect-error an inner timer is declared by a state inside, so only a handler there can arm it
    BAD_1: (_, { arm }) => { arm('inner') },
    // @ts-expect-error a `single` timer whose duration is given at arm requires `ms` when armed
    BAD_2: (_, { arm }) => { arm('backoff') },
    // @ts-expect-error a `single` timer with `after` takes no extra payload argument beyond optional `ms`
    BAD_3: (_, { arm }) => { arm('pulse', 100, { payload: true }) },
    // @ts-expect-error an `each` timer requires its key
    BAD_4: (_, { arm }) => { arm('flash') },
    // @ts-expect-error an `each` timer whose duration is given at arm requires both key and `ms`
    BAD_5: (_, { arm }) => { arm('retry', 'k1') },
    // @ts-expect-error an `each` timer takes no extra payload argument beyond key and `ms`
    BAD_6: (_, { arm }) => { arm('flash', 'k1', 100, { payload: true }) },
    // @ts-expect-error a `single` timer takes no key when disarmed
    BAD_7: (_, { disarm }) => { disarm('pulse', 'k1') },
    // @ts-expect-error it declares no such timer
    BAD_8: (_, { arm }) => { arm('unknown') },
    // @ts-expect-error a `single` timer whose duration is given at arm takes no extra payload argument
    BAD_9: (_, { arm }) => { arm('backoff', 250, 'extra') },
  },
  states: {
    idle: {},
    active: {
      arms: ({ single }) => ({
        inner: single({ after: 100, whenArmed: 'restart', done: () => ({ at: 'idle' }) }),
      }),
      on: {
        ARM_ALL: (_, { arm }) => {
          arm('pulse')
          arm('inner')
        },
      },
    },
  },
})

// Negative checks for Def.arms declarations.
// @ts-expect-error a state whose shape declares arms has to define them
state<{ arms: { pulse: 'single' } }>()({})

state<{ data: { n: number }; arms: { fixed: 'single'; dynamic: { single: 'at arm' }; keyed: 'each'; dynKeyed: { each: 'at arm' } } }>()({
  data: { n: 0 },
  arms: ({ single }) => ({
    // @ts-expect-error a `'single'` timer requires `after`
    fixed: single(),
    // @ts-expect-error a `{ single: 'at arm' }` timer does not accept `after`
    dynamic: single({ after: 100 }),
    // @ts-expect-error an `'each'` timer must be built with `each`, not `single`
    keyed: single({ after: 100 }),
    // @ts-expect-error a `{ each: 'at arm' }` timer must be built with `each`, not `single`
    dynKeyed: single(),
  }),
})

declare const flag: boolean
// A conditional `done` or `whenArmed` that may be `undefined` compiles cleanly while misspelled option keys are still rejected.
state<{ data: { n: number }; arms: { optDone: 'single'; optWhen: 'single'; optDyn: { single: 'at arm' }; optEach: 'each'; optNone: { single: 'at arm' }; badOptUnion: 'single' } }>()({
  data: { n: 0 },
  arms: ({ single, each }) => ({
    optDone: single({ after: 100, done: flag ? ({ data }) => ({ data: { n: data.n + 1 } }) : undefined }),
    optWhen: single({ after: 100, whenArmed: flag ? 'ignore' : undefined }),
    optDyn: single({ whenArmed: flag ? 'ignore' : 'restart' }),
    optEach: each({ after: 100, done: flag ? ({ key }) => { void key } : undefined }),
    optNone: single(undefined),
    // @ts-expect-error unknown option keys are still rejected when `done` may be `undefined`
    badOptUnion: single({ after: 100, whenArmd: 'ignore', done: flag ? () => {} : undefined }),
  }),
})

state<{ data: { n: number }; arms: { badDone: 'single'; badEachDone: 'each' } }>()({
  data: { n: 0 },
  arms: ({ single, each }) => ({
    // @ts-expect-error a `single` timer's `done` return value is checked against the state's data
    badDone: single({ after: 100, done: () => ({ data: { n: 'wrong' } }) }),
    // @ts-expect-error an `each` timer's `done` return value is checked against the state's data
    badEachDone: each({ after: 100, done: () => ({ data: { n: 'wrong' } }) }),
  }),
})

// Each timer here is declared as the kind its options, as written, make: `'at arm'` where they hold no `after`. So the
// one error on each of those lines is the option's own, and not the kind of timer that came of it.
state<{ data: { n: number }; arms: { badAfter: { single: 'at arm' }; badWhenArmed: 'single'; badAfterEach: { each: 'at arm' }; badWhenArmedEach: { each: 'at arm' }; badAfterAlone: { single: 'at arm' }; badWhenArmedValue: { single: 'at arm' }; badPositional: { single: 'at arm' }; badPositionalDone: { single: 'at arm' } } }>()({
  data: { n: 0 },
  arms: ({ single, each }) => ({
    // @ts-expect-error a misspelled `after` on a `single` timer is rejected even when `done` is present
    badAfter: single({ afer: 100, done: () => {} }),
    // @ts-expect-error a misspelled `whenArmed` on a `single` timer is rejected even when `done` is present
    badWhenArmed: single({ after: 100, whenArmd: 'ignore', done: () => {} }),
    // @ts-expect-error a misspelled `after` on an `each` timer is rejected even when `done` is present
    badAfterEach: each({ afer: 100, done: () => {} }),
    // @ts-expect-error a misspelled `whenArmed` on an `each` timer is rejected even when `done` is present
    badWhenArmedEach: each({ whenArmd: 'ignore', done: () => {} }),
    // @ts-expect-error a misspelled `after` is rejected when it is the only option
    badAfterAlone: single({ afer: 100 }),
    // @ts-expect-error `whenArmed` is `'restart'` or `'ignore'`
    badWhenArmedValue: single({ whenArmed: 'reset' }),
    // @ts-expect-error a duration is given as `after`, not as a bare number
    badPositional: single(100),
    // @ts-expect-error what expiring does is given as `done`, not as a bare function
    badPositionalDone: single(() => {}),
  }),
})

// What decides whether each `arm` gives the duration is the type of the options, and of `after` in them: options that
// may be `undefined`, or an `after` that may be, are neither a duration declared nor one left to each `arm`.
declare const duration: number
declare const maybeDuration: number | undefined
const heldOptions = { after: 100, whenArmed: 'ignore' as const }
const heldBare = { whenArmed: 'ignore' as const }
declare const maybeOptions: { readonly after: number } | undefined
declare const optionalAfter: { readonly after?: number }
declare const untypedOptions: any
state<{ data: { n: number }; arms: {
  literal: 'single'; fromNumber: 'single'; held: 'single'; heldEach: 'each'; typedDone: 'single'; ignoring: 'single'
  bare: { single: 'at arm' }; doneOnly: { single: 'at arm' }; heldAtArm: { single: 'at arm' }; noAfter: { single: 'at arm' }; maybeNothing: { single: 'at arm' }
  maybeNone: 'single'; maybeNoneEach: 'each'; maybeHeld: 'single'; maybeAfter: 'single'; maybeAfterEach: 'each'; optional: 'single'
  maybeAfterAtArm: { single: 'at arm' }; maybeAfterAtArmEach: { each: 'at arm' }; optionalAtArm: { single: 'at arm' }; untyped: 'single'; untypedAtArm: { single: 'at arm' }
} }>()({
  data: { n: 0 },
  arms: ({ single, each }) => ({
    literal: single({ after: 100 }),
    fromNumber: single({ after: duration }),
    held: single(heldOptions),
    heldEach: each(heldOptions),
    typedDone: single({ after: 100, done: ({ data, arm }) => { arm('literal'); return { data: { n: data.n + 1 } } } }),
    ignoring: single({ after: 100, whenArmed: 'ignore' }),
    bare: single(),
    doneOnly: single({ done: ({ data }) => ({ data: { n: data.n + 1 } }) }),
    heldAtArm: single(heldBare),
    noAfter: single({ after: undefined }),
    maybeNothing: single(flag ? { done: () => {} } : undefined),
    // @ts-expect-error options that may be `undefined` declare no duration for a `'single'` timer
    maybeNone: single(flag ? { after: 100 } : undefined),
    // @ts-expect-error options that may be `undefined` declare no duration for an `'each'` timer
    maybeNoneEach: each(flag ? { after: 100 } : undefined),
    // @ts-expect-error options held in a constant that may be `undefined` declare no duration either
    maybeHeld: single(maybeOptions),
    // @ts-expect-error an `after` that may be `undefined` declares no duration for a `'single'` timer
    maybeAfter: single({ after: flag ? 100 : undefined }),
    // @ts-expect-error an `after` that may be `undefined` declares no duration for an `'each'` timer
    maybeAfterEach: each({ after: maybeDuration }),
    // @ts-expect-error an `after` that may be left out declares no duration
    optional: single(optionalAfter),
    // @ts-expect-error a `{ single: 'at arm' }` timer does not accept an `after` that may be a duration
    maybeAfterAtArm: single({ after: flag ? 100 : undefined }),
    // @ts-expect-error a `{ each: 'at arm' }` timer does not accept an `after` that may be a duration
    maybeAfterAtArmEach: each({ after: maybeDuration }),
    // @ts-expect-error a `{ single: 'at arm' }` timer does not accept an `after` that may be there
    optionalAtArm: single(optionalAfter),
    // @ts-expect-error options of type `any` say nothing of a duration, so they declare none
    untyped: single(untypedOptions),
    // @ts-expect-error options of type `any` may hold an `after`, which a `{ single: 'at arm' }` timer does not accept
    untypedAtArm: single(untypedOptions),
  }),
})

// A key that is not an option is refused in options held in a constant, and in whichever of the objects they may be.
const heldMisspelled = { after: 100, whenArmd: 'ignore' as const }
declare const eitherOptions: { readonly after: number; readonly whenArmd?: 'ignore' } | { readonly after: number }
declare const eitherOrNone: { readonly whenArmd?: 'ignore' } | undefined
state<{ data: { n: number }; arms: { badHeld: 'single'; badEither: 'single'; badEitherEach: 'each'; badEitherOrNone: { single: 'at arm' }; badUndefinedKey: 'single' } }>()({
  data: { n: 0 },
  arms: ({ single, each }) => ({
    // @ts-expect-error a misspelled option is refused in options held in a constant
    badHeld: single(heldMisspelled),
    // @ts-expect-error a misspelled option is refused when only one of the objects the options may be has it
    badEither: single(eitherOptions),
    // @ts-expect-error a misspelled option is refused on an `each` timer when only one of the objects the options may be has it
    badEitherEach: each(eitherOptions),
    // @ts-expect-error a misspelled option is refused in options that may be `undefined`
    badEitherOrNone: single(eitherOrNone),
    // @ts-expect-error a key that is not an option is refused whatever it holds
    badUndefinedKey: single({ after: 100, afer: undefined }),
  }),
})

// A mistake inside an option is the one error of its line, whichever kind of timer it is declared for: the kind the
// builder makes does not turn on options it could not read.
state<{ data: { n: number }; arms: { badAfterType: 'single'; badAfterTypeAtArm: { each: 'at arm' }; badWhenArmedFixed: 'single'; badPositionalFixed: 'single' } }>()({
  data: { n: 0 },
  arms: ({ single, each }) => ({
    // @ts-expect-error `after` is a number of milliseconds
    badAfterType: single({ after: '100' }),
    // @ts-expect-error `after` is a number of milliseconds, on a timer that takes none as on one that does
    badAfterTypeAtArm: each({ after: '100' }),
    // @ts-expect-error `whenArmed` is `'restart'` or `'ignore'`, on a timer with a declared duration too
    badWhenArmedFixed: single({ after: 100, whenArmed: 'reset' }),
    // @ts-expect-error a bare number is no options for a timer with a declared duration either
    badPositionalFixed: single(100),
  }),
})

state<{ data: { n: number } }>()({
  data: { n: 0 },
  // @ts-expect-error a state whose shape declares no arms cannot define `arms`
  arms: () => ({}),
})

// Value<S> armed narrowing and absence when no arms are declared.
declare const timersValue: Value<TimersShape>
const _pulse: boolean = timersValue.armed.pulse
const _backoff: boolean = timersValue.armed.backoff
const _inner: boolean = timersValue.armed.inner
const _flash: Readonly<Record<string, true>> = timersValue.armed.flash
const _retry: Readonly<Record<string, true>> = timersValue.armed.retry
// @ts-expect-error a `single` timer exposes `boolean` on `armed`, not a record
const _badSingle: Readonly<Record<string, true>> = timersValue.armed.pulse
// @ts-expect-error an `each` timer exposes `Readonly<Record<string, true>>` on `armed`, not a `boolean`
const _badEach: boolean = timersValue.armed.flash
// @ts-expect-error `armed` is read-only and cannot be mutated
timersValue.armed.pulse = true
void _pulse; void _backoff; void _inner; void _flash; void _retry; void _badSingle; void _badEach

declare const plainValue: Value<{ data: { n: number } }>
// @ts-expect-error a state with no declared arms has no `armed` property on its value
void plainValue.armed

// Sibling states may share a timer name with the same kind (e.g. `'single'` and `{ single: 'at arm' }`),
// but conflicting kinds (`single` vs `each`) across states are refused at definition time.
type SameKindArmsShape = {
  states: {
    a: { arms: { retry: 'single' } }
    b: { arms: { retry: { single: 'at arm' } } }
  }
}
state<SameKindArmsShape, never>()({
  initial: 'a',
  states: {
    a: { arms: ({ single }) => ({ retry: single({ after: 100 }) }) },
    b: { arms: ({ single }) => ({ retry: single() }) },
  },
})
declare const sameKindArmsValue: Value<SameKindArmsShape>
const _sameKindArmed: boolean = sameKindArmsValue.armed.retry
void _sameKindArmed

type ConflictingArmsShape = {
  states: {
    a: { arms: { retry: 'single' } }
    b: { arms: { retry: 'each' } }
  }
}
state<ConflictingArmsShape, never>()({
  initial: 'a',
  states: {
    a: {
      // @ts-expect-error a timer name cannot be declared with conflicting kinds across states of one machine
      arms: ({ single }) => ({ retry: single({ after: 100 }) }),
    },
    b: {
      // @ts-expect-error a timer name cannot be declared with conflicting kinds across states of one machine
      arms: ({ each }) => ({ retry: each({ after: 100 }) }),
    },
  },
})

// A nested state cannot redeclare a timer name already declared by an enclosing state (direct child or grandchild),
// and the error lands on the redeclaring inner declaration even when the inner kind also differs; a call of the same
// name lives in `pending` (a separate namespace from `armed`), so a child call may share the parent's timer name.
type ArmCallCrossNet = { systems: { svc: { events: never; asks: { PING: { args: {}; answer: void } } } }; surfaces: {}; views: {} }
const armTyped = forNet<ArmCallCrossNet>()
type DirectShadowArmsShape = {
  arms: { retry: 'single' }
  states: {
    a: { arms: { retry: 'single' } }
    b: { arms: { retry: 'each' } }
    c: { arms: { other: 'single' }; calls: { retry: 'single' } }
  }
}
armTyped<DirectShadowArmsShape, never>()({
  initial: 'a',
  arms: ({ single }) => ({ retry: single({ after: 100 }) }),
  states: {
    a: {
      // @ts-expect-error a child state cannot shadow a timer name declared by its parent
      arms: ({ single }) => ({ retry: single({ after: 100 }) }),
    },
    b: {
      // @ts-expect-error shadowing an enclosing timer name is reported on the redeclaring child even with a different kind
      arms: ({ each }) => ({ retry: each({ after: 100 }) }),
    },
    c: {
      arms: ({ single }) => ({ other: single({ after: 100 }) }),
      calls: ({ single }) => ({ retry: single('svc', 'PING', { done: () => {} }) }),
    },
  },
})

type DeepShadowArmsShape = {
  arms: { retry: 'single' }
  states: { mid: { states: { idle: {}; leaf: { arms: { retry: 'single' } } } } }
}
state<DeepShadowArmsShape, never>()({
  initial: 'mid',
  arms: ({ single }) => ({ retry: single({ after: 100 }) }),
  states: {
    mid: {
      initial: 'idle',
      states: {
        idle: {},
        leaf: {
          // @ts-expect-error a deeply nested state cannot shadow a timer name declared by an ancestor
          arms: ({ single }) => ({ retry: single({ after: 100 }) }),
        },
      },
    },
  },
})
