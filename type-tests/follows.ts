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
    // @ts-expect-error a view is followed from fields or for each key, not both at once
    both: follow('shop', 'price', { from: ['currency'], each: 'watching', args: (id) => ({ id }), updated: () => {} }),
    // @ts-expect-error an `each` view is keyed by a field, so `args` cannot return null to skip a key
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
forNet<ListNet>()<{ data: { ids: string[]; rev: number } }, never>()({
  data: { ids: [], rev: 0 },
  follows: (follow) => ({
    list: follow('items', 'list', { from: ['ids'], args: ({ ids }) => ({ ids }), updated: () => {} }),
    allFrom: follow('items', 'all', { from: ['rev'], updated: () => {} }),
    allEach: follow('items', 'all', { each: 'ids', updated: () => {} }),
    // @ts-expect-error `args` is required because `list` expects `{ ids: string[] }`
    missingArgs: follow('items', 'list', { from: ['ids'], updated: () => {} }),
  }),
})
