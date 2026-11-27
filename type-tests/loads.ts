// The reads a state loads: what can be asked, and what it is asked from.
// Compiled by `npm run typecheck`, never run: each `@ts-expect-error` is a line that must not compile, and one that
// compiled would fail the check as an unused directive.

import type * as from from '../checks/loads-check.mts'
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
    // @ts-expect-error one for each key is read again from fields the state has, and it has no revision
    eachMissing: load('library', 'LOOKUP', { each: 'watched', from: ['revision'], args: (id) => ({ query: id }), done: () => {} }),
    // @ts-expect-error one for each key reads the title, which it did not name
    eachUnnamed: load('library', 'LOOKUP', { each: 'watched', from: ['again'], args: (id, { title }) => ({ query: `${id} ${title}` }), done: () => {} }),
    // @ts-expect-error one for each key that names no fields is given its key alone
    eachAlone: load('library', 'LOOKUP', { each: 'watched', args: (id, from) => ({ query: `${id} ${Object.keys(from).length}` }), done: () => {} }),
    // @ts-expect-error one for each key of a field is not also read again from that same field
    eachTwice: load('library', 'LOOKUP', { each: 'watched', from: ['watched'], args: (id) => ({ query: id }), done: () => {} }),
    // @ts-expect-error one for each key is given its key first, which is a string, and the fields it named after it
    eachKeyless: load('library', 'LOOKUP', { each: 'watched', from: ['again'], args: ({ again }) => ({ query: String(again) }), done: () => {} }),
    // @ts-expect-error one read from fields alone is not one of many, so how it ended has no key
    unkeyed: load('library', 'LOOKUP', { from: ['query'], args: ({ query }) => ({ query }), done: (_, { key }) => { void key } }),
  }),
  states: { on: {}, off: {} },
})

// `args` in `loads` and `calls` accepts read-only values straight from `data`, and `loads` may omit `args` for `{}` asks.
import { forNet } from '../src/index.ts'
type BatchNet = {
  systems: { svc: { events: never; asks: { BATCH: { args: { ids: string[] }; answer: number }; PING: { args: {}; answer: string } } } }
  surfaces: {}
  views: {}
}
forNet<BatchNet>()<{ data: { ids: string[]; rev: number }; calls: { run: 'one'; each: 'each' } }, never>()({
  data: { ids: [], rev: 0 },
  loads: (load) => ({
    batch: load('svc', 'BATCH', { from: ['ids'], args: ({ ids }) => ({ ids }), done: () => {} }),
    pingFrom: load('svc', 'PING', { from: ['rev'], done: () => {} }),
    pingEach: load('svc', 'PING', { each: 'ids', done: () => {} }),
    // One for each key, each read again when a field it names changes: the key comes first, typed, and then those fields.
    batchEach: load('svc', 'BATCH', { each: 'ids', from: ['rev'], args: (id, { rev }) => ({ ids: [id, rev.toFixed()] }), done: (_, { key }) => { key.toUpperCase() } }),
    pingEachFrom: load('svc', 'PING', { each: 'ids', from: ['rev'], done: () => {} }),
    // @ts-expect-error `args` is required because BATCH expects `{ ids: string[] }`
    missingArgs: load('svc', 'BATCH', { from: ['ids'], done: () => {} }),
  }),
  calls: ({ one, each }) => ({
    run: one('svc', 'BATCH', { args: (data) => ({ ids: data.ids }), done: () => {} }),
    each: each('svc', 'BATCH', { args: (_key, data) => ({ ids: data.ids }), done: () => {} }),
  }),
})
