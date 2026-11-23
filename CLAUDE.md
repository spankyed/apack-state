# apack-state

The state primitive apack is to be built on. `README.md` says what it is; this is what to know before changing it.

## Layout

- `src/index.ts` is the door: what it exports, each by name, is the package. `src/types.ts` is what a state's code
  is checked against, `src/kernel.ts` the systems that run states, `src/port.ts` what joins two systems,
  `src/draft.ts` data edited in place, `src/mirror.ts` and `src/vue.ts` what a component reads a running state with
  (`@apackdev/state/vue`), `src/schedule.ts` the schedule a check runs under every ordering
  (`@apackdev/state/testing`), `src/window-frame.ts` what a frame is in a window. What a module exports that the
  doors do not is marked `@internal`: the package's own, which checks may reach and nothing else should.
- `checks/` is every check, each file a vitest spec: `checks.mts` is what they are written with, `examples-check.mts`
  runs the examples, `store.mts` and
  `store-elmdb.mts` the rows a step writes, in memory and on elmdb, and `vue-fixture/` a component `vue-tsc` checks.
- `examples/`, `measure/`, `surveys/` and `tools/` are as `docs/files.md` says.
- `docs/design.md` is the design with no history; `docs/plan.md` the record, with what is not built and the order
  of work.

## Rules

- **One primitive.** A state. What looks like a second kind of thing is a state, or is not built.
- **A step is one unit.** Data, rows and what was said are kept together or not at all. The kernel is given
  `transact` and names no database.
- **Every ordering, not a likely one.** What depends on order is checked under the schedule, exhaustively where
  that is feasible and from a seed where it is not, and a failure names its seed.
- **No dependencies at run time.** Vue is a peer of the Vue binding alone, and elmdb is here only to check rows.
- **A check says what holds, not how.** A case every rewrite that keeps the behaviour would fail is a case about
  the code. A mutation check is run on a copy.
- **The plan is the record.** A decision that changes the design changes `docs/plan.md` and `docs/design.md` in
  the same change.

## Commands

```bash
npm run typecheck
npm run api:check
npm test
npm run build
```

`etc/*.api.md` is what each entry offers, as API Extractor reads it from the source. A change to what the package
offers fails `api:check` until `npm run api:update` has written it, so it shows in the diff. A type a public
signature uses and no entry exports is listed there as a forgotten export.

`npm test` runs every check with vitest: each `checks/*-check.mts` is a spec, run without being listed, and each
check in it a case with its own name (`checks/checks.mts` makes them). No case is given a time to finish in.
`npm run measure` runs the measurements, each as its own process (`scripts/measure.mjs`). A check that starts a process stops it and waits for it to exit.

elmdb's packages are installed from a release's tarballs, named by commit in `package.json`. Moving them is
editing both URLs to another release and `npm install`.
