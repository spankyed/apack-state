// What joins two systems: the port one offers another across a link, and the lane a schedule orders.
//
// `Port`, `Following`, `Failure` and `PortOutcome` match `@apackdev/link` structurally with no runtime dependency
// between the two packages: a system's `port` passes straight to `join(link, system.port)`, and the port `join`
// returns passes straight to `system.attach(port)`, with no adapter and a single hold owned by the link.

/** Why an ask or a view ended without a result. */
export interface Failure { readonly kind: string; readonly message: string }
/** How an ask ended across a port. */
export type PortOutcome = { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly failure: Failure }
/** A view being followed across a port. */
export interface Following {
  stop(): void
  /**
   * Calls `then` once this view has been shown everything kept before the call. `soon` says something is blocked on
   * it. Offered by a system that runs views; one reached across a link has none.
   */
  caughtUp?(then: () => void, soon: boolean): void
}
/** What one system offers another across a link. */
export interface Port {
  /** Something happened. Nobody waits. */
  tell(to: string, event: unknown): void
  /** Asks. `progress` takes what is said before the answer, `done` how it finished. Returns what to call when whoever asked has gone. */
  ask(to: string, name: string, args: unknown, progress: (update: unknown) => void, done: (outcome: PortOutcome) => void): () => void
  /** Follows a view. `updated` takes its result and each changed result after it, `failed` that it has failed and why. */
  follow(feature: string, view: string, args: unknown, updated: (update: unknown) => void, failed: (failure: Failure) => void): Following
}
/** A tell-only port for a named non-window peer: matches a full `@apackdev/link` `Port` or a one-method sink. */
export type PeerPort = Pick<Port, 'tell'>
/**
 * Things that happen one after another: what crosses a link in one direction, or a system's frames. What is in one
 * lane keeps its order, as messages on one socket do. What is in two lanes can come in either order, and that is the
 * whole of what a schedule may choose.
 */
export interface Lane { readonly label: string }
/**
 * A clock a system takes its time and delays from. Matches `@apackdev/clock`'s `controller.clock` and
 * `@apackdev/orderings`'s `schedule.clock` structurally with no runtime dependency on either package.
 */
export interface Clock {
  /** Monotonically clamped wall time in milliseconds since 1970. */
  now(): number
  /** Runs `run` after `ms` milliseconds on a monotonic timer. Returns what cancels it before it runs. */
  after(ms: number, run: () => void): () => void
}
