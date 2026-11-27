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
declare const worked: readonly 'ids'[]
declare const some: boolean
declare const untypedFrom: any
declare const heldRev: readonly 'rev'[]
declare const maybeRev: readonly 'rev'[] | undefined
// Options held in a constant of a type written out, one of them left out.
declare const heldOptions: { each: 'ids'; args: (id: string) => { ids: string[] }; done: () => void; progress?: () => void }
declare const heldOptionsFrom: { each: 'ids'; from: readonly 'rev'[]; args: (id: string, from: { readonly rev: number }) => { ids: string[] }; done: () => void; progress?: () => void }
declare const heldOptionsMaybeFrom: { each: 'ids'; from?: readonly 'rev'[]; args: (id: string, from: { readonly rev: number } | undefined) => { ids: string[] }; done: () => void }
declare const heldOptionsMaybeFromRead: { each: 'ids'; from?: readonly 'rev'[]; args: (id: string, from: { readonly rev: number }) => { ids: string[] }; done: () => void }
declare const heldOptionsUnkeyed: { from: readonly 'rev'[]; args: (from: { readonly rev: number }) => { ids: string[] }; done: () => void; progress?: () => void }
forNet<BatchNet>()<{ data: { ids: string[]; rev: number }; calls: { run: 'single'; each: 'each' } }, never>()({
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
    // One for each key that says it names fields, and names none, is given its key and then none of them: an empty object.
    eachNone: load('svc', 'BATCH', { each: 'ids', from: [], args: (id, from) => ({ ids: [id, ...Object.keys(from)] }), done: () => {} }),
    // @ts-expect-error one for each key that names none of its fields has none of them to read
    eachNoneRead: load('svc', 'BATCH', { each: 'ids', from: [], args: (id, { rev }) => ({ ids: [id, String(rev)] }), done: () => {} }),
    // @ts-expect-error given its type arguments outright, one for each key is still not given the field its keys come from
    eachOutright: load<'svc', 'BATCH', 'rev' | 'ids', 'ids'>('svc', 'BATCH', { each: 'ids', from: ['rev'], args: (id, { ids }) => ({ ids: [id, ...ids] }), done: () => {} }),
    eachOutrightNamed: load<'svc', 'BATCH', 'rev' | 'ids', 'ids'>('svc', 'BATCH', { each: 'ids', from: ['rev'], args: (id, { rev }) => ({ ids: [id, rev.toFixed()] }), done: () => {} }),
    // @ts-expect-error a read has no such option, with fields named or with none
    eachMisspelt: load('svc', 'PING', { each: 'ids', from: [], dnoe: () => {}, done: () => {} }),
    // @ts-expect-error one for each key of a field is not also read again from that field, where the fields it names are worked out
    eachTwiceWorkedOut: load('svc', 'BATCH', { each: 'ids', from: worked, args: (id) => ({ ids: [id] }), done: () => {} }),
    // A `from` written as `undefined` is no `from`: one for each key is given its key alone.
    eachUndefined: load('svc', 'BATCH', { each: 'ids', from: undefined, args: (id) => ({ ids: [id] }), done: () => {} }),
    // @ts-expect-error one for each key whose `from` is `undefined` names no fields, and is given its key alone
    eachUndefinedRead: load('svc', 'BATCH', { each: 'ids', from: undefined, args: (id, from) => ({ ids: [id, ...Object.keys(from)] }), done: () => {} }),
    // A `from` that may be `undefined` gives the fields it names where it is there, and `undefined` where it is not.
    eachMaybe: load('svc', 'BATCH', { each: 'ids', from: some ? ['rev'] : undefined, args: (id, from) => ({ ids: [id, from === undefined ? '' : from.rev.toFixed()] }), done: () => {} }),
    eachMaybeAlone: load('svc', 'BATCH', { each: 'ids', from: some ? ['rev'] : undefined, args: (id) => ({ ids: [id] }), done: () => {} }),
    // @ts-expect-error one for each key whose `from` may be `undefined` may be given no fields, so they are not read unasked
    eachMaybeRead: load('svc', 'BATCH', { each: 'ids', from: some ? ['rev'] : undefined, args: (id, { rev }) => ({ ids: [id, rev.toFixed()] }), done: () => {} }),
    // @ts-expect-error fields that may not be there are not read as though they were
    eachMaybeUnasked: load('svc', 'BATCH', { each: 'ids', from: some ? ['rev'] : undefined, args: (id, from) => ({ ids: [id, from.rev.toFixed()] }), done: () => {} }),
    // The fields named are held in a constant: it is given its key and then those fields.
    eachHeld: load('svc', 'BATCH', { each: 'ids', from: heldRev, args: (id, { rev }) => ({ ids: [id, rev.toFixed()] }), done: () => {} }),
    eachMaybeHeld: load('svc', 'BATCH', { each: 'ids', from: maybeRev, args: (id, from) => ({ ids: [id, from ? from.rev.toFixed() : ''] }), done: () => {} }),
    // @ts-expect-error fields named in a constant that may be `undefined` may not be given
    eachMaybeHeldRead: load('svc', 'BATCH', { each: 'ids', from: maybeRev, args: (id, { rev }) => ({ ids: [id, rev.toFixed()] }), done: () => {} }),
    // @ts-expect-error a constant that may be `undefined` is held to the fields the state has all the same
    eachMaybeMissing: load('svc', 'BATCH', { each: 'ids', from: some ? ['revision'] : undefined, args: (id) => ({ ids: [id] }), done: () => {} }),
    // @ts-expect-error one for each key of a field is not read again from that field, where that may be `undefined` too
    eachMaybeTwice: load('svc', 'BATCH', { each: 'ids', from: some ? ['ids'] : undefined, args: (id) => ({ ids: [id] }), done: () => {} }),
    // A `from` of type `any` says nothing of there being fields, so one for each key is typed as given its key alone.
    eachUntyped: load('svc', 'BATCH', { each: 'ids', from: untypedFrom, args: (id) => ({ ids: [id] }), done: () => {} }),
    // @ts-expect-error a `from` of type `any` does not say there are fields, so none are read
    eachUntypedRead: load('svc', 'BATCH', { each: 'ids', from: untypedFrom, args: (id, { rev }) => ({ ids: [id, String(rev)] }), done: () => {} }),
    // Fields named as a tuple that cannot be written to are named all the same.
    eachFixed: load('svc', 'BATCH', { each: 'ids', from: ['rev'] as const, args: (id, { rev }) => ({ ids: [id, rev.toFixed()] }), done: () => {} }),
    // Options held in a constant are taken as they are typed, what they leave out included.
    eachOptions: load('svc', 'BATCH', heldOptions),
    eachOptionsFrom: load('svc', 'BATCH', heldOptionsFrom),
    eachOptionsMaybeFrom: load('svc', 'BATCH', heldOptionsMaybeFrom),
    // @ts-expect-error options whose `from` may be left out have an `args` that may be given no fields
    eachOptionsMaybeFromRead: load('svc', 'BATCH', heldOptionsMaybeFromRead),
    options: load('svc', 'BATCH', heldOptionsUnkeyed),
    // Given its type arguments outright, one for each key with no fields to name is given its key alone.
    eachOutrightAlone: load<'svc', 'BATCH', never, 'ids'>('svc', 'BATCH', { each: 'ids', args: (id) => ({ ids: [id] }), done: () => {} }),
    // @ts-expect-error given its type arguments outright with no fields to name, it has none to be given
    eachOutrightAloneRead: load<'svc', 'BATCH', never, 'ids'>('svc', 'BATCH', { each: 'ids', args: (id, from) => ({ ids: [id, ...Object.keys(from)] }), done: () => {} }),
    // @ts-expect-error given the fields it names outright, it is written with them: a `from` of `undefined` would be given none
    eachOutrightUndefined: load<'svc', 'BATCH', 'rev', 'ids'>('svc', 'BATCH', { each: 'ids', from: undefined, args: (id, { rev }) => ({ ids: [id, rev.toFixed()] }), done: () => {} }),
    outright: load<'svc', 'BATCH', 'ids'>('svc', 'BATCH', { from: ['ids'], args: ({ ids }) => ({ ids }), done: () => {} }),
    // One read from fields alone is given an object whatever its `from`: with none, an empty one.
    undefinedFrom: load('svc', 'BATCH', { from: undefined, args: (from) => ({ ids: Object.keys(from) }), done: () => {} }),
    noFrom: load('svc', 'BATCH', { args: (from) => ({ ids: Object.keys(from) }), done: () => {} }),
    held: load('svc', 'BATCH', { from: heldRev, args: ({ rev }) => ({ ids: [rev.toFixed()] }), done: () => {} }),
    maybe: load('svc', 'BATCH', { from: some ? ['rev'] : undefined, args: ({ rev }) => ({ ids: [rev === undefined ? '' : rev.toFixed()] }), done: () => {} }),
    // @ts-expect-error fields whose `from` may be `undefined` may each not be there
    maybeRead: load('svc', 'BATCH', { from: some ? ['rev'] : undefined, args: ({ rev }) => ({ ids: [rev.toFixed()] }), done: () => {} }),
  }),
  calls: ({ single, each }) => ({
    run: single('svc', 'BATCH', { args: (data) => ({ ids: data.ids }), done: () => {} }),
    each: each('svc', 'BATCH', { args: (_key, data) => ({ ids: data.ids }), done: () => {} }),
  }),
})
