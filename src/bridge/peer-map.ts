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

/**
 * The slice of the profile's agent-preset registry this map uses.
 *
 * Structural rather than imported, because importing the registry would make it
 * a dependency of a plugin that must also run where it does not exist.
 */
export interface AgentPresetsLike {
  /** Resolve a preset id, or the profile's default when omitted. */
  resolve(id?: string): Promise<{ readonly id: string }>
  /** Bind one unpublished agent to a preset. */
  mount(agentCtx: unknown, id?: string): Promise<unknown>
}

/**
 * Creation-time composition of one agent's scoped world, as `ctx.agents` takes it.
 *
 * The agent argument is present on resume, where its header names the preset the
 * session already recorded.
 */
export type AgentSetupLike = (
  agentCtx: unknown,
  agent: { readonly session: { readonly header: { readonly agentPreset?: string } } },
) => void | Promise<void>

/**
 * The provider and model a session selects, already shaped for `create`/`resume`.
 *
 * Empty when the profile supplies no selection, which is why it is spread into
 * the registry call rather than passed as a value: an absent key lets the
 * registry fall back, while an explicit `undefined` would not.
 */
export interface SelectionFragment {
  agentOptions?: { provider?: string; model?: string }
}

/** The slice of `ctx.agents` this map uses. */
export interface AgentRegistryLike {
  /** Create and start a new agent for one session id. */
  create(options: {
    sessionId: SessionId
    agentOptions?: { provider?: string; model?: string }
    /**
     * Durable session metadata.
     *
     * `cwd` is not decorative: the system prompt's `{{cwd}}` variable reads it,
     * and a prompt variable with no value fails the turn before the provider is
     * called. It is also immutable once written, so a session created without
     * one can never gain it - only a new session can.
     *
     * `agentPreset` is what a later resume reads to rebuild the same tool set.
     */
    meta?: { cwd?: string; agentPreset?: string }
    /** Compose the agent's scoped world, including its preset. */
    setup?: AgentSetupLike
    signal?: AbortSignal
  }): Promise<AgentHandleLike>
  /** Load a persisted session and start an agent on it. */
  resume(options: {
    resumeSessionId: SessionId
    agentOptions?: { provider?: string; model?: string }
    /** Compose the agent's scoped world, including its preset. */
    setup?: AgentSetupLike
  }): Promise<AgentHandleLike>
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
  /** Provider and model every session this map creates or resumes selects. */
  sessionOptions?: { provider: string; model: string }
  /**
   * Working directory every session this map creates records.
   *
   * Applied at creation only. `resume` takes no metadata - it reads the header
   * the session was created with - so a session that already exists keeps
   * whatever it recorded, including nothing.
   */
  cwd?: string
  /**
   * The profile's agent-preset registry, when this deployment has one.
   *
   * Not optional decoration. The web app disables every model-facing tool row
   * on the host plane and moves them behind presets, so a session that mounts no
   * preset has no tools at all: the model emits tool-call syntax from its
   * training - DeepSeek leaks its `｜DSML｜` markup - and the user reads that
   * markup as garbled text instead of an answer.
   *
   * Absent for a deployment that composes no preset roster (the headless
   * runner), where the tool rows sit on the host plane and are read from the
   * global layer anyway. There, joining a preset is neither possible nor needed.
   */
  presets?: AgentPresetsLike
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
  private readonly sessionOptions: { provider: string; model: string } | undefined
  private readonly cwd: string | undefined
  private readonly presets: AgentPresetsLike | undefined
  private readonly entries = new Map<string, Entry>()
  /**
   * Session creations still in flight, per peer.
   *
   * Creating an agent is slow enough that a second message can arrive before
   * the first peer's session exists - and a `/stop` that arrived in that window
   * would find no handle and give up, leaving the turn it meant to stop running
   * to completion.
   */
  private readonly pending = new Map<string, Promise<AgentHandleLike>>()
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
    this.sessionOptions = options.sessionOptions
    this.cwd = options.cwd
    this.presets = options.presets
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

    // One creation per peer: two messages arriving together must not each
    // create a session for the same id, which the registry rejects.
    const existing = this.pending.get(peerId)
    if (existing !== undefined) return existing

