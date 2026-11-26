// The views a state follows. They are declared, and which are followed, and what each is asked for, come from the
// data: nothing follows or stops following one by hand. What a view delivers goes to a handler.
//
//   npx vitest run follows
import { deepStrictEqual, ok, strictEqual } from 'node:assert'
import { connect, rest, run, system } from './checks.mts'
import { forNet, type ViewHost, type ViewUpdate } from '../src/index.ts'

type App = {
  systems: {}
  surfaces: {}
  views: {
    shop: {
      total: { args: { currency: string }; result: number }
      price: { args: { id: string }; result: number }
    }
  }
}
export const state = forNet<App>()

export type ShopEvent =
  | { type: 'SET_CURRENCY'; currency: string }
  | { type: 'SET_NOTE'; note: string }
  | { type: 'WATCH'; ids: string[] }
  | { type: 'GO_AWAY' }
  | { type: 'COME_BACK' }
export type Shop = {
  data: { currency: string; total: number | null; watching: string[]; prices: Record<string, number>; note: string; problem: string | null }
  states: { browsing: {}; away: {} }
}

const shop = state<Shop, ShopEvent>()({
  data: { currency: 'EUR', total: null, watching: [], prices: {}, note: '', problem: null },
  initial: 'browsing',

  follows: (follow) => ({
    // Asked for the currency the data holds. A change of currency follows it again; a change of anything else does not.
    total: follow('shop', 'total', {
      from: ['currency'],
      args: ({ currency }) => ({ currency }),
      updated: (update) => (update.ok ? { data: { total: update.value } } : { data: { problem: update.failure.message } }),
    }),
    // One for each item being watched.
    price: follow('shop', 'price', {
      each: 'watching',
      args: (id) => ({ id }),
      updated: (update, { key }) => {
        if (!update.ok) return { data: { problem: `${key}: ${update.failure.message}` } }
        if (update.value < 0) throw new Error('a price below nothing')
        return { data: (d) => { d.prices[key] = update.value } }
      },
    }),
  }),

  on: {
    SET_CURRENCY: ({ currency }) => ({ data: { currency } }),
    SET_NOTE: ({ note }) => ({ data: { note } }),
    WATCH: ({ ids }) => ({ data: { watching: ids } }),
    GO_AWAY: () => ({ at: 'away' }),
    COME_BACK: () => ({ at: 'browsing' }),
  },

  states: {
    browsing: {},
    away: {
      follows: (follow) => ({
        // What it hears changes the note, and the note is what it asks for: it would follow itself round for good.
        echo: follow('shop', 'total', {
          from: ['note'],
          args: ({ note }) => ({ currency: note }),
          updated: (update) => (update.ok ? { data: { note: `heard ${update.value}` } } : undefined),
        }),
      }),
    },
  },
})

// ── two views, each asked for what the other delivers ───────────────────────────────────────────────────────────────

type PairEvent = { type: 'SET_LEFT'; currency: string }
type Pair = { data: { left: string; right: string } }
const pair = state<Pair, PairEvent>()({
  data: { left: 'EUR', right: 'USD' },
  on: { SET_LEFT: ({ currency }) => ({ data: { left: currency } }) },
  follows: (follow) => ({
    // What `left` delivers says what `right` is asked for. One view leading another is how a list leads a detail.
    left: follow('shop', 'total', {
      from: ['left'],
      args: ({ left }) => ({ currency: left }),
      updated: (update) => (update.ok ? { data: { right: `R${update.value}` } } : undefined),
    }),
    // And what `right` delivers says what `left` is asked for, which closes the circle.
    right: follow('shop', 'total', {
      from: ['right'],
      args: ({ right }) => ({ currency: right }),
      updated: (update) => (update.ok ? { data: { left: `L${update.value}` } } : undefined),
    }),
  }),
})

