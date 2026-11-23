# apack-state

The state primitive apack is to be built on. `README.md` says what it is; this is what to know before changing it.

## Layout

- `src/index.mts` is the door: what it exports is the package. `src/state.mts` is the types and the kernel,
  `src/draft.mts` data edited in place, `src/mirror.mts` and `src/vue.mts` what a component reads a running state
  with (`@apackdev/state/vue`), `src/schedule.mts` the schedule a check runs under every ordering
  (`@apackdev/state/testing`), `src/window-frame.mts` what a frame is in a window.
- `checks/` is every check, each a script: `checks.mts` is what they are written with, `store.mts` and
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
npm test
npm run build
```

`npm test` runs each check as its own process and reads which from the folders, so a new `checks/*-check.mts` is
run without being listed. A check that starts a process stops it and waits for it to exit.

elmdb's packages are installed from a release's tarballs, named by commit in `package.json`. Moving them is
editing both URLs to another release and `npm install`.
