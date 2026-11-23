// The benchmarks: each measurement in measure/ run as its own process, its readings recorded with the conditions
// they were read under. `npm run bench` prints each reading beside the one recorded in bench/<measurement>.json, and
// refuses nothing: a reading moves with the machine it is read on, so it informs and does not gate.
// `npm run bench:record` writes them, to be committed when they are what the repository should say.
//
//   npm run bench [-- <part of a name> ...]
//   npm run bench:record [-- <part of a name> ...]
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { cpus, loadavg, platform, release, tmpdir, totalmem } from 'node:os'
import { join } from 'node:path'

const root = join(import.meta.dirname, '..')
const tsx = join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs')
const record = process.argv.includes('--record')
const only = process.argv.slice(2).filter((arg) => arg !== '--record')
const measurements = readdirSync(join(root, 'measure')).filter((name) => name.endsWith('.mts') && name !== 'record.mts')
  .filter((name) => only.length === 0 || only.some((part) => name.includes(part)))
if (measurements.length === 0) { console.error('Nothing to run'); process.exit(1) }

const git = (...args) => { try { return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim() } catch { return 'unknown' } }
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
/** What a reading was taken under: when, on what, at what load, with which code. */
const conditions = () => ({
  date: new Date().toISOString(),
  commit: git('rev-parse', 'HEAD'),
  // Whether the code differs from the commit: the readings this writes into bench/ are not a change to it.
  changed: git('status', '--porcelain', '--', '.', ':(exclude)bench') !== '',
  cpu: cpus()[0]?.model ?? 'unknown',
  cores: cpus().length,
  memory: `${Math.round(totalmem() / 2 ** 30)} GB`,
  os: `${platform()} ${release()}`,
  node: process.version,
  load: platform() === 'win32' ? null : Number(loadavg()[0].toFixed(2)),
  elmdb: manifest.devDependencies?.elmdb ?? null,
})

const scratch = mkdtempSync(join(tmpdir(), 'apack-state-bench-'))
let failed = 0
try {
  for (const name of measurements) {
    const out = join(scratch, `${name}.json`)
    const began = conditions()
    console.log(`\n${name}`)
    const ran = spawnSync(process.execPath, [tsx, join('measure', name)], { cwd: root, env: { ...process.env, BENCH_OUT: out }, stdio: ['ignore', 'pipe', 'inherit'], encoding: 'utf8' })
    if (ran.status !== 0 || !existsSync(out)) { failed++; console.log(`  FAIL (exit ${ran.status ?? ran.signal})\n${ran.stdout}`); continue }
    const readings = JSON.parse(readFileSync(out, 'utf8'))
    const file = join(root, 'bench', name.replace(/\.mts$/, '.json'))
    const recorded = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : undefined
    const before = new Map((recorded?.readings ?? []).map((one) => [one.name, one.value]))
    for (const { name: what, value, unit } of readings) {
      const was = before.get(what)
      const beside = typeof was === 'number' && was !== 0 && Number.isFinite(value) ? `   (recorded ${was.toFixed(1)} ${unit}, ${(value / was).toFixed(2)}×)` : ''
      console.log(`  ${what.padEnd(84)} ${value.toFixed(1).padStart(10)} ${unit}${beside}`)
    }
    if (recorded) console.log(`  recorded ${recorded.conditions.date.slice(0, 10)} on ${recorded.conditions.cpu}, load ${recorded.conditions.load}, at ${recorded.conditions.commit.slice(0, 7)}`)
    if (record) {
      mkdirSync(join(root, 'bench'), { recursive: true })
      writeFileSync(file, `${JSON.stringify({ measurement: name, conditions: began, readings }, null, 2)}\n`)
      console.log(`  written to bench/${name.replace(/\.mts$/, '.json')}`)
    }
  }
} finally {
  rmSync(scratch, { recursive: true, force: true })
}
process.exit(failed ? 1 : 0)
