// Headless causal inspector over `StepLog`, `Defect`, and `@apackdev/state/graph`.
// Pure TypeScript with zero runtime dependencies and zero Node built-ins (runs identically in Node and browsers).
// Payload-free by default; optional snapshot capture uses the kernel's frozen structural-sharing values.
//
// Within one system an edge is exact: an ask, its progress, its answer and what is done with it carry one id, as do a
// view and its updates. Between systems nothing a log holds says which message a step took, only where it went and
// what it was called, so an edge between systems is given when one message alone could be the one, and not given
// when two could: two windows that told a backend the same thing, a broadcast a window has not caught up with. A step
// then has no edge from another system; it never has a wrong one. That rests on three things: every system that sends
// is hooked, under a name of its own; a message is taken after the step that sent it was logged, which is so of a link,
// which delivers on a later turn; and what was sent across a link arrives. An arrival that nothing sent explains turns
// its name off, which holds the first two. A tell or a broadcast that a link dropped as it closed is not known of.
import type { StateGraph } from './graph.ts'
import type { Defect, Handled, Sent, StepLog } from './kernel.ts'

export type { StateGraph } from './graph.ts'
export type { Defect, Handled, Sent, StepLog } from './kernel.ts'

/** A structured defect captured by the inspector (serializable, with error reduced to text). */
export interface InspectedDefect {
  readonly seq: number
  readonly system: string
  readonly message: string
  readonly ref?: string
  readonly step?: number
  readonly error?: string
}

/** A directed causal edge connecting an earlier step's emission or operation to a later step's handling. */
export interface CausalEdge {
  readonly kind: 'ask' | 'answer' | 'progress' | 'done' | 'view' | 'tell' | 'broadcast'
  readonly fromSystem: string
  readonly fromStep: number
  readonly toSystem: string
  readonly toStep: number
  readonly opId?: number
  readonly ref: string
  readonly name: string
}

/** One recorded step from an attached system, enriched with correlated defects, causal parents, and optional snapshot. */
export interface InspectedStep {
  /** Global monotonic sequence across all attached systems, starting at 1. */
  readonly seq: number
  /** Attached system name (e.g., `'backend'`, `'window-1'`). */
  readonly system: string
  /** Raw `StepLog` emitted by the kernel. */
  readonly log: StepLog
  /** Structured defects reported during this step or its commit flush. */
  readonly defects: readonly InspectedDefect[]
  /** Causal parent edges pointing from earlier steps (in this or another attached system) into this step. */
  readonly causes: readonly CausalEdge[]
  /** Frozen `sys.snapshot()` captured right after commit when `captureSnapshots: true` and `bind()` is active. */
  readonly snapshot?: Readonly<Record<string, unknown>>
}

/** An ask a system made or is answering, or a view it follows, that has not yet ended. */
export interface InFlightOp {
  readonly kind: 'ask' | 'follow'
  readonly system: string
  readonly opId: number
  readonly startedStep: number
  readonly startedAt?: number
  readonly to: string
  readonly name: string
}

/** An ignored event, dropped/failed peer tell, or defect explaining why an action had no effect. */
export interface IgnoredEntry {
  readonly seq: number
  readonly system: string
  readonly step?: number
  readonly kind: 'event' | 'peer' | 'defect'
  readonly ref: string
  readonly name?: string
  readonly detail: string
}

/** Result of walking causal edges backward from the latest step touching a state ref (and optional field). */
export interface CausalExplanation {
  readonly ref: string
  readonly field?: string
  readonly steps: readonly InspectedStep[]
  readonly edges: readonly CausalEdge[]
  readonly text: string
}

/** Static-vs-runtime coverage overlay for one state ref against its `@apackdev/state/graph` `StateGraph`. */
export interface StateCoverage {
  readonly title: string
  readonly ref: string
  readonly declaredStates: readonly string[]
  readonly visitedStates: readonly string[]
  readonly unvisitedStates: readonly string[]
  readonly declaredMoves: ReadonlyArray<{ readonly from: string; readonly on: string; readonly to: string; readonly hit: boolean }>
  readonly observedMoves: ReadonlyArray<{ readonly from: string; readonly on: string; readonly to: string }>
  readonly defects: number
  readonly currentAt?: string
}

/** Portable, payload-free (unless `captureSnapshots` is enabled) JSON-serializable trace snapshot. */
export interface ExportedTrace {
  readonly version: 1
  readonly systems: readonly string[]
  readonly steps: readonly InspectedStep[]
  readonly defects: readonly InspectedDefect[]
  readonly inFlight: readonly InFlightOp[]
  readonly ignored: readonly IgnoredEntry[]
}

