// Static analysis of states written on the kernel. Nothing here runs one: it asks the TypeScript checker what each
// handler can return, reads the moves off those types, and reads who each state reaches off its code.
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'

/** Options for analysing state graphs from TypeScript source files. */
export interface GraphOptions {
  /** Path to the `tsconfig.json` whose compiler options and path aliases are used. Defaults to the nearest `tsconfig.json`. */
  readonly tsconfig?: string
}

/** Static graph of one state definition, derived from its TypeScript types and AST. */
export interface StateGraph {
  readonly title: string
  readonly states: readonly string[]
  readonly moves: ReadonlyArray<{ readonly from: string; readonly on: string; readonly to: readonly string[] }>
  readonly stays: readonly string[]
  readonly answers: readonly string[]
  readonly starts: readonly string[]
  readonly follows: readonly string[]
  readonly loads: readonly string[]
  readonly calls: readonly string[]
  readonly waits: readonly string[]
  readonly reaches: readonly string[]
  readonly findings: readonly string[]
  readonly text: string
}

type Type = any

const VERBS = new Set(['tell', 'ask', 'broadcast', 'call', 'cancel', 'arm', 'disarm'])

const loadTs = (fromDir: string): any => {
  try { return createRequire(resolve(fromDir, 'package.json'))('typescript') } catch { return createRequire(import.meta.url)('typescript') }
}

/** Formats a file's analysed state graphs into the canonical text form used by `etc/graphs/*.txt`. */
export function formatGraphs(graphs: readonly StateGraph[]): string {
  const joined = graphs.map((graph) => graph.text).join('\n\n')
  return joined ? `${joined}\n` : ''
}

/**
 * Analyses one or more TypeScript files and returns the state graphs found in each (keyed by resolved file path).
 * Detects state definitions by their resolved `State<S, E, A, G>` return type, so `state`, `hostState`, `forNet<Net>()`,
 * or any alias all work identically.
 */
