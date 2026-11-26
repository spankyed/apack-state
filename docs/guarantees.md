# Guarantees and boundaries

What `@apackdev/state` guarantees, where each guarantee ends, and what it assumes of the host around it. For the API and
an example, see [design.md](design.md).

## Four lifetimes

The kernel tracks four distinct lifetimes. They nest, but they are **not** interchangeable:

| Lifetime | Begins | Ends | What is atomic or cancelled |
|---|---|---|---|
| **System** | `system(...)` | `stop()` / `[Symbol.dispose]()` or a lost transaction | Stops all running states, cancels all work and asks, detaches ports |
| **State** | Root `start()` or parent `starts` / transition `at` | Parent removes it, state moves away, top-level `stop(handle)`, or system stops | Cancels owned `listen`, `run()`, `starts`, `follows`, `loads`, `calls`, and runs `onExit` releases (LIFO) |
| **Work** (`run` or `answers` handler) | Handler is invoked | Handler returns or throws, state leaves, asker leaves, or system stops | Cancels any kernel `ask()` or `sleep()` it started; closes its scope so later `send`/`tell`/`progress` calls are ignored |
| **Transactional step** | One outside arrival (`send`, `ask`, view update, work result) | `transact` returns and `flush()` runs | Data updates, database rows written via `transact`, and managed outgoing sends (`tell`, `broadcast`, `ask`, `answer`, `peer`) commit or roll back together |

**A multi-step async `run()` is not one transaction.** Each synchronous phase (entering the state, handling an event,
applying `run()`'s return value or `failed()`) is its own transactional step. Cancelling a `run()` mid-flight stops future
kernel work; it does not roll back database rows committed by earlier steps or undo external side effects (files, git,
network) that already ran.

## Atomicity and delivery

- **One step, whole or none.** Inside a step, a handler that throws or returns a refused data/transition update rolls back
  its own data edits, savepointed database rows, and everything it said (`unsay`), leaving the rest of the system intact.
- **Database commit failure.** If the outer `transact` throws at commit, committed snapshots are untouched, nothing leaves
  to windows or peers, outstanding asks are settled as failed, the step is logged with `status: 'lost'`, and the system stops.
- **Commit-time ordering.** Nothing leaves until the step commits. Commit flush runs with reentrancy deferred (`flushing`):
  if a subscriber or named peer synchronously calls `send()` or `ask()`, that call queues behind the current flush and runs
  as a separate subsequent step.
- **Windows vs. named peers.** Broadcasts and answers to windows wait for any affected views' `caughtUp()` hold (when wired
  through `@apackdev/link` or a `ViewHost`) so a window never sees a message ahead of the rows it reflects. Named peer tells
  (`tell({ peer }, event)`) are delivered after commit with no view hold.

## Cancellation and `onExit`

- **`scope.signal` vs. work completion.** `scope.signal` aborts on *cancellation* only (the state was left, the asker left,
  or the system stopped). It does **not** abort on normal completion of `run()` or an ask handler.
- **Kernel-owned `ask()` / `sleep()`.** Any `ask()` or `sleep()` started from `run()` or an ask handler is bound to the
  work lifetime: when `run()` returns or throws (for example, when one branch of `Promise.race()` wins), unfinished losing
  `ask()` / `sleep()` calls reject with `Cancelled`.
- **Detached external promises.** JavaScript cannot forcibly cancel arbitrary non-kernel promises. If a losing branch of
  `Promise.race()` settles *after* `run()` has already returned, the work scope is closed: `send`, `tell`, `progress`, and
  `onExit` calls from that closed scope are ignored, and cooperative code should check `scope.signal.aborted`.
- **Late `onExit()` while work is still in flight.** If the state is left *while* async `run()` is still running (before
  `run()` returns), any subsequent `onExit(release)` registered before `run()` exits executes `release()` immediately under
  exception isolation so acquired resources are not leaked.
- **`listen` vs. `run()`.** `listen` runs synchronously on entry (before `run()`) with a state-lifetime `EventScope` (no
  `ask` or `sleep`) and does not block `sys.idle()`. If it returns a cleanup function, that function is registered with
  `onExit` and runs LIFO on exit (returning a non-function non-`undefined` value reports a `Defect`). Any late callback
  firing after the state exits ignores `send`, `tell`, `broadcast`, `call`, `cancel`, and `report`, while a late
  `onExit(release)` runs `release()` immediately under exception isolation so resources never leak (consistent with
  `run()`). Throwing synchronously inside `listen` rolls back its writes, sayings (`unsay`), and any `onExit` releases it
  registered before throwing, skips `run()`, and routes the failure to `failed` (or reports a `Defect` if `failed` is
  absent, matching synchronous `run()`).

## Handle semantics

