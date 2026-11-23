// What joins two systems: what one offers the other, and the link between a window and its backend that what they
// say crosses. A link here is in memory, with a lane each way; what is said across a real one is apack-link's.
import type { AnyEvent, AnyOutcome, ViewUpdate } from './types.ts'

/** What a system is handed of what is said to it before an answer. @internal */
export type Heard = (update: unknown) => void
/** What one system offers another over a link. @internal */
export interface Port {
  event(ref: string, event: AnyEvent): void
  /** Returns what to call when whoever asked has gone. */
  ask(ref: string, name: string, args: object, heard: Heard, settle: (outcome: AnyOutcome) => void): () => void
  /** Follows a view the other system runs. Returns what to call to stop following it. */
  view(feature: string, view: string, args: object, heard: (update: ViewUpdate<unknown>) => void): () => void
}
/**
 * Things that happen one after another: what crosses a link in one direction, or a system's frames. What is in one
 * lane keeps its order, as messages on one socket do. What is in two lanes can come in either order, and that is the
 * whole of what a schedule may choose.
 */
export interface Lane { readonly label: string }
/** A link between a window and its backend. What crosses it arrives later, and not at all once it is closed. @internal */
export interface Link { open: boolean; readonly up: Lane; readonly down: Lane }
/** Where a system keeps the port it offers. @internal */
export const PORT = Symbol('port')
