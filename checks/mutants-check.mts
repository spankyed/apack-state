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
  location: { start: { line: number; column: number }; end: { line: number; column: number } }
  status: string
}
interface Report {
  files: Record<string, { source: string; mutants: Mutant[] }>
}

const mutant = (id: string, startLine: number, endLine = startLine, startCol = 1, endCol = 10): Mutant => ({
  id,
  location: { start: { line: startLine, column: startCol }, end: { line: endLine, column: endCol } },
  status: 'Survived',
})

const withReport = (initial: Report, body: (file: string) => void): void => {
  const dir = mkdtempSync(join(tmpdir(), 'mutants-check-'))
  const file = join(dir, 'report.json')
  try {
    writeFileSync(file, JSON.stringify(initial))
    body(file)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const prune = (...args: string[]): { out: string; err: string; status: number | null } => {
  const ran = spawnSync(process.execPath, [script, '--prune', ...args], { cwd: root, encoding: 'utf8' })
  return { out: ran.stdout, err: ran.stderr, status: ran.status }
}

const readReport = (file: string): Report => JSON.parse(readFileSync(file, 'utf8')) as Report

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
])
