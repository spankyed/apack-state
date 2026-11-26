// A slice of the app's commit surface, ported: its status, the diff of the file that is selected, staging and
// unstaging, and a push.
//
//   surface   packages/default-setup/src/features/code/fe/features/commit/state.ts
//
// That machine declares 54 asks, and none of them is invoked by a state: it is flat, and every ask is spawned beside
// the others. 28 can be under way many at once, under ids from `askId`, and 26 are one of a kind, under a fixed id.
// Which are under way is kept in its context (`asking`), how each ended arrives as `xstate.done.actor.<id>`, and the
// panel imports the ids to show a spinner. By what each does, 14 are reads and 40 are writes.
//
// Here the slice has no ids, no list of what is under way kept by hand and no event for how an ask ended. The two
// kinds of ask are declared apart, because they are different things:
//
//   a read    `loads`    It is there because the data says so, for as long as it does: asked from the fields it
//                        names, and asked again when one of them changes, the one before cancelled.
//   a write   `calls`    It is fired once, by a handler calling `call`. Which are in flight is the kernel's to keep,
//                        and a component reads it beside the data: `pending.stage[path]`, `pending.push`.
//
// `git` at the bottom stands in for the code system's git engine, with the asks' own names.

import { deepStrictEqual } from 'node:assert'
import { answered, forNet, system } from '../src/index.ts'
import { connect, defectGuard } from '../src/testing.ts'
import { nextTurn } from '../src/turn.ts'

// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// What can be reached by name
// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════

export interface GitStatus { staged: string[]; unstaged: string[]; ahead: number }

export type CodeAsks = {
  'commit.GET_GIT_STATUS': { args: {}; answer: GitStatus }
  'commit.GET_GIT_DIFF': { args: { path: string; staged: boolean }; answer: { path: string; text: string }; refuses: 'not-found' }
  'commit.STAGE_FILES': { args: { paths: string[] }; answer: null; refuses: 'not-found' }
  'commit.UNSTAGE_FILES': { args: { paths: string[] }; answer: null; refuses: 'not-found' }
  'commit.REVERT_FILES': { args: { paths: string[] }; answer: null; refuses: 'not-found' }
  'commit.PUBLISH_BRANCH': { args: {}; progress: { phase: string }; answer: { pushed: number }; refuses: 'rejected' }
}

export type CommitEvent =
  // from the user
  | { type: 'commit.STAGE_FILE'; path: string }
  | { type: 'commit.UNSTAGE_FILE'; path: string }
  | { type: 'commit.REVERT_FILES'; paths: string[] }
  | { type: 'commit.VIEW_DIFF'; path: string; staged: boolean }
  | { type: 'commit.PUSH_BRANCH' }
  | { type: 'commit.STOP_PUSH' }
  | { type: 'commit.DISMISS_ERROR' }
  // broadcast by the backend to every window
  | { type: 'REPOSITORY_CHANGED' }

export type App = {
  systems: { code: { events: never; asks: CodeAsks } }
  surfaces: { commit: { events: CommitEvent } }
  views: {}
}
const state = forNet<App>()

// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// The surface
// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════

export type Commit = {
  data: {
    gitStatus: GitStatus | null
    /** Counts each change to the repository. The status is read again when it moves. */
    revision: number
    selectedGitFile: { path: string; staged: boolean } | null
    gitDiff: string | null
    pushPhase: string | null
    gitError: string | null
  }
  /** The writes it calls: staging/unstaging per path, unkeyed concurrent reverts, and one push at a time. */
  calls: { stage: 'each'; unstage: 'each'; revert: { many: { paths: string[] } }; push: 'one' }
}

