// The graph tool (`@apackdev/state/graph`, `tools/graph.mts`, and `bin/apack-state-graph.mjs`), held to states that
// are hard to read, non-`state` aliases (`hostState`, inline `forNet`), custom `--tsconfig` path aliases, and CLI errors.
//
//   npx vitest run graph
import { spawnSync } from 'node:child_process'
import { deepStrictEqual, ok, strictEqual } from 'node:assert'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { analyseGraphs, formatGraphs, runGraphCli } from '../src/graph.ts'
import { run } from './checks.mts'

const root = join(import.meta.dirname, '..')
/** The tool as a process of its own, waited for: what it printed, and how it ended. */
const graph = (...args: string[]): { out: string; err: string; status: number | null } => {
  const ran = spawnSync(process.execPath, [join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs'), join(root, 'tools', 'graph.mts'), ...args], { cwd: root, encoding: 'utf8' })
  return { out: ran.stdout, err: ran.stderr, status: ran.status }
}
const runCli = (...args: string[]): { out: string; err: string; status: number } => {
  let out = ''
  let err = ''
  const status = runGraphCli(args, { out: (t) => { out += t }, err: (t) => { err += t } })
  return { out, err, status }
}

await run([
  ['a state entered at one inside it, and then itself, is entered at what it starts at too', () => {
    const { out, status } = graph('checks/graphs/entered.mts')
    strictEqual(status, 0)
    ok(out.includes('findings: none'), out)
  }],
  ['who a state reaches through a call with nothing passed, and fields an await is from written short, are read', () => {
    const { out, err, status } = graph('checks/graphs/written-short.mts')
    strictEqual(status, 0, err)
    ok(out.includes('reaches: tell where()'), out)
    ok(out.includes('loads   lookup: library LOOKUP, from what from names'), out)
  }],
  ['detects states built with hostState, inline forNet<Net>(), and bare state() by resolved State return type', () => {
    const file = join(root, 'checks', 'graphs', 'custom-alias.mts')
    const all = analyseGraphs([file], { tsconfig: join(root, 'tsconfig.json') })
    const graphs = all.get(file) ?? []
    strictEqual(graphs.length, 3, formatGraphs(graphs))
    deepStrictEqual(graphs.map((g) => g.title), ['SettingsShape', 'InlineShape', 'Shape'])
    deepStrictEqual(graphs[0]!.states, ['ready', 'saving'])
    deepStrictEqual(graphs[0]!.answers, ['GET'])
    deepStrictEqual(graphs[0]!.findings, [])
    deepStrictEqual(graphs[1]!.reaches, ["tell 'host/settings'"])
    deepStrictEqual(graphs[1]!.findings, [])
    deepStrictEqual(graphs[2]!.findings, [])
  }],
  ['--tsconfig resolves custom path aliases in external projects', () => {
    const work = mkdtempSync(join(tmpdir(), 'apack-graph-tsconfig-'))
    try {
      const stateIndex = join(root, 'src', 'index.ts').replaceAll('\\', '/')
      writeFileSync(join(work, 'net.ts'), `import { forNet } from '${stateIndex}'\nexport const hostState = forNet<{ systems: { 'host/a': { events: { type: 'PING' }; asks: {} } }; surfaces: {}; views: {} }>()\n`)
      writeFileSync(join(work, 'machine.ts'), `import { hostState } from '#generated/net'\ntype Panel = { data: { n: number } }\nexport const panel = hostState<Panel, { type: 'GO' }>()({ data: { n: 0 }, on: { GO: (_, { tell }) => { tell('host/a', { type: 'PING' }) } } })\n`)
      writeFileSync(join(work, 'tsconfig.json'), JSON.stringify({
        compilerOptions: {
          strict: true, target: 'ES2023', module: 'ESNext', moduleResolution: 'Bundler',
          allowImportingTsExtensions: true, noEmit: true, skipLibCheck: true,
          paths: { '#generated/net': ['./net.ts'] },
        },
        include: ['*.ts'],
      }))
      const r1 = runCli('--tsconfig', join(work, 'tsconfig.json'), join(work, 'machine.ts'))
      strictEqual(r1.status, 0, r1.err)
      ok(r1.out.includes('Panel') && r1.out.includes("reaches: tell 'host/a'") && r1.out.includes('findings: none'), r1.out)
      const r2 = runCli(`--tsconfig=${join(work, 'tsconfig.json')}`, join(work, 'machine.ts'))
      strictEqual(r2.status, 0, r2.err)
      strictEqual(r2.out, r1.out)
    } finally {
      rmSync(work, { recursive: true, force: true })
    }
  }],
  ['given nothing to read, bad flags, or missing files/tsconfig, it says so and fails', () => {
    const none = graph()
    ok(none.status !== 0 && none.err.includes('Name a file'), none.err)
    const missing = graph('checks/graphs/no-such.mts')
    ok(missing.status !== 0 && missing.err.includes('No such file'), missing.err)
    const noTsconfigArg = runCli('--tsconfig')
    ok(noTsconfigArg.status !== 0 && noTsconfigArg.err.includes('Missing path'), noTsconfigArg.err)
    const emptyTsconfigEq = runCli('--tsconfig=')
    ok(emptyTsconfigEq.status !== 0 && emptyTsconfigEq.err.includes('Missing path'), emptyTsconfigEq.err)
    const unknownFlag = runCli('--bogus', 'checks/graphs/entered.mts')
    ok(unknownFlag.status !== 0 && unknownFlag.err.includes('Unknown option'), unknownFlag.err)
    const missingTsconfig = runCli('--tsconfig', 'no-such-tsconfig.json', 'checks/graphs/entered.mts')
    ok(missingTsconfig.status !== 0 && missingTsconfig.err.includes('No such tsconfig'), missingTsconfig.err)
  }],
  ['recognizes scope.<verb>(...) and scope.child(...) without false positives on Function.prototype.call', () => {
    const work = mkdtempSync(join(tmpdir(), 'apack-graph-scope-verbs-'))
    try {
      const stateIndex = join(root, 'src', 'index.ts').replaceAll('\\', '/')
      const file = join(work, 'scope-verbs.ts')
      writeFileSync(file, `
import { forNet } from '${stateIndex}'
type Net = {
  systems: { svc: { events: { type: 'PING' }; asks: { GET: { args: {}; answer: string }; SAVE: { args: {}; answer: void } } } }
  surfaces: { panel: { events: { type: 'UPDATED' } } }
  views: {}
}
const state = forNet<Net>()
const kid = state<{}, { type: 'HI' }>()({ on: { HI: () => {} } })
type PanelShape = {
  data: { flag: boolean }
  starts: { kid: typeof kid }
  calls: { save: 'single' }
}
export const panel = state<PanelShape, { type: 'GO' } | { type: 'STOP' }>()({
  data: { flag: false },
  starts: () => ({ kid }),
  calls: ({ single }) => ({
    save: single('svc', 'SAVE', { done: () => undefined }),
  }),
  async run(scope) {
    await scope.ask('svc', 'GET', {})
  },
  failed: () => {},
  on: {
    GO: (_ev, scope) => {
      void Object.prototype.hasOwnProperty.call(scope.data, 'flag')
      const kidHandle = scope.child('kid')
      scope.tell('svc', { type: 'PING' })
      scope.tell(kidHandle, { type: 'HI' })
      scope.broadcast('panel', { type: 'UPDATED' })
      scope.call('save')
    },
    STOP: (_ev, scope) => {
      scope.cancel('save')
    },
  },
})
`)
      const all = analyseGraphs([file], { tsconfig: join(root, 'tsconfig.json') })
      const graphs = all.get(file) ?? []
      strictEqual(graphs.length, 2, formatGraphs(graphs))
      const panelGraph = graphs[1]!
      deepStrictEqual(panelGraph.reaches, [
        "ask 'svc'",
        "tell 'svc'",
        "tell its 'kid'",
        "broadcast 'panel'",
        "call 'save'",
        "cancel 'save'",
      ])
      deepStrictEqual(panelGraph.findings, [])
    } finally {
      rmSync(work, { recursive: true, force: true })
    }
  }],
  ['emits explicit uncertainty findings for dynamic targets, non-inline definitions, and uninspectable declarations', () => {
    const work = mkdtempSync(join(tmpdir(), 'apack-graph-uncertain-'))
    try {
      const stateIndex = join(root, 'src', 'index.ts').replaceAll('\\', '/')
      const file = join(work, 'uncertain.ts')
      writeFileSync(file, `
import { forNet } from '${stateIndex}'
type Net = {
  systems: Record<string, { events: { type: 'PING' }; asks: { GET: { args: {}; answer: string } } }>
  surfaces: {}
  views: { docs: { all: { args: {}; result: string } } }
  peers: Record<string, { events: { type: 'LOG' } }>
}
const state = forNet<Net>()

type DynShape = { states: { a: {}; b: {}; c: {} }; calls: { save: 'single' } }
const nextTarget = (): string => 'b'
const dynSys = (): string => 'svc'
const dynPeer = (): string => 'audit'
const buildFollows = (follow: any) => ({ docs: follow('docs', 'all', { updated: () => undefined }) })
const calls = ({ single }: any) => ({ save: single('svc', 'GET', { done: () => undefined }) })
const loadOpts = { done: () => undefined }
const extraLoads = {}
const subB = {}
const c = {}

export const dynamicState = state<DynShape, { type: 'GO' }>()({
  initial: 'a',
  follows: buildFollows,
  calls,
  loads: (load) => ({
    ...extraLoads,
    one: load('svc', 'GET', loadOpts),
  }),
  on: {
    GO: (_ev, scope) => {
      const target = dynSys()
      const peer = dynPeer()
      scope.tell(target, { type: 'PING' })
      scope.tell({ peer }, { type: 'LOG' })
      return { at: nextTarget() as 'a' | 'b' & string as string as any }
    },
  },
  states: {
    a: {},
    b: subB,
    c,
  },
})

type BuiltShape = { data: { n: number } }
const builtDef = { data: { n: 0 }, on: { INC: () => ({ data: { n: 1 } }) } }
export const nonInlineState = state<BuiltShape, { type: 'INC' }>()(builtDef)
`)
      const all = analyseGraphs([file], { tsconfig: join(root, 'tsconfig.json') })
      const graphs = all.get(file) ?? []
      strictEqual(graphs.length, 2, formatGraphs(graphs))

      const dyn = graphs[0]!
      ok(dyn.findings.some((f) => f.includes('dynamic move target in GO')), dyn.findings.join('; '))
      ok(!dyn.stays.includes('GO'), `dynamic move should not be classified as stays: ${dyn.stays.join(', ')}`)
      ok(dyn.findings.some((f) => f.includes('dynamic target in tell target')), dyn.findings.join('; '))
      ok(dyn.findings.some((f) => f.includes('dynamic target in tell { peer }')), dyn.findings.join('; '))
      ok(dyn.findings.some((f) => f.includes('could not statically read follows')), dyn.findings.join('; '))
      ok(dyn.findings.some((f) => f.includes('could not statically read calls')), dyn.findings.join('; '))
      ok(dyn.findings.some((f) => f.includes('spread in loads could not be statically read')), dyn.findings.join('; '))
      ok(dyn.findings.some((f) => f.includes('could not statically read loads.one')), dyn.findings.join('; '))
      ok(dyn.findings.some((f) => f.includes('could not statically read b')), dyn.findings.join('; '))
      ok(dyn.findings.some((f) => f.includes('could not statically read c')), dyn.findings.join('; '))

      const nonInline = graphs[1]!
      strictEqual(nonInline.title, 'BuiltShape')
      deepStrictEqual(nonInline.stays, ['INC'])
      ok(nonInline.findings.some((f) => f.includes('definition is not an inline object literal')), nonInline.findings.join('; '))
    } finally {
      rmSync(work, { recursive: true, force: true })
    }
  }],
  ['inspects listen at root and in substates, recording reaches with findings: none', () => {
    const work = mkdtempSync(join(tmpdir(), 'apack-graph-listen-'))
    try {
      const stateIndex = join(root, 'src', 'index.ts').replaceAll('\\', '/')
      const file = join(work, 'listen.ts')
      writeFileSync(file, `
import { forNet } from '${stateIndex}'
type Net = {
  systems: { svc: { events: { type: 'PING' }; asks: { SAVE: { args: {}; answer: void } } } }
  surfaces: { panel: { events: { type: 'UPDATED' } } }
  views: {}
  peers: { audit: { events: { type: 'LOG' } } }
}
const state = forNet<Net>()
type WatcherShape = {
  calls: { save: 'single' }
  states: { active: {}; paused: {} }
}
export const watcher = state<WatcherShape, { type: 'PAUSE' } | { type: 'RESUME' }>()({
  initial: 'active',
  calls: ({ single }) => ({ save: single('svc', 'SAVE', { done: () => undefined }) }),
  listen({ tell, broadcast }) {
    tell('svc', { type: 'PING' })
    broadcast('panel', { type: 'UPDATED' })
    return () => {}
  },
  on: {
    PAUSE: () => ({ at: 'paused' }),
    RESUME: () => ({ at: 'active' }),
  },
  states: {
    active: {
      listen: (scope) => {
        scope.tell({ peer: 'audit' }, { type: 'LOG' })
        scope.call('save')
        return () => { scope.cancel('save') }
      },
    },
    paused: {},
  },
})
`)
      const all = analyseGraphs([file], { tsconfig: join(root, 'tsconfig.json') })
      const graphs = all.get(file) ?? []
      strictEqual(graphs.length, 1, formatGraphs(graphs))
      const g = graphs[0]!
      deepStrictEqual(g.reaches, [
        "tell 'svc'",
        "broadcast 'panel'",
        "tell { peer: 'audit' }",
        "call 'save'",
        "cancel 'save'",
      ])
      deepStrictEqual(g.findings, [])
      ok(g.text.includes('findings: none'), g.text)
    } finally {
      rmSync(work, { recursive: true, force: true })
    }
  }],
  ["inspects timers (with and without done, pure TTL, whenArmed: 'ignore', transitions) and flags unused timers", () => {
    const work = mkdtempSync(join(tmpdir(), 'apack-graph-arms-'))
    try {
      const stateIndex = join(root, 'src', 'index.ts').replaceAll('\\', '/')
      const file = join(work, 'arms.ts')
      writeFileSync(file, `
import { state } from '${stateIndex}'
type Shape = {
  data: { count: number }
  arms: {
    pulse: 'single'
    timeout: 'single'
    backoff: { single: 'at arm' }
    flash: 'each'
    unused: 'single'
  }
  states: { active: {}; timedOut: {} }
}
export const timed = state<Shape, { type: 'GO' } | { type: 'STOP' }>()({
  data: { count: 0 },
  initial: 'active',
  arms: ({ single, each }) => ({
    pulse: single({ after: 300 }),
    timeout: single({ after: 5000, done: () => ({ at: 'timedOut' }) }),
    backoff: single({ whenArmed: 'ignore', done: ({ data }) => ({ data: { count: data.count + 1 } }) }),
    flash: each({ after: 200, done: ({ data }) => ({ data: { count: data.count + 1 } }) }),
    unused: single({ after: 100 }),
  }),
  on: {
    GO: (_, { arm }) => {
      arm('pulse')
      arm('timeout')
      arm('backoff', 250)
      arm('flash', 'k')
    },
    STOP: (_, { disarm }) => {
      disarm('pulse')
      disarm('flash')
    },
  },
  states: {
    active: {},
    timedOut: {},
  },
})
`)
      const all = analyseGraphs([file], { tsconfig: join(root, 'tsconfig.json') })
      const graphs = all.get(file) ?? []
      strictEqual(graphs.length, 1, formatGraphs(graphs))
      const g = graphs[0]!
      deepStrictEqual(g.arms, [
        'pulse: 300ms, one at a time',
        'timeout: 5000ms, one at a time',
        'backoff: ms at arm, one at a time, ignored while armed',
        'flash: 200ms, for each key it is told',
        'unused: 100ms, one at a time',
      ])
      deepStrictEqual(g.moves, [{ from: 'anywhere', on: 'timeout (done)', to: ['timedOut'] }])
      ok(g.stays.includes('backoff (done)'), g.stays.join(', '))
      ok(g.stays.includes('flash (done)'), g.stays.join(', '))
      deepStrictEqual(g.reaches, [
        "arm 'pulse'",
        "arm 'timeout'",
        "arm 'backoff'",
        "arm 'flash'",
        "disarm 'pulse'",
        "disarm 'flash'",
      ])
      // `timedOut` is entered by `timeout (done)`, so only `unused` is flagged as never armed.
      deepStrictEqual(g.findings, ['nothing arms unused'])
      ok(g.text.includes('  arms    pulse: 300ms, one at a time'), g.text)
    } finally {
      rmSync(work, { recursive: true, force: true })
    }
  }],
  ['handles destructured arm aliases and suppresses unused-timer findings when arm or scope leaves the literal', () => {
    const work = mkdtempSync(join(tmpdir(), 'apack-graph-arms-helpers-'))
    try {
      const stateIndex = join(root, 'src', 'index.ts').replaceAll('\\', '/')
      const file = join(work, 'helpers.ts')
      writeFileSync(file, `
import { state, type EventScope, type Net } from '${stateIndex}'

type AliasShape = {
  arms: { viaAlias: 'single'; dead: 'single' }
}
export const withAlias = state<AliasShape, { type: 'GO' }>()({
  arms: ({ single }) => ({ viaAlias: single({ after: 100 }), dead: single({ after: 200 }) }),
  on: {
    GO: (_, { arm: startTimer }) => { startTimer('viaAlias') },
  },
})

function armViaHelper(schedule: (name: 'viaArm') => void) { schedule('viaArm') }
export const withArmEscape = state<{ arms: { viaArm: 'single' } }, { type: 'GO' }>()({
  arms: ({ single }) => ({ viaArm: single({ after: 50 }) }),
  on: { GO: (_, { arm }) => { armViaHelper(arm) } },
})

type ScopeShape = { arms: { viaScope: 'single' } }
type ScopeEv = { type: 'GO' }
const armViaScope = (s: Pick<EventScope<ScopeShape, '', ScopeEv, Net>, 'arm'>) => { s.arm('viaScope') }
export const withScopeEscape = state<ScopeShape, ScopeEv>()({
  arms: ({ single }) => ({ viaScope: single({ after: 50 }) }),
  on: { GO: (_, scope) => { armViaScope(scope) } },
})

type HandlerShape = { arms: { t: 'single' } }
const onGo = (_: { type: 'GO' }, { arm }: EventScope<HandlerShape, '', { type: 'GO' }, Net>) => { arm('t') }
export const withExternalHandler = state<HandlerShape, { type: 'GO' }>()({
  arms: ({ single }) => ({ t: single({ after: 50 }) }),
  on: { GO: onGo },
})

const onTable = { GO: onGo }
export const withExternalOnTable = state<HandlerShape, { type: 'GO' }>()({
  arms: ({ single }) => ({ t: single({ after: 50 }) }),
  on: onTable,
})
`)
      const all = analyseGraphs([file], { tsconfig: join(root, 'tsconfig.json') })
      const graphs = all.get(file) ?? []
      strictEqual(graphs.length, 5, formatGraphs(graphs))

      deepStrictEqual(graphs[0]!.reaches, ["arm 'viaAlias'"])
      deepStrictEqual(graphs[0]!.findings, ['nothing arms dead'])
      deepStrictEqual(graphs[1]!.findings, [])
      deepStrictEqual(graphs[2]!.findings, [])
      deepStrictEqual(graphs[3]!.findings, [])
      deepStrictEqual(graphs[4]!.findings, [])
    } finally {
      rmSync(work, { recursive: true, force: true })
    }
  }],
  ['tracks timer reachability from non-done sources and resolves arm by declaring path', () => {
    const work = mkdtempSync(join(tmpdir(), 'apack-graph-arms-reachability-'))
    try {
      const stateIndex = join(root, 'src', 'index.ts').replaceAll('\\', '/')
      const file = join(work, 'reachability.ts')
      writeFileSync(file, `
import { state } from '${stateIndex}'

type SelfLoopShape = { arms: { loop: 'single' } }
export const selfLoop = state<SelfLoopShape, never>()({
  arms: ({ single }) => ({
    loop: single({ after: 100, done: ({ arm }) => { arm('loop') } }),
  }),
})

type DeadChainShape = { arms: { first: 'single'; second: 'single'; ping: 'single'; pong: 'single' } }
export const deadChain = state<DeadChainShape, never>()({
  arms: ({ single }) => ({
    first: single({ after: 100, done: ({ arm }) => { arm('second') } }),
    second: single({ after: 100, done: ({ arm }) => { arm('second') } }),
    ping: single({ after: 100, done: ({ arm }) => { arm('pong') } }),
    pong: single({ after: 100, done: ({ arm }) => { arm('ping') } }),
  }),
})

type LiveChainShape = { arms: { step2: 'single'; step1: 'single'; step3: 'single' } }
export const liveChain = state<LiveChainShape, { type: 'GO' }>()({
  arms: ({ single }) => ({
    // Declared out of topological order so reachability must propagate across multiple hops (step1 -> step2 -> step3).
    step2: single({ after: 100, done: ({ arm }) => { arm('step3') } }),
    step1: single({ after: 100, done: ({ arm }) => { arm('step2') } }),
    step3: single({ after: 100, done: ({ arm }) => { arm('step3') } }),
  }),
  on: { GO: (_, { arm }) => { arm('step1') } },
})

type SiblingsShape = {
  states: {
    a: { arms: { t: 'single' } }
    b: { arms: { t: 'single' } }
  }
}
export const siblingTimers = state<SiblingsShape, { type: 'GO' } | { type: 'NEXT' }>()({
  initial: 'a',
  states: {
    a: {
      arms: ({ single }) => ({ t: single({ after: 100 }) }),
      on: {
        GO: (_, { arm }) => { arm('t') },
        NEXT: () => ({ at: 'b' }),
      },
    },
    b: {
      arms: ({ single }) => ({ t: single({ after: 100 }) }),
    },
  },
})

type ParentArmedFromChildShape = {
  arms: { keepalive: 'single' }
  states: { active: {}; idle: {} }
}
export const parentArmedFromChild = state<ParentArmedFromChildShape, { type: 'GO' } | { type: 'STOP' }>()({
  initial: 'active',
  arms: ({ single }) => ({ keepalive: single({ after: 100 }) }),
  states: {
    active: {
      on: {
        GO: (_, { arm }) => { arm('keepalive') },
        STOP: () => ({ at: 'idle' }),
      },
    },
    idle: {},
  },
})

type QuotedTimersShape = {
  arms: {
    'live-first': 'single'
    'live-next': 'single'
    'dead-first': 'single'
    'dead-next': 'single'
  }
}
export const quotedTimers = state<QuotedTimersShape, { type: 'GO' }>()({
  arms: ({ single }) => ({
    'live-first': single({ after: 100, done: ({ arm }) => { arm('live-next') } }),
    'live-next': single({ after: 100 }),
    'dead-first': single({ after: 100, done: ({ arm }) => { arm('dead-next') } }),
    'dead-next': single({ after: 100 }),
  }),
  on: { GO: (_, { arm }) => { arm('live-first') } },
})

const SUB = 'active' as const
const W = 'pulse' as const
type ComputedNamesShape = {
  states: {
    [SUB]: { arms: { [W]: 'single' } }
    idle: {}
  }
}
export const computedNames = state<ComputedNamesShape, { type: 'GO' } | { type: 'STOP' }>()({
  initial: SUB,
  states: {
    [SUB]: {
      arms: ({ single }) => ({ [W]: single({ after: 100 }) }),
      on: {
        GO: (_, { arm }) => { arm(W) },
        STOP: () => ({ at: 'idle' }),
      },
    },
    idle: {},
  },
})

type UnenteredArmShape = {
  arms: { keepalive: 'single' }
  states: { live: {}; dead: { arms: { inner: 'single' } } }
}
export const unenteredArm = state<UnenteredArmShape, { type: 'GO' }>()({
  initial: 'live',
  arms: ({ single }) => ({ keepalive: single({ after: 100 }) }),
  states: {
    live: ({ on: { GO: () => {} } }),
    dead: ({
      arms: ({ single }) => ({ inner: single({ after: 50 }) }),
      on: { GO: (_, { arm }) => { arm('keepalive'); arm('inner') } },
    }),
  },
})

type LocalArmVarShape = {
  data: { arm: number }
  arms: { dead: 'single' }
}
export const localArmVar = state<LocalArmVarShape, { type: 'SET'; arm: number }>()({
  data: { arm: 0 },
  arms: ({ single }) => ({ dead: single({ after: 100 }) }),
  on: {
    SET: ({ arm }) => ({ data: { arm } }),
  },
})

function armFromBox(box: { arm: (name: 'viaBox') => void }) { box.arm('viaBox') }
export const shorthandScopeArmEscape = state<{ arms: { viaBox: 'single' } }, { type: 'GO' }>()({
  arms: ({ single }) => ({ viaBox: single({ after: 100 }) }),
  on: {
    GO: (_, { arm }) => { armFromBox({ arm }) },
  },
})
`)
      const all = analyseGraphs([file], { tsconfig: join(root, 'tsconfig.json') })
      const graphs = all.get(file) ?? []
      strictEqual(graphs.length, 10, formatGraphs(graphs))

      deepStrictEqual(graphs[0]!.findings, ['nothing arms loop except its own done'])
      deepStrictEqual(graphs[1]!.findings, [
        'nothing arms first',
        'nothing arms second except the done of second, first, which cannot fire',
        'nothing arms ping except the done of pong, which cannot fire',
        'nothing arms pong except the done of ping, which cannot fire',
      ])
      deepStrictEqual(graphs[2]!.findings, [])
      deepStrictEqual(graphs[3]!.findings, ['nothing arms t in b'])
      deepStrictEqual(graphs[4]!.findings, [])
      deepStrictEqual(graphs[5]!.findings, [
        'nothing arms dead-first',
        'nothing arms dead-next except the done of dead-first, which cannot fire',
      ])
      deepStrictEqual(graphs[6]!.arms, ['pulse in active: 100ms, one at a time'])
      deepStrictEqual(graphs[6]!.findings, [])
      deepStrictEqual(graphs[7]!.findings, ['dead is never entered', 'nothing arms keepalive'])
      // An unrelated event/data field named `arm` does not suppress unused-timer findings,
      // while escaping `scope.arm` via `{ arm }` shorthand still suppresses them.
      deepStrictEqual(graphs[8]!.findings, ['nothing arms dead'])
      deepStrictEqual(graphs[9]!.findings, [])
    } finally {
      rmSync(work, { recursive: true, force: true })
    }
  }],
])
