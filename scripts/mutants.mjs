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
//
// `npm run mutants:list` writes the list from a run's reports, for what this fails on.
import * as fs from 'node:fs'
import { LIST, nameOf, survivorsOf } from './mutants-names.mjs'

const args = process.argv.slice(2)
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
