# apack-state: the design on one page

This is the design as it stands, with no history. How it got here, what was tried first and what is not built are in
[the plan](plan.md). Everything shown here runs: the kernel is [`src/`](../src/), and [files.md](files.md) says what each file is.

## A state

There is one primitive, a **state**. A state has its own data, and is at exactly one of the states inside it. What you
read is where it is and the data there:

```ts
{ at: 'thread.sending', data: { titles, threadId, text } }
```

Data exists only while the state that declares it is the case. `threadId` is there while the state is somewhere inside
`thread`, and reading it anywhere else does not compile.

## What a state declares

Its shape is a type. Its definition has the same keys at every depth.

| Key | What it says |
|---|---|
| `data` | Its own fields and their starting values. `given` marks one that whoever enters it has to give |
| `initial`, `states` | The states inside it, and which it is at when entered |
| `on` | The events others may send it. A handler is synchronous and returns what happens next: `{ at, data }` |
| `internal` | The events it sends itself, which nothing else may send it |
| `answers` | The asks it answers. A handler returns the answer, or `answered(answer, next)` to change something as it answers |
| `listen` | External push subscriptions held while it is the case, without blocking `idle()`. Returning a cleanup registers it with `onExit` |
| `run`, `failed` | Work it does while it is the case, and where it goes if that work fails |
| `starts` | Other states it runs |
| `follows` | Views of the database it keeps up to date |
| `loads` | Reads it is loading |
| `calls` | Writes it calls on demand |
| `waits` | Timers it arms on demand |

## Standing things follow the data

`starts`, `follows` and `loads` are all **standing**: while the data says so, they go on. You never start, follow or
read by hand. A state declares each and says which fields of its data it depends on, and the kernel keeps what is
live matching the data, looking again only when one of those fields changes.

Each entry depends on the data in one of two ways:

- **`from: ['id']`**: there is one, and it reads these fields. It is asked again when one of them changes.
- **`each: 'titles'`**: there is one for each key of this field, or each item of a list. A key that appears starts
  one, and a key that goes stops it.

What is followed or loaded may say both: **`each: 'openDiffs', from: ['revision']`** is one for each key, every one
of them asked again when a field in `from` changes, the one before for that key stopped. A key that appears or goes
still starts or stops its own alone. `args` is given the key, and then the fields named.

So changing data is how they start and stop:

| To do this | Change the data like this |
|---|---|
| Open a thread's state | Add its id to `titles` |
| Follow another thread's detail | Set `id` |
| Read the status again | Count `revision` up |
| Read every open diff again | Count `revision` up, where each is `each: 'openDiffs', from: ['revision']` |

## A write is called once

A write is not standing. Nothing in the data stands for it: it is fired once, because a handler called `call`. The
kernel sends it when the step commits, and keeps the record of which are in flight. A component reads that record
beside `at` and `data`, as `pending`.

| To do this | Say this |
|---|---|
| Stage a file | `call('stage', path)` |
| Push | `call('push')` |
| Stop a push | `cancel('push')` |

Keeping the two apart is what Elm does with subscriptions and commands, and TanStack Query with queries and
mutations. It matters for three reasons: the kernel never changes a state's data, one thing owns the record of what
is in flight, and restoring a state reads again but does not write again.

The same split holds for imperative timers under **`waits`**: armed on demand with `arm(name, ...)` and cleared with
`disarm(name, key?)` (`one` or keyed `each`, fixed default `ms` with optional override or runtime `{ one: 'ms' }` /
`{ each: 'ms' }`, `reset: true` debounce by default or `reset: false` throttle, optional `done` for pure-TTL flags).
Which timers are armed lives on `waiting` beside `at`, `data`, and `pending`, disarms automatically on state exit, and
never blocks `idle()`. Like `call`, an `arm` belongs to the active state instance that declared it (so exiting or
self-re-entering that state in the same step drops it); to arm a timer on state entry or self-transition, call `arm`
from that state's `listen` or `run`. A name under `calls` or `waits` is one entry of `pending` or `waiting` and stands for
one thing: it has one kind across a definition, and a state does not declare again a name a state around it declares.
States beside each other may share one.

## A complete example

