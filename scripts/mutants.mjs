// Reads Stryker reports and says which mutants survived: each that no spec failed for. A survivor is either killed,
// by a spec that says what it changed, or listed in `mutants.allowed.json` with why no spec can tell it from the
// code as it is. This fails on any survivor not listed.
//
// Given every report of a run (`--all`), it also fails on a listed mutant that survived in none of them, so the list
// stays what is true. One job's report cannot say that: a job mutates part of a file, and the same line as written
// can be in another job's part.
//
// With `--prune [--expect-none] <mutate>`, it drops any mutant outside `<mutate>` from each report in place. Stryker's
// incremental mode carries over cached mutants whose diff-shifted lines fall outside the current `MUTATE` range;
// pruning them keeps each sharded job's report and incremental file within its own part. `--expect-none` fails if
// anything was out of scope, so forced full runs check that the prune agrees with Stryker.
//
//   node scripts/mutants.mjs reports/mutation/mutation.json [summary.md]
//   node scripts/mutants.mjs --all summary.md reports/*/mutation.json
//   node scripts/mutants.mjs --prune [--expect-none] <mutate> <report.json> [...]
//
// `npm run mutants:list` writes the list from a run's reports, for what this fails on.
import * as fs from 'node:fs'
import * as path from 'node:path'
import { LIST, nameOf, root, survivorsOf } from './mutants-names.mjs'

const args = process.argv.slice(2)

// Same range syntax as Stryker's ProjectReader (`file:startLine[:startCol]-endLine[:endCol]`), 1-based lines and
// 0-based columns when given (defaulting to 0..Infinity). Report positions are 1-based and converted to 0-based.
const RANGE = /^(.*?):(\d+)(?::(\d+))?-(\d+)(?::(\d+))?$/
const gte = (a, b) => a.line > b.line || (a.line === b.line && a.column >= b.column)
const inRange = (range, loc) => {
  const start = { line: loc.start.line - 1, column: loc.start.column - 1 }
  const end = { line: loc.end.line - 1, column: loc.end.column - 1 }
  return gte(start, range.start) && gte(range.end, end)
}
const scopeOf = (rel, patterns) => {
  let scope = false
  for (const raw of patterns) {
    if (raw.startsWith('!')) {
      if (path.posix.matchesGlob(rel, raw.slice(1))) scope = false
      continue
    }
    const match = RANGE.exec(raw)
    if (match) {
      const [, filePattern, startLine, startCol = '0', endLine, endCol] = match
      if (!path.posix.matchesGlob(rel, filePattern) || scope === true) continue
      const range = {
        start: { line: Number(startLine) - 1, column: Number(startCol) },
        end: { line: Number(endLine) - 1, column: endCol === undefined ? Number.POSITIVE_INFINITY : Number(endCol) },
      }
      scope = Array.isArray(scope) ? [...scope, range] : [range]
    } else if (path.posix.matchesGlob(rel, raw)) {
      scope = true
    }
  }
  return scope
}

