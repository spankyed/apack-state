// The reads a state awaits: what can be asked, and what it is asked from.
// Compiled by `npm run typecheck`, never run: each `@ts-expect-error` is a line that must not compile, and one that
// compiled would fail the check as an unused directive.

import type * as from from '../checks/awaits-check.mts'
declare const state: typeof from.state
type Reader = from.Reader
type ReaderEvent = from.ReaderEvent

// What must not compile.
state<Reader, ReaderEvent>()({
  data: { title: '', query: '', again: 0, found: null, heard: [], watched: [], labels: {}, circling: 0, problem: null, pending: '', got: null },
  initial: 'on',
  loads: (load) => ({
    // @ts-expect-error there is no such system to ask
    nobody: load('printer', 'LOOKUP', { args: () => ({ query: '' }), done: () => {} }),
    // @ts-expect-error the library answers no such ask
    nothing: load('library', 'SLEEP', { args: () => ({}), done: () => {} }),
    // @ts-expect-error a lookup is asked for a query, not an id
    wrong: load('library', 'LOOKUP', { each: 'watched', args: (id) => ({ id }), done: () => {} }),
    // @ts-expect-error a title is neither a list nor keyed, so it cannot say which to look up
    titled: load('library', 'LOOKUP', { each: 'title', args: (id) => ({ query: id }), done: () => {} }),
    // @ts-expect-error it reads the title, which it did not name
    unnamed: load('library', 'LOOKUP', { from: ['query'], args: ({ title }) => ({ query: title }), done: () => {} }),
    // @ts-expect-error what a lookup answers is a string, so it cannot be put where the list goes
    misplaced: load('library', 'LOOKUP', { from: ['query'], args: ({ query }) => ({ query }), done: (outcome) => (outcome.ok ? { data: { watched: outcome.value } } : undefined) }),
    // @ts-expect-error an ask is awaited from fields or for each key, not both at once
    both: load('library', 'LOOKUP', { from: ['query'], each: 'watched', args: (id) => ({ query: id }), done: () => {} }),
  }),
  states: { on: {}, off: {} },
})

// `args` in `awaits` and `makes` accepts read-only values straight from `data`.
import { forNet } from '../src/index.ts'
type BatchNet = { systems: { svc: { events: never; asks: { BATCH: { args: { ids: string[] }; answer: number } } } }; surfaces: {}; views: {} }
forNet<BatchNet>()<{ data: { ids: string[] }; makes: { run: 'one'; each: 'each' } }, never>()({
  data: { ids: [] },
  loads: (load) => ({
    batch: load('svc', 'BATCH', { from: ['ids'], args: ({ ids }) => ({ ids }), done: () => {} }),
  }),
  makes: ({ one, each }) => ({
    run: one('svc', 'BATCH', { args: (data) => ({ ids: data.ids }), done: () => {} }),
    each: each('svc', 'BATCH', { args: (_key, data) => ({ ids: data.ids }), done: () => {} }),
  }),
})
