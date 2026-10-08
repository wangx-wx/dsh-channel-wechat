/**
 * The manifest is the only contract dsh reads before it ever loads our code:
 * `dsh plugin add` resolves it, `evaluatePluginCompatibility` gates it, and the
 * profile loader follows `dsh.bundle.patch` to our rows. A manifest that looks
 * right but declares the wrong peer range is rejected at install time with no
 * way to fix it from inside the plugin, so the fields are pinned here.
 */

import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import semver from 'semver'

const root = fileURLToPath(new URL('../..', import.meta.url))
const manifest = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as {
  name: string
  version: string
  type?: string
  private?: boolean
  license?: string
  exports?: Record<string, unknown>
  files?: string[]
  peerDependencies?: Record<string, string>
  dependencies?: Record<string, string>
  dsh?: { bundle?: { patch?: string | string[] } }
}

/** The dsh runtime versions a released plugin must stay installable under. */
const RUNTIME_VERSIONS = ['0.2.0-rc.1', '0.2.0-rc.2']

describe('package manifest', () => {
  it('declares the bundle patch file the profile loader follows', () => {
    const patch = manifest.dsh?.bundle?.patch
    expect(patch).toBe('./cordis.patch.yml')
    expect(existsSync(new URL('../../cordis.patch.yml', import.meta.url))).toBe(true)
  })

  it('resolves every dsh peer range under the prerelease runtimes', () => {
    // dsh evaluates peers with includePrerelease, so a caret on the release
    // (^0.2.0) rejects 0.2.0-rc.1 outright and the install is refused.
    const peers = Object.entries(manifest.peerDependencies ?? {})
      .filter(([name]) => name === '@deepseek-ai/dsh' || name.startsWith('@deepseek-ai/dsh-'))
    expect(peers.length).toBeGreaterThan(0)
    for (const [name, range] of peers) {
      for (const runtime of RUNTIME_VERSIONS) {
        expect(semver.satisfies(runtime, range, { includePrerelease: true }), `${name} ${range} vs ${runtime}`).toBe(true)
      }
    }
  })

  it('exposes a root export the loader can import', () => {
    expect(manifest.exports?.['.']).toBeDefined()
    expect(manifest.name).toBe('dsh-channel-wechat')
    expect(manifest.type).toBe('module')
  })

  it('points every declared entry at a file the build actually emits', () => {
    // A manifest whose entry path drifts from the builder's output installs
    // cleanly and then fails at load with no actionable message, so the two
    // are pinned to each other rather than to a remembered filename.
    const entry = manifest.exports?.['.']
    const target = typeof entry === 'string' ? entry : entry && typeof entry === 'object' && 'default' in entry ? String(entry.default) : undefined
    expect(target, 'root export must be a resolvable path').toBeTypeOf('string')
    expect(existsSync(new URL(`../../${target}`, import.meta.url)), `missing build output ${target}`).toBe(true)
  })
})
