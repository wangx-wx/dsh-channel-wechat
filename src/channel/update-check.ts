/**
 * Reading the newest published version of this package.
 *
 * The page offers an update only when the registry names a newer version than
 * the one this process is running. Three properties matter, and each has a test
 * because each fails silently if it is wrong:
 *
 *  - the comparison is semver, not string equality: a string compare calls
 *    `0.10.0` older than `0.9.0`, which inverts the one answer this feature
 *    exists to give;
 *  - a registry that cannot be read is a `failed` result, never "already up to
 *    date" - the two render identically and only one is the user's situation.
 *
 * Nothing is cached: the only caller is a button press, and a press means "ask
 * now". A page that checked on mount needed a cache to keep two opens from
 * costing two requests; a page that waits for a press has no such cost.
 *
 * The package name is this package's own, read from the file that npm resolved,
 * so a fork that renames itself checks its own releases rather than this one's.
 *
 * @module dsh-channel-wechat/channel/update-check
 */

import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'

/** This package's name, as the running installation resolved it. */
export const PACKAGE_NAME = 'dsh-channel-wechat'

/** The version this process is running, read from the installed manifest. */
export const CURRENT_VERSION: string = readOwnVersion()

/**
 * Read this package's version from its own `package.json`.
 *
 * `exports` already exposes `./package.json`, so the manifest npm placed on disk
 * is reachable from the built entry without inlining the number at build time -
 * which would go stale in the tree-sitter one way or another (a dev run, a
 * `link:` install, a fork). A failure to read is not fatal: the update card
 * reports an unknown current version rather than breaking the page.
 *
 * @returns the version, or an empty string when the manifest cannot be read.
 */
function readOwnVersion(): string {
  try {
    const require = createRequire(import.meta.url)
    const manifest = JSON.parse(readFileSync(require.resolve(`${PACKAGE_NAME}/package.json`), 'utf8')) as {
      version?: unknown
    }
    return typeof manifest.version === 'string' ? manifest.version : ''
  } catch {
    return ''
  }
}

/** The registry this check asks, overridable for tests and mirrors. */
const REGISTRY = 'https://registry.npmjs.org'

/** A `-` and its identifiers, which semver orders below the bare release. */
const PRERELEASE = /-([0-9A-Za-z.-]+)$/u

/**
 * Split a version into its release numbers and prerelease identifiers.
 * @param version - the version text.
 * @returns the three numbers and the identifiers, or undefined when malformed.
 */
function parse(version: string): { numbers: number[]; prerelease: string[] } | undefined {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:\+[0-9A-Za-z.-]+)?$/u.exec(version.replace(PRERELEASE, ''))
  if (match === null) return undefined
  const prerelease = PRERELEASE.exec(version)
  return {
    numbers: [Number(match[1]), Number(match[2]), Number(match[3])],
    prerelease: prerelease === null ? [] : prerelease[1]!.split('.'),
  }
}

/**
 * Compare two semantic versions.
 *
 * Follows semver's precedence rules for the parts this feature can meet: release
 * numbers numerically, then a prerelease below its release, then identifiers
 * with numeric ones compared as numbers. Build metadata is ignored, as semver
 * requires.
 *
 * @param a - the left version.
 * @param b - the right version.
 * @returns negative when `a` precedes `b`, positive when it follows, 0 when equal
 *   or when either side cannot be parsed (an unparseable version is never newer).
 */
