# A step in Vue's devtools

Status: deferred, 2026-11-23. Not designed. This records what it is, why it is worth having, what it would take,
and what would make it worth starting. It is left out of [the plan](../plan.md) on purpose.

## What it is

Pinia shows its stores in Vue's devtools, with what changed them and when. A state could be shown the same way: each
running state's `{ at, data }`, and a timeline of steps, each with what began it, what it handled, which fields of
which state changed, and what left at its commit.

## What it would take

The record is there. A system given `log` is told of each step as it ends (`StepLog`: what it handled, what changed,
what left, how it ended, never a payload), and `snapshot()` reads every running state. What is left is a devtools
plugin that subscribes to both through `vueBinding`'s `provide` and draws them: Vue's devtools plugin API, its
timeline layer for steps, and its inspector for states.

## What would make it worth starting

The components people will inspect. It is worth doing against the app's own surfaces once they run on the kernel,
and not before: what a devtools view shows is only as useful as what the person reading it is looking for.
