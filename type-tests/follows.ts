// The views a state follows: what can be followed, and what it is followed from.
// Compiled by `npm run typecheck`, never run: each `@ts-expect-error` is a line that must not compile, and one that
// compiled would fail the check as an unused directive.

import type * as from from '../checks/follows-check.mts'
declare const state: typeof from.state
type Shop = from.Shop
type ShopEvent = from.ShopEvent

// What must not compile.
state<Shop, ShopEvent>()({
  data: { currency: '', total: null, watching: [], prices: {}, note: '', problem: null },
  initial: 'browsing',
  follows: (follow) => ({
    // @ts-expect-error there is no such view
    stock: follow('shop', 'stock', { from: [], args: () => ({}), updated: () => {} }),
    // @ts-expect-error the total is asked for a currency, not an id
    total: follow('shop', 'total', { from: ['currency'], args: ({ currency }) => ({ id: currency }), updated: () => {} }),
    // @ts-expect-error a currency is neither a list nor keyed, so it cannot say which prices to follow
    price: follow('shop', 'price', { each: 'currency', args: (id) => ({ id }), updated: () => {} }),
    // @ts-expect-error it reads the note, which it did not name: a field it does not name is not there to read
    noted: follow('shop', 'total', { from: ['currency'], args: ({ note }) => ({ currency: note }), updated: () => {} }),
    // @ts-expect-error the shop has no such field to read from
    missing: follow('shop', 'total', { from: ['locale'], args: () => ({ currency: '' }), updated: () => {} }),
  }),
  states: { browsing: {}, away: {} },
})
state<Shop, ShopEvent>()({
  data: { currency: '', total: null, watching: [], prices: {}, note: '', problem: null },
  initial: 'browsing',
  follows: (follow) => ({
    // @ts-expect-error a price is a number, so it cannot be put where the note goes
    price: follow('shop', 'price', { each: 'watching', args: (id) => ({ id }), updated: (update) => (update.ok ? { data: { note: update.value } } : undefined) }),
    // One for each key, each followed again when a field it names changes: the key comes first, typed, and then those fields.
    both: follow('shop', 'price', { from: ['currency'], each: 'watching', args: (id, { currency }) => ({ id: `${id} in ${currency.toLowerCase()}` }), updated: (_, { key }) => { key.toUpperCase() } }),
    // @ts-expect-error one for each key is followed again from fields the shop has, and it has no locale
    eachMissing: follow('shop', 'price', { each: 'watching', from: ['locale'], args: (id) => ({ id }), updated: () => {} }),
    // @ts-expect-error one for each key reads the note, which it did not name
    eachUnnamed: follow('shop', 'price', { each: 'watching', from: ['currency'], args: (id, { note }) => ({ id: id + note }), updated: () => {} }),
    // @ts-expect-error one for each key that names no fields is given its key alone
    eachAlone: follow('shop', 'price', { each: 'watching', args: (id, from) => ({ id: id + Object.keys(from).length }), updated: () => {} }),
    // @ts-expect-error one for each key of a field is not also followed again from that same field
    eachTwice: follow('shop', 'price', { each: 'watching', from: ['watching'], args: (id) => ({ id }), updated: () => {} }),
    // A key there is nothing to follow for is skipped as a single view is: `args` returns nothing.
    skippableBoth: follow('shop', 'price', { each: 'watching', from: ['currency'], args: (id) => (id ? { id } : null), updated: () => {} }),
    skippableEach: follow('shop', 'price', { each: 'watching', args: (id) => (id ? { id } : null), updated: () => {} }),
  }),
  states: { browsing: {}, away: {} },
})

// Conditional `follows` with `from` accepts `null | undefined | false`.
state<Shop, ShopEvent>()({
  data: { currency: '', total: null, watching: [], prices: {}, note: '', problem: null },
  initial: 'browsing',
  follows: (follow) => ({
    maybe: follow('shop', 'total', { from: ['currency'], args: ({ currency }) => (currency ? { currency } : null), updated: () => {} }),
  }),
  states: { browsing: {}, away: {} },
})

