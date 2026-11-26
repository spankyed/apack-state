// Static analysis of states written on the kernel.
//
//   npx tsx tools/graph.mts examples/search.mts           prints one file's graphs
//   npx tsx tools/graph.mts --tsconfig <path> <file...>   prints graphs under a custom tsconfig
//   npm run graph:update                                  writes each example's to etc/graphs/<example>.txt
//   npm run graph:check                                   fails when one of those is not what the source says
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { basename, join as joinPath, resolve } from 'node:path'
import { analyseGraphs, formatGraphs, runGraphCli } from '../src/graph.ts'

const root = resolve(import.meta.dirname, '..')
const EXAMPLES = readdirSync(joinPath(root, 'examples')).filter((name) => name.endsWith('.mts')).sort().map((name) => joinPath(root, 'examples', name))
const argv = process.argv.slice(2)
const writing = argv.includes('--write')
const checking = argv.includes('--check')

const readFileOr = (at: string): string | undefined => { try { return readFileSync(at, 'utf8') } catch { return undefined } }
const recorded = (file: string): string => joinPath(root, 'etc', 'graphs', `${basename(file, '.mts')}.txt`)
const HEADER = '# Generated from the source by `npm run graph:update`; `npm run graph:check` holds it to the source.\n\n'

if (writing || checking) {
  const all = analyseGraphs(EXAMPLES, { tsconfig: joinPath(root, 'tsconfig.json') })
  const stale: string[] = []
  const dir = joinPath(root, 'etc', 'graphs')
  if (writing) mkdirSync(dir, { recursive: true })
  for (const file of EXAMPLES) {
    const text = HEADER + formatGraphs(all.get(file) ?? [])
    const at = recorded(file)
    if (writing) writeFileSync(at, text)
    else if (readFileOr(at) !== text) stale.push(basename(at))
  }
  const kept = new Set(EXAMPLES.map((file) => basename(recorded(file))))
  for (const name of existsSync(dir) ? readdirSync(dir).filter((one) => one.endsWith('.txt') && !kept.has(one)) : []) {
    if (writing) rmSync(joinPath(dir, name))
    else stale.push(`${name} (no example)`)
  }
  if (stale.length) {
    console.error(`Not what the source says: ${stale.join(', ')}. Run npm run graph:update and commit it.`)
    process.exit(1)
  }
  console.log(`${EXAMPLES.length} examples' graphs ${writing ? 'written to etc/graphs/' : 'as the source says'}`)
} else {
  process.exit(runGraphCli(argv))
}
