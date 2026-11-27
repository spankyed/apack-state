// The asks a state loads. These are reads: one is there because the data says so, for as long as it does. It names
// the fields it reads, the field with one for each of its keys, or both, and which are asked follows from the data.
//
//   npx vitest run loads
import { deepStrictEqual, ok, strictEqual, throws } from 'node:assert'
import { connect, rest, run, system } from './checks.mts'
import { commit, git, type CommitEvent } from '../examples/commit.mts'
import { explore, sample, type Schedule } from '@apackdev/orderings'
import { forNet, type PortOutcome, type StepLog } from '../src/index.ts'
import { onSchedule } from '../src/testing.ts'
import { nextTurn } from '../src/turn.ts'

const turns = (count: number): Promise<void> => new Promise((resolve) => { let left = count; const tick = (): void => { if (left-- <= 0) resolve(); else nextTurn(tick) }; tick() })

type LibraryAsks = { LOOKUP: { args: { query: string }; progress: string; answer: string } }
type App = { systems: { library: { events: never; asks: LibraryAsks } }; surfaces: {}; views: {} }
export const state = forNet<App>()

/** What the library was asked and what it was told to give up, in order. */
const library = (did: string[]) => state<{}, never, LibraryAsks>()({
  answers: {
    LOOKUP: async ({ query }, { progress, signal }) => {
      did.push(`lookup ${query}`)
      signal.addEventListener('abort', () => { did.push(`gave up ${query}`) })
      progress(`${query} began`)
      await turns(3)
      progress(`${query} ended`)
      return query.toUpperCase()
    },
  },
})

export type ReaderEvent =
  | { type: 'SET_QUERY'; query: string }
  | { type: 'RENAME'; title: string }
  | { type: 'AGAIN' }
  | { type: 'WATCH'; ids: string[] }
  | { type: 'TURN'; on: boolean }
  | { type: 'CIRCLE' }
  | { type: 'ONCE'; query: string }
export type Reader = {
  data: { title: string; query: string; again: number; found: string | null; heard: string[]; watched: string[]; labels: Record<string, string>; circling: number; problem: string | null; pending: string; got: string | null }
  states: { on: {}; off: {} }
}

const reader = state<Reader, ReaderEvent>()({
  data: { title: 'Reader', query: '', again: 0, found: null, heard: [], watched: [], labels: {}, circling: 0, problem: null, pending: '', got: null },
  initial: 'on',

  on: {
    SET_QUERY: ({ query }) => ({ data: { query, found: null } }),
    RENAME: ({ title }) => ({ data: { title } }),
    AGAIN: (_, { data }) => ({ data: { again: data.again + 1 } }),
    WATCH: ({ ids }) => ({ data: (d) => { d.watched = ids; for (const id of Object.keys(d.labels)) if (!ids.includes(id)) delete d.labels[id] } }),
    TURN: ({ on }) => ({ at: on ? 'on' : 'off' }),
    CIRCLE: (_, { data }) => ({ data: { circling: data.circling + 1 } }),
    ONCE: ({ query }) => ({ data: { pending: query } }),
  },

  states: {
    on: {
      loads: (load) => ({
        // Nothing is looked up while there is nothing to look up, and `again` only counts.
        lookup: load('library', 'LOOKUP', {
          from: ['query', 'again'],
          args: ({ query }) => query !== '' && { query },
          progress: (updates) => ({ data: (d) => { d.heard.push(updates.join('+')) } }),
          done: (outcome) => (outcome.ok ? { data: { found: outcome.value } } : { data: { problem: outcome.failure.message } }),
        }),

        // One for each thing watched. It is asked once for its key, and what it found stays.
        label: load('library', 'LOOKUP', {
          each: 'watched',
          args: (id) => ({ query: id }),
          done: (outcome, { key }) => (outcome.ok ? { data: (d) => { d.labels[key] = outcome.value } } : undefined),
        }),

        // Asked from a field that how it ended changes: it would ask itself again for good.
        circle: load('library', 'LOOKUP', {
          from: ['circling'],
          args: ({ circling }) => circling > 0 && { query: `round ${circling}` },
          done: (_, { data }) => ({ data: { circling: data.circling + 1 } }),
        }),

        // Asked while something is pending, and how it ended clears it: it asks for nothing, which cannot come round.
        once: load('library', 'LOOKUP', {
          from: ['pending'],
          args: ({ pending }) => pending !== '' && { query: pending },
          done: (outcome) => ({ data: { pending: '', got: outcome.ok ? outcome.value : null } }),
        }),
      }),
    },
    off: {},
  },
})

// ── one read for each open file, all read again when the repository changes ─────────────────────────────────────────

type RepoAsks = { DIFF: { args: { path: string; rev: number }; answer: string } }
const beside = forNet<{ systems: { repo: { events: never; asks: RepoAsks } }; surfaces: {}; views: {} }>()