/** Stands in for the view host: says what is followed, and delivers what a check tells it to. */
const wired = (which: 'shop' | 'pair' = 'shop') => {
  const calls: string[] = []
  const everFollowed = new Map<string, (update: ViewUpdate<unknown>) => void>()
  const following = new Set<string>()
  const views: ViewHost = (_feature, view, args, heard) => {
    const id = `${view}${JSON.stringify(args)}`
    everFollowed.set(id, heard)
    following.add(id)
    calls.push(`follow ${id}`)
    return () => { following.delete(id); calls.push(`stop ${id}`) }
  }
  const defects: string[] = []
  const looked: string[] = []
  const sys = system({ side: 'window', views, trace: (line) => { if (line.startsWith('DEFECT')) defects.push(line); if (line.includes('looked at')) looked.push(line) } })
  const it = sys.start('shop', shop)
  const pairOf = which === 'pair' ? sys.start('pair', pair) : undefined
  return {
    setLeft: (currency: string): void => sys.send(pairOf!, { type: 'SET_LEFT', currency }),
    pair: () => sys.read(pairOf!).data,
    sys, calls, defects, looked,
    following: (): string[] => [...following].sort(),
    send: (event: ShopEvent): void => sys.send(it, event),
    data: () => sys.read(it).data,
    /** Delivers to whatever followed under this id, whether or not it still does. */
    deliver: (id: string, update: ViewUpdate<unknown>): void => everFollowed.get(id)!(update),
  }
}
const eur = 'total{"currency":"EUR"}'
const usd = 'total{"currency":"USD"}'

