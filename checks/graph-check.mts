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

/** What the tool finds in each state a source declares, in the order they are written, with the files it is written `beside`. */
const findingsIn = (source: string, beside: Record<string, string> = {}): string[][] => {
  const work = mkdtempSync(join(tmpdir(), 'apack-graph-findings-'))
  try {
    const file = join(work, 'states.ts')
    for (const [name, written] of Object.entries(beside)) writeFileSync(join(work, name), written)
    writeFileSync(file, `import { answered, forNet, state } from '${join(root, 'src', 'index.ts').replaceAll('\\', '/')}'\n${source}`)
    return (analyseGraphs([file], { tsconfig: join(root, 'tsconfig.json') }).get(file) ?? []).map((g) => [...g.findings])
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}
/**
 * A state with a wait of its own and a wait in each of two states beside each other, `inA` written in the first
 * and `inB` in the second.
 */
const twoBranches = (inA: string, moves = `NEXT: () => ({ at: 'b' })`, inB = ''): string => `
const anyName = (): any => 't'
const quiet = (): void => {}
function hand(_: unknown): void {}
type Shape = { waits: { top: 'one' }; states: { a: { waits: { mine: 'one' } }; b: { waits: { side: 'one' } } } }
export const branches = state<Shape, { type: 'GO' } | { type: 'NEXT' }>()({
  initial: 'a',
  waits: ({ one }) => ({ top: one(100) }),
  on: { ${moves} },
  states: {
    a: { waits: ({ one }) => ({ mine: one(100) }), ${inA} },
    b: { waits: ({ one }) => ({ side: one(100) }), ${inB} },
  },
})
`
/**
 * A wait armed only in `box.dead`, which no move that is read enters, beside a state `other` holding `inOther`:
 * what could enter `box.dead` if it cannot be read.
 */
const entryFrom = (inOther: string): string => `
const anyHandler: any = () => ({ at: 'box.dead' })
declare const either: ((a: string) => void) | ((a: number, b: number) => { at: 'box.dead' })
const quiet = (): void => {}
function twice(): void
function twice(event?: unknown): void
function twice(): void {}
type Shape = { states: { box: { waits: { keep: 'one' }; states: { live: {}; dead: {} } }; other: {} } }
export const entry = state<Shape, { type: 'GO' } | { type: 'NEXT' }>()({
  initial: 'box',
  on: { NEXT: () => ({ at: 'other' }) },
  states: {
    box: {
      initial: 'live',
      waits: ({ one }) => ({ keep: one(100) }),
      states: { live: {}, dead: { on: { GO: (_, { arm }) => { arm('keep') } } } },
    },
    other: { ${inOther} },
  },
})
`

/** What is said of what cannot happen, without the notes of what could not be read and the events nothing takes. */
const dead = (found: readonly string[]): string[] => found.filter((finding) => finding.includes(' is never entered') || finding.startsWith('nothing arms '))
/**
 * A state with a wait at each depth: `top` everywhere, `mine` in `a`, `deep` and `other` in the two states inside
 * `a`, `side` in `b`. Every state is entered from `start` but `far`, which nothing read enters and where alone
 * `top` is armed. `what` is written in the state `at`, in a definition called `name`.
 */
const placed = (at: string, what: string, name: string): string => {
  const put = (path: string): string => (at === path ? `${what},` : '')
  return `
export const ${name} = forNet<PlacedNet>()<Placed, PlacedEvent, { GET: { args: {}; answer: number } }>()({
  initial: 'start',
  waits: ({ one }) => ({ top: one(100) }),
  ${put('')}
  states: {
    start: { on: { A: () => ({ at: 'a' }), X: () => ({ at: 'a.x' }), Y: () => ({ at: 'a.y' }), B: () => ({ at: 'b' }) } },
    a: { initial: 'x', waits: ({ one }) => ({ mine: one(100) }), ${put('a')} states: {
      x: { waits: ({ one }) => ({ deep: one(100) }), ${put('a.x')} },
      y: { waits: ({ one }) => ({ other: one(100) }) },
    } },
    b: { waits: ({ one }) => ({ side: one(100) }) },
    far: { initial: 'in', ${put('far')} states: { in: { on: { GO: (_, { arm }) => { arm('top') } } } } },
  },
})
`
}
const PLACED = `
import { imported } from './handlers.ts'
declare const flag: boolean
declare function ambient(): void
const anyName = (): any => 't'
const anyTable: any = {}
const quiet = (): void => {}
const again = quiet
const GO = quiet
function declared(): void {}
const typedVoid: () => void = () => ({ at: 'far' })
const chosen = flag ? () => {} : () => ({ at: 'far' as const })
const heard = () => (): void => {}
const work = (): void => {}
const moreOptions = {} as { done: () => { at: 'far' } }
const buildLoads = (load: any) => ({ far: load('svc', 'X', { from: [] }) })
function hand(_: unknown): void {}
const wrapped = (load: any): any => load('svc', 'X', { from: [], done: () => ({ at: 'far' }) })
const other = (..._: any[]): any => ({ of: 'svc', ask: 'X', from: [], done: () => ({ at: 'far' }) })
type PlacedNet = { systems: { svc: { events: never; asks: { X: { args: {}; answer: void } } } }; surfaces: {}; views: { docs: { all: { args: {}; result: string } } } }
type Placed = {
  internal: { type: 'GO' }
  waits: { top: 'one' }
  states: {
    start: {}
    a: { waits: { mine: 'one' }; states: { x: { waits: { deep: 'one' } }; y: { waits: { other: 'one' } } } }
    b: { waits: { side: 'one' } }
    far: { states: { in: {} } }
  }
}
type PlacedEvent = { type: 'GO' } | { type: 'A' } | { type: 'X' } | { type: 'Y' } | { type: 'B' }
`
const HANDLERS = { 'handlers.ts': 'export const imported = (): void => {}\n' }
/** What is written in a state, by what of it is unread: nothing, a wait it could arm, a state it could enter, both, or anything a state holds. */
const UNREAD = {
  nothing: [
    `on: { GO: () => {} }`,
    `on: { GO: (() => {}) }`,
    `on: { GO: function () {} }`,
    `on: { GO() {} }`,
    `on: { ['GO']: () => {} }`,
    `internal: { GO() {} }`,
    `answers: { GET: () => 1 }`,
    `run() {}`,
    `run: () => {}, failed() {}`,
    `listen: () => {}`,
    `listen() {}`,
    `loads: (load) => ({ got: load('svc', 'X', { from: [], done() {} }) })`,
    `follows: (follow) => ({ docs: follow('docs', 'all', { from: [], updated: () => {} }) })`,
  ],
  arms: [
    `on: { GO: quiet }`,
    `on: { GO: again }`,
    `on: { GO }`,
    `on: { GO: declared }`,
    `on: { GO: imported }`,
    `on: { GO: (_, { arm }) => { hand(arm) } }`,
    `on: { GO: (_, scope) => { hand(scope) } }`,
    `on: { GO: (_, { arm }) => { arm(anyName()) } }`,
    `on: { GO: (_, { tell, broadcast, onExit, ...rest }) => { rest.arm('side') } }`,
    `internal: { GO: quiet }`,
    `listen: heard`,
    `listen: flag ? heard : heard`,
    `run: work`,
  ],
  moves: [
    `on: { GO: (): any => undefined }`,
    `on: { GO: () => ({ at: anyName() }) }`,
    `on: { ['G' + 'O']: () => {} }`,
    `answers: { GET: () => answered(1, anyName()) }`,
    `run: (): any => undefined`,
  ],
  both: [
    `on: anyTable`,
    `internal: anyTable`,
    `answers: anyTable`,
    `on: { ...({} as Record<string, () => void>) }`,
    `on: { GO: flag ? () => {} : () => ({ at: 'far' as const }) }`,
    `on: { GO: typedVoid }`,
    `on: { GO: chosen }`,
    `on: { GO: ambient }`,
    `run: flag ? work : work`,
    `loads: buildLoads`,
    `loads: (load) => ({ ...({} as {}) })`,
    `loads: (load) => ({ got: load('svc', 'X', { from: [], ...moreOptions }) })`,
    `loads: (load) => ({ got: load('svc', 'X', { from: [], [anyName()]: 1, done: () => {} }) })`,
    `loads: (load) => ({ got: load('svc', 'X', { from: [], done: typedVoid }) })`,
    `loads: (load) => ({ got: load('svc', 'X', moreOptions as never) })`,
    `loads: (load) => ({ [anyName()]: load('svc', 'X', { from: [], done: () => {} }) })`,
    `loads: (load) => ({ got: wrapped(load) })`,
    `loads: () => ({ got: other('svc', 'X', { from: [], done: () => {} }) })`,
    `loads: ({ ...helpers }: any) => ({ got: helpers('svc', 'X', { from: [], done: () => {} }) })`,
    `follows: (follow) => ({ docs: follow('docs', 'all', { from: [], updated: typedVoid }) })`,
  ],
  held: [
    `...({} as {})`,
    `[anyName()]: 1`,
    `get listen() { return () => {} }`,
  ],
} as const

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
  ['one for each key that is also from fields says both, and one that names no fields says its keys alone', () => {
    const { out, err, status } = graph('checks/graphs/keyed-from.mts')
    strictEqual(status, 0, err)
    ok(out.includes('loads   diff: repo DIFF, one for each key of open, each from rev, depth'), out)
    ok(out.includes('once: repo DIFF, one for each key of open\n'), out)
    ok(out.includes('follows blame: repo blame, one for each key of open, each from rev'), out)
    ok(out.includes('findings: none'), out)
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
  ['handles destructured arm aliases and suppresses unused-wait findings when arm or scope leaves the literal', () => {
    const work = mkdtempSync(join(tmpdir(), 'apack-graph-waits-helpers-'))
    try {
      const stateIndex = join(root, 'src', 'index.ts').replaceAll('\\', '/')
      const file = join(work, 'helpers.ts')
      writeFileSync(file, `
import { state, type EventScope, type Net } from '${stateIndex}'

type AliasShape = {
  waits: { viaAlias: 'one'; dead: 'one' }
}
export const withAlias = state<AliasShape, { type: 'GO' }>()({
  waits: ({ one }) => ({ viaAlias: one(100), dead: one(200) }),
  on: {
    GO: (_, { arm: startTimer }) => { startTimer('viaAlias') },
  },
})

function armViaHelper(schedule: (name: 'viaArm') => void) { schedule('viaArm') }
export const withArmEscape = state<{ waits: { viaArm: 'one' } }, { type: 'GO' }>()({
  waits: ({ one }) => ({ viaArm: one(50) }),
  on: { GO: (_, { arm }) => { armViaHelper(arm) } },
})

type ScopeShape = { waits: { viaScope: 'one' } }
type ScopeEv = { type: 'GO' }
const armViaScope = (s: Pick<EventScope<ScopeShape, '', ScopeEv, Net>, 'arm'>) => { s.arm('viaScope') }
export const withScopeEscape = state<ScopeShape, ScopeEv>()({
  waits: ({ one }) => ({ viaScope: one(50) }),
  on: { GO: (_, scope) => { armViaScope(scope) } },
})

type HandlerShape = { waits: { t: 'one' } }
const onGo = (_: { type: 'GO' }, { arm }: EventScope<HandlerShape, '', { type: 'GO' }, Net>) => { arm('t') }
export const withExternalHandler = state<HandlerShape, { type: 'GO' }>()({
  waits: ({ one }) => ({ t: one(50) }),
  on: { GO: onGo },
})

const onTable = { GO: onGo }
export const withExternalOnTable = state<HandlerShape, { type: 'GO' }>()({
  waits: ({ one }) => ({ t: one(50) }),
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
  ['tracks wait reachability from non-done sources and resolves arm by declaring path', () => {
    const work = mkdtempSync(join(tmpdir(), 'apack-graph-waits-reachability-'))
    try {
      const stateIndex = join(root, 'src', 'index.ts').replaceAll('\\', '/')
      const file = join(work, 'reachability.ts')
      writeFileSync(file, `
import { state } from '${stateIndex}'

type SelfLoopShape = { waits: { loop: 'one' } }
export const selfLoop = state<SelfLoopShape, never>()({
  waits: ({ one }) => ({
    loop: one(100, ({ arm }) => { arm('loop') }),
  }),
})

type DeadChainShape = { waits: { first: 'one'; second: 'one'; ping: 'one'; pong: 'one' } }
export const deadChain = state<DeadChainShape, never>()({
  waits: ({ one }) => ({
    first: one(100, ({ arm }) => { arm('second') }),
    second: one(100, ({ arm }) => { arm('second') }),
    ping: one(100, ({ arm }) => { arm('pong') }),
    pong: one(100, ({ arm }) => { arm('ping') }),
  }),
})

type LiveChainShape = { waits: { step2: 'one'; step1: 'one'; step3: 'one' } }
export const liveChain = state<LiveChainShape, { type: 'GO' }>()({
  waits: ({ one }) => ({
    // Declared out of topological order so reachability must propagate across multiple hops (step1 -> step2 -> step3).
    step2: one(100, ({ arm }) => { arm('step3') }),
    step1: one(100, ({ arm }) => { arm('step2') }),
    step3: one(100, ({ arm }) => { arm('step3') }),
  }),
  on: { GO: (_, { arm }) => { arm('step1') } },
})

type SiblingsShape = {
  states: {
    a: { waits: { t: 'one' } }
    b: { waits: { t: 'one' } }
  }
}
export const siblingWaits = state<SiblingsShape, { type: 'GO' } | { type: 'NEXT' }>()({
  initial: 'a',
  states: {
    a: {
      waits: ({ one }) => ({ t: one(100) }),
      on: {
        GO: (_, { arm }) => { arm('t') },
        NEXT: () => ({ at: 'b' }),
      },
    },
    b: {
      waits: ({ one }) => ({ t: one(100) }),
    },
  },
})

type ParentArmedFromChildShape = {
  waits: { keepalive: 'one' }
  states: { active: {}; idle: {} }
}
export const parentArmedFromChild = state<ParentArmedFromChildShape, { type: 'GO' } | { type: 'STOP' }>()({
  initial: 'active',
  waits: ({ one }) => ({ keepalive: one(100) }),
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

type QuotedWaitsShape = {
  waits: {
    'live-first': 'one'
    'live-next': 'one'
    'dead-first': 'one'
    'dead-next': 'one'
  }
}
export const quotedWaits = state<QuotedWaitsShape, { type: 'GO' }>()({
  waits: ({ one }) => ({
    'live-first': one(100, ({ arm }) => { arm('live-next') }),
    'live-next': one(100),
    'dead-first': one(100, ({ arm }) => { arm('dead-next') }),
    'dead-next': one(100),
  }),
  on: { GO: (_, { arm }) => { arm('live-first') } },
})

const SUB = 'active' as const
const W = 'pulse' as const
type ComputedNamesShape = {
  states: {
    [SUB]: { waits: { [W]: 'one' } }
    idle: {}
  }
}
export const computedNames = state<ComputedNamesShape, { type: 'GO' } | { type: 'STOP' }>()({
  initial: SUB,
  states: {
    [SUB]: {
      waits: ({ one }) => ({ [W]: one(100) }),
      on: {
        GO: (_, { arm }) => { arm(W) },
        STOP: () => ({ at: 'idle' }),
      },
    },
    idle: {},
  },
})

type UnenteredArmShape = {
  waits: { keepalive: 'one' }
  states: { live: {}; dead: { waits: { inner: 'one' } } }
}
export const unenteredArm = state<UnenteredArmShape, { type: 'GO' }>()({
  initial: 'live',
  waits: ({ one }) => ({ keepalive: one(100) }),
  states: {
    live: ({ on: { GO: () => {} } }),
    dead: ({
      waits: ({ one }) => ({ inner: one(50) }),
      on: { GO: (_, { arm }) => { arm('keepalive'); arm('inner') } },
    }),
  },
})

type LocalArmVarShape = {
  data: { arm: number }
  waits: { dead: 'one' }
}
export const localArmVar = state<LocalArmVarShape, { type: 'SET'; arm: number }>()({
  data: { arm: 0 },
  waits: ({ one }) => ({ dead: one(100) }),
  on: {
    SET: ({ arm }) => ({ data: { arm } }),
  },
})

function armFromBox(box: { arm: (name: 'viaBox') => void }) { box.arm('viaBox') }
export const shorthandScopeArmEscape = state<{ waits: { viaBox: 'one' } }, { type: 'GO' }>()({
  waits: ({ one }) => ({ viaBox: one(100) }),
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
        'nothing arms first, so nothing arms second',
        'nothing arms ping except the done of pong, so nothing arms pong',
      ])
      deepStrictEqual(graphs[2]!.findings, [])
      deepStrictEqual(graphs[3]!.findings, ['nothing arms t in b'])
      deepStrictEqual(graphs[4]!.findings, [])
      deepStrictEqual(graphs[5]!.findings, ['nothing arms dead-first, so nothing arms dead-next'])
      deepStrictEqual(graphs[6]!.waits, ['pulse in active: 100ms, one at a time'])
      deepStrictEqual(graphs[6]!.findings, [])
      deepStrictEqual(graphs[7]!.findings, ['dead is never entered, so nothing arms keepalive'])
      // An unrelated event/data field named `arm` does not suppress unused-wait findings,
      // while escaping `scope.arm` via `{ arm }` shorthand still suppresses them.
      deepStrictEqual(graphs[8]!.findings, ['nothing arms dead'])
      deepStrictEqual(graphs[9]!.findings, [])
    } finally {
      rmSync(work, { recursive: true, force: true })
    }
  }],
  ['an arm counts only in a state that can be entered, and a wait armed only where none can is said by that state', () => {
    const [deadOnly, alsoLive, fromDeadDone, mixed] = findingsIn(`
type Shape = { waits: { t: 'one' }; states: { live: {}; dead: {} } }
export const deadOnly = state<Shape, { type: 'GO' }>()({
  initial: 'live',
  waits: ({ one }) => ({ t: one(100) }),
  states: { live: {}, dead: { on: { GO: (_, { arm }) => { arm('t') } } } },
})
export const alsoLive = state<Shape, { type: 'GO' }>()({
  initial: 'live',
  waits: ({ one }) => ({ t: one(100) }),
  states: {
    live: { on: { GO: (_, { arm }) => { arm('t') } } },
    dead: { on: { GO: (_, { arm }) => { arm('t') } } },
  },
})

type DoneShape = { waits: { keep: 'one' }; states: { live: {}; dead: { waits: { b: 'one' } } } }
export const fromDeadDone = state<DoneShape, never>()({
  initial: 'live',
  waits: ({ one }) => ({ keep: one(100) }),
  states: {
    live: {},
    dead: { waits: ({ one }) => ({ b: one(100, ({ arm }) => { arm('keep') }) }) },
  },
})

type MixedShape = { waits: { t: 'one'; u: 'one' }; states: { live: {}; dead: {}; gone: {} } }
export const mixed = state<MixedShape, { type: 'GO' }>()({
  initial: 'live',
  waits: ({ one }) => ({
    t: one(100, ({ arm }) => { arm('t'); arm('u') }),
    u: one(100),
  }),
  states: {
    live: {},
    dead: { on: { GO: (_, { arm }) => { arm('t'); arm('u') } } },
    gone: { on: { GO: (_, { arm }) => { arm('u') } } },
  },
})
`)
    deepStrictEqual(deadOnly, ['dead is never entered, so nothing arms t'])
    deepStrictEqual(alsoLive, ['dead is never entered'])
    deepStrictEqual(fromDeadDone, ['dead is never entered, so nothing arms keep'])
    // What two causes each lead to is said once, by the first of them.
    deepStrictEqual(mixed, ['dead is never entered, so nothing arms t, u', 'gone is never entered'])
  }],
  ['a handler that cannot be read hides the waits its own state and the states around it declare, and no others', () => {
    const [found] = findingsIn(`
const quiet = (): void => {}
type Shape = {
  waits: { top: 'one' }
  states: {
    a: { waits: { side: 'one' } }
    ab: {
      waits: { mid: 'one' }
      states: {
        sub: { waits: { own: 'one' }; states: { deep: { waits: { below: 'one' } }; rest: {} } }
        other: { waits: { beside: 'one' } }
      }
    }
  }
}
export const branch = state<Shape, { type: 'GO' } | { type: 'A' } | { type: 'DEEP' } | { type: 'OTHER' }>()({
  initial: 'ab',
  waits: ({ one }) => ({ top: one(100) }),
  on: { A: () => ({ at: 'a' }), DEEP: () => ({ at: 'ab.sub.deep' }), OTHER: () => ({ at: 'ab.other' }) },
  states: {
    a: { waits: ({ one }) => ({ side: one(100) }) },
    ab: {
      initial: 'sub',
      waits: ({ one }) => ({ mid: one(100) }),
      states: {
        sub: {
          initial: 'rest',
          waits: ({ one }) => ({ own: one(100) }),
          on: { GO: quiet },
          states: { deep: { waits: ({ one }) => ({ below: one(100) }) }, rest: {} },
        },
        other: { waits: ({ one }) => ({ beside: one(100) }) },
      },
    },
  },
})
`)
    deepStrictEqual(found, ['nothing arms side in a', 'nothing arms below in ab.sub.deep', 'nothing arms beside in ab.other'])
  }],
  ['an arm of a name that is not known, and an arm handed elsewhere, hide as a handler that cannot be read does', () => {
    deepStrictEqual(findingsIn(twoBranches(`on: { GO: (_, { arm }) => { arm(anyName()) } }`)), [['nothing arms side in b', 'dynamic target in arm anyName()']])
    deepStrictEqual(findingsIn(twoBranches(`on: { GO: (_, { arm }) => { hand(arm) } }`)), [['nothing arms side in b']])
    deepStrictEqual(findingsIn(twoBranches(`on: { GO: (_, scope) => { hand(scope) } }`)), [['nothing arms side in b']])
    deepStrictEqual(findingsIn(twoBranches(`on: { GO: quiet }`)), [['nothing arms side in b']])
  }],
  ['each kind of handler, written elsewhere, hides the waits of the state it is in once it can run', () => {
    deepStrictEqual(findingsIn(`
const quiet = (): void => {}
const heard = () => (): void => {}
type Waits = { waits: { t: 'one' } }
export const byListen = state<Waits, never>()({ waits: ({ one }) => ({ t: one(100) }), listen: heard })
type Net = { systems: { svc: { events: never; asks: { SAVE: { args: {}; answer: void } } } }; surfaces: {}; views: {} }
export const byCallDone = forNet<Net>()<Waits & { calls: { save: 'one' } }, never>()({
  waits: ({ one }) => ({ t: one(100) }),
  calls: ({ one }) => ({ save: one('svc', 'SAVE', { done: quiet }) }),
})
export const written = state<Waits, never>()({ waits: ({ one }) => ({ t: one(100, () => {}) }), listen: () => () => {} })
// The done of a wait runs once the wait is armed: written elsewhere, it hides nothing until then.
type Two = { waits: { t: 'one'; u: 'one' } }
export const byDone = state<Two, { type: 'GO' }>()({ waits: ({ one }) => ({ t: one(100, quiet), u: one(100) }), on: { GO: (_, { arm }) => { arm('t') } } })
export const byDoneOption = state<Two, { type: 'GO' }>()({ waits: ({ one }) => ({ t: one(100, { done: quiet }), u: one(100) }), on: { GO: (_, { arm }) => { arm('t') } } })
export const byDoneUnarmed = state<Two, never>()({ waits: ({ one }) => ({ t: one(100, quiet), u: one(100) }) })
export const byDoneOptionUnarmed = state<Two, never>()({ waits: ({ one }) => ({ t: one(100, { done: quiet }), u: one(100) }) })
`), [[], [], ['nothing arms t'], [], [], ['nothing arms t', 'nothing arms u'], ['nothing arms t', 'nothing arms u']])
  }],
  ['what only a handler that cannot run enters or arms is dead, and is said by what stops the handler', () => {
    const found = findingsIn(`
type Net = { systems: { svc: { events: never; asks: { SAVE: { args: {}; answer: void } } } }; surfaces: {}; views: { docs: { all: { args: {}; result: string } } } }
const net = forNet<Net>()
type Three = { waits: { t: 'one' }; states: { live: {}; dead: {}; beyond: {} } }
type Event = { type: 'GO' }
export const byHandler = state<Three, Event>()({
  initial: 'live', waits: ({ one }) => ({ t: one(100) }),
  states: { live: { on: { GO: () => {} } }, dead: { on: { GO: () => ({ at: 'beyond' }) } }, beyond: { on: { GO: (_, { arm }) => { arm('t') } } } },
})
export const byInternal = state<Three & { internal: Event }, never>()({
  initial: 'live', waits: ({ one }) => ({ t: one(100, () => {}) }),
  states: { live: {}, dead: { internal: { GO: (_, { arm }) => { arm('t'); return { at: 'beyond' } } } }, beyond: {} },
})
export const byAnswer = state<Three, never, { GET: { args: {}; answer: number } }>()({
  initial: 'live', waits: ({ one }) => ({ t: one(100, () => {}) }),
  states: { live: { answers: { GET: () => 1 } }, dead: { answers: { GET: (_, { arm }) => { arm('t'); return answered(1, { at: 'beyond' }) } } }, beyond: {} },
})
type Late = { waits: { never: 'one'; then: 'one' }; states: { live: {}; late: {} } }
export const byDone = state<Late, never>()({
  initial: 'live',
  waits: ({ one }) => ({ never: one(100, ({ arm }) => { arm('then'); return { at: 'late' } }), then: one(100) }),
  states: { live: {}, late: {} },
})
export const byDoneOption = state<Late, never>()({
  initial: 'live',
  waits: ({ one }) => ({ never: one(100, { done: ({ arm }) => { arm('then'); return { at: 'late' } } }), then: one(100) }),
  states: { live: {}, late: {} },
})
export const byRun = state<Three, never>()({
  initial: 'live', waits: ({ one }) => ({ t: one(100) }),
  states: { live: {}, dead: { run: ({ arm }) => { arm('t'); return { at: 'beyond' } } }, beyond: {} },
})
export const byFailed = state<Three, never>()({
  initial: 'live', waits: ({ one }) => ({ t: one(100) }),
  states: { live: {}, dead: { run: () => {}, failed: (_, { arm }) => { arm('t'); return { at: 'beyond' } } }, beyond: {} },
})
export const byListen = state<Three, never>()({
  initial: 'live', waits: ({ one }) => ({ t: one(100) }),
  states: { live: {}, dead: { listen: ({ arm }) => { arm('t') } }, beyond: {} },
})
type Calling = { waits: { t: 'one' }; states: { live: {}; dead: { calls: { save: 'one' } }; beyond: {} } }
export const byCall = net<Calling, never>()({
  initial: 'live', waits: ({ one }) => ({ t: one(100) }),
  states: { live: {}, dead: { calls: ({ one }) => ({ save: one('svc', 'SAVE', { done: (_, { arm }) => { arm('t'); return { at: 'beyond' } } }) }) }, beyond: {} },
})
export const byProgress = net<Calling, never>()({
  initial: 'live', waits: ({ one }) => ({ t: one(100) }),
  states: { live: {}, dead: { calls: ({ one }) => ({ save: one('svc', 'SAVE', { done: () => {}, progress: (_, { arm }) => { arm('t'); return { at: 'beyond' } } }) }) }, beyond: {} },
})
export const byLoad = net<Three, never>()({
  initial: 'live', waits: ({ one }) => ({ t: one(100) }),
  states: { live: {}, dead: { loads: (load) => ({ got: load('svc', 'SAVE', { done: (_, { arm }) => { arm('t'); return { at: 'beyond' } } }) }) }, beyond: {} },
})
export const byFollow = net<Three, never>()({
  initial: 'live', waits: ({ one }) => ({ t: one(100) }),
  states: { live: {}, dead: { follows: (follow) => ({ docs: follow('docs', 'all', { updated: (_, { arm }) => { arm('t'); return { at: 'beyond' } } }) }) }, beyond: {} },
})
`)
    const all = 'dead is never entered, so nothing arms t; nothing enters beyond'
    deepStrictEqual(found.map(dead), [
      [all], [all], [all],
      ['nothing arms never, so nothing arms then; nothing enters late'],
      ['nothing arms never, so nothing arms then; nothing enters late'],
      [all], [all],
      ['dead is never entered, so nothing arms t', 'beyond is never entered'],
      [all], [all], [all], [all],
    ])
  }],
  ['each kind of handler, in a state that can be the case, enters what it moves to and arms what it arms', () => {
    const found = findingsIn(`
type Net = { systems: { svc: { events: never; asks: { SAVE: { args: {}; answer: void } } } }; surfaces: {}; views: { docs: { all: { args: {}; result: string } } } }
const net = forNet<Net>()
type Two = { waits: { t: 'one' }; states: { live: {}; beyond: {} } }
type Event = { type: 'GO' }
export const byHandler = state<Two, Event>()({
  initial: 'live', waits: ({ one }) => ({ t: one(100) }),
  states: { live: { on: { GO: (_, { arm }) => { arm('t'); return { at: 'beyond' } } } }, beyond: {} },
})
export const byInternal = state<Two & { internal: Event }, never>()({
  initial: 'live', waits: ({ one }) => ({ t: one(100) }),
  states: { live: { internal: { GO: (_, { arm }) => { arm('t'); return { at: 'beyond' } } } }, beyond: {} },
})
export const byAnswer = state<Two, never, { GET: { args: {}; answer: number } }>()({
  initial: 'live', waits: ({ one }) => ({ t: one(100) }),
  states: { live: { answers: { GET: (_, { arm }) => { arm('t'); return answered(1, { at: 'beyond' }) } } }, beyond: {} },
})
type Then = { waits: { first: 'one'; then: 'one' }; states: { live: {}; beyond: {} } }
export const byDone = state<Then, Event>()({
  initial: 'live',
  waits: ({ one }) => ({ first: one(100, ({ arm }) => { arm('then'); return { at: 'beyond' } }), then: one(100) }),
  states: { live: { on: { GO: (_, { arm }) => { arm('first') } } }, beyond: {} },
})
export const byDoneOption = state<{ waits: { first: { one: 'ms' }; then: 'one' }; states: { live: {}; beyond: {} } }, Event>()({
  initial: 'live',
  waits: ({ one }) => ({ first: one({ done: ({ arm }) => { arm('then'); return { at: 'beyond' } } }), then: one(100) }),
  states: { live: { on: { GO: (_, { arm }) => { arm('first', 10) } } }, beyond: {} },
})
export const byRun = state<Two, never>()({
  initial: 'live', waits: ({ one }) => ({ t: one(100) }),
  states: { live: { run: ({ arm }) => { arm('t'); return { at: 'beyond' } } }, beyond: {} },
})
export const byFailed = state<Two, never>()({
  initial: 'live', waits: ({ one }) => ({ t: one(100) }),
  states: { live: { run: () => {}, failed: (_, { arm }) => { arm('t'); return { at: 'beyond' } } }, beyond: {} },
})
export const byFailedListening = state<Two, never>()({
  initial: 'live', waits: ({ one }) => ({ t: one(100) }),
  states: { live: { listen: () => {}, failed: (_, { arm }) => { arm('t'); return { at: 'beyond' } } }, beyond: {} },
})
export const byListen = state<{ waits: { t: 'one' } }, never>()({ waits: ({ one }) => ({ t: one(100) }), listen: ({ arm }) => { arm('t') } })
type Calling = { waits: { t: 'one' }; states: { live: { calls: { save: 'one' } }; beyond: {} } }
export const byCall = net<Calling, never>()({
  initial: 'live', waits: ({ one }) => ({ t: one(100) }),
  states: { live: { calls: ({ one }) => ({ save: one('svc', 'SAVE', { done: (_, { arm }) => { arm('t'); return { at: 'beyond' } } }) }) }, beyond: {} },
})
export const byProgress = net<Calling, never>()({
  initial: 'live', waits: ({ one }) => ({ t: one(100) }),
  states: { live: { calls: ({ one }) => ({ save: one('svc', 'SAVE', { done: () => {}, progress: (_, { arm }) => { arm('t'); return { at: 'beyond' } } }) }) }, beyond: {} },
})
export const byLoad = net<Two, never>()({
  initial: 'live', waits: ({ one }) => ({ t: one(100) }),
  states: { live: { loads: (load) => ({ got: load('svc', 'SAVE', { done: (_, { arm }) => { arm('t'); return { at: 'beyond' } } }) }) }, beyond: {} },
})
export const byFollow = net<Two, never>()({
  initial: 'live', waits: ({ one }) => ({ t: one(100) }),
  states: { live: { follows: (follow) => ({ docs: follow('docs', 'all', { updated: (_, { arm }) => { arm('t'); return { at: 'beyond' } } }) }) }, beyond: {} },
})
// A state inside one that can be the case is under the handlers of that one.
type Under = { waits: { t: 'one' }; states: { box: { states: { in: {} } }; beyond: {} } }
export const byAround = state<Under, Event>()({
  initial: 'box', waits: ({ one }) => ({ t: one(100) }),
  states: { box: { initial: 'in', on: { GO: (_, { arm }) => { arm('t'); return { at: 'beyond' } } }, states: { in: {} } }, beyond: {} },
})
`)
    deepStrictEqual(found.map(dead), found.map(() => []))
    strictEqual(found.length, 14)
  }],
  ['a failed runs only where there is work to fail', () => {
    deepStrictEqual(findingsIn(`
type Two = { waits: { t: 'one' }; states: { live: {}; beyond: {} } }
export const noWork = state<Two, never>()({
  initial: 'live', waits: ({ one }) => ({ t: one(100) }),
  states: { live: { failed: (_, { arm }) => { arm('t'); return { at: 'beyond' } } }, beyond: {} },
})
const quiet = (): void => {}
export const noWorkUnread = state<Two, never>()({
  initial: 'live', waits: ({ one }) => ({ t: one(100) }),
  states: { live: { failed: Math.random() > 0.5 ? quiet : quiet }, beyond: {} },
})
export const workUnread = state<Two, never>()({
  initial: 'live', waits: ({ one }) => ({ t: one(100) }),
  states: { live: { run: () => {}, failed: Math.random() > 0.5 ? quiet : quiet }, beyond: {} },
})
`), [
      ['beyond is never entered', 'nothing arms t'],
      ['beyond is never entered', 'nothing arms t'],
      [],
    ])
  }],
  ['a chain of states and waits, each reached from the one before, can all happen, and none of it without its first link', () => {
    const chain = (first: string): string => `
type Chain = { waits: { first: 'one' }; states: { a: {}; b: { waits: { second: 'one' } }; c: { waits: { third: 'one' } }; d: {} } }
export const chain = state<Chain, { type: 'GO' }>()({
  initial: 'a',
  // Declared against the order they happen in, so each is found from the one before whatever is read first.
  waits: ({ one }) => ({ first: one(100, () => ({ at: 'b' })) }),
  states: {
    d: {},
    c: { waits: ({ one }) => ({ third: one(100, () => ({ at: 'd' })) }), run: ({ arm }) => { arm('third') } },
    b: { waits: ({ one }) => ({ second: one(100, () => ({ at: 'c' })) }), on: { GO: (_, { arm }) => { arm('second') } } },
    a: { on: { GO: ${first} } },
  },
})
`
    deepStrictEqual(findingsIn(chain(`(_, { arm }) => { arm('first') }`)), [[]])
    deepStrictEqual(findingsIn(chain(`() => {}`)), [['nothing arms first, so nothing enters b, c, d']])
  }],
  ['what is dead is said once, by its cause, with what is dead because of it', () => {
    const [whole, apart, circle, between, ownAndOther, inside, shared, into] = findingsIn(`
type Event = { type: 'GO' }
type Whole = { waits: { keepalive: 'one'; unused: 'one' }; states: { live: {}; dead: { waits: { inner: 'one' }; states: { sub: { waits: { own: 'one' } }; side: {} } } } }
export const whole = state<Whole, Event>()({
  initial: 'live',
  waits: ({ one }) => ({ keepalive: one(100), unused: one(100) }),
  states: {
    live: { on: { GO: () => {} } },
    dead: {
      initial: 'sub',
      waits: ({ one }) => ({ inner: one(100) }),
      on: { GO: (_, { arm }) => { arm('keepalive'); arm('inner') } },
      states: { sub: { waits: ({ one }) => ({ own: one(100) }) }, side: {} },
    },
  },
})
type Apart = { waits: { wy: 'one'; wx: 'one' }; states: { live: {}; x: {}; y: {} } }
export const apart = state<Apart, Event>()({
  initial: 'live',
  waits: ({ one }) => ({ wy: one(100), wx: one(100) }),
  states: { live: { on: { GO: () => {} } }, x: { on: { GO: (_, { arm }) => { arm('wx') } } }, y: { on: { GO: (_, { arm }) => { arm('wy') } } } },
})
type Circle = { states: { live: {}; a: {}; b: {}; c: {} } }
export const circle = state<Circle, Event>()({
  initial: 'live',
  states: { live: { on: { GO: () => {} } }, a: { on: { GO: () => ({ at: 'b' }) } }, b: { on: { GO: () => ({ at: 'c' }) } }, c: { on: { GO: () => ({ at: 'a' }) } } },
})
type Between = { waits: { w: 'one' }; states: { live: {}; s: {} } }
export const between = state<Between, Event>()({
  initial: 'live',
  waits: ({ one }) => ({ w: one(100, () => ({ at: 's' })) }),
  states: { live: { on: { GO: () => {} } }, s: { on: { GO: (_, { arm }) => { arm('w') } } } },
})
type OwnAndOther = { waits: { p: 'one'; q: 'one'; r: 'one' } }
export const ownAndOther = state<OwnAndOther, never>()({
  waits: ({ one }) => ({
    p: one(100, ({ arm }) => { arm('p'); arm('q') }),
    q: one(100, ({ arm }) => { arm('p'); arm('r') }),
    r: one(100),
  }),
})
// A move from inside a state to it, or to another inside it, is no way into it.
type Inside = { states: { live: {}; dead: { states: { x: {}; y: {} } } } }
export const inside = state<Inside, Event>()({
  initial: 'live',
  states: {
    live: { on: { GO: () => {} } },
    dead: { initial: 'x', states: { x: { on: { GO: () => ({ at: 'dead.y' }) } }, y: { on: { GO: () => ({ at: 'dead' }) } } } },
  },
})
// What the done of a wait in a state never entered leads to is said by that state, as the wait is.
type Shared = { waits: { keep: 'one' }; states: { live: {}; dead: { waits: { b: 'one' } }; late: {}; gone: {} } }
export const shared = state<Shared, Event>()({
  initial: 'live',
  waits: ({ one }) => ({ keep: one(100) }),
  states: {
    live: { on: { GO: () => {} } },
    dead: { waits: ({ one }) => ({ b: one(100, ({ arm }) => { arm('keep'); return { at: 'late' } }) }) },
    late: {},
    gone: { on: { GO: () => ({ at: 'late' }) } },
  },
})
// A move to a state inside another enters that other too.
type Into = { states: { live: {}; q: {}; p: { states: { c: {}; d: {} } } } }
export const into = state<Into, Event>()({
  initial: 'live',
  states: { live: { on: { GO: () => {} } }, q: { on: { GO: () => ({ at: 'p.d' }) } }, p: { initial: 'c', states: { c: {}, d: {} } } },
})
`)
    deepStrictEqual(whole, ['dead is never entered, so nothing arms keepalive; nothing enters dead.sub, dead.side', 'nothing arms unused'])
    deepStrictEqual(apart, ['x is never entered, so nothing arms wx', 'y is never entered, so nothing arms wy'])
    deepStrictEqual(circle, ['a is never entered except from c, so nothing enters b, c'])
    deepStrictEqual(between, ['s is never entered except by the done of w, so nothing arms w'])
    deepStrictEqual(ownAndOther, ['nothing arms p except its own done and the done of q, so nothing arms q, r'])
    deepStrictEqual(inside, ['dead is never entered, so nothing enters dead.x, dead.y'])
    deepStrictEqual(shared, ['dead is never entered, so nothing arms keep; nothing enters late', 'gone is never entered'])
    deepStrictEqual(into, ['q is never entered, so nothing enters p, p.c, p.d'])
  }],
  ['a state is entered at what it starts at only when it is entered itself, and at any state inside it where that is not a name', () => {
    const starts = (initial: string): string[] => findingsIn(`
declare const some: any
declare const either: 'x' | 'y'
type Shape = { states: { idle: {}; p: { states: { x: {}; y: { states: { z: {}; z2: {} } }; w: {} } }; q: { states: { v: {} } } } }
export const begins = state<Shape, { type: 'GO' }>()({
  initial: 'idle',
  states: {
    idle: { on: { GO: () => ({ at: ${initial === 'none' ? `'p.w'` : `'p'`} }) } },
    p: { initial: ${initial === 'none' ? `'x'` : initial}, states: { x: {}, y: { initial: 'z', states: { z: {}, z2: {} } }, w: {} } },
    q: { initial: 'v', states: { v: {} } },
  },
})
`)[0]!
    const q = 'q is never entered, so nothing enters q.v'
    deepStrictEqual(starts(`'x'`), ['p.y is never entered, so nothing enters p.y.z, p.y.z2', 'p.w is never entered', q])
    deepStrictEqual(starts('either'), ['p.y.z2 is never entered', 'p.w is never entered', q])
    deepStrictEqual(starts('some'), ['p.y.z2 is never entered', q])
    // Entered only at a state inside it, it is not entered at what it starts at.
    deepStrictEqual(starts('none'), ['p.x is never entered', 'p.y is never entered, so nothing enters p.y.z, p.y.z2', q])
  }],
  ['what is unread hides what it could do from where it is, and nothing else', () => {
    const [M, D, O, S] = ['nothing arms mine in a', 'nothing arms deep in a.x', 'nothing arms other in a.y', 'nothing arms side in b']
    const far = 'far is never entered, so nothing enters far.in'
    const nothingHidden = ['far is never entered, so nothing arms top; nothing enters far.in', M, D, O, S]
    const expected: Record<keyof typeof UNREAD, Record<string, string[]>> = {
      nothing: { '': nothingHidden, a: nothingHidden, 'a.x': nothingHidden, far: nothingHidden },
      arms: { '': [far, M, D, O, S], a: [far, D, O, S], 'a.x': [far, O, S], far: nothingHidden },
      moves: { '': [M, D, O, S], a: [M, D, O, S], 'a.x': [M, D, O, S], far: nothingHidden },
      both: { '': [M, D, O, S], a: [D, O, S], 'a.x': [O, S], far: nothingHidden },
      held: { '': [], a: [S], 'a.x': [O, S], far: nothingHidden },
    }
    const cases = (Object.keys(UNREAD) as Array<keyof typeof UNREAD>).flatMap((kind) => UNREAD[kind].flatMap((what) => Object.keys(expected[kind]).map((at) => ({ kind, what, at }))))
    const found = findingsIn(PLACED + cases.map(({ at, what }, index) => placed(at, what, `placed${index}`)).join(''), HANDLERS)
    strictEqual(found.length, cases.length)
    for (const [index, { kind, what, at }] of cases.entries()) deepStrictEqual(dead(found[index]!), expected[kind][at], `${what} in ${at || 'the definition'}`)
  }],
  ['states that are not written out hold anything from where they are, and a definition that is not holds anything', () => {
    const held = (inP: string, before = ''): string[] => dead(findingsIn(`
${before}
type Shape = {
  waits: { top: 'one' }
  states: { start: {}; p: { waits: { mine: 'one' }; states: { c: { waits: { deep: 'one' } }; d: { waits: { other: 'one' } } } }; q: { waits: { side: 'one' } }; far: {} }
}
export const held = state<Shape, { type: 'P' } | { type: 'C' } | { type: 'D' } | { type: 'Q' }>()({
  initial: 'start',
  waits: ({ one }) => ({ top: one(100) }),
  states: {
    start: { on: { P: () => ({ at: 'p' }), C: () => ({ at: 'p.c' }), D: () => ({ at: 'p.d' }), Q: () => ({ at: 'q' }) } },
    p: { initial: 'c', waits: ({ one }) => ({ mine: one(100) }), ${inP} },
    q: { waits: ({ one }) => ({ side: one(100) }) },
    far: { on: { P: (_, { arm }) => { arm('top') } } },
  },
})
`)[0]!)
    const c = `c: { waits: ({ one }: any) => ({ deep: one(100) }) }`
    const d = `d: { waits: ({ one }: any) => ({ other: one(100) }) }`
    const [M, D, O, S] = ['nothing arms mine in p', 'nothing arms deep in p.c', 'nothing arms other in p.d', 'nothing arms side in q']
    deepStrictEqual(held(`states: { ${c}, ${d} }`), ['far is never entered, so nothing arms top', M, D, O, S])
    // One state not written out holds what is in it and inside it, and what it could arm around it.
    deepStrictEqual(held(`states: { c: made, ${d} }`, `const made: any = {}`), [O, S])
    deepStrictEqual(held(`states: { c, ${d} }`, `const c: any = {}`), [O, S])
    // States not written out, or not all, hold every state inside the one they are in.
    deepStrictEqual(held(`states: made`, `const made: any = {}`), [S])
    deepStrictEqual(held(`states: { ...made, ${d} }`, `const made: any = {}`), [S])
    deepStrictEqual(held(`states: { [name]: {}, ${c}, ${d} }`, `declare const name: string`), [S])
    deepStrictEqual(held(`states: { get c(): any { return {} }, ${d} }`), [S])
    // What a declaration is made by is what its own table is handed, not what some function around it is.
    deepStrictEqual(dead(findingsIn(`
type Net = { systems: { svc: { events: never; asks: { X: { args: {}; answer: void } } } }; surfaces: {}; views: {} }
type Two = { states: { live: {}; far: {} } }
export const build = (handed: any) => forNet<Net>()<Two, never>()({
  initial: 'live',
  states: { live: { loads: () => ({ got: handed('svc', 'X', { from: [], done: () => {} }) }) }, far: {} },
})
export const read = forNet<Net>()<Two, never>()({
  initial: 'live',
  states: { live: { loads: (load) => ({ got: load('svc', 'X', { from: [], done: () => {} }) }) }, far: {} },
})
`).flat()), ['far is never entered'])
    const whole = findingsIn(`
type Shape = { waits: { t: 'one' }; states: { live: {}; dead: {} } }
const made = { initial: 'live', waits: ({ one }: any) => ({ t: one(100) }), states: { live: {}, dead: {} } } as const
export const elsewhere = state<Shape, never>()(made as never)
`)[0]!
    deepStrictEqual(whole, ['definition is not an inline object literal; reaches, follows, loads, calls, and waits could not be scanned'])
  }],
  ['the done of a wait that is not read does what it may once its wait is armed, and nothing before', () => {
    const done = (waits: string, armed: 't' | 'u' | 'v' | ''): string[] => dead(findingsIn(`
declare const flag: boolean
const quiet = (): void => {}
const typedVoid: () => void = () => ({ at: 'far' })
const options = { done: quiet }
const optionsFar = { done: () => ({ at: 'far' as const }) }
const buildWaits = ({ one }: any) => ({ t: one(100), u: one(100) })
const more = {} as {}
const other = (ms: number): any => ({ kind: 'one', ms, done: () => ({ at: 'far' }) })
type Shape = { waits: { u: 'one' }; states: { live: { waits: { t: 'one'; v: 'one' } }; beside: { waits: { side: 'one' } }; far: {} } }
export const waiting = state<Shape, { type: 'GO' } | { type: 'NEXT' }>()({
  initial: 'live',
  waits: ({ one }) => ({ u: one(100) }),
  states: {
    live: { waits: ${waits}, on: { GO: (_, { arm }) => { ${armed && `arm('${armed}')`} }, NEXT: () => ({ at: 'beside' }) } },
    beside: { waits: ({ one }) => ({ side: one(100) }) },
    far: {},
  },
})
`)[0]!)
    const [U, T, V, S] = ['nothing arms u', 'nothing arms t in live', 'nothing arms v in live', 'nothing arms side in beside']
    const far = 'far is never entered'
    const table = (t: string): string => `({ one }) => ({ t: ${t}, v: one(100) })`
    const each: Array<[string, string[]]> = [
      // Written here, it is read: it arms nothing and goes nowhere.
      [table(`one(100, () => {})`), [far, U, V, S]],
      [`(waits) => ({ t: waits.one(100, () => {}), v: waits.one(100) })`, [far, U, V, S]],
      // The name of a function leaves what it arms unread: the waits of its state and the states around it.
      [table(`one(100, quiet)`), [far, S]],
      [table(`one(100, { done: quiet })`), [far, S]],
      [table(`one({ done: quiet })`), [far, S]],
      // What may be either of two, or says less than it does, leaves where it goes unread too.
      [table(`one(100, flag ? quiet : quiet)`), [S]],
      [table(`one(100, { done: typedVoid })`), [S]],
      [table(`one(100, { ...more })`), [S]],
      [table(`one(100, { [String(flag)]: 1 })`), [S]],
      [table(`one(100, options)`), [S]],
      [`({ one }) => ({ t: flag ? one(100) : one(200), v: one(100) })`, [S]],
      // One made by anything but what the table is handed holds what that made of it.
      [table(`other(100)`), [S]],
    ]
    for (const [waits, armed] of each) {
      deepStrictEqual(done(waits, 't'), armed, waits)
      deepStrictEqual(done(waits, ''), [far, U, T, V, S], waits)
    }
    // Options written elsewhere are read by their type for where the done goes, and it goes there once armed.
    deepStrictEqual(done(table(`one(100, optionsFar)`), 't'), [S])
    deepStrictEqual(done(table(`one(100, optionsFar)`), ''), [U, 'nothing arms t in live, so nothing enters far', V, S])
    // One entry that is not read leaves the done of the others in its table as they are written.
    deepStrictEqual(done(`({ one }) => ({ t: flag ? one(100) : one(200), v: one(100) })`, 'v'), [far, U, T, S])
    // A table of waits that is not written out, or not all: the done of each wait there is unread, armed or not.
    for (const waits of [`buildWaits`, `({ one }) => ({ ...more, t: one(100), v: one(100) })`, `({ one }) => ({ [String(flag)]: one(100), t: one(100), v: one(100) })`, `({ one }) => { return { t: one(100), v: one(100) } }`]) {
      deepStrictEqual(done(waits, 't'), [S], waits)
      deepStrictEqual(done(waits, ''), [far, U, T, V, S], waits)
      // And of no wait another state declares, whose done is read where it is written.
      deepStrictEqual(done(waits, 'u'), [far, T, V, S], waits)
    }
  }],
  ['what cannot be read in a state never entered hides nothing, and a wait declared there is said by the state alone', () => {
    deepStrictEqual(findingsIn(twoBranches('', `GO: () => {}`, `on: { GO: quiet }`)), [[
      'nothing takes NEXT',
      'b is never entered',
      'nothing arms top',
      'nothing arms mine in a',
    ]])
  }],
  ['who is told, when it is not known, hides no wait', () => {
    deepStrictEqual(findingsIn(twoBranches(`on: { GO: (_, { tell, arm }) => { tell(anyName(), { type: 'PING' }); arm('mine') } }`)), [[
      'nothing arms top',
      'nothing arms side in b',
      'dynamic target in tell anyName()',
    ]])
  }],
  ['a move to a state that is not known may enter any state, and arms nothing', () => {
    // `b` is entered by nothing that is read, and `top` is armed only there.
    const armedInB = `on: { GO: (_, { arm }) => { arm('top') } }`
    deepStrictEqual(findingsIn(twoBranches('', `NEXT: () => ({ at: anyName() })`, armedInB)), [[
      'nothing arms mine in a',
      'nothing arms side in b',
      'dynamic move target in NEXT (at is any)',
    ]])
    deepStrictEqual(findingsIn(twoBranches('', `NEXT: () => {}`, armedInB)), [[
      'b is never entered, so nothing arms top',
      'nothing arms mine in a',
    ]])
  }],
  ['a way into a state that could not be read leaves the state, and what is armed in it, unreported', () => {
    deepStrictEqual(findingsIn(entryFrom(`on: { GO: quiet }`)), [['box.dead is never entered, so nothing arms keep in box']])
    // A handler that returns anything, one that is not one function, one that is one of two, a table of handlers
    // that is not written out, and what a read hears when its options are spread in: each may enter it, unread.
    const silent = (inOther: string): void => deepStrictEqual(findingsIn(entryFrom(inOther)), [[]], inOther)
    silent(`on: { GO: (): any => undefined }`)
    silent(`on: { GO: anyHandler }`)
    silent(`on: { GO: twice }`)
    silent(`on: { GO: Math.random() > 0.5 ? () => {} : () => ({ at: 'box.dead' as const }) }`)
    silent(`on: anyHandler`)
    silent(`on: { ...({} as Record<string, () => { at: 'box.dead' }>) }`)
    silent(`on: { ['G' + 'O']: () => ({ at: 'box.dead' as const }) }`)
    silent(`internal: anyHandler`)
    silent(`on: { GO: either }`)
    silent(`loads: (load: any) => ({ far: load('svc', 'X', { from: [], ...({} as { done: () => { at: 'box.dead' } }) }) })`)
    const startsAt = (initial: string): string[] => findingsIn(`
declare const either: 'live' | 'dead'
declare const some: any
type Shape = { waits: { one: 'one'; two: 'one' }; states: { live: {}; dead: {} } }
export const begins = state<Shape, { type: 'GO' }>()({
  initial: ${initial},
  waits: ({ one }) => ({ one: one(100), two: one(100) }),
  states: {
    live: { on: { GO: (_, { arm }) => { arm('one') } } },
    dead: { on: { GO: (_, { arm }) => { arm('two') } } },
  },
})
`)[0]!
    deepStrictEqual(startsAt(`'live'`), ['dead is never entered, so nothing arms two'])
    deepStrictEqual(startsAt('either'), [])
    deepStrictEqual(startsAt('some'), [])
  }],
  ['a move a handler makes is read from what it returns, where the type its return is given leaves it out', () => {
    const hidden = (handler: string): string[] => findingsIn(`
declare const anyValue: any
declare const somewhere: string
type Shape = { data: { n: number }; waits: { keep: 'one' }; states: { live: {}; dead: {}; gone: {} } }
const going = { data: { n: 1 }, at: 'dead' as const }
export const hides = state<Shape, { type: 'GO' }>()({
  data: { n: 0 }, initial: 'live', waits: ({ one }) => ({ keep: one(100) }),
  on: { GO: ${handler} },
  states: { live: {}, dead: { on: { GO: (_, { arm }) => { arm('keep') } } }, gone: {} },
})
`)[0]!
    const neither = ['dead is never entered, so nothing arms keep', 'gone is never entered']
    // The type says only that the data changes; the value also says where it goes, and it goes nowhere else.
    deepStrictEqual(hidden(`(): { data: { n: number } } => going`), ['gone is never entered'])
    deepStrictEqual(hidden(`(): { data: { n: number } } => { if (Math.random() > 0.5) return { data: { n: 2 } }; return going }`), ['gone is never entered'])
    deepStrictEqual(hidden(`function (): { data: { n: number } } { return going }`), ['gone is never entered'])
    // A value that could be anything, or that goes to a state not known, may go anywhere.
    deepStrictEqual(hidden(`(): { data: { n: number } } => anyValue`), [])
    deepStrictEqual(hidden(`(): { data: { n: number } } => ({ data: { n: 2 }, at: somewhere })`), [])
    // What a function kept inside it returns is not what it returns.
    deepStrictEqual(hidden(`(): { data: { n: number } } => { const inner = (): unknown => going; void inner; return { data: { n: 2 } } }`), neither)
    deepStrictEqual(hidden(`(): { data: { n: number } } => { function inner(): unknown { return going } void inner; return { data: { n: 2 } } }`), neither)
    // And one whose values go nowhere is still told so.
    deepStrictEqual(hidden(`(): { data: { n: number } } => ({ data: { n: 2 } })`), neither)
  }],
])
