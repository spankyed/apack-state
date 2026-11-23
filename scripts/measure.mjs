// Runs every measurement, one after another, each as its own process, and prints what each found: `npm run measure`.
// A measurement prints and refuses nothing. What is run is read from the folder, so one added to it is run without
// being listed here; `npm run measure -- rows` runs those whose path has `rows` in it.
import { spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'

const root = join(import.meta.dirname, '..')
const tsx = join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs')
const only = process.argv.slice(2)
const files = readdirSync(join(root, 'measure')).filter((name) => name.endsWith('.mts')).map((name) => join('measure', name))
  .filter((file) => only.length === 0 || only.some((part) => file.includes(part)))
if (files.length === 0) {
  console.error('Nothing to run')
  process.exit(1)
}
const failed = []
for (const file of files) {
  const began = performance.now()
  const ran = spawnSync(process.execPath, [tsx, file], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' })
  const seconds = ((performance.now() - began) / 1000).toFixed(1)
  console.log(`${ran.status === 0 ? 'ok  ' : 'FAIL'}  ${file}  ${seconds}s`)
  process.stdout.write(ran.stdout)
  if (ran.status !== 0) { failed.push(file); process.stderr.write(ran.stderr) }
}
process.exit(failed.length === 0 ? 0 : 1)
