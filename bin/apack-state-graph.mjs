#!/usr/bin/env node
import { runGraphCli } from '../dist/graph.js'

process.exitCode = runGraphCli(process.argv.slice(2))