/** Options for `createInspector`. */
export interface InspectorOptions {
  /**
   * How many steps are kept, and what everything else kept is bounded by: as many defects and ignored entries, as many
   * states' coverage, as many names under way between systems, and four times as many asks and follows. A whole number
   * of at least 1 (defaults to 500): a fraction is rounded down, and what is less, or not a number, is 1.
   */
  readonly limit?: number
  /** When true, capture `sys.snapshot()` after each committed step for any system wired via `bind()`. */
  readonly captureSnapshots?: boolean
}

/** Optional downstream callbacks forwarded when wiring `inspector.hooks(...)` into `system(...)`. */
export interface HookForward {
  readonly log?: (step: StepLog) => void
  readonly onDefect?: (defect: Defect) => void
  readonly trace?: (line: string) => void
}

/** Host callbacks returned by `inspector.hooks(...)`, ready to spread into `system({ side, ... })`. */
export interface InspectorHooks {
  readonly log: (step: StepLog) => void
  readonly onDefect: (defect: Defect) => void
  readonly trace: (line: string) => void
}

/** Filter options for `inspector.format(...)`. */
export interface FormatOptions {
  /** Only include the last `N` steps: a fraction is rounded down, and what is less than 0, or not a number, is 0. */
  readonly last?: number
  /** Only include steps from this attached system name. */
  readonly system?: string
  /** Only include steps that handled, changed, or sent to this state ref. */
  readonly ref?: string
}

/** Notification emitted to `inspector.subscribe(...)` listeners. */
export type InspectorUpdate =
  | { readonly kind: 'step'; readonly step: InspectedStep }
  | { readonly kind: 'defect'; readonly defect: InspectedDefect }

/** Unified multi-system causal inspector built over `StepLog`, `Defect`, and `StateGraph`. */
export interface Inspector {
  /** Returns `{ log, onDefect, trace }` hooks to spread into `system({ side, ...inspector.hooks('backend') })`. */
  hooks(systemName: string, forward?: HookForward): InspectorHooks
  /** Binds a running `System` (or snapshot provider) under `systemName` for live `snapshots()` and optional per-step snapshot capture. */
  bind(systemName: string, sys: { snapshot(): Record<string, unknown> }): () => void
  /** All retained steps across attached systems, in global causal arrival order, as they stand when read. */
  readonly steps: readonly InspectedStep[]
  /** All recorded defects across attached systems, as they stand when read. */
  readonly defects: readonly InspectedDefect[]
  /** All causal edges linking retained steps, as they stand when read. */
  readonly edges: readonly CausalEdge[]
  /** Walks backward from the latest step touching `ref` (and optional `field`) to its root cause(s). */
  explain(ref: string, field?: string): CausalExplanation
  /** Every ask and follow under way across attached systems: an ask is under way where it was made and where it is being answered. */
  inFlight(): readonly InFlightOp[]
  /** Every ignored event, dropped/failed peer tell, and defect (optionally filtered to `ref`). */
  whyIgnored(ref?: string): readonly IgnoredEntry[]
  /** Overlays observed runtime transitions and defects onto static `@apackdev/state/graph` `StateGraph`s. */
  coverage(graphs: Readonly<Record<string, StateGraph>> | ((ref: string) => StateGraph | undefined)): readonly StateCoverage[]
  /** Current `snapshot()` of every bound `System`, keyed by attached system name. */
  snapshots(): Readonly<Record<string, Record<string, unknown>>>
  /** Formats steps, defects, and causal links into a compact human- and agent-readable timeline. */
  format(options?: FormatOptions): string
  /** Exports a portable JSON-serializable trace snapshot. */
  export(): ExportedTrace
  /** Subscribes to live step and defect updates; returns an unsubscribe function. */
  subscribe(listener: (update: InspectorUpdate) => void): () => void
  /** Clears all recorded steps, defects, edges, ignored entries, and in-flight tracking. */
  clear(): void
}

/** Something a step sent to another system: which step, and for an ask or its answer, which one. */
interface Pending {
  readonly system: string
  readonly step: number
  readonly opId: number | undefined
  /** Its asker gave it up after it left, so it may never be taken. */
  cancelled?: true
}