export const commit = state<Commit, CommitEvent>()({
  data: { gitStatus: null, revision: 0, selectedGitFile: null, gitDiff: null, pushPhase: null, gitError: null },

  loads: (load) => ({
    // Read as the surface starts, and again whenever the repository changes (`args` omitted because ask takes `{}`).
    status: load('code', 'commit.GET_GIT_STATUS', {
      from: ['revision'],
      done: (outcome) => (outcome.ok ? { data: { gitStatus: outcome.value } } : { data: { gitError: outcome.failure.message } }),
    }),

    // The diff of whichever file is selected. Selecting another cancels the read of the first.
    diff: load('code', 'commit.GET_GIT_DIFF', {
      from: ['selectedGitFile'],
      args: ({ selectedGitFile }) => selectedGitFile,
      done: (outcome) => (outcome.ok ? { data: { gitDiff: outcome.value.text } } : { data: { gitDiff: null, gitError: outcome.failure.message } }),
    }),
  }),

  calls: ({ one, each, many }) => ({
    // Called for a path when a handler says so, and pending for that path until it finishes.
    stage: each('code', 'commit.STAGE_FILES', {
      args: (path) => ({ paths: [path] }),
      done: (outcome, { key }) => (outcome.ok ? undefined : { data: { gitError: `Could not stage ${key}: ${outcome.failure.message}` } }),
    }),
    unstage: each('code', 'commit.UNSTAGE_FILES', {
      args: (path) => ({ paths: [path] }),
      done: (outcome, { key }) => (outcome.ok ? undefined : { data: { gitError: `Could not unstage ${key}: ${outcome.failure.message}` } }),
    }),

    // Unkeyed concurrent write: input passes directly as ask args (no `args` mapper needed) and arrives frozen on `done`.
    revert: many('code', 'commit.REVERT_FILES', {
      done: (outcome, { input }) => (outcome.ok ? undefined : { data: { gitError: `Could not revert ${input.paths.join(', ')}: ${outcome.failure.message}` } }),
    }),

    // One at a time: a second while one is pending is the same push (`args` omitted because ask takes `{}`).
    push: one('code', 'commit.PUBLISH_BRANCH', {
      progress: (updates) => ({ data: { pushPhase: updates.at(-1)!.phase } }),
      done: (outcome) => ({ data: { pushPhase: null, ...(outcome.ok ? {} : { gitError: outcome.failure.message }) } }),
    }),
  }),

  on: {
    'commit.STAGE_FILE':   ({ path }, { call }) => { call('stage', path) },
    'commit.UNSTAGE_FILE': ({ path }, { call }) => { call('unstage', path) },
    'commit.REVERT_FILES': ({ paths }, { call }) => { call('revert', { paths }) },
    'commit.VIEW_DIFF':    ({ path, staged }) => ({ data: { selectedGitFile: { path, staged }, gitDiff: null } }),
    'commit.PUSH_BRANCH':  (_, { call }) => { call('push') },
    // Cancelling the push is what stopping it is: the backend is told, and `done` is not called.
    'commit.STOP_PUSH':    (_, { cancel }) => { cancel('push'); return { data: { pushPhase: null } } },
    'commit.DISMISS_ERROR': () => ({ data: { gitError: null } }),
    'REPOSITORY_CHANGED':  (_, { data }) => ({ data: { revision: data.revision + 1 } }),
  },
})

// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// The backend: stands in for the code system's git engine
// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════

type Repository = { data: { staged: string[]; unstaged: string[]; ahead: number } }

