// What a component may read of a running state and send it, as render functions.
// Compiled by `npm run typecheck`, never run: each `@ts-expect-error` is a line that must not compile, and one that
// compiled would fail the check as an unused directive.

import { defineComponent } from '@vue/runtime-core'
import { vueBinding } from '../src/vue.ts'
import type * as from from '../checks/vue-check.mts'

const { useState } = vueBinding<{ board: typeof from.board }>()

// What must not compile.
defineComponent(() => {
  const it = useState('board')
  // @ts-expect-error the window runs no such state
  useState('deck')
  // @ts-expect-error the board takes no such event
  it.send({ type: 'SHUFFLE' })
  // @ts-expect-error a card is one of many, so reaching one takes its key
  it.child('card')
  const one = useState(() => it.child('card', 'a'))
  // @ts-expect-error a card may not be running, so what it holds cannot be read without saying what if it is not
  void one.state.value.data.bumps
  void one.state.value?.data.bumps
  // @ts-expect-error a component sends; it does not ask
  void it.ask
  return () => null
})
