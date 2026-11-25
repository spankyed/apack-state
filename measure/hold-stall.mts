// What the hold costs a window under a steady stream of writes, on elmdb: a measurement. It prints, and refuses
// nothing.
//
// A backend writes a row every 2 ms, from outside any ask, and a window follows twelve views. Each view reads a row of
// its own and the row the window's asks write, and the stream writes the views' rows in turn, so each of its writes
// touches one view and some view is nearly always behind: the conditions spankyed/elmdb#217 measured
// `watchesSettled` under. The window asks for its row to be written, one ask after another, and each is answered once
// its views show it. Measured
// for the hold as it was, until no watch at all is behind (`watchesSettled`), which under a steady stream may not
// come, and as it is, until each view the window follows has caught up (`Watching.caughtUp({ soon: true })`). An ask
// not answered in 10 s is counted as one that did not end, and the run goes on.
//
//   npx tsx measure/hold-stall.mts
import { cpus, loadavg } from 'node:os'
import { forNet, system, type ViewHost } from '../src/index.ts'
import { connect } from '../src/testing.ts'
import { elmdb } from '../checks/store-elmdb.mts'
import { reading } from './record.mts'

const VIEWS = 12
const WRITE_EVERY_MS = 2
const ASKS = 40
const GIVE_UP_MS = 10_000

type Net = { systems: { rows: { events: never; asks: { CREATE: { args: { id: string }; answer: string } } } }; surfaces: {}; views: { rows: { count: { args: { view: string }; result: number } } } }
type PanelAsks = { ADD: { args: { id: string }; answer: boolean } }
const linked = forNet<Net>()

type Hold = 'every watch settled' | 'each view caught up'
const run = async (hold: Hold): Promise<{ took: number[]; unended: number }> => {
  const store = elmdb()
  // Each view reads its own row and the asked one: a watch of its own, touched by its row's writes and by every ask.
  const views: ViewHost = (_feature, _view, args, heard) => {
    const view = (args as { view: string }).view
    const running = store.watch(() => [store.get('thread', `stream-${view}`)?.topic, store.get('thread', 'asked')?.topic], (value) => heard({ ok: true, value: value.length }))
    return hold === 'each view caught up' ? running : { stop: () => running.stop(), caughtUp: (then) => store.settled(then) }
  }
  const backend = system({ side: 'backend', transact: store.transact, views })
  backend.start('rows', linked<{}, never, Net['systems']['rows']['asks']>()({ answers: { CREATE: ({ id }) => { store.put('thread', 'asked', { topic: id }); return id } } }))
  const window = system({ side: 'window' })
  const link = connect(window, backend)
  const panel = window.start('panel', linked<{ data: { views: string[]; counts: Record<string, number> } }, never, PanelAsks>()({
    data: { views: Array.from({ length: VIEWS }, (_, at) => String(at)), counts: {} },
    follows: (follow) => ({ count: follow('rows', 'count', { each: 'views', args: (view) => ({ view }), update: (update, { key }) => (update.ok ? { data: (d) => { d.counts[key] = update.value } } : undefined) }) }),
    answers: { ADD: async ({ id }, { ask }) => (await ask('rows', 'CREATE', { id })).ok },
  }))
  // The steady stream: a write every 2 ms, each its own unit, from outside any ask, to each view's row in turn.
  let written = 0
  const writer = setInterval(() => { const at = written++; store.transact(() => { store.put('thread', `stream-${at % VIEWS}`, { topic: String(at) }) }) }, WRITE_EVERY_MS)
  const took: number[] = []
  let unended = 0
  try {
    for (let at = 0; at < 5; at++) await window.ask(panel, 'ADD', { id: `warm-${at}` })
    for (let at = 0; at < ASKS; at++) {
      const began = process.hrtime.bigint()
      let timer: NodeJS.Timeout | undefined
      const ended = await Promise.race([
        window.ask(panel, 'ADD', { id: String(at) }).then(() => true),
        new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), GIVE_UP_MS) }),
      ])
      clearTimeout(timer)
      if (!ended) { unended++; continue }
      took.push(Number(process.hrtime.bigint() - began) / 1e6)
    }
  } finally {
    clearInterval(writer)
    link.close(); window.stop(); backend.stop(); store.close()
  }
  return { took, unended }
}

const at = (sorted: number[], share: number): number => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * share))] ?? NaN
console.log(`${new Date().toISOString().slice(0, 10)}, ${cpus()[0]?.model}, node ${process.version}, load ${process.platform === 'win32' ? 'unread' : loadavg()[0]!.toFixed(1)}, temporary databases with syncing off`)
console.log(`${VIEWS} views followed by one window, a row written every ${WRITE_EVERY_MS} ms, ${ASKS} asks one after another, each writing a row\n`)
for (const hold of ['every watch settled', 'each view caught up'] as const) {
  const { took, unended } = await run(hold)
  const sorted = [...took].sort((a, b) => a - b)
  reading(`${hold}: median`, at(sorted, 0.5), 'ms')
  reading(`${hold}: 90th`, at(sorted, 0.9), 'ms')
  reading(`${hold}: most`, sorted.at(-1) ?? NaN, 'ms')
  reading(`${hold}: not answered in ${GIVE_UP_MS / 1000} s`, unended, 'asks')
  console.log(`  ${(hold === 'every watch settled' ? 'until no watch is behind (as it was)' : 'until each view has caught up, soon (as it is)').padEnd(46)} median ${at(sorted, 0.5).toFixed(1).padStart(7)} ms   90th ${at(sorted, 0.9).toFixed(1).padStart(7)} ms   most ${(sorted.at(-1) ?? NaN).toFixed(1).padStart(8)} ms   not answered in ${GIVE_UP_MS / 1000} s: ${unended} of ${ASKS}`)
}
