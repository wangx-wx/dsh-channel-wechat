/**
 * Credential persistence for the WeChat channel.
 *
 * These run against the real file-backed provider rather than a stub: the thing
 * worth proving is that a login survives a process restart, and only the real
 * store can show that. Each test gets its own DSH_HOME, so nothing here touches
 * a developer's own credentials.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import CredentialsLocal from '@deepseek-ai/dsh-credentials-local'
import { afterEach, describe, expect, it } from 'vitest'
import { listAccounts, loadAccount, saveAccount, WECHAT_CREDENTIAL_SCOPE } from '../../src/credentials.ts'

/** One isolated harness home plus its mounted provider. */
interface Bench {
  home: string
  ctx: Context
  dispose: () => Promise<void>
}

const benches: Bench[] = []

/** Mount the real provider against a fresh home and return its context. */
async function mount(): Promise<Bench> {
  const home = mkdtempSync(join(tmpdir(), 'dsh-wechat-cred-'))
  const previous = process.env['DSH_HOME']
  process.env['DSH_HOME'] = home
  const ctx = new Context()
  await ctx.plugin(CredentialsLocal as never, {} as never)
  const bench: Bench = {
    home,
    ctx,
    dispose: async () => {
      await ctx.fiber.dispose()
      if (previous === undefined) delete process.env['DSH_HOME']
      else process.env['DSH_HOME'] = previous
      rmSync(home, { recursive: true, force: true })
    },
  }
  benches.push(bench)
  return bench
}

/** The provider's client-facing surface. */
function credentialsOf(ctx: Context) {
  return (ctx as unknown as { credentials: {
    readRecord: (key: unknown) => Promise<unknown>
    listRecords: () => Promise<readonly { key: string }[]>
  } }).credentials
}

afterEach(async () => {
  while (benches.length > 0) await benches.pop()?.dispose()
})

describe('saving a login', () => {
  it('keeps every field a later request needs', async () => {
    const { ctx } = await mount()

    await saveAccount(ctx, {
      botToken: 'tok-1',
      accountId: 'b0f5860fdecb-im-bot',
      baseUrl: 'https://api.test',
      userId: 'user-7',
    })

    const loaded = await loadAccount(ctx, 'b0f5860fdecb-im-bot')
    expect(loaded).toEqual({
      botToken: 'tok-1',
      accountId: 'b0f5860fdecb-im-bot',
      baseUrl: 'https://api.test',
      userId: 'user-7',
    })
  })

  it('addresses the record under this channel and the server-issued id', async () => {
    const { ctx } = await mount()

    await saveAccount(ctx, { botToken: 'tok-1', accountId: 'b0f5860fdecb-im-bot' })

    // The key is the seam's addressing contract: a scope naming the owner and
    // an id that owner chose. Reading it back by the raw id (not the derived
    // `…@im.bot` form, which is not a legal key segment) is what makes an
    // unrelated plugin unable to collide with it.
    const records = await credentialsOf(ctx).listRecords()
    // Literal, not built from the exported constant: a key derived from the
    // constant would follow it through any rename and assert nothing.
    expect(records.map(record => record.key)).toEqual(['channel-wechat/b0f5860fdecb-im-bot'])
  })

  it('stores a login whose optional fields the server never sent', async () => {
    // The record has to survive JSON: an absent optional field written as
    // `undefined` is rejected by the store, so a token-only confirmation would
    // otherwise fail to persist at all.
    const { ctx } = await mount()

    await saveAccount(ctx, { botToken: undefined, accountId: 'bot-9' })

    const loaded = await loadAccount(ctx, 'bot-9')
    expect(loaded).toEqual({ botToken: undefined, accountId: 'bot-9' })
  })

  it('replaces a previous login for the same account rather than duplicating it', async () => {
    const { ctx } = await mount()

    await saveAccount(ctx, { botToken: 'old', accountId: 'bot-9' })
    await saveAccount(ctx, { botToken: 'new', accountId: 'bot-9' })

    const records = await credentialsOf(ctx).listRecords()
    expect(records).toHaveLength(1)
    expect((await loadAccount(ctx, 'bot-9'))?.botToken).toBe('new')
  })
})

