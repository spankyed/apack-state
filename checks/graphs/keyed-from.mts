// What is loaded and followed one for each key of a field, and again from the fields it names beside it.
import { forNet } from '../../src/index.ts'

type Net = {
  systems: { repo: { events: never; asks: { DIFF: { args: { path: string; rev: number }; answer: string } } } }
  surfaces: {}
  views: { repo: { blame: { args: { path: string; rev: number }; result: string } } }
}
const state = forNet<Net>()
export const diffs = state<{ data: { open: Record<string, string>; blamed: Record<string, string>; rev: number; depth: number } }, never>()({
  data: { open: {}, blamed: {}, rev: 0, depth: 0 },
  loads: (load) => ({
    diff: load('repo', 'DIFF', { each: 'open', from: ['rev', 'depth'], args: (path, { rev }) => ({ path, rev }), done: (outcome, { key }) => (outcome.ok ? { data: (d) => { d.open[key] = outcome.value } } : undefined) }),
    // Named nothing beside its keys, which is one for each key and no more.
    once: load('repo', 'DIFF', { each: 'open', from: [], args: (path) => ({ path, rev: 0 }), done: () => {} }),
  }),
  follows: (follow) => ({
    blame: follow('repo', 'blame', { each: 'open', from: ['rev'], args: (path, { rev }) => ({ path, rev }), updated: (update, { key }) => (update.ok ? { data: (d) => { d.blamed[key] = update.value } } : undefined) }),
  }),
})
