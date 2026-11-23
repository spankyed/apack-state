// What a measurement records beside what it prints: each reading by name, value and unit, under the section it is in.
// Run by `npm run bench`, which names a file in `BENCH_OUT`, the readings are written there as the process ends;
// run alone, they are only printed.
import { writeFileSync } from 'node:fs'

export interface Reading { readonly name: string; readonly value: number; readonly unit: string }
const readings: Reading[] = []
let section = ''

/** The section what follows is read under: a heading, as it is printed. */
export const under = (heading: string): void => { section = heading.trim() }
/** One reading. */
export const reading = (name: string, value: number, unit: string): void => {
  readings.push({ name: section ? `${section}: ${name.trim()}` : name.trim(), value, unit })
}

process.on('exit', () => {
  const out = process.env.BENCH_OUT
  if (out) writeFileSync(out, `${JSON.stringify(readings, null, 2)}\n`)
})
