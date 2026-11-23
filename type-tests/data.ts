// What a handler is handed and what is read from a state: what cannot be written, and what can be handed on.
// Compiled by `npm run typecheck`, never run: each `@ts-expect-error` is a line that must not compile, and one that
// compiled would fail the check as an unused directive.

import { reaching } from '../src/index.ts'

const state = reaching()

// What must not compile: a field of what a handler is handed, or of what is read from a state, cannot be assigned
// at any depth, and a field that is a list cannot be changed in place. What the types leave is a list further in
// changed in place: that compiles, and is what freezing is for (the checks above on a write in place, and on one
// through a helper).
{
  type Shelf = { data: { items: string[]; count: number; byId: Record<string, string[]>; books: { title: string; tags: string[] }[] } }
  type ShelfEvent = { type: 'ASSIGN' } | { type: 'PUSH' } | { type: 'SORT' } | { type: 'KEYED' } | { type: 'DEEP' } | { type: 'FURTHER_IN' }
  state<Shelf, ShelfEvent>()({
    data: { items: [], count: 0, byId: {}, books: [] },
    on: {
      // @ts-expect-error a field is changed by returning a change
      ASSIGN: (_, { data }) => { data.count = 1 },
      // @ts-expect-error a list a field holds is not changed in place
      PUSH: (_, { data }) => { data.items.push('pushed') },
      // @ts-expect-error nor sorted in place
      SORT: (_, { data }) => { data.items.sort() },
      // @ts-expect-error nor is an entry of a record a field holds assigned
      KEYED: (_, { data }) => { data.byId.a = [] },
      // @ts-expect-error nor a field of an object, however far in
      DEEP: (_, { data }) => { const book = data.books[0]; if (book) book.title = 'renamed' },
      // This compiles, and throws when it runs: the list is inside what a field holds, and is typed as it was declared.
      FURTHER_IN: (_, { data }) => { data.byId.a?.push('further in') },
    },
  })
  const read = undefined as unknown as import('../src/index.ts').Value<Shelf>
  // What is read is handed on as its declared type wherever that only asks for an object: read-only fields ask
  // nothing of a helper, and a string marked as a kind of id is still that string.
  type BookId = string & { readonly book: true }
  type Book = { id: BookId; title: string; tags: string[] }
  const held = undefined as unknown as import('../src/index.ts').Value<{ data: { open: Book; byId: Record<string, Book> } }>
  const takes = (_book: Book, _id: BookId): void => {}
  if (false) { takes(held.data.open, held.data.open.id); takes(held.data.byId.a!, held.data.byId.a!.id) }
  // @ts-expect-error what is read from a state cannot be assigned
  if (false) read.data.count = 1
  // @ts-expect-error and a list it holds cannot be changed in place
  if (false) read.data.items.sort()
}

// What is read can be handed on as it is: sent, told, reported as progress, given as an answer, and given back as a
// change. None of these is a write, so none asks for a copy. Nothing here is run: it has to compile.
{
  type Shelf = { data: { items: string[]; picked: string[] }; internal: { type: 'TAKEN'; items: string[] } }
  type ShelfEvent = { type: 'TAKE'; items: string[] } | { type: 'PASS_ON' }
  type ShelfAsks = { LIST: { args: {}; progress: string[]; answer: string[] }; LIST_LATER: { args: {}; answer: string[] } }
  state<Shelf, ShelfEvent, ShelfAsks>()({
    data: { items: [], picked: [] },
    on: {
      TAKE: ({ items }) => ({ data: { picked: items } }),
      PASS_ON: (_, { data, send }) => {
        send({ type: 'TAKE', items: data.items })
        send({ type: 'TAKEN', items: data.items })
        return { data: { picked: data.items } }
      },
    },
    internal: {
      // The one place a read value is not taken as it is: a field of a draft, which is typed as what may be written
      // to. It would be safe, since what is read is the state's own and frozen. TypeScript cannot give a field one
      // type to read and another to assign, so here it is copied, or given as a field as `PASS_ON` does.
      // @ts-expect-error a draft's field is typed writable, and what is read is not
      TAKEN: (_, { data }) => ({ data: (d) => { d.picked = data.items } }),
    },
    asks: {
      LIST: (_, { data, progress }) => { progress(data.items); return data.items },
      LIST_LATER: async (_, { data }) => data.items,
    },
  })
}
