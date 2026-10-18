/**
 * The map from a WeChat peer to the DSH session that serves it.
 *
 * Three failure modes live here and nowhere else:
 *  - creating a second agent for an id already in use throws, so a map that
 *    does not reuse its handles breaks on the second message;
 *  - `followup` on a disposed agent accepts the message and drops it, so a
 *    stale handle looks like a working channel that never answers;
 *  - `resume` throws when the session does not exist, so existence has to be
 *    probed rather than assumed.
 *
 * The registry is injected, so the map's own logic is verified without an
 * agent loop; the real composition is proved separately.
 */

import { describe, expect, it } from 'vitest'
import { PeerMap, sessionIdFor } from '../../src/bridge/peer-map.ts'

/**
 * A stand-in for the pieces of `ctx.agents` the map uses.
 *
 * It mirrors the real registry where it matters: `create` throws for an id that
 * is already live, `get` returns undefined once an agent is gone, and the
 * handle's disposer releases the id. A stub that allowed a duplicate create
 * would hide the reuse bug this suite exists to catch.
 */
function fakeRegistry(options: {
  existingSessions?: string[]
  /** Preset ids the stored sessions recorded, read back on resume. */
  recordedPresets?: Record<string, string>
} = {}) {
  const created: string[] = []
  const resumed: string[] = []
  const disposed: string[] = []
  /** Every selection fragment the registry was handed, create or resume. */
  const asked: { kind: 'create' | 'resume'; sessionId: string; agentOptions?: unknown }[] = []
  const live = new Map<string, { agent: { id: string }; dispose: () => Promise<void> }>()

  const makeHandle = (sessionId: string) => {
    const handle = {
      // The session is what a permission preset is recorded on, so the fake
      // carries one: a handle without it would make the permission assertions
      // below pass vacuously.
      agent: { id: sessionId, session: { id: sessionId } },
      dispose: async () => {
        disposed.push(sessionId)
        live.delete(sessionId)
      },
    }
    return handle
  }

  return {
    created,
    resumed,
    disposed,
    asked,
    live,
    registry: {
      async create({ sessionId, agentOptions }: { sessionId: string; agentOptions?: unknown }) {
        if (live.has(sessionId)) throw new Error(`already registered: ${sessionId}`)
        created.push(sessionId)
        asked.push({ kind: 'create', sessionId, agentOptions })
        const handle = makeHandle(sessionId)
        live.set(sessionId, handle)
        return handle
      },
      async resume({ resumeSessionId, setup, agentOptions }: {
        resumeSessionId: string
        agentOptions?: unknown
        setup?: (agentCtx: unknown, agent: { session: { header: { agentPreset?: string } } }) => unknown
      }) {
        if (!(options.existingSessions ?? []).includes(resumeSessionId)) {
          throw new Error(`session not found: ${resumeSessionId}`)
        }
        resumed.push(resumeSessionId)
        asked.push({ kind: 'resume', sessionId: resumeSessionId, agentOptions })
        const handle = makeHandle(resumeSessionId)
        live.set(resumeSessionId, handle)
        // The real registry awaits setup before publishing the agent, handing it
        // the session it loaded - which is where a resume reads the recorded
        // preset from.
        const recorded = options.recordedPresets?.[resumeSessionId]
        await setup?.(undefined, {
          session: { header: recorded === undefined ? {} : { agentPreset: recorded } },
        })
        return handle
      },
      get(sessionId: string) {
        return live.get(sessionId)?.agent
      },
    },
  }
}

