// Master failure reporting (`.github/scripts/master-status.sh`): validates its argument, skips superseded commits,
// opens or comments on a single bot-authored issue on failure, and closes all matching open bot issues on pass.
//
//   npx vitest run master-status
import { spawnSync } from 'node:child_process'
import { ok, strictEqual } from 'node:assert'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { run } from './checks.mts'

const root = join(import.meta.dirname, '..')
const script = join(root, '.github', 'scripts', 'master-status.sh')

interface Fixture {
  head?: string
  sha?: string
  workflow?: string
  issues?: string
}

const invoke = (arg: string | undefined, fixture: Fixture = {}): { status: number | null; out: string; err: string; calls: string[] } => {
  const dir = mkdtempSync(join(tmpdir(), 'master-status-check-'))
  const log = join(dir, 'gh.log')
  const issuesFile = join(dir, 'issues.json')
  const gh = join(dir, 'gh')
  try {
    writeFileSync(issuesFile, fixture.issues ?? '[]')
    writeFileSync(gh, [
      '#!/usr/bin/env bash',
      'printf "CALL:" >> "$MOCK_LOG"',
      'printf " [%s]" "$@" >> "$MOCK_LOG"',
      'printf "\\n" >> "$MOCK_LOG"',
      'if [ "$1" = api ]; then',
      '  if [[ "$*" == *"/git/ref/heads/master"* ]]; then',
      '    printf "%s\\n" "$MOCK_HEAD"',
      '  else',
      '    cat "$MOCK_ISSUES"',
      '  fi',
      'fi',
      '',
    ].join('\n'))
    chmodSync(gh, 0o755)
    const ran = spawnSync(script, arg === undefined ? [] : [arg], {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${dir}:${process.env.PATH ?? ''}`,
        MOCK_LOG: log,
        MOCK_HEAD: fixture.head ?? 'aaa111',
        MOCK_ISSUES: issuesFile,
        GH_TOKEN: 'dummy',
        GH_REPO: 'spankyed/apack-state',
        WORKFLOW: fixture.workflow ?? 'CI',
        RUN_URL: 'https://example/run/1',
        SHA: fixture.sha ?? 'aaa111',
      },
    })
    const calls = (() => {
      try { return readFileSync(log, 'utf8').trim().split('\n').filter(Boolean) } catch { return [] }
    })()
    return { status: ran.status, out: ran.stdout, err: ran.stderr, calls }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// The script runs on ubuntu-24.04 CI runners and depends on bash and jq.
await run(process.platform === 'win32' ? [] : [
  ['rejects a missing or unknown result without calling gh', () => {
    const empty = invoke(undefined)
    ok(empty.status !== 0 && empty.err.includes('Expected passed or failed'), empty.err)
    strictEqual(empty.calls.length, 0)

    const bad = invoke('pass')
    ok(bad.status !== 0 && bad.err.includes('Expected passed or failed'), bad.err)
    strictEqual(bad.calls.length, 0)
  }],
  ['skips superseded commits without touching issues', () => {
    const failed = invoke('failed', { sha: 'old000', head: 'new999' })
    strictEqual(failed.status, 0, failed.err)
    ok(failed.out.includes('no longer master HEAD'), failed.out)
    strictEqual(failed.calls.length, 1)

    const passed = invoke('passed', { sha: 'old000', head: 'new999', issues: '[{"number": 7, "title": "master fails: CI"}]' })
    strictEqual(passed.status, 0, passed.err)
    strictEqual(passed.calls.length, 1)
  }],
  ['failed opens an issue when none matches (ignoring PRs and other workflows)', () => {
    const issues = JSON.stringify([
      { number: 10, title: 'master fails: CI', pull_request: { url: 'x' } },
      { number: 11, title: 'master fails: mutants' },
    ])
    const ran = invoke('failed', { issues })
    strictEqual(ran.status, 0, ran.err)
    ok(ran.calls.some((line) => line.includes('[issue] [create] [--title] [master fails: CI] [--body] [https://example/run/1 failed on aaa111.]')), ran.calls.join('\n'))
  }],
  ['failed comments on only the first open matching issue across pages', () => {
    const issues = '[{"number": 21, "title": "master fails: CI"}]\n[{"number": 22, "title": "master fails: CI"}]\n'
    const ran = invoke('failed', { issues })
    strictEqual(ran.status, 0, ran.err)
    ok(ran.calls.some((line) => line.includes('[issue] [comment] [21] [--body] [https://example/run/1 failed on aaa111.]')), ran.calls.join('\n'))
    ok(!ran.calls.some((line) => line.includes('[comment] [22]')), ran.calls.join('\n'))
  }],
  ['passed closes every open matching issue across pages, and is quiet when none is open', () => {
    const issues = '[{"number": 21, "title": "master fails: CI"}]\n[{"number": 22, "title": "master fails: CI"}]\n'
    const ran = invoke('passed', { issues })
    strictEqual(ran.status, 0, ran.err)
    ok(ran.calls.some((line) => line.includes('[issue] [close] [21] [--comment] [https://example/run/1 passed on aaa111.]')), ran.calls.join('\n'))
    ok(ran.calls.some((line) => line.includes('[issue] [close] [22] [--comment] [https://example/run/1 passed on aaa111.]')), ran.calls.join('\n'))

    const none = invoke('passed', { issues: '[]' })
    strictEqual(none.status, 0, none.err)
    ok(!none.calls.some((line) => line.includes('[close]')), none.calls.join('\n'))
  }],
  ['handles quotes in the workflow name safely', () => {
    const workflow = 'CI "nightly"'
    const issues = JSON.stringify([{ number: 33, title: `master fails: ${workflow}` }])
    const ran = invoke('passed', { workflow, issues })
    strictEqual(ran.status, 0, ran.err)
    ok(ran.calls.some((line) => line.includes('[issue] [close] [33]')), ran.calls.join('\n'))
  }],
])
