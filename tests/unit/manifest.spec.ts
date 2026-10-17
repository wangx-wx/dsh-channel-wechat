/**
 * The manifest is the only contract dsh reads before it ever loads our code:
 * `dsh plugin add` resolves it, `evaluatePluginCompatibility` gates it, and the
 * profile loader follows `dsh.bundle.patch` to our rows. A manifest that looks
 * right but declares the wrong peer range is rejected at install time with no
 * way to fix it from inside the plugin, so the fields are pinned here.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import semver from 'semver'
import ts from 'typescript'

const manifest = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as {
  name: string
  version: string
  type?: string
  private?: boolean
  license?: string
  exports?: Record<string, unknown>
  files?: string[]
  scripts?: Record<string, string>
  engines?: Record<string, string>
  peerDependencies?: Record<string, string>
  dependencies?: Record<string, string>
  dsh?: { bundle?: { patch?: string | string[] }; client?: { platform?: string; inject?: string[] } }
}

/**
 * The dsh runtime versions a released plugin must stay installable under.
 *
 * Exactly the ones measured against a real launcher with the integration suite:
 *
 *  - `0.2.0-rc.2` — the packaged desktop app (`DeepSeek Harness.app`), 99 tests
 *    pass with nothing skipped.
 *  - `0.2.1-rc.1` — installed from npm as `@deepseek-ai/dsh@0.2.1-rc.1` and
 *    staged into a checkout-shaped directory, 99 tests pass with nothing
 *    skipped. This is the release the `0.2.x` line was verified against.
 *
 * An earlier revision of this comment claimed `0.2.0-rc.2` skipped 15 tests and
 * blamed the version. That was a misattribution worth recording: the skips were
 * `client-half-runs` wanting the checkout's `ui-theme` sources and react, which
 * depends on where the SOURCES live, not on which DSH runs. Measured: the same
 * launch against the same packaged app reports 99/0 when the checkout's sources
 * are present and 84/15 when they are not. So the skip count cannot be evidence
 * about a runtime, and the harness silently substitutes the packaged app when a
 * checkout has no `lib/` - see `.dsh/skills/dsh-plugin-upgrade` for the probe
 * that removes the ambiguity.
 *
 * The rest of `0.2.x` satisfies the declared range but has not been run, so it
 * is not asserted here — claiming support we never exercised is how a plugin
 * comes to break on a version nobody tried.
 */
const RUNTIME_VERSIONS = ['0.2.0-rc.2', '0.2.1-rc.1']

/** How each {@link RUNTIME_VERSIONS} entry was measured, and what a run must show. */
const RUNTIME_EVIDENCE: Record<string, { launcher: string; skipped: number }> = {
  '0.2.0-rc.2': { launcher: 'the packaged DeepSeek Harness.app', skipped: 0 },
  '0.2.1-rc.1': { launcher: 'npm @deepseek-ai/dsh@0.2.1-rc.1, checkout-shaped', skipped: 0 },
}

/** Every source file that ends up in the published bundle. */
function sourceFiles(dir: URL): URL[] {
  const out: URL[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const child = new URL(`${entry.name}${entry.isDirectory() ? '/' : ''}`, dir)
    if (entry.isDirectory()) out.push(...sourceFiles(child))
    else if (/\.m?ts$/u.test(entry.name) && !entry.name.endsWith('.d.mts')) out.push(child)
  }
  return out
}

/**
 * Bare specifiers (not relative, not node: builtins) that `src/` imports.
 *
 * Parsed rather than pattern-matched: this source is dense with prose that
 * mentions `import` and quotes a path, and a regex reads those comments as
 * dependencies.
 * @returns each imported package name, deduplicated and sorted.
 */
