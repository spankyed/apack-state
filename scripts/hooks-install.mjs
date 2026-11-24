// Has git run `npm run pre-push` before each push from this checkout, by writing pre-push into this repository's own
// hooks. Run it to opt in; nothing else installs it. A hook that is there and is not this one is left alone.
//
// Hooks set elsewhere (`core.hooksPath`) are hooks every repository using them runs: one written there would run this
// repository's checks in all of them, and stop their pushes. So with it set, nothing is written.
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
const hooksPath = (() => { try { return git('config', '--get', 'core.hooksPath') } catch { return '' } })()
if (hooksPath) {
  console.error(`core.hooksPath is set (${hooksPath}): a hook written there runs for every repository that uses it. Nothing written.`)
  process.exit(1)
}
const hooks = join(resolve(root, git('rev-parse', '--git-common-dir')), 'hooks')
const hook = join(hooks, 'pre-push')
const MARK = '# apack-state pre-push'
const text = `#!/bin/sh\n${MARK}: runs what npm run pre-push runs before each push (scripts/pre-push.mjs)\nexec npm run pre-push --silent\n`
if (existsSync(hook) && !readFileSync(hook, 'utf8').includes(MARK)) {
  console.error(`${hook} is there and is not this one: left as it is.`)
  process.exit(1)
}
mkdirSync(hooks, { recursive: true })
writeFileSync(hook, text)
chmodSync(hook, 0o755)
// Repo-local merge driver for `mutants.allowed.json` (`.gitattributes`): merges entries by `(key, original)`.
git('config', 'merge.mutants-allowed.name', 'Three-way merge of mutants.allowed.json by entry')
git('config', 'merge.mutants-allowed.driver', 'node scripts/mutants.mjs --merge %O %A %B')
console.log(`${hook} written: git runs npm run pre-push before each push, and merges mutants.allowed.json by entry. Delete the hook to stop.`)
