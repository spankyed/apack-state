# An outbox kept on disk

Status: won't do, 2026-11-23. This records what it is, why the kernel does not have it, and what would have to
become true for that to be looked at again. It is left out of [the plan](../plan.md) on purpose.

## What it is

Nothing a step says leaves before its rows are kept: an answer, a broadcast, progress and word to a peer are held
and released after the unit commits ([the plan](../plan.md), Rows). What holds them is in memory. A process that
ends after the commit and before they leave has kept the rows and lost what was to be said.

An outbox kept on disk closes that. What a step says is written as rows in the step's own unit, a sender reads
them after the commit and removes each once it is delivered, and a process that starts again sends what is still
there. It is the transactional outbox as a service that outlives its messages uses it.

## Why the kernel does not have it

- **After a restart there is nobody to send to.** A state is not saved; it is rebuilt from rows and what it is
  given, and a window that lost its backend starts again with a new session. What was to be said was meant for a
  state, an ask or a window that no longer exists.
- **A window is put right by its views.** A view is read from rows, so a window that connects again is shown
  what was kept whether or not it was told. An ask that was in the air is told it failed although its change was
  made, and the view shows that it was. No outbox changes that: an answer cannot be handed to an ask that is gone.
- **The run history loses nothing it would have kept.** A run does not outlive the process, and what a crash
  leaves `active` is marked `stopped` as the app starts.
- **What a crash can leave wrong is outside the machine**, and an outbox does not reach it. A commit made in git,
  a file written or a model called is done or not done whatever was queued. That is covered by doing the outside
  thing first and recording it as something a later look can find again, and by a step that says `durable: true`
  where an answer must not outlive its row.
- **It costs a write in every step that says anything**, a sender, a rule for what was delivered and not yet
  removed, and receivers that can take the same thing twice. Each of those is a new place to be wrong.

## What it does not decide

Whether a handler that is not made has said anything is a separate question, about one unit in a running
process, and is in the plan under Not built. The two agree: were what a handler says kept as rows in its unit,
undoing the handler would undo them.

## What would change this

- **A receiver that outlives the process and keeps what it is told**, and must not miss a step: another service,
  or a peer whose log has to be complete across a crash. The run history is not one while a run ends with its
  process.
- **A state that is saved and resumed**, which the plan does not want.