/** What windows have sent a backend under one name and it has not yet taken, oldest first. */
interface Pool {
  entries: Pending[]
  /** How many of what is to be taken next cannot be told apart, and so are given no edge. */
  blind: number
}

/** What a backend has broadcast under one name: the last steps that did, and how far each system has taken them. */
interface Shouts {
  /** How many there have been. */
  sent: number
  /** The step that made each of the last of them, by how many there had been before it. */
  readonly last: Map<number, Pending>
  readonly heard: Map<string, { upTo: number; unsure: number }>
}

/** An ask or a follow one system has under way, or has finished and may still hear of. */
interface Op {
  readonly flight: InFlightOp
  open: boolean
  /** Taken here from a link: nothing is done with its answer here. */
  readonly across?: true
  /** The step its answer was handled in. */
  answered?: number
  /** For one taken here: the ask in another system that it is. */
  readonly asker?: Pending
  /** For one sent from here: what was sent, which another system may be still to take. */
  readonly sent?: Pending
  /** For one sent from here: the step in another system that answered it. */
  reply?: Pending
  /**
   * For one sent from here: the step in another system that said something of it and has not been heard here yet,
   * and whether more have said something since, which may or may not be heard with it.
   */
  said?: { readonly first: Pending; more: boolean }
  /** For one sent from here: which step said what is heard next can no longer be told. */
  deaf?: true
}

const errorText = (error: unknown): string => (error instanceof Error ? error.message || error.name : String(error))

/** A count someone gave: the whole number at or below it, no less than `least`, and `least` for what is not a number. */
const countOf = (given: number, least: number): number => (Number.isNaN(given) ? least : Math.max(least, Math.floor(given)))

const stepTouchesRef = (step: InspectedStep, ref: string): boolean =>
  ref in step.log.changed
  || step.log.handled.some((h) => h.ref === ref)
  || step.log.sent.some((s) => s.to === ref)

/** What began a move, as `@apackdev/state/graph` names it in a `StateGraph`'s moves. */
const graphTriggerOf = (h: Handled): string => {
  switch (h.kind) {
    case 'done': return `${h.name} (done)`
    case 'progress': return `${h.name} (progress)`
    case 'view': return `${h.name} (updated)`
    case 'expired': return `${h.name} (expired)`
    case 'result': return '(its work ends)'
    case 'failure': return '(its work fails)'
    case 'ask': case 'answer': return `${h.name} (answering)`
    default: return `${h.name}`
  }
}

const formatHandled = (h: Handled): string => {
  const parts = [h.kind, h.ref, h.name]
  if (h.key !== undefined) parts.push(`[${h.key}]`)
  if (h.id !== undefined) parts.push(`#${h.id}`)
  if (h.own) parts.push('(own)')
  if (h.across) parts.push(`(from ${h.across === 'window' ? 'a window' : 'the backend'})`)
  if (h.ignored) parts.push('(ignored)')
  return parts.join(' ')
}

const formatSent = (s: Sent): string => {
  const parts = [s.kind, `-> ${s.to}`, s.name]
  if (s.id !== undefined) parts.push(`#${s.id}`)
  if (s.outcome) parts.push(`[${s.outcome}]`)
  return parts.join(' ')
}

