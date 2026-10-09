/**
 * Starting the channel from a stored login.
 *
 * A normal `dsh <profile>` start has no app argument of its own: it finds
 * whatever account the `login` action stored and begins polling as that
 * account. This module is the seam between the credentials store and the
 * channel, so the channel itself stays unaware of where its token came from.
 *
 * @module dsh-channel-wechat/channel/runtime
 */

import type { WechatAccount } from '../credentials.ts'
import type { AgentRegistryLike } from '../bridge/peer-map.ts'
import type { MessageApi } from '../wechat/api.ts'
import { LOGIN_BASE_URL } from '../wechat/login-runner.ts'
import { Channel } from './channel.ts'

/** Collaborators for one channel run. */
export interface RuntimeOptions {
  /** Read the account the login action stored. */
  listAccounts: () => Promise<WechatAccount[]>
  /** Build the API client for the stored account. */
  api: MessageApi
  /** Build the agent registry bound to the plugin context. */
  createRegistry: () => AgentRegistryLike
  /** Persist the poll cursor. */
  saveCursor: (cursor: string) => Promise<void> | void
  /** Cursor from the previous run, so a restart resumes instead of replaying. */
  initialCursor?: string | undefined
  /** Observe a reply that exhausted its attempts. */
  onReplyError?: (error: unknown, peerId: string, text: string) => void
  /** Observe a handler failure. */
  onMessageError?: (error: unknown, message: unknown) => void
  /** Pause between polls; defaults to a real timer. */
  sleep?: (ms: number) => Promise<void>
  /** Monotonic milliseconds; defaults to `Date.now`. */
  now?: () => number
  /** Long-poll timeout to request. */
  pollTimeoutMs?: number
  /** Hard limit on one run. */
  maxRunMs?: number
  /** Ends the run promptly when aborted. */
  signal?: AbortSignal
  /** Provider and model each session selects. */
  sessionOptions?: { provider: string; model: string }
  /** Called once the channel is polling, for a start-up log line. */
  onStarted?: (accountId: string) => void
  /**
   * Forward a command line to the harness's command runtime.
   * @returns the harness's outcome, or `undefined` when it does not know the command.
   */
  executeNativeCommand?: (line: string, peerId: string) => Promise<{ kind: 'success' | 'error'; text?: string } | undefined>
  /** Resolve the command names the harness offers one peer, listed by `/help`. */
  nativeCommands?: ((peerId: string) => Promise<readonly string[]>) | undefined
}

/**
 * Run the channel for the stored account, when there is one.
 *
 * Only the first stored account is used: the plan is single-account for v1,
 * though the data structures carry an account id for a later multi-account
 * release.
 * @param options - the stored account, the transports, and the policy.
 * @returns when the run has finished.
 */
export async function startChannelFromStore(options: RuntimeOptions): Promise<void> {
  const accounts = await options.listAccounts()
  const account = accounts[0]
  // Nothing to poll as: without a token every request would be unauthenticated
  // and the server would reject the loop rather than this call.
  if (account === undefined) return
  if (account.botToken === undefined || account.botToken.trim() === '') return

  const token = account.botToken
  const baseUrl = account.baseUrl ?? LOGIN_BASE_URL
  options.onStarted?.(account.accountId)

  const channel = new Channel({
    registry: options.createRegistry(),
    // The poll carries the cursor and the account's own credentials; the
    // channel itself never sees a token.
    poll: (cursor, timeoutMs) => options.api.getUpdates({
      baseUrl,
      token,
      ...(cursor === undefined ? {} : { cursor }),
      timeoutMs,
    }),
    send: (peerId, text, contextToken) => options.api.sendText({
      baseUrl,
      token,
      to: peerId,
      text,
      ...(contextToken === undefined ? {} : { contextToken }),
    }),
    saveCursor: options.saveCursor,
    ...(options.initialCursor === undefined ? {} : { initialCursor: options.initialCursor }),
    ...(options.onReplyError === undefined ? {} : { onReplyError: options.onReplyError }),
    ...(options.onMessageError === undefined ? {} : { onMessageError: options.onMessageError }),
    ...(options.sleep === undefined ? {} : { sleep: options.sleep }),
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.pollTimeoutMs === undefined ? {} : { pollTimeoutMs: options.pollTimeoutMs }),
    ...(options.maxRunMs === undefined ? {} : { maxRunMs: options.maxRunMs }),
    ...(options.sessionOptions === undefined ? {} : { sessionOptions: options.sessionOptions }),
    // The channel needs these to tell the user which login is live and to reach
    // the harness's own commands from WeChat.
    accountId: account.accountId,
    ...(options.executeNativeCommand === undefined ? {} : { executeNativeCommand: options.executeNativeCommand }),
    ...(options.nativeCommands === undefined ? {} : { nativeCommands: options.nativeCommands }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  })

  try {
    await channel.run()
  } finally {
    // Sessions hold a registry slot and a write lease; leaving them behind
    // would make the next start fail on the same peer id.
    await channel.stop()
  }
}