const checks: Array<[string, () => void]> = [
  ['a view is followed from the moment its state is the case, asked for what the data holds', () => {
    const { following, sys } = wired()
    deepStrictEqual(following(), [eur])
    sys.stop()
  }],
  ['what a view delivers goes to its handler, which changes the data', () => {
    const { deliver, data, sys } = wired()
    deliver(eur, { ok: true, value: 12 })
    strictEqual(data().total, 12)
    deliver(eur, { ok: false, failure: { kind: 'not-found', message: 'no such currency' } })
    strictEqual(data().problem, 'no such currency')
    sys.stop()
  }],
  ['a change to what it asks for follows it again, and stops the one before', () => {
    const { send, calls, following, sys } = wired()
    send({ type: 'SET_CURRENCY', currency: 'USD' })
    deepStrictEqual(calls, [`follow ${eur}`, `stop ${eur}`, `follow ${usd}`])
    deepStrictEqual(following(), [usd])
    sys.stop()
  }],
  ['what the one before delivers afterwards is not heard', () => {
    const { send, deliver, data, sys } = wired()
    send({ type: 'SET_CURRENCY', currency: 'USD' })
    deliver(eur, { ok: true, value: 99 })
    strictEqual(data().total, null)
    deliver(usd, { ok: true, value: 14 })
    strictEqual(data().total, 14)
    sys.stop()
  }],
  ['a change to anything else leaves it followed as it is', () => {
    const { send, calls, deliver, sys } = wired()
    send({ type: 'SET_NOTE', note: 'a note' })
    send({ type: 'WATCH', ids: ['a'] })
    deliver(eur, { ok: true, value: 12 })
    deepStrictEqual(calls.filter((call) => call.includes('total')), [`follow ${eur}`])
    sys.stop()
  }],
  ['one is followed for each item of a list, and stops when its item goes', () => {
    const { send, calls, following, sys } = wired()
    send({ type: 'WATCH', ids: ['a', 'b'] })
    deepStrictEqual(following(), ['price{"id":"a"}', 'price{"id":"b"}', eur])
    send({ type: 'WATCH', ids: ['b', 'c'] })
    deepStrictEqual(following(), ['price{"id":"b"}', 'price{"id":"c"}', eur])
    // The one that stayed was not followed again.
    deepStrictEqual(calls.filter((call) => call.includes('"b"')), ['follow price{"id":"b"}'])
    sys.stop()
  }],
  ['which there are is looked at again only when that list changes', () => {
    const { send, deliver, looked, sys } = wired()
    looked.length = 0
    send({ type: 'SET_NOTE', note: 'a note' })
    send({ type: 'SET_CURRENCY', currency: 'USD' })
    deliver(usd, { ok: true, value: 3 })
    deepStrictEqual(looked, [])
    send({ type: 'WATCH', ids: ['a'] })
    strictEqual(looked.length, 1)
    sys.stop()
  }],
  ['each of many hears with its own key', () => {
    const { send, deliver, data, sys } = wired()
    send({ type: 'WATCH', ids: ['a', 'b'] })
    deliver('price{"id":"b"}', { ok: true, value: 5 })
    deliver('price{"id":"a"}', { ok: true, value: 3 })
    deepStrictEqual(data().prices, { a: 3, b: 5 })
    sys.stop()
  }],
  ['a handler that throws changes nothing and is reported, and the view goes on being followed', () => {
    const { send, deliver, data, defects, following, sys } = wired()
    send({ type: 'WATCH', ids: ['a'] })
    deliver('price{"id":"a"}', { ok: true, value: -1 })
    deepStrictEqual(data().prices, {})
    strictEqual(defects.length, 1)
    ok(defects[0]!.includes('threw in price/a updated'))
    deliver('price{"id":"a"}', { ok: true, value: 4 })
    deepStrictEqual(data().prices, { a: 4 })
    ok(following().includes('price{"id":"a"}'))
    sys.stop()
  }],
  ['a view declared by a state inside is followed only while that state is the case', () => {
    const { send, following, sys } = wired()
    send({ type: 'SET_NOTE', note: 'GBP' })
    send({ type: 'GO_AWAY' })
    deepStrictEqual(following(), [eur, 'total{"currency":"GBP"}'])
    send({ type: 'COME_BACK' })
    deepStrictEqual(following(), [eur])
    sys.stop()
  }],
  ['what a view delivers may not change what that view is asked for: it is reported, and goes on as it was', () => {
    const { send, deliver, data, defects, calls, following, sys } = wired()
    send({ type: 'SET_NOTE', note: 'GBP' })
    send({ type: 'GO_AWAY' })
    calls.length = 0
    deliver('total{"currency":"GBP"}', { ok: true, value: 7 })
    // The handler's change is made: it is the following again that is refused.
    strictEqual(data().note, 'heard 7')
    strictEqual(defects.length, 1)
    ok(defects[0]!.includes('shop#echo delivered changed a field it is itself asked from'))
    deepStrictEqual(calls, [])
    deepStrictEqual(following(), [eur, 'total{"currency":"GBP"}'])
    sys.stop()
  }],
  ['one view may lead another: what the first delivers changes what the second is asked for', () => {
    const { deliver, following, defects, pair: now, sys } = wired('pair')
    deliver('total{"currency":"EUR"}', { ok: true, value: 1 })
    deepStrictEqual(now(), { left: 'EUR', right: 'R1' })
    ok(following().includes('total{"currency":"R1"}'))
    deepStrictEqual(defects, [])
    sys.stop()
  }],
  ['but not round in a circle: where it closes, the view goes on as it was, and it is reported', () => {
    const { deliver, following, defects, calls, pair: now, sys } = wired('pair')
    deliver('total{"currency":"EUR"}', { ok: true, value: 1 })
    calls.length = 0
    deliver('total{"currency":"R1"}', { ok: true, value: 2 })
    // The handler's change is made. Following `left` again, which is what led here, is what is refused.
    deepStrictEqual(now(), { left: 'L2', right: 'R1' })
    deepStrictEqual(calls, [])
    ok(following().includes('total{"currency":"EUR"}') && !following().includes('total{"currency":"L2"}'))
    strictEqual(defects.length, 1)
    ok(defects[0]!.includes('pair#left is what led to pair#right being asked'))
    sys.stop()
  }],
  ['a change from anywhere else follows a view again as before, and it leads the other again', () => {
    const { deliver, following, defects, setLeft, sys } = wired('pair')
    deliver('total{"currency":"EUR"}', { ok: true, value: 1 })
    setLeft('GBP')
    ok(following().includes('total{"currency":"GBP"}'))
    deliver('total{"currency":"GBP"}', { ok: true, value: 3 })
    ok(following().includes('total{"currency":"R3"}'))
    deepStrictEqual(defects, [])
    sys.stop()
  }],
  ['stopping the state stops everything it followed', () => {
    const { send, following, sys } = wired()
    send({ type: 'WATCH', ids: ['a', 'b'] })
    sys.stop()
    deepStrictEqual(following(), [])
  }],
]

