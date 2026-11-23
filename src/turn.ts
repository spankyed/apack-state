// The next turn of the event loop, in Node and in a window: `setImmediate` where there is one, which is Node's, and a
// message posted to oneself where there is not, which is a window's next task and comes after everything already
// queued, as `setImmediate` does. A window's `setTimeout(run, 0)` is held to 4 ms once timers nest, so it is not used.
// `setImmediate` is read off the global object, so that this compiles where Node's types are not there.

const immediate = (globalThis as { setImmediate?: (run: () => void) => unknown }).setImmediate

/** Runs `run` on the next turn. @internal */
export const nextTurn: (run: () => void) => void = immediate
  ? (run) => { immediate(run) }
  : (() => {
      const waiting: Array<() => void> = []
      const channel = new MessageChannel()
      channel.port1.onmessage = () => { const run = waiting.shift(); run?.() }
      return (run: () => void) => { waiting.push(run); channel.port2.postMessage(0) }
    })()