/** A repository whose diffs take as long as `work` does. What it read and what it was told to give up, in order. */
const repo = (did: string[], work: (what: string) => Promise<unknown>) => beside<{}, never, RepoAsks>()({
  answers: {
    DIFF: async ({ path, rev }, { signal }) => {
      did.push(`read ${path}@${rev}`)
      signal.addEventListener('abort', () => { did.push(`gave up ${path}@${rev}`) })
      await work(`reading ${path}@${rev}`)
      return `${path}@${rev}`
    },
  },
})

type DiffsEvent =
  | { type: 'OPEN'; paths: string[]; changed?: boolean }
  | { type: 'CLOSE'; path: string; changed?: boolean }
  | { type: 'CHANGED' }
  | { type: 'RENAME'; title: string }
type Diffs = { data: { title: string; open: Record<string, string | null>; rev: number; spins: number; ended: string[]; late: string[] } }

/** `spinning` has how a diff ended count `spins` up, which is a field it is read from. */
const diffs = (spinning = false) => beside<Diffs, DiffsEvent>()({
  data: { title: 'Diffs', open: {}, rev: 0, spins: 0, ended: [], late: [] },
  on: {
    OPEN: ({ paths, changed }) => ({ data: (d) => { for (const path of paths) d.open[path] = null; if (changed) d.rev += 1 } }),
    CLOSE: ({ path, changed }) => ({ data: (d) => { delete d.open[path]; if (changed) d.rev += 1 } }),
    CHANGED: (_, { data }) => ({ data: { rev: data.rev + 1 } }),
    RENAME: ({ title }) => ({ data: { title } }),
  },
  loads: (load) => ({
    diff: load('repo', 'DIFF', {
      each: 'open',
      from: ['rev', 'spins'],
      args: (path, { rev, spins }) => ({ path, rev: rev + spins }),
      done: (outcome, { key, data }) => ({
        data: (d) => {
          if (!outcome.ok) return
          d.open[key] = outcome.value
          d.ended.push(outcome.value)
          // What it was read at is not what the data says now: a read that was given up, heard of all the same.
          if (outcome.value !== `${key}@${data.rev + data.spins}`) d.late.push(outcome.value)
          if (spinning) d.spins += 1
        },
      }),
    }),
  }),
})

/**
 * The diffs on a repository whose reads end when a check says: `end('a@0')`. A read under way is never at rest, so
 * these checks wait in turns: more than anything here takes to be asked or heard.
 */
const opened = (spinning = false) => {
  const did: string[] = []
  const defects: string[] = []
  const reading = new Map<string, () => void>()
  const sys = system({ side: 'backend', trace: (line) => { if (line.startsWith('DEFECT')) defects.push(line) } })
  sys.start('repo', repo(did, (what) => new Promise<void>((resolve) => { reading.set(what.slice('reading '.length), resolve) })))
  const it = sys.start('diffs', diffs(spinning))
  return {
    did, defects,
    send: (event: DiffsEvent): void => sys.send(it, event),
    now: () => sys.read(it).data,
    end: async (...which: string[]): Promise<void> => { for (const one of which) reading.get(one)!(); await turns(8) },
  }
}

const wired = () => {
  const did: string[] = []
  const defects: string[] = []
  const looked: string[] = []
  const sys = system({ side: 'backend', trace: (line) => { if (line.startsWith('DEFECT')) defects.push(line); if (line.includes('looked at')) looked.push(line) } })
  sys.start('library', library(did))
  const it = sys.start('reader', reader)
  return { did, defects, looked, send: (event: ReaderEvent): void => sys.send(it, event), now: () => sys.read(it).data }
}

