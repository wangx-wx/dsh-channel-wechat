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
  /** Remove one record; removing an absent record is a no-op. */
  deleteRecord: (key: CredentialKey) => Promise<void>
  readRecord: (key: CredentialKey) => Promise<unknown>
  /**
   * Enumerate every stored record's address.
   *
   * Optional because the mounted service may not implement it: the seam's type
   * declares it, but a host whose `credentials` provider predates the method
   * exposes the record operations without it. Calling it unconditionally threw
   * `listRecords is not a function` inside `runChannel`, which took the whole
   * channel down before the loop ever polled - so the degraded answer is "this
   * provider cannot enumerate", not an exception.
   */
  listRecords?: () => Promise<readonly { key: string }[]>
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
 * Encode an account id into a legal credential key segment.
 *
 * The key grammar is `/^[a-z][a-z0-9-]*$/`, and the ids the iLink server issues
 * do not fit it: a live login returns `6f773c2222a6@im.bot`, which starts with a
 * digit and contains `@` and `.`. Passing that to `credentialKey` throws, so a
 * confirmed login stored nothing while the panel reported success.
 *
 * The encoding has to be reversible and collision-free, not a tidy-up. Replacing
 * the illegal characters with `-` would be simpler and wrong: `6f77@im.bot` and
 * `6f77-im-bot` are different bots that would become one key, and the second
 * login would silently overwrite the first. So the id is percent-encoded as
 * UTF-8 and prefixed to satisfy the leading-letter rule.
 *
 * @param accountId - the server-issued bot id.
 * @returns a legal key segment that {@link decodeAccountKey} reverses.
 */
export function encodeAccountKey(accountId: string): string {
  // The alphabet is `a-z0-9-`, so `-` is the only character available to
  // introduce an escape; `_` would itself be illegal. A byte is written as
  // `-` plus two hex digits, and a literal `-` is written doubled, which is what
  // keeps the mapping reversible.
  const bytes = new TextEncoder().encode(accountId)
  let encoded = 'w'
  for (const byte of bytes) {
    const character = String.fromCharCode(byte)
    if (character === '-') encoded += '--'
    else if (/^[a-z0-9]$/u.test(character)) encoded += character
    else encoded += `-${byte.toString(16).padStart(2, '0')}`
  }
  return encoded
}

/**
 * Recover the account id from a key segment built by {@link encodeAccountKey}.
 * @param segment - the second half of a key this plugin owns.
 * @returns the original id, or `undefined` when the segment is not ours.
 */
export function decodeAccountKey(segment: string): string | undefined {
  if (!segment.startsWith('w')) return undefined
  const body = segment.slice(1)
  const bytes: number[] = []
  for (let index = 0; index < body.length; index += 1) {
    const character = body[index]
    if (character === '-') {
      if (body[index + 1] === '-') {
        bytes.push('-'.charCodeAt(0))
        index += 1
        continue
      }
      const hex = body.slice(index + 1, index + 3)
      if (!/^[0-9a-f]{2}$/u.test(hex)) return undefined
      bytes.push(Number.parseInt(hex, 16))
      index += 2
      continue
    }
    // Anything outside the unescaped alphabet means this is not our segment.
    if (!/^[a-z0-9]$/u.test(character ?? '')) return undefined
    bytes.push(character?.charCodeAt(0) ?? 0)
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array(bytes))
  } catch {
    // Invalid UTF-8 means someone else wrote this, not an id we can name.
    return undefined
  }
}

/**
 * Build the record key for one account.
 * @param accountId - the server-issued bot id.
 * @returns the branded key.
 */
export function accountKey(accountId: string): CredentialKey {
  return credentialKey(WECHAT_CREDENTIAL_SCOPE, encodeAccountKey(accountId))
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
 *
 * `deleteRecord` rather than `modifyRecord(..., async () => undefined)`. That was
 * the first shape here, and it is wrong in a way no type catches: the contract
 * says returning `undefined` from the mutator **leaves the record untouched**
 * ("or `undefined` to leave it"), so "forget" removed nothing while reporting
 * success. The store still held the token, and the next ordinary start polled as
 * the account the user had just signed out of.
 *
 * @param ctx - plugin context carrying the credentials service.
 * @param accountId - the account to remove.
 */
export async function forgetAccount(ctx: Context, accountId: string): Promise<void> {
  await credentialsOf(ctx).deleteRecord(accountKey(accountId))
}

/**
 * Whether the mounted provider can enumerate stored records.
 *
 * The question a caller has to ask before acting on an empty {@link listAccounts}
 * result: "no accounts" and "this provider cannot be walked" both come back as an
 * empty list, and they need different answers. The first is a user who has not
 * logged in; the second is a login that is stored and readable but cannot be
 * discovered, where a channel that simply stops polling looks like a silent
 * failure.
 * @param ctx - plugin context carrying the credentials service.
 * @returns whether `listRecords` is available.
 */
export function enumeratesAccounts(ctx: Context): boolean {
  return credentialsOf(ctx).listRecords !== undefined
}

/**
 * Enumerate this channel's stored logins.
 *
 * Returns an empty list when the mounted provider cannot enumerate. That is a
 * real state, not a bug to swallow: a `credentials` provider that predates
 * `listRecords` still stores and reads records, so a login survives and works -
 * it just cannot be discovered by walking the store. Throwing instead took the
 * whole channel down at startup, which is strictly worse than not knowing the
 * account id it was polling as.
 *
 * A caller that would otherwise treat the empty list as "not logged in" must ask
 * {@link enumeratesAccounts} first; this function cannot express the difference.
 *
 * @param ctx - plugin context carrying the credentials service.
 * @returns every account this channel owns, newest last as the store lists it.
 */
export async function listAccounts(ctx: Context): Promise<WechatAccount[]> {
  const service = credentialsOf(ctx)
  if (service.listRecords === undefined) return []
  const records = await service.listRecords()
  const prefix = `${WECHAT_CREDENTIAL_SCOPE}/`
  const accounts: WechatAccount[] = []
  for (const record of records) {
    // The scope is the owner: another plugin's record is not ours to interpret,
    // even when its id happens to match one of ours.
    if (!record.key.startsWith(prefix)) continue
    // The stored segment is an encoding, so the id has to be recovered rather
    // than sliced off: a record whose segment does not decode to one of ours is
    // not ours to report.
    const accountId = decodeAccountKey(record.key.slice(prefix.length))
    if (accountId === undefined) continue
    // Read the payload through this record's own key rather than re-deriving
    // one from the id, so the scope check above is what decides inclusion.
    const stored = await service.readRecord(record.key as CredentialKey)
    const account = accountFromPayload(accountId, stored)
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