describe('the model selection handed to the registry', () => {
  it('passes the configured selection to a resume, not only to a create', async () => {
    // The selection is not a creation-time fact: a resumed session's next loop
    // seeds its first request from `agentOptions`, so dropping it on resume
    // would quietly keep the old model after a switch. The same pair goes to
    // both calls.
    const f = fakeRegistry({ existingSessions: ['channel-wechat-user-7'] })
    const map = new PeerMap({
      registry: f.registry as never,
      sessionExists: async id => id === 'channel-wechat-user-7',
      sessionOptions: { provider: 'provider-b', model: 'model-b1' },
    })

    await map.sessionFor('user-7')

    expect(f.asked).toEqual([
      { kind: 'resume', sessionId: 'channel-wechat-user-7', agentOptions: { provider: 'provider-b', model: 'model-b1' } },
    ])
  })

  it('passes the configured selection to a create', async () => {
    const f = fakeRegistry()
    const map = new PeerMap({
      registry: f.registry as never,
      sessionExists: async () => false,
      sessionOptions: { provider: 'provider-b', model: 'model-b1' },
    })

    await map.sessionFor('user-7')

    expect(f.asked).toEqual([
      { kind: 'create', sessionId: 'channel-wechat-user-7', agentOptions: { provider: 'provider-b', model: 'model-b1' } },
    ])
  })

})

describe('reusing a session for one peer', () => {
  it('creates the session on first contact and reuses it afterwards', async () => {
    // Creating a second agent for a live id throws, so returning a fresh handle
    // per message would break the channel from the second message on.
    const f = fakeRegistry()
    const map = new PeerMap({ registry: f.registry as never })

    const first = await map.sessionFor('user-7')
    const second = await map.sessionFor('user-7')

    expect(first).toBe(second)
    expect(f.created).toEqual([first.agent.id])
  })

  it('gives different peers different sessions', async () => {
    const f = fakeRegistry()
    const map = new PeerMap({ registry: f.registry as never })

    const a = await map.sessionFor('user-7')
    const b = await map.sessionFor('user-8')

    expect(a.agent.id).not.toBe(b.agent.id)
    expect(f.created).toHaveLength(2)
  })
})

describe('session identity', () => {
  it('derives an id a restart can find again', async () => {
    // The derivation has to be a pure function of the peer id: a random one
    // would make every restart a new session, losing the conversation.
    const first = new PeerMap({ registry: fakeRegistry().registry as never })
    const second = new PeerMap({ registry: fakeRegistry().registry as never })

    expect((await first.sessionFor('user-7')).agent.id).toBe((await second.sessionFor('user-7')).agent.id)
  })

  it('gives different peers different ids', async () => {
    const map = new PeerMap({ registry: fakeRegistry().registry as never })

    const a = (await map.sessionFor('user-7')).agent.id
    const b = (await map.sessionFor('user-8')).agent.id

    expect(a).not.toBe(b)
  })

  it('keeps generation zero on the id every existing session already has', () => {
    // An untouched peer must keep resuming the conversation it already has, so
    // the first generation cannot shift the id - existing sessions are stored
    // under exactly this name.
    expect(sessionIdFor('user-7', 0)).toBe('channel-wechat-user-7')
  })

  it('gives a later generation an id of its own', () => {
    // `/new` has no way to delete the stored session, so the new conversation
    // can only be a different id. If this collided, `/new` would resume the
    // conversation the user just ended.
    expect(sessionIdFor('user-7', 1)).not.toBe(sessionIdFor('user-7', 0))
    expect(sessionIdFor('user-7', 2)).not.toBe(sessionIdFor('user-7', 1))
  })

  it('does not confuse one peer\u2019s later generation with another peer\u2019s first', () => {
    // A rotated id is `escape(peer)~gN`, so a peer id that literally contains
    // `~g` is the case that could collide with it. Escaping BOTH families is what
    // prevents that: the escape always writes `~7E`, so `~g` can never occur
    // inside an escaped peer id, and the first `~g` in an id is always the
    // separator. Escaping only the rotated family would fail this line.
    expect(sessionIdFor('user~g1', 0)).not.toBe(sessionIdFor('user', 1))
  })

  it('leaves a real peer id untouched, so an existing session is still found', () => {
    // WeChat ids end in `@im.wechat` over `[A-Za-z0-9_.@-]`, none of which is
    // `~`, so the escape is the identity for every id the server actually issues.
    // That is what keeps generation zero byte-identical to the id of every
    // session that already exists on disk.
    const realPeerId = 'o9cq801j8x36C_4pcNTQF6aAqKIg@im.wechat'

    expect(sessionIdFor(realPeerId, 0)).toBe(`channel-wechat-${realPeerId}`)
  })
})

