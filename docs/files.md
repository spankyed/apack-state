# What each file is

What [the plan](plan.md) describes, as code that runs. The design on one page, with a complete example, is
[design.md](design.md). `src/` is the package; `checks/` holds it to what it says; `examples/` are parts of apack
ported to it; `measure/` prints what things cost; `surveys/` read an apack checkout; `tools/` read states' types.

| File | What it is |
|---|---|
| `docs/deferred/` | What is left out of the plan on purpose, each with what it is, what it would take, and what would make it worth starting |
| `src/index.ts` | The door: every export of the package, by name |
| `etc/*.api.md` | What each entry offers, as API Extractor reads it: `npm run api:check` holds the source to them, `npm run api:update` writes them |
| `scripts/api.mjs` | Writes or checks those reports, from declarations emitted afresh from the source |
| `src/types.ts` | The types a state's code is checked against: its shape, its definition, what a handler is handed and may return, and how one state reaches another |
| `src/kernel.ts` | The kernel: systems, steps, asks, and the link between a backend and its windows |
| `src/port.ts` | What one system offers another, and the link in memory between a window and its backend |
| `src/draft.ts` | Data edited in place, from which a new value is made. What the kernel uses for a nested change |
| `measure/append-cost.mts` | What a growing list costs one change at a time and in batches, on the draft and through an ask. Runs, for about 25 seconds |
| `measure/frozen-cost.mts` | What a frozen list costs to read and to copy, beside the same list unfrozen. A measurement: it prints, and refuses nothing |
| `src/mirror.ts` | A running state as a value a component reads: each field is the state's own object, never copied or wrapped, written when the state replaces it. One mirror for each state, shared by all that read it |
| `src/vue.ts` | `useState`: what a Vue component uses to read a running state and tell it things |
| `checks/vue-check.mts` | `useState` checked by rendering real components with Vue's runtime and counting what rendered, as render functions and as compiled templates. Runs |
| `type-tests/*.ts` | What must not compile, by topic: data that cannot be written, asks, follows, awaits, makes, starts, who may send what, refusals and `within`. Each `@ts-expect-error` is a case; `npm run typecheck` fails on one whose line compiles. Compiled, never run |
| `type-tests/vue-templates/` | A component file with a template, and the states it reads, for `vue-tsc` to check: what a template may read, and six lines that have to be errors |
| `src/window-frame.ts` | What a frame is in a window: the next paint while it shows, the next turn while it is hidden |
| `checks/progress-check.mts` | That progress is gathered and nothing else is, and that what a state hears keeps the order it was sent in. Runs |
| `src/schedule.ts` | A schedule given to the kernel in place of the event loop: runs a scenario under every ordering, or a seed's worth, and replays one |
| `checks/schedule-check.mts` | The schedule itself: each ordering run once, a limit that says it stopped short, a failure that names its ordering and replays, and a run that never comes to rest stopped. Runs |
| `checks/interleaving-check.mts` | Scenarios run under every ordering: a search over a search, a cancel, a click among progress, a window closing. Runs, for about 7 seconds |
| `examples/commit.mts` | A slice of the app's commit surface ported: its status and a diff as reads it awaits, staging and a push as writes it makes. Runs, and checks what each step leaves |
| `checks/internal-check.mts` | Who may send a state what: the events it sends itself reach it from nowhere else, and one surface tells another in its window. Runs |
| `checks/awaits-check.mts` | The reads a state awaits: from the fields it names, or one for each key of a field. Runs |
| `checks/makes-check.mts` | The writes a state makes: said once with `make`, with which are under way kept by the kernel. Runs, for about 10 seconds |
| `checks/checks.mts` | What every check file is written with: each check becomes a vitest case with its own name, each system a check makes is stopped however it ends and given a limit on its steps, and `rest()` waits until what the check started has come to rest |
| `checks/examples-check.mts` | Runs each example that runs, as a case of its own |
| `checks/starts-check.mts` | The states a state starts: declared, and which of them run follows from its data. Runs |
| `checks/follows-check.mts` | The views a state follows: declared, and which are followed, and what each is asked for, follow from its data. Runs |
| `checks/answer-check.mts` | An ask that changes something as it answers: the change is there with the answer, a refused change fails the ask, nothing is lost across a wait. Runs |
| `checks/failure-check.mts` | What happens when a state's work or a handler throws: where the state goes, and that the kernel goes on. Runs |
| `checks/leaving-check.mts` | What happens to an ask when whoever made it goes: it throws `Left` where awaited, `finally` runs, the answerer is told, nothing hangs. Runs |
| `checks/store.mts` | Rows as the rule about them is checked: one interface, and rows kept in memory behind it. `transact` is all the kernel is given of it |
| `checks/store-elmdb.mts` | The same interface over the app's engine, elmdb, on a temporary database. Needs the checkout's dependencies |
| `checks/rows-check.mts` | A step as one unit of the database: a handler's rows, data and what it sent kept together, on both stores. Runs, for about 12 seconds |
| `checks/rows-property.mts` | The same rule as a property: runs of handlers made from a seed, held against a model of a few lines, one after another and under way together. Runs, for about 25 seconds, and names the seed of a run that differs |
| `checks/views-check.mts` | A window hears of a step after its views show it: views over the link, and what a step sends windows held until they have been sent its rows. Under every ordering in memory, and on elmdb. Runs, for about 10 seconds |
| `measure/rows-cost.mts` | What a unit around a step and around each handler costs on elmdb, beside the engine alone, and what holding an answer for the views costs a window. A measurement: it prints, and refuses nothing |
| `surveys/writes-survey.mts`, `surveys/writes-shape.mts` | Where the app writes to the database, and how each function that writes does it, read from syntax trees. Each takes the checkout to read |
| `checks/binding-check.mts` | That a reader is handed the state's own values and runs when a field it read is replaced, that none of it can be written, and that a hidden window still hears. Runs |
| `checks/kernel-check.mts` | What the kernel does with a change to data, a move that edits a draft and the refused edits included. Runs |
| `checks/draft-check.mts` | The checks a hand-built draft has to pass. Runs |
| `examples/search.mts` | The app's code search, backend and surface, ported. Runs, and checks what each step leaves |
| `examples/library.mts` | The app's library system ported handler for handler. Typechecks against stand-ins for its imports; not run |
| `examples/threads.mts` | Three backend systems, a state per thread, and two windows: asks, tells, a reply the thread writes and broadcasts, windows that leave part-way, and a refusal that carries data. Runs, and checks what each step leaves |
| `examples/views.mts` | A surface following views, modelled on the threads surface: one always, one while a thread is open, one per tab. Runs, and checks what is followed after each step |
| `tools/graph.mts` | Derives each state's graph from its types, running nothing |
| `surveys/xstate-survey.mts` | The survey of how the app uses XState that the plan's figures come from |

Every check runs with `npm test`, each file a spec and each check a case. One file, or the cases named with some
words:

```bash
npx vitest run draft
```

```bash
npx vitest run -t "under every ordering"
```

An example runs on its own too:

```bash
npx tsx examples/threads.mts
```

The component `vue-tsc` checks:

```bash
npx vue-tsc --noEmit -p type-tests/vue-templates/tsconfig.json
```
