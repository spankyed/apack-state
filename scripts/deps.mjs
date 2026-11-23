#!/usr/bin/env node
// Where the packages this repository takes from its siblings come from, chosen in one place: each sibling's CI packs
// every commit on its default branch and attaches the tarballs to a release `<tag>-<commit>`, and `package.json` names
// each tarball by URL. This writes those URLs from the table below and runs `npm install`, which records what it
// installed in the lockfile. No URL is edited by hand.
//
//   npm run deps:pin -- <repo> <commit>    each package's tarball from the release that sibling's CI made of that commit
//   npm run deps:local -- <repo> [path]    each package's directory in a local checkout (default: the sibling checkout
//                                          beside this one), which must be built; never committed
//   npm run deps:released [-- <repo>]      the release URLs HEAD names, undoing deps:local
//   npm run deps:check                     fails unless every sibling's packages are named by a release URL from the
//                                          table, all of one sibling's at one commit; CI runs it
//
// Plain Node, importing nothing outside `node:`, so it runs before anything is installed.
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')
const MANIFEST = path.join(ROOT, 'package.json')
/** The GitHub owner of every sibling */
const OWNER = 'spankyed'
/**
 * The siblings, the release tag each one's CI makes, and each package it publishes: `file` its tarball's name in the
 * release, `dir` its directory in a checkout. Which of them this repository installs is what its manifest names.
 */
const SIBLINGS = {
  elmdb: {
    tag: 'pkg',
    packages: {
      elmdb: { file: 'elmdb-0.1.0.tgz', dir: 'crates/elmdb-node' },
      '@elmdb/ears': { file: 'elmdb-ears-0.1.0.tgz', dir: 'packages/ears' },
    },
  },
  'apack-link': {
    tag: 'pkg',
    packages: {
      '@apackdev/link': { file: 'apackdev-link-0.1.0.tgz', dir: '.' },
    },
  },
}

/** @param {string} message @returns {never} */
function refuse(message) {
  console.error(message)
  process.exit(1)
}

const releaseUrl = (repo, commit, name) => `https://github.com/${OWNER}/${repo}/releases/download/${SIBLINGS[repo].tag}-${commit}/${SIBLINGS[repo].packages[name].file}`
/** The sibling, commit and file a release URL names, or undefined for anything else */
const releaseOf = (spec) => {
  const match = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/releases\/download\/([a-z]+)-([0-9a-f]{40})\/([^/]+)$/.exec(spec)
  return match && match[1] === OWNER && match[2] in SIBLINGS && match[3] === SIBLINGS[match[2]].tag ? { repo: match[2], commit: match[4], file: match[5] } : undefined
}
const devDependencies = () => JSON.parse(readFileSync(MANIFEST, 'utf8')).devDependencies ?? {}
/** The packages of `repo` this repository installs */
const installed = (repo) => Object.keys(SIBLINGS[repo].packages).filter((name) => name in devDependencies())

/**
 * Rewrites the named devDependencies, line by line, so the rest of the manifest keeps its bytes. A package not yet
 * installed is added, and the entries kept in order.
 */
function writeSpecs(specs) {
  const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'))
  const missing = Object.keys(specs).filter((name) => !(name in (manifest.devDependencies ?? {})))
  if (missing.length) {
    manifest.devDependencies = Object.fromEntries(Object.entries({ ...manifest.devDependencies, ...specs }).sort(([a], [b]) => a.localeCompare(b)))
    writeFileSync(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`)
    return
  }
  let text = readFileSync(MANIFEST, 'utf8')
  for (const [name, spec] of Object.entries(specs)) {
    const line = new RegExp(`^(    ${JSON.stringify(name).replace(/[/]/g, '\\/')}: )"[^"]*"`, 'm')
    if (!line.test(text)) refuse(`package.json names ${name} in a way this cannot rewrite.`)
    text = text.replace(line, `$1${JSON.stringify(spec)}`)
  }
  writeFileSync(MANIFEST, text)
}