/** `work` is how long each thing takes: a check gives one a schedule decides. */
export const git = (work: (what: string) => Promise<unknown>, said: string[] = []) => state<Repository, never, CodeAsks>()({
  data: { staged: [], unstaged: ['a.ts', 'b.ts', 'c.ts'], ahead: 2 },

  answers: {
    'commit.GET_GIT_STATUS': async (_, { data }) => {
      await work('reading the status')
      return { staged: [...data.staged], unstaged: [...data.unstaged], ahead: data.ahead }
    },

    'commit.GET_GIT_DIFF': async ({ path, staged }, { data, refuse, signal }) => {
      signal.addEventListener('abort', () => { said.push(`gave up the diff of ${path}`) })
      await work(`reading the diff of ${path}`)
      if (!(staged ? data.staged : data.unstaged).includes(path)) throw refuse('not-found', `${path} has no ${staged ? 'staged' : 'unstaged'} changes`)
      return { path, text: `diff of ${path}${staged ? ' (staged)' : ''}` }
    },

    'commit.STAGE_FILES': async ({ paths }, { broadcast, refuse }) => {
      await work(`staging ${paths.join(', ')}`)
      broadcast('commit', { type: 'REPOSITORY_CHANGED' })
      // Checked where it is written: a file that went meanwhile is refused, not staged.
      return answered(null, {
        data: (d) => {
          const gone = paths.find((path) => !d.unstaged.includes(path))
          if (gone) throw refuse('not-found', `${gone} has no unstaged changes`)
          d.unstaged = d.unstaged.filter((path) => !paths.includes(path))
          d.staged.push(...paths)
        },
      })
    },

    'commit.UNSTAGE_FILES': async ({ paths }, { broadcast, refuse }) => {
      await work(`unstaging ${paths.join(', ')}`)
      broadcast('commit', { type: 'REPOSITORY_CHANGED' })
      return answered(null, {
        data: (d) => {
          const gone = paths.find((path) => !d.staged.includes(path))
          if (gone) throw refuse('not-found', `${gone} has no staged changes`)
          d.staged = d.staged.filter((path) => !paths.includes(path))
          d.unstaged.push(...paths)
        },
      })
    },

    'commit.REVERT_FILES': async ({ paths }, { broadcast, refuse }) => {
      await work(`reverting ${paths.join(', ')}`)
      broadcast('commit', { type: 'REPOSITORY_CHANGED' })
      return answered(null, {
        data: (d) => {
          const gone = paths.find((path) => !d.unstaged.includes(path))
          if (gone) throw refuse('not-found', `${gone} has no unstaged changes`)
          d.unstaged = d.unstaged.filter((path) => !paths.includes(path))
        },
      })
    },

    'commit.PUBLISH_BRANCH': async (_, { data, progress, broadcast, signal }) => {
      const ahead = data.ahead
      signal.addEventListener('abort', () => { said.push('gave up the push') })
      for (const phase of ['Counting objects', 'Writing objects']) {
        progress({ phase })
        await work(`pushing: ${phase}`)
        signal.throwIfAborted()
      }
      broadcast('commit', { type: 'REPOSITORY_CHANGED' })
      return answered({ pushed: ahead }, { data: (d) => { d.ahead = 0 } })
    },
  },
})

// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// Running it
// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════

