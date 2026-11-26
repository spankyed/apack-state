// The package's door: what a state's code is checked against, and the kernel that runs it. Each export is named
// here on purpose; what a module exports beside these is the package's own, marked `@internal` where it is.
// `@apackdev/state/vue` is what a Vue component reads a running state with, and `@apackdev/state/testing` the
// schedule a scenario is run under every ordering with.

// What a state is: its shape, its definition, and what it is handed and may return.
export {
  answered,
  forNet,
  given,
  state,
  within,
  type AllStarts,
  type AnyEvent,
  type AnyState,
  type Answered,
  type AskEnd,
  type AskFailure,
  type AskScope,
  type AskShape,
  type Asks,
  type AsksOf,
  type CallEach,
  type CallMany,
  type CallOne,
  type CalledEach,
  type CalledMany,
  type CalledOne,
  type Def,
  type Each,
  type EachOf,
  type EventScope,
  type EventsOf,
  type Follow,
  type Followed,
  type Handle,
  type HandleOf,
  type Load,
  type Loaded,
  type Net,
  type OneOf,
  type Outcome,
  type OutcomeOf,
  type ProgressOf,
  type Read,
  type Scope,
  type Shape,
  type ShapeOf,
  type Start,
  type Started,
  type State,
  type Value,
  type ViewHost,
  type ViewUpdate,
} from './types.ts'

// What runs it: a system, its steps, and what it is given.
export { Cancelled, system, type Changes, type Defect, type Handled, type Sent, type StepLog, type System, type Transact } from './kernel.ts'
export type { Clock, Failure, Following, Lane, PeerPort, Port, PortOutcome } from './port.ts'

// What a frame is in a window.
export { windowFrame, type WindowFrames } from './window-frame.ts'
