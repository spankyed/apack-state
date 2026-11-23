import { playwright } from '@vitest/browser-playwright'
import { defineConfig } from 'vitest/config'

/** Each file is a spec, its checks its cases. `checks.mts`, `store.mts` and `store-elmdb.mts` are what they use. */
const checks = ['checks/*-check.mts', 'checks/rows-property.mts']
/**
 * What needs Node and is not run in a window: elmdb's binding (rows, the rows property, the views on elmdb) and
 * running the examples as processes.
 */
const nodeOnly = ['checks/rows-check.mts', 'checks/rows-property.mts', 'checks/views-check.mts', 'checks/examples-check.mts']

export default defineConfig({
  test: {
    // No case is given a time to finish in: one that does not come to rest fails saying so (`rest()`), and an
    // exploration stops at its limit.
    testTimeout: 0,
    hookTimeout: 0,
    // What an example prints as it goes is shown only when it fails.
    silent: 'passed-only',
    projects: [
      { extends: true, test: { name: 'node', include: checks } },
      {
        extends: true,
        // A window has no `node:assert`; the checks are given the package that is the same for browsers.
        resolve: { alias: { 'node:assert': 'assert' } },
        define: { 'process.env.NODE_DEBUG': 'false' },
        test: {
          name: 'browser',
          include: checks,
          exclude: nodeOnly,
          // One file at a time: files run side by side share one page's thread, and what the Vue checks count is what
          // renders between its turns.
          fileParallelism: false,
          browser: { enabled: true, provider: playwright(), headless: true, instances: [{ browser: 'chromium' }] },
        },
      },
    ],
  },
})
