# An outbox kept on disk

Status: deferred, 2026-11-23. Not designed. This records what it is, why it is not worth having yet, what makes
it worth having, and what it would take. It is left out of [the plan](../plan.md) on purpose.

## What it is

Nothing a step says leaves before its rows are kept: an answer, a broadcast, progress and word to a peer are held
and released after the unit commits ([the plan](../plan.md), Rows). What holds them is in memory. A process that
ends after the commit and before they leave has kept the rows and lost what was to be said.

An outbox kept on disk closes that. What a step says is written as rows in the step's own unit, a sender reads
them after the commit and removes each once it is delivered, and a process that starts again sends what is still
there. It is the transactional outbox as a service that outlives its messages uses it.

## Why not yet

As the app stands, after a restart there is nobody to send to.

- **A state is not saved.** It is rebuilt from rows and what it is given, so what was to be said was meant for a
  state or an ask that no longer exists.
- **A window is put right by its views.** A view is read from rows, so a window that connects again is shown what
  was kept whether or not it was told. An ask that was in the air is told it failed although its change was made,
  and the view shows that it was. No outbox changes that: an answer cannot be handed to an ask that is gone.
- **The run history loses nothing it would have kept.** A run does not outlive the process, and what a crash
  leaves `active` is marked `stopped` as the app starts.

## What makes it worth having

**A flow that goes on after the app starts again**, which is expected. A run that survives a quit or a crash is a
receiver that outlives the process, and each of the three reasons above stops holding for it:

- The run is rebuilt and carries on, so what its last step said has somewhere to go: the step it started, the
  flow it told, the event it raised.
- The run history has to hold every step of a run that is still going. A step whose rows were kept and whose
  entry was lost leaves a log that disagrees with the run it is the record of.
- A step whose rows say "done" and whose word to the next step was lost is a run that stops for no reason
  anybody can see.

Without an outbox, a resumed run would have to work out from rows alone what it had said and not said, in each
step type, which is the same record kept by hand.

## What it would take

Not designed. What is known:

- **What a step says, written in its unit.** Which sends are written is the first question: those to a peer and
  to a run, and not those to a window, which its views cover.
- **A sender that removes what was delivered**, and a rule for what was delivered and not yet removed when the
  process ended. That is delivery at least once.
- **Receivers that can take the same thing twice**: an entry in the run history by the id the brain stamped on
  it, a step by a key.
- **A state that is kept.** A run that resumes is brought back where it was, with its data: a state kept in the
  step's unit, beside the rows the step wrote ([the plan](../plan.md), Not built). What the step said is kept in
  the same unit, which is this outbox. The kept state is the larger design, and the outbox is one part of it.
- **A write in every step that says something that is kept**, measured against the steps a flow takes.

## What it does not decide

Whether a handler that is not made has said anything is a separate question, about one unit in a running
process, and is in the plan under Not built. An outbox settles it one way: were what a handler says kept as rows
in its unit, undoing the handler would undo them.

## What would make it worth starting

The design of flows that resume. The outbox is built with it and not before: until a run can outlive its
process, nothing reads what it would keep.
