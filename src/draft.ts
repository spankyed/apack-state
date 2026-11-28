// A draft: data to edit in place, from which a new value is made without touching the old one.
//
//   const { value, touched } = produce(data, (draft) => { draft.titles[id] = title })
//
// A state's data is plain: objects, arrays and values that are replaced whole. That is all a draft goes inside.
// Anything else (a class instance, a Map, a Date) can be read and replaced whole, and refuses to be edited.

/** @internal */
export type Path = ReadonlyArray<string>

/** What a draft was made over, the copy it writes to once something changes, and the drafts handed out inside it. */
interface Node {
  readonly base: object
  copy: object | undefined
  readonly around: Node | undefined
  readonly path: Path
  /** Whether `base` came untouched from the frozen input tree, so untouched siblings on its copy are already frozen. */
  readonly fromBase: boolean
  /** The draft handed out for each key, so that reading the same place twice is the same draft. */
  readonly inside: Map<string, { node: Node; proxy: object }>
}

const NODE = Symbol('draft')
const WHOLE = Symbol('whole')
/**
 * Writes an own enumerable data property without invoking `Object.prototype.__proto__`'s setter.
 * @internal
 */
export const put = (target: Record<string, unknown>, key: string, value: unknown): void => {
  if (key === '__proto__') Object.defineProperty(target, key, { value, writable: true, enumerable: true, configurable: true })
  else target[key] = value
}
const isPlain = (value: object): boolean => {
  if (value === Object.prototype || value === Array.prototype) return false
  if (Array.isArray(value)) return true
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

const freezeInner = (current: unknown, copies?: Map<object, Set<string>>): void => {
  if (Object.isFrozen(current) || !isPlain(current as object)) return
  const dirty = copies?.get(current as object)
  Object.freeze(current)
  if (dirty) {
    for (const key of dirty) {
      if (Object.hasOwn(current as object, key)) freezeInner((current as Record<string, unknown>)[key], copies)
    }
  } else {
    for (const inner of Array.isArray(current) ? current : Object.values(current as Record<string, unknown>)) freezeInner(inner, copies)
  }
}

/**
 * What a state holds is a value: once it is the state's, nothing changes it but a handler, which makes another.
 * So every plain object and array is frozen all the way down, and a write to it throws on the line that tried.
 * A component is handed these very objects, and so is whatever a handler passes on. Freezing stops at what is
 * frozen already, which is all of what a step did not change, and leaves alone what is not plain data: a class
 * instance, a component, a map.
 * @internal
 */
export const freeze = <T,>(value: T): T => { freezeInner(value); return value }

/**
 * `fixed` says the outermost object's keys are not the edit's to change: its values can be edited and replaced, and
 * a key can be neither added nor removed. The write that tries is the one that throws, so the error is on its line.
 * When `freeze` is true (and `base` is already deeply frozen), only newly assigned plain values and copied containers
 * are frozen after the edit settles, avoiding re-walking untouched siblings from `base`.
 * @internal
 */
export function produce<T extends object>(base: T, edit: (draft: T) => void, options: { fixed?: boolean; topLevel?: boolean; freeze?: boolean } = {}): { value: T; touched: Path[] } {
  const touched = new Map<string, Path>()
  const touchedTop = new Set<string>()
  /**
   * Copies descended untouched from frozen `base`, mapped to the keys written onto them (`set` or `settle`). Keyed by
   * the copy object itself so provenance survives mid-edit `settle` and child-draft eviction; copies of freshly
   * assigned values (even shallowly frozen ones) are omitted so `freezeInner` deep-freezes all of their keys.
   */
  const copies = options.freeze ? new Map<object, Set<string>>() : undefined
  let open = true
  /** Whether any nested draft or whole wrapper has been handed out; skips walking fresh assignments when none has. */
  let handed = false
  const closed = (): never => { throw new Error('A draft was used after the handler it was given to returned') }

  const latest = (node: Node): Record<string, unknown> => (node.copy ?? node.base) as Record<string, unknown>

  /** Makes a node, and every node around it, write to a copy of its own from here on. */
  const own = (node: Node): Record<string, unknown> => {
    if (!node.copy) {
      const copy: object = Array.isArray(node.base)
        ? [...node.base]
        : Object.getPrototypeOf(node.base) === null
          ? Object.assign(Object.create(null) as Record<string, unknown>, node.base)
          : { ...node.base }
      node.copy = copy
      if (copies && node.fromBase) copies.set(copy, new Set())
      if (node.around) own(node.around)
    }
    return node.copy as Record<string, unknown>
  }

  const note = (node: Node, key: string): void => {
    if (options.topLevel) {
      touchedTop.add(node.path[0] ?? key)
    } else {
      const path = [...node.path, key]
      touched.set(JSON.stringify(path), path)
    }
  }

  /** What a draft or a plain value stands for right now, with every draft inside it resolved. */
  const settle = (node: Node): object => {
    if (!node.copy) return node.base
    const made = node.copy as Record<string, unknown>
    for (const [key, held] of node.inside) {
      if (held.node.copy && made[key] === held.node.base) {
        put(made, key, settle(held.node))
        copies?.get(made)?.add(key)
      }
    }
    return made
  }
  const plainOf = (value: unknown, seen?: Map<object, object>): unknown => {
    if (typeof value !== 'object' || value === null) return value
    const wrapped = (value as { [WHOLE]?: object })[WHOLE]
    if (wrapped) return wrapped
    if (!isPlain(value)) return value
    const node = (value as { [NODE]?: Node })[NODE]
    if (node) return settle(node)
    if (!handed) return value
    const prior = seen?.get(value)
    if (prior) return prior
    const track = seen ?? new Map<object, object>()
    if (Array.isArray(value)) {
      const copy: unknown[] = []
      track.set(value, copy)
      let changed = false
      for (let i = 0; i < value.length; i++) {
        const item = value[i]
        const plain = plainOf(item, track)
        if (plain !== item) changed = true
        copy.push(plain)
      }
      if (!changed) track.set(value, value)
      return changed ? copy : value
    }
    const copy = Object.create(Object.getPrototypeOf(value) as object | null) as Record<string, unknown>
    track.set(value, copy)
    let changed = false
    for (const [k, v] of Object.entries(value)) {
      const plain = plainOf(v, track)
      if (plain !== v) changed = true
      put(copy, k, plain)
    }
    if (!changed) track.set(value, value)
    return changed ? copy : value
  }

  /**
   * A value that is not plain data, as a draft hands it out: it reads as itself and its methods run on the real
   * thing, and assigning to it throws. Editing it would change the one object every earlier value still points at.
   */
  const whole = (value: object, path: Path): object => {
    const refuse = (): never => { throw new Error(`${path.join('.')} is not plain data, so it cannot be edited in a draft. Replace it whole`) }
    return new Proxy(value, {
      get(target, key) {
        if (key === WHOLE) return target
        const found = Reflect.get(target, key, target)
        return typeof found === 'function' ? found.bind(target) : found
      },
      set: refuse, deleteProperty: refuse, defineProperty: refuse,
    })
  }

  const draftOf = (base: object, around: Node | undefined, path: Path, fromBase: boolean): object => {
    const node: Node = { base, copy: undefined, around, path, fromBase, inside: new Map() }
    const isArray = Array.isArray(base)
    // The target is never read: it only says whether this is an array. Every trap answers from the node.
    return new Proxy(isArray ? [] : {}, {
      get(_, key) {
        if (key === NODE) return node
        if (!open) closed()
        const value = Reflect.get(latest(node), key)
        if (typeof key === 'symbol' || typeof value !== 'object' || value === null) return value
        if (!isPlain(value)) { handed = true; return whole(value, [...node.path, key]) }
        const held = node.inside.get(key)
        if (held && held.node.base === value) return held.proxy
        handed = true
        const current = latest(node)
        const proxy = draftOf(value, node, [...node.path, key], node.fromBase && Object.hasOwn(current, key) && !copies?.get(current)?.has(key))
        node.inside.set(key, { node: (proxy as { [NODE]: Node })[NODE], proxy })
        return proxy
      },
      set(_, key, value) {
        if (!open) closed()
        if (typeof key === 'symbol') return false
        if (isArray && key === '__proto__') throw new Error("Cannot assign '__proto__' on an array draft")
        if (options.fixed && !node.around && !Object.hasOwn(node.base, key)) throw new Error(`There is no field ${key} to change`)
        const next = plainOf(value)
        if (Object.is(latest(node)[key], next) && Object.hasOwn(latest(node), key)) return true
        const target = own(node)
        put(target, key, next)
        copies?.get(target)?.add(key)
        node.inside.delete(key)
        note(node, key)
        return true
      },
      deleteProperty(_, key) {
        if (!open) closed()
        if (typeof key === 'symbol' || !Object.hasOwn(latest(node), key)) return true
        if (options.fixed && !node.around) throw new Error(`The field ${key} cannot be removed`)
        delete own(node)[key]
        node.inside.delete(key)
        note(node, key)
        return true
      },
      has: (_, key) => { if (!open) closed(); return key in latest(node) },
      ownKeys: () => { if (!open) closed(); return Reflect.ownKeys(latest(node)) },
      getOwnPropertyDescriptor(_, key) {
        if (!open) closed()
        const found = Reflect.getOwnPropertyDescriptor(latest(node), key)
        // An array's length cannot be reported configurable; everything else can be, since the target holds nothing.
        return found && { ...found, writable: true, configurable: !(isArray && key === 'length') }
      },
      getPrototypeOf: () => { if (!open) closed(); return Object.getPrototypeOf(base) },
      defineProperty: () => { if (!open) closed(); throw new Error('A draft takes assignments, not property definitions') },
    })
  }

  const draft = draftOf(base, undefined, [], Object.isFrozen(base))
  let returned: unknown
  try { returned = edit(draft as T) } finally { open = false }
  // Both would otherwise do nothing and say nothing.
  if (returned instanceof Promise) {
    // What it goes on to do fails against the closed draft; that failure is this one, already reported.
    returned.catch(() => {})
    throw new Error('An edit cannot be async: a draft is closed as soon as the function returns')
  }
  if (returned !== undefined) throw new Error('An edit changes its draft and returns nothing. To replace a field, give the field')
  const value = settle((draft as { [NODE]: Node })[NODE]) as T
  if (copies) freezeInner(value, copies)
  return {
    value,
    touched: options.topLevel ? [...touchedTop].map((field) => [field]) : [...touched.values()],
  }
}
