/**
 * The map from a WeChat peer to the DSH session serving it.
 *
 * One peer, one session, held as a live handle. Three properties this file
 * exists to guarantee, each because the alternative fails silently:
 *
 *  - **Reuse.** A second `create` for a live id throws, so the handle has to be
 *    kept rather than rebuilt per message.
 *  - **Liveness.** `followup` on a disposed agent accepts the message and drops
 *    it. A stale handle therefore presents as a channel that quietly stops
 *    answering instead of an error, so every delivery checks the registry.
 *  - **Order.** `whenIdle` is whole-agent silence with no way to tell whose turn
 *    ended, so a peer's work is queued and run one turn at a time.
 *
 * The registry is injected rather than reached for, which keeps this testable
 * without an agent loop.
 *
 * @module dsh-channel-wechat/bridge/peer-map
 */

import type { SessionId } from '@deepseek-ai/dsh-session'

/** The session id prefix this channel owns, kept distinct from other plugins'. */
export const SESSION_ID_PREFIX = 'channel-wechat-'

/** The slice of `ctx.agents` this map uses. */
export interface AgentRegistryLike {
  /** Create and start a new agent for one session id. */
  create(options: { sessionId: SessionId; signal?: AbortSignal }): Promise<AgentHandleLike>
  /** Load a persisted session and start an agent on it. */
  resume(options: { resumeSessionId: SessionId }): Promise<AgentHandleLike>
  /** The live agent for one session id, if any. */
  get(sessionId: SessionId): { readonly id: SessionId } | undefined
}

/** An owned agent plus its disposer, as `ctx.agents` returns it. */
export interface AgentHandleLike {
  /** The agent itself; the surface messages are delivered through. */
  readonly agent: { readonly id: SessionId }
  /** Stop the loop, unregister the agent, and release the write lease. */
  dispose(): Promise<void>
}

/** Collaborators the map needs. */
export interface PeerMapOptions {
  /** The agent registry. */
  registry: AgentRegistryLike
  /** Probe whether a persisted session already exists; defaults to "no". */
  sessionExists?: (sessionId: SessionId) => Promise<boolean>
}

/**
 * Derive the session id for one peer.
 *
 * A pure function of the peer id, so a restart finds the same conversation.
 * `SessionId` is an unvalidated branded string and the JSONL backend encodes
 * it before using it as a path, so a peer id needs no escaping here.
 * @param peerId - the WeChat sender id.
 * @returns the session id.
 */
export function sessionIdFor(peerId: string): SessionId {
  return `${SESSION_ID_PREFIX}${peerId}` as SessionId
}

/** One peer's session. */
interface Entry {
  handle: AgentHandleLike
}

/** The peer-to-session map. */
export class PeerMap {
  private readonly registry: AgentRegistryLike
  private readonly sessionExists: (sessionId: SessionId) => Promise<boolean>
  private readonly entries = new Map<string, Entry>()
  /**
   * Per-peer turn queues, kept apart from the session entries: a peer has a
   * queue from its first message, which is what stops two early messages from
   * running at once before either has created a session.
   */
  private readonly tails = new Map<string, Promise<void>>()

  /**
   * @param options - the registry and an optional existence probe.
   */
  constructor(options: PeerMapOptions) {
    this.registry = options.registry
    this.sessionExists = options.sessionExists ?? (async () => false)
  }

  /**
   * The live session for one peer, creating or resuming it as needed.
   * @param peerId - the WeChat sender id.
   * @returns the live handle.
   */
  async sessionFor(peerId: string): Promise<AgentHandleLike> {
    const current = this.entries.get(peerId)
    // Reuse only while the registry still knows the agent: a handle kept past
    // a disposal would swallow every message delivered through it.
    if (current !== undefined && this.registry.get(current.handle.agent.id) !== undefined) return current.handle

    const sessionId = sessionIdFor(peerId)
    const handle = await this.sessionExists(sessionId)
      ? await this.registry.resume({ resumeSessionId: sessionId })
      : await this.registry.create({ sessionId })
    this.entries.set(peerId, { handle })
    return handle
  }

  /**
   * Whether this peer has a live session.
   * @param peerId - the WeChat sender id.
   * @returns true when a live handle is held.
   */
  has(peerId: string): boolean {
    const entry = this.entries.get(peerId)
    return entry !== undefined && this.registry.get(entry.handle.agent.id) !== undefined
  }

  /**
   * Check that a handle is still live.
   * @param handle - the handle to check.
   * @throws when the registry no longer knows the agent.
   */
  require(handle: AgentHandleLike): void {
    if (this.registry.get(handle.agent.id) !== undefined) return
    throw new Error(`channel-wechat: session ${String(handle.agent.id)} is no longer live; the message would be dropped`)
  }

  /**
   * Run one peer's work in order, after everything already queued for it.
   * @param peerId - the WeChat sender id.
   * @param work - the work to run.
   * @returns when the work has settled.
   */
  async runExclusive(peerId: string, work: () => Promise<void>): Promise<void> {
    const previous = this.tails.get(peerId) ?? Promise.resolve()
    let release: () => void = () => {}
    const current = new Promise<void>(resolve => { release = resolve })
    this.tails.set(peerId, current)

    // `current` is released in a `finally`, so it always settles and a rejected
    // turn cannot wedge the queue and mute this peer until restart. The work's
    // own rejection propagates to its caller instead.
    await previous
    try {
      await work()
    } finally {
      release()
      // Drop the slot once this turn is the last one, so a long-lived channel
      // does not accumulate one promise per peer forever.
      if (this.tails.get(peerId) === current) this.tails.delete(peerId)
    }
  }

  /**
   * Drop one peer's handle without disposing it.
   *
   * The caller owns disposal, because it may be tearing the agent down itself;
   * this only stops the map from handing back a handle it no longer trusts.
   * @param peerId - the WeChat sender id.
   */
  forget(peerId: string): void {
    this.entries.delete(peerId)
  }

  /**
   * Dispose every session this map owns.
   *
   * Disposal is not optional: an undisposed agent keeps its registry slot and
   * write lease, so a later create for the same id throws.
   * @returns when every handle has been disposed.
   */
  async disposeAll(): Promise<void> {
    const entries = [...this.entries.values()]
    this.entries.clear()
    this.tails.clear()
    await Promise.all(entries.map(entry => entry.handle.dispose()))
  }
}
