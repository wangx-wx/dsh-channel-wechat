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

import {
  PeerMap,
  type AgentHandleLike,
  type AgentPresetsLike,
  type AgentRegistryLike,
  type PeerGenerationsLike,
} from '../bridge/peer-map.ts'
import { deliverInbound } from '../bridge/dispatcher.ts'
import { ReplyQueue, extractAssistantText, type ReplySender } from '../bridge/reply.ts'
import { parseCommandLine, routeCommand } from '../bridge/commands.ts'
import { runLocalCommand, type LocalCommandContext } from '../bridge/local-commands.ts'
import { parseInboundMessage, type InboundMedia } from '../wechat/inbound.ts'
import { presentedFilesFrom, type PresentedFile } from '../bridge/deliverables.ts'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { monitorLoop, type MonitorResponse } from './monitor.ts'

/** The event surface the reply path subscribes to. */
export interface SessionEventsLike {
  /** Subscribe to one committed session event. Returns the disposer. */
  on: (event: 'session/event', listener: (session: { id: unknown; header?: { cwd?: string } }, event: unknown) => void) => () => void
}

/**
 * The card answerer the channel routes replies through.
 *
 * Structural rather than the concrete `CardService`, so this module does not
 * depend on the card seams to test the routing between them.
 */
export interface CardAnswererLike {
  /** Whether this text answers an open card, and so must not reach the model. */
  addressesCard: (text: string) => boolean
  /** Answer the open card this text names. Returns whether it was claimed. */
  answer: (peerId: string, text: string) => Promise<boolean>
  /** Stop answering cards and reject what is still open. */
  dispose: () => void
}

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
  /**
   * Forward a line to the harness's command runtime.
   *
   * Takes the resolved agent rather than the peer id: this channel owns the
   * peer-to-session mapping, and a bridge that re-derived a session id from the
   * peer would be a second copy of that knowledge - one that goes stale the
   * moment a peer can have more than one conversation.
   */
  executeNativeCommand?: (line: string, agent: unknown) => Promise<{ kind: 'success' | 'error'; text?: string } | undefined>
  /** The account being polled, reported by `/status`. */
  accountId?: string | undefined
  /**
   * Resolve the command names the harness offers one agent, listed by `/help`.
   *
   * Takes the agent rather than the peer id, for the same reason
   * {@link ChannelOptions.executeNativeCommand} does. `undefined` means the peer
   * has no live session, and the lister owns what to answer - so a deployment
   * that can answer without one still may.
   */
  nativeCommands?: (agent: unknown) => Promise<readonly string[]>
  /**
   * Provider and model each new session selects.
   *
   * Without this the loop asks the environment's model configuration, which a
   * channel plugin cannot assume is set up for it.
   */
  sessionOptions?: { provider: string; model: string }
  /**
   * Working directory every session this channel creates records.
   *
   * Creation-only, because the value is immutable once written into a session
   * header. The system prompt's `{{cwd}}` reads it, so a session created without
   * one fails its first turn.
   */
  cwd?: string
  /**
   * The profile's agent-preset registry, when this deployment has one.
   *
   * Without it a session mounts no preset, and on a surface that keeps its
   * model-facing tools behind presets (the web app) the agent then has no tools
   * at all - the model emits raw tool-call syntax that the user reads as garbled
   * text. Absent on a surface that keeps those rows on the host plane.
   */
  presets?: AgentPresetsLike
  /**
   * Where each peer's current conversation generation is kept.
   *
   * Without it `/new` rotates only in memory, so the next restart resumes the
   * conversation the user ended.
   */
  generations?: PeerGenerationsLike
  /**
   * The interaction cards this channel answers.
   *
   * Without it a card reply is delivered to the model as ordinary text and a
   * request with no local answerer waits forever - so an approval or question
   * raised inside a turn hangs that turn with no reply.
   */
  cards?: CardAnswererLike
  /**
   * Turn a message's media into content blocks.
   *
   * Absent means this deployment cannot attach media at all, so a media-only
   * message is delivered as its label. Present but failing is handled inside -
   * it returns notes rather than throwing, because the user's words must still
   * arrive.
   */
  prepareMedia?: (media: readonly InboundMedia[]) => Promise<{ parts: readonly ContentBlock[]; notes: readonly string[] }>
  /**
   * Send the files the agent declared as deliverables.
   *
   * Absent means this deployment cannot send files, and a declaration is simply
   * left alone. Present but failing must not throw into the event dispatch,
   * which is shared with the reply path.
   */
  sendDeliverables?: (peerId: string, files: readonly PresentedFile[], contextToken?: string) => Promise<void>
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
  private readonly cards: CardAnswererLike | undefined
  private readonly tokens = new Map<string, string | undefined>()
  private readonly sessionToPeer = new Map<string, string>()
  private controller: AbortController | undefined
  private running: Promise<void> | undefined
  private readonly turnWork = new Set<Promise<void>>()
  /**
   * Command work in flight.
   *
   * A command is deliberately not queued, so the queue cannot be what a caller
   * waits on - without this, `settled` would return while a command was still
   * running and its reply had not been sent.
   */
  private readonly commandWork = new Set<Promise<void>>()

  /**
   * @param options - the poll, the send, and the policy.
   */
  constructor(options: ChannelOptions) {
    this.options = options
    this.cards = options.cards
    this.peers = new PeerMap({
      registry: options.registry,
      // Every session this channel creates must select the configured provider
      // and model; a session that inherits them from the environment would run
      // on whatever the user happens to have configured.
      ...(options.sessionOptions === undefined ? {} : { sessionOptions: options.sessionOptions }),
      ...(options.sessionExists === undefined ? {} : {
        sessionExists: async sessionId => options.sessionExists?.(String(sessionId)) ?? false,
      }),
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      ...(options.presets === undefined ? {} : { presets: options.presets }),
      ...(options.generations === undefined ? {} : { generations: options.generations }),
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
          const command = work()
          this.commandWork.add(command)
          void command.finally(() => this.commandWork.delete(command))
          await command
          return
        }
        // A card reply bypasses the queue for a sharper reason than a command
        // does: the turn it must unblock is the one *holding* the queue. The
        // agent sits inside `ask_user_question` waiting for this answer, so
        // anything queued behind that turn can never arrive and the card would
        // deadlock the very conversation it is asking about.
        if (text !== undefined && this.cards?.addressesCard(text) === true) {
          const reply = work()
          this.commandWork.add(reply)
          void reply.finally(() => this.commandWork.delete(reply))
          await reply
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

  /**
   * The peer a session belongs to, or `undefined` when it is not this channel's.
   *
   * Exposed for the card service: a card arrives addressed by session, and the
   * conversation that must receive it is this mapping's answer.
   * @param sessionId - the session that raised the request.
   * @returns the peer id, when this channel owns that session.
   */
  peerOfSession(sessionId: string): string | undefined {
    return this.sessionToPeer.get(sessionId)
  }

  /**
   * Send text to one peer through the queue the replies already use.
   *
   * Routed through that queue rather than sent directly, so a card cannot
   * overtake the reply already in flight for the same conversation.
   * @param peerId - the peer to send to.
   * @param text - the text to send.
   */
  async sendToPeer(peerId: string, text: string): Promise<void> {
    await this.replies.enqueue(peerId, text, this.tokens.get(peerId))
  }

  /** Wait for queued work to finish; call after {@link run} in tests. */
  async settled(): Promise<void> {
    await this.running
    await Promise.allSettled([...this.turnWork])
    // Commands may still be running after the loop exits; their replies are
    // queued from inside them, so waiting for the queue first would miss them.
    await Promise.allSettled([...this.commandWork])
    await this.replies.drain()
  }

  /** Stop the loop and release every session this channel owns. */
  async stop(): Promise<void> {
    // Released before anything is drained: a card still open holds a turn that
    // is itself holding work `stop` would otherwise wait on, so draining first
    // would hang the shutdown on the very card being abandoned.
    this.cards?.dispose()
    this.controller?.abort()
    // Draining first means a reply already queued is attempted rather than
    // dropped; WeChat will never replay it.
    await Promise.allSettled([...this.commandWork])
    await this.replies.drain()
    await this.running?.catch(() => {})
    this.running = undefined
    this.controller = undefined
    await this.peers.disposeAll()
    this.tokens.clear()
    this.sessionToPeer.clear()
  }

  /**
   * Subscribe to committed session events.
   *
   * This is the production wiring: the reply path reads the durable
   * `assistant/message` event, so without this subscription the model's answer
   * has no route back to WeChat.
   *
   * Returns a disposer rather than relying on the context's own lifetime,
   * because the two differ: a `Channel` is built per run, while the context it
   * subscribes on outlives every run. Relying on the context would leave one
   * listener behind per restart, each holding a channel that has already been
   * stopped.
   * @param events - the event surface to subscribe on.
   * @returns a disposer that unsubscribes.
   */
  attach(events: SessionEventsLike): () => void {
    return events.on('session/event', (session, event) => {
      // The working directory comes off the session header, which is where a
      // presented file's relative path is relative to - this process's own cwd
      // is a different directory.
      this.onSessionEvent(String(session.id), event, session.header?.cwd)
    })
  }

  /**
   * Take one committed session event.
   *
   * Called by {@link attach} for every log append. Exposed separately so the
   * routing can be tested without a session store.
   * @param sessionId - the session the event belongs to.
   * @param event - the committed event.
   * @param cwd - the session's working directory, used to resolve a relative
   *   presented path. Absent leaves such a path unresolved rather than guessing.
   */
  onSessionEvent(sessionId: string, event: unknown, cwd?: string): void {
    // Only sessions this channel created are its to answer for.
    const peerId = this.sessionToPeer.get(sessionId)
    if (peerId === undefined) return

    // A declared deliverable is a second kind of answer, alongside the model's
    // text - so it is routed before the text check, which would otherwise
    // return early for an event that carries no assistant message.
    const files = presentedFilesFrom(event, cwd ?? '')
    if (files !== undefined) {
      this.sendDeliverables(peerId, files)
      return
    }

    const text = extractAssistantText(event as never)
    if (text === undefined) return
    void this.replies.enqueue(peerId, text, this.tokens.get(peerId))
  }

  /**
   * Send declared deliverables, reporting a failure instead of throwing.
   *
   * Detached because `session/event` is a synchronous emit shared with the reply
   * path: an await here would hold up every other listener, and a rejection
   * would become an unhandled one inside the session service.
   * @param peerId - the conversation that produced the files.
   * @param files - the declared files.
   */
  private sendDeliverables(peerId: string, files: readonly PresentedFile[]): void {
    const send = this.options.sendDeliverables
    if (send === undefined) return
    void send(peerId, files, this.tokens.get(peerId)).catch((error: unknown) => {
      this.options.onReplyError?.(error, peerId, files.map(file => file.path).join(', '))
    })
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
        // The harness resolves a command against an agent's own scoped view, so
        // a native command needs a session even when it is the peer's first
        // message. Creating it here is what lets `/goal …` open a conversation.
        const handle = await this.peers.sessionFor(peerId)
        return execute(line, handle.agent)
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
      nativeCommands: async () => {
        const list = this.options.nativeCommands
        if (list === undefined) return []
        // The live handle rather than `sessionFor`: listing what is available
        // must not be the thing that opens a conversation. Passing `undefined`
        // through is deliberate - the lister owns that decision, so a deployment
        // answering from somewhere other than a live agent still can.
        return list(this.peers.handleFor(peerId)?.agent)
      },
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

  /**
   * End a peer's session so the next message starts a fresh one.
   *
   * Disposing the handle is not enough, and that was a real defect: a peer's
   * session id was derived from the peer alone, so the persisted session
   * outlived the handle and the next message resumed the conversation the user
   * had just ended - the opposite of what `/new` told them. The generation is
   * advanced first, so the id the next message addresses is one nothing has
   * written to yet.
   */
  private async endPeerSession(peerId: string): Promise<void> {
    const handle = this.peers.handleFor(peerId)
    this.peers.forget(peerId)
    await this.peers.startNew(peerId)
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

  /**
   * Prepare a message's media, when this deployment can.
   *
   * A deployment with no preparer delivers the label alone rather than failing:
   * the text the user typed must still arrive.
   * @param media - the descriptors the parser found, if any.
   * @returns the content blocks and notes, both empty when there is no media.
   */
  private async prepareMedia(media: readonly InboundMedia[] | undefined): Promise<{ parts: readonly ContentBlock[]; notes: readonly string[] }> {
    if (media === undefined || media.length === 0) return { parts: [], notes: [] }
    const prepare = this.options.prepareMedia
    if (prepare === undefined) return { parts: [], notes: [] }
    return await prepare(media)
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

    // A card reply is answered here too, and for a stronger reason: it is the
    // answer to a question the *running* turn is blocked on. Delivering it would
    // both queue it behind that turn and hand the model text it should not see.
    if (this.cards !== undefined && await this.cards.answer(parsed.peerId, parsed.text)) return

    const handle = await this.peers.sessionFor(parsed.peerId)
    this.sessionToPeer.set(String(handle.agent.id), parsed.peerId)
    this.peers.require(handle)
    // Prepared before the turn starts, so the first thing the model sees is the
    // complete message rather than an image arriving as a second turn.
    const prepared = await this.prepareMedia(parsed.media)
    this.options.onTurnStarted?.()
    deliverInbound(agentOf(handle), { ...parsed, ...prepared }, { isLive: () => this.peers.has(parsed.peerId) })

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
