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
    const follows: string[] = []
    const loads: string[] = []
    const calls: string[] = []
    const waits: string[] = []
    const reachesSet = new Set<string>()
    const uncertain = new Set<string>()
    const where = (path: string, name: string): string => (path ? `${name} in ${path}` : name)
    const waitKey = (within: string, name: string): string => `${within}\n${name}`
    /** Whether `outer` is `inner` or a state around it. The state everything is in is around every state. */
    const around = (outer: string, inner: string): boolean => !outer || inner === outer || inner.startsWith(`${outer}.`)

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

    // What can happen is one graph. A state that can be the case lets the handlers written in it run; a handler that
    // can run can enter the states it moves to and arm the waits it arms; a wait that can be armed lets its `done`
    // run. A `Site` is where handlers are written that can run on the same condition, with all they can do. What
    // could not be read is what it may do, not a fact about the whole definition: `anywhere` is a move to a state
    // that is not known, `armsAround` an `arm` that is not known (it reaches the waits its own state and the states
    // around it declare), and `armsWithin` one written in a state inside this one.
    type Site = {
      /** The state it is written in. */
      readonly state: string
      /** The wait whose `done` it is: it runs once that is armed, and not otherwise. */
      readonly wait?: string
      /** A `failed`, which runs only where there is work to fail. */
      readonly ofWork?: true
      readonly moves: Set<string>
      readonly arms: Set<string>
      anywhere: boolean
      armsAround: boolean
      armsWithin: boolean
    }
    const sites = new Map<string, Site>()
    const siteAt = (key: string, made: Pick<Site, 'state' | 'wait' | 'ofWork'>): Site => {
      let found = sites.get(key)
      if (!found) { found = { ...made, moves: new Set(), arms: new Set(), anywhere: false, armsAround: false, armsWithin: false }; sites.set(key, found) }
      return found
    }
    /** What a state takes, hears and does while it is the case: its tables, `run`, `listen`, and what its calls, reads and views come back to. */
    const handlersIn = (path: string): Site => siteAt(`in\n${path}`, { state: path })
    const failedIn = (path: string): Site => siteAt(`failed\n${path}`, { state: path, ofWork: true })
    const doneOf = (key: string): Site => siteAt(`done\n${key}`, { state: key.slice(0, key.indexOf('\n')), wait: key })
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
     * Where a function written out goes by what it returns, for one whose return is given a type: that type may say
     * less than the values do, and a move it leaves out is still made. Each value returned is read for itself.
     */
    const readWritten = (fn: any, at: Site): void => {
      const returned: any[] = []
      const gather = (node: any): void => {
        if (ts.isReturnStatement(node)) { if (node.expression) returned.push(node.expression); return }
        if (ts.isFunctionLike(node)) return
        ts.forEachChild(node, gather)
      }
      if (ts.isBlock(fn.body)) ts.forEachChild(fn.body, gather); else returned.push(fn.body)
      for (const expression of returned) {
        for (const value of unwrap(checker.getTypeAtLocation(expression))) {
          if (value.flags & ts.TypeFlags.Any) { at.anywhere = true; continue }
          // An answer that comes with a change goes where the change does.
          const change = value.getProperty?.('next') && value.getProperty?.('answer') ? real(typeOf(value.getProperty('next'))) : [value]
          for (const each of change) {
            if (each.flags & ts.TypeFlags.Any) { at.anywhere = true; continue }
            const next = each.getProperty?.('at')
            if (!next) continue
            for (const member of real(typeOf(next))) { if (member.isStringLiteral()) at.moves.add(member.value as string); else at.anywhere = true }
          }
        }
      }
    }

    const scan = (inner: any, at: Site): void => {
      // A handler is written as an entry of a table or handed to what makes one; a function kept under a name of its
      // own inside one is not what the handler returns.
      if (inner.type && inner.body && (ts.isMethodDeclaration(inner) || ((ts.isArrowFunction(inner) || ts.isFunctionExpression(inner)) && !ts.isVariableDeclaration(inner.parent)))) readWritten(inner, at)
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
              const targetKey = resolveWait(at.state, armedName)
              if (targetKey) at.arms.add(targetKey)
            }
          }
        }
      }
      ts.forEachChild(inner, (child: any) => scan(child, at))
    }

    const read = (returned: Type[], path: string, on: string, at: Site): void => {
      const to = new Set<string>()
      let dynamicAt: string | undefined
      for (const value of returned) {
        const next = value.getProperty?.('at')
        if (!next) continue
        const atType = typeOf(next)
        for (const member of real(atType)) {
          if (member.isStringLiteral()) to.add(member.value as string)
          else dynamicAt = checker.typeToString(atType)
        }
      }
      if (dynamicAt !== undefined) { uncertain.add(`dynamic move target in ${where(path, on)} (at is ${dynamicAt})`); at.anywhere = true }
      for (const target of to) at.moves.add(target)
      if (to.size) moves.push({ from: path || 'anywhere', on, to: [...to] })
      else if (dynamicAt === undefined) stays.push(where(path, on))
    }

    const walk = (level: Type, path: string): void => {
      const here = handlersIn(path)
      for (const property of level.getProperties()) {
        const kinds = real(typeOf(property))
        const type = kinds[0]
        if (!type) continue
        if (property.name === 'on' || property.name === 'internal') {
          for (const handler of type.getProperties()) {
            takes.add(handler.name)
            const returned = returnedBy(real(typeOf(handler))[0], here)
            if (returned) read(returned, path, handler.name, here)
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
    /**
     * Whether a name is one function whose type is read off its own code: a function declared with its body, or a
     * `const` given no type that is a function written out, or the name of one. A type written beside a function may
     * say less than the function returns, and so may the type of one chosen between two.
     */
    const saysItsReturn = (symbol: any, seen = new Set<any>()): boolean => {
      const named = symbol && symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol
      const decl = named?.valueDeclaration
      if (!decl || seen.has(decl)) return false
      seen.add(decl)
      if (ts.isFunctionDeclaration(decl)) return Boolean(decl.body)
      if (!ts.isVariableDeclaration(decl) || !(ts.getCombinedNodeFlags(decl) & ts.NodeFlags.Const) || decl.type || !decl.initializer) return false
      const made = unwrapParens(decl.initializer)
      return isInlineFn(made) || (ts.isIdentifier(made) && saysItsReturn(checker.getSymbolAtLocation(made), seen))
    }
    /**
     * What a handler leaves unread by how it is written. One written out here leaves nothing. The name of a function
     * leaves what it arms, since its code is elsewhere. Anything else (either of two, what a call gives back), and a
     * name whose type may say less than its function returns, leaves where it goes as well.
     */
    const unreadBy = (written: any, at: Site, moves = true): void => {
      if (ts.isMethodDeclaration(written)) return
      const value = ts.isShorthandPropertyAssignment(written) ? written.name : unwrapParens(ts.isPropertyAssignment(written) ? written.initializer : written)
      if (isInlineFn(value)) return
      at.armsAround = true
      const symbol = ts.isShorthandPropertyAssignment(written) ? checker.getShorthandAssignmentValueSymbol(written) : ts.isIdentifier(value) ? checker.getSymbolAtLocation(value) : undefined
      if (moves && !saysItsReturn(symbol)) at.anywhere = true
    }
    /**
     * Whether an entry of a table of declarations is made by what the table is handed: `one(...)` or `helpers.one(...)`
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
        if (name === 'on' || name === 'internal' || name === 'answers') {
          // Handlers that are not each written out under a name of their own are not all read.
          if (!made || !ts.isObjectLiteralExpression(made)) unreadHandler(here)
          else for (const handler of made.properties) {
            unreadBy(handler, here)
            if (handler.name && propName(handler.name) === undefined) here.anywhere = true
          }
          scan(property, here)
          continue
        }
        if (name === 'listen' || name === 'run' || name === 'failed') {
          const at = name === 'failed' ? failedIn(path) : here
          unreadBy(property, at, name !== 'listen')
          scan(property, at)
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
        if (name !== 'follows' && name !== 'loads' && name !== 'calls' && name !== 'waits') {
          scan(property, here)
          continue
        }
        // What a table of declarations hears with, where it is not read: the `done` of each wait the state declares,
        // which runs once that wait is armed, and for the rest what the state hears while it is the case.
        const unreadEntries = (): void => {
          if (name !== 'waits') unreadHandler(here)
          else for (const wait of declaredWaits) if (wait.within === path) unreadHandler(doneOf(wait.key))
        }
        if (!made || !ts.isArrowFunction(made)) {
          uncertain.add(`could not statically read ${where(path, name)}`)
          unreadEntries()
          scan(property, here)
          continue
        }
        const body = unwrapParens(made.body)
        if (!ts.isObjectLiteralExpression(body)) {
          uncertain.add(`could not statically read ${where(path, name)}`)
          unreadEntries()
          scan(property, here)
          continue
        }
        for (const entry of body.properties) {
          if (ts.isSpreadAssignment(entry)) {
            uncertain.add(`spread in ${where(path, name)} could not be statically read`)
            unreadEntries()
            scan(entry, here)
            continue
          }
          const entryName = entry.name ? propName(entry.name) : undefined
          if (!ts.isPropertyAssignment(entry) || !ts.isCallExpression(entry.initializer) || entryName === undefined || !madeByHelper(entry.initializer.expression, made)) {
            uncertain.add(`could not statically read ${where(path, `${name}.${entryName ?? (entry.name ? entry.name.getText() : '?')}`)}`)
            if (name === 'waits' && entryName !== undefined && byWaitKey.has(waitKey(path, entryName))) unreadHandler(doneOf(waitKey(path, entryName)))
            else unreadEntries()
            scan(entry, here)
            continue
          }
          if (name === 'waits') {
            const done = doneOf(waitKey(path, entryName))
            scan(entry.initializer, done)
            const [first, second] = entry.initializer.arguments
            const helper = entry.initializer.expression.getText()
            const hasMs = Boolean(first && (checker.getTypeAtLocation(first).flags & ts.TypeFlags.NumberLike))
            const rest = hasMs ? second : first
            let noReset = false
            if (rest && ts.isObjectLiteralExpression(rest)) {
              if (rest.properties.some((p: any) => ts.isSpreadAssignment(p) || (p.name && propName(p.name) === undefined))) {
                uncertain.add(`spread in ${where(path, `waits.${entryName}`)} could not be statically read`)
                unreadHandler(done)
              }
              const resetProp = rest.properties.find((each: any) => each.name && propName(each.name) === 'reset')
              const resetInit = resetProp && ts.isPropertyAssignment(resetProp) ? resetProp.initializer : undefined
              if (resetInit && resetInit.kind === ts.SyntaxKind.FalseKeyword) noReset = true
              const doneProp = rest.properties.find((each: any) => each.name && propName(each.name) === 'done')
              if (doneProp) unreadBy(doneProp, done)
              const returned = returnedBy(doneProp && checker.getTypeAtLocation(doneProp.initializer ?? doneProp), done)
              if (returned) read(returned, path, `${entryName} (done)`, done)
            } else if (rest) {
              unreadBy(rest, done)
              const restType = checker.getTypeAtLocation(rest)
              if (restType.getCallSignatures().length) {
                read(returnedBy(restType, done)!, path, `${entryName} (done)`, done)
              } else {
                // Options written elsewhere: what is read of them is what their type says, for the moves listed.
                const doneProp = restType.getProperty?.('done')
                const returned = returnedBy(doneProp && real(typeOf(doneProp))[0], done)
                if (returned) read(returned, path, `${entryName} (done)`, done)
                else if (restType.flags & ts.TypeFlags.Any) uncertain.add(`could not statically read ${where(path, `waits.${entryName}`)}`)
              }
            }
            const msLabel = hasMs ? (ts.isNumericLiteral(first) ? `${first.text}ms` : text(first)) : 'ms at arm'
            waits.push(`${entryName}${path ? ` in ${path}` : ''}: ${msLabel}, ${helper === 'each' ? 'for each key it is told' : 'one at a time'}${noReset ? ', no reset' : ''}`)
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
          const helper = entry.initializer.expression.getText()
          const depends = name === 'calls' ? (helper === 'each' ? 'for each key it is told' : helper === 'many' ? 'many at once' : 'one at a time')
            : each ? `one for each key of ${text(each)}`
            : from && ts.isArrayLiteralExpression(from) ? (from.elements.length ? `from ${from.elements.map(text).join(', ')}` : 'from nothing: once')
            : from ? `from what ${text(from)} names` : 'from nothing: once'
          ;(name === 'follows' ? follows : name === 'loads' ? loads : calls).push(`${entryName}${path ? ` in ${path}` : ''}: ${text(first)} ${text(second)}, ${depends}`)
          for (const hears of name === 'follows' ? ['updated'] : ['done', 'progress']) {
            const handler = option(hears)
            if (handler) unreadBy(handler, here)
            const returned = returnedBy(handler && checker.getTypeAtLocation(handler.initializer ?? handler), here)
            if (returned) read(returned, path, `${entryName} (${hears})`, here)
          }
        }
      }
    }
    if (literal && ts.isObjectLiteralExpression(literal)) {
      declarations(literal, '')
    } else {
      uncertain.add('definition is not an inline object literal; reaches, follows, loads, calls, and waits could not be scanned')
      hidden('')
    }

    // The least set closed under what can happen, from the state everything is in and what it starts at. A state is
    // live when it can be the case, and a wait when it can be armed.
    const liveStates = new Set<string>()
    const liveWaits = new Set<string>()
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
        const initial = initialOf.get(at)
        if (initial === 'any') next.push(...declared.filter((name) => name.startsWith(at ? `${at}.` : '') && !name.slice(at ? at.length + 1 : 0).includes('.')))
        else for (const name of initial ?? []) next.push(join(at, name))
      }
    }
    const canRun = (at: Site): boolean => (at.wait !== undefined ? liveWaits.has(at.wait) : liveStates.has(at.state) && (!at.ofWork || working.has(at.state)))
    const ran = new Set<Site>()
    enter('')
    for (let more = true; more; ) {
      more = false
      for (const at of sites.values()) {
        if (ran.has(at) || !canRun(at)) continue
        ran.add(at)
        more = true
        for (const target of at.anywhere ? declared : at.moves) enter(target)
        for (const key of at.arms) liveWaits.add(key)
        for (const wait of declaredWaits) {
          if ((at.armsAround && around(wait.within, at.state)) || (at.armsWithin && around(at.state, wait.within))) liveWaits.add(wait.key)
        }
      }
    }

    // What is dead is said by its cause. One dead thing leads to another where it is read to: a state to the states
    // inside it and the waits it declares, a handler's state to what the handler enters and arms, a wait to what its
    // `done` does. What may be, unread, leads nowhere here: it is not known to. A cause is a dead thing nothing dead
    // leads to but what it leads to itself, and the first of those declared speaks for them.
    const stateId = (path: string): string => `state\n${path}`
    const waitId = (key: string): string => `wait\n${key}`
    const dead = [
      ...declared.filter((name) => !liveStates.has(name)).map(stateId),
      ...declaredWaits.filter((wait) => !liveWaits.has(wait.key)).map((wait) => waitId(wait.key)),
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
    for (const wait of declaredWaits) lead(stateId(wait.within), waitId(wait.key))
    for (const at of sites.values()) {
      const from = at.wait !== undefined ? waitId(at.wait) : stateId(at.state)
      for (const key of at.arms) lead(from, waitId(key))
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
      const wait = byWaitKey.get(name)!
      return where(wait.within, wait.name)
    }
    const isState = (id: string): boolean => id.startsWith('state\n')
    const spoken = new Set<string>(causes)
    const caused: string[] = []
    for (const cause of causes) {
      const by = [...ledBy.get(cause)!]
      const fromWaits = by.filter((id) => !isState(id) && id !== cause).map(said)
      const except: string[] = []
      let subject: string
      if (isState(cause)) {
        const fromStates = by.filter(isState).map(said)
        if (fromStates.length) except.push(`from ${fromStates.join(', ')}`)
        if (fromWaits.length) except.push(`by the done of ${fromWaits.join(', ')}`)
        subject = `${said(cause)} is never entered`
      } else {
        if (by.includes(cause)) except.push('its own done')
        if (fromWaits.length) except.push(`the done of ${fromWaits.join(', ')}`)
        subject = `nothing arms ${said(cause)}`
      }
      const after = dead.filter((id) => !spoken.has(id) && reached.get(cause)!.has(id))
      for (const id of after) spoken.add(id)
      // A wait declared in a state never entered is said by that state: nothing in it happens at all.
      const unarmed = after.filter((id) => !isState(id) && liveStates.has(byWaitKey.get(id.slice(id.indexOf('\n') + 1))!.within)).map(said)
      const unentered = after.filter(isState).map(said)
      const so = [unarmed.length ? `nothing arms ${unarmed.join(', ')}` : '', unentered.length ? `nothing enters ${unentered.join(', ')}` : ''].filter(Boolean)
      caused.push(`${subject}${except.length ? ` except ${except.join(' and ')}` : ''}${so.length ? `, so ${so.join('; ')}` : ''}`)
    }

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
