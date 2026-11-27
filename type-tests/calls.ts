// The writes a state calls: where one may be called, and with which key.
// Compiled by `npm run typecheck`, never run: each `@ts-expect-error` is a line that must not compile, and one that
// compiled would fail the check as an unused directive.

import type * as from from '../checks/calls-check.mts'
declare const state: typeof from.state
type Jobs = from.Jobs
type JobsEvent = from.JobsEvent

// What must not compile.
state<Jobs, JobsEvent>()({
  data: { text: '', saved: null, done: [], heard: [], tries: {}, problem: null },
  initial: 'on',
  on: {
    // @ts-expect-error a save is declared by a state inside, so only a handler there can call it
    SAVE: (_, { call }) => { call('save') },
  },
  states: {
    on: {
      calls: ({ one, each }) => ({
        run: each('worker', 'RUN', { args: (id) => ({ id }), done: () => {} }),
        save: one('worker', 'SAVE', { args: (data) => ({ text: data.text }), done: () => {} }),
      }),
      on: {
        // @ts-expect-error a job is one of many, so calling one takes its key
        ADD: (_, { call }) => { call('run') },
        // @ts-expect-error there is one save at a time, so it takes no key
        STOP_SAVING: (_, { cancel }) => { cancel('save', 'a') },
        // @ts-expect-error it declares no such call
        DROP: (_, { call }) => { call('print') },
      },
    },
    off: {},
  },
})
state<Jobs, JobsEvent>()({
  data: { text: '', saved: null, done: [], heard: [], tries: {}, problem: null },
  initial: 'on',
  states: {
    on: {
      calls: ({ one }) => ({
        // @ts-expect-error a job is one for each of many, so it is declared with `each`
        run: one('worker', 'RUN', { args: () => ({ id: '' }), done: () => {} }),
        // @ts-expect-error what a save answers is a string, so it cannot be put where the list goes
        save: one('worker', 'SAVE', { args: (data) => ({ text: data.text }), done: (outcome) => (outcome.ok ? { data: { done: outcome.value } } : undefined) }),
      }),
    },
    off: {},
  },
})
// @ts-expect-error a state whose shape says it declares calls has to define them
state<Jobs, JobsEvent>()({ data: { text: '', saved: null, done: [], heard: [], tries: {}, problem: null }, initial: 'on', states: { on: {}, off: {} } })

// Typed calls (`one`, `each`, `many`), frozen `scope.input`, optional `args`, and `pending.<many>: number`.
import { forNet, type Value } from '../src/index.ts'
type TypedAsks = {
  PING: { args: {}; answer: string }
  COMMIT: { args: { message: string; amend?: boolean }; progress: string; answer: string }
  STAGE_HUNK: { args: { path: string; hunk: number }; answer: void }
  UPLOAD: { args: { file: string }; answer: string }
}
type TypedNet = { systems: { svc: { events: never; asks: TypedAsks } }; surfaces: {}; views: {} }
const typed = forNet<TypedNet>()

type TypedShape = {
  data: { prefix: string }
  calls: {
    pingOne: 'one'
    pingEach: 'each'
    pingMany: 'many'
    commitDirect: { one: { message: string; amend?: boolean } }
    commitMapped: { one: { msg: string } }
    primOne: { one: string }
    hunk: { each: { hunk: number } }
    uploadDirect: { many: { file: string } }
    uploadMapped: { many: { name: string } }
  }
}
type TypedEvent =
  | { type: 'A' }
  | { type: 'B' }
  | { type: 'C' }
  | { type: 'D' }
  | { type: 'E' }

