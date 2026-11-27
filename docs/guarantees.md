# Guarantees and boundaries

What `@apackdev/state` guarantees, where each guarantee ends, and what it assumes of the host around it. For the API and
an example, see [design.md](design.md).

## Four lifetimes

The kernel tracks four distinct lifetimes. They nest, but they are **not** interchangeable:

| Lifetime | Begins | Ends | What is atomic or cancelled |
|---|---|---|---|
| **System** | `system(...)` | `stop()` / `[Symbol.dispose]()` or a lost transaction | Stops all running states, cancels all work and asks, detaches ports |
| **State** | Root `start()` or parent `starts` / transition `at` | Parent removes it, state moves away, top-level `stop(handle)`, or system stops | Cancels owned `listen`, `run()`, `starts`, `follows`, `loads`, `calls`, `arms`, and runs `onExit` releases (LIFO) |
| **Work** (`run` or `answers` handler) | Handler is invoked | Handler returns or throws, state leaves, asker leaves, or system stops | Cancels any kernel `ask()`, `sleep()` or `outside()` it started; closes its scope so later `raise`/`tell`/`progress` calls are ignored |
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
- **A stale delivery takes no step.** A view's update, how a load or a call ended, a batch of its progress, and a
  timer's expiry each belong to one thing a state holds: the view it follows, the ask it awaits or has pending, the
  timer it armed. One is stale when, as its turn comes, the state no longer holds that thing: it left, stopped
  following or awaiting it, cancelled or disarmed it, or began it again, so that what is held under the name is
  another. A stale delivery is dropped before a step opens: no handler runs, no `StepLog` is written, the step numbers
  have no gap for it, and it does not count against `limit`. That holds whether it went stale before it arrived or
  while it waited behind the step that made it so. An answer that crosses a link to an ask already given up is not one
  of these: it is taken in a step, logged as `answer`, and reaches nobody.
- **An `args` that throws changes nothing that is live, and is asked once.** Where the `args` of a `follows` or
  `loads` entry throws, a `Defect` is reported (`could not say what to ask … for`) and what that entry had live goes on
  as it was: a view followed is not stopped and is still heard, a read under way is not given up and how it ends is
  heard, and where nothing was live nothing is asked. The values it threw for are what it has then seen. `args` is not
  called for them again, so one defect is reported and not one at each later look: one of many is not asked again
  because another key came or went, or because what any of them delivered was written into the field their keys come
  from, and a single one is not asked again because some other field changed. It is asked again when a field it names
  changes, when its key goes and comes back, or when its state is left and entered again.
- **Windows vs. named peers.** Broadcasts and answers to windows wait for any affected views' `caughtUp()` hold (when wired
  through `@apackdev/link` or a `ViewHost`) so a window never sees a message ahead of the rows it reflects. Named peer tells
  (`tell({ peer }, event)`) are delivered after commit with no view hold.

## Cancellation and `onExit`

- **`scope.signal` vs. work completion.** `scope.signal` aborts on *cancellation* only (the state was left, the asker left,
  or the system stopped). It does **not** abort on normal completion of `run()` or an ask handler.
- **Kernel-owned `ask()` / `sleep()`.** Any `ask()` or `sleep()` started from `run()` or an ask handler is bound to the
  work lifetime: when `run()` returns or throws (for example, when one branch of `Promise.race()` wins), unfinished losing
  `ask()` / `sleep()` calls reject with `Cancelled`.
- **`outside(work)`.** A promise the kernel did not make, waited for through the scope, is bound to the work lifetime
  as `ask()` and `sleep()` are: it rejects with `Cancelled` when the state is left, the asker goes, or the work
  finishes, and gives what the promise ends with otherwise. The promise itself is not stopped, and what it ends with
  after its owner has gone is taken and dropped: a late failure is traced, as work that fails after its state was
  left is, and is not an unhandled rejection. A failure that arrives while the owner is there is thrown where it is
  awaited; one that nothing has waited for by the time its work ends is traced then, and is not an unhandled
  rejection either.
- **Outside work that has ended is given on a later turn.** A promise's ending is heard in a microtask, with whatever
  else was queued in that turn still to run, and any of it may leave the state. So `outside()` does not end its wait
  there: it ends it on the system's next turn, by itself, when the only thing queued behind it is its work going on.
  A state left in between is `Cancelled` where it waited, and its work does not go on. The cost is one turn for each
  wait. It holds where the host's `later` is a later turn, as the default and a schedule are: one that runs what it is
  given in a microtask puts the ending back among whatever else is queued.
- **An `ask()` that has been answered is not taken back.** An answer is given as the step that carries it commits,
  and that step may run in a microtask, when what it waited on was a promise. A state left after its ask was answered
  and before its work went on (a leaving sent from a promise callback in that same turn) lets the work run to its next
  wait, where it is `Cancelled`. Until then what it says through its scope does nothing and what it returns is
  dropped, and what it does outside the kernel happens. An answer is not put off a turn as outside work is: an ask
  taken back with its step ends as taken back and not as `Cancelled`, which a later turn would lose, and every ask
  would be one more thing for a schedule to order. A `sleep()` ends on the clock's own turn, with nothing queued
  behind it.
- **Detached external promises.** JavaScript cannot forcibly cancel arbitrary non-kernel promises. If a losing branch of
  `Promise.race()` settles *after* `run()` has already returned, the work scope is closed: `raise`, `tell`, `progress`, and
  `onExit` calls from that closed scope are ignored, and cooperative code should check `scope.signal.aborted`.
