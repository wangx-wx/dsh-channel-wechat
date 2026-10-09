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
import { PeerMap } from '../../src/bridge/peer-map.ts'

/**
 * A stand-in for the pieces of `ctx.agents` the map uses.
 *
 * It mirrors the real registry where it matters: `create` throws for an id that
 * is already live, `get` returns undefined once an agent is gone, and the
 * handle's disposer releases the id. A stub that allowed a duplicate create
 * would hide the reuse bug this suite exists to catch.
 */
function fakeRegistry(options: { existingSessions?: string[] } = {}) {
  const created: string[] = []
  const resumed: string[] = []
  const disposed: string[] = []
  const live = new Map<string, { agent: { id: string }; dispose: () => Promise<void> }>()

  const makeHandle = (sessionId: string) => {
    const handle = {
      agent: { id: sessionId },
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
    live,
    registry: {
      async create({ sessionId }: { sessionId: string }) {
        if (live.has(sessionId)) throw new Error(`already registered: ${sessionId}`)
        created.push(sessionId)
        const handle = makeHandle(sessionId)
        live.set(sessionId, handle)
        return handle
      },
      async resume({ resumeSessionId }: { resumeSessionId: string }) {
        if (!(options.existingSessions ?? []).includes(resumeSessionId)) {
          throw new Error(`session not found: ${resumeSessionId}`)
        }
        resumed.push(resumeSessionId)
        const handle = makeHandle(resumeSessionId)
        live.set(resumeSessionId, handle)
        return handle
      },
      get(sessionId: string) {
        return live.get(sessionId)?.agent
      },
    },
  }
}

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
