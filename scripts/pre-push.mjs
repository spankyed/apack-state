// What is run before a push: lint, the typecheck, the API reports, the specs, and mutation testing of the files under
// src/ this push changes, against where the branch left master. Each runs as its own process, in turn, and the first
// that fails stops the push with its output.
//
//   npm run pre-push [-- --no-mutants] [-- --dry]   by hand
//   npm run hooks:install                           to have git run it before each push (opt in; nothing installs it
//                                                   otherwise)
//
// The full mutation run is CI's (.github/workflows/mutants.yml), a part of src/ a job. Here it is only what changed,
// so that a survivor is found before CI's runners find it. `--dry` says what it would run, and runs nothing.
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

const root = join(import.meta.dirname, '..')
const dry = process.argv.includes('--dry')
const mutants = !process.argv.includes('--no-mutants')
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()

/** Where this branch left master: what a push is measured against. */
const base = (() => {
  for (const ref of ['origin/master', 'master']) {
    try { return git('merge-base', 'HEAD', ref) } catch { /* not there */ }
  }
  return undefined
})()
/** The files under src/ that differ from where the branch left master, and are still there. */
const changed = base ? git('diff', '--name-only', base, 'HEAD', '--', 'src/').split('\n').filter((file) => file.endsWith('.ts') && existsSync(join(root, file))) : []

const steps = [
  ['lint', npm, ['run', 'lint']],
  ['typecheck', npm, ['run', 'typecheck']],
  ['API reports', npm, ['run', 'api:check']],
  ['specs', npm, ['test']],
  // Which files Stryker changes is what stryker.config.mjs reads from MUTATE, as CI's jobs give it.
  ...(mutants && changed.length ? [[`mutants in ${changed.join(', ')}`, npm, ['run', 'mutants'], { MUTATE: changed.join(',') }]] : []),
]
if (mutants && !changed.length) console.log(base ? 'No file under src/ changed: no mutants to run' : 'No master to measure against: no mutants to run')
for (const [what, command, args, env = {}] of steps) {
  if (dry) { console.log(`would run ${what}: ${Object.entries(env).map(([name, value]) => `${name}=${value} `).join('')}${command} ${args.join(' ')}`); continue }
  console.log(`\n── ${what}`)
  const ran = spawnSync(command, args, { cwd: root, stdio: 'inherit', shell: process.platform === 'win32', env: { ...process.env, ...env } })
  if (ran.status !== 0) {
    console.error(`\n${what} failed: not pushing.`)
    process.exit(1)
  }
}
// What a survivor is: the list CI holds src/ to applies here too.
if (!dry && mutants && changed.length && existsSync(join(root, 'reports', 'mutation', 'mutation.json'))) {
  const checked = spawnSync(process.execPath, [join(root, 'scripts', 'mutants.mjs'), join(root, 'reports', 'mutation', 'mutation.json')], { cwd: root, stdio: 'inherit' })
  if (checked.status !== 0) { console.error('\nA mutant survived that is not listed with why: not pushing.'); process.exit(1) }
}
