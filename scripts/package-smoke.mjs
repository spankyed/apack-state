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
    "for (const name of ['system', 'reaching', 'given', 'answered', 'within', 'Left', 'windowFrame']) if (!(name in index)) throw new Error(`@apackdev/state has no ${name}`)",
    "const sys = index.system({ side: 'window' })",
    "const counter = index.reaching()()({ data: { count: 0 }, on: { ADD: (_, { data }) => ({ data: { count: data.count + 1 } }) } })",
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
    "for (const name of ['system', 'reaching', 'given', 'answered', 'within', 'Left', 'windowFrame']) if (!(name in index)) throw new Error(`@apackdev/state has no ${name}`)",
    "const vue = await import('@apackdev/state/vue')",
    "if (typeof vue.vueBinding !== 'function') throw new Error('@apackdev/state/vue has no vueBinding')",
    "const testing = await import('@apackdev/state/testing')",
    "for (const name of ['explore', 'sample', 'replay', 'everyOrder', 'onSchedule', 'connect', 'fromEvents']) if (typeof testing[name] !== 'function') throw new Error(`@apackdev/state/testing has no ${name}`)",
    "const sys = index.system({ side: 'window' })",
    "const counter = index.reaching()()({ data: { count: 0 }, on: { ADD: (_, { data }) => ({ data: { count: data.count + 1 } }) } })",
    "const handle = sys.start('counter', counter)",
    "sys.send(handle, { type: 'ADD' })",
    "while (!sys.idle()) await new Promise((resolve) => setImmediate(resolve))",
    "if (sys.read(handle).data.count !== 1) throw new Error('a state made from the installed package did not count')",
    "sys.stop()",
  ].join('\n')
  fs.writeFileSync(path.join(full, 'load.mjs'), fullLoad)
  execFileSync(process.execPath, ['load.mjs'], { cwd: full, stdio: 'inherit' })

  fs.writeFileSync(path.join(full, 'tsconfig.json'), JSON.stringify({
    compilerOptions: { strict: true, noEmit: true, module: 'nodenext', moduleResolution: 'nodenext', target: 'es2022', skipLibCheck: true },
    include: ['check.ts'],
  }))
  const consumerTypes = [
    "import { answered, given, reaching, system } from '@apackdev/state'",
    "import { vueBinding } from '@apackdev/state/vue'",
    "import { everyOrder, onSchedule } from '@apackdev/state/testing'",
    "const state = reaching()",
    "const counter = state<{ data: { id: string; count: number } }, { type: 'ADD' }, { GET: { args: {}; answer: number } }>()({",
    "  data: { id: given, count: 0 },",
    "  on: { ADD: (_, { data }) => ({ data: { count: data.count + 1 } }) },",
    "  asks: { GET: (_, { data }) => answered(data.count, { data: { count: data.count } }) },",
    "})",
    "const sys = system({ side: 'window' })",
    "const handle = sys.start('counter', counter, { id: 'c1' })",
    "sys.send(handle, { type: 'ADD' })",
    "const binding = vueBinding<{ counter: typeof counter }>()",
    "void binding; void everyOrder; void onSchedule",
  ].join('\n')
  fs.writeFileSync(path.join(full, 'check.ts'), consumerTypes)
  execFileSync(process.execPath, [tscBin, '-p', 'tsconfig.json'], { cwd: full, stdio: 'inherit' })

  console.log('bare zero-peer install, all entries, state run, and consumer types ok')
} finally {
  fs.rmSync(work, { recursive: true, force: true })
}