describe('resuming after a restart', () => {
  it('resumes an existing session instead of creating a duplicate', async () => {
    // A create for an id that already has persisted state would either throw
    // or start an empty conversation beside the stored one.
    const f = fakeRegistry({ existingSessions: ['channel-wechat-user-7'] })
    const map = new PeerMap({ registry: f.registry as never, sessionExists: async id => id === 'channel-wechat-user-7' })

    const session = await map.sessionFor('user-7')

    expect(session.agent.id).toBe('channel-wechat-user-7')
    expect(f.resumed).toEqual(['channel-wechat-user-7'])
    expect(f.created).toEqual([])
  })

  it('creates when the session does not exist yet', async () => {
    const f = fakeRegistry()
    const map = new PeerMap({ registry: f.registry as never, sessionExists: async () => false })

    await map.sessionFor('user-7')

    expect(f.created).toHaveLength(1)
    expect(f.resumed).toEqual([])
  })

  it("mounts the preset the session recorded, not the profile's current default", async () => {
    // A resumed session rebuilds the composition it was started with: the preset
    // decides which tools the agent has, and the recorded header is the only
    // durable record of it. Falling back to the profile's default would silently
    // hand an old conversation a different tool set than it ran with.
    const f = fakeRegistry({
      existingSessions: ['channel-wechat-user-7'],
      recordedPresets: { 'channel-wechat-user-7': 'minimal' },
    })
    const resolved: (string | undefined)[] = []
    const mounted: (string | undefined)[] = []
    const map = new PeerMap({
      registry: f.registry as never,
      sessionExists: async id => id === 'channel-wechat-user-7',
      presets: {
        resolve: (id?: string) => {
          resolved.push(id)
          return Promise.resolve({ id: id ?? 'from-profile' })
        },
        mount: (_ctx: unknown, id?: string) => {
          mounted.push(id)
          return Promise.resolve({ id: id ?? 'from-profile' })
        },
      },
    })

    await map.sessionFor('user-7')

    expect(mounted).toEqual(['minimal'])
    // Nothing asked the profile for a default: a resume's source of truth is the
    // session's own record, and `undefined` there is what recovers a session
    // created before this plugin joined a preset.
    expect(resolved).toEqual([])
  })

  it('mounts the profile default when the stored session recorded no preset', async () => {
    // A session created by an older version of this plugin has no recorded
    // preset, and its header cannot be edited. Resolving `undefined` gives it the
    // profile's default, which is how it recovers without being recreated.
    const f = fakeRegistry({ existingSessions: ['channel-wechat-user-7'] })
    const mounted: (string | undefined)[] = []
    const map = new PeerMap({
      registry: f.registry as never,
      sessionExists: async id => id === 'channel-wechat-user-7',
      presets: {
        resolve: (id?: string) => Promise.resolve({ id: id ?? 'from-profile' }),
        mount: (_ctx: unknown, id?: string) => {
          mounted.push(id)
          return Promise.resolve({ id: id ?? 'from-profile' })
        },
      },
    })

    await map.sessionFor('user-7')

    expect(mounted).toEqual([undefined])
  })
})