const checks: Array<[string, () => Promise<void>]> = [
  ['a read is asked when a field it names changes, and not when another does', async () => {
    const { send, now, did } = wired()
    send({ type: 'SET_QUERY', query: 'apack' })
    await rest()
    strictEqual(now().found, 'APACK')
    send({ type: 'RENAME', title: 'Another' })
    await rest()
    deepStrictEqual(did, ['lookup apack'])
  }],
  ['a field that only counts has it asked again', async () => {
    const { send, did } = wired()
    send({ type: 'SET_QUERY', query: 'apack' })
    await rest()
    send({ type: 'AGAIN' })
    await rest()
    deepStrictEqual(did, ['lookup apack', 'lookup apack'])
  }],
  ['where there is nothing to ask for, nothing is asked', async () => {
    const { send, did } = wired()
    send({ type: 'AGAIN' })
    send({ type: 'SET_QUERY', query: '' })
    await rest()
    deepStrictEqual(did, [])
  }],
  ['a read asked again gives up the one before: the one answering is told, and only the last is taken', async () => {
    const { send, now, did } = wired()
    send({ type: 'SET_QUERY', query: 'first' })
    await turns(1)
    send({ type: 'SET_QUERY', query: 'second' })
    await rest()
    strictEqual(now().found, 'SECOND')
    deepStrictEqual(did, ['lookup first', 'gave up first', 'lookup second'])
  }],
  ['what a read says before it ends is heard, as a list', async () => {
    const { send, now } = wired()
    send({ type: 'SET_QUERY', query: 'apack' })
    await rest()
    deepStrictEqual(now().heard, ['apack began', 'apack ended'])
  }],
  ['one is asked for each item of a list, once, and what it found stays', async () => {
    const { send, now, did } = wired()
    send({ type: 'WATCH', ids: ['a', 'b'] })
    await rest()
    deepStrictEqual(now().labels, { a: 'A', b: 'B' })
    // A read does not end by taking its key out: the list is the data's, and it is as it was.
    deepStrictEqual(now().watched, ['a', 'b'])
    send({ type: 'WATCH', ids: ['a', 'b', 'c'] })
    await rest()
    deepStrictEqual(did, ['lookup a', 'lookup b', 'lookup c'])
    deepStrictEqual(now().labels, { a: 'A', b: 'B', c: 'C' })
  }],
  ['an item taken from the list gives up its read', async () => {
    const { send, now, did } = wired()
    send({ type: 'WATCH', ids: ['a', 'b'] })
    await turns(1)
    send({ type: 'WATCH', ids: ['b'] })
    await rest()
    deepStrictEqual(did, ['lookup a', 'lookup b', 'gave up a'])
    deepStrictEqual(now().labels, { b: 'B' })
  }],
  ['leaving the state gives up what it was waiting on, and entering it again asks afresh', async () => {
    const { send, now, did } = wired()
    send({ type: 'SET_QUERY', query: 'apack' })
    await turns(1)
    send({ type: 'TURN', on: false })
    await rest()
    deepStrictEqual({ did, found: now().found }, { did: ['lookup apack', 'gave up apack'], found: null })
    // The data still says to look it up, so being the case again is asking again.
    send({ type: 'TURN', on: true })
    await rest()
    strictEqual(now().found, 'APACK')
  }],
  ['how a read ended may not change a field it is asked from: it is reported, and not asked again', async () => {
    const { send, now, did, defects } = wired()
    send({ type: 'CIRCLE' })
    await rest()
    deepStrictEqual(did, ['lookup round 1'])
    strictEqual(now().circling, 2)
    strictEqual(defects.length, 1)
    ok(defects[0]!.includes('reader#circle delivered changed a field it is itself asked from'))
  }],
  ['a read whose end clears the field it is asked from asks for nothing more, and that is no circle', async () => {
    const { send, now, did, defects } = wired()
    send({ type: 'ONCE', query: 'x' })
    await rest()
    deepStrictEqual([did, now().got, defects], [['lookup x'], 'X', []])
    send({ type: 'ONCE', query: 'y' })
    await rest()
    deepStrictEqual([did, now().got, defects], [['lookup x', 'lookup y'], 'Y', []])
  }],
  ['which keys there are is looked at only when that field changes', async () => {
    const { send, looked } = wired()
    looked.length = 0
    send({ type: 'RENAME', title: 'Another' })
    send({ type: 'SET_QUERY', query: 'apack' })
    deepStrictEqual(looked, [])
    send({ type: 'WATCH', ids: ['a'] })
    strictEqual(looked.length, 1)
    await turns(8)
  }],
  ['one is read for each key, at what the fields it names hold', async () => {
    const { send, now, did, end } = opened()
    send({ type: 'CHANGED' })
    send({ type: 'OPEN', paths: ['a', 'b'] })
    await turns(8)
    deepStrictEqual(did, ['read a@1', 'read b@1'])
    await end('b@1', 'a@1')
    deepStrictEqual(now().open, { a: 'a@1', b: 'b@1' })
  }],
  ['a field it names changing reads every key again, once each, and gives up the ones under way', async () => {
    const { send, now, did, end } = opened()
    send({ type: 'OPEN', paths: ['a', 'b'] })
    await turns(8)
    send({ type: 'CHANGED' })
    await turns(8)
    deepStrictEqual(did, ['read a@0', 'read b@0', 'gave up a@0', 'gave up b@0', 'read a@1', 'read b@1'])
    // What was given up ends all the same, where whoever answers does not stop: it is not heard.
    await end('a@0', 'b@0')
    deepStrictEqual(now().ended, [])
    await end('a@1', 'b@1')
    deepStrictEqual([now().open, now().ended, now().late], [{ a: 'a@1', b: 'b@1' }, ['a@1', 'b@1'], []])
  }],
  ['one that had ended is read again too, with nothing to give up', async () => {
    const { send, now, did, end } = opened()
    send({ type: 'OPEN', paths: ['a', 'b'] })
    await end('a@0')
    send({ type: 'CHANGED' })
    await turns(8)
    deepStrictEqual(did, ['read a@0', 'read b@0', 'gave up b@0', 'read a@1', 'read b@1'])
    await end('a@1', 'b@1')
    deepStrictEqual(now().open, { a: 'a@1', b: 'b@1' })
  }],
  ['a key that appears or goes reads or gives up its own alone, and a field it does not name reads nothing', async () => {
    const { send, did } = opened()
    send({ type: 'OPEN', paths: ['a'] })
    send({ type: 'OPEN', paths: ['b'] })
    send({ type: 'RENAME', title: 'Another' })
    await turns(8)
    deepStrictEqual(did, ['read a@0', 'read b@0'])
    send({ type: 'CLOSE', path: 'a' })
    await turns(8)
    deepStrictEqual(did, ['read a@0', 'read b@0', 'gave up a@0'])
  }],
  ['a key that appears in the step a named field changes is read once, with the rest', async () => {
    const { send, did } = opened()
    send({ type: 'OPEN', paths: ['a'] })
    await turns(8)
    send({ type: 'OPEN', paths: ['b'], changed: true })
    await turns(8)
    deepStrictEqual(did, ['read a@0', 'gave up a@0', 'read a@1', 'read b@1'])
  }],
  ['a key that goes in the step a named field changes is given up and not read again', async () => {
    const { send, now, did, end } = opened()
    send({ type: 'OPEN', paths: ['a', 'b'] })
    await turns(8)
    send({ type: 'CLOSE', path: 'a', changed: true })
    await turns(8)
    deepStrictEqual(did, ['read a@0', 'read b@0', 'gave up a@0', 'gave up b@0', 'read b@1'])
    await end('a@0', 'b@1')
    deepStrictEqual(now().open, { b: 'b@1' })
  }],
  ['how one of many ended may not change a field they are read from round to itself: it comes to rest, reported', async () => {
    const { send, now, did, defects, end } = opened(true)
    send({ type: 'OPEN', paths: ['a', 'b'] })
    await turns(8)
    // How a's ended changes what b is read from, which is one read leading another. It is a's own that is refused.
    await end('a@0')
    deepStrictEqual(did, ['read a@0', 'read b@0', 'gave up b@0', 'read b@1'])
    strictEqual(defects.length, 1)
    ok(defects[0]!.includes('diffs#diff/a delivered changed a field it is itself asked from'), defects[0])
    // And how b's ended would lead back to a, which led to it, and to itself: neither is read again.
    await end('b@1')
    deepStrictEqual(did, ['read a@0', 'read b@0', 'gave up b@0', 'read b@1'])
    deepStrictEqual([now().open, now().spins], [{ a: 'a@0', b: 'b@1' }, 2])
    strictEqual(defects.length, 3)
    ok(defects.some((line) => line.includes('what diffs#diff/b delivered changed a field diffs#diff/a is asked from, and diffs#diff/a is what led to diffs#diff/b being asked')), defects.join('\n'))
    ok(defects.some((line) => line.includes('diffs#diff/b delivered changed a field it is itself asked from')), defects.join('\n'))
    // One that was refused has seen what it was refused for: another key coming reads that key, and neither of these.
    send({ type: 'OPEN', paths: ['a', 'b', 'c'] })
    await turns(8)
    deepStrictEqual(did, ['read a@0', 'read b@0', 'gave up b@0', 'read b@1', 'read c@2'])
    strictEqual(defects.length, 3)
  }],
  ['a key there is nothing to ask for is not read, the others are, and it is read once there is', async () => {
    type FileAsks = { READ: { args: { path: string; repo: string }; answer: string } }
    const fileState = forNet<{ systems: { files: { events: never; asks: FileAsks } }; surfaces: {}; views: {} }>()
    const asked: string[] = []
    const sys = system({ side: 'backend' })
    sys.start('files', fileState<{}, never, FileAsks>()({ answers: { READ: ({ path, repo }) => { asked.push(`${repo}:${path}`); return path } } }))
    const it = sys.start('reader', fileState<{ data: { open: Record<string, true>; repo: string | null } }, { type: 'REPO'; repo: string | null }>()({
      data: { open: { 'a.ts': true, 'skip.ts': true }, repo: null },
      on: { REPO: ({ repo }) => ({ data: { repo } }) },
      loads: (load) => ({
        // With no repository there is nothing to read, and one file is never read.
        file: load('files', 'READ', { each: 'open', from: ['repo'], args: (path, { repo }) => (repo && path !== 'skip.ts' ? { path, repo } : null), done: () => {} }),
      }),
    }))
    await rest()
    deepStrictEqual(asked, [])
    sys.send(it, { type: 'REPO', repo: 'one' })
    await rest()
    deepStrictEqual(asked, ['one:a.ts'])
    sys.send(it, { type: 'REPO', repo: null })
    sys.send(it, { type: 'REPO', repo: 'two' })
    await rest()
    deepStrictEqual(asked, ['one:a.ts', 'two:a.ts'])
    sys.stop()
  }],
  ['one for each key of a field that is also asked again from that field is refused where it starts', async () => {
    const sys = system({ side: 'backend' })
    const twice = { def: { data: { open: {} }, loads: (load: Function) => ({ diff: load('git', 'DIFF', { each: 'open', from: ['open'], done: () => {} }) }) } }
    throws(() => sys.start('twice', twice as never), { message: 'twice loads diff for each key of open and again from open: name it once' })
    // In a state inside a state, and not the first of those beside it.
    const price = (follow: Function) => ({ price: follow('shop', 'price', { each: 'open', from: ['open'], updated: () => {} }) })
    const inner = { def: { data: { open: {} }, initial: 'a', states: { a: {}, b: { initial: 'c', states: { c: {}, d: { follows: price } } } } } }
    throws(() => sys.start('inner', inner as never), { message: 'inner follows price at b.d for each key of open and again from open: name it once' })
    sys.stop()
  }],
  ['loads may omit args when the ask accepts {}, for both from and each', async () => {
    type PingAsks = { PING: { args: {}; answer: string } }
    type PingNet = { systems: { svc: { events: never; asks: PingAsks } }; surfaces: {}; views: {} }
    const pingState = forNet<PingNet>()
    const received: unknown[] = []
    const svc = pingState<{}, never, PingAsks>()({
      answers: { PING: (args) => { received.push(args); return `pong-${received.length}` } },
    })
    const reader = pingState<{ data: { rev: number; keys: string[]; latest: string | null; byKey: Record<string, string> } }, { type: 'BUMP' } | { type: 'KEYS'; keys: string[] }>()({
      data: { rev: 0, keys: [], latest: null, byKey: {} },
      loads: (load) => ({
        status: load('svc', 'PING', {
          from: ['rev'],
          done: (o) => (o.ok ? { data: { latest: o.value } } : undefined),
        }),
        perKey: load('svc', 'PING', {
          each: 'keys',
          done: (o, { key }) => (o.ok ? { data: (d) => { d.byKey[key] = o.value } } : undefined),
        }),
      }),
      on: {
        BUMP: (_, { data }) => ({ data: { rev: data.rev + 1 } }),
        KEYS: ({ keys }) => ({ data: { keys } }),
      },
    })
    const sys = system({ side: 'backend' })
    sys.start('svc', svc)
    const h = sys.start('reader', reader)
    await rest()
    deepStrictEqual(received, [{}])
    strictEqual(sys.read(h).data.latest, 'pong-1')
    sys.send(h, { type: 'BUMP' })
    sys.send(h, { type: 'KEYS', keys: ['a', 'b'] })
    await rest()
    deepStrictEqual(received, [{}, {}, {}, {}])
    strictEqual(sys.read(h).data.latest, 'pong-2')
    deepStrictEqual(Object.keys(sys.read(h).data.byKey).sort(), ['a', 'b'])
    sys.stop()
  }],
  ['what a read for each key is asked with is made of its key alone, and of its key and the fields it names where it names some', async () => {
    type EchoAsks = { ECHO: { args: { given: unknown[] }; answer: null } }
    const echoState = forNet<{ systems: { svc: { events: never; asks: EchoAsks } }; surfaces: {}; views: {} }>()
    const asked: unknown[][] = []
    const sys = system({ side: 'backend' })
    sys.start('svc', echoState<{}, never, EchoAsks>()({ answers: { ECHO: ({ given }) => { asked.push(given); return null } } }))
    sys.start('reader', echoState<{ data: { keys: Record<string, true>; rev: number } }>()({
      data: { keys: { a: true }, rev: 7 },
      loads: (load) => ({
        alone: load('svc', 'ECHO', { each: 'keys', args: (...given) => ({ given }), done: () => {} }),
        named: load('svc', 'ECHO', { each: 'keys', from: ['rev'], args: (...given) => ({ given }), done: () => {} }),
      }),
    }))
    await rest()
    deepStrictEqual(asked, [['a'], ['a', { rev: 7 }]])
    sys.stop()
  }],
  ['one that names fields is given them as an object whatever they come to: none named at all is still an object', async () => {
    type EchoAsks = { ECHO: { args: { given: unknown[] }; answer: null } }
    const echoState = forNet<{ systems: { svc: { events: never; asks: EchoAsks } }; surfaces: {}; views: {} }>()
    const asked: unknown[][] = []
    const sys = system({ side: 'backend' })
    sys.start('svc', echoState<{}, never, EchoAsks>()({ answers: { ECHO: ({ given }) => { asked.push(given); return null } } }))
    // Which fields it names is worked out, and comes to none.
    const named: readonly 'rev'[] = []
    sys.start('reader', echoState<{ data: { keys: Record<string, true>; rev: number } }>()({
      data: { keys: { a: true }, rev: 7 },
      loads: (load) => ({ some: load('svc', 'ECHO', { each: 'keys', from: named, args: (...given) => ({ given }), done: () => {} }) }),
    }))
    await rest()
    deepStrictEqual(asked, [['a', {}]])
    sys.stop()
  }],
  ['a field named only to have every key read again, which what is asked does not hold, reads them again when it changes', async () => {
    type DiffAsks = { DIFF: { args: { path: string }; answer: string } }
    const diffState = forNet<{ systems: { git: { events: never; asks: DiffAsks } }; surfaces: {}; views: {} }>()
    const asked: string[] = []
    const sys = system({ side: 'backend' })
    sys.start('git', diffState<{}, never, DiffAsks>()({ answers: { DIFF: ({ path }) => { asked.push(path); return `${path}#${asked.length}` } } }))
    const it = sys.start('diffs', diffState<{ data: { open: Record<string, true>; statusRev: number; diffs: Record<string, string> } }, { type: 'CHANGED' }>()({
      data: { open: { 'a.ts': true, 'b.ts': true }, statusRev: 0, diffs: {} },
      on: { CHANGED: (_, { data }) => ({ data: { statusRev: data.statusRev + 1 } }) },
      loads: (load) => ({
        diff: load('git', 'DIFF', { each: 'open', from: ['statusRev'], args: (path) => ({ path }), done: (outcome, { key }) => (outcome.ok ? { data: (d) => { d.diffs[key] = outcome.value } } : undefined) }),
      }),
    }))
    await rest()
    deepStrictEqual(asked, ['a.ts', 'b.ts'])
    sys.send(it, { type: 'CHANGED' })
    await rest()
    deepStrictEqual(asked, ['a.ts', 'b.ts', 'a.ts', 'b.ts'])
    deepStrictEqual(sys.read(it).data.diffs, { 'a.ts': 'a.ts#3', 'b.ts': 'b.ts#4' })
    sys.stop()
  }],
]

