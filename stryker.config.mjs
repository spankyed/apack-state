// Mutation testing of src/: each mutant is a small change to the code, and a spec has to fail for it. It runs on CI's
// runners (.github/workflows/mutants.yml), a part of src/ a job, and never on a developer's machine. Which part is
// given as MUTATE, a Stryker `mutate` pattern such as `src/kernel.ts:1-275`.
//
// A mutant that hangs is ended by Stryker's own timeout: the specs give a case no time to finish in, and a change to
// the kernel can make one wait forever. That timeout is the tool's, and decides nothing a spec says.
export default {
  testRunner: 'vitest',
  vitest: { configFile: 'vitest.config.mts' },
  mutate: (process.env.MUTATE ?? 'src/**/*.ts').split(','),
  coverageAnalysis: 'perTest',
  // A type is not code: there is nothing in it to change that a spec could notice running.
  ignoreStatic: true,
  reporters: ['progress', 'clear-text', 'json'],
  jsonReporter: { fileName: 'reports/mutation/mutation.json' },
  timeoutMS: 60_000,
  timeoutFactor: 3,
  concurrency: 2,
  tempDirName: '.stryker-tmp',
}