describe('starting a new conversation', () => {
  it('uses a different session for the next message', async () => {
    // What `/new` promises. The session boundary offers no delete, so the only
    // way to start a fresh conversation is to address a different id.
    const f = fakeRegistry()
    const map = new PeerMap({ registry: f.registry as never })

    const before = await map.sessionFor('user-7')
    map.forget('user-7')
    await map.startNew('user-7')
    const after = await map.sessionFor('user-7')

    expect(after.agent.id).not.toBe(before.agent.id)
  })

  it('resumes the new conversation after a restart instead of the old one', async () => {
    // The generation has to be durable: an in-memory counter would honor `/new`
    // until the next restart and then silently resume the ended conversation.
    // A fresh map over a store that already says generation 1 is exactly what the
    // next process sees.
    const rotated = sessionIdFor('user-7', 1)
    const f = fakeRegistry({ existingSessions: [rotated] })
    const map = new PeerMap({
      registry: f.registry as never,
      sessionExists: async existing => existing === rotated,
      generations: { generation: async () => 1, startNew: async () => 2 },
    })

    await map.sessionFor('user-7')

    expect(f.resumed).toEqual([rotated])
    expect(f.created).toEqual([])
  })

  it('carries a rotation into the next process', async () => {
    // The write half of the same guarantee: `/new` must persist the new
    // generation, or the restart above would read the old one back.
    const f = fakeRegistry()
    const advanced: string[] = []
    const map = new PeerMap({
      registry: f.registry as never,
      generations: {
        generation: async () => 0,
        startNew: async peerId => {
          advanced.push(peerId)
          return 1
        },
      },
    })

    await map.startNew('user-7')

    expect(advanced).toEqual(['user-7'])
  })

  it('does not touch another peer\u2019s session', async () => {
    const f = fakeRegistry()
    const map = new PeerMap({ registry: f.registry as never })
    const other = await map.sessionFor('user-8')

    await map.startNew('user-7')
    const rebuiltOther = await map.sessionFor('user-8')

    expect(rebuiltOther).toBe(other)
  })
})

describe('a stale handle', () => {
  it('is not handed back once the agent is gone', async () => {
    // `followup` on a disposed agent accepts the message and drops it, so a
    // stale handle presents as a channel that silently stops answering.
    const f = fakeRegistry()
    const map = new PeerMap({ registry: f.registry as never })
    const session = await map.sessionFor('user-7')

    map.forget('user-7')
    await session.dispose()
    const rebuilt = await map.sessionFor('user-7')

    expect(rebuilt).not.toBe(session)
    expect(f.created).toHaveLength(2)
  })

  it('is not reused when something else disposed the agent', async () => {
    // The map is not told about every disposal: an owner fiber can tear an
    // agent down while this map still holds the handle. Reusing it would
    // deliver the next message into a disposed agent, which accepts it and
    // drops it, so the peer goes quiet with no error anywhere.
    const f = fakeRegistry()
    const map = new PeerMap({ registry: f.registry as never })
    const stale = await map.sessionFor('user-7')

    f.live.clear()

    expect(map.has('user-7')).toBe(false)
    const rebuilt = await map.sessionFor('user-7')
    expect(rebuilt).not.toBe(stale)
    expect(f.created).toEqual(['channel-wechat-user-7', 'channel-wechat-user-7'])
  })
})

describe('shutdown', () => {
  it('disposes every session it owns', async () => {
    const f = fakeRegistry()
    const map = new PeerMap({ registry: f.registry as never })
    await map.sessionFor('user-7')
    await map.sessionFor('user-8')

    await map.disposeAll()

    expect(f.disposed.sort()).toEqual(['channel-wechat-user-7', 'channel-wechat-user-8'])
  })

  it('leaves nothing behind that would block a later create', async () => {
    const f = fakeRegistry()
    const map = new PeerMap({ registry: f.registry as never })
    await map.sessionFor('user-7')
    await map.disposeAll()

    // Re-creating the same id only succeeds if the handle was really released.
    await expect(map.sessionFor('user-7')).resolves.toBeDefined()
  })
})

