// A slice of apack's brain ported to the kernel: the brain system, recursive flow states (starting both steps and
// subflows), dynamic trigger nodes handled through one declared `TRIGGER` event, a non-window `runHistory` peer told
// at each commit, step-stamped `now` and `sleep(ms)` from the system's clock, and structured `signal` cancellation.
//
//   npx tsx examples/brain.mts
import { deepStrictEqual, ok, strictEqual } from 'node:assert'
import { given, reaching, system, type Clock, type Each, type PeerPort, type State } from '../src/index.ts'
import { everyOrder, onSchedule } from '../src/testing.ts'

// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// Blueprints, run history peer, and net
// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════

export interface StepDef {
  readonly id: string
  readonly label: string
  readonly kind: 'action' | 'subflow'
  readonly delayMs?: number
  readonly subflowId?: string
  readonly nextId?: string
  readonly final?: boolean
}

export interface TriggerDef {
  readonly id: string
  readonly eventType: string
  readonly firstStepId: string
  readonly persistent?: boolean
}

export interface FlowBlueprint {
  readonly id: string
  readonly label: string
  readonly triggers: readonly TriggerDef[]
  readonly steps: Readonly<Record<string, StepDef>>
}

export type RunHistoryEvent =
  | { readonly type: 'NODE_STARTED'; readonly id: string; readonly parentId?: string; readonly kind: 'flow' | 'event' | 'step'; readonly label: string; readonly at: number }
  | { readonly type: 'NODE_FINISHED'; readonly id: string; readonly status: 'completed' | 'failed'; readonly result?: unknown; readonly error?: string; readonly at: number }
  | { readonly type: 'STOP_ACTIVE'; readonly under?: string; readonly at: number }

export type BrainSurfaceEvent =
  | { readonly type: 'BRAIN_STARTED'; readonly rootFlowId: string }
  | { readonly type: 'BRAIN_KILLED' }
  | { readonly type: 'EVENT_PULSE'; readonly eventType: string }

export type BrainNet = {
  systems: {}
  surfaces: { brain: { events: BrainSurfaceEvent } }
  views: {}
  peers: { runHistory: { events: RunHistoryEvent } }
}

const state = reaching<BrainNet>()

export type StepExecutor = (step: StepDef, payload: unknown, signal: AbortSignal) => Promise<unknown> | unknown

// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// Step state: runs one step action, cancelling via scope.signal if its flow stops
// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════

type StepReport = { readonly type: 'STEP_DONE'; readonly runNodeId: string; readonly stepId: string; readonly result?: unknown; readonly error?: string }

interface StepShape {
  data: {
    runNodeId: string
    step: StepDef
    payload: unknown
  }
  reports: StepReport
  states: {
    executing: {}
    completed: { data: { result: unknown } }
    failed: { data: { error: string } }
  }
}

export const makeStepState = (execute: StepExecutor) => state<StepShape, never>()({
  data: { runNodeId: given, step: given, payload: given },
  start: 'executing',
  states: {
    executing: {
      async run({ data, signal, sleep }) {
        if (data.step.delayMs !== undefined) await sleep(data.step.delayMs)
        const result = await execute(data.step, data.payload, signal)
        return { at: 'completed', data: { result } }
      },
      failed: (error) => ({ at: 'failed', data: { error: error instanceof Error ? error.message : String(error) } }),
    },
    completed: {
      data: { result: given },
      run({ data, now, tell, report }) {
        tell({ peer: 'runHistory' }, { type: 'NODE_FINISHED', id: data.runNodeId, status: 'completed', result: data.result, at: now })
        report({ type: 'STEP_DONE', runNodeId: data.runNodeId, stepId: data.step.id, result: data.result })
      },
    },
    failed: {
      data: { error: given },
      run({ data, now, tell, report }) {
        tell({ peer: 'runHistory' }, { type: 'NODE_FINISHED', id: data.runNodeId, status: 'failed', error: data.error, at: now })
        report({ type: 'STEP_DONE', runNodeId: data.runNodeId, stepId: data.step.id, error: data.error })
      },
    },
  },
})

// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// Flow state (recursive): starts steps and subflows, dispatches dynamic triggers via one declared TRIGGER event
// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════

type ActiveStep = { readonly runNodeId: string; readonly step: StepDef; readonly payload: unknown; readonly trackId: string }
type ActiveSubflow = { readonly runNodeId: string; readonly flowId: string; readonly blueprint: FlowBlueprint; readonly stepId: string; readonly trackId: string }
type TrackState = { readonly live: number; readonly eventType: string; readonly failed?: boolean; readonly error?: string }

export type FlowEvent =
  | { readonly type: 'TRIGGER'; readonly eventType: string; readonly payload: unknown; readonly targetFlowId?: string }
  | { readonly type: 'STEP_DONE'; readonly from: string; readonly runNodeId: string; readonly stepId: string; readonly result?: unknown; readonly error?: string }
  | { readonly type: 'FLOW_DONE'; readonly from: string; readonly runNodeId: string; readonly result?: unknown; readonly error?: string }

type FlowReport = { readonly type: 'FLOW_DONE'; readonly runNodeId: string; readonly result?: unknown; readonly error?: string }

interface FlowShape {
  data: {
    runNodeId: string
    flowId: string
    blueprint: FlowBlueprint
    isRoot: boolean
    activeSteps: Record<string, ActiveStep>
    activeSubflows: Record<string, ActiveSubflow>
    tracks: Record<string, TrackState>
    nextSeq: number
    finalResult: unknown
    finalError: string | undefined
  }
  reports: FlowReport
  states: {
    active: {
      starts: {
        step: Each<ReturnType<typeof makeStepState>>
        subflow: Each<State<FlowShape, FlowEvent, {}, 'runNodeId' | 'flowId' | 'blueprint' | 'isRoot'>>
      }
    }
    completed: {}
    failed: {}
  }
}

