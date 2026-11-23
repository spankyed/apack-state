// The packed package checked as published code: `publint` for what its manifest and files say, and `attw` (Are the
// Types Wrong?) for whether each entry's types resolve to what Node loads. Both read the tarball `npm pack` makes, so
// what is checked is what a consumer installs. Removes what it made either way.
//
//   node scripts/package-lint.mjs   (packs this checkout: `prepack` builds dist/ first)
//
// The package is ESM alone, for Node and for bundlers, so attw runs the `esm-only` profile: a `require` of it is not
// something it offers.
import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
// Each tool's own script, run by this Node: no shell, which on Windows would split a path at its spaces.
const npmCli = process.env.npm_execpath?.endsWith('.js') ? process.env.npm_execpath : path.join(path.dirname(process.execPath), process.platform === 'win32' ? '' : '..', process.platform === 'win32' ? '' : 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js')
/** The script a package installed here runs as `name`, from what its manifest says. */
const bin = (pkg, name) => {
  const dir = path.join(root, 'node_modules', pkg)
  const { bin: bins } = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'))
  return path.join(dir, typeof bins === 'string' ? bins : bins[name])
}
const out = fs.mkdtempSync(path.join(os.tmpdir(), 'apack-state-pack-'))
let failed = false
try {
  const [packed] = JSON.parse(execFileSync(process.execPath, [npmCli, 'pack', '--json', '--pack-destination', out], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }))
  const tarball = path.join(out, packed.filename)
  for (const [what, command, args] of [
    ['publint', bin('publint', 'publint'), ['run', tarball, '--strict', '--level', 'suggestion']],
    ['attw', bin('@arethetypeswrong/cli', 'attw'), [tarball, '--profile', 'esm-only']],
  ]) {
    try {
      execFileSync(process.execPath, [command, ...args], { cwd: root, stdio: 'inherit' })
    } catch {
      failed = true
      console.error(`${what} found a problem with ${packed.filename}`)
    }
  }
} finally {
  fs.rmSync(out, { recursive: true, force: true })
}
process.exit(failed ? 1 : 0)
