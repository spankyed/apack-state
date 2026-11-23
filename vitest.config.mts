import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Each file is a spec, its checks its cases. `checks.mts`, `store.mts` and `store-elmdb.mts` are what they use.
    include: ['checks/*-check.mts', 'checks/rows-property.mts'],
    // No case is given a time to finish in: one that does not come to rest fails saying so (`rest()`), and an
    // exploration stops at its limit.
    testTimeout: 0,
    hookTimeout: 0,
    // What an example prints as it goes is shown only when it fails.
    silent: 'passed-only',
  },
})