if (globalThis.process?.argv?.[1]?.endsWith('commit.mts')) {
  const turns = (count: number): Promise<void> => new Promise((resolve) => { let left = count; const tick = (): void => { if (left-- <= 0) resolve(); else nextTurn(tick) }; tick() })
  const lines: string[] = []
  const say = (line: string): void => { lines.push(line) }
  // What each step must leave behind. The lines printed at the end are for reading; these are what is checked.
  let held = 0
  const holds = (what: string, actual: unknown, expected: unknown): void => {
    try { deepStrictEqual(actual, expected) } catch (error) { console.log(lines.join('\n')); throw new Error(`${what}\n${String(error)}`) }
    held++
  }

  const said: string[] = []
  using guard = defectGuard()
  using backend = system({ side: 'backend', onDefect: guard.onDefect })
  backend.start('code', git(() => turns(3), said))
  using window = system({ side: 'window', onDefect: guard.onDefect })
  using _link = connect(window, backend)
  void _link
  const surface = window.start('commit', commit)
  window.subscribe(() => {
    const shown = window.read(surface)
    if (!shown) return
    const { data: d, pending } = shown
    say(`    ${[d.gitStatus && `staged ${d.gitStatus.staged.join(',') || '-'} | unstaged ${d.gitStatus.unstaged.join(',') || '-'} | ahead ${d.gitStatus.ahead}`,
      Object.keys(pending.stage).length && `staging ${Object.keys(pending.stage).join(',')}`, pending.revert && `reverting (${pending.revert})`, pending.push && `pushing${d.pushPhase ? `: ${d.pushPhase}` : ''}`,
      d.selectedGitFile && `showing ${d.selectedGitFile.path}: ${d.gitDiff ?? '…'}`, d.gitError && `error "${d.gitError}"`].filter(Boolean).join(' | ')}`)
  })
  const send = (event: CommitEvent): void => window.send(surface, event)
  const now = () => window.read(surface).data
  const pending = () => window.read(surface).pending

  say('the surface starts: its status is read')
  await turns(12)
  holds('the status is there', now().gitStatus, { staged: [], unstaged: ['a.ts', 'b.ts', 'c.ts'], ahead: 2 })

  say('two files are staged at once')
  send({ type: 'commit.STAGE_FILE', path: 'a.ts' })
  send({ type: 'commit.STAGE_FILE', path: 'b.ts' })
  holds('both are being staged, which is read beside the data', pending().stage, { 'a.ts': true, 'b.ts': true })
  await turns(30)
  holds('neither is being staged any longer', pending().stage, {})
  holds('and the status was read again, because the repository changed', now().gitStatus, { staged: ['a.ts', 'b.ts'], unstaged: ['c.ts'], ahead: 2 })

  say('a file is selected, and another before the first one\'s diff is read')
  send({ type: 'commit.VIEW_DIFF', path: 'a.ts', staged: true });                  await turns(2)
  send({ type: 'commit.VIEW_DIFF', path: 'c.ts', staged: false });                 await turns(20)
  holds('the diff shown is of the file selected last', now().gitDiff, 'diff of c.ts')
  holds('and the backend was told to give up the first', said, ['gave up the diff of a.ts'])

  say('an unkeyed concurrent revert runs with typed input, and its refusal names the paths')
  send({ type: 'commit.REVERT_FILES', paths: ['c.ts'] })
  send({ type: 'commit.REVERT_FILES', paths: ['missing.ts'] })
  holds('two concurrent reverts are in flight', pending().revert, 2)
  await turns(30)
  holds('both reverts finished', pending().revert, 0)
  holds('the refusal named the missing path from scope.input', now().gitError, 'Could not revert missing.ts: missing.ts has no unstaged changes')
  send({ type: 'commit.DISMISS_ERROR' })

  say('a file that is not there is staged: the refusal is shown, and names the file')
  send({ type: 'commit.STAGE_FILE', path: 'z.ts' });                               await turns(20)
  holds('the error names it', now().gitError, 'Could not stage z.ts: z.ts has no unstaged changes')
  holds('and nothing is left being staged', pending().stage, {})
  send({ type: 'commit.DISMISS_ERROR' })

  say('a push, and a second while it is being made')
  send({ type: 'commit.PUSH_BRANCH' })
  send({ type: 'commit.PUSH_BRANCH' });                                            await turns(4)
  holds('one push is being made, and says how far it is', { pushing: pending().push, phase: now().pushPhase }, { pushing: true, phase: 'Counting objects' })
  await turns(30)
  holds('it ended, and the status says nothing is ahead', { pushing: pending().push, ahead: now().gitStatus?.ahead }, { pushing: false, ahead: 0 })

  say('a push that is stopped')
  send({ type: 'commit.PUSH_BRANCH' });                                            await turns(3)
  send({ type: 'commit.STOP_PUSH' });                                              await turns(20)
  holds('no push is being made, and none is reported as failed', { pushing: pending().push, error: now().gitError }, { pushing: false, error: null })
  holds('and the backend was told to give it up', said.at(-1), 'gave up the push')

  console.log(lines.join('\n'))
  console.log(`\n${held} things held`)
}