/** Formats a list of `InspectedStep`s into a concise causal timeline string. */
export function formatCausalTrace(steps: readonly InspectedStep[], defects: readonly InspectedDefect[] = []): string {
  if (!steps.length && !defects.length) return '(no steps recorded)'
  const lines: string[] = []
  const attachedDefectSeqs = new Set<number>()
  for (const step of steps) {
    const time = step.log.now === undefined ? '' : ` @ ${step.log.now}ms`
    const causeNote = step.causes.length
      ? `  ← ${step.causes.map((c) => `${c.fromSystem}#${c.fromStep} (${c.kind}${c.opId === undefined ? '' : `#${c.opId}`})`).join(', ')}`
      : ''
    lines.push(`${step.system}#${step.log.number} [${step.log.status}${time}]${causeNote}`)
    for (const h of step.log.handled) lines.push(`  ◀ ${formatHandled(h)}`)
    for (const [ref, change] of Object.entries(step.log.changed)) {
      const bits: string[] = []
      if (change.moved) bits.push(`at=${change.at}`)
      if (change.fields.length) bits.push(`fields=[${change.fields.join(', ')}]`)
      if (change.pending) bits.push('pending')
      if (change.armed) bits.push('armed')
      if (bits.length) lines.push(`  Δ ${ref}: ${bits.join(', ')}`)
    }
    for (const s of step.log.sent) lines.push(`  ▶ ${formatSent(s)}`)
    for (const d of step.defects) {
      attachedDefectSeqs.add(d.seq)
      lines.push(`  ⚠ DEFECT${d.ref ? ` (${d.ref})` : ''}: ${d.message}`)
    }
  }
  for (const d of defects) {
    if (attachedDefectSeqs.has(d.seq)) continue
    lines.push(`${d.system}${d.step === undefined ? '' : `#${d.step}`} ⚠ DEFECT${d.ref ? ` (${d.ref})` : ''}: ${d.message}`)
  }
  return lines.join('\n')
}

/**
 * Creates a unified causal inspector across one or more `apack-state` systems.
 * Spread `inspector.hooks(name)` into `system({ side, ... })` to capture steps, defects, ignored events,
 * in-flight async operations, and cross-system causal edges with zero payload logging.
 */
export function createInspector(options: InspectorOptions = {}): Inspector {
  const limit = countOf(options.limit ?? 500, 1)
  const captureSnapshots = options.captureSnapshots ?? false

  let seq = 0
  const systems = new Set<string>()
  const bound = new Map<string, { snapshot(): Record<string, unknown> }>()
  const steps: InspectedStep[] = []
  const defects: InspectedDefect[] = []
  const edges: CausalEdge[] = []
  const ignored: IgnoredEntry[] = []
  const listeners = new Set<(update: InspectorUpdate) => void>()

  /** Defects reported during a step before its `log(step)` callback fires, by `${system}#${step}`. */
  const pendingDefects = new Map<string, InspectedDefect[]>()
  /** What the kernel traced of an event sent from outside that only its state raises, by system, until the step logs. */
  const outsideTraces = new Map<string, string[]>()
  /** Every ask and follow not yet over, and each ask that is over until what is done with it is heard, by `${system}\0${opId}`. */
  const ops = new Map<string, Op>()
  /** What windows have told and asked a backend and it has not taken, by `${ref}\0${name}`. */
  const tells = new Map<string, Pool>()
  const asks = new Map<string, Pool>()
  /** What a backend has broadcast, by `${ref}\0${name}`. */
  const shouts = new Map<string, Shouts>()
  /** Where each state with states of its own is, by `${system}\0${ref}`, to tell where a move was from. */
  const lastAt = new Map<string, { readonly ref: string; readonly at: string }>()
  const observedStates = new Map<string, Set<string>>()
  const observedMoves = new Map<string, Array<{ readonly from: string; readonly on: string; readonly to: string }>>()

  /** Holds a map to so many entries, the oldest going first. */
  const capMap = <K, V>(map: Map<K, V>, max: number): void => {
    for (const oldest of map.keys()) {
      if (map.size <= max) break
      map.delete(oldest)
    }
  }
  /** What a map holds under a key, made if it is not there, and the newest in the map again. */
  const touch = <V,>(map: Map<string, V>, key: string, make: () => V, max: number): V => {
    const value = map.get(key) ?? make()
    map.delete(key)
    map.set(key, value)
    capMap(map, max)
    return value
  }

  const pushBounded = <T,>(list: T[], item: T): void => {
    list.push(item)
    if (list.length > limit) list.shift()
  }

  const emit = (update: InspectorUpdate): void => {
    for (const listener of [...listeners]) {
      try { listener(update) } catch {}
    }
  }

  /** A pool is kept only while it holds something: one that holds nothing is as one never made. */
  const keep = (pools: Map<string, Pool>, key: string, pool: Pool): void => {
    pools.delete(key)
    if (!pool.entries.length && !pool.blind) return
    pools.set(key, pool)
    capMap(pools, limit)
  }
  /** Something was sent under a name. More of them than are kept cannot be told apart, and none of those is given an edge. */
  const leave = (pools: Map<string, Pool>, key: string, pending: Pending): void => {
    const pool = pools.get(key) ?? { entries: [], blind: 0 }
    if (pool.blind) pool.blind++
    else if (pool.entries.push(pending) > limit) { pool.blind = pool.entries.length; pool.entries = [] }
    keep(pools, key, pool)
  }
  /**
   * Something sent under a name was taken: which, if only one could be. It is the oldest, where all that is waiting
   * is one system's, since a link keeps the order of what one system sends; two systems' are in no order, and one
   * given up behind which others wait may never come. Then none of what is waiting is told apart. Taken with nothing
   * waiting, it was sent by what is not inspected, or before its sender's step was logged, and the name is never
   * trusted again.
   */
  const arrive = (pools: Map<string, Pool>, key: string): Pending | undefined => {
    const pool = pools.get(key) ?? { entries: [], blind: 0 }
    const [first] = pool.entries
    let found: Pending | undefined
    if (pool.blind) pool.blind--
    else if (!first) pool.blind = Infinity
    else if (pool.entries.every((each) => each.system === first.system) && !(first.cancelled && pool.entries.length > 1)) found = pool.entries.shift()
    else { pool.blind = pool.entries.length - 1; pool.entries = [] }
    keep(pools, key, pool)
    return found
  }
  /**
   * A broadcast was taken by a system: from which step, if only one could be. Every window joined to the backend is
   * sent each broadcast, in order, but which windows were joined when is in no log: so only when a system has
   * exactly one it has not taken is that the one. With more, none is told apart until it has taken as many as there
   * were, which a window that missed one never does. Taken with none waiting, it is not from what is inspected, and
   * what this system takes under the name is never trusted again.
   */
  const shoutsOf = (key: string): Shouts => touch(shouts, key, () => ({ sent: 0, last: new Map(), heard: new Map() }), limit)
  const hear = (key: string, system: string): Pending | undefined => {
    const all = shoutsOf(key)
    const mine = all.heard.get(system) ?? { upTo: 0, unsure: 0 }
    all.heard.set(system, mine)
    const waiting = all.sent - mine.upTo
    if (waiting === 1 && !mine.unsure) return all.last.get(mine.upTo++)
    mine.unsure = waiting ? mine.unsure + 1 : Infinity
    if (mine.unsure === waiting) { mine.upTo = all.sent; mine.unsure = 0 }
    return undefined
  }

  const recordStep = (systemName: string, log: StepLog): void => {
    const stepSeq = ++seq
    const stepKey = `${systemName}#${log.number}`
    const stepDefects = pendingDefects.get(stepKey) ?? []
    pendingDefects.delete(stepKey)
    const fromOutside = outsideTraces.get(systemName) ?? []
    outsideTraces.delete(systemName)

    const causes: CausalEdge[] = []
    const cause = (kind: CausalEdge['kind'], from: Pending, to: Handled): void => {
      const edge: CausalEdge = {
        kind,
        fromSystem: from.system,
        fromStep: from.step,
        toSystem: systemName,
        toStep: log.number,
        ...(from.opId === undefined ? {} : { opId: from.opId }),
        ref: to.ref,
        name: to.name!,
      }
      causes.push(edge)
      // An edge is kept beside the steps while the step it is from is: the step it leads to always says what it came of.
      if (steps.some((step) => step.system === from.system && step.log.number === from.step)) edges.push(edge)
    }
    const begin = (kind: InFlightOp['kind'], opId: number, to: string, name: string, more: Pick<Op, 'across' | 'asker' | 'sent'> = {}): void => {
      const flight: InFlightOp = { kind, system: systemName, opId, startedStep: log.number, ...(log.now === undefined ? {} : { startedAt: log.now }), to, name }
      ops.set(`${systemName}\0${opId}`, { flight, open: true, ...more })
      capMap(ops, limit * 4)
    }

    // 1. What the step handled: an event nothing took, and what each thing it took came of.
    for (const h of log.handled) {
      const key = `${h.ref}\0${h.name}`
      if (h.kind === 'event') {
        if (h.ignored) {
          const outside = fromOutside.indexOf(`${h.ref} was sent ${h.name} from outside, which only it raises: ignored`)
          pushBounded(ignored, {
            seq: stepSeq,
            system: systemName,
            step: log.number,
            kind: 'event',
            ref: h.ref,
            name: h.name!,
            detail: outside < 0 ? `${h.ref} ignored ${h.name}` : fromOutside.splice(outside, 1)[0]!,
          })
        }
        const sent = h.across === 'window' ? arrive(tells, key) : h.across === 'backend' ? hear(key, systemName) : undefined
        if (sent) cause(h.across === 'window' ? 'tell' : 'broadcast', sent, h)
        continue
      }
      const opKey = `${systemName}\0${h.id}`
      if (h.kind === 'ask') {
        const asker = h.across ? arrive(asks, key) : undefined
        begin('ask', h.id!, h.ref, h.name!, { ...(h.across ? { across: true as const } : {}), ...(asker ? { asker } : {}) })
        if (asker) cause('ask', asker, h)
        continue
      }
      const op = ops.get(opKey)
      if (!op) continue
      // What is done with an answer follows the step that answered; everything before follows the step it began in.
      cause(h.kind as CausalEdge['kind'], { system: systemName, step: op.answered ?? op.flight.startedStep, opId: h.id }, h)
      // What is heard is a list of what was said, oldest first: the oldest not yet heard is surely in it. Whether a
      // later one is, nothing in a log says, so with more than one waiting none after the first is told apart again.
      if (h.kind === 'progress' && op.said) {
        cause('progress', op.said.first, h)
        if (op.said.more) op.deaf = true
        op.said = undefined
      }
      if (h.kind === 'answer') {
        op.answered = log.number
        if (op.reply) cause('answer', op.reply, h)
        // Answered by no step that is known, as when its link ended: if it is still waiting to be taken, it may never be.
        else if (op.sent) op.sent.cancelled = true
      }
      if (h.kind === 'done') ops.delete(opKey)
    }

    // 2. What the step sent: what begins, what ends, and what another system may take.
    // An ask given up in the step that made it never left.
    const neverLeft = new Set(log.sent.filter((s) => s.kind === 'cancelled').map((s) => s.id))
    for (const s of log.sent) {
      const key = `${s.to}\0${s.name}`
      const opKey = `${systemName}\0${s.id}`
      const sent: Pending = { system: systemName, step: log.number, opId: s.id }
      if (s.kind === 'ask') {
        if (neverLeft.has(s.id)) continue
        begin('ask', s.id!, s.to!, s.name!, { sent })
        leave(asks, key, sent)
      } else if (s.kind === 'follow') {
        begin('follow', s.id!, s.to!, s.name!)
      } else if (s.kind === 'unfollow') {
        ops.delete(opKey)
      } else if (s.kind === 'cancelled') {
        // Given up after it left, it may still be taken, and may not.
        const sent = ops.get(opKey)?.sent
        if (sent) sent.cancelled = true
        ops.delete(opKey)
      } else if (s.kind === 'answer' || s.kind === 'abandoned') {
        const op = ops.get(opKey)
        if (!op) continue
        op.open = false
        const asking = op.asker && ops.get(`${op.asker.system}\0${op.asker.opId}`)
        if (asking?.open) asking.reply = sent
        // Nothing more is heard here of an ask that came across a link. One made here is kept for what is done with it.
        if (op.across) ops.delete(opKey)
      } else if (s.kind === 'progress') {
        // What an ask taken from a link says is heard where it was asked.
        const asker = ops.get(opKey)?.asker
        const asking = asker && ops.get(`${asker.system}\0${asker.opId}`)
        if (asking?.open && !asking.deaf) {
          if (asking.said) asking.said.more = true
          else asking.said = { first: sent, more: false }
        }
      } else if (s.kind === 'tell') {
        leave(tells, key, sent)
      } else if (s.kind === 'broadcast') {
        const all = shoutsOf(key)
        all.last.set(all.sent++, sent)
        capMap(all.last, limit)
      } else if (s.outcome) {
        // What is left that says how it ended is a tell to a peer, and it says so only when it was dropped or failed.
        pushBounded(ignored, {
          seq: stepSeq,
          system: systemName,
          step: log.number,
          kind: 'peer',
          ref: s.to!,
          name: s.name!,
          detail: `peer ${s.to} ${s.name} ${s.outcome}`,
        })
      }
    }

    // A step whose rows could not be kept stops its system. What was under way is said to end as its states do, as
    // in any step; that they ended is not said, since nothing of the step was kept, and they are nowhere now.
    if (log.status === 'lost') {
      const mine = `${systemName}\0`
      for (const key of [...lastAt.keys()]) if (key.startsWith(mine)) lastAt.delete(key)
    }

    // 3. Where each state that changed is now, and the move that took it there, for coverage.
    for (const [ref, change] of Object.entries(log.changed)) {
      const stateKey = `${systemName}\0${ref}`
      const from = lastAt.get(stateKey)?.at
      lastAt.delete(stateKey)
      if (!change.at) continue
      lastAt.set(stateKey, { ref, at: change.at })
      capMap(lastAt, limit * 4)
      const visited = touch(observedStates, ref, () => new Set<string>(), limit)
      // In a state, it is in each state that one is inside.
      change.at.split('.').forEach((_, depth, path) => visited.add(path.slice(0, depth + 1).join('.')))
      // A move to the state it was in is a move: it left, and entered again.
      if (!change.moved || from === undefined) continue
      const moves = touch(observedMoves, ref, () => [], limit)
      // A state moves in a step that handled something of its own: the first of them is taken to be what moved it.
      const on = graphTriggerOf(log.handled.find((h) => h.ref === ref)!)
      if (!moves.some((m) => m.from === from && m.on === on && m.to === change.at)) pushBounded(moves, { from, on, to: change.at })
    }

    const sys = captureSnapshots ? bound.get(systemName) : undefined
    const record: InspectedStep = {
      seq: stepSeq,
      system: systemName,
      log,
      defects: stepDefects,
      causes,
      ...(sys ? { snapshot: sys.snapshot() } : {}),
    }
    steps.push(record)
    if (steps.length > limit) {
      // The oldest step goes, and each edge from it: a step an edge leads to came after, and is still kept.
      const dropped = steps.shift()!
      const kept = edges.filter((edge) => edge.fromSystem !== dropped.system || edge.fromStep !== dropped.log.number)
      edges.length = 0
      edges.push(...kept)
    }
    emit({ kind: 'step', step: record })
  }

  const recordDefect = (systemName: string, d: Defect): void => {
    const entry: InspectedDefect = {
      seq: ++seq,
      system: systemName,
      message: d.message,
      ...(d.ref === undefined ? {} : { ref: d.ref }),
      ...(d.step === undefined ? {} : { step: d.step }),
      ...(d.error === undefined ? {} : { error: errorText(d.error) }),
    }
    pushBounded(defects, entry)
    pushBounded(ignored, {
      seq: entry.seq,
      system: systemName,
      ...(d.step === undefined ? {} : { step: d.step }),
      kind: 'defect',
      ref: d.ref ?? systemName,
      detail: d.message,
    })
    if (d.step !== undefined) {
      // Attach immutably if the step was already logged (e.g. a defect inside a throwing log callback), otherwise buffer.
      const existingIdx = steps.findIndex((s) => s.system === systemName && s.log.number === d.step)
      if (existingIdx >= 0) {
        const existing = steps[existingIdx]!
        steps[existingIdx] = { ...existing, defects: [...existing.defects, entry] }
      } else {
        const key = `${systemName}#${d.step}`
        const list = pendingDefects.get(key)
        if (list) list.push(entry)
        else { pendingDefects.set(key, [entry]); capMap(pendingDefects, limit) }
      }
    }
    emit({ kind: 'defect', defect: entry })
  }

  const api: Inspector = {
    hooks(systemName: string, forward: HookForward = {}): InspectorHooks {
      // What was broadcast before a system was hooked was not sent to it.
      if (!systems.has(systemName)) for (const all of shouts.values()) all.heard.set(systemName, { upTo: all.sent, unsure: 0 })
      systems.add(systemName)
      return {
        log: (step: StepLog) => {
          recordStep(systemName, step)
          forward.log?.(step)
        },
        onDefect: (d: Defect) => {
          recordDefect(systemName, d)
          forward.onDefect?.(d)
        },
        trace: (line: string) => {
          if (line.endsWith(' from outside, which only it raises: ignored')) pushBounded(touch(outsideTraces, systemName, () => [], Infinity), line)
          forward.trace?.(line)
        },
      }
    },

    bind(systemName: string, sys: { snapshot(): Record<string, unknown> }): () => void {
      systems.add(systemName)
      bound.set(systemName, sys)
      return () => { if (bound.get(systemName) === sys) bound.delete(systemName) }
    },

    get steps(): readonly InspectedStep[] { return [...steps] },
    get defects(): readonly InspectedDefect[] { return [...defects] },
    get edges(): readonly CausalEdge[] { return [...edges] },

    explain(ref: string, field?: string): CausalExplanation {
      const index = new Map<string, InspectedStep>()
      for (const s of steps) index.set(`${s.system}#${s.log.number}`, s)

      let target: InspectedStep | undefined
      for (let i = steps.length - 1; i >= 0; i--) {
        const s = steps[i]!
        if (field !== undefined) {
          if (s.log.changed[ref]?.fields.includes(field)) { target = s; break }
        } else if (stepTouchesRef(s, ref)) {
          target = s; break
        }
      }
      if (!target) {
        return { ref, ...(field === undefined ? {} : { field }), steps: [], edges: [], text: `(no recorded step touched ${field === undefined ? ref : `${ref}.data.${field}`})` }
      }

      const visited = new Set<string>()
      const chainSteps: InspectedStep[] = []
      const chainEdges: CausalEdge[] = []
      const queue: InspectedStep[] = [target]
      while (queue.length) {
        const current = queue.shift()!
        const key = `${current.system}#${current.log.number}`
        if (visited.has(key)) continue
        visited.add(key)
        chainSteps.push(current)
        for (const edge of current.causes) {
          chainEdges.push(edge)
          const parent = index.get(`${edge.fromSystem}#${edge.fromStep}`)
          if (parent) queue.push(parent)
        }
      }
      chainSteps.sort((a, b) => a.seq - b.seq)
      return {
        ref,
        ...(field === undefined ? {} : { field }),
        steps: chainSteps,
        edges: chainEdges,
        text: formatCausalTrace(chainSteps),
      }
    },

    inFlight(): readonly InFlightOp[] {
      return [...ops.values()].filter((op) => op.open).map((op) => op.flight)
    },

    whyIgnored(ref?: string): readonly IgnoredEntry[] {
      return ref === undefined ? [...ignored] : ignored.filter((entry) => entry.ref === ref)
    },

    coverage(graphs: Readonly<Record<string, StateGraph>> | ((ref: string) => StateGraph | undefined)): readonly StateCoverage[] {
      const entries: Array<[string, StateGraph]> = []
      if (typeof graphs === 'function') {
        const allRefs = new Set<string>([...observedStates.keys(), ...defects.map((d) => d.ref).filter((r): r is string => r !== undefined)])
        for (const ref of allRefs) {
          const g = graphs(ref)
          if (g) entries.push([ref, g])
        }
      } else {
        for (const [ref, g] of Object.entries(graphs)) entries.push([ref, g])
      }
      return entries.map(([ref, graph]) => {
        const visited = observedStates.get(ref) ?? new Set<string>()
        const moves = observedMoves.get(ref) ?? []
        const declaredMoves = graph.moves.flatMap((m) =>
          m.to.map((to) => ({
            from: m.from,
            on: m.on,
            to,
            hit: moves.some((obs) =>
              (obs.to === to || obs.to.startsWith(`${to}.`))
              && (m.from === 'anywhere' || obs.from === m.from || obs.from.startsWith(`${m.from}.`))
              && obs.on === m.on,
            ),
          })),
        )
        const refDefects = defects.filter((d) => d.ref === ref).length
        let currentAt: string | undefined
        for (const entry of lastAt.values()) {
          if (entry.ref === ref) currentAt = entry.at
        }
        return {
          title: graph.title,
          ref,
          declaredStates: graph.states,
          visitedStates: graph.states.filter((s) => visited.has(s)),
          unvisitedStates: graph.states.filter((s) => !visited.has(s)),
          declaredMoves,
          observedMoves: [...moves],
          defects: refDefects,
          ...(currentAt === undefined ? {} : { currentAt }),
        }
      })
    },

    snapshots(): Readonly<Record<string, Record<string, unknown>>> {
      const out: Record<string, Record<string, unknown>> = {}
      for (const [name, sys] of bound) out[name] = sys.snapshot()
      return out
    },

    format(opts: FormatOptions = {}): string {
      let selected = steps
      if (opts.system !== undefined) selected = selected.filter((s) => s.system === opts.system)
      if (opts.ref !== undefined) selected = selected.filter((s) => stepTouchesRef(s, opts.ref!))
      selected = selected.slice(selected.length - Math.min(selected.length, countOf(opts.last ?? Infinity, 0)))
      const minSeq = selected.length ? selected[0]!.seq : undefined
      const selectedDefects = opts.last !== undefined && minSeq === undefined
        ? []
        : defects.filter((d) =>
            (opts.system === undefined || d.system === opts.system)
            && (opts.ref === undefined || d.ref === opts.ref)
            && (minSeq === undefined || d.seq >= minSeq),
          )
      return formatCausalTrace(selected, selectedDefects)
    },

    export(): ExportedTrace {
      return {
        version: 1,
        systems: [...systems],
        steps: [...steps],
        defects: [...defects],
        inFlight: api.inFlight(),
        ignored: [...ignored],
      }
    },

    subscribe(listener: (update: InspectorUpdate) => void): () => void {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },

    clear(): void {
      seq = 0
      steps.length = 0
      defects.length = 0
      edges.length = 0
      ignored.length = 0
      for (const kept of [pendingDefects, outsideTraces, ops, tells, asks, shouts, lastAt, observedStates, observedMoves]) kept.clear()
    },
  }

  return api
}
