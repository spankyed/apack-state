// A slice of apack's brain held to its invariants: dynamic trigger nodes via one declared event, recursive subflows,
// commit-time runHistory peer facts with step-stamped `now`, `sleep(ms)` delays, and structured cancellation on kill.
//
//   npx vitest run brain
import { deepStrictEqual, ok, strictEqual } from 'node:assert'
import { rest, run, system } from './checks.mts'
import { makeBrainState, makeRunHistory, type FlowBlueprint, type StepExecutor } from '../examples/brain.mts'
import { explore, onSchedule } from '../src/testing.ts'

const blueprints: Record<string, FlowBlueprint> = {
  root: {
    id: 'root',
    label: 'Root Flow',
    triggers: [
      { id: 'trig-msg', eventType: 'threads.user_msg', firstStepId: 'call-sub', persistent: true },
      { id: 'trig-ping', eventType: 'custom.ping', firstStepId: 'pong', persistent: true },
    ],
    steps: {
      'call-sub': { id: 'call-sub', label: 'Run Subflow', kind: 'subflow', subflowId: 'reply', nextId: 'finish' },
      finish: { id: 'finish', label: 'Summarize', kind: 'action' },
      pong: { id: 'pong', label: 'Pong', kind: 'action' },
    },
  },
  reply: {
    id: 'reply',
    label: 'Reply Subflow',
    triggers: [{ id: 'entry', eventType: 'flow.entry', firstStepId: 'generate' }],
    steps: {
      generate: { id: 'generate', label: 'Generate Reply', kind: 'action', delayMs: 200, final: true },
    },
  },
}

