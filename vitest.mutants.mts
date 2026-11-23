// What Stryker runs each mutant against: the checks in Node alone. A mutant changes code that runs the same in a
// window, and the runners that mutate have no browser to open for each one. Stryker's vitest runner runs every
// project of the config it is given, so it is given this one.
import { defineConfig } from 'vitest/config'
import { node, shared } from './vitest.config.mts'

export default defineConfig({ test: { ...shared, projects: [node] } })
