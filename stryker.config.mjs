// Mutation testing of src/: each mutant is a small change to the code, and a spec has to fail for it. It runs on CI's
// runners (.github/workflows/mutants.yml), a part of src/ a job, and never on a developer's machine. Which part is
// given as MUTATE, a Stryker `mutate` pattern such as `src/kernel.ts:1-275`.
//
// A mutant that hangs is ended by Stryker's own timeout: the specs give a case no time to finish in, and a change to
// the kernel can make one wait forever. That timeout is the tool's, and decides nothing a spec says. It is the time
// the mutant's specs took unchanged, three times over, and 15 seconds more: a mutant that hangs costs a worker that
// long, and one that only runs slow under four workers still has three times its time.
//
// Results are kept in an incremental file (reports/stryker-incremental.json), which CI caches. A run on master mutates
// everything and writes it afresh (`--force`); a run on a pull request starts from the last one and runs again only a
// mutant whose code changed, one killed by a spec in a file that changed, and one not killed that a new spec reaches.
export default {
  testRunner: 'vitest',
  // The checks in Node: a browser is not opened for each mutant.
  vitest: { configFile: 'vitest.mutants.mts' },
  mutate: (process.env.MUTATE ?? 'src/**/*.ts').split(','),
  coverageAnalysis: 'perTest',
  // A mutant of what runs as a module loads (a constant, a pattern) is run against every spec, not only the ones it
  // reaches: it costs a full run each, and there are few. Types are not mutated whatever this says.
  ignoreStatic: false,
  reporters: ['progress', 'clear-text', 'json'],
  jsonReporter: { fileName: 'reports/mutation/mutation.json' },
  incremental: true,
  timeoutMS: 15_000,
  timeoutFactor: 3,
  // CI's Linux runners have four cores.
  concurrency: 4,
  tempDirName: '.stryker-tmp',
}
