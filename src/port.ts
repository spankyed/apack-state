// What joins two systems: the port one offers another across a link, and the lane a schedule orders.
//
// `Port`, `Following`, `Failure` and `PortOutcome` match `@apackdev/link` structurally with no runtime dependency
// between the two packages: a system's `port` passes straight to `join(link, system.port)`, and the port `join`
// returns passes straight to `system.attach(peer)`, with no adapter and a single hold owned by the link.

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
  /** Asks. `heard` takes what is said before the answer, `ended` how it ended. Returns what to call when whoever asked has gone. */
  ask(to: string, name: string, args: unknown, heard: (update: unknown) => void, ended: (outcome: PortOutcome) => void): () => void
  /** Follows a view. `shown` takes its result and each changed result after it, `over` that it has ended and why. */
  follow(feature: string, view: string, args: unknown, shown: (update: unknown) => void, over: (failure: Failure) => void): Following
}
/**
 * Things that happen one after another: what crosses a link in one direction, or a system's frames. What is in one
 * lane keeps its order, as messages on one socket do. What is in two lanes can come in either order, and that is the
 * whole of what a schedule may choose.
 */
export interface Lane { readonly label: string }
