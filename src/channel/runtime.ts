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
import type { AgentPresetsLike, AgentRegistryLike, PeerGenerationsLike } from '../bridge/peer-map.ts'
import type { MessageApi } from '../wechat/api.ts'
import { LOGIN_BASE_URL } from '../wechat/login-runner.ts'
import { Channel, type CardAnswererLike, type SessionEventsLike } from './channel.ts'
import { readFileBytes, sendFileToPeer } from '../bridge/send-file.ts'
import { uploadToCdn } from '../wechat/cdn-upload.ts'
import { CDN_BASE_URL } from '../wechat/cdn.ts'
import type { PresentedFile } from '../bridge/deliverables.ts'
import type { InboundMedia } from '../wechat/inbound.ts'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'

/** Collaborators for one channel run. */
export interface RuntimeOptions {
  /** Read the account the login action stored. */
  listAccounts: () => Promise<WechatAccount[]>
  /** Build the API client for the stored account. */
  api: MessageApi
  /** Build the agent registry bound to the plugin context. */
  createRegistry: () => AgentRegistryLike
  /**
   * Probe whether a persisted session already exists.
   *
   * Required, not optional: a peer's session id is derived from the peer, so a
   * restart always finds the id already has state. Omitted, the default is
   * "never exists", every restart calls `create` for an id that exists, and the
   * registry rejects it - dropping every inbound message for the life of the
   * process. Making it required is what stops that default from being reached by
   * accident.
   */
  sessionExists: (sessionId: string) => Promise<boolean>
  /**
   * The event surface the reply path subscribes to.
   *
   * Required, not optional: the model's answer is read from the durable
   * `assistant/message` event, so a run without this subscription polls,
   * receives, runs a turn, and sends nothing back. That failure is silent - the
   * channel looks healthy while the user waits for an answer that has nowhere
   * to go - which is exactly why it is a required parameter rather than a
   * default.
   */
  sessionEvents: SessionEventsLike
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
  /**
   * Working directory each created session records.
   *
   * Required, not optional, because omitting it does not mean "no preference" -
   * it means the session records no `cwd`, and the web app's system prompt then
   * fails its first turn on `{{cwd}}`.
   */
  cwd: string
  /**
   * The profile's agent-preset registry, when this deployment has one.
   *
   * A surface that keeps its model-facing tools behind presets (the web app)
   * leaves a session with no tools at all unless it joins one, and the model
   * then emits raw tool-call syntax that the user reads as garbled text.
   */
  presets?: AgentPresetsLike
  /**
   * Where each peer's conversation generation is kept, so `/new` survives a
   * restart instead of resuming the conversation the user ended.
   */
  generations?: PeerGenerationsLike
  /**
   * The interaction cards this channel answers.
   *
   * Without it an approval or question request has no answerer here and the turn
   * that raised one waits forever.
   */
  cards?: CardAnswererLike
  /**
   * Turn a message's media into content blocks.
   *
   * Absent when this deployment cannot attach media, in which case a message is
   * delivered as its label.
   */
  prepareMedia?: (media: readonly InboundMedia[]) => Promise<{ parts: readonly ContentBlock[]; notes: readonly string[] }>
  /** Record one file successfully sent to a peer. */
  onDeliverableSent?: (label: string, detail: unknown) => void
  /** Called once the channel is polling, for a start-up log line. */
  onStarted?: (accountId: string) => void
  /**
   * Called with the channel before it starts polling.
   *
   * The card service needs the channel's own peer routing and reply queue, while
   * the channel needs the card service - so one of the two has to be introduced
   * after the other exists. This is that seam, and it is narrow on purpose:
   * nothing else in this module needs to see the channel.
   */
  onChannel?: (channel: Channel) => void
  /**
   * Forward a command line to the harness's command runtime.
   * @returns the harness's outcome, or `undefined` when it does not know the command.
   */
  /**
   * Forward a command line to the harness's own command runtime.
   *
   * Takes the resolved agent: this channel owns the peer-to-session mapping, and
   * a caller that re-derived a session id from the peer would hold a second copy
   * of that knowledge.
   * @returns the harness's outcome, or `undefined` when it does not know the command.
   */
  executeNativeCommand?: (line: string, agent: unknown) => Promise<{ kind: 'success' | 'error'; text?: string } | undefined>
  /** Resolve the command names the harness offers one agent, listed by `/help`. */
  nativeCommands?: ((agent: unknown) => Promise<readonly string[]>) | undefined
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
/**
 * Upload and send every file the agent declared.
 *
 * One failure does not stop the rest: a single unreadable file must not cost the
 * user the others, so each is attempted and reported separately.
 *
 * @param params - the files, the account's transport, and the destination.
 * @returns when every file has been attempted.
 */
async function sendDeclaredFiles(params: {
  files: readonly PresentedFile[]
  api: MessageApi
  baseUrl: string
  token: string
  contextToken?: string
  to: string
  report?: (error: unknown, peerId: string, text: string) => void
  /**
   * Record one file that went out.
   *
   * Separate from {@link report}, which is about failures: a successful send had
   * no trace at all, so "nothing logged" could not be told apart from "nothing
   * ran" - the ambiguity a live test could not resolve.
   */
  onSent?: (label: string, detail: unknown) => void
}): Promise<void> {
  for (const file of params.files) {
    try {
      await sendFileToPeer(file, {
        read: readFileBytes,
        requestUploadUrl: async (input) => {
          const target = await params.api.getUploadUrl({
            baseUrl: params.baseUrl,
            token: params.token,
            filekey: input.filekey,
            mediaType: input.mediaType,
            to: params.to,
            rawsize: input.rawsize,
            rawfilemd5: input.rawfilemd5,
            filesize: input.filesize,
            aeskey: input.aeskey,
          })
          // The wire spells these snake_case; the sender takes camelCase.
          return { uploadFullUrl: target.upload_full_url, uploadParam: target.upload_param }
        },
        upload: async input => await uploadToCdn({
          data: input.data,
          key: input.key,
          filekey: input.filekey,
          cdnBaseUrl: CDN_BASE_URL,
          ...(input.uploadFullUrl === undefined ? {} : { uploadFullUrl: input.uploadFullUrl }),
          ...(input.uploadParam === undefined ? {} : { uploadParam: input.uploadParam }),
        }),
        send: async input => await params.api.sendFile({
          baseUrl: params.baseUrl,
          token: params.token,
          to: params.to,
          ...(params.contextToken === undefined ? {} : { contextToken: params.contextToken }),
          fileName: input.fileName,
          encryptQueryParam: input.encryptQueryParam,
          aesKeyBase64: input.aesKeyBase64,
          ciphertextSize: input.ciphertextSize,
          plaintextSize: input.plaintextSize,
        }),
      })
      params.onSent?.('已发送文件', `${file.path} → ${params.to}`)
    } catch (error) {
      params.report?.(error, params.to, file.path)
    }
  }
}

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
    cwd: options.cwd,
    ...(options.presets === undefined ? {} : { presets: options.presets }),
    ...(options.generations === undefined ? {} : { generations: options.generations }),
    ...(options.cards === undefined ? {} : { cards: options.cards }),
    ...(options.prepareMedia === undefined ? {} : { prepareMedia: options.prepareMedia }),
    // Built here rather than passed in: this module already owns the account's
    // base URL and token, and a second copy would be a second thing to keep
    // right.
    sendDeliverables: (peerId, files, contextToken) => sendDeclaredFiles({
      files,
      api: options.api,
      baseUrl,
      token,
      ...(contextToken === undefined ? {} : { contextToken }),
      to: peerId,
      ...(options.onReplyError === undefined ? {} : { report: options.onReplyError }),
      ...(options.onDeliverableSent === undefined ? {} : { onSent: options.onDeliverableSent }),
    }),
    sessionExists: options.sessionExists,
    // The channel needs these to tell the user which login is live and to reach
    // the harness's own commands from WeChat.
    accountId: account.accountId,
    ...(options.executeNativeCommand === undefined ? {} : { executeNativeCommand: options.executeNativeCommand }),
    ...(options.nativeCommands === undefined ? {} : { nativeCommands: options.nativeCommands }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  })

  // Handed over before the loop starts, so the card service can answer a request
  // that arrives with the very first poll rather than only after a restart.
  options.onChannel?.(channel)

  // Subscribed before the loop starts: a poll that answered before the
  // subscription existed would deliver into a run nothing is listening to.
  const unsubscribe = channel.attach(options.sessionEvents)

  try {
    await channel.run()
  } finally {
    // Released with the run that owns it. The context outlives the run, so
    // leaving this to the context's own disposal would accumulate one listener
    // per restart, each holding an already-stopped channel.
    unsubscribe()
    // Sessions hold a registry slot and a write lease; leaving them behind
    // would make the next start fail on the same peer id.
    await channel.stop()
  }
}
