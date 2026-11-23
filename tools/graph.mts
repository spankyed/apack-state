// Static analysis of states written on the kernel. Nothing here runs one: it asks the TypeScript checker what each
// handler can return, reads the moves off those types, and reads who each state reaches off its code.
//
//   npx tsx tools/graph.mts examples/search.mts    prints one file's graphs
//   npm run graph:update                           writes each example's to etc/graphs/<example>.txt
//   npm run graph:check                            fails when one of those is not what the source says
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { basename, join as joinPath, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const ts = createRequire(joinPath(root, 'package.json'))('typescript')
/** The examples a graph is recorded for: each that is not a stand-in. */
const EXAMPLES = readdirSync(joinPath(root, 'examples')).filter((name) => name.endsWith('.mts')).sort().map((name) => joinPath(root, 'examples', name))
const files = process.argv.slice(2).filter((arg) => !arg.startsWith('--')).map((arg) => resolve(arg))
const program = ts.createProgram(files.length ? files : EXAMPLES, {
  strict: true, noEmit: true, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler, allowImportingTsExtensions: true, skipLibCheck: true, types: ['node'],
})
const checker = program.getTypeChecker()
/** What is said of the file being read, a line at a time. */
let out: string[] = []
const say = (line: string): void => { out.push(line) }

type Type = any
const members = (type: Type): Type[] => (type.isUnion() ? type.types : [type])
const real = (type: Type): Type[] => members(type).filter((m: Type) => !(m.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Void | ts.TypeFlags.Null | ts.TypeFlags.Never)))
const typeOf = (symbol: any): Type => checker.getTypeOfSymbol(symbol)
const unwrap = (type: Type): Type[] => real(type).flatMap((m: Type) => (m.symbol?.name === 'Promise' ? real(checker.getTypeArguments(m)[0]) : [m]))
const literalsOf = (type: Type): string[] => members(type).filter((m: Type) => m.isStringLiteral()).map((m: Type) => m.value as string)
const join = (within: string, name: string): string => (within ? `${within}.${name}` : name)

