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
  calls: { save: 'one' }
}
export const panel = state<PanelShape, { type: 'GO' } | { type: 'STOP' }>()({
  data: { flag: false },
  starts: () => ({ kid }),
  calls: ({ one }) => ({
    save: one('svc', 'SAVE', { done: () => undefined }),
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

type DynShape = { states: { a: {}; b: {}; c: {} }; calls: { save: 'one' } }
const nextTarget = (): string => 'b'
const dynSys = (): string => 'svc'
const dynPeer = (): string => 'audit'
const buildFollows = (follow: any) => ({ docs: follow('docs', 'all', { updated: () => undefined }) })
const calls = ({ one }: any) => ({ save: one('svc', 'GET', { done: () => undefined }) })
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
  calls: { save: 'one' }
  states: { active: {}; paused: {} }
}
export const watcher = state<WatcherShape, { type: 'PAUSE' } | { type: 'RESUME' }>()({
  initial: 'active',
  calls: ({ one }) => ({ save: one('svc', 'SAVE', { done: () => undefined }) }),
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
  ['inspects waits (direct done, options object, pure TTL, reset: false, transitions) and flags unused waits', () => {
    const work = mkdtempSync(join(tmpdir(), 'apack-graph-waits-'))
    try {
      const stateIndex = join(root, 'src', 'index.ts').replaceAll('\\', '/')
      const file = join(work, 'waits.ts')
      writeFileSync(file, `
import { state } from '${stateIndex}'
type Shape = {
  data: { count: number }
  waits: {
    pulse: 'one'
    timeout: 'one'
    backoff: { one: 'ms' }
    flash: 'each'
    unused: 'one'
  }
  states: { active: {}; timedOut: {} }
}
export const timed = state<Shape, { type: 'GO' } | { type: 'STOP' }>()({
  data: { count: 0 },
  initial: 'active',
  waits: ({ one, each }) => ({
    pulse: one(300),
    timeout: one(5000, () => ({ at: 'timedOut' })),
    backoff: one({ reset: false, done: ({ data }) => ({ data: { count: data.count + 1 } }) }),
    flash: each(200, ({ data }) => ({ data: { count: data.count + 1 } })),
    unused: one(100),
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
      deepStrictEqual(g.waits, [
        'pulse: 300ms, one at a time',
        'timeout: 5000ms, one at a time',
        'backoff: ms at arm, one at a time, no reset',
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
      ok(g.text.includes('  waits   pulse: 300ms, one at a time'), g.text)
    } finally {
      rmSync(work, { recursive: true, force: true })
    }
  }],
])
