// The package as a consumer gets it: a tarball installed into two clean projects of its own. The first installs
// `@apackdev/state` with zero optional peers to verify `.` has no runtime dependencies; the second installs the
// optional peers of `./vue` and `./testing` (pinned from this repository's manifest), imports every entry at run
// time, and runs `tsc --noEmit` against the packed `.d.ts` declarations. Removes what it made either way.
//
//   node scripts/package-smoke.mjs [tarball]   (without one, packs this checkout: `prepack` builds dist/ first)
import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

// npm's own script, run by this Node: no shell, which on Windows would split a path at its spaces and read `^` as an
// escape, and nothing that could. `npm_execpath` is it when this runs under npm; beside Node is where npm installs it.
const npmCli = process.env.npm_execpath?.endsWith('.js') ? process.env.npm_execpath : path.join(path.dirname(process.execPath), process.platform === 'win32' ? '' : '..', process.platform === 'win32' ? '' : 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js')
const repoRoot = path.resolve(import.meta.dirname, '..')
const tscBin = path.join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc')
const run = (args, cwd) => execFileSync(process.execPath, [npmCli, ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] })
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'apack-state-consumer-'))
const bare = path.join(work, 'bare')
const full = path.join(work, 'full')
fs.mkdirSync(bare)
fs.mkdirSync(full)
try {
  let tarball = process.argv[2] && path.resolve(process.argv[2])
  if (!tarball) {
    const [packed] = JSON.parse(run(['pack', '--json', '--pack-destination', work], repoRoot))
    tarball = path.join(work, packed.filename)
  }
  if (!fs.existsSync(tarball)) throw new Error(`No tarball at ${tarball}`)

  // Phase 1: bare consumer with ZERO optional peer dependencies — proves `.` has no runtime dependencies.
  fs.writeFileSync(path.join(bare, 'package.json'), JSON.stringify({ name: 'consumer-bare', private: true, type: 'module' }))
  run(['install', '--omit=peer', '--no-audit', '--no-fund', '--no-package-lock', tarball], bare)
  const bareLoad = [
    "const index = await import('@apackdev/state')",
    "for (const name of ['system', 'forNet', 'state', 'given', 'answered', 'within', 'Cancelled', 'windowFrame']) if (!(name in index)) throw new Error(`@apackdev/state has no ${name}`)",
    "const sys = index.system({ side: 'window' })",
    "const counter = index.state()({ data: { count: 0 }, on: { ADD: (_, { data }) => ({ data: { count: data.count + 1 } }) } })",
    "const handle = sys.start('counter', counter)",
    "sys.send(handle, { type: 'ADD' })",
    "while (!sys.idle()) await new Promise((resolve) => setImmediate(resolve))",
    "if (sys.read(handle).data.count !== 1) throw new Error('a state made from the bare installed package did not count')",
    "sys.stop()",
  ].join('\n')
  fs.writeFileSync(path.join(bare, 'load.mjs'), bareLoad)
  execFileSync(process.execPath, ['load.mjs'], { cwd: bare, stdio: 'inherit' })

  // Phase 2: full consumer with optional peers for `./vue` and `./testing`, plus consumer `.d.ts` typecheck.
  const devDeps = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')).devDependencies
  fs.writeFileSync(path.join(full, 'package.json'), JSON.stringify({ name: 'consumer-full', private: true, type: 'module', dependencies: { '@vue/reactivity': '^3.5.0', '@vue/runtime-core': '^3.5.0', '@apackdev/link': devDeps['@apackdev/link'], '@apackdev/orderings': devDeps['@apackdev/orderings'] } }))
  run(['install', '--no-audit', '--no-fund', '--no-package-lock', tarball], full)
  const fullLoad = [
    "const index = await import('@apackdev/state')",
    "for (const name of ['system', 'forNet', 'state', 'given', 'answered', 'within', 'Cancelled', 'windowFrame']) if (!(name in index)) throw new Error(`@apackdev/state has no ${name}`)",
    "const vue = await import('@apackdev/state/vue')",
    "if (typeof vue.vueBinding !== 'function') throw new Error('@apackdev/state/vue has no vueBinding')",
    "const testing = await import('@apackdev/state/testing')",
    "for (const name of ['explore', 'sample', 'replay', 'everyOrder', 'onSchedule', 'connect', 'fromEvents', 'waitFor', 'defectGuard']) if (typeof testing[name] !== 'function') throw new Error(`@apackdev/state/testing has no ${name}`)",
    "const graph = await import('@apackdev/state/graph')",
    "for (const name of ['analyseGraphs', 'formatGraphs', 'runGraphCli']) if (typeof graph[name] !== 'function') throw new Error(`@apackdev/state/graph has no ${name}`)",
    "const sys = index.system({ side: 'window' })",
    "const counter = index.state()({ data: { count: 0 }, on: { ADD: (_, { data }) => ({ data: { count: data.count + 1 } }) } })",
    "const handle = sys.start('counter', counter)",
    "sys.send(handle, { type: 'ADD' })",
    "while (!sys.idle()) await new Promise((resolve) => setImmediate(resolve))",
    "if (sys.read(handle).data.count !== 1) throw new Error('a state made from the installed package did not count')",
    "sys.stop()",
  ].join('\n')
  fs.writeFileSync(path.join(full, 'load.mjs'), fullLoad)
  execFileSync(process.execPath, ['load.mjs'], { cwd: full, stdio: 'inherit' })

  fs.writeFileSync(path.join(full, 'tsconfig.json'), JSON.stringify({
    compilerOptions: { strict: true, noEmit: true, module: 'nodenext', moduleResolution: 'nodenext', target: 'es2022', lib: ['es2022', 'dom'], skipLibCheck: false },
    include: ['check.ts'],
  }))
  const consumerTypes = [
    "import { answered, forNet, given, state, system, type AsksOf, type EventsOf, type ShapeOf } from '@apackdev/state'",
    "import { vueBinding } from '@apackdev/state/vue'",
    "import { connect, defectGuard, everyOrder, onSchedule, type Defect } from '@apackdev/state/testing'",
    "import { analyseGraphs, formatGraphs, runGraphCli, type GraphOptions, type StateGraph } from '@apackdev/state/graph'",
    "const counter = state<{ data: { id: string; count: number } }, { type: 'ADD' }, { GET: { args: {}; answer: number } }>()({",
    "  data: { id: given, count: 0 },",
    "  on: { ADD: (_, { data }) => ({ data: { count: data.count + 1 } }) },",
    "  answers: { GET: (_, { data }) => answered(data.count, { data: { count: data.count } }) },",
    "})",
    "const _cs: ShapeOf<typeof counter> = { data: { id: '', count: 0 } }",
    "const _ce: EventsOf<typeof counter> = { type: 'ADD' }",
    "const _ca: AsksOf<typeof counter> = { GET: { args: {}, answer: 0 } }",
    "type AppNet = {",
    "  systems: { svc: { events: never; asks: { PING: { args: {}; answer: string }; SAVE: { args: { text: string }; answer: null } } } }",
    "  surfaces: {}",
    "  views: { docs: { detail: { args: { id: string }; result: string }; all: { args: {}; result: number } } }",
    "}",
    "const appState = forNet<AppNet>((name) => (name.includes('/') ? name : `app/${name}`))",
    "const panel = appState<{",
    "  data: { id: string | null; rev: number }",
    "  calls: { ping: 'one'; tag: 'each'; save: { many: { text: string } } }",
    "}, { type: 'GO'; text: string }>()({",
    "  data: { id: null, rev: 0 },",
    "  follows: (follow) => ({",
    "    detail: follow('docs', 'detail', { from: ['id'], args: ({ id }) => (id ? { id } : null), updated: () => {} }),",
    "    all: follow('docs', 'all', { from: ['rev'], updated: () => {} }),",
    "  }),",
    "  loads: (load) => ({",
    "    status: load('svc', 'PING', { from: ['rev'], done: () => {} }),",
    "  }),",
    "  calls: ({ one, each, many }) => ({",
    "    ping: one('svc', 'PING', { done: () => {} }),",
    "    tag: each('svc', 'PING', { done: (_o, { key }) => { void key } }),",
    "    save: many('svc', 'SAVE', { done: (_o, { input }) => { const _t: string = input.text; void _t } }),",
    "  }),",
    "  on: { GO: ({ text }, { call }) => { call('ping'); call('tag', 'k'); call('save', { text }) } },",
    "})",
    "const defects: Defect[] = []",
    "using guard = defectGuard((d) => defects.push(d))",
    "using backend = system({ side: 'backend', onDefect: guard.onDefect })",
    "using win = system({ side: 'window', onDefect: guard.onDefect })",
    "using link = connect(win, backend)",
    "const handle = backend.start('counter', counter, { id: 'c1' })",
    "const panelHandle = win.start('panel', panel)",
    "const _pendingCount: number = win.read(panelHandle).pending.save",
    "backend.send(handle, { type: 'ADD' })",
    "const binding = vueBinding<{ counter: typeof counter }>((name) => (name.includes('/') ? name : `app/${name}`))",
    "const _g: (files: readonly string[], options?: GraphOptions) => ReadonlyMap<string, readonly StateGraph[]> = analyseGraphs",
    "void binding; void everyOrder; void onSchedule; void link; void _pendingCount; void _g; void formatGraphs; void runGraphCli; void _cs; void _ce; void _ca",
  ].join('\n')
  fs.writeFileSync(path.join(full, 'check.ts'), consumerTypes)
  execFileSync(process.execPath, [tscBin, '-p', 'tsconfig.json'], { cwd: full, stdio: 'inherit' })

  // Verify the packed CLI bin runs end-to-end against a real state file using `--tsconfig`.
  const binScript = path.join(full, 'node_modules', '@apackdev', 'state', 'bin', 'apack-state-graph.mjs')
  const graphOut = execFileSync(process.execPath, [binScript, '--tsconfig', path.join(repoRoot, 'tsconfig.json'), path.join(repoRoot, 'checks', 'graphs', 'custom-alias.mts')], { cwd: full, encoding: 'utf8' })
  if (!graphOut.includes('SettingsShape') || !graphOut.includes('findings: none')) throw new Error(`packed apack-state-graph bin returned unexpected output:\n${graphOut}`)

  console.log('bare zero-peer install, all entries, state run, graph bin, and consumer types ok')
} finally {
  fs.rmSync(work, { recursive: true, force: true })
}
