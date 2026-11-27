// The views a state follows. They are declared, and which are followed, and what each is asked for, come from the
// data: nothing follows or stops following one by hand. One is followed from the fields it names, for each key of a
// field, or both. What a view delivers goes to a handler.
//
//   npx vitest run follows
import { deepStrictEqual, ok, strictEqual } from 'node:assert'
import { connect, rest, run, system } from './checks.mts'
import { forNet, type StepLog, type ViewHost, type ViewUpdate } from '../src/index.ts'

type App = {
  systems: {}
  surfaces: {}
  views: {
    shop: {
      total: { args: { currency: string }; result: number }
      price: { args: { id: string }; result: number }
      quote: { args: { id: string; currency: string }; result: number }
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
  ['conditional follows: returning null, undefined, or false skips or stops the view and resumes when truthy again', async () => {
    type CondEvent = { type: 'SET'; currency: string | null | undefined; enabled: boolean; unrelated: number }
    type Cond = { data: { currency: string | null | undefined; enabled: boolean; unrelated: number; total: number | null } }
    let argsCalls = 0
    const cond = state<Cond, CondEvent>()({
      data: { currency: null, enabled: false, unrelated: 0, total: null },
      follows: (follow) => ({
        total: follow('shop', 'total', {
          from: ['currency', 'enabled'],
          args: ({ currency, enabled }) => {
            argsCalls++
            if (!enabled) return false
            if (currency === null) return null
            if (currency === undefined) return undefined
            return { currency }
          },
          updated: (update) => (update.ok ? { data: { total: update.value } } : undefined),
        }),
      }),
      on: {
        SET: ({ currency, enabled, unrelated }) => ({ data: { currency, enabled, unrelated } }),
      },
    })
    const { views, following } = host()
    const sys = system({ side: 'window', views })
    const h = sys.start('cond', cond)
    deepStrictEqual(following(), [])
    strictEqual(argsCalls, 1)

    // Unrelated field change does not re-evaluate args while paused.
    sys.send(h, { type: 'SET', currency: null, enabled: false, unrelated: 1 })
    strictEqual(argsCalls, 1)
    deepStrictEqual(following(), [])

    // Returning null / undefined still follows nothing.
    sys.send(h, { type: 'SET', currency: null, enabled: true, unrelated: 1 })
    deepStrictEqual(following(), [])
    sys.send(h, { type: 'SET', currency: undefined, enabled: true, unrelated: 1 })
    deepStrictEqual(following(), [])

    // Becoming truthy starts following the view.
    sys.send(h, { type: 'SET', currency: 'EUR', enabled: true, unrelated: 1 })
    deepStrictEqual(following(), ['EUR'])

    // Turning off stops the active view.
    sys.send(h, { type: 'SET', currency: 'EUR', enabled: false, unrelated: 1 })
    deepStrictEqual(following(), [])

    // Re-enabling starts following again.
    sys.send(h, { type: 'SET', currency: 'USD', enabled: true, unrelated: 1 })
    deepStrictEqual(following(), ['USD'])
    sys.stop()

    // Also works across a link: unfollows on backend when args becomes falsy, refollows when truthy.
    const remote = host()
    const backend = system({ side: 'backend', views: remote.views })
    const win = system({ side: 'window' })
    connect(win, backend)
    const wh = win.start('cond', cond)
    await rest()
    deepStrictEqual(remote.following(), [])
    win.send(wh, { type: 'SET', currency: 'JPY', enabled: true, unrelated: 0 })
    await rest()
    deepStrictEqual(remote.following(), ['JPY'])
    win.send(wh, { type: 'SET', currency: null, enabled: true, unrelated: 0 })
    await rest()
    deepStrictEqual(remote.following(), [])
    win.stop()
    backend.stop()
  }],
  ['follows may omit args when the view accepts {}, for both from and each', () => {
    type ZeroNet = { systems: {}; surfaces: {}; views: { feed: { all: { args: {}; result: number } } } }
    const zeroState = forNet<ZeroNet>()
    const seenArgs: unknown[] = []
    const callbacks: Array<(u: ViewUpdate<number>) => void> = []
    const views: ViewHost = (_f, _v, args, updated) => {
      seenArgs.push(args)
      callbacks.push(updated)
      return () => {}
    }
    const watcher = zeroState<{ data: { rev: number; keys: string[]; count: number; byKey: Record<string, number> } }, { type: 'BUMP' } | { type: 'KEYS'; keys: string[] }>()({
      data: { rev: 0, keys: [], count: 0, byKey: {} },
      follows: (follow) => ({
        all: follow('feed', 'all', {
          from: ['rev'],
          updated: (u) => (u.ok ? { data: { count: u.value } } : undefined),
        }),
        perKey: follow('feed', 'all', {
          each: 'keys',
          updated: (u, { key }) => (u.ok ? { data: (d) => { d.byKey[key] = u.value } } : undefined),
        }),
      }),
      on: {
        BUMP: (_, { data }) => ({ data: { rev: data.rev + 1 } }),
        KEYS: ({ keys }) => ({ data: { keys } }),
      },
    })
    const sys = system({ side: 'window', views })
    const h = sys.start('w', watcher)
    deepStrictEqual(seenArgs, [{}])
    callbacks[0]!({ ok: true, value: 7 })
    strictEqual(sys.read(h).data.count, 7)
    sys.send(h, { type: 'BUMP' })
    sys.send(h, { type: 'KEYS', keys: ['x'] })
    deepStrictEqual(seenArgs, [{}, {}, {}])
    callbacks[2]!({ ok: true, value: 99 })
    deepStrictEqual(sys.read(h).data.byKey, { x: 99 })
    sys.stop()
  }],
]

// ── one view for each item watched, all followed again when the currency changes ────────────────────────────────────

type QuotesEvent = { type: 'WATCH'; ids: string[]; currency?: string } | { type: 'SET_CURRENCY'; currency: string } | { type: 'SET_NOTE'; note: string }
type Quotes = { data: { currency: string; watching: string[]; quotes: Record<string, number>; note: string; rounds: number } }
/** `echoing` has what a quote delivers count `rounds` up, which is a field it is followed from. */
const quotes = (echoing: boolean) => state<Quotes, QuotesEvent>()({
  data: { currency: 'EUR', watching: [], quotes: {}, note: '', rounds: 0 },
  on: {
    WATCH: ({ ids, currency }, { data }) => ({ data: { watching: ids, currency: currency ?? data.currency } }),
    SET_CURRENCY: ({ currency }) => ({ data: { currency } }),
    SET_NOTE: ({ note }) => ({ data: { note } }),
  },
  follows: (follow) => ({
    quote: follow('shop', 'quote', {
      each: 'watching',
      from: ['currency', 'rounds'],
      args: (id, { currency, rounds }) => ({ id, currency: `${currency}${rounds || ''}` }),
      updated: (update, { key }) => (update.ok ? { data: (d) => { d.quotes[key] = update.value; if (echoing) d.rounds += 1 } } : undefined),
    }),
  }),
})
const quoted = (echoing = false) => {
  const calls: string[] = []
  const everFollowed = new Map<string, (update: ViewUpdate<unknown>) => void>()
  const views: ViewHost = (_feature, _view, args, heard) => {
    const { id, currency } = args as { id: string; currency: string }
    const which = `${id} in ${currency}`
    everFollowed.set(which, heard)
    calls.push(`follow ${which}`)
    return () => { calls.push(`stop ${which}`) }
  }
  const defects: string[] = []
  const sys = system({ side: 'window', views, trace: (line) => { if (line.startsWith('DEFECT')) defects.push(line) } })
  const it = sys.start('quotes', quotes(echoing))
  return {
    calls, defects,
    send: (event: QuotesEvent): void => sys.send(it, event),
    data: () => sys.read(it).data,
    /** Delivers to whatever followed this, whether or not it still does. */
    deliver: (which: string, value: number): void => everFollowed.get(which)!({ ok: true, value }),
  }
}

const keyedFrom: Array<[string, () => void]> = [
  ['one is followed for each key, asked for what the fields it names hold, and each hears with its own key', () => {
    const { send, calls, deliver, data } = quoted()
    send({ type: 'WATCH', ids: ['a', 'b'] })
    deepStrictEqual(calls, ['follow a in EUR', 'follow b in EUR'])
    deliver('b in EUR', 5)
    deliver('a in EUR', 3)
    deepStrictEqual(data().quotes, { a: 3, b: 5 })
  }],
  ['a field it names changing follows every key again, once each, and stops the ones before, which are no longer heard', () => {
    const { send, calls, deliver, data } = quoted()
    send({ type: 'WATCH', ids: ['a', 'b'] })
    calls.length = 0
    send({ type: 'SET_CURRENCY', currency: 'USD' })
    deepStrictEqual(calls, ['stop a in EUR', 'follow a in USD', 'stop b in EUR', 'follow b in USD'])
    deliver('a in EUR', 99)
    deepStrictEqual(data().quotes, {})
    deliver('a in USD', 4)
    deepStrictEqual(data().quotes, { a: 4 })
  }],
  ['a key that appears or goes follows or stops its own alone, and a field it does not name follows nothing', () => {
    const { send, calls } = quoted()
    send({ type: 'WATCH', ids: ['a'] })
    send({ type: 'WATCH', ids: ['a', 'b'] })
    send({ type: 'SET_NOTE', note: 'a note' })
    send({ type: 'WATCH', ids: ['b'] })
    deepStrictEqual(calls, ['follow a in EUR', 'follow b in EUR', 'stop a in EUR'])
  }],
  ['a key that appears in the step a named field changes is followed once, and one that goes then is not followed again', () => {
    const { send, calls } = quoted()
    send({ type: 'WATCH', ids: ['a', 'b'] })
    calls.length = 0
    send({ type: 'WATCH', ids: ['b', 'c'], currency: 'USD' })
    deepStrictEqual(calls, ['stop a in EUR', 'stop b in EUR', 'follow b in USD', 'follow c in USD'])
  }],
  ['what one of many delivers may not change a field they are followed from round to itself: it comes to rest, reported', () => {
    const { send, calls, deliver, data, defects } = quoted(true)
    send({ type: 'WATCH', ids: ['a', 'b'] })
    calls.length = 0
    // What a's delivers changes what b is followed from, which is one view leading another. It is a's own that is refused.
    deliver('a in EUR', 3)
    deepStrictEqual(calls, ['stop b in EUR', 'follow b in EUR1'])
    strictEqual(defects.length, 1)
    ok(defects[0]!.includes('quotes#quote/a delivered changed a field it is itself asked from'), defects[0])
    // And what b's delivers would lead back to a, which led to it, and to itself: neither is followed again.
    deliver('b in EUR1', 5)
    deepStrictEqual(calls, ['stop b in EUR', 'follow b in EUR1'])
    deepStrictEqual([data().quotes, data().rounds], [{ a: 3, b: 5 }, 2])
    strictEqual(defects.length, 3)
    ok(defects.some((line) => line.includes('what quotes#quote/b delivered changed a field quotes#quote/a is asked from, and quotes#quote/a is what led to quotes#quote/b being asked')), defects.join('\n'))
  }],
  ['what a view for each key is asked for is made of its key alone, and of its key and the fields it names where it names some', () => {
    const made: unknown[][] = []
    const sys = system({ side: 'window', views: () => () => {} })
    sys.start('watcher', state<{ data: { watching: Record<string, true>; currency: string } }>()({
      data: { watching: { a: true }, currency: 'EUR' },
      follows: (follow) => ({
        alone: follow('shop', 'price', { each: 'watching', args: (...given) => { made.push(given); return { id: given[0] } }, updated: () => {} }),
        named: follow('shop', 'price', { each: 'watching', from: ['currency'], args: (...given) => { made.push(given); return { id: given[0] } }, updated: () => {} }),
      }),
    }))
    deepStrictEqual(made, [['a'], ['a', { currency: 'EUR' }]])
    sys.stop()
  }],
]

// ── what a view delivers once it is no longer the one followed ──────────────────────────────────────────────────────

type BoardEvent = { type: 'CURRENCY'; currency: string } | { type: 'WATCH'; ids: string[] } | { type: 'NOTE'; note: string } | { type: 'TURN'; on: boolean }
type Board = {
  data: { currency: string; watching: string[]; note: string; total: number | null; prices: Record<string, number>; shown: number[] }
  states: { on: {}; off: {} }
}
/** Follows a total and a price for each thing watched, while it is on. `amid` is run by each handler, as its step is open. */
const board = (amid: { run?: () => void }) => state<Board, BoardEvent>()({
  data: { currency: 'EUR', watching: [], note: '', total: null, prices: {}, shown: [] },
  initial: 'on',
  on: {
    CURRENCY: ({ currency }) => { amid.run?.(); return { data: { currency } } },
    WATCH: ({ ids }) => { amid.run?.(); return { data: { watching: ids } } },
    NOTE: ({ note }) => ({ data: { note } }),
    TURN: ({ on }) => ({ at: on ? 'on' : 'off' }),
  },
  states: {
    on: {
      follows: (follow) => ({
        total: follow('shop', 'total', {
          from: ['currency'],
          args: ({ currency }) => ({ currency }),
          updated: (update) => (update.ok ? { data: (d) => { d.total = update.value; d.shown.push(update.value) } } : undefined),
        }),
        price: follow('shop', 'price', {
          each: 'watching',
          args: (id) => ({ id }),
          updated: (update, { key }) => (update.ok ? { data: (d) => { d.prices[key] = update.value; d.shown.push(update.value) } } : undefined),
        }),
      }),
    },
    off: {},
  },
})
/** A window whose views are this check's: each one followed is kept, and delivers when the check says, stopped or not. */
const atBoard = (host: { limit?: number } = {}) => {
  const followed: Array<(value: number) => void> = []
  const logs: StepLog[] = []
  const defects: string[] = []
  const amid: { run?: () => void } = {}
  const sys = system({
    side: 'window', ...host,
    views: (_feature, _view, _args, heard) => { followed.push((value) => heard({ ok: true, value })); return () => {} },
    log: (step) => { logs.push(step) },
    onDefect: (defect) => { defects.push(defect.message) },
  })
  const it = sys.start('board', board(amid))
  return {
    sys, followed, defects,
    send: (event: BoardEvent): void => sys.send(it, event),
    now: () => sys.read(it).data,
    /** Runs this while the step that handles the next event is open. */
    during: (run: () => void): void => { amid.run = () => { delete amid.run; run() } },
    steps: (): string[] => logs.map((step) => step.handled.map((one) => `${one.kind} ${one.name}${one.key === undefined ? '' : `/${one.key}`}`).join(', ')),
    numbers: (): number[] => logs.map((step) => step.number),
  }
}
/**
 * A view heard from while it is followed; in the step that follows it again, and after; in the step that stops
 * following it, and after; behind the step that leaves the state, and after.
 */
const shown = (it: ReturnType<typeof atBoard>): void => {
  const { send, followed } = it
  followed[0]!(1)
  it.during(() => followed[0]!(2))
  send({ type: 'CURRENCY', currency: 'USD' })
  followed[0]!(3)
  followed[1]!(4)
  send({ type: 'WATCH', ids: ['a'] })
  followed[2]!(5)
  it.during(() => followed[2]!(6))
  send({ type: 'WATCH', ids: [] })
  followed[2]!(7)
  // As a step ends, the state is told to turn off, and behind that comes an update of what it follows.
  let once = true
  const stop = it.sys.subscribe(() => {
    if (!once) return
    once = false
    send({ type: 'TURN', on: false })
    followed[1]!(8)
  })
  send({ type: 'NOTE', note: 'leaving' })
  stop()
  followed[1]!(9)
  send({ type: 'TURN', on: true })
  followed[3]!(10)
}
/** Every step `shown` takes: one for each event, and one for each update of a view followed when its turn came. */
const SHOWN_STEPS = ['', 'view total', 'event CURRENCY', 'view total', 'event WATCH', 'view price/a', 'event WATCH', 'event NOTE', 'event TURN', 'event TURN', 'view total']

type Feed = { NEWS: { args: {}; progress: string; answer: null } }
const fed = forNet<{ systems: { feed: { events: never; asks: Feed } }; surfaces: {}; views: App['views'] }>()
/** Follows a total and, all the while, hears news as it comes: each list of it is written down as one entry. */
const reader = (heard: string[]) => fed<{ data: { currency: string } }, { type: 'CURRENCY'; currency: string }>()({
  data: { currency: 'EUR' },
  on: { CURRENCY: ({ currency }) => ({ data: { currency } }) },
  follows: (follow) => ({ total: follow('shop', 'total', { from: ['currency'], args: ({ currency }) => ({ currency }), updated: () => {} }) }),
  async run({ ask }) { await ask('feed', 'NEWS', {}, (pieces) => { heard.push(pieces.join('+')) }) },
  failed: () => {},
})

const staleChecks: Array<[string, () => void | Promise<void>]> = [
  ['an update of a view no longer followed does not hand over the progress gathered for the frame', async () => {
    const frames: Array<() => void> = []
    const followed: Array<(value: number) => void> = []
    const heard: string[] = []
    let say: ((piece: string) => void) | undefined
    const sys = system({
      side: 'window',
      frame: (run) => { frames.push(run) },
      views: (_feature, _view, _args, hears) => { followed.push((value) => hears({ ok: true, value })); return () => {} },
    })
    // Sends its news when the check says, and never answers.
    const backend = system({ side: 'backend' })
    backend.start('feed', fed<{}, never, Feed>()({ answers: { NEWS: (_, { progress }) => { say = progress; return new Promise<null>(() => {}) } } }))
    connect(sys, backend)
    const it = sys.start('reader', reader(heard))
    // The news crosses from the backend, so it is gathered in the window some turns after it is said.
    const crossed = async (): Promise<void> => { for (let turn = 0; turn < 5; turn++) await new Promise((resolve) => setTimeout(resolve)) }
    await crossed()
    ok(say, 'the feed was asked')
    // The total is followed again, so what the first following delivers from here on is of a view no longer followed.
    sys.send(it, { type: 'CURRENCY', currency: 'USD' })
    strictEqual(followed.length, 2)
    say('a')
    await crossed()
    strictEqual(frames.length, 1)
    followed[0]!(1)
    say('b')
    await crossed()
    // Nothing that arrived handed it over: both pieces wait for the frame, and come as one list.
    deepStrictEqual(heard, [])
    for (const run of frames.splice(0)) run()
    deepStrictEqual(heard, ['a+b'])
    // One that is followed is something arriving, and what was gathered is handed over ahead of it.
    say('c')
    await crossed()
    followed[1]!(2)
    deepStrictEqual(heard, ['a+b', 'c'])
    sys.stop()
    backend.stop()
  }],

  ['an update of a view no longer followed when its turn comes takes no step, and one of a view followed takes one', () => {
    const it = atBoard()
    shown(it)
    strictEqual(it.followed.length, 4)
    deepStrictEqual(it.steps(), SHOWN_STEPS)
    deepStrictEqual(it.numbers(), SHOWN_STEPS.map((_, at) => at + 1))
    deepStrictEqual(it.now(), { currency: 'USD', watching: [], note: 'leaving', total: 10, prices: { a: 5 }, shown: [1, 4, 5, 10] })
    deepStrictEqual(it.defects, [])
    strictEqual(it.sys.idle(), true)
  }],
  ['an update of a view no longer followed counts for nothing against the limit', () => {
    // Exactly as many steps as it takes: one more, and the last update would be turned away.
    const it = atBoard({ limit: SHOWN_STEPS.length })
    shown(it)
    deepStrictEqual(it.steps(), SHOWN_STEPS)
    deepStrictEqual({ total: it.now().total, shown: it.now().shown, defects: it.defects }, { total: 10, shown: [1, 4, 5, 10], defects: [] })
    // And it was the limit: the next thing is not taken.
    it.send({ type: 'NOTE', note: 'one too many' })
    strictEqual(it.now().note, 'leaving')
    strictEqual(it.defects.length, 1)
  }],
]

await run([...checks, ...moreChecks, ...keyedFrom, ...staleChecks])
