// Has git run `npm run pre-push` before each push from this checkout, by writing .git/hooks/pre-push. Run it to opt
// in; nothing else installs it. A hook that is there and is not this one is left alone.
import { existsSync, readFileSync, writeFileSync, chmodSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const hooks = resolve(root, execFileSync('git', ['rev-parse', '--git-path', 'hooks'], { cwd: root, encoding: 'utf8' }).trim())
const hook = join(hooks, 'pre-push')
const MARK = '# apack-state pre-push'
const text = `#!/bin/sh\n${MARK}: runs what npm run pre-push runs before each push (scripts/pre-push.mjs)\nexec npm run pre-push --silent\n`
if (existsSync(hook) && !readFileSync(hook, 'utf8').includes(MARK)) {
  console.error(`${hook} is there and is not this one: left as it is.`)
  process.exit(1)
}
writeFileSync(hook, text)
chmodSync(hook, 0o755)
console.log(`${hook} written: git runs npm run pre-push before each push. Delete it to stop.`)