A slice of the app's commit surface: its status, the diff of the selected file, staging, and a push. The real one is
1,778 lines, declares 54 asks, and keeps a hand-written list of which are under way. This has no ids, no list, and no
event for how an ask ended.

```ts
type Commit = {
  data: {
    gitStatus: GitStatus | null
    revision: number                                    // counts each change to the repository
    selectedGitFile: { path: string; staged: boolean } | null
    gitDiff: string | null
    pushPhase: string | null
    gitError: string | null
  }
  calls: { stage: 'each'; push: 'one' }                 // staging for each of many paths, one push at a time
}

const commit = state<Commit, CommitEvent>()({
  data: { gitStatus: null, revision: 0, selectedGitFile: null, gitDiff: null, pushPhase: null, gitError: null },

  // Reads. Each is there because the data says so.
  loads: (load) => ({
    // Loaded as the surface starts, and again whenever the repository changes.
    status: load('code', 'commit.GET_GIT_STATUS', {
      from: ['revision'],
      args: () => ({}),
      done: (outcome) => (outcome.ok ? { data: { gitStatus: outcome.value } } : { data: { gitError: outcome.failure.message } }),
    }),

    // The diff of whichever file is selected. Selecting another cancels the read of the first.
    diff: load('code', 'commit.GET_GIT_DIFF', {
      from: ['selectedGitFile'],
      args: ({ selectedGitFile }) => selectedGitFile,
      done: (outcome) => (outcome.ok ? { data: { gitDiff: outcome.value.text } } : { data: { gitError: outcome.failure.message } }),
    }),
  }),

  // Writes. Each is called when a handler says so.
  calls: ({ one, each }) => ({
    stage: each('code', 'commit.STAGE_FILES', {
      args: (path) => ({ paths: [path] }),
      done: (outcome, { key }) => (outcome.ok ? undefined : { data: { gitError: `Could not stage ${key}: ${outcome.failure.message}` } }),
    }),

    push: one('code', 'commit.PUBLISH_BRANCH', {
      args: () => ({}),
      progress: (updates) => ({ data: { pushPhase: updates.at(-1)!.phase } }),
      done: (outcome) => ({ data: { pushPhase: null, ...(outcome.ok ? {} : { gitError: outcome.failure.message }) } }),
    }),
  }),

  on: {
    'commit.STAGE_FILE':  ({ path }, { call }) => { call('stage', path) },
    'commit.VIEW_DIFF':   ({ path, staged }) => ({ data: { selectedGitFile: { path, staged }, gitDiff: null } }),
    'commit.PUSH_BRANCH': (_, { call }) => { call('push') },           // a second while one is pending is the same push
    'commit.STOP_PUSH':   (_, { cancel }) => { cancel('push'); return { data: { pushPhase: null } } },
    'REPOSITORY_CHANGED': (_, { data }) => ({ data: { revision: data.revision + 1 } }),
  },
})
```

And the component that shows it:

```vue
<script setup lang="ts">
const { state: commit, send } = useState('commit')
</script>

<template>
  <Spinner v-if="commit.pending.push" :label="commit.data.pushPhase" />
  <li v-for="file in commit.data.gitStatus?.unstaged" :key="file">
    {{ file }}
    <Spinner v-if="commit.pending.stage[file]" />
    <button v-else @click="send({ type: 'commit.STAGE_FILE', path: file })">Stage</button>
  </li>
</template>
```

Whether a write is in flight is `pending`, which the kernel keeps and the component reads. It imports nothing but the
state.

## The other two standing things, in the same grammar

```ts
// States it runs: a thread for each title, told which it is.
starts: (start) => ({
  thread: start(thread, { each: 'titles', given: (threadId) => ({ threadId }) }),
}),

// Views it follows: the detail of the open thread (or nothing when `id` is null), and one for each open tab.
follows: (follow) => ({
  detail: follow('threads', 'detail', { from: ['id'], args: ({ id }) => (id ? { id } : null), updated: (update) => … }),
  tab:    follow('threads', 'tab',    { each: 'openTabs', args: (threadId) => ({ threadId }), updated: (update, { key }) => … }),
}),
```

## When to use which

