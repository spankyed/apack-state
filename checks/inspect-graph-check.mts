// The causal inspector's coverage against graphs the graph tool reads from source: what began a move is named in a
// log by its kind and in a graph by a phrase, and coverage is only right while the two agree. So the states of
// `graphs/moved.mts`, which move for each reason a state can, are run, and every move the tool reads from their types
// has to be the move coverage saw. Needs Node: the graph tool reads files.
//
//   npx vitest run inspect-graph
import { deepStrictEqual } from 'node:assert'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { rest, run, system } from './checks.mts'
import { analyseGraphs } from '../src/graph.ts'
import { createInspector } from '../src/inspect.ts'
import type { Clock, ViewHost } from '../src/index.ts'
import { breaking, calling, resting, sent, shifting, slow, viewing } from './graphs/moved.mts'

const here = dirname(fileURLToPath(import.meta.url))
const file = join(here, 'graphs', 'moved.mts')

await run([
  ['every move the graph tool reads from a state\'s types is the move coverage saw it make, named the same', async () => {
    // In the order the file declares them, which is the order the tool reads them in.
    const names = ['sent', 'viewing', 'slow', 'calling', 'resting', 'breaking', 'shifting']
    const read = analyseGraphs([file], { tsconfig: join(here, '..', 'tsconfig.json') }).get(file)!
    const graphs = Object.fromEntries(names.map((name, index) => [name, read[index]!]))

    const inspector = createInspector()
    const due: Array<() => void> = []
    const clock: Clock = { now: () => 0, after: (_ms, expire) => { due.push(expire); return () => {} } }
    const views: ViewHost = (_feature, _view, _args, updated) => { updated({ ok: true, value: 1 }); return () => {} }
    const sys = system({ side: 'backend', clock, views, ...inspector.hooks('one') })
    sys.send(sys.start('sent', sent), { type: 'WAIT' })
    sys.start('viewing', viewing)
    sys.start('slow', slow)
    sys.send(sys.start('calling', calling), { type: 'GO' })
    sys.start('resting', resting)
    sys.start('breaking', breaking)
    const asked = sys.start('shifting', shifting)
    await sys.ask(asked, 'SHIFT', {})
    await sys.ask(asked, 'LATER', {})
    await rest()
    for (const expire of due.splice(0)) expire()
    await rest()

    const covered = Object.fromEntries(inspector.coverage(graphs).map((each) => [each.ref, each]))
    // Each declared move was made, but for work that could have failed and did not.
    deepStrictEqual(Object.fromEntries(names.map((name) => [name, covered[name]!.declaredMoves.filter((move) => !move.hit).map((move) => move.on)])), {
      sent: [], viewing: [], slow: [], calling: [], resting: ['(its work fails)'], breaking: [], shifting: [],
    })
    // And nothing was seen to move for a reason its graph does not give.
    for (const name of names) {
      const declared = new Set(graphs[name]!.moves.map((move) => move.on))
      deepStrictEqual(covered[name]!.observedMoves.filter((move) => !declared.has(move.on)), [])
      deepStrictEqual(covered[name]!.unvisitedStates, [])
    }
  }],
])
