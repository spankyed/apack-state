// Merges mutants.allowed.json as a list of entries, not as lines: git runs it for the file (.gitattributes) once a
// checkout has it as a merge driver. Two branches that each add or take off entries near each other conflict as text
// and not as entries, and every rebase of one over the other stopped there.
//
// The result is ours, less each entry theirs took off, with each entry theirs added, and each why theirs changed
// where ours left it as it was. An entry is its key and what it changes. Where both changed one entry's why to two
// different things, ours is kept and the merge says it conflicts, naming the entry; nothing else does.
//
//   npm run mutants:merge-install      (has git use it in this checkout)
//   node scripts/mutants-merge.mjs <base> <ours> <theirs>   (as git runs it: %O %A %B, the result written to ours)
import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import { listText, nameOf, root } from './mutants-names.mjs'

if (process.argv[2] === '--install') {
  const git = (...args) => execFileSync('git', args, { cwd: root, stdio: 'inherit' })
  git('config', 'merge.mutants-list.name', 'mutants.allowed.json, entry by entry')
  git('config', 'merge.mutants-list.driver', 'node scripts/mutants-merge.mjs %O %A %B')
  console.log('git merges mutants.allowed.json entry by entry in this checkout. `git config --unset-all merge.mutants-list.driver` stops it.')
  process.exit(0)
}

const [baseFile, oursFile, theirsFile] = process.argv.slice(2)
/** A side as entries by name, or nothing where it is not a list (as a side a merge left half-done would be). */
const read = (file) => {
  try {
    const entries = JSON.parse(fs.readFileSync(file, 'utf8'))
    return Array.isArray(entries) ? entries : undefined
  } catch { return undefined }
}
const [base, ours, theirs] = [read(baseFile) ?? [], read(oursFile), read(theirsFile)]
// What is not a list is not merged here: git is left its own conflict to show.
if (!ours || !theirs) process.exit(1)

const named = (entries) => new Map(entries.map((entry) => [nameOf(entry.key, entry.original), entry]))
const [before, mine, other] = [named(base), named(ours), named(theirs)]

const conflicts = []
const merged = []
for (const [name, entry] of mine) {
  const was = before.get(name)
  const now = other.get(name)
  // Theirs took it off, and ours had it as it was
  if (was && !now) { if (entry.why !== was.why) conflicts.push(`${name}: theirs took it off, ours changed its why`); else continue }
  if (was && now && now.why !== was.why) {
    if (entry.why === was.why) { merged.push(now); continue }
    if (entry.why !== now.why) conflicts.push(`${name}: its why was changed on both sides`)
  }
  merged.push(entry)
}
for (const [name, entry] of other) {
  if (mine.has(name)) continue
  const was = before.get(name)
  // Ours took it off: gone, unless theirs changed it
  if (was) { if (entry.why !== was.why) { conflicts.push(`${name}: ours took it off, theirs changed its why`); merged.push(entry) } continue }
  merged.push(entry)
}

fs.writeFileSync(oursFile, listText(merged))
if (conflicts.length) {
  console.error(`mutants.allowed.json merged, but these conflict:\n${conflicts.map((line) => `  ${line}`).join('\n')}`)
  process.exit(1)
}