await run([
  ['dynamic trigger nodes dispatch through one declared TRIGGER event across recursive subflows with stamped history', async () => {
    const history = makeRunHistory()
    const execute: StepExecutor = (step, payload) => {
      if (step.id === 'pong') return { pong: payload }
      if (step.id === 'generate') return { text: 'generated' }
      if (step.id === 'finish') return { done: (payload as { text: string }).text }
      return payload
    }
    let time = 10_000
    const timers: Array<{ at: number; run: () => void; cancelled: boolean }> = []
    const backend = system({
      side: 'backend',
      clock: {
        now: () => time,
        after: (ms, fn) => {
          const entry = { at: time + ms, run: fn, cancelled: false }
          timers.push(entry)
          return () => { entry.cancelled = true }
        },
      },
    })
    backend.attach('runHistory', history.peer)
    const brain = backend.start('brain', makeBrainState(blueprints, execute))

    backend.send(brain, { type: 'START_BRAIN', rootFlowId: 'root' })
    time = 10_050
    backend.send(brain, { type: 'TRIGGER_BRAIN_EVENT', eventType: 'custom.ping', payload: 'hi' })
    backend.send(brain, { type: 'TRIGGER_BRAIN_EVENT', eventType: 'threads.user_msg', payload: { threadId: 't1' } })
    // Unmatched dynamic trigger is ignored cleanly.
    backend.send(brain, { type: 'TRIGGER_BRAIN_EVENT', eventType: 'unregistered.event', payload: null })
    // Pong finishes asynchronously on a microtask while generate is still sleeping on the manual clock.
    await new Promise<void>((resolve) => { queueMicrotask(resolve) })
    await new Promise<void>((resolve) => { queueMicrotask(resolve) })

    // Pong finished at 10_050 while generate is sleeping for 200ms (system is not yet idle).
    const pong = [...history.nodes.values()].find((n) => n.label === 'Pong')
    strictEqual(pong?.status, 'completed')
    strictEqual(pong?.startedAt, 10_050)
    deepStrictEqual(pong?.result, { pong: 'hi' })
    strictEqual(timers.filter((t) => !t.cancelled).length, 1)
    strictEqual(backend.idle(), false)

    // Advance 200ms: subflow finishes, parent spawns finish step, all tracks drain.
    time = 10_250
    for (const entry of timers.filter((t) => !t.cancelled && t.at <= time)) { entry.cancelled = true; entry.run() }
    await rest()

    const finish = [...history.nodes.values()].find((n) => n.label === 'Summarize')
    strictEqual(finish?.status, 'completed')
    strictEqual(finish?.startedAt, 10_250)
    deepStrictEqual(finish?.result, { done: 'generated' })
    strictEqual(backend.idle(), true)
  }],

  ['a step that fails records failed in runHistory and does not run its next step', async () => {
    const history = makeRunHistory()
    const execute: StepExecutor = (step) => {
      if (step.id === 'generate') throw new Error('model failed')
      return 'should not run'
    }
    const backend = system({
      side: 'backend',
      clock: { now: () => 500, after: (_ms, fn) => { fn(); return () => {} } },
    })
    backend.attach('runHistory', history.peer)
    const brain = backend.start('brain', makeBrainState(blueprints, execute))

    backend.send(brain, { type: 'START_BRAIN', rootFlowId: 'root' })
    backend.send(brain, { type: 'TRIGGER_BRAIN_EVENT', eventType: 'threads.user_msg', payload: {} })
    await rest()

    const gen = [...history.nodes.values()].find((n) => n.label === 'Generate Reply')
    strictEqual(gen?.status, 'failed')
    strictEqual(gen?.error, 'model failed')
    const failedTrack = [...history.nodes.values()].find((n) => n.kind === 'event' && n.label === 'flow.entry')
    strictEqual(failedTrack?.status, 'failed')
    const subflow = [...history.nodes.values()].find((n) => n.label === 'Reply Subflow')
    strictEqual(subflow?.status, 'failed')
    strictEqual(subflow?.error, 'model failed')
    const parentTrack = [...history.nodes.values()].find((n) => n.kind === 'event' && n.label === 'threads.user_msg')
    strictEqual(parentTrack?.status, 'failed')
    // Only the persistent root flow remains active; no subflow or track is stranded.
    deepStrictEqual([...history.nodes.values()].filter((n) => n.status === 'active').map((n) => n.label), ['Root Flow'])
    strictEqual([...history.nodes.values()].some((n) => n.label === 'Summarize'), false)
    strictEqual(backend.idle(), true)
  }],

  ['a final step completing stops any still-running sibling step in the same flow', async () => {
    const history = makeRunHistory()
    const racingBlueprints: Record<string, FlowBlueprint> = {
      root: {
        id: 'root',
        label: 'Root Flow',
        triggers: [
          { id: 't-slow', eventType: 'slow', firstStepId: 'slowStep', persistent: true },
          { id: 't-fast', eventType: 'fast', firstStepId: 'fastFinal', persistent: true },
        ],
        steps: {
          slowStep: { id: 'slowStep', label: 'Slow Step', kind: 'action' },
          fastFinal: { id: 'fastFinal', label: 'Fast Final', kind: 'action', final: true },
        },
      },
    }
    let slowSignal!: AbortSignal
    const execute: StepExecutor = (step, _payload, signal) => {
      if (step.id === 'slowStep') {
        slowSignal = signal
        return new Promise<string>((_, reject) => {
          signal.addEventListener('abort', () => reject(new Error('cancelled')))
        })
      }
      return 'done-now'
    }
    const backend = system({
      side: 'backend',
      clock: { now: () => 1_000, after: () => () => {} },
    })
    backend.attach('runHistory', history.peer)
    const brain = backend.start('brain', makeBrainState(racingBlueprints, execute))
    backend.send(brain, { type: 'START_BRAIN', rootFlowId: 'root' })
    backend.send(brain, { type: 'TRIGGER_BRAIN_EVENT', eventType: 'slow', payload: null })
    strictEqual(slowSignal.aborted, false)
    backend.send(brain, { type: 'TRIGGER_BRAIN_EVENT', eventType: 'fast', payload: null })
    await rest()
    strictEqual(slowSignal.aborted, true, 'entering completed must stop still-running sibling steps')
    const rootFlow = history.nodes.get('run-1')
    strictEqual(rootFlow?.status, 'completed')
    strictEqual(rootFlow?.result, 'done-now')
    const slowNode = [...history.nodes.values()].find((n) => n.label === 'Slow Step')
    strictEqual(slowNode?.status, 'stopped')
    const slowTrack = [...history.nodes.values()].find((n) => n.kind === 'event' && n.label === 'slow')
    strictEqual(slowTrack?.status, 'stopped')
    deepStrictEqual([...history.nodes.values()].filter((n) => n.status === 'active'), [])
  }],
], async (tally) => {
  await tally.every('under every ordering of a running subflow step and KILL_BRAIN, every run node ends terminal and no signal leaks', () =>
    explore((schedule) => {
      const history = makeRunHistory()
      const signals: AbortSignal[] = []
      const execute: StepExecutor = async (step, payload, signal) => {
        signals.push(signal)
        if (step.id === 'generate') return schedule.work('generate', { text: 'ok' })
        return payload
      }
      const backend = system({ side: 'backend', ...onSchedule(schedule, 'brain') })
      backend.attach('runHistory', history.peer)
      const brain = backend.start('brain', makeBrainState(blueprints, execute))

      backend.send(brain, { type: 'START_BRAIN', rootFlowId: 'root' })
      backend.send(brain, { type: 'TRIGGER_BRAIN_EVENT', eventType: 'threads.user_msg', payload: { threadId: 't1' } })
      schedule.does('operator', ['KILL_BRAIN', () => backend.send(brain, { type: 'KILL_BRAIN' })])

      return () => {
        strictEqual(backend.idle(), true)
        strictEqual(backend.read(brain).at, 'stopped')
        // Every signal handed to any step executor has aborted (whether step finished or brain was killed).
        ok(signals.every((s) => s.aborted), 'every step work signal must abort when done or killed')
        // Every run node recorded in runHistory reached a terminal status: none left active.
        const active = [...history.nodes.values()].filter((n) => n.status === 'active')
        deepStrictEqual(active, [])
      }
    }))
})