| What it is | Use |
|---|---|
| A value fetched for some arguments | `loads`, with `from` |
| A value fetched for each of many things | `loads`, with `each` |
| A write to fire, one at a time | `calls`, with `one`, and `call(name, input?)` (`pending.<name>: boolean`) |
| A write to fire, one per key | `calls`, with `each`, and `call(name, key, input?)` (`pending.<name>: Record<string, true>`) |
| A write to fire, several unkeyed at once | `calls`, with `many`, and `call(name, input?)` (`pending.<name>: number`) |
| A timer to arm on demand (debounce, throttle, TTL flag, retry) | `waits`, with `one` or `each`, and `arm(name, ...)` / `disarm(name, key?)` (`waiting.<name>`) |
| Something the surface is *in*, where what it accepts changes | A state with `run`, like `searching` |
| External push events (emitters, watchers, DOM listeners) | `listen` (state-lifetime scope, automatic cleanup, keeps `idle()` true) |
| A thing with a life of its own, one for each id | `starts`, with `each` |
| Data from the database that keeps changing | `follows` |

A call may declare a typed input in `Shape.calls` (`{ one: In }`, `{ each: In }`, `{ many: In }`). The frozen input is
passed to `args`, `progress` (`scope.input`), and `done` (`scope.input`), and is never written to `StepLog`. When the
ask takes `{}` — or, for `{ one: In }` / `{ many: In }`, when `Read<In>` is a plain object already assignable to the
ask's args — `args` may be omitted.

## Talking to other states

| Verb | From | To |
|---|---|---|
| `send(event)` | A state | Itself: an event only it sends, or one others may send it |
| `tell(name, event)` | A state | A backend system. Nobody waits |
| `tell({ surface }, event)` | A state in a window | Another surface in that window |
| `tell({ peer }, event)` | A state | A named non-window peer attached via `attach(name, peer)`. Delivered after commit with no view hold |
| `ask(name, ask, args)` | A state's `run`, or an ask's handler | A backend system. One answer comes back |
| `progress(update)` | An ask's handler | Whoever asked, and only them |
| `broadcast(name, event)` | The backend | That surface in every window |
| `report(event)` | A state that was started | The state that started it |
| `call(name, ...)` / `cancel(name, key?)` | A state | The kernel: fire a declared write (with key and/or typed input), or cancel it (or all in flight for `many`) |
| `arm(name, ...)` / `disarm(name, key?)` | A state | The kernel: arm a declared timer (with key and/or `ms`), or disarm it (or all keys of `each`) |

A component reads and sends. It does not ask.

`tell({ peer: name }, event)` calls `port.tell(name, event)`, passing the peer name as the target `to`. To reach several
systems behind one `@apackdev/link` connection, attach that same port under each peer name (and detach each on `link.onEnd`);
if a remote system uses a different name than the local peer, wrap `tell` at the wiring site
(`{ tell: (_, event) => port.tell('remoteName', event) }`).

A write is told when losing it does not matter, and asked when it does. There is no third way to make one.

## A step's log

A system given `log` tells it of each step once it has ended, for a timeline or a devtools panel to read:

```ts
system({ side: 'window', log: (step) => timeline.push(step) })

// { number: 12, status: 'committed',
//   handled: [{ kind: 'event', ref: 'commit', name: 'commit.PUSH_BRANCH' }, { kind: 'call', ref: 'commit', name: 'push' }],
//   changed: { commit: { fields: ['pushPhase'], moved: false, pending: true, at: 'ready' } },
//   sent: [{ kind: 'ask', to: 'code', name: 'commit.PUBLISH_BRANCH' }] }
```

- **What began it, and everything after**: each thing handled in order, as its kind (an event, an ask, a view's
  result, how a read or write finished, what a state's work found), the state, and the name it was declared or sent by.
  An event a state sent itself is marked `own`. When the system is given a `clock`, `now` stamps when the step began,
  and every handler in the step reads that same `now`.
- **What changed**: for each state that did, the fields of its data, whether it moved, where it is, and whether
  its pending calls or armed waits changed.
- **Only what was taken.** A view's update, how a read or write finished, its progress, or a timer's expiry that is
  stale when its turn comes (the state no longer follows, awaits, has pending or has armed the one it belongs to) takes
  no step, so no log names it and the numbers have no gap for it.
- **What was sent at the commit (`sent`)**, in order: answers, with `ok` or the failure's kind; progress; tells, peer tells (with
  `dropped` when no peer is attached under that name, or `failed` when its `tell` threw), asks, broadcasts, follows and
  unfollows across a link; asks abandoned when their state ended. Each by kind, to whom, and name.
