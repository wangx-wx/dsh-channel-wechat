/**
 * The channel: the five pieces of M2 wired into one thing.
 *
 * This module owns the wiring and nothing else. Each piece has its own rules
 * and its own suite:
 *
 *  - {@link ./../wechat/inbound} reads one wire message;
 *  - {@link ./../bridge/peer-map} maps a peer to a session and serializes turns;
 *  - {@link ./../bridge/dispatcher} turns a message into agent input;
 *  - {@link ./../bridge/reply} builds and queues what comes back;
 *  - {@link ./monitor} is the poll loop, which does not wait for any of it.
 *
 * Only the two platform boundaries are inputs: the poll and the transport send.
 *
 * @module dsh-channel-wechat/channel/channel
 */

import { PeerMap, type AgentHandleLike, type AgentRegistryLike } from '../bridge/peer-map.ts'
import { deliverInbound } from '../bridge/dispatcher.ts'
import { ReplyQueue, extractAssistantText, type ReplySender } from '../bridge/reply.ts'
import { parseCommandLine, routeCommand } from '../bridge/commands.ts'
import { runLocalCommand, type LocalCommandContext } from '../bridge/local-commands.ts'
import { parseInboundMessage } from '../wechat/inbound.ts'
import { monitorLoop, type MonitorResponse } from './monitor.ts'

/** Collaborators the channel needs. */
export interface ChannelOptions {
  /** The agent registry. */
  registry: AgentRegistryLike
  /** Poll the server once. */
  poll: (cursor: string | undefined, timeoutMs: number) => Promise<MonitorResponse>
  /** Send one reply to WeChat. */
  send: ReplySender
  /** Persist the poll cursor. */
  saveCursor: (cursor: string) => Promise<void> | void
  /** Cursor from a previous run. */
  initialCursor?: string
  /** Probe whether a session already exists, so a restart resumes it. */
  sessionExists?: (sessionId: string) => Promise<boolean>
  /** Pause between polls; defaults to a real timer. */
  sleep?: (ms: number) => Promise<void>
  /** Monotonic milliseconds; defaults to `Date.now`. */
  now?: () => number
  /** Long-poll timeout to request. */
  pollTimeoutMs?: number
  /** Hard limit on one run. */
  maxRunMs?: number
  /** Observe a reply that exhausted its attempts. */
  onReplyError?: (error: unknown, peerId: string, text: string) => void
  /** Observe a handler failure; the loop continues either way. */
  onMessageError?: (error: unknown, message: unknown) => void
  /** Observe a turn beginning, so a caller can tell work is in flight. */
  onTurnStarted?: () => void
  /** Cancel one peer's running turn; defaults to cancelling the live agent. */
  cancelRunning?: (peerId: string) => Promise<boolean>
  /** Forward a line to the harness's command runtime. */
  executeNativeCommand?: (line: string, peerId: string) => Promise<{ kind: 'success' | 'error'; text?: string } | undefined>
  /** The account being polled, reported by `/status`. */
  accountId?: string | undefined
  /** Command names the harness offers, listed by `/help`. */
  nativeCommands?: readonly string[]
  /**
   * Provider and model each new session selects.
   *
   * Without this the loop asks the environment's model configuration, which a
   * channel plugin cannot assume is set up for it.
   */
  sessionOptions?: { provider: string; model: string }
}

/**
 * One WeChat conversation set, and the loop that feeds it.
 *
 * A peer's context token is remembered as its message arrives, because the
 * token is per-message and only ever comes inbound: a reply that did not keep
 * it would be unauthenticated for that conversation.
 */
export class Channel {
  private readonly options: ChannelOptions
  private readonly peers: PeerMap
  private readonly replies: ReplyQueue
  private readonly tokens = new Map<string, string | undefined>()
  private readonly sessionToPeer = new Map<string, string>()
  private controller: AbortController | undefined
  private running: Promise<void> | undefined
  private readonly turnWork = new Set<Promise<void>>()