// `args` accepts read-only values straight from `data`, and `follows` may omit `args` for `{}` views.
import { forNet } from '../src/index.ts'
type ListNet = {
  systems: {}
  surfaces: {}
  views: { items: { list: { args: { ids: string[] }; result: number }; all: { args: {}; result: number } } }
}
declare const worked: readonly 'ids'[]
declare const some: boolean
declare const untypedFrom: any
declare const heldRev: readonly 'rev'[]
declare const maybeRev: readonly 'rev'[] | undefined
// Options held in a constant of a type written out, one of them left out.
declare const heldOptions: { each: 'ids'; args?: (id: string) => { ids: string[] }; updated: () => void }
declare const heldOptionsFrom: { each: 'ids'; from: readonly 'rev'[]; args?: (id: string, from: { readonly rev: number }) => { ids: string[] }; updated: () => void }
declare const heldOptionsMaybeFrom: { each: 'ids'; from?: readonly 'rev'[]; args: (id: string, from: { readonly rev: number } | undefined) => { ids: string[] }; updated: () => void }
declare const heldOptionsMaybeFromRead: { each: 'ids'; from?: readonly 'rev'[]; args: (id: string, from: { readonly rev: number }) => { ids: string[] }; updated: () => void }
declare const heldOptionsUnkeyed: { from: readonly 'rev'[]; args?: (from: { readonly rev: number }) => { ids: string[] }; updated: () => void }
forNet<ListNet>()<{ data: { ids: string[]; rev: number } }, never>()({
  data: { ids: [], rev: 0 },
  follows: (follow) => ({
    list: follow('items', 'list', { from: ['ids'], args: ({ ids }) => ({ ids }), updated: () => {} }),
    allFrom: follow('items', 'all', { from: ['rev'], updated: () => {} }),
    allEach: follow('items', 'all', { each: 'ids', updated: () => {} }),
    // @ts-expect-error `args` is required because `list` expects `{ ids: string[] }`
    missingArgs: follow('items', 'list', { from: ['ids'], updated: () => {} }),
    // One for each key that says it names fields, and names none, is given its key and then none of them: an empty object.
    eachNone: follow('items', 'list', { each: 'ids', from: [], args: (id, from) => ({ ids: [id, ...Object.keys(from)] }), updated: () => {} }),
    // @ts-expect-error one for each key that names none of its fields has none of them to read
    eachNoneRead: follow('items', 'list', { each: 'ids', from: [], args: (id, { rev }) => ({ ids: [id, String(rev)] }), updated: () => {} }),
    // @ts-expect-error given its type arguments outright, one for each key is still not given the field its keys come from
    eachOutright: follow<'items', 'list', 'rev' | 'ids', 'ids'>('items', 'list', { each: 'ids', from: ['rev'], args: (id, { ids }) => ({ ids: [id, ...ids] }), updated: () => {} }),
    eachOutrightNamed: follow<'items', 'list', 'rev' | 'ids', 'ids'>('items', 'list', { each: 'ids', from: ['rev'], args: (id, { rev }) => ({ ids: [id, rev.toFixed()] }), updated: () => {} }),
    // @ts-expect-error a view has no such option, with fields named or with none
    eachMisspelt: follow('items', 'all', { each: 'ids', from: [], udpated: () => {}, updated: () => {} }),
    // @ts-expect-error one for each key of a field is not also followed again from that field, where the fields it names are worked out
    eachTwiceWorkedOut: follow('items', 'list', { each: 'ids', from: worked, args: (id) => ({ ids: [id] }), updated: () => {} }),
    // A `from` written as `undefined` is no `from`: one for each key is given its key alone.
    eachUndefined: follow('items', 'list', { each: 'ids', from: undefined, args: (id) => ({ ids: [id] }), updated: () => {} }),
    // @ts-expect-error one for each key whose `from` is `undefined` names no fields, and is given its key alone
    eachUndefinedRead: follow('items', 'list', { each: 'ids', from: undefined, args: (id, from) => ({ ids: [id, ...Object.keys(from)] }), updated: () => {} }),
    // A `from` that may be `undefined` gives the fields it names where it is there, and `undefined` where it is not.
    eachMaybe: follow('items', 'list', { each: 'ids', from: some ? ['rev'] : undefined, args: (id, from) => ({ ids: [id, from === undefined ? '' : from.rev.toFixed()] }), updated: () => {} }),
    eachMaybeAlone: follow('items', 'list', { each: 'ids', from: some ? ['rev'] : undefined, args: (id) => ({ ids: [id] }), updated: () => {} }),
    // @ts-expect-error one for each key whose `from` may be `undefined` may be given no fields, so they are not read unasked
    eachMaybeRead: follow('items', 'list', { each: 'ids', from: some ? ['rev'] : undefined, args: (id, { rev }) => ({ ids: [id, rev.toFixed()] }), updated: () => {} }),
    // @ts-expect-error fields that may not be there are not read as though they were
    eachMaybeUnasked: follow('items', 'list', { each: 'ids', from: some ? ['rev'] : undefined, args: (id, from) => ({ ids: [id, from.rev.toFixed()] }), updated: () => {} }),
    // The fields named are held in a constant: it is given its key and then those fields.
    eachHeld: follow('items', 'list', { each: 'ids', from: heldRev, args: (id, { rev }) => ({ ids: [id, rev.toFixed()] }), updated: () => {} }),
    eachMaybeHeld: follow('items', 'list', { each: 'ids', from: maybeRev, args: (id, from) => ({ ids: [id, from ? from.rev.toFixed() : ''] }), updated: () => {} }),
    // @ts-expect-error fields named in a constant that may be `undefined` may not be given
    eachMaybeHeldRead: follow('items', 'list', { each: 'ids', from: maybeRev, args: (id, { rev }) => ({ ids: [id, rev.toFixed()] }), updated: () => {} }),
    // @ts-expect-error a constant that may be `undefined` is held to the fields the state has all the same
    eachMaybeMissing: follow('items', 'list', { each: 'ids', from: some ? ['revision'] : undefined, args: (id) => ({ ids: [id] }), updated: () => {} }),
    // @ts-expect-error one for each key of a field is not followed again from that field, where that may be `undefined` too
    eachMaybeTwice: follow('items', 'list', { each: 'ids', from: some ? ['ids'] : undefined, args: (id) => ({ ids: [id] }), updated: () => {} }),
    // A `from` of type `any` says nothing of there being fields, so one for each key is typed as given its key alone.
    eachUntyped: follow('items', 'list', { each: 'ids', from: untypedFrom, args: (id) => ({ ids: [id] }), updated: () => {} }),
    // @ts-expect-error a `from` of type `any` does not say there are fields, so none are read
    eachUntypedRead: follow('items', 'list', { each: 'ids', from: untypedFrom, args: (id, { rev }) => ({ ids: [id, String(rev)] }), updated: () => {} }),
    // Fields named as a tuple that cannot be written to are named all the same.
    eachFixed: follow('items', 'list', { each: 'ids', from: ['rev'] as const, args: (id, { rev }) => ({ ids: [id, rev.toFixed()] }), updated: () => {} }),
    // Options held in a constant are taken as they are typed, what they leave out included.
    eachOptions: follow('items', 'all', heldOptions),
    eachOptionsFrom: follow('items', 'all', heldOptionsFrom),
    eachOptionsMaybeFrom: follow('items', 'list', heldOptionsMaybeFrom),
    // @ts-expect-error options whose `from` may be left out have an `args` that may be given no fields
    eachOptionsMaybeFromRead: follow('items', 'list', heldOptionsMaybeFromRead),
    options: follow('items', 'all', heldOptionsUnkeyed),
    // Given its type arguments outright, one for each key with no fields to name is given its key alone.
    eachOutrightAlone: follow<'items', 'list', never, 'ids'>('items', 'list', { each: 'ids', args: (id) => ({ ids: [id] }), updated: () => {} }),
    // @ts-expect-error given its type arguments outright with no fields to name, it has none to be given
    eachOutrightAloneRead: follow<'items', 'list', never, 'ids'>('items', 'list', { each: 'ids', args: (id, from) => ({ ids: [id, ...Object.keys(from)] }), updated: () => {} }),
    // @ts-expect-error given the fields it names outright, it is written with them: a `from` of `undefined` would be given none
    eachOutrightUndefined: follow<'items', 'list', 'rev', 'ids'>('items', 'list', { each: 'ids', from: undefined, args: (id, { rev }) => ({ ids: [id, rev.toFixed()] }), updated: () => {} }),
    outright: follow<'items', 'list', 'ids'>('items', 'list', { from: ['ids'], args: ({ ids }) => ({ ids }), updated: () => {} }),
    // One followed from fields alone is given an object whatever its `from`: with none, an empty one.
    undefinedFrom: follow('items', 'list', { from: undefined, args: (from) => ({ ids: Object.keys(from) }), updated: () => {} }),
    noFrom: follow('items', 'list', { args: (from) => ({ ids: Object.keys(from) }), updated: () => {} }),
    held: follow('items', 'list', { from: heldRev, args: ({ rev }) => ({ ids: [rev.toFixed()] }), updated: () => {} }),
    maybe: follow('items', 'list', { from: some ? ['rev'] : undefined, args: ({ rev }) => ({ ids: [rev === undefined ? '' : rev.toFixed()] }), updated: () => {} }),
    // @ts-expect-error fields whose `from` may be `undefined` may each not be there
    maybeRead: follow('items', 'list', { from: some ? ['rev'] : undefined, args: ({ rev }) => ({ ids: [rev.toFixed()] }), updated: () => {} }),
  }),
})
