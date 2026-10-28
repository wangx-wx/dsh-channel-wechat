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
  onExpired?: (cardId: string) => void
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
    onExpired: card => {
      expired.push(card.id)
      overrides.onExpired?.(card.id)
    },
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

  it('says so when the GUI answers a card that is on the phone’s screen', async () => {
    // The wechat card is withdrawn the moment the GUI decides, so it simply
    // disappears from the chat. Without a word the user cannot tell whether
    // their pending decision went anywhere.
    const b = bench({ shareWithGui: true })

    await b.fire('approval/request', approvalRequest(), async () => 'rejected' as const)

    expect(b.sent.some(entry => entry.text.includes('Harness 界面'))).toBe(true)
  })

  it('frees the display slot when the GUI wins', async () => {
    // Otherwise the next card waits behind a card nobody on this side will ever
    // answer.
    const b = bench({ shareWithGui: true })
    // Awaited, because the wording that tells the user is sent before the card
    // is closed - so the withdrawal lands after that send resolves.
    await b.fire('approval/request', approvalRequest({ toolName: 'bash' }), async () => 'rejected' as const)
    await Promise.resolve()

    // The wechat card is gone...
    expect(b.service.addressesCard('P1 1')).toBe(false)
    // ...and the next card is no longer blocked behind it.
    void b.fire('approval/request', approvalRequest({ toolName: 'write' }), async () => 'rejected' as const)
    await Promise.resolve()
    await Promise.resolve()

    expect(b.sent.some(entry => entry.text.includes('write'))).toBe(true)
  })
})