// ── what a read delivers once it is no longer the one awaited ───────────────────────────────────────────────────────

type DeskAsks = {
  DETAIL: { args: { query: string }; progress: string; answer: string }
  /** Each thing it says before it ends is a better query. */
  SUGGEST: { args: { seed: string }; progress: string; answer: null }
}
type DeskNet = { systems: { desk: { events: never; asks: DeskAsks } }; surfaces: {}; views: {} }
const desked = forNet<DeskNet>()

type FinderEvent = { type: 'QUERY'; query: string } | { type: 'SEED'; seed: string } | { type: 'NOTE'; note: string } | { type: 'TURN'; on: boolean }
type Finder = {
  data: { seed: string; query: string; note: string; found: string | null; ended: string[]; heard: string[]; astray: string[] }
  states: { on: {}; off: {} }
}
/** Shows the detail of a query. What is being suggested from a seed becomes the query, so the detail is asked again. */
const finder = desked<Finder, FinderEvent>()({
  data: { seed: '', query: '', note: '', found: null, ended: [], heard: [], astray: [] },
  initial: 'on',
  on: {
    QUERY: ({ query }) => ({ data: { query } }),
    SEED: ({ seed }) => ({ data: { seed } }),
    NOTE: ({ note }) => ({ data: { note } }),
    TURN: ({ on }) => ({ at: on ? 'on' : 'off' }),
  },
  states: {
    on: {
      loads: (load) => ({
        suggest: load('desk', 'SUGGEST', {
          from: ['seed'],
          args: ({ seed }) => seed !== '' && { seed },
          progress: (updates) => ({ data: (d) => { d.query = updates[updates.length - 1]!; d.heard.push(...updates) } }),
          done: () => undefined,
        }),
        detail: load('desk', 'DETAIL', {
          from: ['query'],
          args: ({ query }) => query !== '' && { query },
          progress: (updates, { data }) => ({ data: (d) => { for (const update of updates) (update.startsWith(`${data.query}:`) ? d.heard : d.astray).push(update) } }),
          // The desk answers with the query it was asked, so one that is not the query now came from a read given up.
          done: (outcome, { data }) => ({ data: (d) => {
            const value = outcome.ok ? outcome.value : outcome.failure.kind
            if (value !== data.query) { d.astray.push(value); return }
            d.ended.push(value)
            d.found = value
          } }),
        }),
      }),
    },
    off: {},
  },
})

