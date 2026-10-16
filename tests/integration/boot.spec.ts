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
import { afterEach, describe, expect, it, vi } from 'vitest'
import { REPO_ROOT } from '../support/harness.ts'

/** Poll until a condition holds, so a detached action can make progress. */
async function until(check: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (check()) return
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error('condition never held')
}

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

  it('reaches ACTIVE rather than parking in PENDING once its services exist', async () => {
    const module = await import(builtEntry())
    ctx = new Context()
    // A profile supplies these before this row activates; providing them here
    // is what makes the assertion about the export form rather than about the
    // absence of a mount order.
    provideCmdline(ctx, { args: [], exit: () => {}, ready: { commit() {}, await: async () => {} } } as never)
    ctx.provide('credentials', {})
    ctx.provide('agents', {})
    ctx.provide('commands', {})
    // The row also waits on the profile's model selection, because a session
    // created without one has no model and fails its first turn.
    ctx.provide('agentDefaultModel', {
      currentSelection: () => ({ provider: 'deepseek-official', model: 'deepseek-v4.1-flash' }),
    })
    const fiber = ctx.plugin(module, { cwd: '/work' })
    await fiber

    // PENDING here would mean an `inject` entry has no provider: the plugin is
    // silently absent while the profile still boots.
    expect(fiber.state).not.toBe(FIBER_STATE.PENDING)
    expect(fiber.state).toBe(FIBER_STATE.ACTIVE)
  })

  it('parks in PENDING when the services it injects are absent', async () => {
    // The other half of that contract, and the reason it is worth asserting:
    // a missing provider is a silent absence in a profile, so the states on
    // both sides of the boundary are pinned rather than only the happy one.
    const module = await import(builtEntry())
    ctx = new Context()
    const fiber = ctx.plugin(module, { cwd: '/work' })
    await fiber

    expect(fiber.state).toBe(FIBER_STATE.PENDING)
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

describe('the row claims its own app argument', () => {
  it('acts on `login` instead of starting the server', async () => {
    // Everything above proves the row composed and the module resolves. This
    // proves the launcher's app argument actually reaches it: an unclaimed
    // argument is ignored in silence, so a boot that looks successful is the
    // failure mode being ruled out. The claim used to live in its own row and be
    // published as a service; it is now the main row's own first step, so this
    // asserts on the effect a login has - an exit request - rather than on a
    // service value.
    const module = await import(builtEntry())
    const ctx = new Context()
    const exits: number[] = []
    provideCmdline(ctx, {
      args: ['login'],
      exit: (code: number) => void exits.push(code),
      ready: { commit: () => {}, await: async () => {} },
    } as never)
    ctx.provide('credentials', {})
    ctx.provide('agents', {})
    ctx.provide('commands', {})
    ctx.provide('agentDefaultModel', {
      currentSelection: () => ({ provider: 'deepseek-official', model: 'deepseek-v4.1-flash' }),
    })
    // A wire that fails immediately. The real QR flow polls for up to eight
    // minutes, so a live network would make this test hang rather than assert;
    // what is under test is that the row *read the argument at all* and left the
    // ordinary-start branch, and a failed login still exits - with a non-zero
    // code, which is the difference between "acted on login" and "started the
    // server".
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('no wire in this test') }) as unknown as typeof fetch)
    try {
      await ctx.plugin(module, { cwd: '/work' })
      // The action runs detached (it owns process lifetime), so the exit request
      // arrives after `apply` returns rather than during it.
      await until(() => exits.length > 0, 5_000)
    } finally {
      await ctx.fiber.dispose()
      vi.unstubAllGlobals()
    }

    expect(exits).toEqual([1])
  }, 30_000)
})
