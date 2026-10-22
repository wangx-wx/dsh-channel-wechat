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
import { createOutbound } from './outbound.ts'
import { createPeerLifecycle } from './peer-lifecycle.ts'
import { createCommandContext } from './command-context.ts'
import { parseCommandLine } from '../bridge/commands.ts'
import { isSkillInvocation, routeCommandLine } from './command-routing.ts'
import { DEFAULT_TURN_SETTLE_TIMEOUT_MS, settleWithin } from './settle.ts'
import { runLocalCommand, type LocalCommandContext } from '../bridge/local-commands.ts'
import type { NativeCommandRow } from '../bridge/native-commands.ts'
import type { ModelCommandContext } from '../bridge/model-commands.ts'
import { parseInboundMessage, type InboundMedia } from '../wechat/inbound.ts'
import { presentedFilesFrom, type PresentedFile } from '../bridge/deliverables.ts'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { monitorLoop, type MonitorResponse } from './monitor.ts'
import { resolveDirectory } from './directory.ts'

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

/**
 * Resolve the skills one peer can invoke.
 *
 * Takes the agent and the peer's current directory: the harness's own skill
 * catalog resolves against both, so a listing that ignored either would show a
 * different set than the model sees.
 */
export type SkillLister = (agent: unknown, cwd: string | undefined) => Promise<readonly string[]>

