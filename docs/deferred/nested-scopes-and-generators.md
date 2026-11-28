# Nested work scopes and generator-based work

Status: deferred, 2026-11-27. Surveyed, not designed. This records what they are, what apack's work looks like today,
why neither is built, the one smaller thing the survey supported and that is built, and what would make either worth starting. It is
left out of [the plan](../plan.md) on purpose.

## What they are

Two ways to give the kernel more say over a state's `run` and an ask's handler:

- **A nested scope**: a part of some work that can be ended while the work goes on, with `all`, `race` and `timeout`
  built on it. The loser of a race, or what ran past a deadline, has its asks and sleeps cancelled at once and not
  when the whole work ends.
- **Generator-based work**: `run` written as a generator, `yield*` where it now says `await`. The kernel resumes the
  body, so a body whose state was left is never resumed, and is ended with `return()`, which runs `finally` and no
  `catch`.

## What work does today when its owner goes

Work has two signals ([`enter`](../src/kernel.ts), [`workScopeOf`](../src/kernel.ts)): the state's, which aborts when
the state is left, and the work's own, which also aborts when `run` returns or throws.

| What the body does after its state was left | What happens |
|---|---|
| Awaits `ask`, `sleep` or `outside` | Throws `Cancelled` there. `finally` runs, and the kernel discards it at the top of `run` |
| Calls `raise`, `tell`, `broadcast`, `call`, `cancel`, `arm`, `disarm`, `report` | Nothing: each checks that its owner is alive |
| Calls `onExit(release)` | Runs `release` at once |
| Returns `{ at, data }` | Dropped: a result arrives only while the state is still the case |
| Throws | Traced as failed after it was left. `failed` is not called |
| Writes rows | Refused: a write outside a step is refused |
| Awaits a promise the kernel did not make, bare | **Resumes when it settles, and runs on** |
| Does something outside the kernel: a toast, a file, a module-level variable | **Happens** |

`checks/leaving-check.mts`, `checks/clock-check.mts` and `checks/outside-check.mts` hold the first six rows. The last
two are the whole of what the kernel does not own: a body that awaits outside work bare is resumed after its state
was left, and until its next wait through its scope, or its return, it runs as if it had not been.

## What apack's work looks like

apack at `afc19f0f52`, 48 files that import the kernel. Every state with an `async run`, 16 of them:

| What the body is | How many | Where |
|---|---|---|
| A `sleep` and then one `report` or move | 7 | The shell's `connecting`, the commit refresh's `waiting`, brain's pulse, the terminal's two bell timers, threads' two flag timers |
| One `ask` and a move on its outcome | 1 | Library's `edit.fetching` |
| A microtask and then one `report` | 1 | Threads' chat follow-up |
| Outside work, with nothing guarded | 3 | Settings' reset, the commit refresh's `checking`, the terminal's `initializing` |
| Outside work, guarded by hand | 4 | The shell's entity opening, `unreachable` and pack frontends; brain's step |

And across all 48 files, in `run` and in handlers alike:

| Looked for | Found |
|---|---|
| `Promise.race` over anything | 0 |
| `Promise.all` over `ask` or `sleep` | 0 |
| A deadline put on a part of some work | 0 |
| An `AbortController` made inside work to end a part of it | 0 |
| An `ask` from `run` | 1, the one above |
| `signal.aborted` read in a state's work, an ask's handler, or a helper one of them calls | 20, in 6 files |
| A helper that waits for an outside promise or the signal, whichever is first | 2: the terminal's `awaitRestore` (18 lines, 8 callers) and the promise brain's step builds around a callback |

Three things follow.

**Nothing in apack would use a nested scope.** There is no race, no deadline on a part, and no group of managed asks
in any work. Work in apack is almost never a composition of asks: reads became `loads`, writes became `calls`, and
what is left in `run` is outside work.

**Nine of the sixteen are not work.** Seven are a timer, which `arms` declares in one line with no state of its own;
one is a read, which `loads` declares; one is a `raise`. They are written as `run` because apack is pinned to a
kernel from before `arms`. Moving the pin removes them, and with them every `sleep` apack calls.