function analyse(title: string, shape: Type, events: string[], asks: string[], def: Type, reaches: string[], literal: any): void {
  const moves: Array<{ from: string; on: string; to: string[] }> = []
  const stays: string[] = []
  const answers: string[] = []
  const takes = new Set<string>()
  const entered = new Set<string>()
  const starts = new Map<string, string>()
  const follows: string[] = []
  const awaits: string[] = []
  const makes: string[] = []
  const where = (path: string, name: string): string => (path ? `${name} in ${path}` : name)

  /** A returned value that says `at` is a move to that path. Anything else changes data and stays. */
  const read = (returned: Type[], path: string, on: string): void => {
    const to = new Set<string>()
    for (const value of returned) { const at = value.getProperty?.('at'); if (at) for (const target of literalsOf(typeOf(at))) to.add(target) }
    if (to.size) moves.push({ from: path || 'anywhere', on, to: [...to] })
    else stays.push(where(path, on))
  }

  const walk = (level: Type, path: string): void => {
    for (const property of level.getProperties()) {
      const type = real(typeOf(property))[0]
      if (!type) continue
      if (property.name === 'on' || property.name === 'internal') {
        for (const handler of type.getProperties()) {
          takes.add(handler.name)
          const signature = real(typeOf(handler))[0]?.getCallSignatures()[0]
          if (signature) read(unwrap(signature.getReturnType()), path, handler.name)
        }
      } else if (property.name === 'asks') {
        for (const handler of type.getProperties()) {
          takes.add(handler.name)
          answers.push(where(path, handler.name))
          // An answer that comes with a change: `answered(answer, next)`. Its `next` is read as any handler's return is.
          const signature = real(typeOf(handler))[0]?.getCallSignatures()[0]
          const changes = signature ? unwrap(signature.getReturnType()).filter((value: Type) => value.getProperty?.('next') && value.getProperty?.('answer')) : []
          if (changes.length) read(changes.flatMap((value: Type) => real(typeOf(value.getProperty('next')))), path, `${handler.name} (answering)`)
        }
      } else if (property.name === 'run') {
        const returned = type.getCallSignatures()[0] ? unwrap(type.getCallSignatures()[0].getReturnType()) : []
        if (returned.length) read(returned, path, '(its work ends)')
      } else if (property.name === 'failed') {
        const signature = type.getCallSignatures()[0]
        if (signature) read(unwrap(signature.getReturnType()), path, '(its work fails)')
      } else if (property.name === 'start') {
        for (const at of literalsOf(type)) starts.set(path, at)
      } else if (property.name === 'states') {
        for (const inner of type.getProperties()) { const innerType = real(typeOf(inner))[0]; if (innerType) walk(innerType, join(path, inner.name)) }
      }
    }
  }
  walk(def, '')

  // What it follows and awaits is read from the definition as written: each entry is a call that names what it is
  // of and the fields it depends on, which is why those are named and not worked out.
  const text = (node: any): string => (ts.isStringLiteralLike(node) ? node.text : node.getText())
  const declarations = (object: any, path: string): void => {
    for (const property of object.properties) {
      if (!ts.isPropertyAssignment(property) && !ts.isMethodDeclaration(property)) continue
      const name = property.name.getText()
      const made = ts.isPropertyAssignment(property) ? property.initializer : undefined
      if (name === 'states' && made && ts.isObjectLiteralExpression(made)) {
        for (const inner of made.properties) if (ts.isPropertyAssignment(inner) && ts.isObjectLiteralExpression(inner.initializer)) declarations(inner.initializer, join(path, inner.name.getText()))
      }
      if ((name !== 'follows' && name !== 'awaits' && name !== 'makes') || !made || !ts.isArrowFunction(made)) continue
      let body = made.body
      while (ts.isParenthesizedExpression(body)) body = body.expression
      if (!ts.isObjectLiteralExpression(body)) continue
      for (const entry of body.properties) {
        if (!ts.isPropertyAssignment(entry) || !ts.isCallExpression(entry.initializer)) continue
        const [first, second, options] = entry.initializer.arguments
        if (!first || !second || !options || !ts.isObjectLiteralExpression(options)) continue
        const option = (key: string): any => options.properties.find((each: any) => each.name?.getText() === key)
        const each = option('each')
        const from = option('from')
        // An ask that is made is made when a handler says so: with `each` for one of many keys, with `one` for one at a time.
        const depends = name === 'makes' ? (entry.initializer.expression.getText() === 'each' ? 'for each key it is told' : 'one at a time')
          : each ? `one for each key of ${text(each.initializer)}`
          : from && ts.isArrayLiteralExpression(from.initializer) && from.initializer.elements.length ? `from ${from.initializer.elements.map(text).join(', ')}` : 'from nothing: once'
        ;(name === 'follows' ? follows : name === 'awaits' ? awaits : makes).push(`${entry.name.getText()}${path ? ` in ${path}` : ''}: ${text(first)} ${text(second)}, ${depends}`)
        for (const hears of name === 'follows' ? ['heard'] : ['ended', 'heard']) {
          const handler = option(hears)
          const signature = handler && checker.getTypeAtLocation(handler.initializer ?? handler).getCallSignatures()[0]
          if (signature) read(unwrap(signature.getReturnType()), path, `${entry.name.getText()} (${hears === 'ended' ? 'ending' : 'hearing'})`)
        }
      }
    }
  }
  declarations(literal, '')

  /** Entering a state also enters the one it starts at, and so on down. */
  const enter = (path: string): void => {
    for (let at = path; ; ) {
      if (at) { if (entered.has(at)) break; entered.add(at); for (let cut = at.lastIndexOf('.'); cut > 0; cut = at.lastIndexOf('.', cut - 1)) entered.add(at.slice(0, cut)) }
      const next = starts.get(at)
      if (next === undefined) break
      at = join(at, next)
    }
  }
  enter('')
  for (const move of moves) for (const target of move.to) enter(target)

  const declared: string[] = []
  const startsStates: string[] = []
  const survey = (of: Type, within: string): void => {
    // What it starts is declared in the shape: a state, or one for each key.
    const started = of.getProperty('starts')
    if (started) for (const each of typeOf(started).getProperties()) startsStates.push(`${each.name}${typeOf(each).getProperty('_each') ? ' (one for each key)' : ''}${within ? ` in ${within}` : ''}`)
    const states = of.getProperty('states')
    if (!states) return
    for (const inner of typeOf(states).getProperties()) { declared.push(join(within, inner.name)); survey(typeOf(inner), join(within, inner.name)) }
  }
  survey(shape, '')

  say(`\n${title}`)
  if (declared.length) say(`  states: ${declared.join(', ')}`)
  for (const move of moves) say(`    ${move.from.padEnd(16)} ${move.on.padEnd(18)} → ${move.to.join(' | ')}`)
  if (stays.length) say(`  changes data only: ${stays.join(', ')}`)
  if (answers.length) say(`  answers: ${answers.join(', ')}`)
  if (startsStates.length) say(`  starts: ${startsStates.join(', ')}`)
  for (const followed of follows) say(`  follows ${followed}`)
  for (const awaited of awaits) say(`  awaits  ${awaited}`)
  for (const made of makes) say(`  makes   ${made}`)
  if (reaches.length) say(`  reaches: ${reaches.join(', ')}`)
  const findings: string[] = []
  for (const taken of [...events, ...asks]) if (!takes.has(taken)) findings.push(`nothing takes ${taken}`)
  for (const name of declared) if (!entered.has(name)) findings.push(`${name} is never entered`)
  say(`  findings: ${findings.length ? findings.join('; ') : 'none'}`)
}

