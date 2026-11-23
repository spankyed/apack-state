// A refusal's data is part of the ask's declaration.
// Compiled by `npm run typecheck`, never run: each `@ts-expect-error` is a line that must not compile, and one that
// compiled would fail the check as an unused directive.

import { type AskFailure } from '../src/index.ts'
import type * as from from '../examples/threads.mts'
declare const state: typeof from.state
declare const thread: typeof from.thread
type Threads = from.Threads
type ThreadsAsks = from.ThreadsAsks
type ThreadsEvent = from.ThreadsEvent

// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// What must not compile: a refusal's data is part of the ask's declaration
// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════

/** Never called: it exists to be typechecked. */
function mustNotCompile(): void {

  state<Threads, ThreadsEvent, ThreadsAsks>()({
    data: { titles: {} },
    starts: (start) => ({ thread: start(thread(undefined as never), { each: 'titles', given: (threadId) => ({ threadId }) }) }),
    asks: {
      CREATE_THREAD: () => ({ threadId: 'THR-1' }),
      // @ts-expect-error `attachment-missing` carries the document's id, so it cannot be refused without one
      USER_MSG: async (_, { refuse }) => { throw refuse('attachment-missing', 'no') },
    },
  })

  state<Threads, ThreadsEvent, ThreadsAsks>()({
    data: { titles: {} },
    starts: (start) => ({ thread: start(thread(undefined as never), { each: 'titles', given: (threadId) => ({ threadId }) }) }),
    asks: {
      CREATE_THREAD: () => ({ threadId: 'THR-1' }),
      // @ts-expect-error `no-such-thread` carries nothing, so it takes no document id
      USER_MSG: async (_, { refuse }) => { throw refuse('no-such-thread', 'no', { documentId: 'DOC-1' }) },
    },
  })

  const failure = undefined as unknown as AskFailure<ThreadsAsks['USER_MSG']>
  // @ts-expect-error the document's id exists only once the kind is known to be `attachment-missing`
  void failure.documentId
  if (failure.kind === 'attachment-missing') void failure.documentId
}
void mustNotCompile