export const makeFlowState = (
  blueprints: Readonly<Record<string, FlowBlueprint>>,
  execute: StepExecutor,
): State<FlowShape, FlowEvent, {}, 'runNodeId' | 'flowId' | 'blueprint' | 'isRoot'> => {
  const stepState = makeStepState(execute)

  const spawnChild = (
    draft: FlowShape['data'],
    step: StepDef,
    payload: unknown,
    trackId: string,
    parentId: string,
    now: number,
    tellPeer: (event: RunHistoryEvent) => void,
  ): void => {
    const seq = ++draft.nextSeq
    if (step.kind === 'subflow') {
      const subBlueprint = blueprints[step.subflowId!]!
      const runNodeId = `${draft.runNodeId}.sub.${seq}`
      draft.activeSubflows[runNodeId] = { runNodeId, flowId: subBlueprint.id, blueprint: subBlueprint, stepId: step.id, trackId }
      tellPeer({ type: 'NODE_STARTED', id: runNodeId, parentId, kind: 'flow', label: subBlueprint.label, at: now })
    } else {
      const runNodeId = `${draft.runNodeId}.step.${seq}`
      draft.activeSteps[runNodeId] = { runNodeId, step, payload, trackId }
      tellPeer({ type: 'NODE_STARTED', id: runNodeId, parentId, kind: 'step', label: step.label, at: now })
    }
  }

  const nextOutcome = (
    data: { readonly blueprint: FlowBlueprint; readonly tracks: Readonly<Record<string, TrackState>> },
    stepId: string,
    trackId: string,
    failed: boolean,
  ): { nextStep: StepDef | undefined; nextLive: number; shouldComplete: boolean; shouldFail: boolean } => {
    const step = data.blueprint.steps[stepId]
    const nextStep = !failed && step?.nextId ? data.blueprint.steps[step.nextId] : undefined
    const track = data.tracks[trackId]
    const nextLive = Math.max(0, (track?.live ?? 1) - 1) + (nextStep ? 1 : 0)
    const trackFailed = Boolean(track?.failed) || failed
    const hasPersistent = data.blueprint.triggers.some((t) => t.persistent)
    const allDrained = Object.entries(data.tracks).every(([id, t]) => (id === trackId ? nextLive : t.live) === 0)
    const anyTrackFailed = Object.entries(data.tracks).some(([id, t]) => (id === trackId ? trackFailed : Boolean(t.failed)))
    const shouldComplete = !failed && (Boolean(step?.final) || (!hasPersistent && allDrained && !anyTrackFailed))
    const shouldFail = !shouldComplete && !hasPersistent && allDrained && anyTrackFailed
    return { nextStep, nextLive, shouldComplete, shouldFail }
  }

  const settleChild = (
    draft: FlowShape['data'],
    blueprint: FlowBlueprint,
    stepId: string,
    trackId: string,
    parentId: string,
    result: unknown,
    error: string | undefined,
    now: number,
    tellPeer: (event: RunHistoryEvent) => void,
  ): void => {
    const failed = error !== undefined
    const { nextStep, nextLive, shouldComplete, shouldFail } = nextOutcome({ blueprint, tracks: draft.tracks }, stepId, trackId, failed)
    const track = draft.tracks[trackId]
    const trackFailed = Boolean(track?.failed) || failed
    const trackError = track?.error ?? error
    if (track) draft.tracks[trackId] = { ...track, live: nextLive, ...(trackFailed ? { failed: true } : {}), ...(trackError !== undefined ? { error: trackError } : {}) }
    if (nextLive === 0) tellPeer({ type: 'NODE_FINISHED', id: trackId, status: trackFailed ? 'failed' : 'completed', at: now })
    if (shouldComplete) { draft.finalResult = result; return }
    if (shouldFail) {
      const firstError = Object.values(draft.tracks).find((t) => t.error !== undefined)?.error
      draft.finalError = firstError ?? 'flow failed'
      return
    }
    if (nextStep) spawnChild(draft, nextStep, result, trackId, parentId, now, tellPeer)
  }

  const flowState: State<FlowShape, FlowEvent, {}, 'runNodeId' | 'flowId' | 'blueprint' | 'isRoot'> = state<FlowShape, FlowEvent>()({
    data: {
      runNodeId: given,
      flowId: given,
      blueprint: given,
      isRoot: given,
      activeSteps: {},
      activeSubflows: {},
      tracks: {},
      nextSeq: 0,
      finalResult: undefined,
      finalError: undefined,
    },
    start: 'active',
    states: {
      active: {
        starts: (start) => ({
          step: start(stepState, {
            each: 'activeSteps',
            given: (key, data) => {
              const active = data.activeSteps[key]!
              return { runNodeId: active.runNodeId, step: active.step, payload: active.payload }
            },
          }),
          subflow: start(flowState, {
            each: 'activeSubflows',
            given: (key, data) => {
              const active = data.activeSubflows[key]!
              return { runNodeId: active.runNodeId, flowId: active.flowId, blueprint: active.blueprint, isRoot: false }
            },
          }),
        }),
        run({ data, send }) {
          if (!data.isRoot) send({ type: 'TRIGGER', eventType: 'flow.entry', payload: undefined, targetFlowId: data.runNodeId })
        },
        on: {
          TRIGGER: (event, { data, now, tell, child }) => {
            // Forward global events (and targeted events meant for a descendant) down the subflow tree.
            if (!event.targetFlowId || event.targetFlowId !== data.runNodeId) {
              for (const subId of Object.keys(data.activeSubflows)) {
                tell(child('subflow', subId), event)
              }
            }
            if (event.targetFlowId && event.targetFlowId !== data.runNodeId) return undefined
            const matches = data.blueprint.triggers.filter((t) => t.eventType === event.eventType)
            if (!matches.length) return undefined
            const tellPeer = (e: RunHistoryEvent): void => { tell({ peer: 'runHistory' }, e) }
            return {
              data: (d) => {
                for (const trigger of matches) {
                  const firstStep = data.blueprint.steps[trigger.firstStepId]
                  if (!firstStep) continue
                  const trackId = `${d.runNodeId}.ev.${++d.nextSeq}`
                  d.tracks[trackId] = { live: 1, eventType: trigger.eventType }
                  tellPeer({ type: 'NODE_STARTED', id: trackId, parentId: d.runNodeId, kind: 'event', label: trigger.eventType, at: now })
                  spawnChild(d, firstStep, event.payload, trackId, trackId, now, tellPeer)
                }
              },
            }
          },
          STEP_DONE: ({ from, runNodeId, stepId, result, error }, { data, now, tell }) => {
            const active = data.activeSteps[from]
            if (!active) return undefined
            const tellPeer = (e: RunHistoryEvent): void => { tell({ peer: 'runHistory' }, e) }
            const { shouldComplete, shouldFail } = nextOutcome(data, stepId, active.trackId, error !== undefined)
            const edit = (d: FlowShape['data']): void => {
              delete d.activeSteps[from]
              settleChild(d, data.blueprint, stepId, active.trackId, runNodeId, result, error, now, tellPeer)
            }
            return shouldComplete ? { at: 'completed', data: edit } : shouldFail ? { at: 'failed', data: edit } : { data: edit }
          },
          FLOW_DONE: ({ from, runNodeId, result, error }, { data, now, tell }) => {
            const active = data.activeSubflows[from]
            if (!active) return undefined
            const tellPeer = (e: RunHistoryEvent): void => { tell({ peer: 'runHistory' }, e) }
            const { shouldComplete, shouldFail } = nextOutcome(data, active.stepId, active.trackId, error !== undefined)
            const edit = (d: FlowShape['data']): void => {
              delete d.activeSubflows[from]
              settleChild(d, data.blueprint, active.stepId, active.trackId, runNodeId, result, error, now, tellPeer)
            }
            return shouldComplete ? { at: 'completed', data: edit } : shouldFail ? { at: 'failed', data: edit } : { data: edit }
          },
        },
      },
      completed: {
        run({ data, now, tell, report }) {
          tell({ peer: 'runHistory' }, { type: 'STOP_ACTIVE', under: data.runNodeId, at: now })
          tell({ peer: 'runHistory' }, { type: 'NODE_FINISHED', id: data.runNodeId, status: 'completed', result: data.finalResult, at: now })
          report({ type: 'FLOW_DONE', runNodeId: data.runNodeId, result: data.finalResult })
        },
      },
      failed: {
        run({ data, now, tell, report }) {
          const error = data.finalError ?? 'flow failed'
          tell({ peer: 'runHistory' }, { type: 'STOP_ACTIVE', under: data.runNodeId, at: now })
          tell({ peer: 'runHistory' }, { type: 'NODE_FINISHED', id: data.runNodeId, status: 'failed', error, at: now })
          report({ type: 'FLOW_DONE', runNodeId: data.runNodeId, error })
        },
      },
    },
  })

  return flowState
}

// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// Brain system: owns the root flow lifecycle, stamps run history facts, and routes trigger events
// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════

export type BrainEvent =
  | { readonly type: 'START_BRAIN'; readonly rootFlowId: string }
  | { readonly type: 'KILL_BRAIN' }
  | { readonly type: 'TRIGGER_BRAIN_EVENT'; readonly eventType: string; readonly payload: unknown; readonly targetFlowId?: string }
  | { readonly type: 'FLOW_DONE'; readonly from: string; readonly runNodeId: string; readonly result?: unknown; readonly error?: string }

interface BrainShape {
  data: { runSeq: number }
  states: {
    stopped: {}
    running: {
      data: { rootRunNodeId: string; rootFlowId: string; rootBlueprint: FlowBlueprint }
      starts: { rootFlow: State<FlowShape, FlowEvent, {}, 'runNodeId' | 'flowId' | 'blueprint' | 'isRoot'> }
    }
  }
}

export const makeBrainState = (blueprints: Readonly<Record<string, FlowBlueprint>>, execute: StepExecutor) => {
  const flowState = makeFlowState(blueprints, execute)
  return state<BrainShape, BrainEvent>()({
    data: { runSeq: 0 },
    start: 'stopped',
    states: {
      stopped: {
        on: {
          START_BRAIN: ({ rootFlowId }, { data, now, tell, broadcast }) => {
            const blueprint = blueprints[rootFlowId]
            if (!blueprint) return undefined
            const seq = data.runSeq + 1
            const rootRunNodeId = `run-${seq}`
            tell({ peer: 'runHistory' }, { type: 'NODE_STARTED', id: rootRunNodeId, kind: 'flow', label: blueprint.label, at: now })
            broadcast('brain', { type: 'BRAIN_STARTED', rootFlowId })
            return { at: 'running', data: { runSeq: seq, rootRunNodeId, rootFlowId, rootBlueprint: blueprint } }
          },
        },
      },
      running: {
        data: { rootRunNodeId: given, rootFlowId: given, rootBlueprint: given },
        starts: (start) => ({
          rootFlow: start(flowState, {
            given: (data) => ({ runNodeId: data.rootRunNodeId, flowId: data.rootFlowId, blueprint: data.rootBlueprint, isRoot: true }),
          }),
        }),
        on: {
          TRIGGER_BRAIN_EVENT: ({ eventType, payload, targetFlowId }, { tell, broadcast, child }) => {
            broadcast('brain', { type: 'EVENT_PULSE', eventType })
            tell(child('rootFlow'), { type: 'TRIGGER', eventType, payload, ...(targetFlowId ? { targetFlowId } : {}) })
          },
          KILL_BRAIN: (_, { now, tell, broadcast }) => {
            tell({ peer: 'runHistory' }, { type: 'STOP_ACTIVE', at: now })
            broadcast('brain', { type: 'BRAIN_KILLED' })
            return { at: 'stopped' }
          },
          FLOW_DONE: () => undefined,
        },
      },
    },
  })
}

// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// In-memory run history peer: verifies order and invariants of committed brain facts
// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════

export interface RunHistoryStore {
  readonly peer: PeerPort
  readonly nodes: Map<string, { id: string; parentId?: string; kind: string; label: string; status: 'active' | 'completed' | 'failed' | 'stopped'; startedAt: number; finishedAt?: number; result?: unknown; error?: string }>
  readonly events: RunHistoryEvent[]
}

export const makeRunHistory = (): RunHistoryStore => {
  const nodes = new Map<string, { id: string; parentId?: string; kind: string; label: string; status: 'active' | 'completed' | 'failed' | 'stopped'; startedAt: number; finishedAt?: number; result?: unknown; error?: string }>()
  const events: RunHistoryEvent[] = []
  const peer: PeerPort = {
    tell: (to, raw) => {
      strictEqual(to, 'runHistory')
      const event = raw as RunHistoryEvent
      events.push(event)
      if (event.type === 'NODE_STARTED') {
        if (event.parentId) ok(nodes.has(event.parentId), `parent ${event.parentId} must exist before child ${event.id}`)
        nodes.set(event.id, { id: event.id, ...(event.parentId ? { parentId: event.parentId } : {}), kind: event.kind, label: event.label, status: 'active', startedAt: event.at })
      } else if (event.type === 'NODE_FINISHED') {
        const node = nodes.get(event.id)
        ok(node, `finished node ${event.id} must exist`)
        node.status = event.status
        node.finishedAt = event.at
        if (event.result !== undefined) node.result = event.result
        if (event.error !== undefined) node.error = event.error
      } else if (event.type === 'STOP_ACTIVE') {
        const prefix = event.under ? `${event.under}.` : undefined
        for (const node of nodes.values()) {
          if (node.status === 'active' && (!prefix || node.id.startsWith(prefix))) {
            node.status = 'stopped'
            node.finishedAt = event.at
          }
        }
      }
    },
  }
  return { peer, nodes, events }
}

// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// Running it
// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════

