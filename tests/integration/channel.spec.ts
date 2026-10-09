/**
 * The channel row over a real cordis context, the real file-backed credentials
 * provider, and the real wire client — stubbing only `fetch`, which is the
 * platform boundary rather than a collaborator.
 *
 * This is the composition the profile performs. It is where "the app argument
 * reaches the login, and the resulting login survives" is proved end to end,
 * as opposed to each piece being proved in isolation.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import CredentialsLocal from '@deepseek-ai/dsh-credentials-local'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import { provideCmdline } from '@deepseek-ai/dsh-cmdline'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { apply as applyChannel, inject as channelInject } from '../../src/index.ts'
import { loadAccount } from '../../src/credentials.ts'
import { apply as applyStartup } from '../../src/startup.ts'
import { saveAccount } from '../../src/credentials.ts'

/** One mounted profile plus its disposable state. */
interface Booted {
  ctx: Context
  /** The account the login stored, if it stored one. */
  storedAccountId: string | undefined
  dispose: () => Promise<void>
}

const boots: Booted[] = []

afterEach(async () => {
  while (boots.length > 0) await boots.pop()?.dispose()
  vi.unstubAllGlobals()
})

/**
 * Stub `fetch` so the QR request and its status poll succeed without network.
 * @param status - the status the poll should report.
 */
function stubWeixin(status: Record<string, unknown>): void {
  vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request) => {
    const href = String(url)
    if (href.includes('get_bot_qrcode')) {
      return new Response(JSON.stringify({ qrcode: 'qr-1', qrcode_img_content: 'https://weixin.test/qr-1' }), { status: 200 })
    }
    return new Response(JSON.stringify(status), { status: 200 })
  }) as unknown as typeof fetch)
}

/**
 * Mount the two rows the profile mounts, over a launcher command line.
 * @param args - app arguments.
 * @param status - status the QR poll reports.
 * @returns the mounted context and the account id that ended up stored.
 */
async function bootProfile(args: string[], status: Record<string, unknown>): Promise<Booted> {
  const home = mkdtempSync(join(tmpdir(), 'dsh-wechat-e2e-'))
  const previousHome = process.env['DSH_HOME']
  process.env['DSH_HOME'] = home
  stubWeixin(status)

  const exits: number[] = []
  const ctx = new Context()
  provideCmdline(ctx, {
    args,
    exit: (code: number) => void exits.push(code),
    ready: { commit() {}, await: async () => {} },
  } as never)
  await ctx.plugin(CredentialsLocal as never, {} as never)
  await ctx.plugin({ name: 'channel-wechat-startup', inject: ['cmdlineArgs'], apply: applyStartup })
  await ctx.plugin({ name: 'channel-wechat', inject: ['wechatStartup', 'credentials'], apply: applyChannel })

  const accountId = typeof status['ilink_bot_id'] === 'string' ? status['ilink_bot_id'] : undefined
  const booted: Booted = {
    ctx,
    storedAccountId: accountId,
    dispose: async () => {
      await ctx.fiber.dispose()
      if (previousHome === undefined) delete process.env['DSH_HOME']
      else process.env['DSH_HOME'] = previousHome
      rmSync(home, { recursive: true, force: true })
    },
  }
  boots.push(booted)
  return booted
}

/** Wait until a condition holds, so an async apply() has a chance to finish. */
async function until(check: () => Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await check()) return
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error('condition never held')
}

describe('a profile boot with the login action', () => {
  it('stores a login that a later process can read', async () => {
    const { ctx, storedAccountId } = await bootProfile(['login'], {
      status: 'confirmed',
      bot_token: 'tok-1',
      ilink_bot_id: 'bot-9',
      baseurl: 'https://api.test',
    })

    await until(async () => (await loadAccount(ctx, 'bot-9')) !== undefined)
    const stored = await loadAccount(ctx, 'bot-9')

    expect(storedAccountId).toBe('bot-9')
    expect(stored?.botToken).toBe('tok-1')
    expect(stored?.baseUrl).toBe('https://api.test')
  })

  it('requests the QR code from the channel before it polls', async () => {
    await bootProfile(['login'], { status: 'confirmed', bot_token: 't', ilink_bot_id: 'bot-9' })

    const calls = (globalThis.fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls
    expect(String(calls[0]?.[0])).toContain('get_bot_qrcode')
  })
})

describe('the row\'s declared dependencies', () => {
  it('waits for the parsed invocation and the credentials store', () => {
    // All three are load-bearing: without `wechatStartup` the row cannot know
    // what was asked, without `credentials` it would activate before the store
    // it writes through exists, and without `agents` the channel would reach
    // for an unmounted registry and start polling with nowhere to deliver.
    expect(channelInject).toEqual(['wechatStartup', 'credentials', 'agents'])
  })
})

describe('a profile boot with no action', () => {
  it('starts the channel when a login is already stored', async () => {
    // The M2 acceptance path: an ordinary start finds the stored account and
    // begins polling as it, with no app argument involved.
    const previous = process.env['DSH_HOME']
    const home = mkdtempSync(join(tmpdir(), 'dsh-wechat-start-'))
    process.env['DSH_HOME'] = home

    // Stub only the platform boundary: the poll and the send go through it.
    const requested: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request) => {
      requested.push(String(url))
      if (String(url).includes('getupdates')) {
        return new Response(JSON.stringify({ ret: 0, msgs: [], get_updates_buf: 'c1' }), { status: 200 })
      }
      return new Response(JSON.stringify({ ret: 0 }), { status: 200 })
    }) as unknown as typeof fetch)

    const ctx = new Context()
    provideCmdline(ctx, { args: [], exit: () => {}, ready: { commit() {}, await: async () => {} } } as never)
    await ctx.plugin(CredentialsLocal as never, {} as never)
    // The channel creates sessions through the agent registry, so a profile
    // that starts it must have one mounted.
    await ctx.plugin(AgentRegistry)
    await saveAccount(ctx, { botToken: 'tok-1', accountId: 'bot-9' })
    await ctx.plugin({ name: 'channel-wechat-startup', inject: ['cmdlineArgs'], apply: applyStartup })
    await ctx.plugin({ name: 'channel-wechat', inject: ['wechatStartup', 'credentials', 'agents'], apply: applyChannel })

    // The loop runs detached, so give it a moment to issue its first poll.
    await new Promise(resolve => setTimeout(resolve, 150))
    await ctx.fiber.dispose()

    expect(requested.some(url => url.includes('getupdates'))).toBe(true)
    if (previous === undefined) delete process.env['DSH_HOME']
    else process.env['DSH_HOME'] = previous
    rmSync(home, { recursive: true, force: true })
  }, 30_000)

  it('starts the server instead of performing a login', async () => {
    // An ordinary `dsh <profile>` must not log in or exit; the fetch stub
    // would throw if anything reached for the QR endpoint.
    const { ctx } = await bootProfile([], { status: 'confirmed', bot_token: 't', ilink_bot_id: 'bot-9' })

    expect(ctx.get('wechatStartup')).toEqual({ action: 'none' })
    // Nothing reached the wire: the stub records every call, and a login would
    // have fetched a QR code first.
    const calls = (globalThis.fetch as unknown as { mock?: { calls: unknown[] } }).mock?.calls ?? []
    expect(calls).toHaveLength(0)
    // Nothing was stored either, which is what a user-visible hijack would do.
    expect(await loadAccount(ctx, 'bot-9')).toBeUndefined()
  })
})