export function compareVersions(a: string, b: string): number {
  const left = parse(a)
  const right = parse(b)
  // An unreadable version on either side compares equal, which is what makes
  // `isNewer` answer false rather than inventing an ordering.
  if (left === undefined || right === undefined) return 0

  for (let index = 0; index < 3; index += 1) {
    const difference = left.numbers[index]! - right.numbers[index]!
    if (difference !== 0) return difference
  }

  // Same release numbers: a prerelease precedes the release, so its presence
  // alone decides when the other side has none.
  if (left.prerelease.length === 0 && right.prerelease.length === 0) return 0
  if (left.prerelease.length === 0) return 1
  if (right.prerelease.length === 0) return -1

  for (let index = 0; index < Math.max(left.prerelease.length, right.prerelease.length); index += 1) {
    const leftPart = left.prerelease[index]
    const rightPart = right.prerelease[index]
    // A shorter identifier list precedes a longer one with the same prefix.
    if (leftPart === undefined) return -1
    if (rightPart === undefined) return 1
    const leftNumber = /^\d+$/u.test(leftPart) ? Number(leftPart) : undefined
    const rightNumber = /^\d+$/u.test(rightPart) ? Number(rightPart) : undefined
    if (leftNumber !== undefined && rightNumber !== undefined) {
      if (leftNumber !== rightNumber) return leftNumber - rightNumber
      continue
    }
    // Numeric identifiers always have lower precedence than alphanumeric ones.
    if (leftNumber !== undefined) return -1
    if (rightNumber !== undefined) return 1
    if (leftPart !== rightPart) return leftPart < rightPart ? -1 : 1
  }
  return 0
}

/**
 * Whether `latest` is a version the running copy should adopt.
 * @param latest - the version the registry names.
 * @param current - the version this process runs.
 * @returns true only when both parse and `latest` is strictly ahead.
 */
export function isNewer(latest: string | undefined, current: string | undefined): boolean {
  if (latest === undefined || current === undefined) return false
  return compareVersions(latest, current) > 0
}

/** What one check found. */
export type UpdateCheck =
  /** The registry answered. `newer` compares `latest` against `current`. */
  | { status: 'ready'; current: string; latest: string; newer: boolean }
  /** The registry could not be read; `reason` says what failed. */
  | { status: 'failed'; current: string; reason: string }

/** How one check runs. */
export interface UpdateCheckerOptions {
  /** The version this process runs. */
  currentVersion: string
  /** The request implementation; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch
  /** Registry base URL; defaults to npm's own. */
  registry?: string
}

/**
 * Build a checker that reads the registry on every call.
 *
 * There is no cache. The only caller is a person who just pressed "check for
 * updates", and a cached answer would be a different answer than the one they
 * asked for: a release published a minute ago would stay invisible until the
 * window expired, with nothing on screen explaining why. The cost of asking is
 * one small `dist-tags` document per press, which is what a press means.
 *
 * @param options - the running version and the request implementation.
 * @returns a function that reads the registry and reports what it found.
 */
export function createUpdateChecker(options: UpdateCheckerOptions): () => Promise<UpdateCheck> {
  const doFetch = options.fetchImpl ?? globalThis.fetch
  const registry = (options.registry ?? REGISTRY).replace(/\/+$/u, '')

  return async function check(): Promise<UpdateCheck> {
    try {
      // The `dist-tags` endpoint rather than the full packument: this feature
      // reads one string, and the packument for a package with a long history
      // is measured in megabytes.
      const response = await doFetch(`${registry}/-/package/${encodeURIComponent(PACKAGE_NAME)}/dist-tags`, {
        headers: { accept: 'application/json' },
      })
      if (!response.ok) return { status: 'failed', current: options.currentVersion, reason: `HTTP ${String(response.status)}` }

      const body: unknown = await response.json()
      // Two shapes answer here: the bare tag map, and one wrapped in `dist-tags`
      // by registries that proxy npm under a different route.
      const tags = (body as { 'dist-tags'?: unknown })['dist-tags'] ?? body
      const latest = typeof (tags as { latest?: unknown }).latest === 'string'
        ? (tags as { latest: string }).latest
        : undefined
      if (latest === undefined) {
        return { status: 'failed', current: options.currentVersion, reason: 'registry named no latest tag' }
      }

      return {
        status: 'ready',
        current: options.currentVersion,
        latest,
        newer: isNewer(latest, options.currentVersion),
      }
    } catch (error) {
      return {
        status: 'failed',
        current: options.currentVersion,
        reason: error instanceof Error ? error.message : String(error),
      }
    }
  }
}