A `Handle` (`sys.start(...)`, `sys.child(...)`, or `scope.child(...)`) is a **logical `{ ref }` address**, not an
incarnation token:

- Reading or sending to a handle while no state runs at that ref returns `undefined` / drops safely (or answers `unavailable`
  for asks).
- If a child at `parent/card/a` is stopped and later recreated under the same key `a`, an earlier handle for `parent/card/a`
  addresses the new incarnation. Callers that need to distinguish incarnations should carry a domain/generation id in the
  event or data.
- **Per-ref `stop(handle)`.** Calling `sys.stop(handle)` stops only that top-level state and everything it started, leaving
  sibling top-level states untouched so a ref can be unloaded or hot-reloaded immediately with `sys.start(ref, nextState)`.
  Passing a handle that is not currently running is a safe no-op; passing a child handle started via `starts` is refused
  at compile time, and at runtime throws synchronously (or reports a `Defect` if deferred behind a queued start) without
  disturbing the starter or later queued work. `System` lifecycle methods (`start`, `stop`) are host-level imperatives
  outside handler transaction rollback (not `Scope` operations).

## Name resolution (`forNet(resolve)` / `vueBinding(resolve)`)

`resolve` is a static namespace prefixing hook (e.g., mapping bare own-pack names to `<packId>/<name>`), **not** a
dynamic service locator:

- **Purity and stability.** `resolve` must be pure, deterministic, and return a non-empty string. At runtime the kernel
  memoizes each name's first valid resolution per running state instance for that instance's lifetime, so an unstable
  resolver cannot drift mid-flight.
- **Fault isolation.** If `resolve` throws or returns an empty/non-string value, the kernel reports a structured `Defect`
  and skips the operation without corrupting state, `at.following`, `at.awaiting`, or `at.pending` (and `scope.ask()`
  resolves to a `failed` outcome). In `vueBinding(resolve)`, valid results are memoized per binding instance and
  non-empty-string validation runs inside `useState(name)` so a broken resolver fails fast in Vue `setup()` rather than
  silently rendering `undefined`.

## Trusted-host boundary

Every callback supplied to `system(...)` has a defined failure contract:

| Host callback | Exception-isolated? | If it throws |
|---|---|---|
| `trace(line)` | Yes (`try/catch`, ignored) | Never aborts a step, commit flush, or `onDefect` |
| `onDefect(defect)` | Yes (`try/catch`, ignored) | Never recurses or aborts a step or commit flush |
| `log(step)` | Yes (`safely` → defect) | Reported as a defect; step is already committed |
| `subscribe(...)` listener | Yes (`safely` → defect) | Reported as a defect; remaining subscribers and flush items still run |
| `PeerPort.tell(...)` | Yes (`safely` → defect, `outcome: 'failed'`) | Reported as a defect and logged; remaining peers and flush items still run |
| `ViewHost` start/stop | Yes (`safely` → defect) | Reported as a defect; state continues running |
| `Port.ask` / `Port.tell` | Yes (`safely` → defect / failure outcome) | Ask settles as `failed`; system continues running |
| `forNet(resolve)` | Yes (`try/catch` + non-empty string check → defect) | Reported as a defect before mutating `following`/`awaiting`/`pending`; `ask()` resolves to `failed`; valid results memoized per running state |
| `transact(fn)` | Atomic boundary | Inner throw rolls back one handler; outer commit throw stops the system (`status: 'lost'`) and settles pending asks |
| `clock.now()` / `clock.after()` | `after` throw rejects `sleep()`; `cancel` isolated (`safely`); `now` during `stop()` falls back to last timestamp | A healthy clock must not throw from `now()` during normal steps; `clock.now()` is assumed monotonic and clamped if it moves backward |

## Cycle and deadlock boundaries

- **Detected by the kernel:**
  - **Synchronous tell loops (`RUNAWAY`)** and **reactive `follows`/`loads` data cycles**.
  - **Local in-system ask call-chain cycles:** Each answering handler carries its causal `(ref, askName)` chain. If a local
    `ask()` closes a cycle (`a PING -> b PONG -> a PING`, self-asks, or longer hops), the cycle-closing ask immediately
    resolves to `{ ok: false, failure: { kind: 'failed', message: 'Ask cycle: ...' } }` and reports a structured `Defect`
    instead of hanging. Non-cyclic re-entry to a different ask on the same state (`a OUTER -> b HELP -> a READ`),
    concurrent independent asks, and cross-link asks are unaffected.
- **Not detected by the kernel:**
  - **Cross-link or external deadlocks:** Call chains are local to one system (they do not cross `@apackdev/link` ports),
    and the kernel cannot inspect deadlocks inside arbitrary external non-kernel promises or locks.
- **Durability outside `transact`.** State snapshots live in memory; durability comes from the database rows written inside
  `transact` and the transport contract (`@apackdev/link`).
