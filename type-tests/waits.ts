// The timers a state waits on: where one may be armed or disarmed, its duration, and its waiting record.
// Compiled by `npm run typecheck`, never run: each `@ts-expect-error` is a line that must not compile, and one that
// compiled would fail the check as an unused directive.

import { state, type Value } from '../src/index.ts'

type TimersShape = {
  data: { count: number; lastKey: string | null }
  waits: {
    pulse: 'one'
    backoff: { one: 'ms' }
    readonly fixedReadonly: { readonly one: 'ms' }
    flash: 'each'
    retry: { each: 'ms' }
    readonly retryReadonly: { readonly each: 'ms' }
  }
  states: {
    idle: {}
    active: {
      waits: { inner: 'one' }
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

// Positive check: fixed-ms, runtime-ms (mutable and readonly), pure-TTL (no done), direct done, options object, and nested waits.
state<TimersShape, TimersEvent>()({
  data: { count: 0, lastKey: null },
  initial: 'idle',
  waits: ({ one, each }) => ({
    pulse: one(300),
    backoff: one(({ data }) => ({ data: { count: data.count + 1 } })),
    fixedReadonly: one({ reset: false, done: () => ({ at: 'idle' }) }),
    flash: each(500, ({ key, data }) => ({ data: { lastKey: key, count: data.count + 1 } })),
    retry: each({ reset: false, done: ({ key }) => ({ data: { lastKey: key } }) }),
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
    // @ts-expect-error an inner wait is declared by a state inside, so only a handler there can arm it
    BAD_1: (_, { arm }) => { arm('inner') },
    // @ts-expect-error a runtime-ms `one` wait requires `ms` when armed
    BAD_2: (_, { arm }) => { arm('backoff') },
    // @ts-expect-error a fixed-ms `one` wait takes no extra payload argument beyond optional `ms`
    BAD_3: (_, { arm }) => { arm('pulse', 100, { payload: true }) },
    // @ts-expect-error an `each` wait requires its key
    BAD_4: (_, { arm }) => { arm('flash') },
    // @ts-expect-error a runtime-ms `each` wait requires both key and `ms`
    BAD_5: (_, { arm }) => { arm('retry', 'k1') },
    // @ts-expect-error an `each` wait takes no extra payload argument beyond key and `ms`
    BAD_6: (_, { arm }) => { arm('flash', 'k1', 100, { payload: true }) },
    // @ts-expect-error a `one` wait takes no key when disarmed
    BAD_7: (_, { disarm }) => { disarm('pulse', 'k1') },
    // @ts-expect-error it declares no such wait
    BAD_8: (_, { arm }) => { arm('unknown') },
    // @ts-expect-error a runtime-ms `one` wait takes no extra payload argument
    BAD_9: (_, { arm }) => { arm('backoff', 250, 'extra') },
  },
  states: {
    idle: {},
    active: {
      waits: ({ one }) => ({
        inner: one(100, { reset: true, done: () => ({ at: 'idle' }) }),
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

// Negative checks for Def.waits declarations.
// @ts-expect-error a state whose shape declares waits has to define them
state<{ waits: { pulse: 'one' } }>()({})

state<{ data: { n: number }; waits: { fixed: 'one'; dynamic: { one: 'ms' }; keyed: 'each'; dynKeyed: { each: 'ms' } } }>()({
  data: { n: 0 },
  waits: ({ one }) => ({
    // @ts-expect-error a fixed-ms `'one'` wait requires a default `ms`
    fixed: one(),
    // @ts-expect-error a runtime-ms `{ one: 'ms' }` wait does not accept a default `ms`
    dynamic: one(100),
    // @ts-expect-error an `'each'` wait must be built with `each`, not `one`
    keyed: one(100),
    // @ts-expect-error a `{ each: 'ms' }` wait must be built with `each`, not `one`
    dynKeyed: one(),
  }),
})

state<{ data: { n: number }; waits: { badDone: 'one'; badEachDone: 'each' } }>()({
  data: { n: 0 },
  waits: ({ one, each }) => ({
    // @ts-expect-error a `one` wait's `done` return value is checked against the state's data
    badDone: one(100, () => ({ data: { n: 'wrong' } })),
    // @ts-expect-error an `each` wait's `done` return value is checked against the state's data
    badEachDone: each(100, { done: () => ({ data: { n: 'wrong' } }) }),
  }),
})

state<{ data: { n: number } }>()({
  data: { n: 0 },
  // @ts-expect-error a state whose shape declares no waits cannot define `waits`
  waits: () => ({}),
})

// Value<S> waiting narrowing and absence when no waits are declared.
declare const timersValue: Value<TimersShape>
const _pulse: boolean = timersValue.waiting.pulse
const _backoff: boolean = timersValue.waiting.backoff
const _inner: boolean = timersValue.waiting.inner
const _flash: Readonly<Record<string, true>> = timersValue.waiting.flash
const _retry: Readonly<Record<string, true>> = timersValue.waiting.retry
// @ts-expect-error a `one` wait exposes `boolean` on `waiting`, not a record
const _badOne: Readonly<Record<string, true>> = timersValue.waiting.pulse
// @ts-expect-error an `each` wait exposes `Readonly<Record<string, true>>` on `waiting`, not a `boolean`
const _badEach: boolean = timersValue.waiting.flash
// @ts-expect-error `waiting` is read-only and cannot be mutated
timersValue.waiting.pulse = true
void _pulse; void _backoff; void _inner; void _flash; void _retry; void _badOne; void _badEach

declare const plainValue: Value<{ data: { n: number } }>
// @ts-expect-error a state with no declared waits has no `waiting` property on its value
void plainValue.waiting
