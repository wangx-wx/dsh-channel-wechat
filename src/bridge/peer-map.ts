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
  readonly agent: {
    readonly id: SessionId
    /**
     * The durable session, when the real registry supplies one.
     *
     * Optional because several tests build handles structurally. The permission
     * preset is recorded on the session, so it is the only thing here that needs
     * it - and a handle without one simply skips that step.
     */
    readonly session?: unknown
  }
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
  /**
   * Where each peer's current conversation generation is kept.
   *
   * Needed for `/new` to mean what it says across a restart. Without it the map
   * can only ever address generation zero, so `/new` would be undone by the next
   * start - the same broken promise in a slower form.
   */
  generations?: PeerGenerationsLike
  /**
   * Record this channel's configured permission preset on a freshly created
   * session.
   *
   * Called at creation only. See the field's own note for why a resume must not
   * re-apply it.
   */
  applyPermission?: (handle: AgentHandleLike) => void
}

/**
 * The slice of the peer-session store this map uses.
 *
 * Structural rather than imported, so the map stays testable without touching
 * the filesystem.
 */
export interface PeerGenerationsLike {
  /** Read one peer's current generation; zero when it has never rotated. */
  generation(peerId: string): Promise<number>
  /** Advance one peer's generation and return the new value. */
  startNew(peerId: string): Promise<number>
  /**
   * Read the directory this peer's next session should record.
   *
   * Optional so a caller that keeps no per-peer directories can supply only the
   * rotation methods; the map then falls back to its configured `cwd`.
   * @returns the stored absolute directory, or `undefined` for "no switch".
   */
  cwd?: (peerId: string) => Promise<string | undefined>
  /**
   * Persist one peer's working directory for its next session.
   *
   * Optional alongside {@link cwd}: without it a `/cwd` switch lasts one
   * process, which is reported rather than silently accepted.
   */
  setCwd?: (peerId: string, path: string) => Promise<void>
}

/**
 * The separator between a peer id and its conversation generation.
 *
 * `~g` on purpose: {@link sessionIdFor} escapes every literal `~` in a peer id
 * before appending this, and the escape it uses (`~7E`) always puts a `7` after
 * the `~`, so `~g` can never be produced *inside* an escaped peer id. That is
 * what makes the first `~g` in an id the separator rather than part of the peer.
 */
const GENERATION_SEPARATOR = '~g'

/**
 * Escape a peer id so it cannot contain the generation separator.
 *
 * Backslash-free and reversible: the only substitution is `~` → `~7E`, and
 * because every escape it introduces carries a hex digit after the `~`, the
 * marker `~g` cannot appear in the result.
 * @param peerId - the WeChat sender id.
 * @returns the peer id with every literal tilde escaped.
 */
function escapePeerId(peerId: string): string {
  return peerId.replaceAll('~', '~7E')
}

/**
 * Derive the session id for one peer's conversation generation.
 *
 * Generation zero keeps the id a conversation already has, so an untouched peer
 * resumes what it was talking to and a restart finds it. A later generation is a
 * *different* id: the session boundary offers no delete, so a different id is
 * the only way `/new` can mean what it says - reusing one would resume the very
 * conversation the user just ended.
 *
 * Both families escape the peer id first, which is what makes the mapping
 * injective. Escaping only the rotated family would collide: peer `user~g1` at
 * generation zero and peer `user` at generation one would both derive
 * `channel-wechat-user~g1`. Because {@link escapePeerId} writes `~7E` for every
 * literal tilde, the separator `~g` can never occur *inside* an escaped peer id,
 * so the first `~g` is always the separator and the two families cannot overlap.
 *
 * Escaping is the identity for every real peer id: WeChat issues ids ending in
 * `@im.wechat` made of `[A-Za-z0-9_.@-]`, none of which is `~`. That is what
 * keeps generation zero byte-identical to the id of every session that already
 * exists. A peer id that did contain a literal `~` would have its stored session
 * orphaned by the escape - impossible for a real id, and recorded here rather
 * than left implicit.
 *
 * `SessionId` is an unvalidated branded string and the JSONL backend encodes it
 * before using it as a path, so neither form needs further escaping here.
 *
 * @param peerId - the WeChat sender id.
 * @param generation - the conversation generation; zero for the original one.
 * @returns the session id.
 */
export function sessionIdFor(peerId: string, generation = 0): SessionId {
  const escaped = `${SESSION_ID_PREFIX}${escapePeerId(peerId)}`
  if (generation === 0) return escaped as SessionId
  return `${escaped}${GENERATION_SEPARATOR}${String(generation)}` as SessionId
}

