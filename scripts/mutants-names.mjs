// How a mutant in a Stryker report is named in `mutants.allowed.json`, and which of a report's mutants survived. What
// `mutants.mjs` checks the list by, `mutants-list.mjs` writes it with, and `mutants-merge.mjs` merges it by.
import * as fs from 'node:fs'
import * as path from 'node:path'

export const root = path.resolve(import.meta.dirname, '..')
export const LIST = path.join(root, 'mutants.allowed.json')

/** What names a mutant across edits elsewhere in its file: its file, what it does, and the line it changes, as written. */
export const keyOf = (file, mutant, source) => {
  const line = source.split('\n')[mutant.location.start.line - 1]?.trim() ?? ''
  return `${file} | ${mutant.mutatorName} | ${line} | ${mutant.replacement ?? ''}`
}

/**
 * Which part of the line it changes, as written, with its spaces run together: two mutants of one kind on one line, to
 * the same replacement, are told apart by it. `!a || b` made `false` and `a` made `false` have one key and two of these.
 */
export const originalOf = (mutant, source) => {
  const lines = source.split('\n')
  const { start, end } = mutant.location
  const text = start.line === end.line
    ? lines[start.line - 1].slice(start.column - 1, end.column - 1)
    : [lines[start.line - 1].slice(start.column - 1), ...lines.slice(start.line, end.line - 1), lines[end.line - 1].slice(0, end.column - 1)].join('\n')
  return text.replace(/\s+/g, ' ').trim()
}

/** One entry of the list, or one survivor, as a single string: its key and what it changes. */
export const nameOf = (key, original) => `${key} | ${original}`

/** Every mutant of the reports, counted by status, and each that survived, named as the list names it. */
export const survivorsOf = (reports) => {
  const survived = []
  const counts = {}
  for (const report of reports) {
    const { files } = JSON.parse(fs.readFileSync(report, 'utf8'))
    for (const [file, { source, mutants }] of Object.entries(files)) {
      const rel = path.relative(root, path.resolve(root, file)).split(path.sep).join('/')
      for (const mutant of mutants) {
        counts[mutant.status] = (counts[mutant.status] ?? 0) + 1
        if (mutant.status !== 'Survived' && mutant.status !== 'NoCoverage') continue
        survived.push({ file: rel, mutator: mutant.mutatorName, replacement: mutant.replacement ?? '', key: keyOf(rel, mutant, source), original: originalOf(mutant, source), line: mutant.location.start.line, status: mutant.status })
      }
    }
  }
  return { survived, counts }
}

/** The list as it is written: two spaces, the characters as they are, and a newline at the end. */
export const listText = (entries) => `${JSON.stringify(entries, null, 2)}\n`
