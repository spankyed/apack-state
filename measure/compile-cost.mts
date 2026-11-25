// What it costs TypeScript to check many states: a measurement. It prints, and refuses nothing.
//
// Writes a project of N states into `.temp/compile/<N>/`, each as a pack's would be: its own data, events, asks it
// answers, a view it follows, a read it awaits, a write it makes, and states inside it, all forNet one app's
// systems and views. Then checks it with this repository's TypeScript, once warm, and reads what TypeScript says it
// took (`--extendedDiagnostics`): the time to check, the types it made, and the memory it used, beside the wall time.
//
//   npx tsx measure/compile-cost.mts [N ...]   (10, 100 and 300 unless given)
import { execFileSync } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { cpus, loadavg } from 'node:os'
import { join } from 'node:path'
import { reading, under } from './record.mts'

const root = join(import.meta.dirname, '..')
const tsc = join(root, 'node_modules', 'typescript', 'bin', 'tsc')
const sizes = process.argv.slice(2).map(Number).filter((n) => n > 0)

/** One state, as a pack writes one. */
const stateFile = (at: number): string => `import { answered, given, type Outcome } from '../../../../src/index.ts'
import { state } from './app.ts'

type Shape${at} = {
  data: { title: string; items: Record<string, { label: string; done: boolean }>; selected: string | null; revision: number; problem: string | null }
  states: {
    idle: {}
    editing: { data: { draft: string }; states: { typing: {}; saving: { data: { since: number } } } }
  }
  makes: { save: 'one'; tag: 'each' }
}
type Event${at} =
  | { type: 'SELECT'; id: string }
  | { type: 'EDIT'; draft: string }
  | { type: 'TYPE'; text: string }
  | { type: 'SAVE' }
  | { type: 'TAG'; id: string }
  | { type: 'CHANGED' }
type Asks${at} = {
  RENAME: { args: { id: string; label: string }; answer: boolean; refuses: { missing: { id: string } } }
  COUNT: { args: {}; answer: number }
}

export const state${at} = state<Shape${at}, Event${at}, Asks${at}>()({
  data: { title: 'list ${at}', items: {}, selected: null, revision: 0, problem: null },
  initial: 'idle',
  follows: (follow) => ({
    rows: follow('store', 'rows', { from: ['revision'], args: () => ({ list: ${at} }), heard: (update) => (update.ok ? { data: { title: \`\${update.value.length} rows\` } } : { data: { problem: update.error } }) }),
  }),
  awaits: (asking) => ({
    detail: asking('store', 'DETAIL', { from: ['selected'], args: ({ selected }) => (selected ? { id: selected } : null), ended: (outcome: Outcome<{ label: string }, { kind: string; message: string }>) => (outcome.ok ? undefined : { data: { problem: outcome.failure.message } }) }),
  }),
  makes: ({ one, each }) => ({
    save: one('store', 'SAVE', { args: () => ({ list: ${at} }), ended: (outcome) => (outcome.ok ? undefined : { data: { problem: outcome.failure.message } }) }),
    tag: each('store', 'TAG', { args: (id) => ({ id }), ended: () => undefined }),
  }),
  on: {
    SELECT: ({ id }) => ({ data: { selected: id } }),
    EDIT: ({ draft }) => ({ at: 'editing', data: { draft } }),
    TAG: ({ id }, { make }) => { make('tag', id) },
    CHANGED: (_, { data }) => ({ data: { revision: data.revision + 1 } }),
  },
  asks: {
    RENAME: ({ id, label }, { data, refuse }) => {
      if (!data.items[id]) throw refuse('missing', 'There is no such item', { id })
      return answered(true, { data: (d) => { d.items[id]!.label = label } })
    },
    COUNT: (_, { data }) => Object.keys(data.items).length,
  },
  states: {
    idle: {},
    editing: {
      data: { draft: given },
      initial: 'typing',
      states: {
        typing: { on: { TYPE: ({ text }, { data }) => ({ data: { draft: data.draft + text } }), SAVE: (_, { make }) => { make('save'); return { at: 'editing.saving', data: { since: 0 } } } } },
        saving: { data: { since: given } },
      },
    },
  },
})
`
const appFile = `import { forNet } from '../../../../src/index.ts'

type App = {
  systems: {
    store: {
      events: never
      asks: {
        DETAIL: { args: { id: string }; answer: { label: string } }
        SAVE: { args: { list: number }; answer: boolean }
        TAG: { args: { id: string }; answer: boolean }
      }
    }
  }
  surfaces: {}
  views: { store: { rows: { args: { list: number }; result: string[] } } }
}
export const state = forNet<App>()
`

/** TypeScript's own account of a check, from `--extendedDiagnostics`. */
const diagnostic = (out: string, what: string): number => Number(new RegExp(`^${what}:\\s+([\\d.]+)`, 'm').exec(out)?.[1] ?? NaN)

console.log(`${new Date().toISOString().slice(0, 10)}, ${cpus()[0]?.model}, node ${process.version}, load ${process.platform === 'win32' ? 'unread' : loadavg()[0]!.toFixed(1)}, TypeScript ${execFileSync(process.execPath, [tsc, '--version'], { encoding: 'utf8' }).trim()}`)
under('checking N states')
for (const count of sizes.length ? sizes : [10, 100, 300]) {
  const dir = join(root, '.temp', 'compile', String(count))
  rmSync(dir, { recursive: true, force: true })
  // What is generated is removed however its check ends.
  try {
    mkdirSync(join(dir, 'states'), { recursive: true })
    writeFileSync(join(dir, 'states', 'app.ts'), appFile)
    for (let at = 0; at < count; at++) writeFileSync(join(dir, 'states', `state${at}.ts`), stateFile(at))
    writeFileSync(join(dir, 'tsconfig.json'), JSON.stringify({ extends: '../../../tsconfig.json', compilerOptions: { noEmit: true, types: [] }, include: ['states/*.ts'] }, null, 2))
    const check = (): { wall: number; out: string } => {
      const began = process.hrtime.bigint()
      let out: string
      try { out = execFileSync(process.execPath, [tsc, '-p', dir, '--extendedDiagnostics'], { encoding: 'utf8' }) } catch (error) {
        // What is measured has to compile: a state that does not is not what a pack writes.
        throw new Error(`The generated states do not compile:\n${(error as { stdout?: string }).stdout?.split('\n').filter((line) => line.includes('error')).slice(0, 10).join('\n')}`)
      }
      return { wall: Number(process.hrtime.bigint() - began) / 1e6, out }
    }
    check()
    const { wall, out } = check()
    const checkTime = diagnostic(out, 'Check time') * 1000
    const types = diagnostic(out, 'Types')
    const memory = Number(/^Memory used:\s+(\d+)K/m.exec(out)?.[1] ?? NaN) / 1024
    reading(`${count} states: check time`, checkTime, 'ms')
    reading(`${count} states: wall time`, wall, 'ms')
    reading(`${count} states: types`, types, 'types')
    reading(`${count} states: memory`, memory, 'MB')
    console.log(`  ${String(count).padStart(4)} states   check ${checkTime.toFixed(0).padStart(6)} ms   wall ${wall.toFixed(0).padStart(6)} ms   ${types.toFixed(0).padStart(8)} types   ${memory.toFixed(0).padStart(5)} MB   (${(checkTime / count).toFixed(1)} ms a state)`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}