if (args[0] === '--prune') {
  const rest = args.slice(1)
  const expectNone = rest[0] === '--expect-none'
  const [mutate, ...files] = expectNone ? rest.slice(1) : rest
  if (!mutate || !files.length) {
    console.error('Usage: node scripts/mutants.mjs --prune [--expect-none] <mutate> <report.json> [...]')
    process.exit(1)
  }
  const patterns = mutate.split(',')
  let unexpected = false
  for (const reportPath of files) {
    const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'))
    let removedMutants = 0
    let removedFiles = 0
    const samples = []
    for (const [file, entry] of Object.entries(report.files ?? {})) {
      const rel = path.relative(root, path.resolve(root, file)).split(path.sep).join('/')
      const scope = scopeOf(rel, patterns)
      if (scope === false) {
        removedFiles++
        removedMutants += entry.mutants.length
        if (samples.length < 5) samples.push(`${rel} (${entry.mutants.length} mutant(s))`)
        delete report.files[file]
      } else if (Array.isArray(scope)) {
        const kept = []
        for (const mutant of entry.mutants) {
          if (scope.some((range) => inRange(range, mutant.location))) {
            kept.push(mutant)
          } else {
            removedMutants++
            if (samples.length < 5) samples.push(`${rel}:${mutant.location.start.line}-${mutant.location.end.line}`)
          }
        }
        entry.mutants = kept
      }
    }
    if (removedMutants > 0 || removedFiles > 0) {
      if (expectNone) {
        unexpected = true
        const detail = [
          removedMutants > 0 ? `${removedMutants} out-of-scope mutant(s)` : '',
          removedFiles > 0 ? `${removedFiles} out-of-scope file(s)` : '',
        ].filter(Boolean).join(' and ')
        console.error(`Expected no out-of-scope results for ${mutate} in ${reportPath}, found ${detail}: ${samples.join(', ')}`)
      } else {
        fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`)
        const what = removedMutants > 0 ? `${removedMutants} out-of-scope mutant(s)` : `${removedFiles} out-of-scope file(s)`
        console.log(`Pruned ${what} from ${reportPath}`)
      }
    }
  }
  process.exit(unexpected ? 1 : 0)
}

const all = args[0] === '--all'
const [summary, ...reports] = all ? args.slice(1) : [args[1], args[0]]
const allowed = JSON.parse(fs.readFileSync(LIST, 'utf8'))

// An entry allows one mutant: the one of its key that changes what it names. One that names nothing would allow every
// mutant its key has, the ones nobody looked at among them.
const unnamed = allowed.filter((entry) => typeof entry.original !== 'string')
if (unnamed.length) {
  console.error(`Each entry in mutants.allowed.json names the part of the line it allows (original); these do not:\n${unnamed.map((entry) => `- ${entry.key}`).join('\n')}`)
  process.exit(1)
}
// An entry says why no spec can tell its mutant from the code. `npm run mutants:list` writes one without, for its
// author to fill in.
const whyless = allowed.filter((entry) => typeof entry.why !== 'string' || !entry.why.trim())
if (whyless.length) {
  console.error(`Each entry in mutants.allowed.json says why its mutant survives (why); these do not:\n${whyless.map((entry) => `- ${entry.key}, changing ${entry.original}`).join('\n')}`)
  process.exit(1)
}
const allowedKeys = new Map(allowed.map((entry) => [nameOf(entry.key, entry.original), entry.why]))
const { survived: survivors, counts } = survivorsOf(reports)
const seen = new Set(survivors.map((one) => nameOf(one.key, one.original)))
const survived = survivors.map((one) => ({ ...one, listed: allowedKeys.has(nameOf(one.key, one.original)) }))
// Every report of a run mutates every file there is: an entry none of them has, for a file that is gone as well as
// for a mutant that is killed, is stale.
const stale = all ? allowed.filter((entry) => !seen.has(nameOf(entry.key, entry.original))) : []
const unlisted = survived.filter((one) => !one.listed)

const lines = [
  `Mutants: ${Object.entries(counts).map(([status, count]) => `${count} ${status}`).join(', ')}`,
  '',
  ...(unlisted.length ? ['Survived, and not listed in mutants.allowed.json:', '', ...unlisted.map((one) => `- line ${one.line} (${one.status}): \`${one.key}\`, changing \`${one.original}\``), ''] : []),
  ...(survived.length - unlisted.length ? [`${survived.length - unlisted.length} survived and are listed with why.`, ''] : []),
  ...(stale.length ? ['Listed, and no longer surviving: take them off the list.', '', ...stale.map((entry) => `- \`${entry.key}\`, changing \`${entry.original}\``), ''] : []),
  ...(unlisted.length || stale.length ? ['`npm run mutants:list -- <run id>` writes the list from this run, each new entry for its why.', ''] : []),
]
console.log(lines.join('\n'))
if (summary) fs.appendFileSync(summary, `${lines.join('\n')}\n`)
process.exit(unlisted.length || stale.length ? 1 : 0)
