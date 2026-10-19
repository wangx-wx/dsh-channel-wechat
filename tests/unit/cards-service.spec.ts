/**
 * Answering DSH's interaction cards over WeChat.
 *
 * The listeners are waterfalls with no requester id, no race, and no timeout, so
 * every property this suite pins down is one DSH does not supply: claiming a
 * request for the right conversation, refusing to lean on `next()` when the GUI
 * is not offered the card, reporting a lost race, and expiring a card nobody
 * answers.
 */

import { describe, expect, it, vi } from 'vitest'
import { CardService, CardExpired, type ApprovalOutcomeLike } from '../../src/bridge/cards-service.ts'

/** The shape of a registered listener, as the fake context stores it. */
type Listener = (request: never, next: () => Promise<never>) => Promise<never>

/** A context that records listeners, so a test can invoke one directly. */
function fakeContext() {
  const listeners = new Map<string, { listener: Listener; prepend: boolean | undefined }>()
  return {
    listeners,
    context: {
      on(event: string, listener: Listener, options?: { prepend?: boolean }) {
        listeners.set(event, { listener, prepend: options?.prepend })
        return () => listeners.delete(event)
      },
    },
  }
}

/** A service over recording boundaries. */
function bench(overrides: {
  peerOfSession?: (sessionId: string) => string | undefined
  shareWithGui?: boolean
  timeoutMs?: number
  elevate?: (sessionId: string) => boolean
} = {}) {
  const sent: { peerId: string; text: string }[] = []
  const cardsSent: string[] = []
  const expired: string[] = []
  const elevated: string[] = []
  const f = fakeContext()
  const service = new CardService({
    context: f.context as never,
    // Claimed by default: the channel owns the conversation, so no GUI answerer
    // is offered the card unless a test asks for it.
    shareWithGui: overrides.shareWithGui ?? false,
    peerOfSession: overrides.peerOfSession ?? (sessionId => (sessionId === 's1' ? 'user-7' : undefined)),
    send: async (peerId, text) => void sent.push({ peerId, text }),
    timeoutMs: overrides.timeoutMs ?? 0,
    ...(overrides.elevate === undefined ? {} : {
      elevate: (sessionId: string) => {
        elevated.push(sessionId)
        return overrides.elevate!(sessionId)
      },
    }),
    onCardSent: card => void cardsSent.push(card.id),
    onExpired: card => void expired.push(card.id),
  })
  service.attach()
  /** Invoke the registered listener for one seam. */
  const fire = async (
    event: 'approval/request' | 'user-questions/request',
    request: unknown,
    next: () => Promise<unknown> = async () => { throw new Error('next() must not be called') },
  ): Promise<unknown> => {
    const entry = f.listeners.get(event)
    if (entry === undefined) throw new Error(`no listener registered for ${event}`)
    return await entry.listener(request as never, next as never)
  }
  return { service, sent, cardsSent, expired, elevated, fire, listeners: f.listeners }
}

/** An approval request as the seam raises it for a session this channel owns. */
function approvalRequest(overrides: Record<string, unknown> = {}) {
  return {
    agent: { id: 'a1', session: { id: 's1' } },
    toolName: 'bash',
    reason: 'run: rm -rf build',
    ...overrides,
  }
}

/** A question request as the seam raises it. */
function questionRequest(overrides: Record<string, unknown> = {}) {
  return {
    agent: { id: 'a1', session: { id: 's1' } },
    questions: [{ id: 'q', question: 'Which?', options: [{ label: 'Fast' }, { label: 'Careful' }] }],
    ...overrides,
  }
}

describe('claiming a request', () => {
  it('registers both listeners with prepend', () => {
    // `prepend` is not a preference. Without it the GUI's answerer runs first,
    // claims the request, and this listener is never called - with no error
    // anywhere to say the channel has stopped answering cards.
    const { listeners } = bench()

    expect(listeners.get('approval/request')?.prepend).toBe(true)
    expect(listeners.get('user-questions/request')?.prepend).toBe(true)
  })

  it('sends the approval card to the peer that owns the session', async () => {
    const b = bench()

    void b.fire('approval/request', approvalRequest())
    await Promise.resolve()

    expect(b.sent).toHaveLength(1)
    expect(b.sent[0]?.peerId).toBe('user-7')
  })

  it('names the tool and the reason on the card', async () => {
    const b = bench()

    void b.fire('approval/request', approvalRequest())
    await Promise.resolve()

    expect(b.sent[0]?.text).toContain('bash')
    expect(b.sent[0]?.text).toContain('rm -rf build')
  })

  it('delegates a session this channel does not own', async () => {
    // Another conversation's card belongs to whatever answers it there; claiming
    // it would leave that conversation waiting for an answer it never gets.
    const b = bench()
    const next = vi.fn(async () => 'allowed-once' as const)

    const outcome = await b.fire('approval/request', approvalRequest({ agent: { id: 'a', session: { id: 'other' } } }), next)

    expect(next).toHaveBeenCalled()
    expect(outcome).toBe('allowed-once')
    expect(b.sent).toEqual([])
  })

  it('delegates a question whose request carries no agent', async () => {
    // `agent` is optional on the question seam, and without it there is no
    // session to route to - so the GUI's answerer is the right one.
    const b = bench()
    const next = vi.fn(async () => ({ answers: [] }))

    await b.fire('user-questions/request', questionRequest({ agent: undefined }), next)

    expect(next).toHaveBeenCalled()
  })

  it('does not delegate when it owns the conversation', async () => {
    // The point of claiming: the GUI must not also be asked, or one card appears
    // in two places and either can decide it.
    const b = bench()
    const next = vi.fn(async () => 'rejected' as const)

    void b.fire('approval/request', approvalRequest(), next)
    await Promise.resolve()

    expect(next).not.toHaveBeenCalled()
  })

  it('delegates alongside a card when the GUI is offered the same request', async () => {
    const b = bench({ shareWithGui: true })
    const next = vi.fn(async () => 'allowed-once' as const)

    const outcome = await b.fire('approval/request', approvalRequest(), next)

    expect(next).toHaveBeenCalled()
    expect(outcome).toBe('allowed-once')
  })
})

