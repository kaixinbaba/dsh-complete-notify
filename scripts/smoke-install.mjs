#!/usr/bin/env node
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

const root = resolve(process.argv[2] ?? '.')
const home = mkdtempSync(join(tmpdir(), 'dsh-plugin-smoke-home-'))
const packDir = mkdtempSync(join(tmpdir(), 'dsh-plugin-smoke-pack-'))

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    ...options,
    env: {
      ...process.env,
      npm_config_registry: 'https://registry.npmjs.org/',
      ...options.env,
    },
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    const detail = [result.stdout, result.stderr].filter(Boolean).join('\n').trim()
    throw new Error(`${command} ${args.join(' ')} failed (${result.status}):\n${detail}`)
  }
  return result
}

try {
  const dshVersion = run('dsh', ['--version'])
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  const packed = run('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', packDir], { cwd: root })
  const packResult = JSON.parse(packed.stdout)[0]
  const tarball = join(packDir, packResult.filename)

  run('dsh', [
    'plugin', '--profile', 'contract-smoke', 'add', tarball,
    '--registry=https://registry.npmjs.org/',
    '--config.minimum-release-age=0',
  ], { cwd: root, env: { DSH_HOME: home } })

  const profilePath = join(home, 'profiles', 'contract-smoke', 'package.json')
  const profile = JSON.parse(readFileSync(profilePath, 'utf8'))
  if (!(manifest.name in (profile.dependencies ?? {}))) {
    throw new Error(`profile dependency is missing ${manifest.name}`)
  }
  if (!(profile.dsh?.profile?.bundles ?? []).includes(manifest.name)) {
    throw new Error(`profile bundle list is missing ${manifest.name}`)
  }

  const dump = run('dsh', ['--profile', 'contract-smoke', '--dump-config'], {
    cwd: root,
    env: { DSH_HOME: home },
  })
  if (!dump.stdout.includes(`name: '${manifest.name}'`) && !dump.stdout.includes(`name: ${manifest.name}`)) {
    throw new Error(`composed config does not contain plugin package ${manifest.name}`)
  }

  console.log(`✓ packed ${manifest.name}@${manifest.version}, installed it into an isolated DSH_HOME, and composed its patch with dsh ${dshVersion.stdout.trim()}`)
} finally {
  rmSync(home, { recursive: true, force: true })
  rmSync(packDir, { recursive: true, force: true })
}
