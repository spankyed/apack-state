// Writes mutants.allowed.json from every report of one mutants run: what `scripts/mutants.mjs` would fail on, made
// right. A listed mutant that survived in none of the reports is taken off. A survivor not listed is added, with its
// key and what it changes taken from the report, and a why left empty for its author to write: the check refuses an
// entry without one, so nothing is allowed that nobody looked at.
//
// A survivor whose line was rewritten has a new key, so its entry goes and a new one comes. Where exactly one entry
// that goes is for the same file, the same mutation and the same text changed, the new one is given its why, and
// says so here, to be read again.
//
//   npm run mutants:list -- <run id>              (its reports downloaded with gh, from this repository's runs)
//   npm run mutants:list -- reports/*/mutation.json
//
// The reports are taken as the whole run: given part of one, entries for what the rest mutates would go as stale.
import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { LIST, listText, nameOf, survivorsOf } from './mutants-names.mjs'

const args = process.argv.slice(2)
if (args.length === 0) {
  console.error('Give a mutants run id, or every mutation.json of one run')
  process.exit(1)
}
const fromRun = (id) => {
  const into = fs.mkdtempSync(path.join(os.tmpdir(), `mutants-${id}-`))
  execFileSync('gh', ['run', 'download', id, '--pattern', 'mutants-*', '--dir', into], { stdio: 'inherit' })
  return fs.readdirSync(into).map((name) => path.join(into, name, 'mutation.json')).filter((file) => fs.existsSync(file))
}
const reports = args.length === 1 && /^\d+$/.test(args[0]) ? fromRun(args[0]) : args
if (reports.length === 0) {
  console.error('No reports found')
  process.exit(1)
}

const list = JSON.parse(fs.readFileSync(LIST, 'utf8'))
const { survived } = survivorsOf(reports)
const surviving = new Set(survived.map((one) => nameOf(one.key, one.original)))
const kept = list.filter((entry) => surviving.has(nameOf(entry.key, entry.original)))
const gone = list.filter((entry) => !surviving.has(nameOf(entry.key, entry.original)))

/** What an entry says apart from its line: file, mutation, replacement, and the text it changes. */
const shapeOf = (key, original) => {
  const [file, mutator] = key.split(' | ')
  const replacement = key.slice(key.lastIndexOf(' | ') + 3)
  return [file, mutator, replacement, original].join(' | ')
}
const goneByShape = Map.groupBy(gone, (entry) => shapeOf(entry.key, entry.original))

const listed = new Set(kept.map((entry) => nameOf(entry.key, entry.original)))
const added = []
const carried = []
for (const one of survived) {
  const name = nameOf(one.key, one.original)
  if (listed.has(name)) continue
  listed.add(name)
  const was = goneByShape.get(shapeOf(one.key, one.original))
  const why = was?.length === 1 ? was[0].why : ''
  if (why) carried.push(one)
  added.push({ key: one.key, original: one.original, why })
}
const rewritten = new Set(carried.map((one) => shapeOf(one.key, one.original)))
const removed = gone.filter((entry) => !rewritten.has(shapeOf(entry.key, entry.original)))

fs.writeFileSync(LIST, listText([...kept, ...added]))

const say = (title, items) => { if (items.length) console.log(`${title}\n${items.map((line) => `  ${line}`).join('\n')}\n`) }
say(`Taken off, as surviving in none of ${reports.length} reports:`, removed.map((entry) => `${entry.key}, changing ${entry.original}`))
say('Their line was rewritten; given the why they had, to be read again:', carried.map((one) => `${one.key}, changing ${one.original}`))
const whyless = added.filter((entry) => !entry.why)
say('Added, each needing its why, or a spec that kills it:', whyless.map((entry) => `${entry.key}, changing ${entry.original}`))
console.log(`mutants.allowed.json: ${kept.length + added.length} entries (${removed.length} taken off, ${carried.length} carried over, ${whyless.length} added without why)`)