describe('surviving a restart', () => {
  it('reads back a login written by an earlier process', async () => {
    // The first mount stands in for the process that did the login; the second
    // for the one that starts later and must not ask the user to scan again.
    const first = await mount()
    await saveAccount(first.ctx, { botToken: 'tok-1', accountId: 'bot-9', baseUrl: 'https://api.test' })
    await first.ctx.fiber.dispose()

    const second = new Context()
    const previous = process.env['DSH_HOME']
    process.env['DSH_HOME'] = first.home
    await second.plugin(CredentialsLocal as never, {} as never)

    const loaded = await loadAccount(second, 'bot-9')
    expect(loaded?.botToken).toBe('tok-1')

    await second.fiber.dispose()
    if (previous === undefined) delete process.env['DSH_HOME']
    else process.env['DSH_HOME'] = previous
  })

  it('writes through the provider store rather than a file of its own', async () => {
    const { ctx, home } = await mount()

    await saveAccount(ctx, { botToken: 'tok-1', accountId: 'bot-9' })

    // A channel-owned JSON file would be invisible to `ctx.credentials`, which
    // is the whole point of using the seam.
    const stored = readFileSync(join(home, '.credentials.yaml'), 'utf8')
    expect(stored).toContain('bot-9')
    expect(stored).toContain('tok-1')
  })
})

describe('listing stored logins', () => {
  it('reports each account this channel has stored', async () => {
    const { ctx } = await mount()

    await saveAccount(ctx, { botToken: 'a', accountId: 'bot-1' })
    await saveAccount(ctx, { botToken: 'b', accountId: 'bot-2' })

    const accounts = await listAccounts(ctx)
    expect(accounts.map(account => account.accountId).sort()).toEqual(['bot-1', 'bot-2'])
    expect(accounts.find(account => account.accountId === 'bot-2')?.botToken).toBe('b')
  })

  it('ignores records belonging to another plugin that look like ours', async () => {
    // The payload is deliberately shaped like a WeChat login: without a scope
    // check this record is indistinguishable from one of ours, which is what
    // makes the scope the load-bearing part of the key.
    const { ctx } = await mount()
    await saveAccount(ctx, { botToken: 'mine', accountId: 'bot-1' })
    await (ctx as unknown as { credentials: { modifyRecord: Function } }).credentials
      .modifyRecord('other-plugin/bot-1', async () => ({
        kind: 'grant',
        payload: { botToken: 'theirs', baseUrl: 'https://elsewhere.test' },
      }))

    const records = await credentialsOf(ctx).listRecords()
    expect(records.map(record => record.key).sort()).toEqual(['channel-wechat/bot-1', 'other-plugin/bot-1'])
    // Only ours is read back: a foreign record with a colliding id must not
    // appear, and must not shadow ours either.
    const accounts = await listAccounts(ctx)
    expect(accounts).toEqual([{ botToken: 'mine', accountId: 'bot-1' }])
  })

  it('reports nothing before any login', async () => {
    const { ctx } = await mount()

    expect(await listAccounts(ctx)).toEqual([])
  })
})

describe('a missing credentials service', () => {
  it('fails loudly when the service is not mounted', async () => {
    // Silently succeeding would report a completed login whose token was never
    // stored, and the next start would ask the user to scan again with no hint
    // as to why.
    const ctx = new Context()

    // The message is pinned, not matched loosely: "credentials" also appears in
    // the TypeError you get from calling a method on the wrong object, so a
    // loose matcher passes whether or not this check exists.
    await expect(saveAccount(ctx, { botToken: 'tok-1', accountId: 'bot-9' }))
      .rejects.toThrow('channel-wechat: ctx.credentials is not mounted')
  })
})

describe('absence', () => {
  it('reports nothing for an account that never logged in', async () => {
    const { ctx } = await mount()

    expect(await loadAccount(ctx, 'never-seen')).toBeUndefined()
  })

  it('writes no store file until something is saved', async () => {
    const { home } = await mount()

    expect(existsSync(join(home, '.credentials.yaml'))).toBe(false)
  })
})
