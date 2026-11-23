// The parts of apack ported to the kernel, each run as it is written, as its own process: an example runs what it
// shows only when it is the program being run, and checks what every step leaves as it goes, exiting with a failure
// where something is not what it says.
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { expect, it } from 'vitest'

const root = join(import.meta.dirname, '..')
const tsx = join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs')

for (const name of ['commit', 'search', 'threads', 'views']) {
  it(`examples/${name}.mts runs, and each step leaves what it says`, () => {
    // Waits for the process to exit, whatever it does.
    const ran = spawnSync(process.execPath, [tsx, join('examples', `${name}.mts`)], { cwd: root, encoding: 'utf8' })
    expect(ran.status, `${ran.stdout}\n${ran.stderr}`).toBe(0)
  })
}