// Positive check: contextual inference for `input`, `data`, `key`, `scope.input`, and omitted `args`.
typed<TypedShape, TypedEvent>()({
  data: { prefix: '' },
  calls: ({ one, each, many }) => ({
    pingOne: one('svc', 'PING', { done: () => {} }),
    pingEach: each('svc', 'PING', { done: (_o, { key }) => { const _k: string = key; void _k } }),
    pingMany: many('svc', 'PING', { done: () => {} }),
    commitDirect: one('svc', 'COMMIT', {
      progress: (_u, { input }) => { const _m: string = input.message; void _m },
      done: (_o, { input }) => { const _m: string = input.message; void _m },
    }),
    commitMapped: one('svc', 'COMMIT', {
      args: (input, data) => ({ message: input.msg + data.prefix }),
      done: (_o, { input }) => { const _m: string = input.msg; void _m },
    }),
    primOne: one('svc', 'PING', {
      args: () => ({}),
      done: (_o, { input }) => { const _s: string = input; void _s },
    }),
    hunk: each('svc', 'STAGE_HUNK', {
      args: (path, input) => ({ path, hunk: input.hunk }),
      done: (_o, { key, input }) => { const _n: number = input.hunk; const _k: string = key; void _n; void _k },
    }),
    uploadDirect: many('svc', 'UPLOAD', {
      done: (_o, { input }) => { const _f: string = input.file; void _f },
    }),
    uploadMapped: many('svc', 'UPLOAD', {
      args: (input, data) => ({ file: data.prefix + input.name }),
      done: (_o, { input }) => { const _n: string = input.name; void _n },
    }),
  }),
  on: {
    A: (_, { call }) => {
      call('pingOne')
      call('pingEach', 'k')
      call('pingMany')
      call('commitDirect', { message: 'hi' })
      call('hunk', 'a.ts', { hunk: 1 })
      call('uploadDirect', { file: 'x.png' })
    },
    // @ts-expect-error a typed `one` call requires its input argument
    B: (_, { call }) => { call('commitDirect') },
    // @ts-expect-error a typed `each` call requires both key and input
    C: (_, { call }) => { call('hunk', 'a.ts') },
    // @ts-expect-error cancelling a `many` call takes no key (it cancels all in flight)
    D: (_, { cancel }) => { cancel('uploadDirect', 'k') },
    // @ts-expect-error a bare `one` call takes no extra argument
    E: (_, { call }) => { call('pingOne', 'extra') },
  },
})

// Negative checks for `args` omission, cardinality mismatch, and `scope.input` on bare calls.
typed<TypedShape, never>()({
  data: { prefix: '' },
  calls: ({ one, each, many }) => ({
    // @ts-expect-error a bare `one` call has no `input` on scope
    pingOne: one('svc', 'PING', { done: (_o, { input }) => { void input } }),
    pingEach: each('svc', 'PING', { done: () => {} }),
    // @ts-expect-error `pingMany` is declared as `many`, so it must be built with `many`
    pingMany: one('svc', 'PING', { done: () => {} }),
    commitDirect: one('svc', 'COMMIT', { done: () => {} }),
    // @ts-expect-error `args` is required because `{ msg: string }` is not assignable to `{ message: string }`
    commitMapped: one('svc', 'COMMIT', { done: () => {} }),
    // @ts-expect-error `args` is required because a primitive input cannot pass through directly as ask args
    primOne: one('svc', 'PING', { done: () => {} }),
    // @ts-expect-error `args` is required for a typed `each` call
    hunk: each('svc', 'STAGE_HUNK', { done: () => {} }),
    uploadDirect: many('svc', 'UPLOAD', { done: () => {} }),
    // @ts-expect-error `args` is required because `{ name: string }` is not assignable to `{ file: string }`
    uploadMapped: many('svc', 'UPLOAD', { done: () => {} }),
  }),
})

declare const typedValue: Value<TypedShape>
const _manyCount: number = typedValue.pending.uploadDirect
// @ts-expect-error a `many` call exposes its in-flight count (`number`), not a `boolean`
const _wrongManyPending: boolean = typedValue.pending.uploadDirect
void _manyCount; void _wrongManyPending

// Sibling states may share a call name with the same kind (e.g. bare `'one'` and typed `{ one: In }`),
// but conflicting kinds (`one` vs `each`) across states are refused at definition time.
type SameKindCallsShape = {
  states: {
    a: { calls: { save: 'one' } }
    b: { calls: { save: { one: { message: string } } } }
  }
}
typed<SameKindCallsShape, never>()({
  initial: 'a',
  states: {
    a: { calls: ({ one }) => ({ save: one('svc', 'PING', { done: () => {} }) }) },
    b: { calls: ({ one }) => ({ save: one('svc', 'COMMIT', { done: () => {} }) }) },
  },
})
declare const sameKindCallsValue: Value<SameKindCallsShape>
const _sameKindPending: boolean = sameKindCallsValue.pending.save
void _sameKindPending

type ConflictingCallsShape = {
  states: {
    a: { calls: { save: 'one' } }
    b: { calls: { save: 'each' } }
  }
}
typed<ConflictingCallsShape, never>()({
  initial: 'a',
  states: {
    a: {
      // @ts-expect-error a call name cannot be declared with conflicting kinds across states of one machine
      calls: ({ one }) => ({ save: one('svc', 'PING', { done: () => {} }) }),
    },
    b: {
      // @ts-expect-error a call name cannot be declared with conflicting kinds across states of one machine
      calls: ({ each }) => ({ save: each('svc', 'PING', { done: () => {} }) }),
    },
  },
})