  /**
   * @param options - the poll, the send, and the policy.
   */
  constructor(options: ChannelOptions) {
    this.options = options
    this.peers = new PeerMap({
      registry: options.registry,
      // Every session this channel creates must select the configured provider
      // and model; a session that inherits them from the environment would run
      // on whatever the user happens to have configured.
      ...(options.sessionOptions === undefined ? {} : { sessionOptions: options.sessionOptions }),
      ...(options.sessionExists === undefined ? {} : {
        sessionExists: async sessionId => options.sessionExists?.(String(sessionId)) ?? false,
      }),
    })
    this.replies = new ReplyQueue({
      send: options.send,
      ...(options.onReplyError === undefined ? {} : {
        onGiveUp: (peerId, text, error) => options.onReplyError?.(error, peerId, text),
      }),
    })
  }

  /** Poll until stopped. Resolves when the loop has exited. */
  async run(): Promise<void> {
    if (this.running !== undefined) return this.running
    const controller = new AbortController()
    this.controller = controller
    this.running = monitorLoop({
      initialCursor: this.options.initialCursor,
      poll: this.options.poll,
      onMessage: message => this.handleMessage(message),
      saveCursor: this.options.saveCursor,
      shouldStop: () => controller.signal.aborted,
      // The peer's own queue is what serializes a conversation, so routing
      // through it here is what keeps two of its messages from interleaving.
      serialize: async (message, work) => {
        const peerId = peerIdOf(message)
        if (peerId === undefined) return work()
        // This hook decides *queuing*, not routing: a command must run
        // immediately rather than behind the turn it may be intended to stop,
        // because anything queued behind that turn can never arrive. What the
        // command itself does is `handleMessage`'s decision.
        const text = textOf(message)
        if (text !== undefined && parseCommandLine(text) !== undefined) {
          await work()
          return
        }
        const task = this.peers.runExclusive(peerId, work)
        this.turnWork.add(task)
        try {
          await task
        } finally {
          this.turnWork.delete(task)
        }
      },
      ...(this.options.onMessageError === undefined ? {} : { onMessageError: this.options.onMessageError }),
      ...(this.options.sleep === undefined ? {} : { sleep: this.options.sleep }),
      ...(this.options.now === undefined ? {} : { now: this.options.now }),
      ...(this.options.pollTimeoutMs === undefined ? {} : { pollTimeoutMs: this.options.pollTimeoutMs }),
      ...(this.options.maxRunMs === undefined ? {} : { maxRunMs: this.options.maxRunMs }),
      signal: controller.signal,
    })
    return this.running
  }

  /** Wait for queued work to finish; call after {@link run} in tests. */
  async settled(): Promise<void> {
    await this.running
    await this.replies.drain()
    await Promise.allSettled([...this.turnWork])
  }

  /** Stop the loop and release every session this channel owns. */
  async stop(): Promise<void> {
    this.controller?.abort()
    // Draining first means a reply already queued is attempted rather than
    // dropped; WeChat will never replay it.
    await this.replies.drain()
    await this.running?.catch(() => {})
    this.running = undefined
    this.controller = undefined
    await this.peers.disposeAll()
    this.tokens.clear()
    this.sessionToPeer.clear()
  }

  /**
   * Subscribe to committed session events on a context.
   *
   * This is the production wiring: the reply path reads the durable
   * `assistant/message` event, so without this subscription the model's answer
   * has no route back to WeChat. The subscription is released when the
   * context's fiber disposes.
   * @param ctx - the plugin context carrying the session service.
   */
  attach(ctx: { on: (event: 'session/event', listener: (session: { id: unknown }, event: unknown) => void) => unknown }): void {
    ctx.on('session/event', (session, event) => { this.onSessionEvent(String(session.id), event) })
  }

  /**
   * Take one committed session event.
   *
   * Called by {@link attach} for every log append. Exposed separately so the
   * routing can be tested without a session store.
   * @param sessionId - the session the event belongs to.
   * @param event - the committed event.
   */
  onSessionEvent(sessionId: string, event: unknown): void {
    // Only sessions this channel created are its to answer for.
    const peerId = this.sessionToPeer.get(sessionId)
    if (peerId === undefined) return
    const text = extractAssistantText(event as never)
    if (text === undefined) return
    void this.replies.enqueue(peerId, text, this.tokens.get(peerId))
  }

