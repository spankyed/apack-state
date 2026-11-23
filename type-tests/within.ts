// `within`: narrowing a state read from outside by where it is.
// Compiled by `npm run typecheck`, never run: each `@ts-expect-error` is a line that must not compile, and one that
// compiled would fail the check as an unused directive.

import { within } from '../src/index.ts'
import type * as from from '../examples/threads.mts'
type ThreadsSurface = from.ThreadsSurface

// ── `within`: what must not compile ─────────────────────────────────────────────────────────────────────────────────

function withinMustNotCompile(value: import('../src/index.ts').Value<ThreadsSurface>): void {
  // @ts-expect-error a thread's id exists only somewhere inside `thread`
  void value.data.threadId
  if (within(value, 'thread')) void value.data.threadId
  if (within(value, 'thread.sending')) void value.data.documentId
  // @ts-expect-error there is no such state to be inside
  within(value, 'board')
  // @ts-expect-error inside `thread` is not enough to know it is sending
  if (within(value, 'thread')) void value.data.documentId
}
void withinMustNotCompile
