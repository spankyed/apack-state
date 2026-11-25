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
    stock: follow('shop', 'stock', { from: [], args: () => ({}), heard: () => {} }),
    // @ts-expect-error the total is asked for a currency, not an id
    total: follow('shop', 'total', { from: ['currency'], args: ({ currency }) => ({ id: currency }), heard: () => {} }),
    // @ts-expect-error a currency is neither a list nor keyed, so it cannot say which prices to follow
    price: follow('shop', 'price', { each: 'currency', args: (id) => ({ id }), heard: () => {} }),
    // @ts-expect-error it reads the note, which it did not name: a field it does not name is not there to read
    noted: follow('shop', 'total', { from: ['currency'], args: ({ note }) => ({ currency: note }), heard: () => {} }),
    // @ts-expect-error the shop has no such field to read from
    missing: follow('shop', 'total', { from: ['locale'], args: () => ({ currency: '' }), heard: () => {} }),
  }),
  states: { browsing: {}, away: {} },
})
state<Shop, ShopEvent>()({
  data: { currency: '', total: null, watching: [], prices: {}, note: '', problem: null },
  initial: 'browsing',
  follows: (follow) => ({
    // @ts-expect-error a price is a number, so it cannot be put where the note goes
    price: follow('shop', 'price', { each: 'watching', args: (id) => ({ id }), heard: (update) => (update.ok ? { data: { note: update.value } } : undefined) }),
    // @ts-expect-error a view is followed from fields or for each key, not both at once
    both: follow('shop', 'price', { from: ['currency'], each: 'watching', args: (id) => ({ id }), heard: () => {} }),
  }),
  states: { browsing: {}, away: {} },
})

// `args` accepts read-only values straight from `data`.
import { forNet } from '../src/index.ts'
type ListNet = { systems: {}; surfaces: {}; views: { items: { list: { args: { ids: string[] }; result: number } } } }
forNet<ListNet>()<{ data: { ids: string[] } }, never>()({
  data: { ids: [] },
  follows: (follow) => ({
    list: follow('items', 'list', { from: ['ids'], args: ({ ids }) => ({ ids }), heard: () => {} }),
  }),
})
