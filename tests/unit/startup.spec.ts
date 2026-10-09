/**
 * The command-line entry that starts a login.
 *
 * `dsh <profile> login` only works if this plugin parses its own app argument:
 * an unclaimed argument is ignored in silence, and the profile boots normally
 * with no login and no error. These tests therefore assert on the provided
 * service values (which is what downstream rows read) and on the exit request
 * for a rejected invocation, not merely that parsing did not throw.
 */

import { Context } from '@deepseek-ai/cordis'
import { provideCmdline } from '@deepseek-ai/dsh-cmdline'
import { describe, expect, it, vi } from 'vitest'
import { apply, WECHAT_STARTUP_SERVICE, type WechatStartupValues } from '../../src/startup.ts'

/**
 * Mount the startup provider over a launcher-supplied command line.
 *
 * The plugin declares `inject`, so its fiber stays pending until the service
 * arrives; every test must await the mount before reading what was published,
 * or it observes the pre-activation context.
 */
async function boot(args: string[]) {
  const ctx = new Context()
  const exits: number[] = []
  provideCmdline(ctx, {
    args,
    exit: (code: number) => void exits.push(code),
    ready: { commit: () => {}, await: async () => {} },
  } as never)

  await ctx.plugin({ name: 'channel-wechat-startup', inject: ['cmdlineArgs'], apply })
  const values = () => ctx.get(WECHAT_STARTUP_SERVICE) as WechatStartupValues | undefined
  return { ctx, exits, values }
}

describe('command-line entry', () => {
  it('publishes a login request when the app argument says login', async () => {
    const { values } = await boot(['login'])

    expect(values()).toEqual({ action: 'login' })
  })

  it('publishes a status request for the status argument', async () => {
    const { values } = await boot(['status'])

    expect(values()).toEqual({ action: 'status' })
  })

  it('publishes nothing for an invocation with no app arguments', async () => {
    // Ordinary boot: the rows that consume the startup service stay dormant,
    // which is what keeps `dsh <profile>` a normal server start.
    const { values } = await boot([])

    expect(values()).toEqual({ action: 'none' })
  })

  it('exits on an unknown argument instead of ignoring it', async () => {
    // Silence is the documented failure mode here, so an unrecognized action
    // must request a process exit rather than look like a successful no-op.
    const { values, exits } = await boot(['not-a-real-action'])

    expect(exits).toEqual([1])
    expect(values()).toBeUndefined()
  })
})

describe('the service downstream rows read', () => {
  it('is published under the documented name', async () => {
    expect(WECHAT_STARTUP_SERVICE).toBe('wechatStartup')
  })

  it('takes `--json` so a script can read a machine-readable result', async () => {
    const { values } = await boot(['login', '--json'])

    expect(values()?.json).toBe(true)
  })
})
