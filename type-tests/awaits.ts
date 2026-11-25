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
  start: 'on',
  awaits: (asking) => ({
    // @ts-expect-error there is no such system to ask
    nobody: asking('printer', 'LOOKUP', { args: () => ({ query: '' }), ended: () => {} }),
    // @ts-expect-error the library answers no such ask
    nothing: asking('library', 'SLEEP', { args: () => ({}), ended: () => {} }),
    // @ts-expect-error a lookup is asked for a query, not an id
    wrong: asking('library', 'LOOKUP', { each: 'watched', args: (id) => ({ id }), ended: () => {} }),
    // @ts-expect-error a title is neither a list nor keyed, so it cannot say which to look up
    titled: asking('library', 'LOOKUP', { each: 'title', args: (id) => ({ query: id }), ended: () => {} }),
    // @ts-expect-error it reads the title, which it did not name
    unnamed: asking('library', 'LOOKUP', { from: ['query'], args: ({ title }) => ({ query: title }), ended: () => {} }),
    // @ts-expect-error what a lookup answers is a string, so it cannot be put where the list goes
    misplaced: asking('library', 'LOOKUP', { from: ['query'], args: ({ query }) => ({ query }), ended: (outcome) => (outcome.ok ? { data: { watched: outcome.value } } : undefined) }),
    // @ts-expect-error an ask is awaited from fields or for each key, not both at once
    both: asking('library', 'LOOKUP', { from: ['query'], each: 'watched', args: (id) => ({ query: id }), ended: () => {} }),
  }),
  states: { on: {}, off: {} },
})

// `args` in `awaits` and `makes` accepts read-only values straight from `data`.
import { reaching } from '../src/index.ts'
type BatchNet = { systems: { svc: { events: never; asks: { BATCH: { args: { ids: string[] }; answer: number } } } }; surfaces: {}; views: {} }
reaching<BatchNet>()<{ data: { ids: string[] }; makes: { run: 'one'; each: 'each' } }, never>()({
  data: { ids: [] },
  awaits: (asking) => ({
    batch: asking('svc', 'BATCH', { from: ['ids'], args: ({ ids }) => ({ ids }), ended: () => {} }),
  }),
  makes: ({ one, each }) => ({
    run: one('svc', 'BATCH', { args: (data) => ({ ids: data.ids }), ended: () => {} }),
    each: each('svc', 'BATCH', { args: (_key, data) => ({ ids: data.ids }), ended: () => {} }),
  }),
})