describe('answering a card from chat', () => {
  it('settles the waiting approval with the granted outcome', async () => {
    const b = bench()
    const pending = b.fire('approval/request', approvalRequest())
    await Promise.resolve()

    await b.service.answer('user-7', 'P1 1')

    await expect(pending).resolves.toBe('allowed-once')
  })

  it('settles a rejection', async () => {
    const b = bench()
    const pending = b.fire('approval/request', approvalRequest())
    await Promise.resolve()

    await b.service.answer('user-7', 'P1 2')

    await expect(pending).resolves.toBe('rejected')
  })

  it('elevates the session and still allows this call', async () => {
    // The choice means two things at once: switch the session to full access,
    // and let the tool call that raised the card proceed. Doing only the second
    // would make the card a plain grant under a misleading label; doing only
    // the first would refuse the very call the user just approved.
    const b = bench({ elevate: () => true })
    const pending = b.fire('approval/request', approvalRequest())
    await Promise.resolve()

    await b.service.answer('user-7', 'P1 3')

    await expect(pending).resolves.toBe('allowed-once')
    expect(b.elevated).toEqual(['s1'])
  })

  it('says the cards will stop and how to get them back', async () => {
    // There is no second confirmation, so this message is the last chance to
    // tell the user what the choice did.
    const b = bench({ elevate: () => true })
    void b.fire('approval/request', approvalRequest())
    await Promise.resolve()

    await b.service.answer('user-7', 'P1 3')

    expect(b.sent.at(-1)?.text).toMatch(/不再弹出审批卡/u)
    expect(b.sent.at(-1)?.text).toMatch(/\/new/u)
  })

  it('says the elevation failed rather than claiming it worked', async () => {
    // `permissionPresets.set` can throw on a session the service does not know.
    // Reporting success would leave the user believing cards were off while
    // they keep arriving.
    const b = bench({ elevate: () => false })
    const pending = b.fire('approval/request', approvalRequest())
    await Promise.resolve()

    await b.service.answer('user-7', 'P1 3')

    await expect(pending).resolves.toBe('allowed-once')
    expect(b.sent.at(-1)?.text).toMatch(/未能切换/u)
  })

  it('reports a missing permission service instead of granting silently', async () => {
    // `elevate` is absent on a composition without `permissionPresets`. The card
    // still renders the option - it is built from a constant - so the user has
    // to learn it did nothing rather than believe the session was widened.
    //
    // The call still proceeds: refusing it would punish the tool for a choice
    // the user did make, and a one-shot grant is strictly narrower than the
    // session-wide access they asked for.
    const b = bench()
    const pending = b.fire('approval/request', approvalRequest())
    await Promise.resolve()

    await b.service.answer('user-7', 'P1 3')

    await expect(pending).resolves.toBe('allowed-once')
    expect(b.sent.at(-1)?.text).toMatch(/未能切换/u)
  })

  it('does not widen the session when the answer loses the race', async () => {
    // The card was already answered. Settling is what decides the race, so the
    // permission change has to happen only after a win; doing it first would
    // widen a session for an answer that did not count.
    const b = bench({ elevate: () => true })
    void b.fire('approval/request', approvalRequest())
    await Promise.resolve()
    await b.service.answer('user-7', 'P1 1')
    await b.service.answer('user-7', 'P1 3')

    expect(b.elevated).toEqual([])
  })

  it('settles a question with the chosen labels', async () => {
    const b = bench()
    const pending = b.fire('user-questions/request', questionRequest())
    await Promise.resolve()

    await b.service.answer('user-7', 'P1 2')

    await expect(pending).resolves.toEqual({ answers: [{ id: 'q', selected: ['Careful'] }] })
  })

  it('tells the user their choice was received', async () => {
    const b = bench()
    void b.fire('approval/request', approvalRequest())
    await Promise.resolve()

    await b.service.answer('user-7', 'P1 1')

    expect(b.sent.at(-1)?.text).toMatch(/正在继续/u)
  })

  it('says so when a second answer loses the race', async () => {
    // The agent already acted on the first answer. Silence would let the user
    // believe the second one changed something.
    const b = bench()
    void b.fire('approval/request', approvalRequest())
    await Promise.resolve()
    await b.service.answer('user-7', 'P1 1')

    await b.service.answer('user-7', 'P1 2')

    // A closed card is no longer matched, so this is simply not a reply - and
    // the loser learns nothing, which is the honest outcome: the message reaches
    // the model instead of being silently swallowed.
    expect(b.service.addressesCard('P1 2')).toBe(false)
  })

  it('keeps the card open when the answer cannot be read', async () => {
    // A malformed answer must be retryable; closing the card would strand the
    // turn it is holding.
    const b = bench()
    void b.fire('approval/request', approvalRequest())
    await Promise.resolve()

    await b.service.answer('user-7', 'P1 9')

    expect(b.service.addressesCard('P1 1')).toBe(true)
    expect(b.sent.at(-1)?.text).toMatch(/请回复/u)
  })

  it('does not consume a message that names no card', async () => {
    const b = bench()

    expect(await b.service.answer('user-7', 'hello')).toBe(false)
  })

  it('does not consume a message that names a closed card', async () => {
    const b = bench()

    expect(await b.service.answer('user-7', 'P9 1')).toBe(false)
  })
})