if (globalThis.process?.argv?.[1]?.endsWith('brain.mts')) {
  const blueprints: Record<string, FlowBlueprint> = {
    root: {
      id: 'root',
      label: 'Root Flow',
      triggers: [{ id: 'trig-1', eventType: 'threads.user_msg', firstStepId: 'call-sub', persistent: true }],
      steps: {
        'call-sub': { id: 'call-sub', label: 'Run Subflow', kind: 'subflow', subflowId: 'reply', nextId: 'finish' },
        finish: { id: 'finish', label: 'Summarize', kind: 'action' },
      },
    },
    reply: {
      id: 'reply',
      label: 'Reply Subflow',
      triggers: [{ id: 'entry', eventType: 'flow.entry', firstStepId: 'generate' }],
      steps: {
        generate: { id: 'generate', label: 'Generate Reply', kind: 'action', delayMs: 500, final: true },
      },
    },
  }

  const execute: StepExecutor = (step, payload) => {
    if (step.id === 'generate') return { text: 'hello from subflow' }
    if (step.id === 'finish') return { summary: (payload as { text: string }).text.toUpperCase() }
    return payload
  }

  await everyOrder((schedule) => {
    const history = makeRunHistory()
    const backend = system({ side: 'backend', ...onSchedule(schedule, 'brain') })
    backend.attach('runHistory', history.peer)
    const brain = backend.start('brain', makeBrainState(blueprints, execute))

    schedule.does('app',
      ['start brain', () => backend.send(brain, { type: 'START_BRAIN', rootFlowId: 'root' })],
      ['user message', () => backend.send(brain, { type: 'TRIGGER_BRAIN_EVENT', eventType: 'threads.user_msg', payload: { threadId: 't1' } })],
    )

    return () => {
      strictEqual(backend.idle(), true)
      strictEqual(backend.read(brain).at, 'running')
      const finishedSteps = [...history.nodes.values()].filter((n) => n.kind === 'step' && n.status === 'completed')
      deepStrictEqual(finishedSteps.map((n) => [n.label, n.result]), [
        ['Generate Reply', { text: 'hello from subflow' }],
        ['Summarize', { summary: 'HELLO FROM SUBFLOW' }],
      ])
      const subflow = [...history.nodes.values()].find((n) => n.label === 'Reply Subflow')
      strictEqual(subflow?.status, 'completed')
      strictEqual(subflow?.startedAt, 0)
      strictEqual(subflow?.finishedAt, 500)
    }
  })

  // Also verify kill cancels in-flight step actions cleanly.
  let cancelled = 0
  const killExecute: StepExecutor = (step, payload, signal) => {
    signal.addEventListener('abort', () => { cancelled++ })
    return execute(step, payload, signal)
  }
  let now = 1_000
  const timers: Array<{ at: number; run: () => void; cancelled: boolean }> = []
  const clock: Clock = {
    now: () => now,
    after: (ms, fn) => {
      const entry = { at: now + ms, run: fn, cancelled: false }
      timers.push(entry)
      return () => { entry.cancelled = true }
    },
  }
  const history = makeRunHistory()
  const backend = system({ side: 'backend', clock })
  backend.attach('runHistory', history.peer)
  const brain = backend.start('brain', makeBrainState(blueprints, killExecute))
  backend.send(brain, { type: 'START_BRAIN', rootFlowId: 'root' })
  backend.send(brain, { type: 'TRIGGER_BRAIN_EVENT', eventType: 'threads.user_msg', payload: { threadId: 't1' } })
  strictEqual(timers.filter((t) => !t.cancelled).length, 1)
  now = 1_100
  backend.send(brain, { type: 'KILL_BRAIN' })
  strictEqual(backend.read(brain).at, 'stopped')
  strictEqual(timers.filter((t) => !t.cancelled).length, 0)
  strictEqual([...history.nodes.values()].every((n) => n.status === 'stopped'), true)
  strictEqual(cancelled, 0, 'generate had not started yet while sleeping')
  backend.stop()
  console.log('examples/brain.mts: all checks passed')
}