// ── a view asked from two fields, and views followed across a link ──────────────────────────────────────────────────

type TwoEvent = { type: 'SET_CURRENCY'; currency: string } | { type: 'SET_SUFFIX'; suffix: string }
type Two = { data: { currency: string; suffix: string; total: number | null; problem: string | null } }
const two = state<Two, TwoEvent>()({
  data: { currency: 'EUR', suffix: '', total: null, problem: null },
  follows: (follow) => ({
    total: follow('shop', 'total', {
      from: ['currency', 'suffix'],
      args: ({ currency, suffix }) => ({ currency: `${currency}${suffix}` }),
      updated: (update) => (update.ok ? { data: { total: update.value } } : { data: { problem: `${update.failure.kind}: ${update.failure.message}` } }),
    }),
  }),
  on: {
    SET_CURRENCY: ({ currency }) => ({ data: { currency } }),
    SET_SUFFIX: ({ suffix }) => ({ data: { suffix } }),
  },
})
/** A host of views that says what is followed now, by what it was asked for. */
const host = () => {
  const following = new Set<string>()
  const views: ViewHost = (_feature, _view, args) => {
    const id = (args as { currency: string }).currency
    following.add(id)
    return () => { following.delete(id) }
  }
  return { views, following: (): string[] => [...following].sort() }
}
/** A window with no views of its own, following them over the link from a backend that runs them, or none. */
const across = (runsViews = true) => {
  const backendHost = host()
  const backend = system({ side: 'backend', ...(runsViews ? { views: backendHost.views } : {}) })
  const window = system({ side: 'window' })
  connect(window, backend)
  const it = window.start('two', two)
  return { following: backendHost.following, send: (event: TwoEvent): void => window.send(it, event), data: () => window.read(it).data }
}