    const creation = this.createSession(peerId).finally(() => { this.pending.delete(peerId) })
    this.pending.set(peerId, creation)
    return creation
  }

  /** Create or resume one peer's session and record it. */
  private async createSession(peerId: string): Promise<AgentHandleLike> {
    const sessionId = sessionIdFor(peerId)
    const agentOptions = this.sessionOptions === undefined
      ? {}
      : { agentOptions: { provider: this.sessionOptions.provider, model: this.sessionOptions.model } }
    const handle = await this.sessionExists(sessionId)
      ? await this.resumeSession(sessionId, agentOptions)
      : await this.createNewSession(sessionId, agentOptions)
    this.entries.set(peerId, { handle })
    return handle
  }

  /**
   * Resume one peer's persisted session under the preset it recorded.
   *
   * The preset comes from the session's own header rather than the profile's
   * current default, so a session keeps the composition it was started with.
   * Falling back to the default would silently hand an old conversation a
   * different tool set than the one it ran with.
   *
   * A session created before this plugin joined a preset records none. Its
   * header cannot be edited, so resolving `undefined` - the profile's default -
   * is how such a session recovers without being recreated.
   *
   * That recovery path is verified against the registry's real behaviour rather
   * than its types: `resolve(undefined)` is what the shipped session controller
   * calls for the same case, and `setup` receives the loaded Agent
   * (`agent-loop/src/index.ts`, `setup?.(prepared.agent.ctx, prepared.agent)`),
   * which is where the recorded header is read from.
   *
   * @param sessionId - the persisted session id.
   * @param agentOptions - the selected provider and model, when configured.
   * @returns the live handle.
   */
  private async resumeSession(
    sessionId: SessionId,
    agentOptions: SelectionFragment,
  ): Promise<AgentHandleLike> {
    const presets = this.presets
    if (presets === undefined) {
      return this.registry.resume({ resumeSessionId: sessionId, ...agentOptions })
    }
    return this.registry.resume({
      resumeSessionId: sessionId,
      ...agentOptions,
      setup: async (agentCtx, agent) => {
        await presets.mount(agentCtx, agent.session.header.agentPreset)
      },
    })
  }

  /**
   * Create one peer's session under the profile's default preset.
   *
   * `meta.agentPreset` and the mounted preset must agree: the header is the
   * durable record a later resume rebuilds its composition from, and writing one
   * id while mounting another would make the log describe a world the agent
   * never ran in. Both come from the single `resolve` below.
   * @param sessionId - the session id to create.
   * @param agentOptions - the selected provider and model, when configured.
   * @returns the live handle.
   */
  private async createNewSession(
    sessionId: SessionId,
    agentOptions: SelectionFragment,
  ): Promise<AgentHandleLike> {
    // Only `create` takes metadata. A resume reads the header the session already
    // recorded, so passing a cwd there would be silently ignored - and a session
    // created before this was configured keeps no cwd for its whole life.
    const meta = this.cwd === undefined ? {} : { cwd: this.cwd }
    const presets = this.presets
    if (presets === undefined) {
      // Omitted rather than an empty object when nothing is configured, so the
      // registry sees the same call it did before presets existed.
      return this.registry.create({
        sessionId,
        ...agentOptions,
        ...(this.cwd === undefined ? {} : { meta }),
      })
    }
    const preset = await presets.resolve()
    return this.registry.create({
      sessionId,
      ...agentOptions,
      meta: { ...meta, agentPreset: preset.id },
      setup: async agentCtx => { await presets.mount(agentCtx, preset.id) },
    })
  }

  /** How many peers currently hold a session. */
  get size(): number {
    return this.entries.size
  }

  /**
   * The live handle for one peer, without creating or resuming anything.
   * @param peerId - the WeChat sender id.
   * @returns the handle, or `undefined` when this peer has none.
   */
  handleFor(peerId: string): AgentHandleLike | undefined {
    const entry = this.entries.get(peerId)
    if (entry === undefined) return undefined
    return this.registry.get(entry.handle.agent.id) === undefined ? undefined : entry.handle
  }

  /**
   * The live handle for a peer, waiting out a creation already in flight.
   *
   * A caller that must act on work the peer has started needs this rather than
   * {@link handleFor}: the turn can begin before the session is recorded, so
   * looking only at what exists would miss exactly the case where a stop is
   * most needed.
   * @param peerId - the WeChat sender id.
   * @returns the handle, or `undefined` when this peer has none.
   */
  async liveHandleFor(peerId: string): Promise<AgentHandleLike | undefined> {
    const pendingCreation = this.pending.get(peerId)
    if (pendingCreation !== undefined) {
      // A creation that fails leaves no session, which is the same answer as
      // never having had one.
      await pendingCreation.catch(() => undefined)
    }
    return this.handleFor(peerId)
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
    // Let in-flight creations finish first, or their handles are never disposed
    // and keep a registry slot and write lease after this map is gone.
    await Promise.allSettled([...this.pending.values()])
    const entries = [...this.entries.values()]
    this.entries.clear()
    this.tails.clear()
    await Promise.all(entries.map(entry => entry.handle.dispose()))
  }
}
