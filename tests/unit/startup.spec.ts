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

  it('treats an unrecognised word as an ordinary start, not an error', async () => {
    // This is a deliberate trade. The command line is shared with every other
    // app in the profile, so a bare word is at least as likely to be their flag
    // value (`--port 19387`) as a typo here. Erroring exits the boot before any
    // service is published, which fails the whole application - so the cost of
    // a silently-ignored typo is accepted instead.
    const { values, exits } = await boot(['not-a-real-action'])

    expect(exits).toEqual([])
    expect(values()).toEqual({ action: 'none' })
  })
})

describe('launcher flags this channel does not own', () => {
  it('ignores the desktop host’s own flags instead of rejecting them', async () => {
    // The desktop host boots this profile with `--no-open --port 19387`, which
    // belong to the web app it also mounts. Rejecting them exits the boot
    // before any service is published, which fails the whole app rather than
    // this plugin.
    const { values, exits } = await boot(['--no-open', '--port', '19387'])

    expect(exits).toEqual([])
    expect(values()).toEqual({ action: 'none' })
  })

  it('still recognises its own action alongside foreign flags', async () => {
    const { values, exits } = await boot(['--port', '19387', 'login'])

    expect(exits).toEqual([])
    expect(values()?.action).toBe('login')
  })

  it('does not treat another app\u2019s flag value as an action', async () => {
    // The exact shape the desktop host sends: a flag whose value is a bare
    // number. Mistaking it for an action is what crashed the host.
    const { values, exits } = await boot(['--no-open', '--port', '19387'])

    expect(exits).toEqual([])
    expect(values()).toEqual({ action: 'none' })
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
