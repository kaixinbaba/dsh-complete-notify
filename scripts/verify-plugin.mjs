#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

const args = process.argv.slice(2)
const rootArg = args.find((arg) => !arg.startsWith('--')) ?? '.'
const levelArg = args.find((arg) => arg.startsWith('--level='))
const level = levelArg?.slice('--level='.length) ?? 'contract'
const shouldPack = !args.includes('--no-pack')
const jsonOutput = args.includes('--json')

if (!['contract', 'standard'].includes(level)) {
  console.error('usage: verify-plugin.mjs [plugin-dir] [--level=contract|standard] [--no-pack] [--json]')
  process.exit(2)
}

const root = resolve(rootArg)
const errors = []
const warnings = []

function fail(message) { errors.push(message) }
function warn(message) { warnings.push(message) }
function check(condition, message) { if (!condition) fail(message) }
function readJson(path, label) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    fail(`${label} is not readable JSON: ${error instanceof Error ? error.message : String(error)}`)
    return null
  }
}
function exportTarget(exportsField, key) {
  const value = exportsField?.[key]
  if (typeof value === 'string') return value
  if (value && typeof value === 'object' && typeof value.default === 'string') return value.default
  return null
}
function targetExists(target, label) {
  if (target === null) {
    fail(`missing string export ${label}`)
    return
  }
  check(target.startsWith('./'), `export ${label} must be package-relative`)
  check(existsSync(resolve(root, target)), `export ${label} target does not exist: ${target}`)
}

const manifestPath = resolve(root, 'package.json')
const manifest = readJson(manifestPath, 'package.json')
if (manifest === null) {
  finish()
  process.exit(1)
}

const packageNamePattern = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/
check(typeof manifest.name === 'string' && packageNamePattern.test(manifest.name), 'package.json name must be a valid lowercase npm package name')
check(typeof manifest.version === 'string' && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(manifest.version), 'package.json version must be semver')
check(typeof manifest.description === 'string' && manifest.description.trim().length >= 20, 'package.json description must explain the plugin')
check(manifest.type === 'module', 'package.json type must be module')
check(typeof manifest.license === 'string' && manifest.license.length > 0, 'package.json license is required')
check(manifest.private !== true, 'published plugin must not set private:true')
check(manifest.publishConfig?.access === 'public', 'publishConfig.access must be public')
check(Array.isArray(manifest.files) && manifest.files.length > 0, 'package.json files whitelist is required')
check(manifest.repository !== undefined, 'package.json repository is required')
check(typeof manifest.homepage === 'string' && manifest.homepage.length > 0, 'package.json homepage is required')
check(typeof manifest.bugs?.url === 'string' && manifest.bugs.url.length > 0, 'package.json bugs.url is required')
check(Array.isArray(manifest.keywords) && manifest.keywords.includes('dsh-plugin'), 'package.json keywords must include dsh-plugin')

const patch = manifest.dsh?.bundle?.patch
check(typeof patch === 'string' && patch.length > 0, 'dsh.bundle.patch is required')
if (typeof patch === 'string') check(existsSync(resolve(root, patch)), `bundle patch does not exist: ${patch}`)

const exportsField = manifest.exports
check(exportsField && typeof exportsField === 'object' && !Array.isArray(exportsField), 'package.json exports object is required')
targetExists(exportTarget(exportsField, '.'), '"."')
targetExists(exportTarget(exportsField, './cordis.patch.yml'), '"./cordis.patch.yml"')
targetExists(exportTarget(exportsField, './package.json'), '"./package.json"')

const client = manifest.dsh?.client
const clientTarget = exportTarget(exportsField, './client')
if (client !== undefined) {
  check(client?.platform === 'web', 'dsh.client.platform must be web')
  check(Array.isArray(client?.inject) && client.inject.every((item) => typeof item === 'string'), 'dsh.client.inject must be a string array')
  targetExists(clientTarget, '"./client"')
} else if (clientTarget !== null) {
  fail('exports["./client"] requires a matching dsh.client declaration')
}