interface Asked { readonly name: string; readonly args: { query?: string; seed?: string }; says(update: string): void; ends(outcome: PortOutcome): void }
/**
 * A window whose backend is this check's: each ask across is kept, to be heard from when the check says, and is
 * heard from whether or not it was given up. Its frames are the check's to run too.
 */
const atDesk = (host: { limit?: number } = {}) => {
  const asked: Asked[] = []
  const logs: StepLog[] = []
  const defects: string[] = []
  const frames: Array<() => void> = []
  const sys = system({ side: 'window', ...host, frame: (run) => { frames.push(run) }, log: (step) => { logs.push(step) }, onDefect: (defect) => { defects.push(defect.message) } })
  sys.attach({
    tell: () => {},
    follow: () => ({ stop: () => {} }),
    ask: (_to, name, args, says, ends) => { asked.push({ name, args: args as Asked['args'], says, ends }); return () => {} },
  })
  const it = sys.start('finder', finder)
  return {
    sys, it, asked, defects,
    send: (event: FinderEvent): void => sys.send(it, event),
    now: () => sys.read(it).data,
    frame: (): void => { for (const run of frames.splice(0)) run() },
    /** What began each step, and what it handled after. */
    steps: (): string[] => logs.map((step) => step.handled.map((one) => `${one.kind} ${one.name}`).join(', ')),
    numbers: (): number[] => logs.map((step) => step.number),
  }
}
type Desk = ReturnType<typeof atDesk>
const ok1 = (value: string | null): PortOutcome => ({ ok: true, value })

