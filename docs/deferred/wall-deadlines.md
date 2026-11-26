# Wall-clock deadlines and derived due times

Status: deferred, 2026-11-24. Not designed. This records what it is, why it is not built yet, what would make it
worth starting, and how shutdown works with `@apackdev/clock` today. It is left out of [the plan](../plan.md) on
purpose, beside `@apackdev/clock`'s own `docs/deferred/wall-deadlines-and-sleep.md`.

## What it is

A system takes a structural `Clock` (`now()` and `after(ms, run)`) and exposes:

- `scope.now` and `StepLog.now`: monotonically clamped wall time stamped once per step (and read live after an
  `await` in `run` or an ask's handler).
- `scope.sleep(ms)`: a monotonic duration wait built on `clock.after(ms, run)`, cancelled with `Cancelled` when its
  state is left, its asker goes, or its work finishes.

What is left out is waiting for a **wall-clock timestamp** (`scope.until(wallTime)`) and **derived deadlines**
declared from data (e.g. a `due(data)` rule that re-arms across restarts and system wake).

## Why not yet

- `@apackdev/clock` keeps monotonic timers (`after`, paused across laptop sleep via `suspend()`/`resume()`)
  separate from wall-clock deadlines (`until(wallTime)` with wake draining), and defers `until` in its own
  `docs/deferred/wall-deadlines-and-sleep.md` until a real calendar-deadline caller exists.
- Computing `until(wallTime)` by subtracting `wallTime - clock.now()` and calling `clock.after(...)` would break
  that invariant: it mixes wall-clock timestamps onto a monotonic timer, which is wrong across NTP forward steps
  and laptop sleep.
- Today's real delayed transition (`running.connecting` → `unreachable` after 30s) is an active monotonic wait:
  pausing while the laptop sleeps is the behaviour wanted.

## Shutdown order with `@apackdev/clock`

When wiring `new ClockController()` into a system, stop the system before closing the clock:

```ts
const controller = new ClockController()
const sys = system({ side: 'backend', clock: controller.clock })
// ...
sys.stop()         // exits every state and cancels pending sleep timers
controller.close() // rejects any future timer registrations
```

Stopping the system first cancels every active `sleep` cleanly before the clock closes.

## What would make it worth starting

Kept states ([the plan](../plan.md), Not built) introducing a real calendar deadline that must survive process
restart and wake from laptop sleep — built together with `until(wallTime)` in `@apackdev/clock`.
