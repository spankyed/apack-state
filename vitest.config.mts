import { playwright } from '@vitest/browser-playwright'
import { defineConfig } from 'vitest/config'

/** Each file is a spec, its checks its cases. `checks.mts`, `store.mts` and `store-elmdb.mts` are what they use. */
const checks = ['checks/*-check.mts', 'checks/rows-property.mts']
/**
 * What needs Node and is not run in a window: elmdb's binding (rows, the rows property, the views on elmdb) and
 * running the examples as processes.
 */
const nodeOnly = ['checks/rows-check.mts', 'checks/rows-property.mts', 'checks/views-check.mts', 'checks/examples-check.mts', 'checks/graph-check.mts', 'checks/inspect-graph-check.mts', 'checks/refusals-check.mts', 'checks/mutants-check.mts', 'checks/master-status-check.mts']

/** What every run of the checks is given. */
export const shared = {
  // No case is given a time to finish in: one that does not come to rest fails saying so (`rest()`), and an
  // exploration stops at its limit.
  testTimeout: 0,
  hookTimeout: 0,
  // What an example prints as it goes is shown only when it fails.
  silent: 'passed-only',
} as const

/** The checks in Node: what the suite runs on three systems, and all a mutant is run against (`vitest.mutants.mts`). */
export const node = { extends: true as const, test: { name: 'node', include: checks } }

export default defineConfig({
  test: {
    ...shared,
    projects: [
      node,
      {
        extends: true,
        // A window has no `node:assert`; the checks are given the package that is the same for browsers.
        resolve: { alias: { 'node:assert': 'assert' } },
        // Found before the run, not part-way through it: Vite reloads a page whose dependencies it optimizes as it
        // finds them, and a component would then read from another copy of Vue's reactivity than the kernel writes to.
        optimizeDeps: { include: ['@vue/runtime-core', '@vue/reactivity', '@vue/compiler-dom', 'assert'] },
        define: { 'process.env.NODE_DEBUG': 'false' },
        test: {
          name: 'browser',
          include: checks,
          exclude: nodeOnly,
          // One file at a time: files run side by side share one page's thread, and what the Vue checks count is what
          // renders between its turns.
          fileParallelism: false,
          // A check that fails says why in what it throws; a picture of a page the checks draw nothing on says nothing.
          browser: { enabled: true, provider: playwright(), headless: true, screenshotFailures: false, instances: [{ browser: 'chromium' }] },
        },
      },
    ],
  },
})