const VERBS = new Set(['tell', 'ask', 'broadcast', 'make', 'drop'])
const visit = (node: any): void => {
  // state<Shape, Events, Asks>()(definition)
  if (ts.isCallExpression(node) && ts.isCallExpression(node.expression) && ts.isIdentifier(node.expression.expression)
    && node.expression.expression.text === 'state' && node.expression.typeArguments?.length && node.arguments.length === 1 && ts.isObjectLiteralExpression(node.arguments[0])
    // A definition written to show what does not compile is not one to describe.
    && !node.getFullText().includes('@ts-expect-error')) {
    const [shapeNode, eventNode, askNode] = node.expression.typeArguments
    const eventType = eventNode ? checker.getTypeFromTypeNode(eventNode) : undefined
    const events = eventType ? members(eventType).flatMap((m: Type) => { const t = m.getProperty?.('type'); return t ? literalsOf(typeOf(t)) : [] }) : []
    const asks = askNode ? checker.getTypeFromTypeNode(askNode).getProperties().map((p: any) => p.name as string) : []
    const reaches = new Set<string>()
    const scan = (inner: any): void => {
      if (ts.isCallExpression(inner) && ts.isIdentifier(inner.expression) && VERBS.has(inner.expression.text) && inner.arguments[0]) {
        const target = inner.arguments[0]
        reaches.add(`${inner.expression.text} ${ts.isCallExpression(target) ? `its ${target.arguments[0].getText()}` : target.getText()}`)
      }
      ts.forEachChild(inner, scan)
    }
    scan(node.arguments[0])
    analyse(shapeNode.getText(), checker.getTypeFromTypeNode(shapeNode), events, asks, checker.getTypeAtLocation(node.arguments[0]), [...reaches], node.arguments[0])
  }
  ts.forEachChild(node, visit)
}
/** Every graph one file holds, as text. */
const graphsOf = (file: string): string => {
  out = []
  visit(program.getSourceFile(file)!)
  return `${out.join('\n').trim()}\n`
}

const recorded = (file: string): string => joinPath(root, 'etc', 'graphs', `${basename(file, '.mts')}.txt`)
const HEADER = '# Generated from the source by `npm run graph:update`; `npm run graph:check` holds it to the source.\n\n'
if (process.argv.includes('--write') || process.argv.includes('--check')) {
  const stale: string[] = []
  mkdirSync(joinPath(root, 'etc', 'graphs'), { recursive: true })
  for (const file of EXAMPLES) {
    const text = HEADER + graphsOf(file)
    const at = recorded(file)
    if (process.argv.includes('--write')) writeFileSync(at, text)
    else if (readFileOr(at) !== text) stale.push(basename(at))
  }
  if (stale.length) {
    console.error(`Not what the source says: ${stale.join(', ')}. Run npm run graph:update and commit it.`)
    process.exit(1)
  }
  console.log(`${EXAMPLES.length} examples' graphs ${process.argv.includes('--write') ? 'written to etc/graphs/' : 'as the source says'}`)
} else {
  for (const file of files) process.stdout.write(graphsOf(file))
}
function readFileOr(at: string): string | undefined { try { return readFileSync(at, 'utf8') } catch { return undefined } }
