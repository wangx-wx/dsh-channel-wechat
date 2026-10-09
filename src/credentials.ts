/**
 * Where a WeChat login is kept between runs.
 *
 * The record lives in `ctx.credentials`, not in a file this plugin owns: that
 * seam already owns durability, cross-process write locking, and the redaction
 * rules a config surface needs. It also keeps the payload out of the profile's
 * plain configuration, where a bot token would otherwise sit in a file users
 * are told to edit.
 *
 * The record is a grant rather than an api-key because its payload is written
 * in this plugin's own format — the seam stores it verbatim and never reads it.
 *
 * @module dsh-channel-wechat/credentials
 */

import { credentialKey, type CredentialKey } from '@deepseek-ai/dsh-credentials'
import type { Context } from '@deepseek-ai/cordis'

/** The scope half of every key this plugin owns. */
export const WECHAT_CREDENTIAL_SCOPE = 'channel-wechat'

/** A stored WeChat login. */
export interface WechatAccount {
  /** Bot token for authenticated requests. */
  botToken: string | undefined
  /** Bot account id the server issued; also the record's addressing id. */
  accountId: string
  /** API base URL, when the server supplied one. */
  baseUrl?: string
  /** The user who scanned. */
  userId?: string
}

/** The subset of the credentials service this module uses. */
interface CredentialsService {
  modifyRecord: (
    key: CredentialKey,
    mutate: (current: unknown) => Promise<unknown>,
  ) => Promise<unknown>
  readRecord: (key: CredentialKey) => Promise<unknown>
}

/**
 * Read the credentials service from the context.
 * @param ctx - plugin context carrying the service.
 * @returns the service.
 * @throws when the service is not mounted, since silently skipping the write
 *   would lose a login the user already completed.
 */
function credentialsOf(ctx: Context): CredentialsService {
  const service = ctx.get('credentials') as CredentialsService | undefined
  if (service === undefined) {
    throw new Error('channel-wechat: ctx.credentials is not mounted; cannot store the WeChat login')
  }
  return service
}

/**
 * Build the record key for one account.
 * @param accountId - the server-issued bot id, used verbatim.
 * @returns the branded key.
 */
export function accountKey(accountId: string): CredentialKey {
  // Kept verbatim: the id the server issues (`…-im-bot`) is already a legal key
  // segment, while the derived `…@im.bot` form is not.
  return credentialKey(WECHAT_CREDENTIAL_SCOPE, accountId)
}

/**
 * Persist one login.
 * @param ctx - plugin context carrying the credentials service.
 * @param account - the login to store.
 * @returns when the write has committed.
 */
export async function saveAccount(ctx: Context, account: WechatAccount): Promise<void> {
  await credentialsOf(ctx).modifyRecord(accountKey(account.accountId), async () => ({
    kind: 'grant',
    // The seam never interprets this; only this plugin knows its shape. Fields
    // the server omitted are left out rather than sent as `undefined`, which
    // the store rejects because it is not representable in JSON.
    payload: {
      ...(account.botToken === undefined ? {} : { botToken: account.botToken }),
      ...(account.baseUrl === undefined ? {} : { baseUrl: account.baseUrl }),
      ...(account.userId === undefined ? {} : { userId: account.userId }),
    },
  }))
}

/**
 * Read one stored login.
 * @param ctx - plugin context carrying the credentials service.
 * @param accountId - the account to look up.
 * @returns the login, or `undefined` when this account never logged in.
 */
export async function loadAccount(ctx: Context, accountId: string): Promise<WechatAccount | undefined> {
  const record = await credentialsOf(ctx).readRecord(accountKey(accountId))
  if (record === undefined || record === null) return undefined
  const payload = (record as { payload?: unknown }).payload
  if (payload === undefined || typeof payload !== 'object') return undefined
  const fields = payload as { botToken?: unknown; baseUrl?: unknown; userId?: unknown }
  return {
    botToken: typeof fields.botToken === 'string' ? fields.botToken : undefined,
    accountId,
    ...(typeof fields.baseUrl === 'string' ? { baseUrl: fields.baseUrl } : {}),
    ...(typeof fields.userId === 'string' ? { userId: fields.userId } : {}),
  }
}

/**
 * Forget one account's login.
 * @param ctx - plugin context carrying the credentials service.
 * @param accountId - the account to remove.
 */
export async function forgetAccount(ctx: Context, accountId: string): Promise<void> {
  await credentialsOf(ctx).modifyRecord(accountKey(accountId), async () => undefined)
}
