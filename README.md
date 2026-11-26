# apack-state

The state primitive [apack](https://github.com/spankyed/apack) is to be built on, in place of XState. As a
package, `@apackdev/state`.

**A system is states that reach each other by name. Each runs in steps, and a step is kept whole or not at all:
its data, the rows it wrote, and what it said.**

Status: packaged as `@apackdev/state` (`.`, `./vue`, `./testing`, `./graph`, and `apack-state-graph` CLI), with zero runtime dependencies, Node and Chromium
browser specs, TypeScript 5.7+ floor checking, API Extractor reports, and mutation testing. Nothing in apack has
switched over yet; releases are installed by GitHub tarball URL (`pkg-<commit>`).

## Where to start

- [docs/design.md](docs/design.md): the design on one page, with a complete example.
- [docs/guarantees.md](docs/guarantees.md): the four lifetimes, atomicity, cancellation, handle semantics, and the trusted-host boundary.
- [docs/plan.md](docs/plan.md): the longer record. Why, every rule, rows and the database, each decision and what
  it replaced, what is proven, what is not built, and the order of work.
- [docs/files.md](docs/files.md): what each file is.
- [docs/errors.md](docs/errors.md): what a compile error means, and what to write instead.

## Layout

| Folder | Holds |
|---|---|
| `src/` | The package: types (`types.ts`), kernel (`kernel.ts`), port/clock contracts (`port.ts`), drafts (`draft.ts`), Vue mirror and binding (`mirror.ts`, `vue.ts`), testing kit (`testing.ts`), window framing (`window-frame.ts`), and turn helper (`turn.ts`) |
| `checks/` | Vitest specs holding the kernel to what it says (run in Node and Chromium). Rows are checked in memory and on [elmdb](https://github.com/spankyed/elmdb) |
| `type-tests/` | Compile-time `@ts-expect-error` and positive type checks, including Vue templates checked with `vue-tsc` |
| `examples/` | Parts of apack ported to it: search, commit, threads, views, the brain slice, and the library system |
| `etc/` | API Extractor reports (`*.api.md`) and derived example graphs (`graphs/*.txt`) |
| `measure/` | Benchmarks (`npm run bench`, recorded in `bench/`) |
| `surveys/` | Scripts that read an apack checkout: how it uses XState, and where it writes to the database |
| `tools/` | A state's graph, derived from its types |

It works with three siblings: [elmdb](https://github.com/spankyed/elmdb) keeps the rows a step writes,
[apack-link](https://github.com/spankyed/apack-link) carries what states say between a backend and its windows, and
[apack-orderings](https://github.com/spankyed/apack-orderings) drives exhaustive interleaving schedules.

## Checking a pack's states

`@apackdev/state/testing` is what a pack's checks are written with, over the schedule of
[`@apackdev/orderings`](https://github.com/spankyed/apack-orderings) and the in-memory link of
[`@apackdev/link`](https://github.com/spankyed/apack-link), which whoever uses this entry installs beside
it (`connect(window, backend, schedule?)` joins two systems across a real link). A scenario builds systems on a
schedule and says what must hold once everything has come to rest; the schedule
chooses the order of everything put off, and runs every one:

```ts
import { system } from '@apackdev/state'
import { everyOrder, fromEvents, onSchedule } from '@apackdev/state/testing'

await everyOrder((schedule) => {
  const window = system({ side: 'window', ...onSchedule(schedule) })
  const counter = window.start('counter', counterState)
  schedule.does('one user', ['adds', () => window.send(counter, { type: 'ADD', by: 1 })])
  schedule.does('another', ['resets', () => window.send(counter, { type: 'RESET' })])
  // Waits on nothing but the schedule: `schedule.clock.sleep(60_000)` is an hour that passes when it is chosen.
  return () => { /* what holds, whichever went first */ }
})

// Runs of events the state declares, drawn from a seed, with what always holds checked after every step.
await fromEvents({
  state: counterState,
  events: { ADD: (random) => ({ type: 'ADD', by: random.int(3) }), RESET: () => ({ type: 'RESET' }) },
  always: (value) => { /* … */ },
  steps: 12, runs: 50, seed: 1,
})
```

A failure names the ordering, or the seed and the events sent, that make it again.

## Installing it

Each commit on `master` whose CI passed is a prerelease, `pkg-<commit>`, holding the package as `npm pack` packs it
and its `SHA256SUMS`. It is installed by the tarball's URL, and never from npm:

```bash
npm install https://github.com/spankyed/apack-state/releases/download/pkg-<commit>/apackdev-state-0.1.0.tgz
```

## Commands

```bash
npm run typecheck
```

```bash
npm run api:check
```

```bash
npm test
```

```bash
npm run build
```

`npm test` runs every check with vitest, each file a spec and each check a case of it. `npx vitest run rows` runs
the files whose path has `rows` in it, `npx vitest run -t "<words>"` the cases named with them, and
`npm run test:watch` runs again what a change touches. `npm run bench` runs the measurements and prints each beside the reading recorded in `bench/`, with the
conditions it was read under; `npm run bench:record` records them.