function bareSpecifiers(): string[] {
  const found = new Set<string>()
  for (const file of sourceFiles(new URL('../../src/', import.meta.url))) {
    const parsed = ts.createSourceFile(file.pathname, readFileSync(file, 'utf8'), ts.ScriptTarget.ESNext, true)
    const specifiers: string[] = []
    const visit = (node: ts.Node): void => {
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier !== undefined) {
        if (ts.isStringLiteral(node.moduleSpecifier)) specifiers.push(node.moduleSpecifier.text)
      } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        const [first] = node.arguments
        if (first !== undefined && ts.isStringLiteral(first)) specifiers.push(first.text)
      }
      ts.forEachChild(node, visit)
    }
    visit(parsed)
    for (const specifier of specifiers) {
      if (specifier.startsWith('.') || specifier.startsWith('node:')) continue
      // A subpath import is served by the same declared dependency as its root.
      found.add(specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0]!)
    }
  }
  return [...found].sort()
}

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

  it('declares the dsh compatibility floor and keeps every measured runtime above it', () => {
    // `engines.dsh` decides alone once present: dsh ignores the dsh peers and
    // evaluates this range with includePrerelease. So this one string, not the
    // peer ranges, is what admits or refuses the install.
    //
    // There is deliberately NO upper bound. A ceiling would refuse every future
    // DSH release until this plugin republished, which for a channel plugin is a
    // worse failure than an untested runtime: the user's WeChat keeps working on
    // versions whose contracts this plugin does not use. The floor is what
    // actually matters, and it is spelled `>=0.2.0-rc.1` rather than `^0.2.0`
    // because a caret on the release excludes `0.2.0-rc.2` - the packaged
    // desktop app this plugin was verified against.
    const range = manifest.engines?.['dsh']
    expect(range).toBe('>=0.2.0-rc.1')
    for (const runtime of RUNTIME_VERSIONS) {
      expect(semver.satisfies(runtime, range!, { includePrerelease: true }), `engines.dsh ${range} vs ${runtime}`).toBe(true)
    }
  })

  it('pins the compatibility floor and deliberately leaves the ceiling open', () => {
    // Both edges are asserted so a change to either is visible in review. The
    // floor is the oldest runtime measured against a real launcher; runtimes
    // below it predate APIs this plugin calls, so they must be refused.
    const range = manifest.engines?.['dsh']
    if (range === undefined) throw new Error('engines.dsh is required')
    expect(semver.satisfies('0.2.0-rc.2', range, { includePrerelease: true })).toBe(true)
    expect(semver.satisfies('0.2.1-rc.1', range, { includePrerelease: true })).toBe(true)
    expect(semver.satisfies('0.1.7-rc.2', range, { includePrerelease: true })).toBe(false)
    // No ceiling: a future minor, a future major, and their prereleases are all
    // admitted rather than blocked until this package republishes.
    expect(semver.satisfies('0.3.0-rc.1', range, { includePrerelease: true })).toBe(true)
    expect(semver.satisfies('0.3.0', range, { includePrerelease: true })).toBe(true)
    expect(semver.satisfies('1.0.0', range, { includePrerelease: true })).toBe(true)
  })

  it('names how every claimed runtime was measured, and claims nothing it cannot', () => {
    // A version in RUNTIME_VERSIONS is a support claim. Recording the evidence
    // beside it is what keeps that claim honest: a name added without a run
    // would otherwise read exactly like one that was verified, which is the
    // failure this list exists to prevent.
    expect(Object.keys(RUNTIME_EVIDENCE).sort()).toEqual([...RUNTIME_VERSIONS].sort())
    for (const runtime of RUNTIME_VERSIONS) {
      const evidence = RUNTIME_EVIDENCE[runtime]
      if (evidence === undefined) throw new Error(`no measurement recorded for ${runtime}`)
      expect(evidence.launcher.trim()).not.toBe('')
      expect(evidence.skipped).toBeGreaterThanOrEqual(0)
    }
    // The newest verified release runs the whole suite; a skip there would mean
    // this list is claiming coverage the run did not produce.
    expect(RUNTIME_EVIDENCE['0.2.1-rc.1']?.skipped).toBe(0)
  })

  it('exposes a root export the loader can import', () => {
    expect(manifest.exports?.['.']).toBeDefined()
    expect(manifest.name).toBe('dsh-channel-wechat')
    expect(manifest.type).toBe('module')
  })

  it('declares every exported subpath in a form the loader can resolve', () => {
    // Every subpath has to be resolvable, and a type face has to point at
    // something that ships or `tsc` falls back to `any` for every consumer.
    const entries = Object.entries(manifest.exports ?? {})
    expect(entries.length).toBeGreaterThan(0)
    for (const [subpath, target] of entries) {
      if (subpath === './package.json') continue
      const resolved = typeof target === 'string' ? target : (target as { default?: string; types?: string })
      const main = typeof resolved === 'string' ? resolved : resolved.default
      expect(main, `${subpath} must declare a runtime target`).toBeTypeOf('string')
    }
  })

  it('declares the browser half the client module system serves', () => {
    // `dsh.client` and `exports["./client"]` are two halves of one contract, and
    // a mismatch between them is silent: the host starts, the channel works, and
    // the login button simply never appears. The client system scans Loader rows
    // for `dsh.client`, then resolves `exports["./client"]` to serve it - so both
    // have to be present, `platform` has to be the one it selects, and the path
    // has to be a plain string.
    expect(manifest.dsh?.client?.platform).toBe('web')
    expect(manifest.exports?.['./client']).toBeTypeOf('string')
    // A path the build does not emit fails *activation*, not install, so it is
    // pinned to a file that exists rather than to a remembered string.
    expect(existsSync(new URL(`../../${String(manifest.exports?.['./client'])}`, import.meta.url))).toBe(true)
  })

  it('declares a root export as a plain path string', () => {
    // dsh reads exports["."] directly; a conditional object without a usable
    // default is the shape that fails at load rather than at install.
    const entry = manifest.exports?.['.']
    const target = typeof entry === 'string'
      ? entry
      : entry && typeof entry === 'object' && 'default' in entry ? entry.default : undefined
    expect(target, 'root export must resolve to a path').toBeTypeOf('string')
    expect(target).toMatch(/^\.\/.+\.js$/u)
  })

  it('declares every bare specifier its own source imports', () => {
    // An undeclared import still resolves while developing, because this
    // checkout's node_modules is hoisted and holds the whole harness. It stops
    // resolving once the package is installed somewhere its ancestors do not
    // happen to provide that name, and the failure appears at plugin load, far
    // from the missing declaration.
    const declared = new Set([
      ...Object.keys(manifest.dependencies ?? {}),
      ...Object.keys(manifest.peerDependencies ?? {}),
    ])
    const missing = bareSpecifiers().filter(specifier => !declared.has(specifier))
    expect(missing, `undeclared imports: ${missing.join(', ')}`).toEqual([])
  })

  it('keeps dsh runtime packages out of dependencies, where the profile would duplicate them', () => {
    // The failure this exists for is silent and only appears on a real turn.
    //
    // `dependencies` is installed INTO the profile. A `@deepseek-ai/*` package
    // declared there gets its own physical copy under
    // `$DSH_HOME/profiles/<name>/node_modules`, beside the identical copy the
    // installation already resolves from its own closure. Two physical
    // instances of one package are two module graphs: `cosmokit` seeds
    // `Symbol.for("cosmokit.volatile.write")` and cordis builds its reactive
    // system on it, so a plugin holding instance B registers effects the Host's
    // instance A never sees. The reported symptoms were
    // `no agent factory registered` and
    // `cannot create effect on inactive context` - every inbound WeChat message
    // failed - while the plugin loaded, advertised its routes, and reported
    // nothing wrong.
    //
    // The versions match in that state, which is why a version check cannot
    // catch it: the copies differed only by inode. Declaring these as peers
    // instead makes the profile resolve the one closure the Host already has.
    const core = Object.keys(manifest.dependencies ?? {}).filter(name => name.startsWith('@deepseek-ai/'))
    expect(core, `dsh runtime packages installed into the profile: ${core.join(', ')}`).toEqual([])
  })

  it('ships every path its exports point at', () => {
    // `exports` is what a consumer resolves; `files` is what npm packs. They
    // are independent fields, so a type face can point at a source path that
    // the tarball omits - the consumer silently falls back to `any`, and the
    // breakage lands on whoever installs rather than on whoever published.
    const shipped = (path: string): boolean => {
      const clean = path.replace(/^\.\//u, '')
      return (manifest.files ?? []).some(entry => clean === entry || clean.startsWith(entry))
    }
    const offenders: string[] = []
    for (const [subpath, target] of Object.entries(manifest.exports ?? {})) {
      if (subpath === './package.json') continue
      const fields = typeof target === 'string' ? [target] : Object.values(target as Record<string, string>)
      for (const path of fields) {
        if (typeof path === 'string' && path.startsWith('./') && !shipped(path)) offenders.push(`${subpath} -> ${path}`)
      }
    }
    expect(offenders, `exports point outside files[]: ${offenders.join(', ')}`).toEqual([])
  })

  it('builds before packing, so a publish cannot ship an empty package', () => {
    // lib/ is generated and git-ignored. Without a hook that runs the build,
    // `npm publish` from a fresh clone packs only the hand-written files -
    // measured: 4 files, 10.1 kB, no code at all - and reports success.
    const hooks = Object.entries(manifest.scripts ?? {})
      .filter(([name]) => /^(prepack|prepublishOnly|prepare)$/u.test(name))
      .map(([, command]) => command)
    expect(hooks.length, 'one of prepack/prepublishOnly/prepare must build').toBeGreaterThan(0)
    expect(
      hooks.some(command => /\b(build|tsdown)\b/u.test(command)),
      'the publish hook must actually run the build',
    ).toBe(true)
  })
})