/** A read heard from while it is awaited, after it was asked again, behind the step that asks it again, and after its state was left. */
const read = async (it: Desk): Promise<void> => {
  const { send, asked } = it
  send({ type: 'QUERY', query: 'one' })
  // Awaited: what it says is a step, and how it ends is one.
  asked[0]!.says('one: half')
  it.frame()
  asked[0]!.ends(ok1('one'))
  await turns(1)
  // Asked again twice over: the one in between is heard from when it is no longer awaited.
  send({ type: 'QUERY', query: 'two' })
  send({ type: 'QUERY', query: 'three' })
  asked[1]!.says('two: half')
  it.frame()
  asked[1]!.ends(ok1('two'))
  await turns(1)
  // In one read from the backend: the detail ends, and a suggestion is made. The suggestion is handed over first, and
  // has the detail asked again, so how the detail ended has its turn once it is no longer awaited.
  send({ type: 'SEED', seed: 's' })
  asked[2]!.ends(ok1('three'))
  asked[3]!.says('four')
  await turns(1)
  it.frame()
  // The state is left, and behind that in one read comes what the detail said, and how it ended.
  let once = true
  const stop = it.sys.subscribe(() => {
    if (!once) return
    once = false
    send({ type: 'TURN', on: false })
    asked[4]!.says('four: half')
    asked[4]!.ends(ok1('four'))
  })
  send({ type: 'NOTE', note: 'leaving' })
  stop()
  await turns(1)
  it.frame()
  // Left: nothing it was awaiting is heard from.
  asked[3]!.says('five')
  it.frame()
  asked[3]!.ends(ok1(null))
  await turns(1)
  // Back, it asks afresh, and that one is awaited.
  send({ type: 'TURN', on: true })
  asked[6]!.says('four: all')
  it.frame()
  asked[6]!.ends(ok1('four'))
  asked[5]!.ends(ok1(null))
  await turns(1)
  it.frame()
}
/** Every step `read` takes: one for each event, each answer from the backend, and each delivery of a read awaited. */
const READ_STEPS = [
  '',
  'event QUERY', 'progress detail', 'answer DETAIL', 'done detail',
  'event QUERY', 'event QUERY', 'answer DETAIL',
  'event SEED', 'answer DETAIL', 'progress suggest',
  'event NOTE', 'event TURN', 'answer DETAIL',
  'answer SUGGEST',
  'event TURN', 'progress detail', 'answer DETAIL', 'answer SUGGEST', 'done detail', 'done suggest',
]

