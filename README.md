# apack-state

The state primitive [apack](https://github.com/spankyed/apack) is to be built on, in place of XState. As a
package, `@apackdev/state`.

**A system is states that reach each other by name. Each runs in steps, and a step is kept whole or not at all:
its data, the rows it wrote, and what it said.**

Status: started, 2026-11-23, from a prototype that was grown beside a plan in apack's repository. What is here is
that prototype's kernel and everything that holds it to what it says. Nothing in apack uses it yet, and the layout
and API are the prototype's, not yet a package's: files are `.mts`, and checks are scripts, not specs.

## Where to start

- [docs/design.md](docs/design.md): the design on one page, with a complete example.
- [docs/plan.md](docs/plan.md): the longer record. Why, every rule, rows and the database, each decision and what
  it replaced, what is proven, what is not built, and the order of work.
- [docs/files.md](docs/files.md): what each file is.

## Layout

| Folder | Holds |
|---|---|
| `src/` | The package: the types a state is checked against (`types.ts`) and the kernel (`kernel.ts`), drafts, the mirror a component reads, the Vue binding, and the schedule that runs a scenario under every ordering |
| `checks/` | What holds the kernel to what it says, each file a script that exits non-zero when something does not hold. Rows are checked in memory and on [elmdb](https://github.com/spankyed/elmdb) |
| `examples/` | Parts of apack ported to it: search, commit, threads, views, the library system |
| `measure/` | What things cost. These print, and refuse nothing |
| `surveys/` | Scripts that read an apack checkout: how it uses XState, and where it writes to the database |
| `tools/` | A state's graph, derived from its types |

It is one of three siblings: [elmdb](https://github.com/spankyed/elmdb) keeps the rows a step writes, and
[apack-link](https://github.com/spankyed/apack-link) carries what states say between a backend and its windows.

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
`npm run test:watch` runs again what a change touches. `npm run measure` runs the measurements.
