# apack-state

The state primitive apack is to be built on. `README.md` says what it is; this is what to know before changing it.

## Layout

- `src/index.ts` is the door: what it exports, each by name, is the package. `src/types.ts` is what a state's code
  is checked against, `src/kernel.ts` the systems that run states, `src/port.ts` what joins two systems,
  `src/draft.ts` data edited in place, `src/mirror.ts` and `src/vue.ts` what a component reads a running state with
  (`@apackdev/state/vue`), `src/testing.ts` what a pack's checks are written with (`@apackdev/state/testing`), over the schedule of
  `@apackdev/orderings`, a package of its own that apack-link's specs are run under too, `src/window-frame.ts` what a frame is in a window. What a module exports that the
  doors do not is marked `@internal`: the package's own, which checks may reach and nothing else should.
- `docs/errors.md` is what each compile error the type tests hold means, generated from them (`errors:update`) and
  held to the compiler (`errors:check`). A type test met by a name that is not there, and not by its mistake, fails
  the check.
- `type-tests/` is what must not compile, and some of what must: each `@ts-expect-error` is a case, and one whose
  line compiles fails `npm run typecheck` as an unused directive. `vue-templates/` is the same in a component's
  template, for `vue-tsc`. `npm run typecheck:floor` runs it all on TypeScript 5.7, the oldest held to.
- `checks/` is every check, each file a vitest spec: `checks.mts` is what they are written with, `examples-check.mts`
  runs the examples, `store.mts` and
  `store-elmdb.mts` the rows a step writes, in memory and on elmdb.
- `examples/`, `measure/`, `surveys/` and `tools/` are as `docs/files.md` says.
- `docs/design.md` is the design with no history; `docs/plan.md` the record, with what is not built and the order
  of work; `docs/deferred/` what is left out of it on purpose, and why. What moving apack onto it changes in apack's
  tree is apack's own plan, not this one.

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
npm run lint
npm run typecheck
npm run typecheck:floor
npm run api:check
npm test
npm run build
```

`npm run lint` is oxlint over everything here, warnings refused; `.oxlintrc.json` turns off the rules whose findings
are deliberate, each where it is. `npm run package:lint` packs the package and runs publint and attw over the
tarball.

`etc/graphs/<example>.txt` is each example's graph, read from its types by `tools/graph.mts` without running it:
its states, the moves its handlers can make, what it answers, starts, follows, loads and calls, who it reaches,
and what looks wrong. `npm run graph:check` holds them to the source, and `npm run graph:update` writes them.

`etc/*.api.md` is what each entry offers, as API Extractor reads it from the source. A change to what the package
offers fails `api:check` until `npm run api:update` has written it, so it shows in the diff. A type a public
signature uses and no entry exports is listed there as a forgotten export.

`npm run pre-push` runs lint, the typecheck, the API reports, the specs, and Stryker over the files under `src/` the
branch changed since it left `master` (`--no-mutants` leaves that out, `--dry` says what it would run). `npm run
hooks:install` has git run it before each push; it is opt-in, and nothing installs it otherwise.

A mutant that survives is killed by a spec or listed in `mutants.allowed.json` with why, and the mutants workflow
fails on one that is neither, and on an entry that no longer survives. `npm run mutants:list -- <run id>` writes the
list from that run: stale entries off, new survivors on with an empty why, which the check refuses until it is
written. `npm run mutants:merge-install` has git merge the list entry by entry in this checkout, where two branches
that each change it otherwise conflict as text.

`npm run test:browser` runs the same checks in Chromium (vitest's browser mode, Playwright), all but those that need
Node itself: elmdb's binding and the examples run as processes. `src/turn.ts` is how the kernel, and every check,
waits a turn in either.

`npm test` runs every check with vitest: each `checks/*-check.mts` is a spec, run without being listed, and each
check in it a case with its own name (`checks/checks.mts` makes them). No case is given a time to finish in.
`npm run bench` runs the measurements in `measure/`, each as its own process, and prints each reading beside the one
recorded in `bench/<measurement>.json` with the conditions it was read under; `npm run bench:record` writes them.
Neither refuses anything: a reading moves with the machine. A check that starts a process stops it and waits for it to exit.

Each `master` commit whose CI passed is packed and published as the prerelease `pkg-<commit>`
(`.github/workflows/packages.yml`), which apack installs by URL and pins by commit. Nothing publishes to npm, and
`npm run workflows:check` fails a workflow or script that could. `npm run package:smoke` installs the packed
package into a project of its own and imports each entry, as CI does on every push.

The packages this repository takes from its siblings (`elmdb`, `apack-link`, and `apack-orderings`) are installed from the
tarballs each sibling's CI attaches to a release of a commit, named by URL in `package.json`. `scripts/deps.mjs`
holds the table of them and writes the URLs: `npm run deps:pin -- elmdb <commit>` moves to another release,
`npm run deps:local -- elmdb` points at a built checkout beside this one (never committed), and
`npm run deps:released` undoes that. No URL is edited by hand; `npm run deps:check`, which CI runs, fails one that
is not as `deps:pin` writes it.