export function analyseGraphs(files: readonly string[], options?: GraphOptions): ReadonlyMap<string, readonly StateGraph[]> {
  const resolved = files.map((file) => resolve(file))
  const missing = resolved.filter((file) => !existsSync(file))
  if (missing.length) throw new Error(`No such file: ${missing.join(', ')}`)

  const baseDir = options?.tsconfig ? dirname(resolve(options.tsconfig)) : resolved[0] ? dirname(resolved[0]) : process.cwd()
  const ts = loadTs(baseDir)

  const configPath = options?.tsconfig
    ? resolve(options.tsconfig)
    : resolved[0] ? ts.findConfigFile(dirname(resolved[0]), ts.sys.fileExists, 'tsconfig.json') : undefined
  if (options?.tsconfig && !existsSync(configPath!)) throw new Error(`No such tsconfig: ${configPath}`)

  const parsed = configPath
    ? ts.getParsedCommandLineOfConfigFile(configPath, {}, { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => {} })
    : undefined
  const program = ts.createProgram(resolved, { ...parsed?.options, noEmit: true })
  const checker = program.getTypeChecker()

  const members = (type: Type): Type[] => (type.isUnion() ? type.types : [type])
  const real = (type: Type): Type[] => members(type).filter((m: Type) => !(m.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Void | ts.TypeFlags.Null | ts.TypeFlags.Never)))
  const typeOf = (symbol: any): Type => checker.getTypeOfSymbol(symbol)
  const unwrap = (type: Type): Type[] => real(type).flatMap((m: Type) => (m.symbol?.name === 'Promise' ? real(checker.getTypeArguments(m)[0]) : [m]))
  const literalsOf = (type: Type): string[] => members(type).filter((m: Type) => m.isStringLiteral()).map((m: Type) => m.value as string)
  const join = (within: string, name: string): string => (within ? `${within}.${name}` : name)

  const isScopeReceiver = (expr: any): boolean => {
    const t = checker.getTypeAtLocation(expr)
    return Boolean(t?.getProperty?.('tell') && t?.getProperty?.('broadcast') && t?.getProperty?.('onExit'))
  }
  const verbOf = (expr: any): string | undefined => {
    if (ts.isIdentifier(expr)) {
      if (VERBS.has(expr.text)) return expr.text
      const decl = checker.getSymbolAtLocation(expr)?.valueDeclaration
      if (decl && ts.isBindingElement(decl) && decl.propertyName && VERBS.has(decl.propertyName.getText())) return decl.propertyName.getText()
    }
    if (ts.isPropertyAccessExpression(expr) && VERBS.has(expr.name.text) && isScopeReceiver(expr.expression)) return expr.name.text
    return undefined
  }
  const unwrapConst = (expr: any): any => {
    const seen = new Set<any>()
    let current = expr
    while (current && !seen.has(current)) {
      seen.add(current)
      while (ts.isParenthesizedExpression(current)) current = current.expression
      if (!ts.isIdentifier(current)) break
      const decl = checker.getSymbolAtLocation(current)?.valueDeclaration
      if (!decl || !ts.isVariableDeclaration(decl) || !(ts.getCombinedNodeFlags(decl) & ts.NodeFlags.Const) || !decl.initializer) break
      current = decl.initializer
    }
    return current
  }
  const isChildCall = (expr: any): boolean =>
    ts.isCallExpression(expr) && expr.arguments.length > 0 && (
      (ts.isIdentifier(expr.expression) && expr.expression.text === 'child')
      || (ts.isPropertyAccessExpression(expr.expression) && expr.expression.name.text === 'child' && isScopeReceiver(expr.expression.expression))
    )
  const hasStaticTarget = (target: any): boolean => {
    const resolvedTarget = unwrapConst(target)
    if (ts.isStringLiteralLike(resolvedTarget)) return true
    if (isChildCall(resolvedTarget)) return hasStaticTarget(resolvedTarget.arguments[0])
    if (ts.isObjectLiteralExpression(resolvedTarget)) {
      const prop = resolvedTarget.properties.find((p: any) =>
        (ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p))
        && (p.name.getText() === 'peer' || p.name.getText() === 'surface'))
      if (prop) return hasStaticTarget(ts.isShorthandPropertyAssignment(prop) ? prop.name : prop.initializer)
    }
    const targetType = checker.getTypeAtLocation(target)
    const nonEmpty = real(targetType)
    return nonEmpty.length > 0 && nonEmpty.every((m: Type) => m.isStringLiteral())
  }
  const isDeclName = (node: any): boolean => {
    const p = node.parent
    if (!p) return false
    if (ts.isPropertyAccessExpression(p) && p.name === node) return true
    if (ts.isBindingElement(p) && (p.name === node || p.propertyName === node)) return true
    return (ts.isParameter(p) || ts.isVariableDeclaration(p) || ts.isPropertyAssignment(p) || ts.isFunctionDeclaration(p) || ts.isMethodDeclaration(p)) && p.name === node
  }

  const analyse = (title: string, shape: Type, events: string[], asks: string[], def: Type, literal: any): StateGraph => {
    const moves: Array<{ from: string; on: string; to: string[] }> = []
    const stays: string[] = []
    const answers: string[] = []
    const takes = new Set<string>()
    const entered = new Set<string>()
    const starts = new Map<string, string>()
    const follows: string[] = []
    const loads: string[] = []
    const calls: string[] = []
    const waits: string[] = []
    const reachesSet = new Set<string>()
    const uncertain = new Set<string>()
    const where = (path: string, name: string): string => (path ? `${name} in ${path}` : name)
    const waitKey = (within: string, name: string): string => `${within}\n${name}`

    const declared: string[] = []
    const startsStates: string[] = []
    const declaredWaits: Array<{ key: string; name: string; within: string }> = []
    const byWaitKey = new Map<string, { key: string; name: string; within: string }>()
    const survey = (of: Type, within: string): void => {
      const started = of.getProperty('starts')
      if (started) for (const each of typeOf(started).getProperties()) startsStates.push(`${each.name}${typeOf(each).getProperty('_each') ? ' (one for each key)' : ''}${within ? ` in ${within}` : ''}`)
      const waited = of.getProperty('waits')
      if (waited) {
        for (const each of typeOf(waited).getProperties()) {
          const entry = { key: waitKey(within, each.name), name: each.name, within }
          declaredWaits.push(entry)
          byWaitKey.set(entry.key, entry)
        }
      }
      const states = of.getProperty('states')
      if (!states) return
      for (const inner of typeOf(states).getProperties()) { declared.push(join(within, inner.name)); survey(typeOf(inner), join(within, inner.name)) }
    }
    survey(shape, '')

    const resolveWait = (fromPath: string, name: string): string | undefined => {
      for (let at = fromPath; ; ) {
        const key = waitKey(at, name)
        if (byWaitKey.has(key)) return key
        if (!at) return undefined
        const cut = at.lastIndexOf('.')
        at = cut >= 0 ? at.slice(0, cut) : ''
      }
    }

    const rootArmed = new Set<string>()
    const waitEdges = new Map<string, Set<string>>()
    const armedByWait = new Map<string, Set<string>>()
    let hasDynamicArm = false
    const scan = (inner: any, statePath: string, fromWaitKey?: string): void => {
      if (!isDeclName(inner)) {
        const p = inner.parent
        if (verbOf(inner) === 'arm' && !(p && ts.isCallExpression(p) && p.expression === inner)) {
          hasDynamicArm = true
        } else if (ts.isIdentifier(inner) && isScopeReceiver(inner)
          && !(p && ts.isPropertyAccessExpression(p) && p.expression === inner)
          && !(p && ts.isVariableDeclaration(p) && p.initializer === inner && ts.isObjectBindingPattern(p.name))) {
          hasDynamicArm = true
        }
      }
      if (ts.isCallExpression(inner) && inner.arguments[0]) {
        const verb = verbOf(inner.expression)
        if (verb) {
          const target = inner.arguments[0]
          const resolvedTarget = unwrapConst(target)
          reachesSet.add(`${verb} ${isChildCall(resolvedTarget) ? `its ${resolvedTarget.arguments[0].getText()}` : target.getText()}`)
          if (!hasStaticTarget(target)) {
            uncertain.add(`dynamic target in ${verb} ${target.getText()}`)
            if (verb === 'arm') hasDynamicArm = true
          } else if (verb === 'arm') {
            const names: string[] = []
            if (ts.isStringLiteralLike(resolvedTarget)) names.push(resolvedTarget.text)
            else for (const m of real(checker.getTypeAtLocation(target))) if (m.isStringLiteral()) names.push(m.value as string)
            for (const armedName of names) {
              const targetKey = resolveWait(statePath, armedName)
              if (!targetKey) continue
              if (fromWaitKey === undefined) {
                rootArmed.add(targetKey)
              } else {
                let out = waitEdges.get(fromWaitKey)
                if (!out) { out = new Set(); waitEdges.set(fromWaitKey, out) }
                out.add(targetKey)
                let inc = armedByWait.get(targetKey)
                if (!inc) { inc = new Set(); armedByWait.set(targetKey, inc) }
                inc.add(fromWaitKey)
              }
            }
          }
        }
      }
      ts.forEachChild(inner, (child: any) => scan(child, statePath, fromWaitKey))
    }

    const read = (returned: Type[], path: string, on: string): void => {
      const to = new Set<string>()
      let dynamicAt: string | undefined
      for (const value of returned) {
        const at = value.getProperty?.('at')
        if (!at) continue
        const atType = typeOf(at)
        for (const member of real(atType)) {
          if (member.isStringLiteral()) to.add(member.value as string)
          else dynamicAt = checker.typeToString(atType)
        }
      }
      if (dynamicAt !== undefined) uncertain.add(`dynamic move target in ${where(path, on)} (at is ${dynamicAt})`)
      if (to.size) moves.push({ from: path || 'anywhere', on, to: [...to] })
      else if (dynamicAt === undefined) stays.push(where(path, on))
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
        } else if (property.name === 'answers') {
          for (const handler of type.getProperties()) {
            takes.add(handler.name)
            answers.push(where(path, handler.name))
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
        } else if (property.name === 'initial') {
          for (const at of literalsOf(type)) starts.set(path, at)
        } else if (property.name === 'states') {
          for (const inner of type.getProperties()) { const innerType = real(typeOf(inner))[0]; if (innerType) walk(innerType, join(path, inner.name)) }
        }
      }
    }
    walk(def, '')

    const text = (node: any): string => (ts.isStringLiteralLike(node) ? node.text : node.getText())
    const isInlineFn = (node: any): boolean => {
      let cur = node
      while (cur && ts.isParenthesizedExpression(cur)) cur = cur.expression
      return Boolean(cur && (ts.isArrowFunction(cur) || ts.isFunctionExpression(cur)))
    }
    const isInlineHandlerProp = (prop: any): boolean =>
      ts.isMethodDeclaration(prop) || (ts.isPropertyAssignment(prop) && isInlineFn(prop.initializer))
    let hasOpaqueHandler = false
    const declarations = (object: any, path: string): void => {
      for (const property of object.properties) {
        if (ts.isSpreadAssignment(property)) {
          uncertain.add(`spread in ${path || 'definition'} could not be statically read`)
          scan(property.expression, path)
          continue
        }
        if (!ts.isPropertyAssignment(property) && !ts.isShorthandPropertyAssignment(property) && !ts.isMethodDeclaration(property)) {
          scan(property, path)
          continue
        }
        const name = text(property.name)
        const made = ts.isPropertyAssignment(property) ? property.initializer : undefined
        if (name === 'on' || name === 'internal' || name === 'answers') {
          if (!made || !ts.isObjectLiteralExpression(made) || made.properties.some((p: any) => !isInlineHandlerProp(p))) hasOpaqueHandler = true
          scan(property, path)
          continue
        }
        if (name === 'listen' || name === 'run' || name === 'failed') {
          if (!isInlineHandlerProp(property)) hasOpaqueHandler = true
          scan(property, path)
          continue
        }
        if (name === 'states') {
          if (!made || !ts.isObjectLiteralExpression(made)) {
            uncertain.add(`could not statically read ${where(path, 'states')}`)
            scan(property, path)
            continue
          }
          for (const inner of made.properties) {
            if (ts.isSpreadAssignment(inner)) {
              uncertain.add(`spread in ${where(path, 'states')} could not be statically read`)
              scan(inner, path)
            } else if (ts.isPropertyAssignment(inner)) {
              const subName = text(inner.name)
              if (ts.isObjectLiteralExpression(inner.initializer)) declarations(inner.initializer, join(path, subName))
              else { uncertain.add(`could not statically read ${join(path, subName)}`); scan(inner, path) }
            } else if (ts.isShorthandPropertyAssignment(inner)) {
              uncertain.add(`could not statically read ${join(path, text(inner.name))}`)
              scan(inner, path)
            } else {
              scan(inner, path)
            }
          }
          continue
        }
        if (name !== 'follows' && name !== 'loads' && name !== 'calls' && name !== 'waits') {
          scan(property, path)
          continue
        }
        if (!made || !ts.isArrowFunction(made)) {
          uncertain.add(`could not statically read ${where(path, name)}`)
          scan(property, path)
          continue
        }
        let body = made.body
        while (ts.isParenthesizedExpression(body)) body = body.expression
        if (!ts.isObjectLiteralExpression(body)) {
          uncertain.add(`could not statically read ${where(path, name)}`)
          scan(property, path)
          continue
        }
        for (const entry of body.properties) {
          if (ts.isSpreadAssignment(entry)) {
            uncertain.add(`spread in ${where(path, name)} could not be statically read`)
            scan(entry, path)
            continue
          }
          if (!ts.isPropertyAssignment(entry) || !ts.isCallExpression(entry.initializer)) {
            uncertain.add(`could not statically read ${where(path, `${name}.${entry.name ? text(entry.name) : '?'}`)}`)
            scan(entry, path)
            continue
          }
          const entryName = text(entry.name)
          if (name === 'waits') {
            scan(entry.initializer, path, waitKey(path, entryName))
            const [first, second] = entry.initializer.arguments
            const helper = entry.initializer.expression.getText()
            const hasMs = Boolean(first && (checker.getTypeAtLocation(first).flags & ts.TypeFlags.NumberLike))
            const rest = hasMs ? second : first
            let noReset = false
            if (rest && ts.isObjectLiteralExpression(rest)) {
              if (rest.properties.some((p: any) => ts.isSpreadAssignment(p))) {
                uncertain.add(`spread in ${where(path, `waits.${entryName}`)} could not be statically read`)
              }
              const resetProp = rest.properties.find((each: any) => each.name && text(each.name) === 'reset')
              const resetInit = resetProp && ts.isPropertyAssignment(resetProp) ? resetProp.initializer : undefined
              if (resetInit && resetInit.kind === ts.SyntaxKind.FalseKeyword) noReset = true
              const doneProp = rest.properties.find((each: any) => each.name && text(each.name) === 'done')
              if (doneProp && !isInlineHandlerProp(doneProp)) hasOpaqueHandler = true
              const signature = doneProp && checker.getTypeAtLocation(doneProp.initializer ?? doneProp).getCallSignatures()[0]
              if (signature) read(unwrap(signature.getReturnType()), path, `${entryName} (done)`)
            } else if (rest) {
              if (!isInlineFn(rest)) hasOpaqueHandler = true
              const restType = checker.getTypeAtLocation(rest)
              const sigs = restType.getCallSignatures()
              if (sigs.length) {
                read(unwrap(sigs[0].getReturnType()), path, `${entryName} (done)`)
              } else {
                const doneProp = restType.getProperty?.('done')
                const sig = doneProp && real(typeOf(doneProp))[0]?.getCallSignatures()[0]
                if (sig) read(unwrap(sig.getReturnType()), path, `${entryName} (done)`)
                else if (restType.flags & ts.TypeFlags.Any) uncertain.add(`could not statically read ${where(path, `waits.${entryName}`)}`)
              }
            }
            const msLabel = hasMs ? (ts.isNumericLiteral(first) ? `${first.text}ms` : text(first)) : 'ms at arm'
            waits.push(`${entryName}${path ? ` in ${path}` : ''}: ${msLabel}, ${helper === 'each' ? 'for each key it is told' : 'one at a time'}${noReset ? ', no reset' : ''}`)
            continue
          }
          scan(entry.initializer, path)
          const [first, second, opts] = entry.initializer.arguments
          if (!first || !second || !opts || !ts.isObjectLiteralExpression(opts)) {
            uncertain.add(`could not statically read ${where(path, `${name}.${entryName}`)}`)
            continue
          }
          const option = (key: string): any => opts.properties.find((each: any) => each.name && text(each.name) === key)
          const valueOf = (prop: any): any => prop && (prop.initializer ?? prop.name)
          const each = valueOf(option('each'))
          const from = valueOf(option('from'))
          const helper = entry.initializer.expression.getText()
          const depends = name === 'calls' ? (helper === 'each' ? 'for each key it is told' : helper === 'many' ? 'many at once' : 'one at a time')
            : each ? `one for each key of ${text(each)}`
            : from && ts.isArrayLiteralExpression(from) ? (from.elements.length ? `from ${from.elements.map(text).join(', ')}` : 'from nothing: once')
            : from ? `from what ${text(from)} names` : 'from nothing: once'
          ;(name === 'follows' ? follows : name === 'loads' ? loads : calls).push(`${entryName}${path ? ` in ${path}` : ''}: ${text(first)} ${text(second)}, ${depends}`)
          for (const hears of name === 'follows' ? ['updated'] : ['done', 'progress']) {
            const handler = option(hears)
            if (handler && !isInlineHandlerProp(handler)) hasOpaqueHandler = true
            const signature = handler && checker.getTypeAtLocation(handler.initializer ?? handler).getCallSignatures()[0]
            if (signature) read(unwrap(signature.getReturnType()), path, `${entryName} (${hears})`)
          }
        }
      }
    }
    if (literal && ts.isObjectLiteralExpression(literal)) {
      declarations(literal, '')
    } else {
      uncertain.add('definition is not an inline object literal; reaches, follows, loads, calls, and waits could not be scanned')
    }

    const gone = new Set<string>()
    const enter = (path: string): void => {
      for (let at = path; ; ) {
        if (gone.has(at)) break
        gone.add(at)
        if (at) { entered.add(at); for (let cut = at.lastIndexOf('.'); cut > 0; cut = at.lastIndexOf('.', cut - 1)) entered.add(at.slice(0, cut)) }
        const next = starts.get(at)
        if (next === undefined) break
        at = join(at, next)
      }
    }
    enter('')
    for (const move of moves) for (const target of move.to) enter(target)

    const liveWaits = new Set<string>(rootArmed)
    const queue = [...rootArmed]
    while (queue.length) {
      const cur = queue.shift()!
      for (const next of waitEdges.get(cur) ?? []) {
        if (!liveWaits.has(next)) {
          liveWaits.add(next)
          queue.push(next)
        }
      }
    }

    const reaches = [...reachesSet]
    const findings: string[] = []
    for (const taken of [...events, ...asks]) if (!takes.has(taken)) findings.push(`nothing takes ${taken}`)
    for (const name of declared) if (!entered.has(name)) findings.push(`${name} is never entered`)
    if (literal && ts.isObjectLiteralExpression(literal) && !hasDynamicArm && !hasOpaqueHandler && !uncertain.size) {
      for (const w of declaredWaits) {
        if (liveWaits.has(w.key)) continue
        const sources = [...(armedByWait.get(w.key) ?? [])]
        const others = sources
          .filter((source) => source !== w.key)
          .map((source) => {
            const from = byWaitKey.get(source)
            return from ? where(from.within, from.name) : source.slice(source.indexOf('\n') + 1)
          })
        const label = where(w.within, w.name)
        if (!sources.length) findings.push(`nothing arms ${label}`)
        else if (!others.length) findings.push(`nothing arms ${label} except its own done`)
        else findings.push(`nothing arms ${label} except the done of ${[...(sources.includes(w.key) ? [label] : []), ...others].join(', ')}, which nothing arms`)
      }
    }
    for (const note of uncertain) findings.push(note)

    const lines: string[] = [title]
    if (declared.length) lines.push(`  states: ${declared.join(', ')}`)
    for (const move of moves) lines.push(`    ${move.from.padEnd(16)} ${move.on.padEnd(18)} → ${move.to.join(' | ')}`)
    if (stays.length) lines.push(`  changes data only: ${stays.join(', ')}`)
    if (answers.length) lines.push(`  answers: ${answers.join(', ')}`)
    if (startsStates.length) lines.push(`  starts: ${startsStates.join(', ')}`)
    for (const followed of follows) lines.push(`  follows ${followed}`)
    for (const loaded of loads) lines.push(`  loads   ${loaded}`)
    for (const called of calls) lines.push(`  calls   ${called}`)
    for (const waited of waits) lines.push(`  waits   ${waited}`)
    if (reaches.length) lines.push(`  reaches: ${reaches.join(', ')}`)
    lines.push(`  findings: ${findings.length ? findings.join('; ') : 'none'}`)

    return {
      title, states: declared, moves, stays, answers, starts: startsStates, follows, loads, calls, waits, reaches, findings,
      text: lines.join('\n').replaceAll('\r\n', '\n'),
    }
  }

  const results = new Map<string, readonly StateGraph[]>()
  for (const file of resolved) {
    const graphs: StateGraph[] = []
    const visit = (node: any): void => {
      if (ts.isCallExpression(node) && ts.isCallExpression(node.expression)
        && node.arguments.length === 1
        && !node.getFullText().includes('@ts-expect-error')) {
        const returned = checker.getTypeAtLocation(node)
        if (returned.symbol?.name === 'State' && returned.getProperty('def') && returned.getProperty('_')) {
          const [shapeType, eventType, askType] = checker.getTypeArguments(returned)
          if (shapeType) {
            const titleNode = node.expression.typeArguments?.[0]
            const title = titleNode ? titleNode.getText() : checker.typeToString(shapeType)
            const events = eventType ? members(eventType).flatMap((m: Type) => { const t = m.getProperty?.('type'); return t ? literalsOf(typeOf(t)) : [] }) : []
            const asks = askType ? askType.getProperties().map((p: any) => p.name as string) : []
            const arg = node.arguments[0]
            graphs.push(analyse(title, shapeType, events, asks, checker.getTypeAtLocation(arg), arg))
          }
        }
      }
      ts.forEachChild(node, visit)
    }
    const source = program.getSourceFile(file)
    if (source) visit(source)
    results.set(file, graphs)
  }
  return results
}

