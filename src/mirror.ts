// A running state as a value a component can read.
//
//   const thread = mirror(system, handle)
//   thread.value.at                          // read again when it moves
//   thread.value.data.messages               // read again when the state replaces `messages`
//
// A state's data is held a field at a time, and what a field holds is the state's own value: never a copy, and never
// made reactive. The kernel never writes into a value it has committed, it makes another, and it freezes each. So an
// object a component reads is the very one the state holds. It is found by `includes`, it can be cloned, it is the
// same one when it is sent back, and it cannot be written to.
//
// The kernel says which fields a step replaced, and those are written into the mirror. Whatever read one runs again:
// at least when what it read changed, and for any other change inside that field. Where that is too coarse there are
// two ways to be exact, and neither wraps a value. One of many is a state of its own (`starts`), with a mirror of its
// own. And `computed(() => state.data.messages[id])` gives the same object for as long as that message list is not
// replaced, which a computed does not pass on as a change.
//
// What a state has pending is the kernel's own record and holds nothing but whether each call is in flight, so that is kept
// to the key: a spinner on one file runs again for that file.
import { reactive, readonly, shallowReactive, shallowReadonly } from '@vue/reactivity'
import type { System } from './kernel.ts'
import type { Asks, Handle, Started } from './types.ts'

type Pending = Record<string, boolean | number | Record<string, boolean>>
type Armed = Record<string, boolean | Record<string, boolean>>
type Held = { at?: string; data: Record<string, unknown>; pending?: Pending; armed?: Armed }
/** What a reader is handed: where the state is, its fields, pending calls, and armed timers. None of it can be written. */
type Shown = { readonly at: string | undefined; readonly data: Readonly<Record<string, unknown>>; readonly pending?: Readonly<Pending>; readonly armed?: Readonly<Armed> }
/** The same, as the mirror writes it. */
interface Written { readonly whole: { at: string | undefined }; readonly data: Record<string, unknown>; readonly pending: Pending | undefined; readonly armed: Armed | undefined }

/** One running state, mirrored once for everything that reads it. @internal */
export interface Shared { readonly ref: string; readonly box: { now: Shown | undefined }; readers: number }

/**
 * The mirrors of one system. A state is mirrored once however many read it, from the first reader until the last has
 * gone, and a state nobody reads is not mirrored at all. The system is listened to once, for as long as anything is
 * mirrored: a step costs a lookup for each state it changed and a write for each field it replaced, whatever is
 * reading. Nothing is copied, when the first reader arrives or after.
 * @internal
 */
export interface Mirrors {
  /** The mirror of the state running under this name, made if this is its first reader. */
  acquire(ref: string): Shared
  /** One reader fewer. The last one gone, the mirror is dropped. */
  release(shared: Shared): void
  /** How many states are mirrored. */
  readonly size: number
}

const made = new WeakMap<System, Mirrors>()

/** @internal */
export function mirrors(sys: System): Mirrors {
  const existing = made.get(sys)
  if (existing) return existing
  const byRef = new Map<string, Shared>()
  const written = new Map<Shared, Written>()
  let unsubscribe: (() => void) | undefined
  const read = (ref: string): Held | undefined => sys.read({ ref } as never) as Held | undefined

  /** What the kernel says is in flight, written into a record of its own a key at a time. */
  const follow = (into: Pending, from: Pending): void => {
    for (const [name, now] of Object.entries(from)) {
      if (typeof now !== 'object') { if (into[name] !== now) into[name] = now; continue }
      const keys = (into[name] ??= {}) as Record<string, boolean>
      for (const key of Object.keys(keys)) if (!(key in now)) delete keys[key]
      for (const key of Object.keys(now)) if (!keys[key]) keys[key] = true
    }
  }

  /** Shows a state as it is now, or as nothing if it is not running. */
  const show = (shared: Shared, now: Held | undefined): void => {
    if (!now) { written.delete(shared); shared.box.now = undefined; return }
    // Shallow on purpose: a field's value is the state's own object, which is never written to, so there is nothing
    // inside it to track.
    const data = shallowReactive<Record<string, unknown>>({ ...now.data })
    const pending = now.pending === undefined ? undefined : reactive<Pending>({})
    if (pending) follow(pending, now.pending!)
    const armed = now.armed === undefined ? undefined : reactive<Armed>({})
    if (armed) follow(armed, now.armed!)
    const whole = shallowReactive({
      at: now.at,
      data: shallowReadonly(data),
      ...(pending ? { pending: readonly(pending) } : {}),
      ...(armed ? { armed: readonly(armed) } : {}),
    })
    written.set(shared, { whole, data, pending, armed })
    shared.box.now = shallowReadonly(whole) as Shown
  }

  const onStep = (changed: readonly string[], fields: Readonly<Record<string, readonly string[]>>, changes: Readonly<Record<string, { moved: boolean; pending: boolean; armed: boolean }>>): void => {
    for (const ref of changed) {
      const shared = byRef.get(ref)
      if (!shared) continue
      const latest = read(ref)
      const into = written.get(shared)
      // It stopped, or it has only now started: there is nothing to write into, or nothing written yet.
      if (!latest || !into) { show(shared, latest); continue }
      if (changes[ref]?.moved) into.whole.at = latest.at
      if (changes[ref]?.pending && into.pending && latest.pending) follow(into.pending, latest.pending)
      if (changes[ref]?.armed && into.armed && latest.armed) follow(into.armed, latest.armed)
      // A field the state replaced is written, and one it no longer has, having left the state that held it, goes.
      for (const field of fields[ref] ?? []) {
        if (Object.hasOwn(latest.data, field)) into.data[field] = latest.data[field]; else delete into.data[field]
      }
    }
  }

  const all: Mirrors = {
    acquire(ref) {
      let shared = byRef.get(ref)
      if (!shared) {
        shared = { ref, box: shallowReactive<{ now: Shown | undefined }>({ now: undefined }), readers: 0 }
        show(shared, read(ref))
        byRef.set(ref, shared)
        unsubscribe ??= sys.subscribe(onStep)
      }
      shared.readers++
      return shared
    },
    release(shared) {
      if (--shared.readers > 0 || byRef.get(shared.ref) !== shared) return
      byRef.delete(shared.ref)
      written.delete(shared)
      if (!byRef.size) { unsubscribe?.(); unsubscribe = undefined }
    },
    get size() { return byRef.size },
  }
  made.set(sys, all)
  return all
}

/**
 * One reader of a running state, outside a component. A state another started may not be running: its mirror reads
 * as nothing until it is, and as nothing again once it has stopped, and a reader that read it runs again each time.
 * @internal
 */
export function mirror<V extends { data: object }>(sys: System, handle: Started<V, never, Asks, any>): { readonly value: V | undefined; stop(): void }
export function mirror<V extends { data: object }>(sys: System, handle: Handle<V, never, Asks>): { readonly value: V; stop(): void }
export function mirror(sys: System, handle: { readonly ref: string }): { readonly value: unknown; stop(): void } {
  const all = mirrors(sys)
  let shared: Shared | undefined = all.acquire(handle.ref)
  const box = shared.box
  return { get value() { return box.now }, stop: () => { if (shared) all.release(shared); shared = undefined } }
}