/**
 * The session header behind one handle, when the handle carries a session.
 *
 * Structural because several tests build handles without one, and a handle with
 * no session simply has no recorded directory to report.
 * @param handle - the handle to read.
 * @returns the header, or `undefined` when this handle carries no session.
 */
function sessionHeaderOf(handle: AgentHandleLike): { cwd?: string } | undefined {
  const session = handle.agent.session as { header?: { cwd?: string } } | undefined
  return session?.header
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
  private readonly generations: PeerGenerationsLike | undefined
  /**
   * Records this channel's configured permission preset on a session it just
   * created.
   *
   * Applied at **creation only**, never on resume. A resume loads a session whose
   * knobs are already recorded - including a preset the user changed from WeChat
   * with `/permission` mid-conversation - and `permissionPresets` already
   * restores those (`pinInitialPermission`). Re-applying the config here would
   * silently undo the user's own in-session choice on the next restart.
   *
   * Absent when the deployment composes no permission service, in which case the
   * session keeps the composition's own default.
   */
  private readonly applyPermission: ((handle: AgentHandleLike) => void) | undefined
  /**
   * The generation each peer is currently addressing.
   *
   * Held once resolved rather than re-read per message, so a `/new` that lands
   * mid-conversation cannot move a turn already in flight to another session.
   */
  private readonly currentGeneration = new Map<string, number>()
  /**
   * The directory each peer's next session records.
   *
   * Resolved once and kept, for the same reason as the generation: a `/cwd`
   * landing mid-conversation must not move a turn already in flight to another
   * directory, and a session's `cwd` is written at creation only.
   */
  private readonly currentCwd = new Map<string, string>()
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
    this.generations = options.generations
    this.applyPermission = options.applyPermission
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
    const sessionId = sessionIdFor(peerId, await this.generationOf(peerId))
    const agentOptions = this.sessionOptions === undefined
      ? {}
      : { agentOptions: { provider: this.sessionOptions.provider, model: this.sessionOptions.model } }
    // Resolved before the existence probe, because the directory decides where a
    // *created* session runs: a resume reads the header it already recorded, so
    // this is the only chance to apply it.
    //
    // A peer that never switched and a deployment with no directory store take
    // the synchronous path on purpose. An extra await here is not free: it
    // delays when the turn starts, and that ordering is observable.
    const switched = this.currentCwd.has(peerId) || this.generations?.cwd !== undefined
    const cwd = switched ? (await this.cwdOf(peerId)) ?? this.cwd : this.cwd
    const resumed = await this.sessionExists(sessionId)
    const handle = resumed
      ? await this.resumeSession(sessionId, agentOptions)
      : await this.createNewSession(sessionId, agentOptions, cwd)
    // Only on creation: a resumed session's permission knobs are already durable,
    // and may hold a preset the user changed with `/permission`. See
    // {@link PeerMapOptions.applyPermission}.
    if (!resumed) this.applyPermission?.(handle)
    this.entries.set(peerId, { handle })
    return handle
  }

  /**
   * The conversation generation one peer is addressing.
   *
   * Seeded once from durable state and then kept in memory, so every message in
   * a conversation resolves the same id. Re-reading per message would move a turn
   * to a different session the moment `/new` landed, splitting one exchange
   * across two conversations.
   * @param peerId - the WeChat sender id.
   * @returns the generation; zero when this peer has never started a new one.
   */
  private async generationOf(peerId: string): Promise<number> {
    const known = this.currentGeneration.get(peerId)
    if (known !== undefined) return known
    const stored = this.generations === undefined ? 0 : await this.generations.generation(peerId)
    this.currentGeneration.set(peerId, stored)
    return stored
  }

  /**
   * The directory one peer's next session should record.
   *
   * Seeded once from durable state and then kept, for the same reason as the
   * generation: re-reading per message would move a turn to another directory
   * the moment `/cwd` landed, and a session's `cwd` is written at creation.
   *
   * A peer that never switched resolves to `undefined`, which means "use the
   * configured `cwd`" - so this deployment keeps working exactly as before for
   * every existing peer.
   * @param peerId - the WeChat sender id.
   * @returns the stored directory, or `undefined` when the peer never switched.
   */
  private async cwdOf(peerId: string): Promise<string | undefined> {
    if (this.currentCwd.has(peerId)) return this.currentCwd.get(peerId)
    const stored = this.generations?.cwd === undefined ? undefined : await this.generations.cwd(peerId)
    if (stored !== undefined) this.currentCwd.set(peerId, stored)
    return stored
  }

  /**
   * The directory one peer's conversation currently runs in.
   *
   * The live session's own directory wins when there is one: it is the durable
   * answer, and it covers a session created before this deployment configured a
   * different default. Otherwise the stored switch, otherwise the configured
   * directory - so the answer is never a guess.
   * @param peerId - the WeChat sender id.
   * @returns the absolute directory, or `undefined` when nothing is known.
   */
  async cwdFor(peerId: string): Promise<string | undefined> {
    const handle = this.handleFor(peerId)
    if (handle !== undefined) {
      const header = sessionHeaderOf(handle)
      if (header !== undefined && header.cwd !== undefined) return header.cwd
    }
    return (await this.cwdOf(peerId)) ?? this.cwd
  }

  /**
   * Move one peer to a new working directory.
   *
   * The directory is recorded for the *next* session and the peer is moved to a
   * new conversation, because a session's header `cwd` cannot be rewritten: the
   * only way to run somewhere else is to start a different session. The
   * rotation is not optional here - recording the directory alone would leave
   * the current conversation running where it was, and the next message would
   * still address a session that already exists.
   *
   * The caller validates the directory and disposes the old handle; this only
   * records the switch and rotates, which is the part that must stay consistent
   * with the store.
   * @param peerId - the WeChat sender id.
   * @param path - the absolute directory the next session records.
   * @returns the generation the peer now addresses.
   */
  async startNewIn(peerId: string, path: string): Promise<number> {
    // Recorded before the rotation: a crash between the two leaves the peer on
    // the old generation but with the new directory stored, so the next session
    // it creates is the one the user asked for.
    this.currentCwd.set(peerId, path)
    if (this.generations?.setCwd === undefined) {
      // No store to persist into. The rotation still happens, so the switch is
      // true for this process rather than silently ignored; a restart then falls
      // back to the configured directory, which is the same trade `/new` makes.
    } else {
      await this.generations.setCwd(peerId, path)
    }
    return await this.startNew(peerId)
  }

  /**
   * Move one peer to a new conversation.
   *
   * Forgets the live handle without disposing it - the caller owns that, because
   * `/new` must not tear a running turn down as a side effect - and advances the
   * generation, so the peer's next message addresses a session id nothing has
   * written yet and therefore starts empty.
   *
   * The counter advances in memory unconditionally and is *also* persisted when
   * this deployment keeps generations. Rotating only in memory would honour
   * `/new` until the next restart and then resume the conversation the user
   * ended; refusing to rotate without a store would make the command silently do
   * nothing, which is worse than a rotation that lasts one process.
   *
   * The old session is left on disk: the session boundary exposes no delete, and
   * a conversation the user can still read beats one silently resumed.
   * @param peerId - the WeChat sender id.
   * @returns the generation the peer now addresses.
   */
  async startNew(peerId: string): Promise<number> {
    // The handle is dropped here rather than left for the caller to remember:
    // a rotation that left it in place would make the very next `cwdFor` (and
    // `handleFor`) answer from the conversation being ended. Disposal stays with
    // the caller, which is what {@link forget} means.
    this.forget(peerId)
    const next = (await this.generationOf(peerId)) + 1
    this.currentGeneration.set(peerId, next)
    if (this.generations !== undefined) await this.generations.startNew(peerId)
    return next
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
   * @param cwd - the directory to record; omitted means the deployment recorded none.
   * @returns the live handle.
   */
  private async createNewSession(
    sessionId: SessionId,
    agentOptions: SelectionFragment,
    cwd: string | undefined,
  ): Promise<AgentHandleLike> {
    // Only `create` takes metadata. A resume reads the header the session already
    // recorded, so passing a cwd there would be silently ignored - and a session
    // created before this was configured keeps no cwd for its whole life.
    const meta = cwd === undefined ? {} : { cwd }
    const presets = this.presets
    if (presets === undefined) {
      // Omitted rather than an empty object when nothing is configured, so the
      // registry sees the same call it did before presets existed.
      return this.registry.create({
        sessionId,
        ...agentOptions,
        ...(cwd === undefined ? {} : { meta }),
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
    // Both resolved caches are dropped with the map: they are seeded from
    // durable state on the next run, and keeping a stale copy would outlive the
    // sessions they describe.
    this.currentGeneration.clear()
    this.currentCwd.clear()
    await Promise.all(entries.map(entry => entry.handle.dispose()))
  }
}
