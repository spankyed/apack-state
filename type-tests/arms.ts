// The timers a state arms: where one may be armed or disarmed, its duration, and its armed record.
// Compiled by `npm run typecheck`, never run: each `@ts-expect-error` is a line that must not compile, and one that
// compiled would fail the check as an unused directive.

import { forNet, state, type Value } from '../src/index.ts'

type TimersShape = {
  data: { count: number; lastKey: string | null }
  arms: {
    pulse: 'one'
    backoff: { one: 'at arm' }
    readonly fixedReadonly: { readonly one: 'at arm' }
    flash: 'each'
    retry: { each: 'at arm' }
    readonly retryReadonly: { readonly each: 'at arm' }
  }
  states: {
    idle: {}
    active: {
      arms: { inner: 'one' }
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

// Positive check: a declared duration, one given at arm (mutable and readonly), pure-TTL (no expired), `expired`, `whenArmed`, and nested timers.
state<TimersShape, TimersEvent>()({
  data: { count: 0, lastKey: null },
  initial: 'idle',
  arms: ({ one, each }) => ({
    pulse: one({ after: 300 }),
    backoff: one({ expired: ({ data }) => ({ data: { count: data.count + 1 } }) }),
    fixedReadonly: one({ whenArmed: 'ignore', expired: () => ({ at: 'idle' }) }),
    flash: each({ after: 500, expired: ({ key, data }) => ({ data: { lastKey: key, count: data.count + 1 } }) }),
    retry: each({ whenArmed: 'ignore', expired: ({ key }) => ({ data: { lastKey: key } }) }),
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
    // @ts-expect-error a `one` timer whose duration is given at arm requires `ms` when armed
    BAD_2: (_, { arm }) => { arm('backoff') },
    // @ts-expect-error a `one` timer with `after` takes no extra payload argument beyond optional `ms`
    BAD_3: (_, { arm }) => { arm('pulse', 100, { payload: true }) },
    // @ts-expect-error an `each` timer requires its key
    BAD_4: (_, { arm }) => { arm('flash') },
    // @ts-expect-error an `each` timer whose duration is given at arm requires both key and `ms`
    BAD_5: (_, { arm }) => { arm('retry', 'k1') },
    // @ts-expect-error an `each` timer takes no extra payload argument beyond key and `ms`
    BAD_6: (_, { arm }) => { arm('flash', 'k1', 100, { payload: true }) },
    // @ts-expect-error a `one` timer takes no key when disarmed
    BAD_7: (_, { disarm }) => { disarm('pulse', 'k1') },
    // @ts-expect-error it declares no such timer
    BAD_8: (_, { arm }) => { arm('unknown') },
    // @ts-expect-error a `one` timer whose duration is given at arm takes no extra payload argument
    BAD_9: (_, { arm }) => { arm('backoff', 250, 'extra') },
  },
  states: {
    idle: {},
    active: {
      arms: ({ one }) => ({
        inner: one({ after: 100, whenArmed: 'restart', expired: () => ({ at: 'idle' }) }),
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
state<{ arms: { pulse: 'one' } }>()({})

state<{ data: { n: number }; arms: { fixed: 'one'; dynamic: { one: 'at arm' }; keyed: 'each'; dynKeyed: { each: 'at arm' } } }>()({
  data: { n: 0 },
  arms: ({ one }) => ({
    // @ts-expect-error a `'one'` timer requires `after`
    fixed: one(),
    // @ts-expect-error a `{ one: 'at arm' }` timer does not accept `after`
    dynamic: one({ after: 100 }),
    // @ts-expect-error an `'each'` timer must be built with `each`, not `one`
    keyed: one({ after: 100 }),
    // @ts-expect-error a `{ each: 'at arm' }` timer must be built with `each`, not `one`
    dynKeyed: one(),
  }),
})

declare const flag: boolean
// A conditional `expired` or `whenArmed` that may be `undefined` compiles cleanly while misspelled option keys are still rejected.
state<{ data: { n: number }; arms: { optExpired: 'one'; optWhen: 'one'; optDyn: { one: 'at arm' }; optEach: 'each'; optNone: { one: 'at arm' }; badOptUnion: 'one' } }>()({
  data: { n: 0 },
  arms: ({ one, each }) => ({
    optExpired: one({ after: 100, expired: flag ? ({ data }) => ({ data: { n: data.n + 1 } }) : undefined }),
    optWhen: one({ after: 100, whenArmed: flag ? 'ignore' : undefined }),
    optDyn: one({ whenArmed: flag ? 'ignore' : 'restart' }),
    optEach: each({ after: 100, expired: flag ? ({ key }) => { void key } : undefined }),
    optNone: one(undefined),
    // @ts-expect-error unknown option keys are still rejected when `expired` may be `undefined`
    badOptUnion: one({ after: 100, whenArmd: 'ignore', expired: flag ? () => {} : undefined }),
  }),
})

state<{ data: { n: number }; arms: { badExpired: 'one'; badEachExpired: 'each' } }>()({
  data: { n: 0 },
  arms: ({ one, each }) => ({
    // @ts-expect-error a `one` timer's `expired` return value is checked against the state's data
    badExpired: one({ after: 100, expired: () => ({ data: { n: 'wrong' } }) }),
    // @ts-expect-error an `each` timer's `expired` return value is checked against the state's data
    badEachExpired: each({ after: 100, expired: () => ({ data: { n: 'wrong' } }) }),
  }),
})

// Each timer here is declared as the kind its options, as written, make: `'at arm'` where they hold no `after`. So the
// one error on each of those lines is the option's own, and not the kind of timer that came of it.
state<{ data: { n: number }; arms: { badAfter: { one: 'at arm' }; badWhenArmed: 'one'; badAfterEach: { each: 'at arm' }; badWhenArmedEach: { each: 'at arm' }; badAfterAlone: { one: 'at arm' }; badWhenArmedValue: { one: 'at arm' }; badPositional: { one: 'at arm' }; badPositionalExpired: { one: 'at arm' } } }>()({
  data: { n: 0 },
  arms: ({ one, each }) => ({
    // @ts-expect-error a misspelled `after` on a `one` timer is rejected even when `expired` is present
    badAfter: one({ afer: 100, expired: () => {} }),
    // @ts-expect-error a misspelled `whenArmed` on a `one` timer is rejected even when `expired` is present
    badWhenArmed: one({ after: 100, whenArmd: 'ignore', expired: () => {} }),
    // @ts-expect-error a misspelled `after` on an `each` timer is rejected even when `expired` is present
    badAfterEach: each({ afer: 100, expired: () => {} }),
    // @ts-expect-error a misspelled `whenArmed` on an `each` timer is rejected even when `expired` is present
    badWhenArmedEach: each({ whenArmd: 'ignore', expired: () => {} }),
    // @ts-expect-error a misspelled `after` is rejected when it is the only option
    badAfterAlone: one({ afer: 100 }),
    // @ts-expect-error `whenArmed` is `'restart'` or `'ignore'`
    badWhenArmedValue: one({ whenArmed: 'reset' }),
    // @ts-expect-error a duration is given as `after`, not as a bare number
    badPositional: one(100),
    // @ts-expect-error what expiring does is given as `expired`, not as a bare function
    badPositionalExpired: one(() => {}),
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
  literal: 'one'; fromNumber: 'one'; held: 'one'; heldEach: 'each'; typedExpired: 'one'; ignoring: 'one'
  bare: { one: 'at arm' }; expiredOnly: { one: 'at arm' }; heldAtArm: { one: 'at arm' }; noAfter: { one: 'at arm' }; maybeNothing: { one: 'at arm' }
  maybeNone: 'one'; maybeNoneEach: 'each'; maybeHeld: 'one'; maybeAfter: 'one'; maybeAfterEach: 'each'; optional: 'one'
  maybeAfterAtArm: { one: 'at arm' }; maybeAfterAtArmEach: { each: 'at arm' }; optionalAtArm: { one: 'at arm' }; untyped: 'one'; untypedAtArm: { one: 'at arm' }
} }>()({
  data: { n: 0 },
  arms: ({ one, each }) => ({
    literal: one({ after: 100 }),
    fromNumber: one({ after: duration }),
    held: one(heldOptions),
    heldEach: each(heldOptions),
    typedExpired: one({ after: 100, expired: ({ data, arm }) => { arm('literal'); return { data: { n: data.n + 1 } } } }),
    ignoring: one({ after: 100, whenArmed: 'ignore' }),
    bare: one(),
    expiredOnly: one({ expired: ({ data }) => ({ data: { n: data.n + 1 } }) }),
    heldAtArm: one(heldBare),
    noAfter: one({ after: undefined }),
    maybeNothing: one(flag ? { expired: () => {} } : undefined),
    // @ts-expect-error options that may be `undefined` declare no duration for a `'one'` timer
    maybeNone: one(flag ? { after: 100 } : undefined),
    // @ts-expect-error options that may be `undefined` declare no duration for an `'each'` timer
    maybeNoneEach: each(flag ? { after: 100 } : undefined),
    // @ts-expect-error options held in a constant that may be `undefined` declare no duration either
    maybeHeld: one(maybeOptions),
    // @ts-expect-error an `after` that may be `undefined` declares no duration for a `'one'` timer
    maybeAfter: one({ after: flag ? 100 : undefined }),
    // @ts-expect-error an `after` that may be `undefined` declares no duration for an `'each'` timer
    maybeAfterEach: each({ after: maybeDuration }),
    // @ts-expect-error an `after` that may be left out declares no duration
    optional: one(optionalAfter),
    // @ts-expect-error a `{ one: 'at arm' }` timer does not accept an `after` that may be a duration
    maybeAfterAtArm: one({ after: flag ? 100 : undefined }),
    // @ts-expect-error a `{ each: 'at arm' }` timer does not accept an `after` that may be a duration
    maybeAfterAtArmEach: each({ after: maybeDuration }),
    // @ts-expect-error a `{ one: 'at arm' }` timer does not accept an `after` that may be there
    optionalAtArm: one(optionalAfter),
    // @ts-expect-error options of type `any` say nothing of a duration, so they declare none
    untyped: one(untypedOptions),
    // @ts-expect-error options of type `any` may hold an `after`, which a `{ one: 'at arm' }` timer does not accept
    untypedAtArm: one(untypedOptions),
  }),
})

// A key that is not an option is refused in options held in a constant, and in whichever of the objects they may be.
const heldMisspelled = { after: 100, whenArmd: 'ignore' as const }
declare const eitherOptions: { readonly after: number; readonly whenArmd?: 'ignore' } | { readonly after: number }
declare const eitherOrNone: { readonly whenArmd?: 'ignore' } | undefined
state<{ data: { n: number }; arms: { badHeld: 'one'; badEither: 'one'; badEitherEach: 'each'; badEitherOrNone: { one: 'at arm' }; badUndefinedKey: 'one' } }>()({
  data: { n: 0 },
  arms: ({ one, each }) => ({
    // @ts-expect-error a misspelled option is refused in options held in a constant
    badHeld: one(heldMisspelled),
    // @ts-expect-error a misspelled option is refused when only one of the objects the options may be has it
    badEither: one(eitherOptions),
    // @ts-expect-error a misspelled option is refused on an `each` timer when only one of the objects the options may be has it
    badEitherEach: each(eitherOptions),
    // @ts-expect-error a misspelled option is refused in options that may be `undefined`
    badEitherOrNone: one(eitherOrNone),
    // @ts-expect-error a key that is not an option is refused whatever it holds
    badUndefinedKey: one({ after: 100, afer: undefined }),
  }),
})

// A mistake inside an option is the one error of its line, whichever kind of timer it is declared for: the kind the
// builder makes does not turn on options it could not read.
state<{ data: { n: number }; arms: { badAfterType: 'one'; badAfterTypeAtArm: { each: 'at arm' }; badWhenArmedFixed: 'one'; badPositionalFixed: 'one' } }>()({
  data: { n: 0 },
  arms: ({ one, each }) => ({
    // @ts-expect-error `after` is a number of milliseconds
    badAfterType: one({ after: '100' }),
    // @ts-expect-error `after` is a number of milliseconds, on a timer that takes none as on one that does
    badAfterTypeAtArm: each({ after: '100' }),
    // @ts-expect-error `whenArmed` is `'restart'` or `'ignore'`, on a timer with a declared duration too
    badWhenArmedFixed: one({ after: 100, whenArmed: 'reset' }),
    // @ts-expect-error a bare number is no options for a timer with a declared duration either
    badPositionalFixed: one(100),
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
// @ts-expect-error a `one` timer exposes `boolean` on `armed`, not a record
const _badOne: Readonly<Record<string, true>> = timersValue.armed.pulse
// @ts-expect-error an `each` timer exposes `Readonly<Record<string, true>>` on `armed`, not a `boolean`
const _badEach: boolean = timersValue.armed.flash
// @ts-expect-error `armed` is read-only and cannot be mutated
timersValue.armed.pulse = true
void _pulse; void _backoff; void _inner; void _flash; void _retry; void _badOne; void _badEach

declare const plainValue: Value<{ data: { n: number } }>
// @ts-expect-error a state with no declared arms has no `armed` property on its value
void plainValue.armed

// Sibling states may share a timer name with the same kind (e.g. `'one'` and `{ one: 'at arm' }`),
// but conflicting kinds (`one` vs `each`) across states are refused at definition time.
type SameKindArmsShape = {
  states: {
    a: { arms: { retry: 'one' } }
    b: { arms: { retry: { one: 'at arm' } } }
  }
}
state<SameKindArmsShape, never>()({
  initial: 'a',
  states: {
    a: { arms: ({ one }) => ({ retry: one({ after: 100 }) }) },
    b: { arms: ({ one }) => ({ retry: one() }) },
  },
})
declare const sameKindArmsValue: Value<SameKindArmsShape>
const _sameKindArmed: boolean = sameKindArmsValue.armed.retry
void _sameKindArmed

type ConflictingArmsShape = {
  states: {
    a: { arms: { retry: 'one' } }
    b: { arms: { retry: 'each' } }
  }
}
state<ConflictingArmsShape, never>()({
  initial: 'a',
  states: {
    a: {
      // @ts-expect-error a timer name cannot be declared with conflicting kinds across states of one machine
      arms: ({ one }) => ({ retry: one({ after: 100 }) }),
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
  arms: { retry: 'one' }
  states: {
    a: { arms: { retry: 'one' } }
    b: { arms: { retry: 'each' } }
    c: { arms: { other: 'one' }; calls: { retry: 'one' } }
  }
}
armTyped<DirectShadowArmsShape, never>()({
  initial: 'a',
  arms: ({ one }) => ({ retry: one({ after: 100 }) }),
  states: {
    a: {
      // @ts-expect-error a child state cannot shadow a timer name declared by its parent
      arms: ({ one }) => ({ retry: one({ after: 100 }) }),
    },
    b: {
      // @ts-expect-error shadowing an enclosing timer name is reported on the redeclaring child even with a different kind
      arms: ({ each }) => ({ retry: each({ after: 100 }) }),
    },
    c: {
      arms: ({ one }) => ({ other: one({ after: 100 }) }),
      calls: ({ one }) => ({ retry: one('svc', 'PING', { done: () => {} }) }),
    },
  },
})

type DeepShadowArmsShape = {
  arms: { retry: 'one' }
  states: { mid: { states: { idle: {}; leaf: { arms: { retry: 'one' } } } } }
}
state<DeepShadowArmsShape, never>()({
  initial: 'mid',
  arms: ({ one }) => ({ retry: one({ after: 100 }) }),
  states: {
    mid: {
      initial: 'idle',
      states: {
        idle: {},
        leaf: {
          // @ts-expect-error a deeply nested state cannot shadow a timer name declared by an ancestor
          arms: ({ one }) => ({ retry: one({ after: 100 }) }),
        },
      },
    },
  },
})
