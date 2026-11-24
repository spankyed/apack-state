// Reads Stryker reports and says which mutants survived: each that no spec failed for. A survivor is either killed,
// by a spec that says what it changed, or listed in `mutants.allowed.json` with why no spec can tell it from the
// code as it is. This fails on any survivor not listed.
//
// Given every report of a run (`--all`), it also fails on a listed mutant that survived in none of them, so the list
// stays what is true. One job's report cannot say that: a job mutates part of a file, and the same line as written
// can be in another job's part.
//
// With `--prune <mutate>`, it drops any mutant outside `<mutate>` from each report in place. Stryker's incremental
// mode carries over cached mutants whose diff-shifted lines fall outside the current `MUTATE` range; pruning them
// keeps each sharded job's report and incremental file within its own part.
//
//   node scripts/mutants.mjs reports/mutation/mutation.json [summary.md]
//   node scripts/mutants.mjs --all summary.md reports/*/mutation.json
//   node scripts/mutants.mjs --prune <mutate> <report.json> [...]
import * as fs from 'node:fs'
import * as path from 'node:path'

const args = process.argv.slice(2)
const root = path.resolve(import.meta.dirname, '..')

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
  const [mutate, ...files] = args.slice(1)
  if (!mutate || !files.length) {
    console.error('Usage: node scripts/mutants.mjs --prune <mutate> <report.json> [...]')
    process.exit(1)
  }
  const patterns = mutate.split(',')
  for (const reportPath of files) {
    const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'))
    let removed = 0
    let dirty = false
    for (const [file, entry] of Object.entries(report.files ?? {})) {
      const rel = path.relative(root, path.resolve(root, file)).split(path.sep).join('/')
      const scope = scopeOf(rel, patterns)
      if (scope === false) {
        removed += entry.mutants.length
        delete report.files[file]
        dirty = true
      } else if (Array.isArray(scope)) {
        const kept = entry.mutants.filter((mutant) => scope.some((range) => inRange(range, mutant.location)))
        if (kept.length !== entry.mutants.length) {
          removed += entry.mutants.length - kept.length
          entry.mutants = kept
          dirty = true
        }
      }
    }
    if (dirty) {
      fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`)
      console.log(`Pruned ${removed} out-of-scope mutant(s) from ${reportPath}`)
    }
  }
  process.exit(0)
}

const all = args[0] === '--all'
const [summary, ...reports] = all ? args.slice(1) : [args[1], args[0]]
const allowed = JSON.parse(fs.readFileSync(path.join(root, 'mutants.allowed.json'), 'utf8'))

/** What names a mutant across edits elsewhere in its file: its file, what it does, and the line it changes, as written. */
const keyOf = (file, mutant, source) => {
  const line = source.split('\n')[mutant.location.start.line - 1]?.trim() ?? ''
  return `${file} | ${mutant.mutatorName} | ${line} | ${mutant.replacement ?? ''}`
}
/**
 * Which part of the line it changes, as written, with its spaces run together: two mutants of one kind on one line, to
 * the same replacement, are told apart by it. `!a || b` made `false` and `a` made `false` have one key and two of these.
 */
const originalOf = (mutant, source) => {
  const lines = source.split('\n')
  const { start, end } = mutant.location
  const text = start.line === end.line
    ? lines[start.line - 1].slice(start.column - 1, end.column - 1)
    : [lines[start.line - 1].slice(start.column - 1), ...lines.slice(start.line, end.line - 1), lines[end.line - 1].slice(0, end.column - 1)].join('\n')
  return text.replace(/\s+/g, ' ').trim()
}
// An entry allows one mutant: the one of its key that changes what it names. One that names nothing would allow every
// mutant its key has, the ones nobody looked at among them.
const unnamed = allowed.filter((entry) => typeof entry.original !== 'string')
if (unnamed.length) {
  console.error(`Each entry in mutants.allowed.json names the part of the line it allows (original); these do not:\n${unnamed.map((entry) => `- ${entry.key}`).join('\n')}`)
  process.exit(1)
}
const nameOf = (key, original) => `${key} | ${original}`
const allowedKeys = new Map(allowed.map((entry) => [nameOf(entry.key, entry.original), entry.why]))
const survived = []
const counts = {}
const seen = new Set()
for (const report of reports) {
  const { files } = JSON.parse(fs.readFileSync(report, 'utf8'))
  for (const [file, { source, mutants }] of Object.entries(files)) {
    const rel = path.relative(root, path.resolve(root, file)).split(path.sep).join('/')
    for (const mutant of mutants) {
      counts[mutant.status] = (counts[mutant.status] ?? 0) + 1
      if (mutant.status !== 'Survived' && mutant.status !== 'NoCoverage') continue
      const key = keyOf(rel, mutant, source)
      const original = originalOf(mutant, source)
      seen.add(nameOf(key, original))
      survived.push({ key, original, line: mutant.location.start.line, status: mutant.status, listed: allowedKeys.has(nameOf(key, original)) })
    }
  }
}
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
]
console.log(lines.join('\n'))
if (summary) fs.appendFileSync(summary, `${lines.join('\n')}\n`)
process.exit(unlisted.length || stale.length ? 1 : 0)
