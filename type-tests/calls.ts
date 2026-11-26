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
