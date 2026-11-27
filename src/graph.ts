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
  readonly arms: readonly string[]
  readonly reaches: readonly string[]
  readonly findings: readonly string[]
  readonly text: string
}

type Type = any

const VERBS = new Set(['tell', 'ask', 'broadcast', 'call', 'cancel', 'arm', 'disarm'])
/** How many states deep a definition is read: one whose type never comes to an end is read this far. */
const DEEPEST = 64
/** A handler written so that where it goes is not read. */
const UNREAD = Symbol('unread')

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
  /** What each thing a type may be comes to: a promise is what it is of, and one of nothing known is left as it is. */
  const unwrap = (type: Type): Type[] => real(type).flatMap((m: Type) => {
    const held = m.symbol?.name === 'Promise' ? checker.getTypeArguments(m)[0] : undefined
    return held ? real(held) : [m]
  })
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
  /** Where a name is declared, if it names a `const`: its own name, one it is imported under, or one of a file imported whole. */
  const constOf = (name: any): any => {
    if (!ts.isIdentifier(name) && !ts.isPropertyAccessExpression(name)) return undefined
    const symbol = checker.getSymbolAtLocation(name)
    const decl = (symbol && symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol)?.valueDeclaration
    return decl && ts.isVariableDeclaration(decl) && ts.getCombinedNodeFlags(decl) & ts.NodeFlags.Const ? decl : undefined
  }
  const unwrapConst = (expr: any): any => {
    const seen = new Set<any>()
    let current = expr
    while (current && !seen.has(current)) {
      seen.add(current)
      while (ts.isParenthesizedExpression(current)) current = current.expression
      const given = constOf(current)?.initializer
      if (!given) break
      current = given
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

  const analyse = (title: string, shape: Type, events: string[], asks: string[], def: Type, literal: any, library: any): StateGraph => {
    /**
     * Each handler read, in the order they are read: the state it is written in, what it is listed under, the table
     * it is an entry of where a state has two that may take the same event (`on` and `internal`), the states it
     * moves to, and whether it may move to one not known.
     */
    const handled: Array<{ path: string; on: string; table: string; to: Set<string>; unknown: boolean }> = []
    const handlerAt = (path: string, on: string, table: string): { to: Set<string>; unknown: boolean } => {
      let found = handled.find((each) => each.path === path && each.on === on && each.table === table)
      if (!found) { found = { path, on, table, to: new Set(), unknown: false }; handled.push(found) }
      return found
    }
    const answers: string[] = []
    const takes = new Set<string>()
    const follows: string[] = []
    const loads: string[] = []
    const calls: string[] = []
    const arms: string[] = []
    const reachesSet = new Set<string>()
    const uncertain = new Set<string>()
    const where = (path: string, name: string): string => (path ? `${name} in ${path}` : name)
    const timerKey = (within: string, name: string): string => `${within}\n${name}`
    /** Whether `outer` is `inner` or a state around it. The state everything is in is around every state. */
    const around = (outer: string, inner: string): boolean => !outer || inner === outer || inner.startsWith(`${outer}.`)

    const declared: string[] = []
    const startsStates: string[] = []
    const declaredTimers: Array<{ key: string; name: string; within: string }> = []
    const byTimerKey = new Map<string, { key: string; name: string; within: string }>()
    /** `around` is each shape this one is inside: a shape that holds itself is read once, and none past `DEEPEST`. */
    const survey = (of: Type, within: string, around: readonly Type[] = []): void => {
      const started = of.getProperty('starts')
      if (started) for (const each of typeOf(started).getProperties()) startsStates.push(`${each.name}${typeOf(each).getProperty('_each') ? ' (one for each key)' : ''}${within ? ` in ${within}` : ''}`)
      const armed = of.getProperty('arms')
      if (armed) {
        for (const each of typeOf(armed).getProperties()) {
          const entry = { key: timerKey(within, each.name), name: each.name, within }
          declaredTimers.push(entry)
          byTimerKey.set(entry.key, entry)
        }
      }
      const states = of.getProperty('states')
      if (!states) return
      const inside = [...around, of]
      for (const inner of typeOf(states).getProperties()) {
        const innerType = typeOf(inner)
        declared.push(join(within, inner.name))
        if (!inside.includes(innerType) && inside.length < DEEPEST) survey(innerType, join(within, inner.name), inside)
      }
    }
    survey(shape, '')

    const resolveTimer = (fromPath: string, name: string): string | undefined => {
      for (let at = fromPath; ; ) {
        const key = timerKey(at, name)
        if (byTimerKey.has(key)) return key
        if (!at) return undefined
        const cut = at.lastIndexOf('.')
        at = cut >= 0 ? at.slice(0, cut) : ''
      }
    }

    // What can happen is one graph. A state that can be the case lets the handlers written in it run; a handler that
    // can run can enter the states it moves to and arm the timers it arms; a timer that can be armed lets its `expired`
    // run. A `Site` is where handlers are written that can run on the same condition, with all they can do. What
    // could not be read is what it may do, not a fact about the whole definition: `anywhere` is a move to a state
    // that is not known, `armsAround` an `arm` that is not known (it reaches the timers its own state and the states
    // around it declare), and `armsWithin` one written in a state inside this one.
    type Site = {
      /** The state it is written in. */
      readonly state: string
      /** The timer whose `expired` it is: it runs once that is armed, and not otherwise. */
      readonly timer?: string
      /** The timers one of whose `expired` it is, where which is not known: it runs once any of them is armed. */
      readonly anyOf?: readonly string[]
      /** A `failed`, which runs only where there is work to fail. */
      readonly ofWork?: true
      readonly moves: Set<string>
      readonly arms: Set<string>
      anywhere: boolean
      armsAround: boolean
      armsWithin: boolean
    }
    const sites = new Map<string, Site>()
    const siteAt = (key: string, made: Pick<Site, 'state' | 'timer' | 'anyOf' | 'ofWork'>): Site => {
      let found = sites.get(key)
      if (!found) { found = { ...made, moves: new Set(), arms: new Set(), anywhere: false, armsAround: false, armsWithin: false }; sites.set(key, found) }
      return found
    }
    /** What a state takes, hears and does while it is the case: its tables, `run`, `listen`, and what its calls, reads and views come back to. */
    const handlersIn = (path: string): Site => siteAt(`in\n${path}`, { state: path })
    const failedIn = (path: string): Site => siteAt(`failed\n${path}`, { state: path, ofWork: true })
    const expiredOf = (key: string): Site => siteAt(`expired\n${key}`, { state: key.slice(0, key.indexOf('\n')), timer: key })
    /**
     * What is written among a state's timers and is the entry of none that is known. It is the `expired` of one of
     * them, so it runs once one is armed; where the state declares none, it is held to run while the state is the case.
     */
    const someExpiredIn = (path: string): Site => {
      const anyOf = declaredTimers.filter((timer) => timer.within === path).map((timer) => timer.key)
      return anyOf.length ? siteAt(`some expired\n${path}`, { state: path, anyOf }) : handlersIn(path)
    }
    /** A part of a state that could not be read may hold anything a state holds, in it and in every state inside it. */
    const hidden = (path: string): void => {
      const all = handlersIn(path)
      all.anywhere = true
      all.armsAround = true
      all.armsWithin = true
    }
    const unreadHandler = (at: Site): void => { at.anywhere = true; at.armsAround = true }
    /** The states with work that can fail: a `run` or a `listen`. */
    const working = new Set<string>()
    /** What each state starts at: the names `initial` may be, or `'any'` where it is not names. */
    const initialOf = new Map<string, readonly string[] | 'any'>()

    /**
     * What a handler returns, by its type. One with more than one way to be called, or that may be either of two
     * functions, is read as its first, and one that is no function as nothing: none of them is a function written
     * out, so how it is written already leaves where it goes unread (`unreadBy`).
     */
    const returnedBy = (handler: Type | undefined, at: Site): Type[] | undefined => {
      if (!handler) return undefined
      const signatures = handler.getCallSignatures()
      const values = signatures.length ? unwrap(signatures[0].getReturnType()) : undefined
      if (values?.some((value: Type) => value.flags & ts.TypeFlags.Any)) at.anywhere = true
      return values
    }

    /**
     * Where a handler goes by what its function returns. The type of what it returns may say less than the values
     * do, whether it is given or worked out from them (of two values, one with a move and one that is the same
     * without it, the type worked out is the one without), and a move it leaves out is still made. Each value
     * returned is read for itself: each one a return may be, under a type it is said to be, and what a `const` it
     * names was given, in this file or another. A `const` whose value is not written where it can be read (one only
     * declared) may be more than its type says: it goes where its type says, and anywhere where its type does not
     * say. What a function inside it returns is not what it returns. What one of `answers` returns is its answer, and
     * goes somewhere only as an answer that comes with a change: the change `answered` is given is read as a value
     * returned is.
     */
    const readWritten = (fn: any, at: Site, path: string, on: string, table: string): void => {
      const answering = table === 'answers'
      const listed = (): { to: Set<string>; unknown: boolean } => handlerAt(path, on, table === 'internal' ? table : '')
      const anywhere = (): void => { at.anywhere = true; listed().unknown = true }
      const returned = new Set<any>()
      /** Of what is returned, each that is the change an answer comes with, and each `const` kept where it is not read. */
      const changes = new Set<any>()
      const keptElsewhere = new Set<any>()
      const value = (expression: any, change: boolean): void => {
        if (returned.has(expression)) return
        if (ts.isParenthesizedExpression(expression)) value(expression.expression, change)
        else if (ts.isConditionalExpression(expression)) { value(expression.whenTrue, change); value(expression.whenFalse, change) }
        else if (ts.isBinaryExpression(expression) && [ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken].includes(expression.operatorToken.kind)) { value(expression.left, change); value(expression.right, change) }
        // What is left of `&&` is given back only when it is nothing, and what is left of a comma never.
        else if (ts.isBinaryExpression(expression) && [ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.CommaToken].includes(expression.operatorToken.kind)) value(expression.right, change)
        else {
          returned.add(expression)
          if (change) changes.add(expression)
          if (ts.isAsExpression(expression) || ts.isTypeAssertionExpression(expression) || ts.isSatisfiesExpression(expression) || ts.isNonNullExpression(expression)) value(expression.expression, change)
          else if (ts.isCallExpression(expression)) { if (expression.arguments[1] && isAnswered(expression.expression)) value(expression.arguments[1], true) }
          else {
            // A `const` is what it was given, whatever type it was given beside.
            const given = unwrapConst(expression)
            const kept = constOf(expression)
            if (given !== expression) value(given, change)
            // One a loop gives a value each time round is a name like any other, read by its type.
            else if (kept && ts.isVariableStatement(kept.parent.parent)) keptElsewhere.add(expression)
          }
        }
      }
      const gather = (node: any): void => {
        if (ts.isReturnStatement(node)) { if (node.expression) value(node.expression, false); return }
        if (ts.isFunctionLike(node)) return
        ts.forEachChild(node, gather)
      }
      if (ts.isBlock(fn.body)) ts.forEachChild(fn.body, gather); else value(fn.body, false)
      for (const expression of returned) {
        // What a type that is no object says is all there is; any other may be said of a value that is more.
        const mayBeMore = (type: Type): boolean => keptElsewhere.has(expression) && !(type.flags & ts.TypeFlags.Primitive)
        for (const made of unwrap(checker.getTypeAtLocation(expression))) {
          if (made.flags & ts.TypeFlags.Any) { anywhere(); continue }
          // An answer that comes with a change goes where the change does.
          const withChange = made.getProperty?.('next') && made.getProperty?.('answer')
          const change = changes.has(expression) ? [made] : withChange ? real(typeOf(made.getProperty('next'))) : answering ? [] : [made]
          if (!change.length && !withChange && mayBeMore(made)) anywhere()
          for (const each of change) {
            if (each.flags & ts.TypeFlags.Any) { anywhere(); continue }
            const next = each.getProperty?.('at')
            if (!next && mayBeMore(each)) anywhere()
            if (!next) continue
            for (const member of real(typeOf(next))) {
              if (member.isStringLiteral()) { at.moves.add(member.value as string); listed().to.add(member.value as string) } else anywhere()
            }
          }
        }
      }
    }

    const scan = (inner: any, at: Site): void => {
      if (!isDeclName(inner)) {
        const p = inner.parent
        if (verbOf(inner) === 'arm' && !(p && ts.isCallExpression(p) && p.expression === inner)) {
          at.armsAround = true
        } else if (ts.isBindingElement(inner) && inner.dotDotDotToken && ts.isObjectBindingPattern(p) && isScopeReceiver(p)) {
          // The rest of a scope taken apart holds whatever of it was not named, `arm` among it.
          at.armsAround = true
        } else if (ts.isIdentifier(inner) && isScopeReceiver(inner)
          && !(p && ts.isPropertyAccessExpression(p) && p.expression === inner)
          && !(p && ts.isVariableDeclaration(p) && p.initializer === inner && ts.isObjectBindingPattern(p.name))) {
          at.armsAround = true
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
            if (verb === 'arm') at.armsAround = true
          } else if (verb === 'arm') {
            const names: string[] = []
            if (ts.isStringLiteralLike(resolvedTarget)) names.push(resolvedTarget.text)
            else for (const m of real(checker.getTypeAtLocation(target))) if (m.isStringLiteral()) names.push(m.value as string)
            for (const armedName of names) {
              const targetKey = resolveTimer(at.state, armedName)
              if (targetKey) at.arms.add(targetKey)
            }
          }
        }
      }
      ts.forEachChild(inner, (child: any) => scan(child, at))
    }

    const read = (returned: Type[], path: string, on: string, at: Site, table = ''): void => {
      const to = new Set<string>()
      let dynamicAt: string | undefined
      const entry = handlerAt(path, on, table)
      for (const value of returned) {
        if (value.flags & ts.TypeFlags.Any) entry.unknown = true
        const next = value.getProperty?.('at')
        if (!next) continue
        const atType = typeOf(next)
        for (const member of real(atType)) {
          if (member.isStringLiteral()) to.add(member.value as string)
          else dynamicAt = checker.typeToString(atType)
        }
      }
      if (dynamicAt !== undefined) { uncertain.add(`dynamic move target in ${where(path, on)} (at is ${dynamicAt})`); at.anywhere = true; entry.unknown = true }
      for (const target of to) { at.moves.add(target); entry.to.add(target) }
    }

    const walk = (level: Type, path: string, depth = 1): void => {
      const here = handlersIn(path)
      for (const property of level.getProperties()) {
        const kinds = real(typeOf(property))
        const type = kinds[0]
        if (!type) continue
        if (property.name === 'on' || property.name === 'internal') {
          for (const handler of type.getProperties()) {
            takes.add(handler.name)
            const returned = returnedBy(real(typeOf(handler))[0], here)
            if (returned) read(returned, path, handler.name, here, property.name === 'internal' ? property.name : '')
          }
        } else if (property.name === 'answers') {
          for (const handler of type.getProperties()) {
            takes.add(handler.name)
            answers.push(where(path, handler.name))
            const changes = (returnedBy(real(typeOf(handler))[0], here) ?? []).filter((value: Type) => value.getProperty?.('next') && value.getProperty?.('answer'))
            const nexts = changes.flatMap((value: Type) => real(typeOf(value.getProperty('next'))))
            if (nexts.some((next: Type) => next.flags & ts.TypeFlags.Any)) here.anywhere = true
            if (changes.length) read(nexts, path, `${handler.name} (answering)`, here)
          }
        } else if (property.name === 'run') {
          working.add(path)
          const returned = returnedBy(type, here) ?? []
          if (returned.length) read(returned, path, '(its work ends)', here)
        } else if (property.name === 'failed') {
          const failed = failedIn(path)
          const returned = returnedBy(type, failed)
          if (returned) read(returned, path, '(its work fails)', failed)
        } else if (property.name === 'listen') {
          working.add(path)
        } else if (property.name === 'initial') {
          initialOf.set(path, kinds.every((kind: Type) => kind.isStringLiteral()) ? kinds.map((kind: Type) => kind.value as string) : 'any')
        } else if (property.name === 'states') {
          for (const inner of type.getProperties()) { const innerType = real(typeOf(inner))[0]; if (innerType && depth < DEEPEST) walk(innerType, join(path, inner.name), depth + 1) }
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
    /** Whether what is called is the `answered` of this package, by whatever name it was imported under. */
    const isAnswered = (callee: any): boolean => {
      const symbol = checker.getSymbolAtLocation(unwrapParens(callee))
      const decl = (symbol && symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol)?.valueDeclaration
      return Boolean(decl && ts.isFunctionDeclaration(decl) && decl.name?.text === 'answered' && decl.getSourceFile() === library)
    }
    /** Whether what is written there is `undefined`, however it is written. */
    const isUndefined = (node: any): boolean => Boolean(checker.getTypeAtLocation(node).flags & ts.TypeFlags.Undefined)
    const unwrapParens = (node: any): any => {
      let cur = node
      while (cur && ts.isParenthesizedExpression(cur)) cur = cur.expression
      return cur
    }
    const isInlineFn = (node: any): boolean => {
      const cur = unwrapParens(node)
      return Boolean(cur && (ts.isArrowFunction(cur) || ts.isFunctionExpression(cur)))
    }
    /**
     * The one function a name is, where that is read off its own code: a function declared with its body, or a
     * `const` given no type that is a function written out, or the name of one. A type written beside a name may
     * say less than its function returns, and so may the type of one chosen between two.
     */
    const namedFunction = (symbol: any, seen = new Set<any>()): any => {
      const named = symbol && symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol
      const decl = named?.valueDeclaration
      if (!decl || seen.has(decl)) return undefined
      seen.add(decl)
      if (ts.isFunctionDeclaration(decl)) return decl.body ? decl : undefined
      if (!ts.isVariableDeclaration(decl) || !(ts.getCombinedNodeFlags(decl) & ts.NodeFlags.Const) || decl.type || !decl.initializer) return undefined
      const made = unwrapParens(decl.initializer)
      return isInlineFn(made) ? made : ts.isIdentifier(made) ? namedFunction(checker.getSymbolAtLocation(made), seen) : undefined
    }
    /**
     * What a handler leaves unread by how it is written, and the function it is where that is known. One written out
     * here leaves nothing. The name of a function leaves what it arms, since its code is elsewhere. Anything else
     * (either of two, what a call gives back), and a name whose type may say less than its function returns, leaves
     * where it goes as well: it is `UNREAD`. So does a method with no body yet. `undefined` written where a handler
     * goes is no handler, and leaves nothing.
     */
    const unreadBy = (written: any, at: Site, moves = true): any => {
      const value = ts.isMethodDeclaration(written) ? undefined : ts.isShorthandPropertyAssignment(written) ? written.name : unwrapParens(ts.isPropertyAssignment(written) ? written.initializer : written)
      if (!value) { if (written.body) return written }
      else if (isInlineFn(value)) return value
      else if (isUndefined(value)) return undefined
      at.armsAround = true
      const symbol = !value ? undefined : ts.isShorthandPropertyAssignment(written) ? checker.getShorthandAssignmentValueSymbol(written) : ts.isIdentifier(value) ? checker.getSymbolAtLocation(value) : undefined
      const fn = namedFunction(symbol)
      if (fn || !moves) return fn
      at.anywhere = true
      return UNREAD
    }
    /**
     * A handler, where the definition names it: what it leaves unread, and where it goes by what it returns. `on` is
     * what it is listed under in the state at `path`, and `table` the table it is an entry of, where it is of one.
     */
    const handler = (written: any, at: Site, path: string, on: string, table = ''): void => {
      const fn = unreadBy(written, at)
      if (fn === UNREAD) handlerAt(path, on, table === 'internal' ? table : '').unknown = true
      else if (fn) readWritten(fn, at, path, on, table)
    }
    /** Which of what a table is handed made an entry: the name it has there, whatever it is called by. */
    const helperOf = (callee: any): string | undefined => {
      const named = unwrapParens(callee)
      if (ts.isPropertyAccessExpression(named)) return named.name.text
      const decl = checker.getSymbolAtLocation(named)?.valueDeclaration
      return decl && ts.isBindingElement(decl) && decl.propertyName ? propName(decl.propertyName) : named.getText()
    }
    /**
     * Whether an entry of a table of declarations is made by what the table is handed: `single(...)` or `helpers.single(...)`
     * of the table's own parameter. One made by anything else holds what that made of it, which is not read.
     */
    const madeByHelper = (callee: any, table: any): boolean => {
      const named = unwrapParens(callee)
      const from = ts.isPropertyAccessExpression(named) ? unwrapParens(named.expression) : named
      if (!ts.isIdentifier(from)) return false
      let decl = checker.getSymbolAtLocation(from)?.valueDeclaration
      if (decl && ts.isBindingElement(decl) && !decl.dotDotDotToken && ts.isObjectBindingPattern(decl.parent) && !ts.isPropertyAccessExpression(named)) decl = decl.parent.parent
      return Boolean(decl && ts.isParameter(decl) && decl.parent === table)
    }
    const declarations = (object: any, path: string): void => {
      const here = handlersIn(path)
      for (const property of object.properties) {
        if (ts.isSpreadAssignment(property)) {
          uncertain.add(`spread in ${path || 'definition'} could not be statically read`)
          hidden(path)
          scan(property.expression, here)
          continue
        }
        if (!ts.isPropertyAssignment(property) && !ts.isShorthandPropertyAssignment(property) && !ts.isMethodDeclaration(property)) {
          hidden(path)
          scan(property, here)
          continue
        }
        const name = propName(property.name)
        if (name === undefined) {
          uncertain.add(`computed property ${property.name.getText()} in ${path || 'definition'} could not be statically read`)
          hidden(path)
          scan(property, here)
          continue
        }
        const made = ts.isPropertyAssignment(property) ? unwrapParens(property.initializer) : undefined
        // `undefined` written under a name is nothing written there.
        if (made && isUndefined(made)) continue
        if (name === 'on' || name === 'internal' || name === 'answers') {
          // Handlers that are not each written out under a name of their own are not all read.
          if (!made || !ts.isObjectLiteralExpression(made)) unreadHandler(here)
          else for (const entry of made.properties) {
            const taken = entry.name ? propName(entry.name) : undefined
            if (taken === undefined) { unreadBy(entry, here); here.anywhere = true }
            else handler(entry, here, path, name === 'answers' ? `${taken} (answering)` : taken, name)
          }
          scan(property, here)
          continue
        }
        if (name === 'listen' || name === 'run' || name === 'failed') {
          // What a `listen` returns is how it stops hearing, not where the state goes.
          if (name === 'listen') unreadBy(property, here, false)
          else if (name === 'run') handler(property, here, path, '(its work ends)')
          else handler(property, failedIn(path), path, '(its work fails)')
          scan(property, name === 'failed' ? failedIn(path) : here)
          continue
        }
        if (name === 'states') {
          if (!made || !ts.isObjectLiteralExpression(made)) {
            uncertain.add(`could not statically read ${where(path, 'states')}`)
            hidden(path)
            scan(property, here)
            continue
          }
          for (const inner of made.properties) {
            if (ts.isSpreadAssignment(inner)) {
              uncertain.add(`spread in ${where(path, 'states')} could not be statically read`)
              hidden(path)
              scan(inner, here)
            } else if (ts.isPropertyAssignment(inner)) {
              const subName = propName(inner.name)
              const subInit = unwrapParens(inner.initializer)
              if (subName === undefined) {
                uncertain.add(`could not statically read ${where(path, inner.name.getText())}`)
                hidden(path)
                scan(inner, here)
              } else if (ts.isObjectLiteralExpression(subInit)) {
                declarations(subInit, join(path, subName))
              } else {
                uncertain.add(`could not statically read ${join(path, subName)}`)
                hidden(join(path, subName))
                scan(inner, handlersIn(join(path, subName)))
              }
            } else if (ts.isShorthandPropertyAssignment(inner)) {
              uncertain.add(`could not statically read ${join(path, inner.name.text)}`)
              hidden(join(path, inner.name.text))
              scan(inner, handlersIn(join(path, inner.name.text)))
            } else {
              hidden(path)
              scan(inner, here)
            }
          }
          continue
        }
        if (name !== 'follows' && name !== 'loads' && name !== 'calls' && name !== 'arms') {
          scan(property, here)
          continue
        }
        // What a table of declarations hears with, where it is not read: the `expired` of each timer the state declares,
        // which runs once that timer is armed, and for the rest what the state hears while it is the case.
        const unreadEntries = (): void => {
          if (name !== 'arms') unreadHandler(here)
          else for (const timer of declaredTimers) if (timer.within === path) unreadHandler(expiredOf(timer.key))
        }
        // Where what is written in the table is not the entry of one name: among timers, the `expired` of one of them.
        const unplaced = name === 'arms' ? someExpiredIn(path) : here
        if (!made || !ts.isArrowFunction(made)) {
          uncertain.add(`could not statically read ${where(path, name)}`)
          unreadEntries()
          scan(property, unplaced)
          continue
        }
        const body = unwrapParens(made.body)
        if (!ts.isObjectLiteralExpression(body)) {
          uncertain.add(`could not statically read ${where(path, name)}`)
          unreadEntries()
          scan(property, unplaced)
          continue
        }
        for (const entry of body.properties) {
          if (ts.isSpreadAssignment(entry)) {
            uncertain.add(`spread in ${where(path, name)} could not be statically read`)
            unreadEntries()
            scan(entry, unplaced)
            continue
          }
          const entryName = entry.name ? propName(entry.name) : undefined
          if (!ts.isPropertyAssignment(entry) || !ts.isCallExpression(entry.initializer) || entryName === undefined || !madeByHelper(entry.initializer.expression, made)) {
            uncertain.add(`could not statically read ${where(path, `${name}.${entryName ?? (entry.name ? entry.name.getText() : '?')}`)}`)
            // What is written in a timer's entry is its `expired`, which runs once that timer is armed.
            const expired = name === 'arms' && entryName !== undefined && byTimerKey.has(timerKey(path, entryName)) ? expiredOf(timerKey(path, entryName)) : undefined
            if (expired) unreadHandler(expired)
            else unreadEntries()
            scan(entry, expired ?? (entryName === undefined ? unplaced : here))
            continue
          }
          if (name === 'arms') {
            const expired = expiredOf(timerKey(path, entryName))
            scan(entry.initializer, expired)
            const given = unwrapParens(entry.initializer.arguments[0])
            // No options, written as `undefined`, are no options written at all.
            const options = given && isUndefined(given) ? undefined : given
            const helper = helperOf(entry.initializer.expression)
            let msLabel = 'ms at arm'
            let ignoredWhileArmed = false
            if (options && ts.isObjectLiteralExpression(options)) {
              if (options.properties.some((p: any) => ts.isSpreadAssignment(p) || (p.name && propName(p.name) === undefined))) {
                uncertain.add(`spread in ${where(path, `arms.${entryName}`)} could not be statically read`)
                unreadHandler(expired)
              }
              const named = (key: string): any => options.properties.find((each: any) => each.name && propName(each.name) === key)
              const afterProp = named('after')
              const after = afterProp && (ts.isPropertyAssignment(afterProp) ? afterProp.initializer : afterProp.name)
              if (after && !isUndefined(after)) msLabel = ts.isNumericLiteral(after) ? `${after.text}ms` : text(after)
              const whenArmedProp = named('whenArmed')
              const whenArmed = whenArmedProp && (ts.isPropertyAssignment(whenArmedProp) ? whenArmedProp.initializer : whenArmedProp.name)
              const whenArmedType = whenArmed && checker.getTypeAtLocation(whenArmed)
              if (whenArmedType?.isStringLiteral() && whenArmedType.value === 'ignore') ignoredWhileArmed = true
              const expiredProp = named('expired')
              if (expiredProp) handler(expiredProp, expired, path, `${entryName} (expired)`)
              // An `expired` that may be `undefined`, or one of two functions, moves as each function it may be does.
              const returned = expiredProp ? real(checker.getTypeAtLocation(expiredProp.initializer ?? expiredProp)).flatMap((each: Type) => returnedBy(each, expired) ?? []) : []
              if (returned.length) read(returned, path, `${entryName} (expired)`, expired)
            } else if (options) {
              // Options written elsewhere: what is read of them is what their type says, for the moves listed.
              unreadHandler(expired)
              const optionsType = checker.getTypeAtLocation(options)
              if (optionsType.getProperty?.('after')) msLabel = `${text(options)}.after`
              const expiredProp = optionsType.getProperty?.('expired')
              const returned = returnedBy(expiredProp && real(typeOf(expiredProp))[0], expired)
              if (returned) read(returned, path, `${entryName} (expired)`, expired)
              else if (optionsType.flags & ts.TypeFlags.Any) uncertain.add(`could not statically read ${where(path, `arms.${entryName}`)}`)
            }
            arms.push(`${entryName}${path ? ` in ${path}` : ''}: ${msLabel}, ${helper === 'each' ? 'for each key it is told' : 'one at a time'}${ignoredWhileArmed ? ', ignored while armed' : ''}`)
            continue
          }
          scan(entry.initializer, here)
          const [first, second, opts] = entry.initializer.arguments
          if (!first || !second || !opts || !ts.isObjectLiteralExpression(opts)) {
            uncertain.add(`could not statically read ${where(path, `${name}.${entryName}`)}`)
            unreadHandler(here)
            continue
          }
          // What is spread into its options, or put there under a name worked out, may be what it hears with.
          if (opts.properties.some((each: any) => ts.isSpreadAssignment(each) || (each.name && propName(each.name) === undefined))) unreadHandler(here)
          const option = (key: string): any => opts.properties.find((each: any) => each.name && propName(each.name) === key)
          const valueOf = (prop: any): any => prop && (prop.initializer ?? prop.name)
          const each = valueOf(option('each'))
          const from = valueOf(option('from'))
          const helper = helperOf(entry.initializer.expression)
          // The fields it is asked from, where it names any: `from []` names none, which is as good as leaving it out.
          const named = from && (!ts.isArrayLiteralExpression(from) ? `from what ${text(from)} names` : from.elements.length ? `from ${from.elements.map(text).join(', ')}` : undefined)
          const depends = name === 'calls' ? (helper === 'each' ? 'for each key it is told' : helper === 'many' ? 'many at once' : 'one at a time')
            : each ? `one for each key of ${text(each)}${named ? `, each ${named}` : ''}`
            : named ?? 'from nothing: once'
          ;(name === 'follows' ? follows : name === 'loads' ? loads : calls).push(`${entryName}${path ? ` in ${path}` : ''}: ${text(first)} ${text(second)}, ${depends}`)
          for (const hears of name === 'follows' ? ['updated'] : ['done', 'progress']) {
            const heard = option(hears)
            if (heard) handler(heard, here, path, `${entryName} (${hears})`)
            // One that may be `undefined`, or one of two functions, moves as each function it may be does.
            const returned = heard ? real(checker.getTypeAtLocation(heard.initializer ?? heard)).flatMap((each: Type) => { const by = returnedBy(each, here); return by ? [by] : [] }) : []
            if (returned.length) read(returned.flat(), path, `${entryName} (${hears})`, here)
          }
        }
      }
    }
    if (literal && ts.isObjectLiteralExpression(literal)) {
      declarations(literal, '')
    } else {
      uncertain.add('definition is not an inline object literal; reaches, follows, loads, calls, and arms could not be scanned')
      hidden('')
    }

    // The least set closed under what can happen, from the state everything is in and what it starts at. A state is
    // live when it can be the case, and a timer when it can be armed.
    const liveStates = new Set<string>()
    const liveTimers = new Set<string>()
    /** The states entered themselves, whose `initial` has been followed. One live only as a state around another is not among them. */
    const begun = new Set<string>()
    /**
     * Entering a state is entering each state around it, and then what it starts at, and what that starts at. A state
     * around the one entered is not entered at what it starts at.
     */
    const enter = (target: string): void => {
      for (let cut = target.indexOf('.'); cut > 0; cut = target.indexOf('.', cut + 1)) liveStates.add(target.slice(0, cut))
      const next = [target]
      while (next.length) {
        const at = next.pop()!
        liveStates.add(at)
        if (begun.has(at)) continue
        begun.add(at)
        const initial = initialOf.get(at)
        if (initial === 'any') next.push(...declared.filter((name) => name.startsWith(at ? `${at}.` : '') && !name.slice(at ? at.length + 1 : 0).includes('.')))
        else for (const name of initial ?? []) next.push(join(at, name))
      }
    }
    const canRun = (at: Site): boolean => (
      at.timer !== undefined ? liveTimers.has(at.timer)
        : at.anyOf ? at.anyOf.some((key) => liveTimers.has(key))
          : liveStates.has(at.state) && (!at.ofWork || working.has(at.state)))
    const ran = new Set<Site>()
    enter('')
    for (let more = true; more; ) {
      more = false
      for (const at of sites.values()) {
        if (ran.has(at) || !canRun(at)) continue
        ran.add(at)
        more = true
        for (const target of at.anywhere ? declared : at.moves) enter(target)
        for (const key of at.arms) liveTimers.add(key)
        for (const timer of declaredTimers) {
          if ((at.armsAround && around(timer.within, at.state)) || (at.armsWithin && around(at.state, timer.within))) liveTimers.add(timer.key)
        }
      }
    }

    // What is dead is said by its cause. One dead thing leads to another where it is read to: a state to the states
    // inside it and the timers it declares, a handler's state to what the handler enters and arms, a timer to what its
    // `expired` does. What may be, unread, leads nowhere here: it is not known to. A cause is a dead thing nothing dead
    // leads to but what it leads to itself, and the first of those declared speaks for them.
    const stateId = (path: string): string => `state\n${path}`
    const timerId = (key: string): string => `timer\n${key}`
    const dead = [
      ...declared.filter((name) => !liveStates.has(name)).map(stateId),
      ...declaredTimers.filter((timer) => !liveTimers.has(timer.key)).map((timer) => timerId(timer.key)),
    ]
    const order = new Map(dead.map((id, index) => [id, index]))
    const leadsTo = new Map<string, Set<string>>(dead.map((id) => [id, new Set()]))
    const ledBy = new Map<string, Set<string>>(dead.map((id) => [id, new Set()]))
    const lead = (from: string, to: string): void => {
      if (!order.has(from) || !order.has(to)) return
      leadsTo.get(from)!.add(to)
      ledBy.get(to)!.add(from)
    }
    for (const name of declared) lead(stateId(name.slice(0, Math.max(0, name.lastIndexOf('.')))), stateId(name))
    for (const timer of declaredTimers) lead(stateId(timer.within), timerId(timer.key))
    for (const at of sites.values()) {
      const from = at.timer !== undefined ? timerId(at.timer) : stateId(at.state)
      for (const key of at.arms) lead(from, timerId(key))
      // A move enters the states around its target that the handler is not already in.
      for (const target of at.moves) {
        for (const name of declared) if (around(name, target) && !around(name, at.state)) lead(from, stateId(name))
      }
    }
    const reached = new Map<string, Set<string>>()
    for (const id of dead) {
      const seen = new Set<string>()
      const next = [...leadsTo.get(id)!]
      while (next.length) {
        const to = next.pop()!
        if (seen.has(to)) continue
        seen.add(to)
        next.push(...leadsTo.get(to)!)
      }
      reached.set(id, seen)
    }
    const causes = dead.filter((id) => dead.every((other) => other === id || !reached.get(other)!.has(id) || (reached.get(id)!.has(other) && order.get(other)! > order.get(id)!)))
    const said = (id: string): string => {
      const name = id.slice(id.indexOf('\n') + 1)
      if (id.startsWith('state\n')) return name
      const timer = byTimerKey.get(name)!
      return where(timer.within, timer.name)
    }
    const isState = (id: string): boolean => id.startsWith('state\n')
    const spoken = new Set<string>(causes)
    const caused: string[] = []
    for (const cause of causes) {
      const by = [...ledBy.get(cause)!]
      const fromTimers = by.filter((id) => !isState(id) && id !== cause).map(said)
      const except: string[] = []
      let subject: string
      if (isState(cause)) {
        const fromStates = by.filter(isState).map(said)
        if (fromStates.length) except.push(`from ${fromStates.join(', ')}`)
        if (fromTimers.length) except.push(`by the expiry of ${fromTimers.join(', ')}`)
        subject = `${said(cause)} is never entered`
      } else {
        if (by.includes(cause)) except.push('its own expiry')
        if (fromTimers.length) except.push(`the expiry of ${fromTimers.join(', ')}`)
        subject = `nothing arms ${said(cause)}`
      }
      const after = dead.filter((id) => !spoken.has(id) && reached.get(cause)!.has(id))
      for (const id of after) spoken.add(id)
      // A timer declared in a state never entered is said by that state: nothing in it happens at all.
      const unarmed = after.filter((id) => !isState(id) && liveStates.has(byTimerKey.get(id.slice(id.indexOf('\n') + 1))!.within)).map(said)
      const unentered = after.filter(isState).map(said)
      const so = [unarmed.length ? `nothing arms ${unarmed.join(', ')}` : '', unentered.length ? `nothing enters ${unentered.join(', ')}` : ''].filter(Boolean)
      caused.push(`${subject}${except.length ? ` except ${except.join(' and ')}` : ''}${so.length ? `, so ${so.join('; ')}` : ''}`)
    }

    const moves = handled.filter((each) => each.to.size).map((each) => ({ from: each.path || 'anywhere', on: each.on, to: [...each.to] }))
    const stays = handled.filter((each) => !each.to.size && !each.unknown).map((each) => where(each.path, each.on))
    const reaches = [...reachesSet]
    const findings: string[] = []
    for (const taken of [...events, ...asks]) if (!takes.has(taken)) findings.push(`nothing takes ${taken}`)
    findings.push(...caused)
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
    for (const armed of arms) lines.push(`  arms    ${armed}`)
    if (reaches.length) lines.push(`  reaches: ${reaches.join(', ')}`)
    lines.push(`  findings: ${findings.length ? findings.join('; ') : 'none'}`)

    return {
      title, states: declared, moves, stays, answers, starts: startsStates, follows, loads, calls, arms, reaches, findings,
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
            graphs.push(analyse(title, shapeType, events, asks, checker.getTypeAtLocation(arg), arg, returned.symbol.declarations?.[0]?.getSourceFile()))
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