if (typeof patch === 'string' && existsSync(resolve(root, patch))) {
  const source = readFileSync(resolve(root, patch), 'utf8')
  check(/^- insert:\s*$/m.test(source), 'bundle patch must contain an insert operation')
  if (typeof manifest.name === 'string') {
    const escaped = manifest.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    check(new RegExp(`^\\s+name:\\s*['"]?${escaped}['"]?\\s*$`, 'm').test(source), 'bundle patch must insert the package name')
  }
  const ids = [...source.matchAll(/^\s+- id:\s*['"]?([^'"#\s]+)['"]?/gm)].map((match) => match[1])
  check(ids.length === 1, 'bundle patch must insert exactly one plugin id')
}

for (const file of ['README.md', 'LICENSE']) {
  check(existsSync(resolve(root, file)), `required published file is missing: ${file}`)
}

if (level === 'standard') {
  check(manifest.private === false, 'standard requires explicit private:false')
  check(typeof manifest.engines?.node === 'string', 'standard requires engines.node')
  check(typeof manifest.engines?.dsh === 'string', 'standard requires engines.dsh')
  for (const script of ['check', 'test', 'test:integration', 'verify:plugin', 'smoke:install', 'prepack']) {
    check(typeof manifest.scripts?.[script] === 'string', `standard requires npm script ${script}`)
  }
  check(existsSync(resolve(root, 'tests/integration/plugin-contract.test.js')), 'standard integration contract test is missing')
  check(existsSync(resolve(root, '.github/workflows/ci.yml')), 'standard GitHub Actions CI workflow is missing')
  check(existsSync(resolve(root, 'CHANGELOG.md')), 'standard CHANGELOG.md is missing')
}

if (shouldPack) {
  const packed = spawnSync('npm', ['pack', '--json', '--dry-run', '--ignore-scripts'], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, npm_config_registry: 'https://registry.npmjs.org/' },
  })
  if (packed.status !== 0) {
    fail(`npm pack --dry-run failed: ${(packed.stderr || packed.stdout).trim()}`)
  } else {
    try {
      const result = JSON.parse(packed.stdout)[0]
      const paths = new Set((result.files ?? []).map((entry) => entry.path))
      const requiredPaths = [
        'package.json',
        typeof patch === 'string' ? patch.replace(/^\.\//, '') : null,
        exportTarget(exportsField, '.')?.replace(/^\.\//, ''),
        clientTarget?.replace(/^\.\//, ''),
      ].filter(Boolean)
      for (const required of requiredPaths) check(paths.has(required), `packed artifact is missing ${required}`)
      for (const path of paths) {
        if (/(^|\/)(?:tests?|screenshots?|\.env)(?:\/|$)/.test(path)) fail(`packed artifact contains development-only path: ${path}`)
      }
    } catch (error) {
      fail(`could not parse npm pack --json output: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}

if (level === 'contract') {
  if (manifest.private !== false) warn('recommended: set private:false explicitly')
  if (typeof manifest.engines?.node !== 'string' || typeof manifest.engines?.dsh !== 'string') warn('recommended: declare engines.node and engines.dsh')
  if (!existsSync(resolve(root, '.github/workflows/ci.yml'))) warn('missing CI workflow')
  if (typeof manifest.scripts?.['test:integration'] !== 'string') warn('missing non-business integration test lane')
}

finish()

function finish() {
  const result = {
    ok: errors.length === 0,
    package: manifest?.name ?? basename(root),
    version: manifest?.version ?? null,
    level,
    root,
    errors,
    warnings,
  }
  if (jsonOutput) {
    console.log(JSON.stringify(result, null, 2))
  } else if (result.ok) {
    console.log(`✓ ${result.package}@${result.version ?? '?'} passes DSH plugin ${level} verification`)
    for (const message of warnings) console.log(`  warning: ${message}`)
  } else {
    console.error(`✗ ${result.package} fails DSH plugin ${level} verification`)
    for (const message of errors) console.error(`  - ${message}`)
    for (const message of warnings) console.error(`  warning: ${message}`)
  }
  process.exitCode = result.ok ? 0 : 1
}