- **Late `onExit()` while work is still in flight.** If the state is left *while* async `run()` is still running (before
  `run()` returns), any subsequent `onExit(release)` registered before `run()` exits executes `release()` immediately under
  exception isolation so acquired resources are not leaked.
- **`listen` vs. `run()`.** `listen` runs synchronously on entry (before `run()`) with a state-lifetime `EventScope` (no
  `ask` or `sleep`) and does not block `sys.idle()`. If it returns a cleanup function, that function is registered with
  `onExit` and runs LIFO on exit (returning a non-function non-`undefined` value reports a `Defect`). Any late callback
  firing after the state exits ignores `raise`, `tell`, `broadcast`, `call`, `cancel`, `arm`, `disarm`, and `report`, while a late
  `onExit(release)` runs `release()` immediately under exception isolation so resources never leak (consistent with
  `run()`). Throwing synchronously inside `listen` rolls back its writes, sayings (`unsay`), and any `onExit` releases it
  registered before throwing, skips `run()`, and routes the failure to `failed` (or reports a `Defect` if `failed` is
  absent, matching synchronous `run()`).
- **Imperative calls (`calls`) and timers (`arms`).** Each projects into one flat namespace per machine (`pending` and
  `armed`). Because an active child and its enclosing ancestors run simultaneously and share one snapshot map, a
  nested state may not redeclare a call or timer name already declared by an enclosing state; sibling states may
  share a name provided their kinds match, while conflicting kinds (`single` vs `each` vs `many`) across states of one
  machine are refused at compile time and on `start()`. `arm` and `disarm` enqueue onto the step's internal queue so
  they obey exact FIFO ordering within a step (`disarm; arm`, `arm; disarm`) and roll back whole under `unsay` if the
  handler throws or returns a refused edit. Armed timers belong to the active state instance that declared them
  (disarming automatically when that state exits, self-re-enters, or the system stops; to arm a timer on entry or
  self-transition, call `arm` from that state's `listen` or `run`), never block `sys.idle()`, and never deliver or log
  stale expirations after disarm, re-arm, or exit. An `each` key must be a string — calling or arming an `each` entry
  with `undefined`, a number, or any other non-string reports a structured `Defect` without starting the call or timer,
  because `pending` and `armed` are plain objects where `5` and `'5'` would coerce to one entry `'5'` while
  `scope.key` is typed `string` (and `undefined` would omit `'/'` and overwrite `{}` with `true`). Arming with a
  non-finite or negative `ms`, or without a `clock` on the system, likewise reports a structured `Defect`. A timer
  declared with anything but an options object where its options go (a bare number, a function, `null`, an array),
  or with a `whenArmed` that is neither `'restart'` nor `'ignore'`, is refused on `start()`, saying what it was given;
  no options at all, `undefined`, and an object of them are taken as they are; a throwing
  `expired` handler reports a `Defect` and rolls back its own sayings while still clearing the expired timer from
  `armed`.

- **What starts first.** A state named by `initial` is entered with nothing given, so a field of its data that is
  `given` is refused, by its name, where the definition is written, and the state does not start (`cannot start at
  <state> without <field>`). A state whose data all has values of its own may be entered first. What the compiler
  cannot tell is left to `start()`: a field written as a value typed `any`, or as one that may be `given` or a value
  (`cond ? '' : given`), compiles, and the state is refused where it starts if the field turns out to be given. An
  `initial` itself typed `any` names every state at once to the compiler, so a `given` field in any of them is
  refused where the definition is written.

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
| `clock.now()` / `clock.after()` | `after` throw rejects `sleep()` or reports a `Defect` for `arms` (preserving any prior armed timer on re-arm); `cancel` isolated (`safely`); `now` during `stop()` falls back to last timestamp | A healthy clock must not throw from `now()` during normal steps; `clock.now()` is assumed monotonic and clamped if it moves backward |

## Cycle and deadlock boundaries

- **Detected by the kernel:**
  - **Synchronous tell loops (`RUNAWAY`)** and **reactive `follows`/`loads` data cycles**.
  - **Local in-system ask depth cap (`MAX_ASK_DEPTH = 64`):** Each answering handler carries its local `(ref, askName)`
    call chain. Because `answers` handlers are concurrent and reentrant, finite recursion on the same `(ref, askName)`
    with different `args` (depth `< 64`) completes cleanly with no defect. Once a local call chain reaches 64 nested asks,
    the next local `ask()` immediately resolves to `{ ok: false, failure: { kind: 'failed', message } }` and reports a
    structured `Defect` — extracting and formatting the repeating cycle slice (`Ask cycle (depth 64): a PING -> b PONG -> a PING`)
    when the target repeats in the chain, or the trailing frames (`Ask depth exceeded (64): ...`) for a non-repeating chain.
    Concurrent independent asks and cross-link asks are unaffected.
- **Not detected by the kernel:**
  - **Cross-link or external deadlocks:** Call chains are local to one system (they do not cross `@apackdev/link` ports),
    and the kernel cannot inspect deadlocks inside arbitrary external non-kernel promises or locks.
- **Durability outside `transact`.** State snapshots live in memory; durability comes from the database rows written inside
  `transact` and the transport contract (`@apackdev/link`).
