// Headless causal inspector over `StepLog`, `Defect`, and `@apackdev/state/graph`.
// Pure TypeScript with zero runtime dependencies and zero Node built-ins (runs identically in Node and browsers).
// Payload-free by default; optional snapshot capture uses the kernel's frozen structural-sharing values.
import type { StateGraph } from './graph.ts'
import type { Defect, Handled, Sent, StepLog, System } from './kernel.ts'

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
  readonly kind: 'ask' | 'answer' | 'progress' | 'done' | 'abandoned' | 'follow' | 'view' | 'unfollow' | 'tell' | 'broadcast'
  readonly fromSystem: string
  readonly fromStep: number
  readonly toSystem: string
  readonly toStep: number
  readonly opId?: number
  readonly ref: string
  readonly name?: string
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

/** An async ask or view follow that has been initiated and not yet settled or unfollowed. */
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
  /** Maximum steps retained in the ring buffer (defaults to 500). */
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
  /** Only include the last `N` steps. */
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
  /** Binds a running `System` instance under `systemName` for live `snapshots()` and optional per-step snapshot capture. */
  bind(systemName: string, sys: System): () => void
  /** All retained steps across attached systems, in global causal arrival order. */
  readonly steps: readonly InspectedStep[]
  /** All recorded defects across attached systems. */
  readonly defects: readonly InspectedDefect[]
  /** All causal edges linking retained steps. */
  readonly edges: readonly CausalEdge[]
  /** Walks backward from the latest step touching `ref` (and optional `field`) to its root cause(s). */
  explain(ref: string, field?: string): CausalExplanation
  /** Every currently open `ask` or `follow` across attached systems. */
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

interface PendingLink {
  readonly system: string
  readonly step: number
  readonly opId?: number
}

const errorText = (error: unknown): string | undefined => {
  if (error === undefined) return undefined
  if (error instanceof Error) return error.message || error.name
  return String(error)
}

const stepTouchesRef = (step: InspectedStep, ref: string): boolean =>
  ref in step.log.changed
  || step.log.handled.some((h) => h.ref === ref)
  || step.log.sent.some((s) => s.to === ref)
  || step.defects.some((d) => d.ref === ref)

const formatHandled = (h: Handled): string => {
  const parts = [`${h.kind}`, h.ref]
  if (h.name) parts.push(h.name)
  if (h.key !== undefined) parts.push(`[${h.key}]`)
  if (h.id !== undefined) parts.push(`#${h.id}`)
  if (h.own) parts.push('(own)')
  if (h.ignored) parts.push('(ignored)')
  return parts.join(' ')
}

