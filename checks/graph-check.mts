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
])