**The guards are one pattern.** At that pin, before `outside`, the `signal.aborted` reads follow a wait on outside work, which is the row the kernel
does not own. More than half are before a `report`, a `raise` or a `return`, where the table above says the kernel
already does nothing, so they can be deleted today. The rest keep an outside effect from happening (a toast in entity
opening, an error page in `unreachable`) or keep the body from starting more outside work (the next pack's frontend).

## Why not a nested scope

No call site. `all`, `race` and `timeout` would be three exports and a tree of signals inside the kernel, checked
under every ordering, for code apack does not contain. [CLAUDE.md](../CLAUDE.md) asks for the call sites first, and
there are none to name.

Where two asks must both be made, `loads` and `calls` make them, each cancelled alone. Where one is given up on after
a while, `arms` declares the timer and its `expired` handler says what happens, in a step and in the log.

## Why not generators

What a generator gives that `async` cannot is the last two rows of the first table: the body is not resumed, even
where it awaits a promise bare. That is real, and it is the only thing. Against it:

- **It does not remove the wrapping.** A generator has one type for what every `yield` evaluates to, so a typed result
  needs `yield*` over a helper at each wait: `const packs = yield* outside(client.loadedPacks())`. Each outside
  promise is wrapped either way.
- **It is a second way to write work.** `run`, every ask's handler, their types, the graph analyser's reading of
  returns, and every check of work would hold for both, or apack's 16 `run` bodies and its roughly 40 `async`
  handlers would all be rewritten.
- **It changes nothing for work that is one outside call**, which is 3 of the 7 that are really work.

The one place a generator is strictly better is `catch`. `Cancelled` thrown at an `await` is caught by a `try` around
it, as pack frontends' loop has; `return()` runs no `catch`. A body that catches it and goes on meets the same
`Cancelled` at its next wait, and every scope call it makes in between does nothing, so the cost is wasted work and
not a wrong effect.

## What the survey supported, and is built

One method on the work scope, `outside` ([the design](../design.md), When to use which).

```ts
// Ends with `Cancelled` where it is awaited when the work's owner goes, as `ask` and `sleep` do.
outside<T>(work: PromiseLike<T>): Promise<Awaited<T>>
```

It makes an outside promise a wait the kernel owns: every row of the first table then holds at every `await` that
goes through the scope. It adds no export, no kind of thing and no state: it is `sleep` with a promise where the
clock was.

The shell's entity opening, as it is at that pin and as it reads with `outside`:

```ts
const exists = await client.entityExists(request.id, signal);
if (signal.aborted) return;
if (!exists) { refuse(request, '…'); … }
```

```ts
const exists = await outside(client.entityExists(request.id, signal));
if (!exists) { refuse(request, '…'); … }
```

| Site | Today | With `outside` |
|---|---|---|
| Entity opening, `unreachable` | One guard each, before an effect the kernel cannot stop | No guard. The effect cannot happen for a state left before the work ended |
| Pack frontends | Seven guards in one body | None. A pack's frontend is not loaded for a state that was left |
| The terminal's `awaitRestore` | An 18-line helper with its own listener, throwing its own `Error('Cancelled')` | `await outside(restore.ready)` at its 8 callers |
| Brain's step | A promise built around a callback, settled by the signal, 6 guards | Unchanged: what it waits on is a callback, not a promise |

What it does not do: it does not stop the outside work, which still needs the signal handed to it, and it does not
undo what that work already did. A state left after the work ended and before the body resumed is covered: what the
work ends with is given on a later turn, with nothing queued ahead of the body going on
([guarantees](../guarantees.md)).

## What would make them worth starting

- **A nested scope**: three places in apack's work that race managed asks, or put a deadline on a part of some work
  that then goes on, and that `arms` with an `expired` handler states worse.
- **Generators**: a defect in apack traced to a body that caught `Cancelled` and went on to an outside effect, or
  work that must be replayed step by step, which needs the kernel to own every resumption
  ([durable outbox](durable-outbox.md)).

## Open

- Whether the graph check should say where work awaits something that did not come from its scope. It reads `run`
  already, and it would make the one row the kernel does not own a finding.
