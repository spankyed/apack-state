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
// With `--draft`, it prints ready-to-edit JSON entries for every unlisted survivor in the given reports. With
// `--sort`, it normalizes and canonically sorts `mutants.allowed.json`. With `--merge <base> <ours> <theirs>`, it
// performs a 3-way semantic merge by `(key, original)` for use as a git merge driver (`.gitattributes`).
//
//   node scripts/mutants.mjs reports/mutation/mutation.json [summary.md]
//   node scripts/mutants.mjs --all summary.md reports/*/mutation.json
//   node scripts/mutants.mjs --prune [--expect-none] <mutate> <report.json> [...]
//   node scripts/mutants.mjs --draft <report.json> [...]
//   node scripts/mutants.mjs --sort [mutants.allowed.json]
//   node scripts/mutants.mjs --merge <base.json> <ours.json> <theirs.json>
import * as fs from 'node:fs'
import * as path from 'node:path'

const args = process.argv.slice(2)
const root = path.resolve(import.meta.dirname, '..')
const defaultAllowedPath = process.env.MUTANTS_ALLOWED
  ? path.resolve(root, process.env.MUTANTS_ALLOWED)
  : path.join(root, 'mutants.allowed.json')

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
const nameOf = (key, original) => `${key} | ${original}`
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0)
const compareEntries = (a, b) => cmp(a.key, b.key) || cmp(a.original, b.original)
const normalizeEntry = (entry) => ({ key: entry.key, original: entry.original, why: entry.why })
const formatAllowed = (entries) => `${JSON.stringify([...entries].map(normalizeEntry).sort(compareEntries), null, 2)}\n`

const readAllowed = (filePath) => {
  const list = JSON.parse(fs.readFileSync(filePath, 'utf8'))
  if (!Array.isArray(list)) {
    console.error(`${filePath} must be a JSON array`)
    process.exit(1)
  }
  // An entry allows one mutant: the one of its key that changes what it names. One that names nothing would allow every
  // mutant its key has, the ones nobody looked at among them.
  const unnamed = list.filter((entry) => typeof entry?.original !== 'string')
  if (unnamed.length) {
    console.error(`Each entry in ${path.basename(filePath)} names the part of the line it allows (original); these do not:\n${unnamed.map((entry) => `- ${entry?.key}`).join('\n')}`)
    process.exit(1)
  }
  const invalid = list.filter((entry) => typeof entry.key !== 'string' || typeof entry.why !== 'string')
  if (invalid.length) {
    console.error(`Each entry in ${path.basename(filePath)} must have string key, original and why.`)
    process.exit(1)
  }
  const byName = new Map()
  const duplicates = []
  for (const entry of list) {
    const name = nameOf(entry.key, entry.original)
    if (byName.has(name)) duplicates.push(name)
    else byName.set(name, normalizeEntry(entry))
  }
  if (duplicates.length) {
    console.error(`Duplicate entries in ${path.basename(filePath)}:\n${duplicates.map((name) => `- ${name}`).join('\n')}`)
    process.exit(1)
  }
  return { list, byName }
}

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

if (args[0] === '--draft') {
  const reports = args.slice(1)
  if (!reports.length) {
    console.error('Usage: node scripts/mutants.mjs --draft <report.json> [...]')
    process.exit(1)
  }
  const { byName: allowed } = readAllowed(defaultAllowedPath)
  const drafts = new Map()
  for (const report of reports) {
    const { files } = JSON.parse(fs.readFileSync(report, 'utf8'))
    for (const [file, { source, mutants }] of Object.entries(files ?? {})) {
      const rel = path.relative(root, path.resolve(root, file)).split(path.sep).join('/')
      for (const mutant of mutants) {
        if (mutant.status !== 'Survived' && mutant.status !== 'NoCoverage') continue
        const key = keyOf(rel, mutant, source)
        const original = originalOf(mutant, source)
        const name = nameOf(key, original)
        if (!allowed.has(name) && !drafts.has(name)) drafts.set(name, { key, original, why: '' })
      }
    }
  }
  process.stdout.write(formatAllowed(drafts.values()))
  process.exit(0)
}

if (args[0] === '--sort') {
  const target = args[1] ? path.resolve(root, args[1]) : defaultAllowedPath
  const { byName } = readAllowed(target)
  const formatted = formatAllowed(byName.values())
  const current = fs.readFileSync(target, 'utf8')
  if (formatted !== current) {
    fs.writeFileSync(target, formatted)
    console.log(`Sorted ${byName.size} entries in ${path.relative(root, target) || target}`)
  }
  process.exit(0)
}

if (args[0] === '--merge') {
  const [basePath, oursPath, theirsPath] = args.slice(1)
  if (!basePath || !oursPath || !theirsPath) {
    console.error('Usage: node scripts/mutants.mjs --merge <base.json> <ours.json> <theirs.json>')
    process.exit(1)
  }
  const base = readAllowed(basePath).byName
  const ours = readAllowed(oursPath).byName
  const theirs = readAllowed(theirsPath).byName
  const merged = []
  const conflicts = []
  for (const name of new Set([...base.keys(), ...ours.keys(), ...theirs.keys()])) {
    const b = base.get(name)
    const o = ours.get(name)
    const t = theirs.get(name)
    if (o && t) {
      if (o.why === t.why) merged.push(o)
      else if (b && o.why === b.why) merged.push(t)
      else if (b && t.why === b.why) merged.push(o)
      else conflicts.push(`both sides changed/added with different why: ${name}`)
    } else if (o) {
      if (!b) merged.push(o)
      else if (o.why !== b.why) conflicts.push(`edited on ours, deleted on theirs: ${name}`)
    } else if (t) {
      if (!b) merged.push(t)
      else if (t.why !== b.why) conflicts.push(`deleted on ours, edited on theirs: ${name}`)
    }
  }
  if (conflicts.length) {
    console.error(`Cannot merge mutants.allowed.json cleanly:\n${conflicts.map((line) => `- ${line}`).join('\n')}`)
    process.exit(1)
  }
  fs.writeFileSync(oursPath, formatAllowed(merged))
  process.exit(0)
}

const all = args[0] === '--all'
const [summary, ...reports] = all ? args.slice(1) : [args[1], args[0]]
const { list: allowed, byName: allowedKeys } = readAllowed(defaultAllowedPath)
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
