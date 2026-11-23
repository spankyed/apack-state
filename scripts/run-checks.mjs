// Runs every file that checks something, one after another, each as its own process: `npm test`.
// `npm run measure` runs the measurements instead, which print and refuse nothing.
// What is run is read from the folders, so a file added to one is run without being listed here.
import { spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'

const root = join(import.meta.dirname, '..')
const tsx = join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs')
const only = process.argv.slice(3)
/** A port that typechecks against stand-ins for what it imports and is not run */
const NOT_RUN = new Set(['library.mts'])
const sets = {
  checks: [
    ...readdirSync(join(root, 'checks')).filter((name) => name.endsWith('-check.mts') || name === 'rows-property.mts').map((name) => join('checks', name)),
    ...readdirSync(join(root, 'examples')).filter((name) => name.endsWith('.mts') && !NOT_RUN.has(name)).map((name) => join('examples', name)),
  ],
  measure: readdirSync(join(root, 'measure')).filter((name) => name.endsWith('.mts')).map((name) => join('measure', name)),
}
const files = sets[process.argv[2] ?? 'checks'].filter((file) => only.length === 0 || only.some((part) => file.includes(part)))
if (files.length === 0) {
  console.error('Nothing to run')
  process.exit(1)
}
const failed = []
for (const file of files) {
  const began = performance.now()
  const ran = spawnSync(process.execPath, [tsx, file], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' })
  const seconds = ((performance.now() - began) / 1000).toFixed(1)
  if (ran.status === 0) {
    console.log(`ok    ${file}  ${seconds}s`)
    if (process.argv[2] === 'measure') process.stdout.write(ran.stdout)
  } else {
    failed.push(file)
    console.log(`FAIL  ${file}  ${seconds}s  (exit ${ran.status ?? ran.signal})`)
    process.stdout.write(ran.stdout)
    process.stderr.write(ran.stderr)
  }
}
console.log(failed.length === 0 ? `${files.length} of ${files.length} passed` : `${failed.length} of ${files.length} failed: ${failed.join(', ')}`)
process.exit(failed.length === 0 ? 0 : 1)