const staleChecks: Array<[string, () => Promise<void>]> = [
  ['what a read delivers once it is no longer awaited takes no step, and what one awaited delivers takes one', async () => {
    const it = atDesk()
    await read(it)
    deepStrictEqual(it.asked.map((one) => `${one.name} ${one.args.query ?? one.args.seed}`), ['DETAIL one', 'DETAIL two', 'DETAIL three', 'SUGGEST s', 'DETAIL four', 'SUGGEST s', 'DETAIL four'])
    deepStrictEqual(it.steps(), READ_STEPS)
    deepStrictEqual(it.numbers(), READ_STEPS.map((_, at) => at + 1))
    deepStrictEqual(it.now(), { seed: 's', query: 'four', note: 'leaving', found: 'four', ended: ['one', 'four'], heard: ['one: half', 'four', 'four: all'], astray: [] })
    deepStrictEqual(it.defects, [])
    strictEqual(it.sys.idle(), true)
  }],
  ['what a read delivers once it is no longer awaited counts for nothing against the limit', async () => {
    // Exactly as many steps as it takes: one more, and the last delivery would be turned away.
    const it = atDesk({ limit: READ_STEPS.length })
    await read(it)
    deepStrictEqual(it.steps(), READ_STEPS)
    deepStrictEqual({ found: it.now().found, ended: it.now().ended }, { found: 'four', ended: ['one', 'four'] })
    deepStrictEqual(it.defects, [])
    // And it was the limit: the next thing is not taken.
    it.send({ type: 'NOTE', note: 'one too many' })
    strictEqual(it.now().note, 'leaving')
    strictEqual(it.defects.length, 1)
  }],
]

