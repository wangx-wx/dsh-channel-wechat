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
  keywords?: string[]
  icon?: string
  exports?: Record<string, unknown>
  files?: string[]
  scripts?: Record<string, string>
  engines?: Record<string, string>
  peerDependencies?: Record<string, string>
  dependencies?: Record<string, string>
  dsh?: { bundle?: { patch?: string | string[] }; client?: { platform?: string; inject?: string[] } }
}

/** Whether npm would pack a `./`-relative path, given the declared `files[]`. */
const shipped = (path: string): boolean => {
  const clean = path.replace(/^\.\//u, '')
  return (manifest.files ?? []).some(entry => clean === entry || clean.startsWith(entry))
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
const RUNTIME_VERSIONS = ['0.2.0-rc.2', '0.2.1-rc.1', '0.2.1-rc.2']

/** How each {@link RUNTIME_VERSIONS} entry was measured, and what a run must show. */
const RUNTIME_EVIDENCE: Record<string, { launcher: string; skipped: number }> = {
  '0.2.0-rc.2': { launcher: 'the packaged DeepSeek Harness.app', skipped: 0 },
  '0.2.1-rc.1': { launcher: 'npm @deepseek-ai/dsh@0.2.1-rc.1, checkout-shaped', skipped: 0 },
  '0.2.1-rc.2': { launcher: 'the packaged DeepSeek Harness.app', skipped: 0 },
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

describe('discovery metadata', () => {
  // Everything below is read by DSH *without loading our code*: the plugin page
  // calls `readPluginMeta` for the icon and locale files, and the market index
  // lists what a user can install. None of it is exercised by the runtime tests,
  // and every field fails silently - a bad icon path, a locale file left out of
  // `files`, a keyword typo - so each one is pinned to the file it names.

  it('carries the github topic dsh reads for discovery in its keywords', () => {
    // `dsh-plugin` is the only topic the harness README and CONTRIBUTING name.
    // It is also copied verbatim into the market index's `metadata.keywords`,
    // where it is searchable - so a typo costs a word and nothing complains.
    expect(manifest.keywords).toContain('dsh-plugin')
  })

  it('declares an icon the plugin page can render', () => {
    const icon = manifest.icon
    expect(icon, 'package.json must declare `icon`').toBeTypeOf('string')
    // DSH rejects an absolute path or a URL, and any file outside the package.
    expect(icon).toMatch(/^\.\/[^/].*\.svg$/u)
    expect(shipped(String(icon)), `${String(icon)} must be in files[]`).toBe(true)
    const file = new URL(`../../${String(icon)}`, import.meta.url)
    expect(existsSync(file), `${String(icon)} must exist`).toBe(true)
    // The 256 KiB ceiling is DSH's, enforced when it base64-encodes the file.
    expect(readFileSync(file).byteLength).toBeLessThanOrEqual(256 * 1024)
  })

  it('ships locale files that give the plugin a localized title', () => {
    // `readPluginMeta` resolves `<pkg>/locale/en.json` through `exports`, then
    // reads every sibling `*.json`. A locale directory that is not exported
    // yields no metadata at all rather than an error.
    const prefixes = Object.keys(manifest.exports ?? {}).filter(key => key.startsWith('./locale/'))
    expect(prefixes, 'exports must expose ./locale/*.json').toEqual(['./locale/*.json'])
    const english = JSON.parse(readFileSync(new URL('../../locale/en.json', import.meta.url), 'utf8')) as {
      meta?: { title?: string; description?: string }
    }
    // English is the required fallback: `LocalizedText` objects must carry `en`.
    expect(english.meta?.title?.trim()).toBeTruthy()
    expect(english.meta?.description?.trim()).toBeTruthy()
    const translations = readdirSync(new URL('../../locale/', import.meta.url))
      .filter(name => name.endsWith('.json'))
    expect(translations).toContain('en.json')
    for (const name of translations) {
      // Every file must parse: one malformed sibling would take the whole
      // localization down with it, since the reader throws on the directory.
      const text = JSON.parse(readFileSync(new URL(`../../locale/${name}`, import.meta.url), 'utf8')) as {
        meta?: { title?: string; description?: string }
      }
      expect(text.meta?.title?.trim(), `${name} needs meta.title`).toBeTruthy()
    }
  })

  it('publishes a market index that lists this package instead of being hand-written', () => {
    // The index is generated from the npm registry, so these assertions are the
    // cheap half of the format-1 rules: enough to catch a hand edit or a stale
    // copy, without duplicating `dsh-plugin-market-index` (a dsh package this
    // repository must not depend on).
    const index = JSON.parse(readFileSync(new URL('../../docs/market/index.json', import.meta.url), 'utf8')) as {
      format?: number
      title?: string
      plugins?: {
        name?: string
        versions?: { version?: string; publishTimestamp?: number; source?: { type?: string }; engines?: { dsh?: string } }[]
      }[]
    }
    expect(index.format).toBe(1)
    expect(index.title?.trim()).toBeTruthy()
    const entry = (index.plugins ?? []).find(plugin => plugin.name === manifest.name)
    expect(entry, `the index must list ${manifest.name}`).toBeDefined()
    expect(entry?.versions?.length ?? 0).toBeGreaterThan(0)
    for (const version of entry?.versions ?? []) {
      expect(version.version).toMatch(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u)
      expect(version.source?.type).toBe('npm')
      expect(Number.isInteger(version.publishTimestamp)).toBe(true)
      // Format 1 has no peer-dependency fallback here: a version without a
      // copy of our own `engines.dsh` is rejected at install. Older releases
      // declared a caret range, so only the newest entry has to match today's
      // manifest - it is the one a default install picks.
      expect(version.engines?.dsh, 'every listed version needs engines.dsh').toBeTypeOf('string')
    }
    expect(entry?.versions?.[0]?.engines?.dsh).toBe(manifest.engines?.['dsh'])
    // The index is generated from the registry, so the newest listed version is
    // the one published last. A mismatch here means someone edited the file.
    expect(entry?.versions?.[0]?.version).toBe(manifest.version)
  })

  it('keeps the index display fields in step with this checkout', () => {
    // The generator copies `icon` and `locale/*.json` out of the *published*
    // package, so after changing either one in the repository the index keeps
    // showing the previous release until it is regenerated. That divergence is
    // invisible: the old icon is a perfectly valid SVG and the old title is a
    // perfectly valid string, so no format check can catch it. This closes the
    // gap by comparing the index against the files it is supposed to mirror.
    //
    // Note the direction: this asserts the index matches the *working tree*,
    // which is only true while the two are deliberately kept in sync. Once a
    // release regenerates the index from the registry, npm becomes the source
    // of truth again and this test keeps passing only because the published
    // version now carries the same bytes.
    const icon = manifest.icon
    expect(icon, 'package.json must declare `icon`').toBeTypeOf('string')
    const iconSvg = readFileSync(new URL(`../../${String(icon)}`, import.meta.url), 'utf8')

    const english = JSON.parse(readFileSync(new URL('../../locale/en.json', import.meta.url), 'utf8')) as {
      meta?: { title?: string; description?: string }
    }
    const chinese = JSON.parse(readFileSync(new URL('../../locale/zh.json', import.meta.url), 'utf8')) as {
      meta?: { title?: string; description?: string }
    }

    const index = JSON.parse(readFileSync(new URL('../../docs/market/index.json', import.meta.url), 'utf8')) as {
      plugins?: {
        name?: string
        title?: Record<string, string>
        description?: Record<string, string>
        icon?: string
        metadata?: { keywords?: string[] }
      }[]
    }
    const entry = (index.plugins ?? []).find(plugin => plugin.name === manifest.name)
    expect(entry, `the index must list ${manifest.name}`).toBeDefined()

    // The icon is inlined as a base64 `data:` URL by the generator, so compare
    // the decoded bytes rather than the string. `metadata.dataUrl` keeps the
    // assertions readable when they fail.
    expect(entry?.icon, 'the index must inline an icon').toMatch(/^data:image\/svg\+xml;base64,/u)
    const inlined = Buffer.from(String(entry?.icon).split(',')[1] ?? '', 'base64').toString('utf8')
    expect(inlined, 'the index icon must be byte-identical to icon.svg').toBe(iconSvg)
    // The index-specific ceiling is 32 KiB, tighter than the plugin page's
    // 256 KiB: a passing package `icon` can still be too big for an index.
    expect(Buffer.byteLength(inlined)).toBeLessThanOrEqual(32 * 1024)

    expect(entry?.title).toEqual({ en: english.meta?.title, zh: chinese.meta?.title })
    expect(entry?.description).toEqual({ en: english.meta?.description, zh: chinese.meta?.description })
    expect(entry?.metadata?.keywords).toEqual(manifest.keywords)
  })

  it('publishes a favicon that is the same artwork as the package icon', () => {
    // GitHub Pages serves /docs, so the site cannot reach the repository-root
    // `icon.svg` and needs its own copy. A copy can drift, and a stale favicon
    // is invisible: the browser shows *an* icon either way, so nothing looks
    // broken. This pins the copy to the original.
    const icon = manifest.icon
    expect(icon, 'package.json must declare `icon`').toBeTypeOf('string')
    const source = readFileSync(new URL(`../../${String(icon)}`, import.meta.url), 'utf8')
    const favicon = readFileSync(new URL('../../docs/favicon.svg', import.meta.url), 'utf8')
    expect(favicon, 'docs/favicon.svg must be byte-identical to icon.svg').toBe(source)
  })

  it('links every page that ships from /docs to the favicon', () => {
    // A page without the link silently falls back to /favicon.ico, which this
    // site does not have, so the tab shows the browser's blank-document icon.
    // Nothing errors; it simply looks unfinished.
    const pages = [
      new URL('../../docs/index.html', import.meta.url),
      new URL('../../docs/article/wechat-channel-internals.html', import.meta.url),
    ]
    for (const page of pages) {
      const html = readFileSync(page, 'utf8')
      const href = html.match(/<link rel="icon" href="([^"]+)"/u)?.[1]
      expect(href, `${page.pathname} must declare a favicon`).toBeTypeOf('string')
      // Resolve the way a browser would, then require the file to exist: a
      // typo in a relative href is a 404 nobody notices.
      const resolved = new URL(String(href), page)
      expect(existsSync(resolved), `${href} in ${page.pathname} must exist`).toBe(true)
    }
  })

  it('references only screenshot files that are actually in the tree', () => {
    // The landing page shows real screenshots. A renamed or missing file is a
    // broken image on the published site and nothing else notices: the page
    // builds, the test run stays green, and only a visitor sees the gap.
    const page = new URL('../../docs/index.html', import.meta.url)
    const html = readFileSync(page, 'utf8')
    const sources = [...html.matchAll(/<img[^>]*\ssrc="([^"]+)"/gu)].map(match => match[1])
    expect(sources.length, 'the landing page should show screenshots').toBeGreaterThan(0)
    for (const source of sources) {
      const resolved = new URL(String(source), page)
      expect(existsSync(resolved), `${source} in docs/index.html must exist`).toBe(true)
    }
  })

  it('gives every class the landing page uses a rule in site.css', () => {
    // `.links` sat in the markup from the first version of the page with no
    // stylesheet rule behind it, so the entry cards rendered identically to the
    // feature cards and did not look clickable. Nothing fails when a class has
    // no rule: the browser applies none, and the page just looks flat. This
    // catches the whole family, not that one instance.
    const html = readFileSync(new URL('../../docs/index.html', import.meta.url), 'utf8')
    const source = readFileSync(new URL('../../docs/assets/site.css', import.meta.url), 'utf8')
    // Strip comments first. Without this the check greps prose: documenting a
    // class in a comment would satisfy it even when no rule exists.
    const css = source.replace(/\/\*[\s\S]*?\*\//gu, '')
    const used = new Set<string>()
    for (const match of html.matchAll(/\sclass="([^"]+)"/gu)) {
      for (const name of String(match[1]).split(/\s+/u)) if (name) used.add(name)
    }
    const missing = [...used].filter(name => !css.includes(`.${name}`))
    expect(missing, 'docs/index.html uses classes with no rule in site.css').toEqual([])
  })

  it('keeps the published release history internally consistent', () => {
    // The release list is hand-written, like the market index and the changelog
    // section before it. A row copied and not edited yields a link that points
    // at the wrong tag, and the page still looks fine: the label is what the
    // reader trusts, not the href. Offline checks only: the unit suite must not
    // depend on the network or on `gh` being installed.
    const html = readFileSync(new URL('../../docs/index.html', import.meta.url), 'utf8')
    const list = html.match(/<ol class="releases">([\s\S]*?)<\/ol>/u)?.[1]
    expect(list, 'docs/index.html must carry the release history list').toBeTypeOf('string')

    const rows = [...String(list).matchAll(/<a href="([^"]+)">([\s\S]*?)<\/a>/gu)].map(match => ({
      href: match[1],
      tag: match[2].match(/class="release-tag">([^<]+)</u)?.[1],
      date: match[2].match(/<time[^>]*datetime="([^"]+)"/u)?.[1],
      latest: /class="release-latest"/u.test(match[2]),
    }))
    expect(rows.length, 'the release history should list the published versions').toBeGreaterThan(0)

    for (const row of rows) {
      expect(row.tag, 'every row needs a version tag').toBeTypeOf('string')
      expect(row.href.endsWith(`/releases/tag/${row.tag}`), `${row.tag} must link to its own release`).toBe(true)
      expect(row.date, `${row.tag} needs a publish date`).toMatch(/^\d{4}-\d{2}-\d{2}$/u)
    }

    // Newest first. Comparing by string would put v0.10.0 below v0.9.0, so
    // compare the numeric segments.
    const keys = rows.map(row => String(row.tag).slice(1).split('.').map(Number))
    const descending = keys.every((key, index) => {
      if (index === 0) return true
      const previous = keys[index - 1]
      for (let i = 0; i < Math.max(key.length, previous.length); i += 1) {
        const a = previous[i] ?? 0
        const b = key[i] ?? 0
        if (a !== b) return a > b
      }
      return false
    })
    expect(descending, 'the release history must be newest first').toBe(true)

    // Exactly one row carries the badge, and it has to be the first one.
    const flagged = rows.filter(row => row.latest)
    expect(flagged.length, 'exactly one release is current').toBe(1)
    expect(rows[0].latest, 'the current release must be listed first').toBe(true)
  })
})
