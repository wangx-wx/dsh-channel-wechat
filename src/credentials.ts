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

/**
 * A stored WeChat login.
 *
 * The optional fields are explicitly `| undefined` rather than merely optional:
 * a confirmation can arrive without a base URL, and `exactOptionalPropertyTypes`
 * makes "absent" and "present but undefined" different types.
 */
export interface WechatAccount {
  /** Bot token for authenticated requests. */
  botToken: string | undefined
  /** Bot account id the server issued; also the record's addressing id. */
  accountId: string
  /** API base URL, when the server supplied one. */
  baseUrl?: string | undefined
  /** The user who scanned. */
  userId?: string | undefined
}

/** The subset of the credentials service this module uses. */
interface CredentialsService {
  modifyRecord: (
    key: CredentialKey,
    mutate: (current: unknown) => Promise<unknown>,
  ) => Promise<unknown>
  readRecord: (key: CredentialKey) => Promise<unknown>
  listRecords: () => Promise<readonly { key: string }[]>
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
  return accountFromPayload(accountId, await credentialsOf(ctx).readRecord(accountKey(accountId)))
}

/**
 * Forget one account's login.
 * @param ctx - plugin context carrying the credentials service.
 * @param accountId - the account to remove.
 */
export async function forgetAccount(ctx: Context, accountId: string): Promise<void> {
  await credentialsOf(ctx).modifyRecord(accountKey(accountId), async () => undefined)
}

/**
 * Enumerate this channel's stored logins.
 * @param ctx - plugin context carrying the credentials service.
 * @returns every account this channel owns, newest last as the store lists it.
 */
export async function listAccounts(ctx: Context): Promise<WechatAccount[]> {
  const records = await credentialsOf(ctx).listRecords()
  const prefix = `${WECHAT_CREDENTIAL_SCOPE}/`
  const service = credentialsOf(ctx)
  const accounts: WechatAccount[] = []
  for (const record of records) {
    // The scope is the owner: another plugin's record is not ours to interpret,
    // even when its id happens to match one of ours.
    if (!record.key.startsWith(prefix)) continue
    // Read the payload through this record's own key rather than re-deriving
    // one from the id, so the scope check above is what decides inclusion.
    const stored = await service.readRecord(record.key as CredentialKey)
    const account = accountFromPayload(record.key.slice(prefix.length), stored)
    if (account !== undefined) accounts.push(account)
  }
  return accounts
}

/** Build an account from one stored record's payload. */
function accountFromPayload(accountId: string, record: unknown): WechatAccount | undefined {
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
