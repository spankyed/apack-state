// What the compiler says of a definition it refuses, read whole. `docs/errors.md` shows the start of each error, and
// where what is refused is a function the start is that function's type: the reason comes after. These hold the
// reason itself, for each rule that gives one.
//
//   npx vitest run refusals
import { deepStrictEqual, ok, throws } from 'node:assert'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import ts from 'typescript'
import { given, state } from '../src/index.ts'
import { run, system } from './checks.mts'

const root = join(import.meta.dirname, '..')
/** Every error the compiler has for this source, each as one text with all it says beneath its first line. */
const errorsIn = (source: string): string[] => {
  const work = mkdtempSync(join(tmpdir(), 'apack-refusals-'))
  try {
    const file = join(work, 'states.ts')
    writeFileSync(file, `import { state } from '${join(root, 'src', 'index.ts').replaceAll('\\', '/')}'\n${source}`)
    const read = ts.readConfigFile(join(root, 'tsconfig.json'), ts.sys.readFile)
    const { options } = ts.parseJsonConfigFileContent(read.config, ts.sys, root)
    const program = ts.createProgram([file], { ...options, noErrorTruncation: true })
    return ts.getPreEmitDiagnostics(program, program.getSourceFile(file)).map((each) => ts.flattenDiagnosticMessageText(each.messageText, '\n'))
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}
/** That one of the errors says this, and that there is an error for each place it has to be said. */
const says = (errors: string[], reason: string, times = 1): void => {
  const saying = errors.filter((error) => error.includes(`Refused<"${reason}"`) || error.includes(`"${reason}"`))
  ok(saying.length === times, `${times} of: ${reason}\n\ngot ${saying.length} of ${errors.length}:\n${errors.join('\n---\n')}`)
}

await run([
  ['a name declared again inside a state that declares it is refused by that name, whichever of the three it is', () => {
    const errors = errorsIn(`
export const field = state<{ data: { n: number }; states: { idle: {}; s: { data: { n: number } } } }>()({ data: { n: 0 }, initial: 'idle', states: { idle: {}, s: { data: { n: 1 } } } })
export const call = state<{ calls: { save: 'one' }; states: { s: { calls: { save: 'one' } } } }>()({
  initial: 's', calls: ({ one }) => ({ save: one('svc' as never, 'SAVE' as never, { done: () => {} } as never) }),
  states: { s: { calls: ({ one }) => ({ save: one('svc' as never, 'SAVE' as never, { done: () => {} } as never) }) } },
})
export const wait = state<{ waits: { retry: 'one' }; states: { s: { waits: { retry: 'one' } } } }>()({
  initial: 's', waits: ({ one }) => ({ retry: one(100) }),
  states: { s: { waits: ({ one }) => ({ retry: one(100) }) } },
})
`)
    says(errors, `data field 'n' is already declared by an enclosing state`)
    says(errors, `call 'save' is already declared by an enclosing state`)
    says(errors, `wait 'retry' is already declared by an enclosing state`)
  }],
  ['a name declared with two kinds is refused in each state that declares it, naming each kind', () => {
    const errors = errorsIn(`
export const call = state<{ states: { a: { calls: { save: 'one' } }; b: { calls: { save: 'each' } } } }>()({
  initial: 'a',
  states: {
    a: { calls: ({ one }) => ({ save: one('svc' as never, 'SAVE' as never, { done: () => {} } as never) }) },
    b: { calls: ({ each }) => ({ save: each('svc' as never, 'SAVE' as never, { done: () => {} } as never) }) },
  },
})
export const wait = state<{ states: { a: { waits: { retry: 'one' } }; b: { waits: { retry: 'each' } } } }>()({
  initial: 'a',
  states: { a: { waits: ({ one }) => ({ retry: one(100) }) }, b: { waits: ({ each }) => ({ retry: each(100) }) } },
})
`)
    // Each of the two states is told of both kinds: the one it declared and the one that is declared beside it.
    for (const what of ['call \'save\'', 'wait \'retry\'']) {
      const [first, second] = [...new Set(errors.flatMap((error) => [...error.matchAll(new RegExp(`${what} is declared with more than one kind across states: '(\\w+)' is one of them`, 'g'))].map((found) => found[1]!)))].sort()
      ok(first && second && first !== second, `${what}: two kinds named, got ${first}, ${second}\n${errors.join('\n---\n')}`)
      says(errors, `${what} is declared with more than one kind across states: '${first}' is one of them`, 2)
      says(errors, `${what} is declared with more than one kind across states: '${second}' is one of them`, 2)
    }
  }],
  ['a field that has to be given is refused in the state entered first, by name; a state whose data has its own values is not; and a name that is no state is told the states there are', () => {
    const shape = `{ states: { idle: {}; a: { data: { m: number } }; b: { data: { m: number } } } }`
    const errors = errorsIn(`
import { given } from '${join(root, 'src', 'index.ts').replaceAll('\\', '/')}'
export const defaulted = state<${shape}>()({ initial: 'b', states: { idle: {}, a: { data: { m: 1 } }, b: { data: { m: 1 } } } })
export const needing = state<${shape}>()({ initial: 'b', states: { idle: {}, a: { data: { m: given } }, b: { data: { m: given } } } })
export const typo = state<${shape}>()({ initial: 'idel', states: { idle: {}, a: { data: { m: 1 } }, b: { data: { m: 1 } } } })
`)
    ok(errors.length === 2, errors.join('\n---\n'))
    // Only the state named is entered first: `a` has the same field to be given, and is not spoken of.
    says(errors, `data field 'm' cannot be given: an initial state is entered with nothing given`)
    ok(errors.some((error) => error.includes(`'"idel"' is not assignable to type '"idle" | "a" | "b"'`)), errors.join('\n---\n'))
  }],
  ['what is refused there is what cannot start, and what is not, starts', () => {
    const sys = system({ side: 'backend' })
    const it = sys.start('defaulted', state<{ states: { idle: {}; b: { data: { m: number } } } }>()({ initial: 'b', states: { idle: {}, b: { data: { m: 1 } } } }))
    deepStrictEqual(sys.read(it), { at: 'b', data: { m: 1 } })
    throws(() => sys.start('needing', { def: { initial: 'b', states: { idle: {}, b: { data: { m: given } } } } } as never), { message: 'needing cannot start at b without m' })
    sys.stop()
  }],
])
