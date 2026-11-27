# Kept-state restoration, event postponement, and timer-only states

Status: deferred, 2026-11-25. Not designed. This records three patterns reviewed from XState v6, Erlang's
`gen_statem`, and adjacent state-machine libraries: what each is, why it is not built yet, what it would take, and
what would make it worth starting. They are left out of [the plan](../plan.md) on purpose, beside
[durable-outbox.md](durable-outbox.md) and [wall-deadlines.md](wall-deadlines.md).

---

## 1. Kept-state restoration and boundary validation

### What it is

When a state outlives its process ([the plan](../plan.md), *A state that is kept*), bringing it back from storage is
different from starting it fresh:

- **Separate `restore(...)` from `start(...)`** (as XState v6's `xstate/persist` separates `restoreActor` from
  `createActor`). Fresh startup initializes defaults, enters `initial` substates, and launches `run()`; restoration
  rehydrates `{ at, data }` from a committed snapshot, re-attaches standing reads (`starts`, `follows`, `loads`),
  does **not** re-run one-shot writes (`calls`) or unasked `run()` work, and invokes a declared `restored` handler
  so the state decides what happens next.
- **Structural Standard Schema boundary validation.** Accept an optional structural `StandardSchemaV1`-shaped
  validator (`~standard.validate`) at persistence and untrusted wire boundaries so packs can plug in Zod, Valibot,
  or ArkType without `@apackdev/state` taking any runtime dependency — the same zero-dep pattern already used for
  `Clock` and `Transact`.

### Why not yet

- No state is persisted yet. Surfaces and current backend states rebuild from rows and what they are given; the brain
  slice is ported first with runs that end with the process.
- Designing a persistence contract before the first kept state (a resumable brain flow) risks inventing migration and
  child-rehydration rules for hypothetical shapes.

### What it would take

- Decide persistence scope alongside [durable-outbox.md](durable-outbox.md) and
  [wall-deadlines.md](wall-deadlines.md):
  - Persist `{ at, data }` in the step's `transact` unit beside the rows it wrote.
  - Define rehydration order across parent/child `starts`, what happens to asks that were in flight before crash, and
    how a state moves forward when its stored `{ at, data }` no longer matches a newer definition.
  - Add a ~15-line structural `StandardSchema` type (zero runtime imports) if runtime validation of persisted
    snapshots or wire payloads is needed at restore time.

### What would make it worth starting

The design of resumable brain flows that survive app quit or crash. Build this together with the durable outbox and
not before.

---

## 2. Event postponement (`postpone`)

### What it is

In Erlang/OTP's `gen_statem`, a handler in a transient state (such as `booting`, `connecting`, or `saving`) can
postpone the current event. The runtime holds postponed events in arrival order and automatically re-delivers them
when the state moves to a different `at`, instead of dropping them or forcing every machine to buffer a `pending`
list in `data`.

### Why not yet

- No ported feature in `apack` currently needs automatic postponement; transient states either accept the event
  directly, queue via explicit data (where the UI also wants to render what is queued), or refuse it.
