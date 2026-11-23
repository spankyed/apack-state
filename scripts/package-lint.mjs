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
const windows = process.platform === 'win32'
const npm = windows ? 'npm.cmd' : 'npm'
const bin = (name) => path.join(root, 'node_modules', '.bin', windows ? `${name}.cmd` : name)
const out = fs.mkdtempSync(path.join(os.tmpdir(), 'apack-state-pack-'))
let failed = false
try {
  const [packed] = JSON.parse(execFileSync(npm, ['pack', '--json', '--pack-destination', out], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], shell: windows }))
  const tarball = path.join(out, packed.filename)
  for (const [what, command, args] of [
    ['publint', bin('publint'), ['run', tarball, '--strict', '--level', 'suggestion']],
    ['attw', bin('attw'), [tarball, '--profile', 'esm-only']],
  ]) {
    try {
      execFileSync(command, args, { cwd: root, stdio: 'inherit', shell: windows })
    } catch {
      failed = true
      console.error(`${what} found a problem with ${packed.filename}`)
    }
  }
} finally {
  fs.rmSync(out, { recursive: true, force: true })
}
process.exit(failed ? 1 : 0)
