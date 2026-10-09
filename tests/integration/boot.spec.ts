/**
 * M0's acceptance criterion is that the plugin mounts. Two things can make it
 * not mount while every earlier check still passes:
 *
 *  - the wrong export form (a default-exported Service class where the loader
 *    expects `apply`, or vice versa), which mounts nothing;
 *  - an `inject` entry with no provider, which parks the fiber in PENDING
 *    forever — reported as a boot-audit line, never as an error.
 *
 * The shipped launcher cannot show either: the web app passes a no-op sink to
 * `auditStartupEntries`, and the named-logger service has no console exporter
 * on that surface, so a mounted and an unmounted plugin produce identical
 * output. This therefore asserts on the cordis fiber directly, which is the
 * same evidence dsh's own app-boot tests use.
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { provideCmdline } from '@deepseek-ai/dsh-cmdline'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { createTestHarness, linkRepoAsBundle, REPO_ROOT, setProfileBundles, type TestHarness } from '../support/harness.ts'

/**
 * Cordis FiberState values. The enum is `const`, so it is inlined at compile
 * time and cannot be imported at runtime; `inject` parking is the state this
 * suite exists to catch.
 */
const FIBER_STATE = { PENDING: 0, LOADING: 1, ACTIVE: 2, FAILED: 3, DISPOSED: 4, UNLOADING: 5 } as const

const builtEntry = (): string => {
  const manifest = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')) as { main?: string }
  return join(REPO_ROOT, manifest.main ?? 'lib/index.js')
}

describe('plugin mounts in a real cordis context', () => {
  let ctx: Context | undefined

  afterEach(async () => {
    await ctx?.fiber.dispose()
    ctx = undefined
  })

  it('reaches ACTIVE rather than parking in PENDING', async () => {
    const module = await import(builtEntry())
    ctx = new Context()
    const fiber = ctx.plugin(module)
    await fiber

    // PENDING here would mean an `inject` entry has no provider: the plugin is
    // silently absent while the profile still boots.
    expect(fiber.state).not.toBe(FIBER_STATE.PENDING)
    expect(fiber.state).toBe(FIBER_STATE.ACTIVE)
  })

  it('exports the function-plugin shape the loader dispatches on', async () => {
    const module = (await import(builtEntry())) as Record<string, unknown>
    // The two legal export forms are mutually exclusive; a plugin that ships
    // both, or neither, is the failure this pins.
    expect(typeof module['apply']).toBe('function')
    expect(module['default']).toBeUndefined()
    expect(module['name']).toBe('channel-wechat')
    expect(Array.isArray(module['inject'])).toBe(true)
  })

  it('builds the entry the manifest advertises', () => {
    // A manifest whose entry path drifts from the builder's output installs
    // cleanly and then fails at load with no actionable message, so the two
    // are pinned to each other rather than to a remembered filename. This
    // lives here, not in the unit suite, because it needs a real build.
    const manifest = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')) as { exports?: Record<string, unknown> }
    const entry = manifest.exports?.['.']
    const target = typeof entry === 'string' ? entry : entry && typeof entry === 'object' && 'default' in entry ? entry.default : undefined
    expect(target, 'root export must resolve to a path').toBeTypeOf('string')
    expect(existsSync(join(REPO_ROOT, String(target))), `missing build output ${String(target)}`).toBe(true)
  })
})

describe('the startup row activates in a real profile', () => {
  let harness: TestHarness

  beforeAll(() => {
    harness = createTestHarness()
    const packageName = linkRepoAsBundle(harness)
    setProfileBundles(harness, ['@deepseek-ai/dsh-base', packageName])
  })

  afterAll(() => harness?.cleanup())

  it('publishes the login request when the app argument says login', async () => {
    // Everything above proves the row composed and the module resolves. This
    // proves the launcher's app argument actually reaches it: an unclaimed
    // argument is ignored in silence, so a boot that looks successful is the
    // failure mode being ruled out.
    const module = await import('dsh-channel-wechat/startup')
    const ctx = new Context()
    provideCmdline(ctx, {
      args: ['login'],
      exit: () => {},
      ready: { commit: () => {}, await: async () => {} },
    } as never)
    await ctx.plugin({ name: 'channel-wechat-startup', inject: ['cmdlineArgs'], apply: module.apply })

    expect(ctx.get(module.WECHAT_STARTUP_SERVICE)).toEqual({ action: 'login' })
  })
})
