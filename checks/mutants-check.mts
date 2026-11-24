// Pruning of sharded Stryker reports (`scripts/mutants.mjs --prune`): keeps every mutant inside a job's `MUTATE`
// scope and drops those carried over outside it, matching Stryker's own range and glob rules.
//
//   npx vitest run mutants
import { spawnSync } from 'node:child_process'
import { deepStrictEqual, ok, strictEqual } from 'node:assert'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { run } from './checks.mts'

const root = join(import.meta.dirname, '..')
const script = join(root, 'scripts', 'mutants.mjs')

interface Mutant {
  id: string
  mutatorName?: string
  replacement?: string
  location: { start: { line: number; column: number }; end: { line: number; column: number } }
  status: string
}
interface Report {
  files: Record<string, { source: string; mutants: Mutant[] }>
}
interface AllowedEntry {
  key: string
  original: string
  why: string
}

const mutant = (id: string, startLine: number, endLine = startLine, startCol = 1, endCol = 10): Mutant => ({
  id,
  location: { start: { line: startLine, column: startCol }, end: { line: endLine, column: endCol } },
  status: 'Survived',
})

const withDir = (body: (dir: string) => void): void => {
  const dir = mkdtempSync(join(tmpdir(), 'mutants-check-'))
  try {
    body(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const withReport = (initial: Report, body: (file: string) => void): void => {
  withDir((dir) => {
    const file = join(dir, 'report.json')
    writeFileSync(file, JSON.stringify(initial))
    body(file)
  })
}

const runScript = (args: string[], env?: Record<string, string>): { out: string; err: string; status: number | null } => {
  const ran = spawnSync(process.execPath, [script, ...args], { cwd: root, encoding: 'utf8', env: { ...process.env, ...env } })
  return { out: ran.stdout, err: ran.stderr, status: ran.status }
}
const prune = (...args: string[]) => runScript(['--prune', ...args])

const readReport = (file: string): Report => JSON.parse(readFileSync(file, 'utf8')) as Report
const readAllowed = (file: string): AllowedEntry[] => JSON.parse(readFileSync(file, 'utf8')) as AllowedEntry[]

await run([
  ['a line range keeps mutants just inside each boundary and drops those just outside or straddling', () => {
    const initial: Report = {
      files: {
        'src/kernel.ts': {
          source: 'x',
          mutants: [
            mutant('start-edge', 276, 276),
            mutant('end-edge', 550, 550),
            mutant('just-before', 275, 275),
            mutant('just-after', 551, 551),
            mutant('straddles-start', 274, 277),
            mutant('straddles-end', 549, 552),
          ],
        },
        'src/draft.ts': { source: 'y', mutants: [mutant('other-file', 10, 10)] },
      },
    }
    withReport(initial, (file) => {
      const { status, err } = prune('src/kernel.ts:276-550', file)
      strictEqual(status, 0, err)
      const after = readReport(file)
      deepStrictEqual(Object.keys(after.files), ['src/kernel.ts'])
      deepStrictEqual(after.files['src/kernel.ts']?.mutants.map((m) => m.id), ['start-edge', 'end-edge'])
    })
  }],
  ['a column range enforces start and end columns inclusively on 0-based boundaries', () => {
    const initial: Report = {
      files: {
        'src/kernel.ts': {
          source: 'x',
          mutants: [
            mutant('before-start-col', 5, 5, 4, 6), // 0-based col 3 < 4
            mutant('exact-bounds', 5, 6, 5, 5), // 0-based start col 4, end col 4
            mutant('past-end-col', 5, 6, 5, 6), // 0-based end col 5 > 4
          ],
        },
      },
    }
    withReport(initial, (file) => {
      const { status, err } = prune('src/kernel.ts:5:4-6:4', file)
      strictEqual(status, 0, err)
      deepStrictEqual(readReport(file).files['src/kernel.ts']?.mutants.map((m) => m.id), ['exact-bounds'])
    })
  }],
  ['a glob with negation keeps matching files, drops excluded ones even with zero mutants, and is a no-op once clean', () => {
    const initial: Report = {
      files: {
        'src/kernel.ts': { source: 'x', mutants: [mutant('excluded', 10, 10)] },
        'src/draft.ts': { source: 'y', mutants: [mutant('kept-top', 10, 10)] },
        'src/nested/part.ts': { source: 'z', mutants: [mutant('kept-nested', 10, 10)] },
      },
    }
    withReport(initial, (file) => {
      const first = prune('src/**/*.ts,!src/kernel.ts', file)
      strictEqual(first.status, 0, first.err)
      deepStrictEqual(Object.keys(readReport(file).files).sort(), ['src/draft.ts', 'src/nested/part.ts'])

      const mtime = statSync(file).mtimeMs
      const second = prune('src/**/*.ts,!src/kernel.ts', file)
      strictEqual(second.status, 0, second.err)
      strictEqual(second.out, '')
      strictEqual(statSync(file).mtimeMs, mtime)
    })

    const emptyExcluded: Report = {
      files: {
        'src/kernel.ts': { source: 'x', mutants: [] },
        'src/draft.ts': { source: 'y', mutants: [mutant('kept', 10, 10)] },
      },
    }
    withReport(emptyExcluded, (file) => {
      const ran = prune('src/**/*.ts,!src/kernel.ts', file)
      strictEqual(ran.status, 0, ran.err)
      ok(ran.out.includes('1 out-of-scope file(s)'), ran.out)
      deepStrictEqual(Object.keys(readReport(file).files), ['src/draft.ts'])
    })
  }],
  ['--expect-none passes when everything is in scope and fails when any mutant or file is outside it', () => {
    const clean: Report = {
      files: {
        'src/kernel.ts': { source: 'x', mutants: [mutant('in', 1, 1), mutant('edge', 275, 275)] },
      },
    }
    withReport(clean, (file) => {
      const ran = prune('--expect-none', 'src/kernel.ts:1-275', file)
      strictEqual(ran.status, 0, ran.err)
    })

    const outOfRange: Report = {
      files: {
        'src/kernel.ts': { source: 'x', mutants: [mutant('in', 275, 275), mutant('out', 276, 276)] },
      },
    }
    withReport(outOfRange, (file) => {
      const ran = prune('--expect-none', 'src/kernel.ts:1-275', file)
      ok(ran.status !== 0 && ran.err.includes('src/kernel.ts:276-276'), ran.err)
    })

    const extraFile: Report = {
      files: {
        'src/kernel.ts': { source: 'x', mutants: [mutant('in', 10, 10)] },
        'src/draft.ts': { source: 'y', mutants: [] },
      },
    }
    withReport(extraFile, (file) => {
      const ran = prune('--expect-none', 'src/kernel.ts:1-275', file)
      ok(ran.status !== 0 && ran.err.includes('src/draft.ts'), ran.err)
    })
  }],
  ['--draft prints canonically sorted, deduplicated entries for unlisted Survived and NoCoverage mutants', () => {
    withDir((dir) => {
      const allowed = join(dir, 'allowed.json')
      const r1 = join(dir, 'r1.json')
      const r2 = join(dir, 'r2.json')
      writeFileSync(allowed, JSON.stringify([
        { key: 'src/a.ts | BooleanLiteral | const ok = true | false', original: 'true', why: 'already listed' },
      ]))
      const source = 'const ok = true\nconst x = !a || b\n'
      writeFileSync(r1, JSON.stringify({
        files: {
          'src/a.ts': {
            source,
            mutants: [
              { id: '1', mutatorName: 'BooleanLiteral', replacement: 'false', location: { start: { line: 1, column: 12 }, end: { line: 1, column: 16 } }, status: 'Survived' },
              { id: '2', mutatorName: 'ConditionalExpression', replacement: 'false', location: { start: { line: 2, column: 11 }, end: { line: 2, column: 18 } }, status: 'Survived' },
              { id: '3', mutatorName: 'ConditionalExpression', replacement: 'false', location: { start: { line: 2, column: 11 }, end: { line: 2, column: 13 } }, status: 'NoCoverage' },
              { id: '4', mutatorName: 'BooleanLiteral', replacement: 'true', location: { start: { line: 1, column: 12 }, end: { line: 1, column: 16 } }, status: 'Killed' },
            ],
          },
        },
      }))
      // Duplicate of id 3 in a second report must only appear once
      writeFileSync(r2, JSON.stringify({
        files: {
          'src/a.ts': {
            source,
            mutants: [
              { id: '3b', mutatorName: 'ConditionalExpression', replacement: 'false', location: { start: { line: 2, column: 11 }, end: { line: 2, column: 13 } }, status: 'NoCoverage' },
            ],
          },
        },
      }))
      const ran = runScript(['--draft', r1, r2], { MUTANTS_ALLOWED: allowed })
      strictEqual(ran.status, 0, ran.err)
      deepStrictEqual(JSON.parse(ran.out), [
        { key: 'src/a.ts | ConditionalExpression | const x = !a || b | false', original: '!a', why: '' },
        { key: 'src/a.ts | ConditionalExpression | const x = !a || b | false', original: '!a || b', why: '' },
      ])
    })
  }],
  ['--sort normalizes key order, sorts canonically, checks order with --check, and rejects duplicates or empty why', () => {
    withDir((dir) => {
      const file = join(dir, 'allowed.json')
      writeFileSync(file, JSON.stringify([
        { why: 'second', key: 'src/b.ts | M | b | x', original: 'b' },
        { key: 'src/a.ts | M | a | x', original: 'a', why: 'first' },
      ]))
      const unsorted = runScript(['--sort', '--check', file])
      ok(unsorted.status !== 0 && unsorted.err.includes('npm run mutants:sort'), unsorted.err)

      const ran = runScript(['--sort', file])
      strictEqual(ran.status, 0, ran.err)
      const parsed = readAllowed(file)
      deepStrictEqual(parsed, [
        { key: 'src/a.ts | M | a | x', original: 'a', why: 'first' },
        { key: 'src/b.ts | M | b | x', original: 'b', why: 'second' },
      ])
      deepStrictEqual(Object.keys(parsed[1]!), ['key', 'original', 'why'])

      const sortedCheck = runScript(['--sort', '--check', file])
      strictEqual(sortedCheck.status, 0, sortedCheck.err)

      const dup = join(dir, 'dup.json')
      writeFileSync(dup, JSON.stringify([
        { key: 'src/a.ts | M | a | x', original: 'a', why: 'one' },
        { key: 'src/a.ts | M | a | x', original: 'a', why: 'two' },
      ]))
      const failed = runScript(['--sort', dup])
      ok(failed.status !== 0 && failed.err.includes('Duplicate entries'), failed.err)

      const emptyWhy = join(dir, 'empty-why.json')
      writeFileSync(emptyWhy, JSON.stringify([
        { key: 'src/a.ts | M | a | x', original: 'a', why: '   ' },
      ]))
      const rejected = runScript(['--sort', emptyWhy])
      ok(rejected.status !== 0 && rejected.err.includes('non-empty why'), rejected.err)
    })
  }],
  ['--merge combines disjoint additions, deletions, identical additions, one-sided why edits, and empty add/add base cleanly', () => {
    withDir((dir) => {
      const base = join(dir, 'base.json')
      const ours = join(dir, 'ours.json')
      const theirs = join(dir, 'theirs.json')
      const e = (id: string, why: string): AllowedEntry => ({ key: `src/${id}.ts | M | ${id} | x`, original: id, why })

      writeFileSync(base, JSON.stringify([
        e('keep', 'same'),
        e('drop-ours', 'stale'),
        e('drop-theirs', 'stale'),
        e('edit-ours', 'old'),
        e('edit-theirs', 'old'),
      ]))
      writeFileSync(ours, JSON.stringify([
        e('keep', 'same'),
        e('drop-theirs', 'stale'),
        e('edit-ours', 'new-ours'),
        e('edit-theirs', 'old'),
        e('add-ours', 'why-ours'),
        e('add-both', 'identical'),
      ]))
      writeFileSync(theirs, JSON.stringify([
        e('keep', 'same'),
        e('drop-ours', 'stale'),
        e('edit-ours', 'old'),
        e('edit-theirs', 'new-theirs'),
        e('add-theirs', 'why-theirs'),
        e('add-both', 'identical'),
      ]))

      const ran = runScript(['--merge', base, ours, theirs])
      strictEqual(ran.status, 0, ran.err)
      deepStrictEqual(readAllowed(ours), [
        e('add-both', 'identical'),
        e('add-ours', 'why-ours'),
        e('add-theirs', 'why-theirs'),
        e('edit-ours', 'new-ours'),
        e('edit-theirs', 'new-theirs'),
        e('keep', 'same'),
      ])

      // Add/add merge where git passes a 0-byte base file (%O)
      writeFileSync(base, '')
      writeFileSync(ours, JSON.stringify([e('one', 'why-one')]))
      writeFileSync(theirs, JSON.stringify([e('two', 'why-two')]))
      const addAdd = runScript(['--merge', base, ours, theirs])
      strictEqual(addAdd.status, 0, addAdd.err)
      deepStrictEqual(readAllowed(ours), [e('one', 'why-one'), e('two', 'why-two')])
    })
  }],
  ['--merge writes conflict markers into ours and preserves non-conflicting entries on real conflicts', () => {
    withDir((dir) => {
      const base = join(dir, 'base.json')
      const ours = join(dir, 'ours.json')
      const theirs = join(dir, 'theirs.json')
      const e = (id: string, why: string): AllowedEntry => ({ key: `src/${id}.ts | M | ${id} | x`, original: id, why })

      writeFileSync(base, JSON.stringify([e('a', 'orig'), e('b', 'orig'), e('keep', 'same')]))
      writeFileSync(ours, JSON.stringify([e('a', 'ours-why'), e('c', 'c-ours'), e('keep', 'same')]))
      writeFileSync(theirs, JSON.stringify([e('b', 'theirs-why'), e('c', 'c-theirs'), e('keep', 'same'), e('z-theirs', 'clean-add')]))

      const ran = runScript(['--merge', base, ours, theirs])
      ok(ran.status !== 0, 'expected merge conflict')
      ok(ran.err.includes('edited on ours, deleted on theirs'), ran.err)
      ok(ran.err.includes('deleted on ours, edited on theirs'), ran.err)
      ok(ran.err.includes('both sides changed/added with different why'), ran.err)
      const conflicted = readFileSync(ours, 'utf8')
      ok(conflicted.includes('<<<<<<< ours') && conflicted.includes('=======') && conflicted.includes('>>>>>>> theirs'), conflicted)
      ok(conflicted.includes('z-theirs') && conflicted.includes('clean-add'), conflicted)
    })
  }],
])
