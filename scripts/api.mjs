// The API reports: for each entry `package.json` exports, what a consumer can reach through it, as API Extractor
// reads it from the declarations, in `etc/<entry>.api.md`. `npm run api:check` fails when a report is not what the
// source says, or API Extractor finds a problem; `npm run api:update` writes them. A change to what the package
// offers shows as a change to a report.
//
// A type a public signature uses but no entry exports is listed in the report (`ae-forgotten-export`): a consumer can
// meet it and not name it. Each is a decision, and the list is where it is seen.
import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { Extractor, ExtractorConfig, ExtractorLogLevel } from '@microsoft/api-extractor'

const root = path.resolve(import.meta.dirname, '..')
const local = process.argv.includes('--local')
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
const types = path.join(root, '.temp', 'api-types')
const reports = path.join(root, 'etc')

// The declarations, emitted afresh from the source into a folder of their own: the reports are of the source, not of
// whatever `dist/` holds.
fs.rmSync(types, { recursive: true, force: true })
const tsc = spawnSync(process.execPath, [path.join(root, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', 'tsconfig.api.json'], { cwd: root, stdio: 'inherit' })
if (tsc.status !== 0) process.exit(1)

/** Each entry, by the name its report is given, and the declaration its `types` names, as emitted from the source. */
const entries = Object.entries(manifest.exports).map(([key, target]) => [
  key === '.' ? 'index' : key.slice(2),
  path.join(types, target.types.replace(/^\.\/dist\//, '')),
])

if (local) fs.mkdirSync(reports, { recursive: true })
let failed = 0
for (const [name, declaration] of entries) {
  const config = ExtractorConfig.prepare({
    configObject: {
      projectFolder: root,
      mainEntryPointFilePath: declaration,
      newlineKind: 'lf',
      compiler: { tsconfigFilePath: path.join(root, 'tsconfig.api.json') },
      apiReport: { enabled: true, reportFolder: reports, reportFileName: `${name}.api.md`, reportTempFolder: path.join(root, '.temp') },
      docModel: { enabled: false },
      dtsRollup: { enabled: false },
      tsdocMetadata: { enabled: false },
      // `prepare` applies none of API Extractor's defaults, and without these nothing is ever reported.
      messages: {
        compilerMessageReporting: { default: { logLevel: ExtractorLogLevel.Warning } },
        extractorMessageReporting: {
          default: { logLevel: ExtractorLogLevel.Warning },
          'ae-forgotten-export': { logLevel: ExtractorLogLevel.None, addToApiReportFile: true },
          'ae-incompatible-release-tags': { logLevel: ExtractorLogLevel.Warning, addToApiReportFile: true },
          'ae-internal-missing-underscore': { logLevel: ExtractorLogLevel.None },
          'ae-internal-mixed-release-tag': { logLevel: ExtractorLogLevel.Warning, addToApiReportFile: true },
          'ae-undocumented': { logLevel: ExtractorLogLevel.None },
          // Every export is public; a tag is only how `@internal` is marked.
          'ae-missing-release-tag': { logLevel: ExtractorLogLevel.None },
          'ae-wrong-input-file-type': { logLevel: ExtractorLogLevel.Error },
        },
        // TSDoc syntax is not what these reports hold the package to.
        tsdocMessageReporting: { default: { logLevel: ExtractorLogLevel.None } },
      },
    },
    configObjectFullPath: undefined,
    packageJsonFullPath: path.join(root, 'package.json'),
  })
  const result = Extractor.invoke(config, { localBuild: local, showVerboseMessages: false })
  if (!result.succeeded) {
    failed++
    console.error(`${name}: ${result.apiReportChanged ? 'the report is not what the source says: run npm run api:update and commit it' : `${result.errorCount} errors, ${result.warningCount} warnings`}`)
  } else console.log(`${name}: ${local && result.apiReportChanged ? 'written' : 'as the source says'}`)
}
process.exit(failed ? 1 : 0)
