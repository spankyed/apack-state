// Reaching a started state from outside, checked against what its starter declares.
// Compiled by `npm run typecheck`, never run: each `@ts-expect-error` is a line that must not compile, and one that
// compiled would fail the check as an unused directive.

import { system } from '../src/index.ts'
import type * as from from '../checks/binding-check.mts'
declare const board: typeof from.board

// What must not compile: forNet a started state from outside is checked against what its starter declares.
{
  const sys = system({ side: 'window' })
  const handle = sys.start('typed', board)
  // @ts-expect-error a card is one of many, so forNet one takes its key
  void sys.child(handle, 'card')
  // @ts-expect-error the board starts no such state
  void sys.child(handle, 'deck', 'a')
  sys.stop()
}