- **How it finished (`status`)**: `committed`; `lost`, when its rows could not be kept and the system stopped; `halted`, when it
  ran away.
- **Never what any of it carried.** An event's fields, a call's input, an ask's arguments, an answer, progress, a refusal's message and
  data are none of them in a log. A log that throws is its own to answer for, and the system goes on.
- **Structured defects (`onDefect`) and `using` cleanup.** `system({ onDefect })` receives each kernel defect as a
  structured `{ message, ref?, error? }` record (preserving original `Error` stacks) in addition to `trace('DEFECT: …')`.
  `System`, `Connected`, and `DefectGuard` implement `[Symbol.dispose]()` so tests and callers can clean up with `using`.

## What holds, always

- **Only a handler changes data.** The kernel never does. What is in flight is its own record, beside the data.
- **What a state holds is a value, and it is frozen.** A write to it throws on the line that tried, and most do not
  compile: what is read is typed so that no field can be assigned, at any depth, and a list a
  field holds cannot be changed in place. One that runs is reported with what to write. A component is
  handed these same objects, a field at a time, and runs again at least when a field it read was replaced. To be
  exact inside a field, give each of many a state of its own, or read the part through a `computed`.
- **A change is all of it or none.** What the compiler refuses, the kernel refuses too, whole, where it is tried.
- **One message and everything it causes is one step.** Nothing leaves until the step commits, so nobody sees a
  half-made change, and what runs is matched to the data once, as the step ends.
- **A step is one database transaction.** A handler's rows, its data and what it sends are kept together, a handler
  that changes nothing has written nothing and said nothing, a link is written to rows that are there, and a write outside a step is
  refused. A window hears of a step after its views show it. Rows that cannot be kept stop the system, and every ask
  is answered. Nothing outside the database is part of it: git, files and models are
  done first, and the row that records one is written in the step its result arrives in.
- **Work has one owner and stops when its owner does.** A state's `listen` and `run` are the state's. An ask is the asker's. What a
  state starts, follows, loads or calls is that state's. Stopping a top-level state with `stop(handle)` ends that state
  and everything it started without touching sibling top-level states; `stop()` ends them all. `listen` keeps a
  state-lifetime scope until the state exits without blocking `idle()`, unsubscribes automatically on exit, and ignores
  late callbacks after exit. When `run` or an ask's handler finishes (returns or throws),
  the kernel cancels any `ask` or `sleep` it started and ignores any later calls on its scope (`send`, `tell`,
  `progress`, etc.). Public `scope.signal` means cancellation only (the state was left, the asker left, or the system
  stopped): it does not abort on normal completion, so outside work handed `scope.signal` and not awaited is not stopped
  when `run` or an ask returns.
- **An answer and the change it makes are one thing.** Whoever asked is never told of a change that was not made.
- **An ask or `sleep` whose owner has gone throws `Cancelled` where it is awaited**, so `finally` runs and what was held is let go.
- **Handlers are pure; work is not.** A handler's result depends only on its data, the event and the step's `now` (recorded in `StepLog.now`). In `run` or an ask's handler after an `await`, `now` reads the clock live and is not logged, so a decision that must be replayable belongs in the handler that receives the work's result.
- **What is no longer held is not heard from.** What a view delivers, how a read or a write ended, what it said
  before it ended, and a timer's expiry reach a handler only while the state holds the very one they belong to. One
  that was left, stopped, cancelled, disarmed or begun again by the time its turn comes takes no step at all.
- **Nothing depends on itself in a circle.** What a view delivers, or how a read ended, may not change a field it is
  itself asked from.
- **Every ordering is checked, not the one that happened.** A schedule stands in for the event loop and runs a
  scenario under every ordering its messages allow.