function install() {
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
  const ran = spawnSync(npm, ['install', '--no-audit', '--no-fund'], { cwd: ROOT, stdio: 'inherit', shell: process.platform === 'win32' })
  process.exit(ran.status ?? 1)
}

function sibling(repo) {
  if (repo === undefined || !(repo in SIBLINGS)) refuse(`Name a sibling: ${Object.keys(SIBLINGS).join(', ')}.`)
  return repo
}

/** Every package a sibling publishes that this repository installs, or all of them when it installs none yet */
const chosen = (repo) => (installed(repo).length ? installed(repo) : Object.keys(SIBLINGS[repo].packages))

function pin(repo, commit) {
  if (commit === undefined || !/^[0-9a-f]{40}$/.test(commit)) refuse('Name the commit by its full 40-character hash.')
  writeSpecs(Object.fromEntries(chosen(repo).map((name) => [name, releaseUrl(repo, commit, name)])))
  console.log(`${repo}: the release of ${commit}`)
}

function local(repo, given) {
  const checkout = path.resolve(given ?? path.join(ROOT, '..', repo))
  writeSpecs(Object.fromEntries(chosen(repo).map((name) => {
    const dir = path.join(checkout, SIBLINGS[repo].packages[name].dir)
    if (!existsSync(path.join(dir, 'package.json'))) refuse(`${dir} holds no package.json: is ${checkout} a checkout of ${repo}?`)
    return [name, `file:${path.relative(ROOT, dir).split(path.sep).join('/')}`]
  })))
  console.log(`${repo}: the checkout at ${checkout}, which has to be built (npm run deps:released undoes this)`)
}

function released(repos) {
  const committed = JSON.parse(execFileSync('git', ['show', 'HEAD:package.json'], { cwd: ROOT, encoding: 'utf8' })).devDependencies ?? {}
  const specs = {}
  for (const repo of repos) {
    for (const name of installed(repo)) {
      if (releaseOf(committed[name] ?? '')?.repo !== repo) refuse(`HEAD's package.json does not name a release of ${repo} for ${name}: ${committed[name]}`)
      specs[name] = committed[name]
    }
  }
  writeSpecs(specs)
  console.log(`${repos.join(', ')}: the releases HEAD names`)
}

/** Every sibling package named by a release URL from the table, with its own file, and one commit a sibling */
function check() {
  const problems = []
  for (const repo of Object.keys(SIBLINGS)) {
    const commits = new Set()
    for (const name of installed(repo)) {
      const spec = devDependencies()[name]
      const release = releaseOf(spec)
      if (!release || release.repo !== repo) { problems.push(`${name} is ${spec}: not a release of ${repo} (npm run deps:pin -- ${repo} <commit>)`); continue }
      if (release.file !== SIBLINGS[repo].packages[name].file) problems.push(`${name} names ${release.file}, and ${repo}'s release holds it as ${SIBLINGS[repo].packages[name].file}`)
      commits.add(release.commit)
    }
    if (commits.size > 1) problems.push(`${repo}'s packages are pinned to different commits: ${[...commits].join(', ')}`)
  }
  if (problems.length) refuse(`The siblings' packages are not as deps:pin writes them:\n  ${problems.join('\n  ')}`)
  console.log(Object.keys(SIBLINGS).map((repo) => {
    const names = installed(repo)
    return names.length ? `${repo}: ${releaseOf(devDependencies()[names[0]]).commit}` : `${repo}: not installed`
  }).join('\n'))
}

const [command, repo, argument] = process.argv.slice(2)
if (command === 'check') { check(); process.exit(0) }
if (command === 'pin') pin(sibling(repo), argument)
else if (command === 'local') local(sibling(repo), argument)
else if (command === 'released') released(repo === undefined ? Object.keys(SIBLINGS) : [sibling(repo)])
else refuse('Usage: node scripts/deps.mjs <pin <repo> <commit> | local <repo> [path] | released [repo] | check>')
install()
