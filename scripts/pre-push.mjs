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
//
// Run by git, it is told what is pushed. A push that only deletes runs nothing. What it checks is the checkout, so a
// push of something else than what is checked out is not checked here: CI checks it.
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'

const root = join(import.meta.dirname, '..')
const dry = process.argv.includes('--dry')
const mutants = !process.argv.includes('--no-mutants')
// npm's own script, run by this Node, with no shell to read a path or an argument on Windows.
const npmCli = process.env.npm_execpath?.endsWith('.js') ? process.env.npm_execpath : join(process.execPath, '..', process.platform === 'win32' ? '' : '../lib', 'node_modules', 'npm', 'bin', 'npm-cli.js')
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()

/** What git says is pushed, a line a ref: `<local ref> <local sha> <remote ref> <remote sha>`. Nothing when run by hand. */
const pushed = process.stdin.isTTY ? [] : readFileSync(0, 'utf8').split('\n').map((line) => line.trim().split(/\s+/)).filter((fields) => fields.length === 4)
const NONE = /^0+$/
if (pushed.length && pushed.every(([, sha]) => NONE.test(sha))) {
  console.log('Only deleting: nothing to check')
  process.exit(0)
}
const head = git('rev-parse', 'HEAD')
const elsewhere = pushed.filter(([, sha]) => !NONE.test(sha) && sha !== head).map(([ref]) => ref)
if (elsewhere.length) {
  console.log(`Pushing ${elsewhere.join(', ')}, which is not what is checked out: what is checked here is the checkout, so CI checks it`)
  process.exit(0)
}

/** Where this branch left master: what a push is measured against. */
const base = (() => {
  for (const ref of ['origin/master', 'master']) {
    try { return git('merge-base', 'HEAD', ref) } catch { /* not there */ }
  }
  return undefined
})()
/** The files under src/ that differ from where the branch left master, and are still there. */
const changed = base ? git('diff', '--name-only', base, 'HEAD', '--', 'src/').split('\n').filter((file) => file.endsWith('.ts') && file !== 'src/graph.ts' && existsSync(join(root, file))) : []

const npm = [process.execPath, npmCli]
const steps = [
  ['lint', npm, ['run', 'lint']],
  ['typecheck', npm, ['run', 'typecheck']],
  ['API reports', npm, ['run', 'api:check']],
  ['specs', npm, ['test']],
  // Which files Stryker changes is what stryker.config.mjs reads from MUTATE, as CI's jobs give it.
  ...(mutants && changed.length ? [[`mutants in ${changed.join(', ')}`, npm, ['run', 'mutants'], { MUTATE: changed.join(',') }]] : []),
]
const report = join(root, 'reports', 'mutation', 'mutation.json')
const surviving = mutants && changed.length
if (mutants && !changed.length) console.log(base ? 'No file under src/ changed: no mutants to run' : 'No master to measure against: no mutants to run')
// A report from an earlier run is not this run's.
if (!dry && surviving) rmSync(report, { force: true })
for (const [what, [node, cli], args, env = {}] of steps) {
  if (dry) { console.log(`would run ${what}: ${Object.entries(env).map(([name, value]) => `${name}=${value} `).join('')}npm ${args.join(' ')}`); continue }
  console.log(`\n── ${what}`)
  const ran = spawnSync(node, [cli, ...args], { cwd: root, stdio: 'inherit', env: { ...process.env, ...env } })
  if (ran.status !== 0) {
    console.error(`\n${what} failed: not pushing.`)
    process.exit(1)
  }
}
// What a survivor is: the list CI holds src/ to applies here too.
if (surviving && dry) console.log('would check reports/mutation/mutation.json against mutants.allowed.json')
if (surviving && !dry) {
  if (!existsSync(report)) { console.error('\nThe mutants ran and left no report, so what survived is not known: not pushing.'); process.exit(1) }
  const checked = spawnSync(process.execPath, [join(root, 'scripts', 'mutants.mjs'), report], { cwd: root, stdio: 'inherit' })
  if (checked.status !== 0) { console.error('\nA mutant survived that is not listed with why: not pushing.'); process.exit(1) }
}
