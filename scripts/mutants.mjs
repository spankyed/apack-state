// Reads Stryker reports and says which mutants survived: each that no spec failed for. A survivor is either killed,
// by a spec that says what it changed, or listed in `mutants.allowed.json` with why no spec can tell it from the
// code as it is. This fails on any survivor not listed.
//
// Given every report of a run (`--all`), it also fails on a listed mutant that survived in none of them, so the list
// stays what is true. One job's report cannot say that: a job mutates part of a file, and the same line as written
// can be in another job's part.
//
//   node scripts/mutants.mjs reports/mutation/mutation.json [summary.md]
//   node scripts/mutants.mjs --all summary.md reports/*/mutation.json
import * as fs from 'node:fs'
import * as path from 'node:path'

const args = process.argv.slice(2)
const all = args[0] === '--all'
const [summary, ...reports] = all ? args.slice(1) : [args[1], args[0]]
const root = path.resolve(import.meta.dirname, '..')
const allowed = JSON.parse(fs.readFileSync(path.join(root, 'mutants.allowed.json'), 'utf8'))

/** What names a mutant across edits elsewhere in its file: its file, what it does, and the line it changes, as written. */
const keyOf = (file, mutant, source) => {
  const line = source.split('\n')[mutant.location.start.line - 1]?.trim() ?? ''
  return `${file} | ${mutant.mutatorName} | ${line} | ${mutant.replacement ?? ''}`
}
const allowedKeys = new Map(allowed.map((entry) => [entry.key, entry.why]))
const survived = []
const counts = {}
const seen = new Set()
const mutatedFiles = new Set()
for (const report of reports) {
  const { files } = JSON.parse(fs.readFileSync(report, 'utf8'))
  for (const [file, { source, mutants }] of Object.entries(files)) {
    const rel = path.relative(root, path.resolve(root, file)).split(path.sep).join('/')
    mutatedFiles.add(rel)
    for (const mutant of mutants) {
      counts[mutant.status] = (counts[mutant.status] ?? 0) + 1
      if (mutant.status !== 'Survived' && mutant.status !== 'NoCoverage') continue
      const key = keyOf(rel, mutant, source)
      seen.add(key)
      survived.push({ key, line: mutant.location.start.line, status: mutant.status, listed: allowedKeys.has(key) })
    }
  }
}
const stale = all ? allowed.filter((entry) => mutatedFiles.has(entry.key.split(' | ')[0]) && !seen.has(entry.key)) : []
const unlisted = survived.filter((one) => !one.listed)

const lines = [
  `Mutants: ${Object.entries(counts).map(([status, count]) => `${count} ${status}`).join(', ')}`,
  '',
  ...(unlisted.length ? ['Survived, and not listed in mutants.allowed.json:', '', ...unlisted.map((one) => `- line ${one.line} (${one.status}): \`${one.key}\``), ''] : []),
  ...(survived.length - unlisted.length ? [`${survived.length - unlisted.length} survived and are listed with why.`, ''] : []),
  ...(stale.length ? ['Listed, and no longer surviving: take them off the list.', '', ...stale.map((entry) => `- \`${entry.key}\``), ''] : []),
]
console.log(lines.join('\n'))
if (summary) fs.appendFileSync(summary, `${lines.join('\n')}\n`)
process.exit(unlisted.length || stale.length ? 1 : 0)