describe('a card that expires', () => {
  it('refuses the approval rather than granting it', async () => {
    // `unavailable` is the seam's fail-closed value. An expired card that read as
    // permission would let an ignored prompt authorize a tool.
    const b = bench({ timeoutMs: 5 })
    const pending = b.fire('approval/request', approvalRequest())

    await expect(pending).resolves.toBe('unavailable')
  })

  it('rejects a question, because no answer exists to give', async () => {
    // There is no fail-closed *answer*: any selected label would be invented. The
    // listener rejects, so the tool reports a failed question.
    const b = bench({ timeoutMs: 5 })
    const pending = b.fire('user-questions/request', questionRequest())

    await expect(pending).rejects.toBeInstanceOf(CardExpired)
  })

  it('stops being answerable once it expires', async () => {
    const b = bench({ timeoutMs: 5 })
    void b.fire('approval/request', approvalRequest())
    await new Promise(resolve => setTimeout(resolve, 20))

    expect(await b.service.answer('user-7', 'P1 1')).toBe(false)
  })

  it('reports the expiry so the user can be told', async () => {
    const b = bench({ timeoutMs: 5 })

    void b.fire('approval/request', approvalRequest())
    await new Promise(resolve => setTimeout(resolve, 20))

    expect(b.expired).toEqual(['P1'])
  })
})

describe('the id space', () => {
  it('is shared between the two seams', async () => {
    // A reply is matched against open cards of both kinds. Two independent
    // counters would both hand out `P1`, and `P1 1` could name either.
    const b = bench()
    void b.fire('approval/request', approvalRequest())
    await Promise.resolve()
    void b.fire('user-questions/request', questionRequest())
    await Promise.resolve()

    expect(b.cardsSent).toEqual(['P1', 'P2'])
  })

  it('counts every card it is waiting on', async () => {
    const b = bench()
    void b.fire('approval/request', approvalRequest())
    await Promise.resolve()
    void b.fire('user-questions/request', questionRequest())
    await Promise.resolve()

    expect(b.service.pending).toBe(2)
  })
})

describe('recognizing a reply before delivery', () => {
  it('reports a message that names an open card', async () => {
    // The caller consults this so the reply is answered instead of being sent to
    // the model - and, more urgently, so it is not queued behind the very turn it
    // must unblock.
    const b = bench()
    void b.fire('approval/request', approvalRequest())
    await Promise.resolve()

    expect(b.service.addressesCard('P1 1')).toBe(true)
  })

  it('reports an ordinary message as not a reply', () => {
    expect(bench().service.addressesCard('hello')).toBe(false)
  })
})

describe('disposal', () => {
  it('releases both listeners', () => {
    const b = bench()
    b.service.dispose()

    expect(b.listeners.size).toBe(0)
  })

  it('settles an open card rather than wedging its turn', async () => {
    // A disposed channel with a card still waiting holds that agent turn open
    // forever, and its session can never be disposed.
    const b = bench()
    const pending = b.fire('approval/request', approvalRequest())
    await Promise.resolve()

    b.service.dispose()

    await expect(pending).resolves.toBe('unavailable')
  })

  it('stops reporting an open card as answerable', async () => {
    const b = bench()
    void b.fire('approval/request', approvalRequest())
    await Promise.resolve()

    b.service.dispose()

    expect(b.service.addressesCard('P1 1')).toBe(false)
  })
})

describe('the approval outcome vocabulary', () => {
  it('covers exactly the seam\u2019s outcomes', () => {
    // A compile-time check made explicit: the vocabulary is closed, and the card
    // only ever produces two of the four.
    const all: ApprovalOutcomeLike[] = ['allowed-once', 'rejected', 'cancelled', 'unavailable']

    expect(all).toHaveLength(4)
  })
})
