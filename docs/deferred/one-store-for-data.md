# One store for either kind of data

Status: deferred, 2026-11-23. Not designed. This records what it is, why it is worth having, what it would take,
and what would make it worth starting. It is left out of [the plan](../plan.md) on purpose.

A state's `data` could be kept in memory or in the database behind one interface, so that a backend state's data
were rows and a window followed them by view. It is worth having for exactly that, a backend state with data
several windows show. It is not a way to make everything a row: a window has no database, a row is typed by a
pack's manifest where data is typed by the state, and a write a second is what a draft of text costs in memory and
far more in a log. A step is now a transaction, which is what it needed first; nothing in the plan needs it.

## What would make it worth starting

A backend state whose data several windows show, written today as data and a view of rows kept beside it, in more
than one feature once the app runs on the kernel. Until then a view of rows is the way to show a backend's data.