const moreChecks: Array<[string, () => void | Promise<void>]> = [
  ['a view asked from two fields is followed again when either changes', () => {
    const { views, following } = host()
    const sys = system({ side: 'window', views })
    const it = sys.start('two', two)
    sys.send(it, { type: 'SET_SUFFIX', suffix: '!' })
    deepStrictEqual(following(), ['EUR!'])
    sys.send(it, { type: 'SET_CURRENCY', currency: 'USD' })
    deepStrictEqual(following(), ['USD!'])
  }],
  ['a window with no views and no backend follows nothing, and nothing breaks', () => {
    const defects: string[] = []
    const sys = system({ side: 'window', trace: (line) => { if (line.startsWith('DEFECT')) defects.push(line) } })
    const it = sys.start('two', two)
    sys.send(it, { type: 'SET_CURRENCY', currency: 'USD' })
    deepStrictEqual([sys.read(it).data, defects], [{ currency: 'USD', suffix: '', total: null, problem: null }, []])
  }],
  ['a window follows its backend\'s views over the link, and a view it stops following is stopped there', async () => {
    const it = across()
    await rest()
    deepStrictEqual(it.following(), ['EUR'])
    it.send({ type: 'SET_CURRENCY', currency: 'USD' })
    await rest()
    deepStrictEqual(it.following(), ['USD'])
  }],
  ['a view given up before it crossed is never followed there', async () => {
    const it = across()
    it.send({ type: 'SET_CURRENCY', currency: 'USD' })
    await rest()
    deepStrictEqual(it.following(), ['USD'])
  }],
  ['a view of a backend that runs none is heard as failing, saying so', async () => {
    const it = across(false)
    await rest()
    ok(it.data().problem?.startsWith('unavailable:') && /runs no views/.test(it.data().problem ?? ''), String(it.data().problem))
  }],
  ['a local ViewHost that throws in views() or stop() is isolated without aborting exit or leaving zombie states', () => {
    const defects: string[] = []
    let throwInStop = false
    const flakyViews: ViewHost = (_feature, _view, args) => {
      if ((args as { currency: string }).currency === 'BOOM') throw new Error('views host crashed')
      return {
        stop: () => { if (throwInStop) throw new Error('view stop crashed') },
      }
    }
    const sys = system({ side: 'window', views: flakyViews, trace: (line) => { if (line.startsWith('DEFECT')) defects.push(line) } })
    const it = sys.start('two', two)
    sys.send(it, { type: 'SET_CURRENCY', currency: 'BOOM' })
    ok(defects.some((line) => line.includes('views host crashed')), defects.join('\n'))
    // State is still healthy and responsive.
    sys.send(it, { type: 'SET_CURRENCY', currency: 'USD' })
    strictEqual(sys.read(it).data.currency, 'USD')
    // Now throw in stop() during system.stop(): state must still exit cleanly with no zombie left behind.
    throwInStop = true
    sys.stop()
    deepStrictEqual(sys.snapshot(), {})
    ok(defects.some((line) => line.includes("stopping two's view total") && line.includes('view stop crashed')), defects.join('\n'))
  }],
  ['stale view deliveries after leaving or changing fields do not trigger a step', () => {
    const callbacks: Array<(u: ViewUpdate<number>) => void> = []
    let steps = 0
    const sys = system({
      side: 'window',
      log: () => { steps++ },
      views: (_f, _v, _a, heard) => { callbacks.push(heard); return () => {} },
    })
    const watcher = state<{ data: { currency: string; total: number }; states: { on: {}; off: {} } }, { type: 'CHANGE'; currency: string } | { type: 'OFF' }>()({
      data: { currency: 'EUR', total: 0 },
      initial: 'on',
      states: {
        on: {
          follows: (follow) => ({
            total: follow('shop', 'total', {
              from: ['currency'],
              args: ({ currency }) => ({ currency }),
              updated: (u) => (u.ok ? { data: { total: u.value } } : undefined),
            }),
          }),
          on: {
            CHANGE: ({ currency }) => ({ data: { currency } }),
            OFF: () => ({ at: 'off' }),
          },
        },
        off: {},
      },
    })
    const h = sys.start('w', watcher)
    const first = callbacks[0]!
    sys.send(h, { type: 'CHANGE', currency: 'USD' })
    const second = callbacks[1]!
    const stepsAfterChange = steps
    // Stale callback from EUR must be dropped before arrive() (no extra step).
    first({ ok: true, value: 1 })
    strictEqual(steps, stepsAfterChange)
    sys.send(h, { type: 'OFF' })
    const stepsAfterOff = steps
    // Stale callback after leaving `on` must also be dropped before arrive() (no extra step).
    second({ ok: true, value: 2 })
    strictEqual(steps, stepsAfterOff)
    strictEqual(sys.read(h).data.total, 0)
  }],
  ['queued view, ended, and progressed deliveries arriving after leave or replacement do not run stale handlers', async () => {
    const calls: string[] = []
    let deliverView!: (update: ViewUpdate<number>) => void
    let triggerProgress!: (u: string) => void
    let triggerEnd!: (o: { ok: true; value: string }) => void
    type StaleNet = {
      systems: { svc: { events: never; asks: { FETCH: { args: { k: string }; answer: string; progress: string } } } }
      surfaces: {}
      views: { shop: { total: { args: { currency: string }; result: number } } }
    }
    const s = forNet<StaleNet>()
    const actor = s<{
      data: { currency: string }
      states: { active: {}; gone: {} }
    }, { type: 'LEAVE' } | { type: 'CHANGE'; currency: string } | { type: 'TRIGGER' }>()({
      data: { currency: 'EUR' },
      initial: 'active',
      states: {
        active: {
          follows: (follow) => ({
            total: follow('shop', 'total', {
              from: ['currency'],
              args: ({ currency }) => ({ currency }),
              updated: (update) => { calls.push(`view:${update.ok ? update.value : update.failure.message}`); return undefined },
            }),
          }),
          loads: (load) => ({
            fetch: load('svc', 'FETCH', {
              from: ['currency'],
              args: ({ currency }) => ({ k: currency }),
              progress: (updates) => { calls.push(`progress:${updates.join(',')}`); return undefined },
              done: (outcome) => { calls.push(`ended:${outcome.ok ? outcome.value : outcome.failure.kind}`); return undefined },
            }),
          }),
          on: {
            LEAVE: () => ({ at: 'gone' }),
            CHANGE: ({ currency }) => ({ data: { currency } }),
            TRIGGER: (_, { data }) => ({ data: { currency: data.currency } }),
          },
        },
        gone: {},
      },
    })

    // Case 1: queued while flushing, before LEAVE executes (tests `aborted` guard).
    const sys1 = system({
      side: 'window',
      views: (_f, _v, _a, heard) => { deliverView = heard; return () => {} },
    })
    sys1.attach({
      tell: () => {},
      follow: () => ({ stop: () => {} }),
      ask: (_to, _name, _args, heard, ended) => {
        triggerProgress = (u) => heard(u)
        triggerEnd = (o) => ended(o)
        return () => {}
      },
    })
    const h1 = sys1.start('a', actor)
    let armed = false
    sys1.subscribe(() => {
      if (!armed) return
      armed = false
      // Inside flushing: queue LEAVE first, then view + progress + end behind it in `outside`.
      sys1.send(h1, { type: 'LEAVE' })
      deliverView({ ok: true, value: 99 })
      triggerProgress('p1')
      triggerEnd({ ok: true, value: 'late' })
    })
    armed = true
    sys1.send(h1, { type: 'CHANGE', currency: 'USD' })
    await rest()
    strictEqual(sys1.read(h1).at, 'gone')
    deepStrictEqual(calls, [])

    // Case 2: queued while flushing, before CHANGE replaces live without aborting controller (tests `live.get(id) !== live` guard).
    const sys2 = system({
      side: 'window',
      views: (_f, _v, _a, heard) => { deliverView = heard; return () => {} },
    })
    sys2.attach({
      tell: () => {},
      follow: () => ({ stop: () => {} }),
      ask: (_to, _name, _args, heard, ended) => {
        triggerProgress = (u) => heard(u)
        triggerEnd = (o) => ended(o)
        return () => {}
      },
    })
    const h2 = sys2.start('a', actor)
    let armed2 = false
    sys2.subscribe(() => {
      if (!armed2) return
      armed2 = false
      const staleView = deliverView
      const staleProgress = triggerProgress
      const staleEnd = triggerEnd
      sys2.send(h2, { type: 'CHANGE', currency: 'GBP' })
      staleView({ ok: true, value: 111 })
      staleProgress('stale-p')
      staleEnd({ ok: true, value: 'stale-end' })
    })
    armed2 = true
    sys2.send(h2, { type: 'CHANGE', currency: 'JPY' })
    strictEqual(sys2.read(h2).data.currency, 'GBP')
    deepStrictEqual(calls, [])
    sys1.stop()
    sys2.stop()
    await rest()
  }],
]

await run([...checks, ...moreChecks])
