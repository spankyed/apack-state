// The package as a consumer gets it: a tarball installed into a project of its own, and each entry imported there by
// its name. `./vue` is installed with the Vue packages it names as peers, which a consumer that uses it has. Removes
// what it made either way.
//
//   node scripts/package-smoke.mjs [tarball]   (without one, packs this checkout: `prepack` builds dist/ first)
import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

// npm's own script, run by this Node: no shell, which on Windows would split a path at its spaces and read `^` as an
// escape, and nothing that could. `npm_execpath` is it when this runs under npm; beside Node is where npm installs it.
const npmCli = process.env.npm_execpath?.endsWith('.js') ? process.env.npm_execpath : path.join(path.dirname(process.execPath), process.platform === 'win32' ? '' : '..', process.platform === 'win32' ? '' : 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js')
const run = (args, cwd) => execFileSync(process.execPath, [npmCli, ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] })
const consumer = fs.mkdtempSync(path.join(os.tmpdir(), 'apack-state-consumer-'))
try {
  let tarball = process.argv[2] && path.resolve(process.argv[2])
  if (!tarball) {
    const [packed] = JSON.parse(run(['pack', '--json', '--pack-destination', consumer], path.resolve(import.meta.dirname, '..')))
    tarball = path.join(consumer, packed.filename)
  }
  if (!fs.existsSync(tarball)) throw new Error(`No tarball at ${tarball}`)
  // The peers `./vue` names are the consumer's own, as one that uses it has them.
  fs.writeFileSync(path.join(consumer, 'package.json'), JSON.stringify({ name: 'consumer', private: true, type: 'module', dependencies: { '@vue/reactivity': '^3.5.0', '@vue/runtime-core': '^3.5.0' } }))
  run(['install', '--no-audit', '--no-fund', '--no-package-lock', tarball], consumer)
  const load = [
    "const index = await import('@apackdev/state')",
    "for (const name of ['system', 'reaching', 'given', 'answered', 'within', 'Left', 'windowFrame']) if (!(name in index)) throw new Error(`@apackdev/state has no ${name}`)",
    "const vue = await import('@apackdev/state/vue')",
    "if (typeof vue.vueBinding !== 'function') throw new Error('@apackdev/state/vue has no vueBinding')",
    "const testing = await import('@apackdev/state/testing')",
    "for (const name of ['explore', 'sample', 'replay', 'everyOrdering', 'onSchedule', 'fromEvents']) if (typeof testing[name] !== 'function') throw new Error(`@apackdev/state/testing has no ${name}`)",
    // A state made and run, so that what loaded is the kernel and not only its names
    "const sys = index.system({ side: 'window' })",
    "const counter = index.reaching()()({ data: { count: 0 }, on: { ADD: (_, { data }) => ({ data: { count: data.count + 1 } }) } })",
    "const handle = sys.start('counter', counter)",
    "sys.send(handle, { type: 'ADD' })",
    // Until it has come to rest, a turn at a time: nothing here waits on a clock
    "while (!sys.idle()) await new Promise((resolve) => setImmediate(resolve))",
    "if (sys.read(handle).data.count !== 1) throw new Error('a state made from the installed package did not count')",
    "sys.stop()",
    "console.log('each entry loaded, and a state ran')",
  ].join('\n')
  fs.writeFileSync(path.join(consumer, 'load.mjs'), load)
  execFileSync(process.execPath, ['load.mjs'], { cwd: consumer, stdio: 'inherit' })
} finally {
  fs.rmSync(consumer, { recursive: true, force: true })
}