- Postponement adds non-obvious invariants to the kernel:
  - What `sys.idle()` reports while events are postponed.
  - Whether postponed events live in `StepLog`, survive a kept-state restart, or have a queue bound to avoid
    unbounded memory growth if a state never leaves.
  - Whether postponing an `ask` is allowed (which holds a caller's promise open across state transitions).

### What it would take

- A per-`Running` FIFO postpone queue cleared on `end()`, re-enqueued into `inside` when `at` changes in `go()`.
- Clear rules for `StepLog` visibility, `answers` (likely event-only, not asks), and runaway/queue limits.

### What would make it worth starting

Two or three real `apack` ports hand-rolling the exact same `pending: Event[]` buffer-and-replay pattern across
transient states purely to work around event arrival ordering (where the UI does not need to display the buffer).

---

## 3. Timer-only states without `failed` boilerplate

### What it is

Delayed transitions today are written with `scope.sleep(ms)` inside `run`:

```ts
waiting: {
  run: async ({ sleep }) => { await sleep(5_000); return { at: 'timedOut' } },
  failed: () => ({ at: 'timedOut' }),
}
```

Because `run` is `async`, the type system requires a `failed` handler even though `sleep()` can only reject with
`Cancelled` (which cancels without calling `failed`). In addition, [tools/graph.mts](../../tools/graph.mts) sees arbitrary
async work rather than a declared timeout edge (as XState's `after` or `gen_statem`'s `state_timeout` exposes).

### Why not yet

- `scope.sleep(ms)` already handles monotonic delays cleanly, auto-cancels on state leave and system stop, works with
  the structural `Clock` and `@apackdev/orderings`, and requires zero new concepts in the state definition grammar.
- Very few states are pure timers with no other async work; adding a new top-level key (`after` / `timeout`) would
  widen `Def` and the kernel for a handful of call sites.

### What it would take

Either:
- A small declarative timeout clause on a state (compiled into `clock.after` on enter and cancelled on exit, visible
  to `tools/graph.mts`, with no `failed` required), or
- Keeping `sleep()` in `run` as the single mechanism if pure timer states stay rare.

### What would make it worth starting

Porting retry/backoff flows or brain step timeouts where pure timer states proliferate enough that dummy `failed`
handlers become recurring noise or graph visibility of timeout edges matters.

---

## 4. Graph-level static checks and `fromEvents` state coverage

### What it is

- **Static graph invariants in [tools/graph.mts](../../tools/graph.mts):** report unreachable states and cross-system
  ask cycles ([the plan](../plan.md), *A check for a cycle of asks*).
- **State-coverage reporting in `fromEvents`:** surface visited vs. unvisited `at` paths across random runs so deep
  or guarded branches are not silently skipped.

### Why not yet

- Neither blocks porting features onto the kernel, and the real ported systems will show which graph anomalies and
  coverage gaps actually occur in practice rather than on synthetic examples.

### What would make it worth starting

Multiple ported backend systems and surfaces running together, where cross-system ask graphs and deeper state trees
make static cycle checks and fuzz coverage visibility pay off immediately.

---

## Reviewed and declined (not deferred)

Recorded here so they are not re-proposed without new evidence:

- **Typed `trigger` proxy (`actor.trigger.EVENT()` from XState v6 / `@xstate/store`):** Poor fit for dotted event
  names used across `apack` (e.g. `'commit.STAGE_FILE'`).
- **Parallel regions and history states (XState v6 / SCXML):** Already declined in [the plan](../plan.md); separate
  states plus atomic steps handle concurrency without region-interaction complexity.
- **`always` eventless transitions and `final`/`output` (XState v6):** Plain JS handlers compute targets directly;
  standing reactions belong in `starts`/`follows`/`loads`; child completion already uses `report(event)`.
- **Mutable non-reactive `refs` and `watch`/`track` (Zag.js v1):** Mutable `refs` break frozen-value/rollback
  guarantees (`run()` closures + `onExit(release)` hold handles instead); declarative `from`/`each` replace `watch`.
- **`reenter: true` (XState v6):** Unnecessary because `{ data }` updates in place while `{ at }` always enters the
  target state afresh.
- **Standalone `peersFor<Net>()` curried helper (PR #63):** Declined to avoid `xxxFor<Net>()` export sprawl;
  replaced by optionally generic `system<N extends Net = Net>(host)` (PR #70), which types `sys.attach(name, peer)`
  directly with zero new runtime exports.
- **Runtime `(ref, askName)` membership banning for ask cycles (PR #64):** Declined because `answers` handlers are
  concurrent and reentrant rather than per-`(ref, askName)` mutexes; `chain.includes(edge)` falsely rejects finite
  recursive asks on different `args`. Replaced by `MAX_ASK_DEPTH = 64` with repeating cycle-slice reporting (PR #71),
  matching `RUNAWAY` and Erlang/Orleans/gRPC precedent.
