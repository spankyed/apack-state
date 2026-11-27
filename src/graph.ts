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
  const isScopeBinding = (decl: any): boolean =>
    Boolean(decl && ts.isBindingElement(decl) && ts.isObjectBindingPattern(decl.parent) && isScopeReceiver(decl.parent))
  const verbOf = (expr: any): string | undefined => {
    if (ts.isIdentifier(expr)) {
      const sym = expr.parent && ts.isShorthandPropertyAssignment(expr.parent) && expr.parent.name === expr
        ? checker.getShorthandAssignmentValueSymbol(expr.parent)
        : checker.getSymbolAtLocation(expr)
      const decl = sym?.valueDeclaration
      if (isScopeBinding(decl)) {
        const key = decl.propertyName
          ? (ts.isIdentifier(decl.propertyName) || ts.isStringLiteralLike(decl.propertyName) ? decl.propertyName.text : decl.propertyName.getText())
          : expr.text
        if (VERBS.has(key)) return key
      } else if (!decl && VERBS.has(expr.text)) {
        return expr.text
      }
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
    // What could arm a wait and cannot be read is kept by where it is, since an `arm` reaches only the waits its own
    // state and the states around it declare: `unreadArms` holds the state each is written in. What cannot be placed
    // (a part of the definition that could not be read, a move to a state that is not known) sets `unplaced`, and
    // then no wait is said to be unarmed.
    const unreadArms = new Set<string>()
    let unplaced = false
    const unread = (note: string): void => { uncertain.add(note); unplaced = true }
    // Whether every way into a state has been read. A handler whose return could not be read, or an `initial` that
    // is not one name, may enter a state nothing else is seen to enter, and then an `arm` counts wherever it is.
    let entryKnown = true
    const returnedBy = (handler: Type | undefined): Type[] | undefined => {
      if (!handler) return undefined
      const signatures = handler.getCallSignatures()
      const values = signatures.length ? unwrap(signatures[0].getReturnType()) : undefined
      if (signatures.length !== 1 || values!.some((value: Type) => value.flags & ts.TypeFlags.Any)) entryKnown = false
      return values
    }
    /** The one function a handler is. One that may be either of two is read as its first, and the other may enter anything. */
    const handlerOf = (property: any): Type | undefined => {
      const kinds = real(typeOf(property))
      if (kinds.length !== 1) entryKnown = false
      return kinds[0]
    }
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

    const rawArms: Array<{ statePath: string; targetKey: string; fromWaitKey?: string }> = []
    const scan = (inner: any, statePath: string, fromWaitKey?: string): void => {
      if (!isDeclName(inner)) {
        const p = inner.parent
        if (verbOf(inner) === 'arm' && !(p && ts.isCallExpression(p) && p.expression === inner)) {
          unreadArms.add(statePath)
        } else if (ts.isIdentifier(inner) && isScopeReceiver(inner)
          && !(p && ts.isPropertyAccessExpression(p) && p.expression === inner)
          && !(p && ts.isVariableDeclaration(p) && p.initializer === inner && ts.isObjectBindingPattern(p.name))) {
          unreadArms.add(statePath)
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
            if (verb === 'arm') unreadArms.add(statePath)
          } else if (verb === 'arm') {
            const names: string[] = []
            if (ts.isStringLiteralLike(resolvedTarget)) names.push(resolvedTarget.text)
            else for (const m of real(checker.getTypeAtLocation(target))) if (m.isStringLiteral()) names.push(m.value as string)
            for (const armedName of names) {
              const targetKey = resolveWait(statePath, armedName)
              if (targetKey) rawArms.push({ statePath, targetKey, fromWaitKey })
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
      if (dynamicAt !== undefined) unread(`dynamic move target in ${where(path, on)} (at is ${dynamicAt})`)
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
            const returned = returnedBy(handlerOf(handler))
            if (returned) read(returned, path, handler.name)
          }
        } else if (property.name === 'answers') {
          for (const handler of type.getProperties()) {
            takes.add(handler.name)
            answers.push(where(path, handler.name))
            const changes = (returnedBy(handlerOf(handler)) ?? []).filter((value: Type) => value.getProperty?.('next') && value.getProperty?.('answer'))
            if (changes.length) read(changes.flatMap((value: Type) => real(typeOf(value.getProperty('next')))), path, `${handler.name} (answering)`)
          }
        } else if (property.name === 'run') {
          const returned = returnedBy(type) ?? []
          if (returned.length) read(returned, path, '(its work ends)')
        } else if (property.name === 'failed') {
          const returned = returnedBy(type)
          if (returned) read(returned, path, '(its work fails)')
        } else if (property.name === 'initial') {
          const named = real(typeOf(property))
          if (named.length !== 1 || !named[0].isStringLiteral()) entryKnown = false
          for (const at of literalsOf(type)) starts.set(path, at)
        } else if (property.name === 'states') {
          for (const inner of type.getProperties()) { const innerType = real(typeOf(inner))[0]; if (innerType) walk(innerType, join(path, inner.name)) }
        }
      }
    }
    walk(def, '')

    const text = (node: any): string => (ts.isStringLiteralLike(node) ? node.text : node.getText())
    const propName = (nameNode: any): string | undefined => {
      if (ts.isIdentifier(nameNode) || ts.isStringLiteralLike(nameNode) || ts.isNumericLiteral(nameNode)) return nameNode.text
      if (ts.isComputedPropertyName(nameNode)) {
        const resolvedExpr = unwrapConst(nameNode.expression)
        if (ts.isStringLiteralLike(resolvedExpr) || ts.isNumericLiteral(resolvedExpr)) return resolvedExpr.text
        const lits = literalsOf(checker.getTypeAtLocation(nameNode.expression))
        if (lits.length === 1) return lits[0]
      }
      return undefined
    }
    const unwrapParens = (node: any): any => {
      let cur = node
      while (cur && ts.isParenthesizedExpression(cur)) cur = cur.expression
      return cur
    }
    const isInlineFn = (node: any): boolean => {
      const cur = unwrapParens(node)
      return Boolean(cur && (ts.isArrowFunction(cur) || ts.isFunctionExpression(cur)))
    }
    const isInlineHandlerProp = (prop: any): boolean =>
      ts.isMethodDeclaration(prop) || (ts.isPropertyAssignment(prop) && isInlineFn(prop.initializer))
    const declarations = (object: any, path: string): void => {
      for (const property of object.properties) {
        if (ts.isSpreadAssignment(property)) {
          unread(`spread in ${path || 'definition'} could not be statically read`)
          scan(property.expression, path)
          continue
        }
        if (!ts.isPropertyAssignment(property) && !ts.isShorthandPropertyAssignment(property) && !ts.isMethodDeclaration(property)) {
          scan(property, path)
          continue
        }
        const name = propName(property.name)
        if (name === undefined) {
          unread(`computed property ${property.name.getText()} in ${path || 'definition'} could not be statically read`)
          scan(property, path)
          continue
        }
        const made = ts.isPropertyAssignment(property) ? unwrapParens(property.initializer) : undefined
        if (name === 'on' || name === 'internal' || name === 'answers') {
          if (!made || !ts.isObjectLiteralExpression(made) || made.properties.some((p: any) => !isInlineHandlerProp(p))) unreadArms.add(path)
          // Handlers that are not each written out under a name of their own are not all read, and one written as
          // anything but a function or the name of one (either of two, what a call gives back) has a type that says
          // less than it does: each may enter anything.
          const named = (p: any): boolean => ts.isMethodDeclaration(p) || ts.isShorthandPropertyAssignment(p)
            || (ts.isPropertyAssignment(p) && !ts.isComputedPropertyName(p.name) && (isInlineFn(p.initializer) || ts.isIdentifier(unwrapParens(p.initializer))))
          if (!made || !ts.isObjectLiteralExpression(made) || !made.properties.every(named)) entryKnown = false
          scan(property, path)
          continue
        }
        if (name === 'listen' || name === 'run' || name === 'failed') {
          if (!isInlineHandlerProp(property)) unreadArms.add(path)
          scan(property, path)
          continue
        }
        if (name === 'states') {
          if (!made || !ts.isObjectLiteralExpression(made)) {
            unread(`could not statically read ${where(path, 'states')}`)
            scan(property, path)
            continue
          }
          for (const inner of made.properties) {
            if (ts.isSpreadAssignment(inner)) {
              unread(`spread in ${where(path, 'states')} could not be statically read`)
              scan(inner, path)
            } else if (ts.isPropertyAssignment(inner)) {
              const subName = propName(inner.name)
              const subInit = unwrapParens(inner.initializer)
              if (subName === undefined) {
                unread(`could not statically read ${where(path, inner.name.getText())}`)
                scan(inner, path)
              } else if (ts.isObjectLiteralExpression(subInit)) {
                declarations(subInit, join(path, subName))
              } else {
                unread(`could not statically read ${join(path, subName)}`)
                scan(inner, path)
              }
            } else if (ts.isShorthandPropertyAssignment(inner)) {
              unread(`could not statically read ${join(path, inner.name.text)}`)
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
          unread(`could not statically read ${where(path, name)}`)
          scan(property, path)
          continue
        }
        const body = unwrapParens(made.body)
        if (!ts.isObjectLiteralExpression(body)) {
          unread(`could not statically read ${where(path, name)}`)
          scan(property, path)
          continue
        }
        for (const entry of body.properties) {
          if (ts.isSpreadAssignment(entry)) {
            unread(`spread in ${where(path, name)} could not be statically read`)
            scan(entry, path)
            continue
          }
          if (!ts.isPropertyAssignment(entry) || !ts.isCallExpression(entry.initializer)) {
            const rawEntry = entry.name ? (propName(entry.name) ?? entry.name.getText()) : '?'
            unread(`could not statically read ${where(path, `${name}.${rawEntry}`)}`)
            scan(entry, path)
            continue
          }
          const entryName = propName(entry.name)
          if (entryName === undefined) {
            unread(`could not statically read ${where(path, `${name}.${entry.name.getText()}`)}`)
            scan(entry, path)
            continue
          }
          if (name === 'waits') {
            scan(entry.initializer, path, waitKey(path, entryName))
            const [first, second] = entry.initializer.arguments
            const helper = entry.initializer.expression.getText()
            const hasMs = Boolean(first && (checker.getTypeAtLocation(first).flags & ts.TypeFlags.NumberLike))
            const rest = hasMs ? second : first
            let noReset = false
            if (rest && ts.isObjectLiteralExpression(rest)) {
              if (rest.properties.some((p: any) => ts.isSpreadAssignment(p) || (p.name && propName(p.name) === undefined))) {
                unread(`spread in ${where(path, `waits.${entryName}`)} could not be statically read`)
              }
              const resetProp = rest.properties.find((each: any) => each.name && propName(each.name) === 'reset')
              const resetInit = resetProp && ts.isPropertyAssignment(resetProp) ? resetProp.initializer : undefined
              if (resetInit && resetInit.kind === ts.SyntaxKind.FalseKeyword) noReset = true
              const doneProp = rest.properties.find((each: any) => each.name && propName(each.name) === 'done')
              if (doneProp && !isInlineHandlerProp(doneProp)) unreadArms.add(path)
              const returned = returnedBy(doneProp && checker.getTypeAtLocation(doneProp.initializer ?? doneProp))
              if (returned) read(returned, path, `${entryName} (done)`)
            } else if (rest) {
              if (!isInlineFn(rest)) unreadArms.add(path)
              const restType = checker.getTypeAtLocation(rest)
              if (restType.getCallSignatures().length) {
                read(returnedBy(restType)!, path, `${entryName} (done)`)
              } else {
                const doneProp = restType.getProperty?.('done')
                const returned = returnedBy(doneProp && real(typeOf(doneProp))[0])
                if (returned) read(returned, path, `${entryName} (done)`)
                else if (restType.flags & ts.TypeFlags.Any) unread(`could not statically read ${where(path, `waits.${entryName}`)}`)
              }
            }
            const msLabel = hasMs ? (ts.isNumericLiteral(first) ? `${first.text}ms` : text(first)) : 'ms at arm'
            waits.push(`${entryName}${path ? ` in ${path}` : ''}: ${msLabel}, ${helper === 'each' ? 'for each key it is told' : 'one at a time'}${noReset ? ', no reset' : ''}`)
            continue
          }
          scan(entry.initializer, path)
          const [first, second, opts] = entry.initializer.arguments
          if (!first || !second || !opts || !ts.isObjectLiteralExpression(opts)) {
            unread(`could not statically read ${where(path, `${name}.${entryName}`)}`)
            continue
          }
          // What is spread into its options, or put there under a name worked out, may be what it hears with.
          if (opts.properties.some((each: any) => ts.isSpreadAssignment(each) || (each.name && ts.isComputedPropertyName(each.name)))) { entryKnown = false; unreadArms.add(path) }
          const option = (key: string): any => opts.properties.find((each: any) => each.name && propName(each.name) === key)
          const valueOf = (prop: any): any => prop && (prop.initializer ?? prop.name)
          const each = valueOf(option('each'))
          const from = valueOf(option('from'))
          const helper = entry.initializer.expression.getText()
          // The fields it is asked from, where it names any: `from []` names none, which is as good as leaving it out.
          const named = from && (!ts.isArrayLiteralExpression(from) ? `from what ${text(from)} names` : from.elements.length ? `from ${from.elements.map(text).join(', ')}` : undefined)
          const depends = name === 'calls' ? (helper === 'each' ? 'for each key it is told' : helper === 'many' ? 'many at once' : 'one at a time')
            : each ? `one for each key of ${text(each)}${named ? `, each ${named}` : ''}`
            : named ?? 'from nothing: once'
          ;(name === 'follows' ? follows : name === 'loads' ? loads : calls).push(`${entryName}${path ? ` in ${path}` : ''}: ${text(first)} ${text(second)}, ${depends}`)
          for (const hears of name === 'follows' ? ['updated'] : ['done', 'progress']) {
            const handler = option(hears)
            if (handler && !isInlineHandlerProp(handler)) unreadArms.add(path)
            const returned = returnedBy(handler && checker.getTypeAtLocation(handler.initializer ?? handler))
            if (returned) read(returned, path, `${entryName} (${hears})`)
          }
        }
      }
    }
    if (literal && ts.isObjectLiteralExpression(literal)) {
      declarations(literal, '')
    } else {
      unread('definition is not an inline object literal; reaches, follows, loads, calls, and waits could not be scanned')
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

    // An `arm` counts where it can run: in the state everything is in, and in a state that can be entered.
    const canRun = (path: string): boolean => !entryKnown || !path || entered.has(path)
    const around = (outer: string, inner: string): boolean => !outer || inner === outer || inner.startsWith(`${outer}.`)
    const rootArmed = new Set<string>()
    const waitEdges = new Map<string, Set<string>>()
    const armedByWait = new Map<string, Set<string>>()
    const armedWhereNeverEntered = new Map<string, Set<string>>()
    for (const { statePath, targetKey, fromWaitKey } of rawArms) {
      if (!canRun(statePath)) {
        let dead = armedWhereNeverEntered.get(targetKey)
        if (!dead) { dead = new Set(); armedWhereNeverEntered.set(targetKey, dead) }
        dead.add(statePath)
        continue
      }
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
    if (!unplaced) {
      const hiding = [...unreadArms].filter(canRun)
      for (const w of declaredWaits) {
        if (liveWaits.has(w.key)) continue
        // One declared in a state never entered is said already, by that state: nothing in it happens at all.
        if (!canRun(w.within)) continue
        if (hiding.some((path) => around(w.within, path))) continue
        const sources = [...(armedByWait.get(w.key) ?? [])]
        const others = sources
          .filter((source) => source !== w.key)
          .map((source) => {
            const from = byWaitKey.get(source)
            return from ? where(from.within, from.name) : source.slice(source.indexOf('\n') + 1)
          })
        const label = where(w.within, w.name)
        const dead = [...(armedWhereNeverEntered.get(w.key) ?? [])]
        // What does arm it and cannot: first the `done` of waits that cannot fire, then the states never entered. An
        // `arm` in a state never entered is named by that state, whether or not it is in a `done` there.
        const except: string[] = []
        if (others.length) except.push(`the done of ${[...(sources.includes(w.key) ? [label] : []), ...others].join(', ')}, which cannot fire`)
        else if (sources.length) except.push('its own done')
        if (dead.length) except.push(`in ${dead.join(', ')}, which ${dead.length > 1 ? 'are' : 'is'} never entered`)
        findings.push(except.length ? `nothing arms ${label} except ${except.join(', and ')}` : `nothing arms ${label}`)
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