  /**
   * Answer one slash command for a peer.
   *
   * Deliberately outside the peer's queue, and deliberately not delivered to
   * the model: the reply is the command's own output, so no turn runs and the
   * answer goes straight back out.
   * @param peerId - the peer whose message carried the command.
   * @param text - the command line.
   */
  private async handleCommand(peerId: string, text: string): Promise<void> {
    const outcome = await routeCommand(text, {
      handleLocal: command => runLocalCommand(command, this.localCommandContext(peerId)),
      executeNative: async line => {
        const execute = this.options.executeNativeCommand
        if (execute === undefined) return undefined
        return execute(line, peerId)
      },
    })
    if (outcome === undefined) return
    await this.replies.enqueue(peerId, outcome.text ?? `${outcome.kind === 'success' ? '完成' : '失败'}`, this.tokens.get(peerId))
  }

  /**
   * The context this channel's own commands run against.
   * @param peerId - the peer whose command is running.
   * @returns the command context.
   */
  private localCommandContext(peerId: string): LocalCommandContext {
    return {
      peerId,
      cancelRunning: async () => {
        const cancel = this.options.cancelRunning
        if (cancel !== undefined) return cancel(peerId)
        return this.cancelPeer(peerId)
      },
      endSession: async () => { await this.endPeerSession(peerId) },
      accountId: this.options.accountId,
      sessionCount: this.peers.size,
      nativeCommands: this.options.nativeCommands ?? [],
    }
  }

  /** Cancel a peer's running turn through its live agent. */
  private async cancelPeer(peerId: string): Promise<boolean> {
    // Waits out a session still being created: the turn can start before the
    // session is recorded, which is exactly when a stop matters most.
    const handle = await this.peers.liveHandleFor(peerId)
    if (handle === undefined) return false
    const agent = handle.agent as unknown as { cancel?: (cause: { kind: string }) => void }
    if (typeof agent.cancel !== 'function') return false
    agent.cancel({ kind: 'user' })
    return true
  }

  /** End a peer's session so the next message starts a fresh one. */
  private async endPeerSession(peerId: string): Promise<void> {
    const handle = this.peers.handleFor(peerId)
    this.peers.forget(peerId)
    if (handle === undefined) return
    const id = String(handle.agent.id)
    this.sessionToPeer.delete(id)
    await handle.dispose()
  }

  /** Read, parse, and deliver one polled message. */
  /** Read, parse, and deliver one polled message. */
  /** Options passed to every `create`/`resume` for a peer's session. */
  private get createOptions(): { provider?: string; model?: string } {
    const options = this.options.sessionOptions
    return options === undefined ? {} : { provider: options.provider, model: options.model }
  }

  /** Read, parse, and deliver one polled message. */
  private async handleMessage(message: unknown): Promise<void> {
    const parsed = parseInboundMessage(message as never)
    if (parsed === undefined) return

    // Remembered before delivery: the token belongs to this inbound message, and
    // the reply it triggers reads it back.
    this.tokens.set(parsed.peerId, parsed.contextToken)

    // A command is answered here rather than delivered: the channel knows the
    // answer, so running a turn for it would burn the user's tokens answering
    // a question this plugin already knows.
    if (parseCommandLine(parsed.text) !== undefined) {
      await this.handleCommand(parsed.peerId, parsed.text)
      return
    }

    const handle = await this.peers.sessionFor(parsed.peerId)
    this.sessionToPeer.set(String(handle.agent.id), parsed.peerId)
    this.peers.require(handle)
    this.options.onTurnStarted?.()
    deliverInbound(agentOf(handle), parsed, { isLive: () => this.peers.has(parsed.peerId) })

    // Wait for the turn this message started. The answer is read from the
    // committed `assistant/message`, which only exists once the turn settles,
    // and the poll loop is detached from this work — so returning here
    // would let the channel report itself settled with the turn still running.
    await agentOf(handle).whenIdle?.()
  }
}

/** The text a raw message carries, when it has any. */
function textOf(message: unknown): string | undefined {
  return parseInboundMessage(message as never)?.text
}

/** The peer id a raw message claims to come from, when it has one. */
function peerIdOf(message: unknown): string | undefined {
  const parsed = parseInboundMessage(message as never)
  return parsed?.peerId
}

/** The agent inside a handle, as this module uses it. */
function agentOf(handle: AgentHandleLike): {
  followup: (message: never) => void
  whenIdle?: () => Promise<void>
} {
  return handle.agent as unknown as {
    followup: (message: never) => void
    whenIdle?: () => Promise<void>
  }
}
