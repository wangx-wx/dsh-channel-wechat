/**
 * How the integration harness locates a DeepSeek Harness launcher.
 *
 * Kept separate from `harness.ts` so the search can be unit-tested: importing
 * `harness.ts` resolves a launcher eagerly, which is what integration suites
 * want (fail at import with a fixable message) but not what a test of the
 * resolution order wants.
 *
 * A local checkout is preferred over the packaged application: it is the build
 * under development, it needs no Electron, and it can be pointed at any
 * revision. The search order is an explicit `DSH_CHECKOUT`, then a
 * `deepseek-harness` sibling of this repository, then the packaged macOS app.
 * Each step is taken only when the launcher it would run exists, and running out
 * of steps is an error that says how to provide one.
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Repository root, resolved from this file's location under tests/support. */
export const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url))

/** The macOS shim the packaged desktop app ships for booting without Electron. */
const PACKAGED_SHIM = '/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh'

/** What the search consults; injected so each branch is testable. */
export interface LauncherDeps {
  /** Whether a path exists. */
  readonly exists: (path: string) => boolean
  /** The host platform, which decides whether the packaged shim applies. */
  readonly platform: NodeJS.Platform
  /** Repository root, so the sibling checkout is found without a hardcoded home. */
  readonly repoRoot: string
}

/**
 * The launcher inside a source checkout.
 * @param checkout - a candidate checkout directory.
 * @returns the path of the built launcher under it.
 */
export const launcherPath = (checkout: string): string => join(checkout, 'apps', 'cli', 'lib', 'bin.js')

/**
 * Pick the checkout to launch the integration suites against.
 *
 * @param env - the environment to read `DSH_CHECKOUT` from.
 * @param deps - filesystem and platform facts.
 * @returns the checkout directory, or an empty string when the packaged app is
 *   the launcher (it carries no sources to read).
 * @throws when `DSH_CHECKOUT` is set but unbuilt: naming the missing artefact is
 *   more use than ignoring the setting and failing later for another reason.
 */
export function resolveCheckout(env: Record<string, string | undefined>, deps: LauncherDeps): string {
  const explicit = env['DSH_CHECKOUT']
  if (explicit !== undefined && explicit !== '') {
    const launcher = launcherPath(explicit)
    if (!deps.exists(launcher)) {
      throw new Error(
        `DSH_CHECKOUT is ${explicit}, but ${launcher} does not exist.\n` +
          'That file is the built launcher: run `pnpm install && pnpm build` in that checkout, ' +
          'or unset DSH_CHECKOUT to let the harness search for one.',
      )
    }
    return explicit
  }

  // A checkout beside this repository is the ordinary contributor layout and
  // needs no environment variable at all.
  const sibling = join(deps.repoRoot, '..', 'deepseek-harness')
  if (deps.exists(launcherPath(sibling))) return sibling

  // No launcher under any checkout; the packaged app may still serve on macOS,
  // where it has no checkout to report.
  return ''
}

/**
 * The checkout a suite that reads source files needs.
 *
 * {@link resolveCheckout} returns an empty string when the packaged application
 * is the launcher, and that bundle carries no sources. A suite that reads
 * `react` or the theme stylesheets from the checkout cannot run there, and
 * failing is the point: its own `existsSync` guards turned the empty string into
 * a relative path, found nothing, and skipped every case while the run stayed
 * green.
 *
 * @param env - the environment to read `DSH_CHECKOUT` from.
 * @param deps - filesystem and platform facts.
 * @returns the checkout directory.
 * @throws when only the packaged application was found, naming what to provide.
 */
export function requireCheckout(env: Record<string, string | undefined>, deps: LauncherDeps): string {
  const checkout = resolveCheckout(env, deps)
  if (checkout !== '') return checkout
  // Throws its own "no launcher at all" message when there is none; when this
  // returns, the packaged application is what the suites would launch.
  launcherCommand(checkout, deps)
  throw new Error(
    'This suite reads sources from a DeepSeek Harness checkout, but only the packaged ' +
      'application was found and it ships no sources.\n' +
      'Set DSH_CHECKOUT to a built checkout (see docs/development.md), or run this suite ' +
      'where one is available.',
  )
}

/**
 * The command that runs the launcher, as `[executable, ...leading arguments]`.
 *
 * A checkout is run through `node apps/cli/lib/bin.js`; the packaged application
 * ships a `dsh` shim that boots Electron as Node instead. Kept as a command plus
 * arguments so both are spawned the same way.
 *
 * @param checkout - the directory {@link resolveCheckout} chose.
 * @param deps - filesystem and platform facts.
 * @returns the command to spawn.
 * @throws when no launcher exists at all, with the two ways to provide one.
 */
export function launcherCommand(checkout: string, deps: LauncherDeps): readonly string[] {
  const launcher = launcherPath(checkout)
  if (deps.exists(launcher)) return [process.execPath, launcher]
  if (deps.platform === 'darwin' && deps.exists(PACKAGED_SHIM)) return [PACKAGED_SHIM]

  // Distinguish "there is a checkout, it just is not built" from "there is no
  // checkout at all": the first is the common case on a fresh clone, and its
  // fix is a command rather than a download.
  const sibling = join(deps.repoRoot, '..', 'deepseek-harness')
  const hint = deps.exists(sibling)
    ? `A checkout exists at ${sibling} but has not been built (${launcherPath(sibling)} is missing).\n` +
      'Run `pnpm install && pnpm build` in it, or set DSH_CHECKOUT to a checkout that has been built.'
    : 'Set DSH_CHECKOUT to a source checkout that has been built (it must contain apps/cli/lib/bin.js, ' +
      'so run `pnpm install && pnpm build` in it).'

  throw new Error(`No DeepSeek Harness launcher was found for the integration suites.\n${hint}`)
}

/** The facts the search consults in a real run. */
export const REAL_DEPS: LauncherDeps = {
  exists: existsSync,
  platform: process.platform,
  repoRoot: REPO_ROOT,
}