/** Collaborators the channel needs. */
export interface ChannelOptions {
  /** The agent registry. */
  registry: AgentRegistryLike
  /** Poll the server once, aborting the request when `signal` aborts. */
  poll: (cursor: string | undefined, timeoutMs: number, signal: AbortSignal | undefined) => Promise<MonitorResponse>
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
  /**
   * Ends the run when it aborts.
   *
   * The run owner (`SingleRun`) aborts this to replace or stop a run, and a
   * `Channel` that ignored it kept polling: `stop()` was never reached because
   * `run()` never resolved, so a replacement overlapped the run it replaced.
   * A `Channel` with no signal is stopped through {@link Channel.stop} alone,
   * which is what the tests that build one directly rely on.
   */
  signal?: AbortSignal
  /** Observe a reply that exhausted its attempts. */
  onReplyError?: (error: unknown, peerId: string, text: string) => void
  /**
   * Longest text one WeChat message may carry, in characters.
   *
   * A longer reply is split rather than sent as one refused body. Absent uses
   * {@link DEFAULT_MAX_CHARS}.
   */
  maxMessageChars?: number
  /** How long {@link Channel.stop} waits for in-flight turns; see `settle.ts`. */
  turnSettleTimeoutMs?: number
  /** Observe turns `stop` gave up waiting for, by count. */
  onStopStalled?: (pending: number) => void
  /**
   * Smallest gap between two sends to one peer, in milliseconds.
   *
   * The server answers a burst with `ret: -2` / "prepare failed", and that answer
   * arrives only after the burst has already been refused - so the queue paces
   * rather than relying on the retry to discover the limit. Absent disables
   * pacing, which is what the tests that are not about rate use.
   */
  minSendIntervalMs?: number
  /** How many times a throttled reply may be retried; see `ReplyQueue`. */
  maxThrottleAttempts?: number
  /** Observe a handler failure; the loop continues either way. */
  onMessageError?: (error: unknown, message: unknown) => void
  /**
   * Observe a reference that arrived with unreadable content.
   *
   * The wire has more than one shape here - the content may be inline, or only an
   * id may arrive - and the difference is invisible downstream because both leave
   * the quote empty. Without a line naming which happened, deciding what to do
   * about it requires a phone screenshot rather than a log.
   */
  onUnreadableQuote?: (detail: unknown) => void
  /** Observe a turn beginning, so a caller can tell work is in flight. */
  onTurnStarted?: () => void
  /**
   * Show and withdraw the typing indicator around one delivered turn.
   *
   * Only conversational turns use it: a command is answered locally and a card
   * reply unblocks a turn that is already running, so neither is "the bot is
   * typing". Absent when this deployment composes no typing transport.
   */
  typing?: {
    /** Begin the indicator for one peer. */
    start: (peerId: string) => Promise<void>
    /** Withdraw it. Called even when the turn failed. */
    stop: (peerId: string) => Promise<void>
  }
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
   * Resolve the commands the harness offers one agent, listed by `/help`.
   *
   * Takes the agent rather than the peer id, for the same reason
   * {@link ChannelOptions.executeNativeCommand} does. `undefined` means the peer
   * has no live session, and the lister owns what to answer - so a deployment
   * that can answer without one still may.
   */
  nativeCommands?: (agent: unknown) => Promise<readonly NativeCommandRow[]>
  /**
   * Resolve the skills this peer can invoke, listed by `/skills`.
   *
   * Takes the agent and the peer's current directory: the harness's own skill
   * catalog resolves against both, so a listing that ignored either would show
   * a different set than the model sees. Absent when this deployment composes no
   * skill registry, where the command says so instead of reporting "none".
   */
  skills?: SkillLister
  /**
   * Whether a `/name` line names a user-invocable skill, so it is delivered
   * rather than answered as an unknown command.
   *
   * Takes the same `(agent, cwd)` pair {@link ChannelOptions.skills} does, and
   * for the same reason: a preset can mount skills the global layer lacks, so a
   * lookup that ignored the agent would answer for a different catalog than the
   * one the model sees. Absent means no skills are invocable from chat and
   * every `/name` stays a command line.
   */
  claimsSkill?: (name: string, agent: unknown, cwd: string | undefined) => Promise<boolean>
  /**
   * Provider and model each new session selects.
   *
   * Without this the loop asks the environment's model configuration, which a
   * channel plugin cannot assume is set up for it.
   */
  sessionOptions?: { provider: string; model: string }
  /**
   * What `/models` and `/model` read and write.
   *
   * Optional because a deployment can compose no LLM registry or no writable
   * profile; the commands then say so rather than the plugin refusing to load.
   * Passing it through rather than reading the environment here keeps the
   * channel free of the harness's model services, the same way the command
   * forwarder keeps it free of `ctx.commands`.
   */
  models?: ModelCommandContext
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
   * Record this channel's configured permission preset on a session it creates.
   *
   * Creation-only, so a resumed session keeps whatever knobs it recorded -
   * including a preset the user changed from WeChat with `/permission`.
   */
  applyPermission?: (handle: AgentHandleLike) => void
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
  /** Turns one answer into the messages the transport accepts. */
  private readonly outbound: ReturnType<typeof createOutbound>
  /** Ending, moving, and cancelling a peer's conversation. */
  private readonly lifecycle: ReturnType<typeof createPeerLifecycle>

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
      ...(options.applyPermission === undefined ? {} : { applyPermission: options.applyPermission }),
    })
    this.replies = new ReplyQueue({
      send: options.send,
      ...(options.maxThrottleAttempts === undefined ? {} : { maxThrottleAttempts: options.maxThrottleAttempts }),
      ...(options.minSendIntervalMs === undefined ? {} : { minIntervalMs: options.minSendIntervalMs }),
      ...(options.onReplyError === undefined ? {} : {
        onGiveUp: (peerId, text, error) => options.onReplyError?.(error, peerId, text),
      }),
    })
    this.outbound = createOutbound({
      queue: this.replies,
      ...(options.maxMessageChars === undefined ? {} : { maxMessageChars: options.maxMessageChars }),
    })
    this.lifecycle = createPeerLifecycle({ peers: this.peers, sessionToPeer: this.sessionToPeer })
  }

  /** Poll until stopped. Resolves when the loop has exited. */
  async run(): Promise<void> {
    if (this.running !== undefined) return this.running
    const controller = new AbortController()
    this.controller = controller
    // Two ways to end this run, one loop: the owner's signal, and `stop()`.
    // Forwarding the owner's abort into the local controller is what makes the
    // two agree - without it the loop only ever watched its own controller,
    // which nothing outside this class can reach.
    const outer = this.options.signal
    if (outer !== undefined) {
      if (outer.aborted) controller.abort()
      else outer.addEventListener('abort', () => controller.abort(), { once: true })
    }
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
        //
        // A skill invocation is a turn, not a command, so it must be queued
        // like one - otherwise it could interleave with the turn already
        // running for this peer. The same predicate `handleCommand` uses
        // decides, so the two cannot disagree about which lines are commands.
        const text = textOf(message)
        const command = text === undefined ? undefined : parseCommandLine(text)
        // A skill is a turn, not a command, so it must queue like one. This
        // only classifies; running it is `handleMessage`'s job.
        const isSkill = command !== undefined && await isSkillInvocation(command.name, this.skillClaim(peerId))
        if (command !== undefined && !isSkill) {
          const ran = work()
          this.commandWork.add(ran)
          void ran.finally(() => this.commandWork.delete(ran))
          await ran
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
    this.enqueueReply(peerId, text)
  }

  /**
   * Queue one reply, split into messages the transport will accept.
   *
   * The cutting and the queueing live in {@link ./outbound}; this is the single
   * door every outbound text goes through, so the length ceiling cannot be
   * forgotten at a call site. Synchronous for the same reason the outbound
   * function is: the queue starts its pump in the same call, and the reply path
   * is detached.
   * @param peerId - the conversation to answer.
   * @param text - the text to send.
   */
  private enqueueReply(peerId: string, text: string): void {
    this.outbound(peerId, text, id => this.tokens.get(id))
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

  /**
   * Stop the loop and release every session this channel owns.
   *
   * The order is what keeps a reply from being lost. Draining the queue first
   * looks right and is not: a turn still in flight commits its
   * `assistant/message` *after* that drain, so the answer is enqueued into a
   * queue nobody waits on again - and WeChat never replays it. So the turns
   * settle first, and only then is the queue drained.
   *
   * The loop is awaited **last**, not first: a poll already in flight is aborted
   * by the controller and resolves on its own, and waiting for the whole loop
   * before the turns would make every stop wait out one more poll cycle before
   * flushing the replies it exists to flush.
   */
  async stop(): Promise<void> {
    // Released before anything is awaited: a card still open holds a turn that
    // is itself holding work `stop` would otherwise wait on, so waiting first
    // would hang the shutdown on the very card being abandoned.
    this.cards?.dispose()
    this.controller?.abort()
    // The turns it started: each one enqueues its answer as it commits, so the
    // drain below has to run after this rather than before it.
    // Bounded, and giving up is reported: the reply is lost either way, and
    // only that line says why the user saw nothing.
    const pending = [...this.turnWork]
    if (!await settleWithin(pending, this.options.turnSettleTimeoutMs ?? DEFAULT_TURN_SETTLE_TIMEOUT_MS)) {
      this.options.onStopStalled?.(pending.length)
    }
    await Promise.allSettled([...this.commandWork])
    // Now the queue holds everything that will ever be queued for this run.
    await this.replies.drain()
    // Awaited last, so a poll still unwinding cannot queue a reply behind the
    // drain that already ran.
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
    this.enqueueReply(peerId, text)
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
   * Answer one slash command for a peer, outside the peer's queue and without
   * delivering it to the model: the reply is the command's own output.
   * @param peerId - the peer whose message carried the command.
   * @param text - the command line.
   * @returns whether the line was a command, rather than a skill invocation to
   *   be delivered as a turn.
   */
  private async handleCommand(peerId: string, text: string): Promise<boolean> {
    const { outcome } = await routeCommandLine(text, {
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
      claimsSkill: this.skillClaim(peerId),
    })
    // `undefined` means the line belongs to the agent - a skill invocation. The
    // caller delivers it like ordinary text rather than answering it here.
    if (outcome === undefined) return false
    this.enqueueReply(peerId, outcome.text ?? `${outcome.kind === 'success' ? '完成' : '失败'}`)
    return true
  }

  /**
   * The skill predicate for one peer, bound to its conversation.
   *
   * A preset can mount skills the global layer lacks, so the answer needs the
   * peer's live agent and directory - not just the line.
   * @param peerId - the peer whose line is being classified.
   * @returns the predicate, or `undefined` when this deployment has no skills.
   */
  private skillClaim(peerId: string): ((name: string) => Promise<boolean>) | undefined {
    const claims = this.options.claimsSkill
    if (claims === undefined) return undefined
    return async name => {
      const handle = this.peers.handleFor(peerId)
      return await claims(name, handle?.agent, await this.peers.cwdFor(peerId))
    }
  }

  /**
   * The context this channel's own commands run against.
   * @param peerId - the peer whose command is running.
   * @returns the command context.
   */
  private localCommandContext(peerId: string): LocalCommandContext {
    return createCommandContext({
      peerId,
      peers: this.peers,
      ...(this.options.accountId === undefined ? {} : { accountId: this.options.accountId }),
      ...(this.options.cancelRunning === undefined ? {} : { cancelRunning: this.options.cancelRunning }),
      cancel: peer => this.lifecycle.cancel(peer),
      endSession: peer => this.lifecycle.end(peer),
      changeCwd: async (peer, path) => {
        // Validated before anything is torn down: a typo must cost the user a
        // message, not the conversation they were in.
        const resolved = await resolveDirectory(path)
        await this.lifecycle.endIn(peer, resolved)
        return resolved
      },
      ...(this.options.nativeCommands === undefined ? {} : { nativeCommands: this.options.nativeCommands }),
      ...(this.options.skills === undefined ? {} : { skills: this.options.skills }),
      ...(this.options.models === undefined ? {} : { models: this.options.models }),
    })
  }

  /** Options passed to every `create`/`resume` for a peer's session. */
  private get createOptions(): { provider?: string; model?: string } {
    const options = this.options.sessionOptions
    return options === undefined ? {} : { provider: options.provider, model: options.model }
  }

  /**
   * Prepare a message's media, when this deployment can.
   *
   * Inlined rather than delegated, and the no-media case returns **before any
   * `await`**. That is not a micro-optimisation: an extra suspension point here
   * defers the delivery of the inbound message by a microtask, which is enough to
   * change when the turn's `assistant/message` is committed relative to the reply
   * subscription - and a real test caught exactly that.
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
    //
    // A `/name` that turns out to be a **skill** is the exception, and the
    // reason the answer is a boolean: the harness recognizes that gesture by
    // scanning the delivered message, so the line has to reach the agent or the
    // invocation `/skills` advertises can never work from WeChat.
    if (parseCommandLine(parsed.text) !== undefined) {
      if (await this.handleCommand(parsed.peerId, parsed.text)) return
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
    // A reference whose text never arrived is reported, because "quoted nothing"
    // and "quoted something unreadable" are indistinguishable in the delivered
    // message and need different fixes.
    if (parsed.quoted === true && parsed.quote === undefined) {
      this.options.onUnreadableQuote?.(`from ${parsed.peerId}`)
    }
    const prepared = await this.prepareMedia(parsed.media)
    this.options.onTurnStarted?.()
    // Started only now: the commands and card replies above returned already,
    // and neither is the bot working on a prompt. Awaited so the indicator is
    // visible before the first model token could be, and silent on failure
    // because the indicator must never cost a reply.
    await this.options.typing?.start(parsed.peerId)
    try {
      deliverInbound(agentOf(handle), { ...parsed, ...prepared }, { isLive: () => this.peers.has(parsed.peerId) })

      // Wait for the turn this message started. The answer is read from the
      // committed `assistant/message`, which only exists once the turn settles,
      // and the poll loop is detached from this work — so returning here
      // would let the channel report itself settled with the turn still running.
      await agentOf(handle).whenIdle?.()
    } finally {
      // In `finally` because a turn that failed still has to take the
      // indicator down; an indicator left running reads as a hung bot.
      await this.options.typing?.stop(parsed.peerId)
    }
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