/** Runs the `apack-state-graph` CLI (`[--tsconfig <path>] <file...>`), returning the exit code. */
export function runGraphCli(
  argv: readonly string[],
  io: { readonly out?: (text: string) => void; readonly err?: (text: string) => void } = {},
): number {
  const out = io.out ?? ((text: string) => { process.stdout.write(text) })
  const err = io.err ?? ((text: string) => { process.stderr.write(text) })
  let tsconfig: string | undefined
  const files: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    if (arg === '--tsconfig') {
      const next = argv[++i]
      if (!next) { err('Missing path after --tsconfig\n'); return 1 }
      tsconfig = next
    } else if (arg.startsWith('--tsconfig=')) {
      const value = arg.slice('--tsconfig='.length)
      if (!value) { err('Missing path after --tsconfig=\n'); return 1 }
      tsconfig = value
    } else if (arg.startsWith('--')) {
      err(`Unknown option: ${arg}\n`)
      return 1
    } else {
      files.push(arg)
    }
  }
  if (!files.length) {
    err("Name a file to print its graphs, or give --tsconfig <path> <file...>.\n")
    return 1
  }
  try {
    const all = analyseGraphs(files, tsconfig ? { tsconfig } : undefined)
    for (const graphs of all.values()) out(formatGraphs(graphs))
    return 0
  } catch (error) {
    err(`${error instanceof Error ? error.message : String(error)}\n`)
    return 1
  }
}
