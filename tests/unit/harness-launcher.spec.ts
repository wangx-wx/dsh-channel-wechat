/**
 * Where the integration harness finds a DeepSeek Harness to launch.
 *
 * The shape being pinned: a missing checkout produces one actionable error that
 * names the path it looked at and the two ways to fix it. The failure this
 * replaces was a hardcoded macOS path that turned into "spawn
 * /Applications/DeepSeek Harness.app/..." on a Windows box - an error that
 * points at the wrong filesystem instead of at `DSH_CHECKOUT`.
 *
 * Each case builds an artificial filesystem from a set of "existing" paths, so
 * the resolution order is testable without installing anything.
 */

import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { launcherCommand, resolveCheckout } from '../support/launcher.ts'

/** Repository root stand-in; `resolveCheckout` resolves siblings against it. */
const REPO_ROOT = '/repo/dsh-channel-wechat'

/** A checkout that has been built, i.e. the file the launcher spawns exists. */
const BUILT_CHECKOUT = '/work/deepseek-harness'

/**
 * A fake `existsSync`.
 *
 * Separators are normalized on both sides: `join` renders host separators, and
 * these cases are written with POSIX-looking literals so they read the same on
 * every machine.
 * @param paths - the paths that should be reported as existing.
 * @returns a predicate with the same signature as `existsSync`.
 */
const existing = (paths: readonly string[]): ((path: string) => boolean) => {
  const set = new Set(paths.map(path => path.replace(/\\/gu, '/')))
  return path => set.has(path.replace(/\\/gu, '/'))
}

/** Build the launcher path under a checkout, with separators normalized. */
const launcherIn = (checkout: string): string => join(checkout, 'apps', 'cli', 'lib', 'bin.js')

describe('resolving the checkout to launch', () => {
  it('uses DSH_CHECKOUT when the launcher under it exists', () => {
    const deps = { exists: existing([launcherIn(BUILT_CHECKOUT)]), platform: 'linux' as NodeJS.Platform, repoRoot: REPO_ROOT }
    expect(resolveCheckout({ DSH_CHECKOUT: BUILT_CHECKOUT }, deps)).toBe(BUILT_CHECKOUT)
  })

  it('reports where it looked when DSH_CHECKOUT points at an unbuilt checkout', () => {
    // The realistic mistake: the variable is right but `pnpm install && pnpm
    // build` never ran. Saying "spawn failed" would hide which of the two
    // things to do.
    const deps = { exists: existing([]), platform: 'win32' as NodeJS.Platform, repoRoot: REPO_ROOT }
    expect(() => resolveCheckout({ DSH_CHECKOUT: 'C:\\work\\deepseek-harness' }, deps)).toThrowError(
      /C:\\work\\deepseek-harness[^]*apps[\\/]cli[\\/]lib[\\/]bin\.js[^]*pnpm build/u,
    )
  })

  it('falls back to a checkout beside this repository', () => {
    // The layout most contributors already have, and the reason no absolute
    // home directory is baked into the harness anymore.
    const sibling = join(REPO_ROOT, '..', 'deepseek-harness')
    const deps = { exists: existing([launcherIn(sibling)]), platform: 'linux' as NodeJS.Platform, repoRoot: REPO_ROOT }
    expect(resolveCheckout({}, deps)).toBe(sibling)
  })

  it('falls back to the packaged app on macOS only', () => {
    // The packaged shim is a macOS path. Offering it on Windows is what made
    // the old failure unreadable: the spawn error named a macOS bundle instead
    // of the setting that was missing.
    const app = '/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh'
    const mac = { exists: existing([app]), platform: 'darwin' as NodeJS.Platform, repoRoot: REPO_ROOT }
    expect(resolveCheckout({}, mac)).toBe('')
    expect(launcherCommand('', mac)).toEqual([app])

    const win = { exists: existing([app]), platform: 'win32' as NodeJS.Platform, repoRoot: REPO_ROOT }
    expect(() => launcherCommand('', win)).toThrowError(/DSH_CHECKOUT/u)
  })

  it('names DSH_CHECKOUT and the expected build artefact when nothing can be found', () => {
    const nowhere = { exists: existing([]), platform: 'win32' as NodeJS.Platform, repoRoot: REPO_ROOT }
    expect(() => launcherCommand('', nowhere)).toThrowError(/DSH_CHECKOUT[^]*pnpm build/u)
  })

  it('distinguishes an unbuilt sibling checkout from having none at all', () => {
    // The common fresh-clone case: the repository is there, `pnpm build` never
    // ran. Naming that command is the whole value of the message.
    const sibling = join(REPO_ROOT, '..', 'deepseek-harness')
    const unbuilt = { exists: existing([sibling]), platform: 'linux' as NodeJS.Platform, repoRoot: REPO_ROOT }
    expect(() => launcherCommand('', unbuilt)).toThrowError(/checkout exists at[^]*pnpm install && pnpm build/u)

    const absent = { exists: existing([]), platform: 'linux' as NodeJS.Platform, repoRoot: REPO_ROOT }
    expect(() => launcherCommand('', absent)).toThrowError(/^No DeepSeek Harness launcher/u)
    expect(() => launcherCommand('', absent)).not.toThrowError(/checkout exists at/u)
  })
})