const formatSent = (s: Sent): string => {
  const parts = [`${s.kind}`]
  if (s.to) parts.push(`-> ${s.to}`)
  if (s.name) parts.push(s.name)
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
      if (change.moved) bits.push(`at=${change.at || '(stopped)'}`)
      if (change.fields.length) bits.push(`fields=[${change.fields.join(', ')}]`)
      if (change.pending) bits.push('pending')
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
  const limit = Math.max(1, options.limit ?? 500)
  const captureSnapshots = options.captureSnapshots ?? false

  let seq = 0
  const systems = new Set<string>()
  const bound = new Map<string, System>()
  const steps: InspectedStep[] = []
  const defects: InspectedDefect[] = []
  const edges: CausalEdge[] = []
  const ignored: IgnoredEntry[] = []
  const listeners = new Set<(update: InspectorUpdate) => void>()

  /** Defects reported during a step before its `log(step)` callback fires. */
  const pendingDefects = new Map<string, InspectedDefect[]>()
  /** Trace lines mentioning `ignored`, buffered per system until the step logs. */
  const pendingIgnoredTraces = new Map<string, string[]>()
  /** Per-system operation origin: `${system}:${opId}` -> step number that initiated the ask/follow. */
  const opOrigins = new Map<string, { readonly step: number; readonly kind: 'ask' | 'follow'; readonly to: string; readonly name: string }>()
  /** Per-system step where an ask's `answer` arrived, so a subsequent `done` step chains through it. */
  const opAnswered = new Map<string, number>()
  /** Currently open async operations, keyed by `${system}:${kind}:${opId}`. */
  const openOps = new Map<string, InFlightOp>()
  /** Cross-system FIFO queues for stitching outbound tells/broadcasts/asks/answers across attached systems. */
  const crossAsks = new Map<string, PendingLink[]>()
  const crossAnswers = new Map<string, PendingLink[]>()
  const crossTells = new Map<string, PendingLink[]>()
  const crossBroadcasts = new Map<string, PendingLink[]>()
  /** Tracks last known substate path per `${system}:${ref}` to reconstruct observed `from -> to` transitions. */
  const lastAt = new Map<string, string>()
  const observedStates = new Map<string, Set<string>>()
  const observedMoves = new Map<string, Array<{ readonly from: string; readonly on: string; readonly to: string }>>()

  const emit = (update: InspectorUpdate): void => {
    for (const listener of [...listeners]) {
      try { listener(update) } catch {}
    }
  }

  const pushQueue = (map: Map<string, PendingLink[]>, key: string, item: PendingLink): void => {
    const list = map.get(key)
    if (list) list.push(item)
    else map.set(key, [item])
  }

  const shiftFromOther = (map: Map<string, PendingLink[]>, key: string, currentSystem: string): PendingLink | undefined => {
    const list = map.get(key)
    if (!list?.length) return undefined
    const idx = list.findIndex((entry) => entry.system !== currentSystem)
    if (idx < 0) return undefined
    const [found] = list.splice(idx, 1)
    if (!list.length) map.delete(key)
    return found
  }

  const addStateVisited = (ref: string, at: string): void => {
    if (!at) return
    let set = observedStates.get(ref)
    if (!set) { set = new Set(); observedStates.set(ref, set) }
    set.add(at)
    for (let cut = at.lastIndexOf('.'); cut > 0; cut = at.lastIndexOf('.', cut - 1)) set.add(at.slice(0, cut))
  }

  const recordStep = (systemName: string, log: StepLog): void => {
    const stepSeq = ++seq
    const key = `${systemName}#${log.number}`
    const stepDefects = pendingDefects.get(key) ?? []
    pendingDefects.delete(key)

    const causes: CausalEdge[] = []
    const seenCause = new Set<string>()
    const addCause = (edge: CausalEdge): void => {
      const sig = `${edge.kind}|${edge.fromSystem}#${edge.fromStep}|${edge.toSystem}#${edge.toStep}|${edge.opId ?? ''}|${edge.ref}|${edge.name ?? ''}`
      if (seenCause.has(sig)) return
      seenCause.add(sig)
      causes.push(edge)
      edges.push(edge)
    }

    const ignoredTraces = pendingIgnoredTraces.get(systemName) ?? []
    pendingIgnoredTraces.delete(systemName)

    // 1. Correlate inbound `handled` entries to prior causal origins & record ignored events.
    for (const h of log.handled) {
      if (h.kind === 'event' && h.ignored) {
        const matchedTrace = ignoredTraces.find((line) => line.includes(h.ref) && (!h.name || line.includes(h.name)))
        ignored.push({
          seq: stepSeq,
          system: systemName,
          step: log.number,
          kind: 'event',
          ref: h.ref,
          ...(h.name === undefined ? {} : { name: h.name }),
          detail: matchedTrace ?? `${h.ref} ignored ${h.name ?? 'event'}`,
        })
      }
      if (h.kind === 'event' && h.name) {
        const fromTell = shiftFromOther(crossTells, `${h.ref}:${h.name}`, systemName)
        if (fromTell) addCause({ kind: 'tell', fromSystem: fromTell.system, fromStep: fromTell.step, toSystem: systemName, toStep: log.number, ref: h.ref, name: h.name })
        const fromBcast = shiftFromOther(crossBroadcasts, `${h.ref}:${h.name}`, systemName)
        if (fromBcast) addCause({ kind: 'broadcast', fromSystem: fromBcast.system, fromStep: fromBcast.step, toSystem: systemName, toStep: log.number, ref: h.ref, name: h.name })
      }
      if (h.kind === 'ask' && h.id !== undefined) {
        const originKey = `${systemName}:${h.id}`
        if (!opOrigins.has(originKey)) {
          opOrigins.set(originKey, { step: log.number, kind: 'ask', to: h.ref, name: h.name ?? '' })
        }
        openOps.set(`${systemName}:ask:${h.id}`, {
          kind: 'ask',
          system: systemName,
          opId: h.id,
          startedStep: log.number,
          ...(log.now === undefined ? {} : { startedAt: log.now }),
          to: h.ref,
          name: h.name ?? '',
        })
        const fromAsk = h.name ? shiftFromOther(crossAsks, `${h.ref}:${h.name}`, systemName) : undefined
        if (fromAsk) {
          addCause({ kind: 'ask', fromSystem: fromAsk.system, fromStep: fromAsk.step, toSystem: systemName, toStep: log.number, ...(fromAsk.opId === undefined ? {} : { opId: fromAsk.opId }), ref: h.ref, ...(h.name === undefined ? {} : { name: h.name }) })
        }
      }
      if ((h.kind === 'answer' || h.kind === 'progress' || h.kind === 'done' || h.kind === 'view') && h.id !== undefined) {
        const opKey = `${systemName}:${h.id}`
        const origin = opOrigins.get(opKey)
        const answeredStep = h.kind === 'done' ? opAnswered.get(opKey) : undefined
        const parentStep = answeredStep ?? origin?.step
        if (parentStep !== undefined && parentStep !== log.number) {
          addCause({
            kind: h.kind,
            fromSystem: systemName,
            fromStep: parentStep,
            toSystem: systemName,
            toStep: log.number,
            opId: h.id,
            ref: h.ref,
            ...(h.name === undefined ? {} : { name: h.name }),
          })
        }
        if (h.kind === 'answer') {
          opAnswered.set(opKey, log.number)
          if (h.name) {
            const fromAnswer = shiftFromOther(crossAnswers, `${h.ref}:${h.name}`, systemName)
            if (fromAnswer) {
              addCause({ kind: 'answer', fromSystem: fromAnswer.system, fromStep: fromAnswer.step, toSystem: systemName, toStep: log.number, ...(fromAnswer.opId === undefined ? {} : { opId: fromAnswer.opId }), ref: h.ref, name: h.name })
            }
          }
        }
        if (h.kind === 'answer' || h.kind === 'done') openOps.delete(`${systemName}:ask:${h.id}`)
      }
    }

    // 2. Track outbound `sent` entries for downstream causal links, in-flight ops, and dropped/failed peers.
    for (const s of log.sent) {
      if (s.kind === 'ask' && s.id !== undefined && s.to && s.name) {
        opOrigins.set(`${systemName}:${s.id}`, { step: log.number, kind: 'ask', to: s.to, name: s.name })
        openOps.set(`${systemName}:ask:${s.id}`, {
          kind: 'ask',
          system: systemName,
          opId: s.id,
          startedStep: log.number,
          ...(log.now === undefined ? {} : { startedAt: log.now }),
          to: s.to,
          name: s.name,
        })
        pushQueue(crossAsks, `${s.to}:${s.name}`, { system: systemName, step: log.number, opId: s.id })
      } else if (s.kind === 'follow' && s.id !== undefined && s.to && s.name) {
        opOrigins.set(`${systemName}:${s.id}`, { step: log.number, kind: 'follow', to: s.to, name: s.name })
        openOps.set(`${systemName}:follow:${s.id}`, {
          kind: 'follow',
          system: systemName,
          opId: s.id,
          startedStep: log.number,
          ...(log.now === undefined ? {} : { startedAt: log.now }),
          to: s.to,
          name: s.name,
        })
      } else if (s.kind === 'unfollow' && s.id !== undefined) {
        openOps.delete(`${systemName}:follow:${s.id}`)
      } else if ((s.kind === 'answer' || s.kind === 'abandoned') && s.id !== undefined) {
        openOps.delete(`${systemName}:ask:${s.id}`)
        if (s.to && s.name) pushQueue(crossAnswers, `${s.to}:${s.name}`, { system: systemName, step: log.number, opId: s.id })
      } else if (s.kind === 'tell' && s.to && s.name) {
        pushQueue(crossTells, `${s.to}:${s.name}`, { system: systemName, step: log.number })
      } else if (s.kind === 'broadcast' && s.to && s.name) {
        pushQueue(crossBroadcasts, `${s.to}:${s.name}`, { system: systemName, step: log.number })
      } else if (s.kind === 'peer' && (s.outcome === 'dropped' || s.outcome === 'failed')) {
        ignored.push({
          seq: stepSeq,
          system: systemName,
          step: log.number,
          kind: 'peer',
          ref: s.to ?? '',
          ...(s.name === undefined ? {} : { name: s.name }),
          detail: `peer ${s.to ?? '(unknown)'} ${s.name ?? 'event'} ${s.outcome}`,
        })
      }
    }

    // 3. Track visited states and observed transitions for static-vs-runtime graph coverage.
    const trigger = log.handled[0]
    for (const [ref, change] of Object.entries(log.changed)) {
      const stateKey = `${systemName}:${ref}`
      const prevAt = lastAt.get(stateKey) ?? ''
      if (change.at) addStateVisited(ref, change.at)
      if (change.moved && prevAt && change.at && prevAt !== change.at) {
        let list = observedMoves.get(ref)
        if (!list) { list = []; observedMoves.set(ref, list) }
        const on = trigger?.name ?? trigger?.kind ?? '(step)'
        if (!list.some((m) => m.from === prevAt && m.on === on && m.to === change.at)) {
          list.push({ from: prevAt, on, to: change.at })
        }
      }
      if (change.at) lastAt.set(stateKey, change.at)
      else lastAt.delete(stateKey)
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
      const dropped = steps.shift()!
      for (let i = edges.length - 1; i >= 0; i--) {
        if (edges[i]!.toSystem === dropped.system && edges[i]!.toStep === dropped.log.number) edges.splice(i, 1)
      }
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
    defects.push(entry)
    ignored.push({
      seq: entry.seq,
      system: systemName,
      ...(d.step === undefined ? {} : { step: d.step }),
      kind: 'defect',
      ref: d.ref ?? systemName,
      detail: d.message,
    })
    if (d.step !== undefined) {
      // Attach directly if the step was already logged (e.g. a defect inside a throwing log callback), otherwise buffer.
      const existing = steps.find((s) => s.system === systemName && s.log.number === d.step)
      if (existing) {
        ;(existing.defects as InspectedDefect[]).push(entry)
      } else {
        const key = `${systemName}#${d.step}`
        const list = pendingDefects.get(key)
        if (list) list.push(entry)
        else pendingDefects.set(key, [entry])
      }
    }
    emit({ kind: 'defect', defect: entry })
  }

  const api: Inspector = {
    hooks(systemName: string, forward: HookForward = {}): InspectorHooks {
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
          if (line.includes('ignored')) {
            const list = pendingIgnoredTraces.get(systemName)
            if (list) list.push(line)
            else pendingIgnoredTraces.set(systemName, [line])
          }
          forward.trace?.(line)
        },
      }
    },

    bind(systemName: string, sys: System): () => void {
      systems.add(systemName)
      bound.set(systemName, sys)
      return () => { if (bound.get(systemName) === sys) bound.delete(systemName) }
    },

    get steps(): readonly InspectedStep[] { return steps },
    get defects(): readonly InspectedDefect[] { return defects },
    get edges(): readonly CausalEdge[] { return edges },

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
        return { ref, ...(field === undefined ? {} : { field }), steps: [], edges: [], text: `(no recorded step touched ${field ? `${ref}.data.${field}` : ref})` }
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
      return [...openOps.values()]
    },

    whyIgnored(ref?: string): readonly IgnoredEntry[] {
      return ref === undefined ? [...ignored] : ignored.filter((entry) => entry.ref === ref)
    },

    coverage(graphs: Readonly<Record<string, StateGraph>> | ((ref: string) => StateGraph | undefined)): readonly StateCoverage[] {
      const entries: Array<[string, StateGraph]> = []
      if (typeof graphs === 'function') {
        const allRefs = new Set<string>([...observedStates.keys(), ...observedMoves.keys(), ...defects.map((d) => d.ref).filter((r): r is string => r !== undefined)])
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
            hit: moves.some((obs) => obs.to === to && (m.from === 'anywhere' || obs.from === m.from || obs.from.startsWith(`${m.from}.`)) && obs.on === m.on),
          })),
        )
        const refDefects = defects.filter((d) => d.ref === ref).length
        let currentAt: string | undefined
        for (const [k, at] of lastAt) {
          if (k.endsWith(`:${ref}`)) currentAt = at
        }
        return {
          title: graph.title,
          ref,
          declaredStates: graph.states,
          visitedStates: graph.states.filter((s) => visited.has(s)),
          unvisitedStates: graph.states.filter((s) => !visited.has(s)),
          declaredMoves,
          observedMoves: moves,
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
      if (opts.last !== undefined && opts.last >= 0) selected = opts.last === 0 ? [] : selected.slice(-opts.last)
      const selectedDefects = defects.filter((d) =>
        (opts.system === undefined || d.system === opts.system)
        && (opts.ref === undefined || d.ref === opts.ref),
      )
      return formatCausalTrace(selected, selectedDefects)
    },

    export(): ExportedTrace {
      return {
        version: 1,
        systems: [...systems],
        steps: [...steps],
        defects: [...defects],
        inFlight: [...openOps.values()],
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
      pendingDefects.clear()
      pendingIgnoredTraces.clear()
      opOrigins.clear()
      opAnswered.clear()
      openOps.clear()
      crossAsks.clear()
      crossAnswers.clear()
      crossTells.clear()
      crossBroadcasts.clear()
      lastAt.clear()
      observedStates.clear()
      observedMoves.clear()
    },
  }

  return api
}