/**
 * The finder across a socket a schedule reads: each thing the backend sends waits to be read, and one read takes
 * everything waiting, in the order it was sent. It has been asked for one thing, and to suggest a better.
 */
const suggesting = (schedule: Schedule): (() => void) => {
  const logs: StepLog[] = []
  const window = system({ side: 'window', ...onSchedule(schedule, 'the window'), log: (step) => { logs.push(step) } })
  const waiting: Array<() => void> = []
  const socket = { label: 'the socket' }
  const sends = (lane: { label: string }, message: () => void): void => {
    schedule.later(lane, () => { waiting.push(message); schedule.later(socket, () => { for (const each of waiting.splice(0)) each() }) })
  }
  let asks = 0
  window.attach({
    tell: () => {},
    follow: () => ({ stop: () => {} }),
    // It answers whether or not whoever asked has gone: what was sent before it heard so is on its way.
    ask: (_to, name, args, says, ends) => {
      const lane = { label: `${name} ${++asks}` }
      if (name === 'SUGGEST') { sends(lane, () => says('better')); sends(lane, () => ends({ ok: true, value: null })) }
      else sends(lane, () => ends({ ok: true, value: (args as { query: string }).query }))
      return () => {}
    },
  })
  const it = window.start('finder', finder)
  window.send(it, { type: 'QUERY', query: 'one' })
  window.send(it, { type: 'SEED', seed: 's' })
  return () => {
    const { data } = window.read(it)
    // Whichever way it went, the detail shown is of the query there is, and nothing given up was heard from.
    deepStrictEqual({ query: data.query, found: data.found, astray: data.astray }, { query: 'better', found: 'better', astray: [] })
    strictEqual(window.idle(), true)
    // Each delivery that took a step was one awaited: its handler ran, once.
    const took = (kind: string, name: string): number => logs.filter((step) => step.handled[0]?.kind === kind && step.handled[0].name === name).length
    strictEqual(took('done', 'detail'), data.ended.length)
    strictEqual(took('progress', 'suggest'), 1)
  }
}

/** The commit surface's reads, on a backend whose work a schedule decides. */
const selecting = (schedule: Schedule): (() => void) => {
  const backend = system({ side: 'backend', later: schedule.later })
  backend.start('code', git((what) => schedule.work(what, null)))
  const window = system({ side: 'window', later: schedule.later })
  connect(window, backend, schedule)
  const surface = window.start('commit', commit)
  const send = (event: CommitEvent): void => window.send(surface, event)
  schedule.does('the user', ['selects a', () => send({ type: 'commit.VIEW_DIFF', path: 'a.ts', staged: false })], ['selects c', () => send({ type: 'commit.VIEW_DIFF', path: 'c.ts', staged: false })])
  return () => { deepStrictEqual({ diff: window.read(surface).data.gitDiff, error: window.read(surface).data.gitError }, { diff: 'diff of c.ts', error: null }) }
}

/** Two open diffs and a repository that changes twice, with each read ending whenever the schedule says. */
const rereading = (schedule: Schedule): (() => void) => {
  const sys = system({ side: 'backend', later: schedule.later })
  sys.start('repo', repo([], (what) => schedule.work(what, null)))
  const it = sys.start('diffs', diffs())
  const send = (event: DiffsEvent): void => sys.send(it, event)
  send({ type: 'OPEN', paths: ['a', 'b'] })
  schedule.does('the repository', ['changes', () => send({ type: 'CHANGED' })], ['changes again', () => send({ type: 'CHANGED' })])
  return () => {
    const { open, late } = sys.read(it).data
    deepStrictEqual({ open, late }, { open: { a: 'a@2', b: 'b@2' }, late: [] })
  }
}

await run([...checks, ...staleChecks], async (tally) => {
  await tally.every('each open diff ends as its last read says and no read given up is heard, however the reads race the changes', () => explore(rereading))
  await tally.every('a read asked again while it and what asks it again are on their way shows the last, and takes a step only for what it awaits', () => explore(suggesting))
  await tally.every('the diff shown is of the file selected last, whichever read ends first', () => sample(selecting, { seed: 1, runs: 5_000 }), 'sampled')
})