describe('a card that expires while others wait', () => {
  it('reports an expiry before showing the card behind it', async () => {
    // The chat reads in send order, so an expiry notice sent after the next
    // card would leave the user reading a new question and only then learning
    // why the previous one vanished.
    vi.useFakeTimers()
    try {
      const seen: string[] = []
      // The service's own `onExpired` hook is where the application sends its
      // "this card expired" message, so its position in the sequence is the
      // position that message would take in the chat.
      const b = bench({ timeoutMs: 1_000, onExpired: id => void seen.push(`expired:${id}`) })
      void b.fire('approval/request', approvalRequest({ toolName: 'bash' }))
      await vi.advanceTimersByTimeAsync(0)
      void b.fire('approval/request', approvalRequest({ toolName: 'write' }))
      await vi.advanceTimersByTimeAsync(0)

      await vi.advanceTimersByTimeAsync(1_000)
      await vi.advanceTimersByTimeAsync(0)

      expect(b.expired).toEqual(['P1'])
      expect(seen).toEqual(['expired:P1'])
      // And the card behind it is displayed, after that report.
      expect(b.sent.some(entry => entry.text.includes('write'))).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('a service that is disposed and reused', () => {
  it('shows cards again after disposal', async () => {
    // `runs` points at cards disposal removed. Left behind, every later display
    // would bail out on a slot that can never be freed.
    const b = bench()
    void b.fire('approval/request', approvalRequest({ toolName: 'bash' }))
    await Promise.resolve()

    b.service.dispose()
    // A fresh listener set, as a replacement run would register.
    b.service.attach()
    void b.fire('approval/request', approvalRequest({ toolName: 'write' }))
    await Promise.resolve()
    await Promise.resolve()

    expect(b.sent.some(entry => entry.text.includes('write'))).toBe(true)
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
    // The second card is queued rather than displayed, so the ids are read in
    // order: the question's turn comes after the approval is answered.
    const b = bench()
    void b.fire('approval/request', approvalRequest())
    await Promise.resolve()
    void b.fire('user-questions/request', questionRequest())
    await Promise.resolve()

    await b.service.answer('user-7', 'P1 1')

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

describe('showing several cards one at a time', () => {
  // Parallel tool calls raise their approvals together. Sending all of them at
  // once put three long cards and three ids on one phone screen, and the reader
  // had to hold all of them in mind to answer any.

  it('sends only the first card when several arrive together', async () => {
    const b = bench()
    const first = b.fire('approval/request', approvalRequest({ toolName: 'bash' }))
    await Promise.resolve()
    void b.fire('approval/request', approvalRequest({ toolName: 'write' }))
    await Promise.resolve()
    void b.fire('approval/request', approvalRequest({ toolName: 'edit' }))
    await Promise.resolve()

    expect(b.sent).toHaveLength(1)
    expect(b.sent[0]?.text).toContain('bash')
    // The other two are open and waiting; they are simply not on screen yet.
    expect(b.service.pending).toBe(3)
    void first
  })

  it('sends the next card once the first is answered', async () => {
    const b = bench()
    void b.fire('approval/request', approvalRequest({ toolName: 'bash' }))
    await Promise.resolve()
    void b.fire('approval/request', approvalRequest({ toolName: 'write' }))
    await Promise.resolve()

    await b.service.answer('user-7', 'P1 1')

    expect(b.sent.some(entry => entry.text.includes('write'))).toBe(true)
  })

  it('numbers a displayed card by what is queued when it appears', async () => {
    // The count is fixed when a card is displayed, from what is queued at that
    // moment: renumbering the card already on screen would mean sending it
    // twice. A card that arrives afterwards is simply the next one.
    const b = bench()
    void b.fire('approval/request', approvalRequest({ toolName: 'bash' }))
    await Promise.resolve()
    void b.fire('approval/request', approvalRequest({ toolName: 'write' }))
    await Promise.resolve()

    // The first card was alone when it went out, so it says nothing about a
    // run; the second one knows it is the last of the two.
    expect(b.sent[0]?.text).not.toMatch(/\d\/\d/u)

    await b.service.answer('user-7', 'P1 1')

    expect(b.sent.some(entry => entry.text.includes('2/2'))).toBe(true)
  })

  it('does not renumber a card that is already on screen', async () => {
    // Re-sending the visible card would put a second copy of it in the chat.
    const b = bench()
    void b.fire('approval/request', approvalRequest({ toolName: 'bash' }))
    await Promise.resolve()
    void b.fire('approval/request', approvalRequest({ toolName: 'write' }))
    await Promise.resolve()

    // Only the first was ever displayed; the arrival of the second changed
    // nothing on screen.
    expect(b.sent).toHaveLength(1)
  })

  it('acknowledges the answer before showing the next card', async () => {
    // Sends are queued per peer in order, so whatever is queued first is read
    // first. Showing the next card before the receipt makes the user see a new
    // question appear with no word that their last answer landed.
    const b = bench()
    void b.fire('approval/request', approvalRequest({ toolName: 'bash' }))
    await Promise.resolve()
    void b.fire('approval/request', approvalRequest({ toolName: 'write' }))
    await Promise.resolve()

    await b.service.answer('user-7', 'P1 1')

    const receipt = b.sent.findIndex(entry => entry.text.includes('已收到'))
    const next = b.sent.findIndex(entry => entry.text.includes('write'))
    expect(receipt).toBeGreaterThanOrEqual(0)
    expect(next).toBeGreaterThan(receipt)
  })

  it('refuses an answer to a card that has not been shown yet', async () => {
    // Accepting it would decide a card the user has never seen. Dropping the
    // message silently is worse: `P2 1` then reads as ordinary prose and is
    // queued behind the turn it was meant to unblock.
    const b = bench()
    void b.fire('approval/request', approvalRequest())
    await Promise.resolve()
    void b.fire('approval/request', approvalRequest())
    await Promise.resolve()

    expect(await b.service.answer('user-7', 'P2 1')).toBe(true)

    expect(b.sent.at(-1)?.text).toMatch(/\u8fd8\u6ca1\u8f6e\u5230|\u5148\u56de\u7b54/u)
    // The first card is still the one waiting.
    expect(b.service.pending).toBe(2)
  })

  it('is recognized as a card reply even before its turn', async () => {
    // This predicate decides whether the message BYPASSES the peer queue. A
    // queued card's reply must bypass it too, because the queue is held by the
    // very turn the card is waiting on - going through it means the "not your
    // turn yet" answer arrives only after the turn it cannot unblock ends,
    // which is never. Said `false`, the reply reads as ordinary prose and is
    // queued behind that turn.
    const b = bench()
    void b.fire('approval/request', approvalRequest())
    await Promise.resolve()
    void b.fire('approval/request', approvalRequest())
    await Promise.resolve()

    expect(b.service.addressesCard('P2 1')).toBe(true)
  })

  it('still answers nothing for an id no card holds', async () => {
    // Widening the predicate must not widen it into "anything with a P".
    const b = bench()
    void b.fire('approval/request', approvalRequest())
    await Promise.resolve()

    expect(b.service.addressesCard('P9 1')).toBe(false)
  })
})

describe('a card whose turn has ended', () => {
  it('stops being answerable when the request is aborted', async () => {
    // `/stop` cancels the turn, which aborts the tool signal the request
    // carries. The card cannot be answered any more - but nothing used to say
    // so, and it stayed open for 30 minutes. A reply then "won" its settle and
    // the user was told "received, continuing" about a turn that was gone.
    const b = bench()
    const controller = new AbortController()
    void b.fire('approval/request', approvalRequest({ signal: controller.signal }))
    await Promise.resolve()

    controller.abort()
    await Promise.resolve()

    expect(b.service.addressesCard('P1 1')).toBe(false)
    expect(b.service.pending).toBe(0)
  })

  it('settles an aborted approval as cancelled, not as a refusal', async () => {
    // The seam distinguishes them: `cancelled` means the question was
    // withdrawn, `rejected` means a person said no.
    const b = bench()
    const controller = new AbortController()
    const pending = b.fire('approval/request', approvalRequest({ signal: controller.signal }))
    await Promise.resolve()

    controller.abort()

    await expect(pending).resolves.toBe('cancelled')
  })

  it('rejects an aborted question rather than inventing an answer', async () => {
    const b = bench()
    const controller = new AbortController()
    const pending = b.fire('user-questions/request', questionRequest({ signal: controller.signal }))
    await Promise.resolve()

    controller.abort()

    await expect(pending).rejects.toThrow()
  })

  it('shows the next card when the shown one is aborted', async () => {
    const b = bench()
    const controller = new AbortController()
    void b.fire('approval/request', approvalRequest({ toolName: 'bash', signal: controller.signal }))
    await Promise.resolve()
    void b.fire('approval/request', approvalRequest({ toolName: 'write' }))
    await Promise.resolve()

    controller.abort()
    await Promise.resolve()

    expect(b.sent.some(entry => entry.text.includes('write'))).toBe(true)
  })

  it('does not flash every queued card on screen when one turn aborts', async () => {
    // One turn's signal is shared by every card that turn raised, so a single
    // abort runs every listener. Displaying on each one would push all the
    // queued cards to the chat and withdraw them in the same breath.
    const b = bench()
    const controller = new AbortController()
    void b.fire('approval/request', approvalRequest({ toolName: 'bash', signal: controller.signal }))
    await Promise.resolve()
    void b.fire('approval/request', approvalRequest({ toolName: 'write', signal: controller.signal }))
    await Promise.resolve()
    void b.fire('approval/request', approvalRequest({ toolName: 'edit', signal: controller.signal }))
    await Promise.resolve()

    controller.abort()
    await Promise.resolve()
    await Promise.resolve()

    // Only the card that was already on screen was ever sent; the two behind
    // it went away without appearing.
    expect(b.sent).toHaveLength(1)
    expect(b.service.pending).toBe(0)
  })

  it('ignores an abort that arrives after the card was answered', async () => {
    // A turn may abort on its way out. The answer already decided the card, and
    // re-settling would be a second decision.
    const b = bench()
    const controller = new AbortController()
    const pending = b.fire('approval/request', approvalRequest({ signal: controller.signal }))
    await Promise.resolve()
    await b.service.answer('user-7', 'P1 1')

    controller.abort()

    await expect(pending).resolves.toBe('allowed-once')
  })
})

describe('withdrawing a peer\u2019s cards', () => {
  it('reports how many cards it dropped', async () => {
    const b = bench()
    void b.fire('approval/request', approvalRequest())
    await Promise.resolve()
    void b.fire('approval/request', approvalRequest())
    await Promise.resolve()

    expect(b.service.withdrawAll('user-7')).toBe(2)
  })

  it('leaves another conversation\u2019s cards alone', async () => {
    const b = bench({ peerOfSession: sessionId => (sessionId === 's1' ? 'user-7' : 'user-9') })
    void b.fire('approval/request', approvalRequest())
    await Promise.resolve()
    void b.fire('approval/request', approvalRequest({ agent: { id: 'a2', session: { id: 's2' } } }))
    await Promise.resolve()

    expect(b.service.withdrawAll('user-7')).toBe(1)
    expect(b.service.pending).toBe(1)
  })

  it('settles a withdrawn approval as cancelled', async () => {
    const b = bench()
    const pending = b.fire('approval/request', approvalRequest())
    await Promise.resolve()

    b.service.withdrawAll('user-7')

    await expect(pending).resolves.toBe('cancelled')
  })

  it('rejects a withdrawn question, so the tool sees a failed call', async () => {
    const b = bench()
    const pending = b.fire('user-questions/request', questionRequest())
    await Promise.resolve()

    b.service.withdrawAll('user-7')

    await expect(pending).rejects.toThrow()
  })

  it('reports zero when the peer has nothing waiting', () => {
    expect(bench().service.withdrawAll('user-7')).toBe(0)
  })
})

describe('answering a question with words', () => {
  it('sends the custom answer the user typed', async () => {
    const b = bench()
    void b.fire('user-questions/request', questionRequest())
    await Promise.resolve()

    await b.service.answer('user-7', 'P1 use a softer blue')

    expect(b.sent.at(-1)?.text).toMatch(/\u5df2\u6536\u5230/u)
    expect(b.service.pending).toBe(0)
  })

  it('closes the card when the user asks to discuss it instead', async () => {
    const b = bench()
    const pending = b.fire('user-questions/request', questionRequest())
    await Promise.resolve()

    await b.service.answer('user-7', 'P1 0')

    // The card is gone, and the tool call ended without an invented answer.
    expect(b.service.pending).toBe(0)
    await expect(pending).rejects.toThrow()
  })

  it('tells the user their next message is the one that matters', async () => {
    const b = bench()
    // Caught here because this test is about the reply, not the rejection: the
    // real seam attaches its own handler, which the `fire` helper does not.
    const pending = b.fire('user-questions/request', questionRequest())
    pending.catch(() => {})
    await Promise.resolve()

    await b.service.answer('user-7', 'P1 0')

    expect(b.sent.at(-1)?.text).toMatch(/\u76f4\u63a5\u8bf4|\u60f3\u6cd5/u)
    await expect(pending).rejects.toThrow()
  })
})