describe('serialization per peer', () => {
  it('runs one peer\u2019s work in order', async () => {
    // Two messages from one peer must not interleave: `whenIdle` is whole-agent
    // silence and cannot tell whose turn ended.
    const map = new PeerMap({ registry: fakeRegistry().registry as never })
    const order: string[] = []

    const run = (label: string, delay: number): Promise<void> => map.runExclusive('user-7', async () => {
      order.push(`${label}:start`)
      await new Promise(resolve => setTimeout(resolve, delay))
      order.push(`${label}:end`)
    })

    await Promise.all([run('a', 20), run('b', 1)])

    expect(order).toEqual(['a:start', 'a:end', 'b:start', 'b:end'])
  })

  it('lets different peers proceed independently', async () => {
    // Serializing globally would let one slow peer stall every other user.
    const map = new PeerMap({ registry: fakeRegistry().registry as never })
    const order: string[] = []

    const run = (peer: string, label: string, delay: number): Promise<void> => map.runExclusive(peer, async () => {
      order.push(`${label}:start`)
      await new Promise(resolve => setTimeout(resolve, delay))
      order.push(`${label}:end`)
    })

    await Promise.all([run('user-7', 'slow', 30), run('user-8', 'fast', 1)])

    expect(order.slice(0, 2)).toEqual(['slow:start', 'fast:start'])
  })

  it('keeps serving a peer after its work throws', async () => {
    // A rejected turn must not wedge the queue, or the peer is mute until
    // restart.
    const map = new PeerMap({ registry: fakeRegistry().registry as never })

    await expect(map.runExclusive('user-7', async () => { throw new Error('turn failed') })).rejects.toThrow('turn failed')
    await expect(map.runExclusive('user-7', async () => undefined)).resolves.toBeUndefined()
  })
})

describe('calling the agent', () => {
  it('refuses to deliver to a session that is no longer live', async () => {
    // The whole point of the liveness check: without it the message vanishes.
    const f = fakeRegistry()
    const map = new PeerMap({ registry: f.registry as never })
    const session = await map.sessionFor('user-7')
    f.live.clear()

    expect(() => map.require(session)).toThrow(/no longer live/u)
  })

  it('accepts a session the registry still knows', async () => {
    const f = fakeRegistry()
    const map = new PeerMap({ registry: f.registry as never })
    const session = await map.sessionFor('user-7')

    expect(() => map.require(session)).not.toThrow()
  })
})

describe('unknown peers', () => {
  it('reports that a peer has no session yet', () => {
    const map = new PeerMap({ registry: fakeRegistry().registry as never })

    expect(map.has('never-seen')).toBe(false)
  })
})

describe('the permission preset a new session records', () => {
  it('applies the preset to a session it creates', async () => {
    const f = fakeRegistry()
    const applied: { session: unknown; preset: string }[] = []
    const map = new PeerMap({
      registry: f.registry as never,
      applyPermission: handle => { applied.push({ session: handle.agent.session, preset: 'read-only' }) },
    })

    const handle = await map.sessionFor('user-7')

    expect(applied).toEqual([{ session: handle.agent.session, preset: 'read-only' }])
  })

  it('does NOT re-apply the preset when resuming an existing session', async () => {
    // This is the whole reason the callback is creation-only. A resumed session
    // already carries its own durable knobs - including a preset the user changed
    // from WeChat with `/permission` mid-conversation - and the permission
    // service restores those. Re-applying the config here would silently undo the
    // user's own choice on the next restart, which is invisible until they notice
    // the agent asking for approval it should not.
    const f = fakeRegistry({ existingSessions: [sessionIdFor('user-7', 0)] })
    const applied: unknown[] = []
    const map = new PeerMap({
      registry: f.registry as never,
      // The map takes its own existence probe; the fake registry's option only
      // decides which ids a resume is allowed to find.
      sessionExists: async () => true,
      applyPermission: handle => { applied.push(handle.agent.session) },
    })

    await map.sessionFor('user-7')

    expect(f.resumed).toHaveLength(1)
    expect(applied).toEqual([])
  })

  it('applies nothing when the deployment configures no callback', async () => {
    // A deployment with no permission service must keep working; the absent
    // callback is how that is expressed, not an error.
    const f = fakeRegistry()
    const map = new PeerMap({ registry: f.registry as never })

    await expect(map.sessionFor('user-7')).resolves.toBeDefined()
  })
})
