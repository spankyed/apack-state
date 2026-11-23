// The writes a state makes: where one may be said, and with which key.
// Compiled by `npm run typecheck`, never run: each `@ts-expect-error` is a line that must not compile, and one that
// compiled would fail the check as an unused directive.

import type * as from from '../checks/makes-check.mts'
declare const state: typeof from.state
type Jobs = from.Jobs
type JobsEvent = from.JobsEvent

// What must not compile.
state<Jobs, JobsEvent>()({
  data: { text: '', saved: null, done: [], heard: [], tries: {}, problem: null },
  start: 'on',
  on: {
    // @ts-expect-error a save is made by a state inside, so only a handler there can say to make one
    SAVE: (_, { make }) => { make('save') },
  },
  states: {
    on: {
      makes: ({ one, each }) => ({
        run: each('worker', 'RUN', { args: (id) => ({ id }), ended: () => {} }),
        save: one('worker', 'SAVE', { args: (data) => ({ text: data.text }), ended: () => {} }),
      }),
      on: {
        // @ts-expect-error a job is one of many, so making one takes its key
        ADD: (_, { make }) => { make('run') },
        // @ts-expect-error there is one save at a time, so it takes no key
        STOP_SAVING: (_, { drop }) => { drop('save', 'a') },
        // @ts-expect-error it makes no such thing
        DROP: (_, { make }) => { make('print') },
      },
    },
    off: {},
  },
})
state<Jobs, JobsEvent>()({
  data: { text: '', saved: null, done: [], heard: [], tries: {}, problem: null },
  start: 'on',
  states: {
    on: {
      makes: ({ one, each }) => ({
        // @ts-expect-error a job is one for each of many, so it is made with `each`
        run: one('worker', 'RUN', { args: () => ({ id: '' }), ended: () => {} }),
        // @ts-expect-error what a save answers is a string, so it cannot be put where the list goes
        save: one('worker', 'SAVE', { args: (data) => ({ text: data.text }), ended: (outcome) => (outcome.ok ? { data: { done: outcome.value } } : undefined) }),
      }),
    },
    off: {},
  },
})
// @ts-expect-error a state whose shape says it makes these has to say how
state<Jobs, JobsEvent>()({ data: { text: '', saved: null, done: [], heard: [], tries: {}, problem: null }, start: 'on', states: { on: {}, off: {} } })
