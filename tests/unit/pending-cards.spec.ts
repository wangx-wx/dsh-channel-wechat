/**
 * The open cards for one channel run.
 *
 * DSH's seams give a channel none of this: they do not race two answerers, do
 * not expire a request, and do not tell a late answerer it lost. Every one of
 * those gaps fails silently in production - a lost race looks like a decision
 * that was never made, an expiry that never fires holds its turn open forever -
 * so each is a property this suite pins down.
 */

import { describe, expect, it, vi } from 'vitest'
import { PendingCards, type PendingCard } from '../../src/bridge/pending-cards.ts'

/** A card body without its id, as a caller offers one. */
function body(overrides: Partial<Omit<PendingCard, 'id'>> = {}): Omit<PendingCard, 'id'> {
  return { kind: 'approval', peerId: 'user-7', sessionId: 's', toolName: 'bash', questions: [], ...overrides }
}

/** A registry over a controllable clock. */
function bench(overrides: { timeoutMs?: number } = {}) {
  const expired: string[] = []
  const unmatched: string[] = []
  /** Timers scheduled through the injected scheduler, by card. */
  const timers = new Map<ReturnType<typeof setTimeout>, () => void>()
  let nextHandle = 1
  const cards = new PendingCards<string>({
    timeoutMs: overrides.timeoutMs ?? 0,
    onTimeout: () => 'unavailable',
    onExpired: card => void expired.push(card.id),
    onUnmatched: (cardId, peerId) => void unmatched.push(`${cardId}:${peerId}`),
    schedule: (work) => {
      const handle = nextHandle++ as unknown as ReturnType<typeof setTimeout>
      timers.set(handle, work)
      return handle
    },
    cancelSchedule: handle => void timers.delete(handle),
  })
  /** Fire the scheduled expiry for one card, as a timer would. */
  const fire = (): void => {
    const [, work] = [...timers.entries()][0] ?? []
    work?.()
  }
  return { cards, expired, unmatched, timers, fire }
}

describe('offering a card', () => {
  it('gives each card an id the user can type', () => {
    const b = bench()

    const first = b.cards.offer(body())
    const second = b.cards.offer(body())

    expect(first.card.id).toBe('P1')
    expect(second.card.id).toBe('P2')
  })

  it('reports a card as open once it is offered', () => {
    const b = bench()

    const { card } = b.cards.offer(body())

    expect(b.cards.isOpen(card.id)).toBe(true)
  })

  it('reports an id that was never offered as not open', () => {
    // This is what keeps `P9 1` from being read as an answer.
    expect(bench().cards.isOpen('P9')).toBe(false)
  })

  it('returns the card so the caller can render it', () => {
    const b = bench()

    const { card } = b.cards.offer(body({ toolName: 'write' }))

    expect(card.toolName).toBe('write')
    expect(card.peerId).toBe('user-7')
  })

  it('counts the cards still waiting', () => {
    const b = bench()

    b.cards.offer(body())
    b.cards.offer(body())

    expect(b.cards.size).toBe(2)
  })

  it('carries the questions a question card was offered with', () => {
    const b = bench()
    const questions = [{ id: 'q', question: 'Which?' }]

    const { card } = b.cards.offer(body({ kind: 'question', questions }))

    expect(card.questions).toEqual(questions)
  })
})

describe('answering a card', () => {
  it('settles the waiting listener with the answer', async () => {
    const b = bench()
    const { card, settled } = b.cards.offer(body())

    b.cards.settle(card.id, 'user-7', 'allowed-once')

    await expect(settled).resolves.toBe('allowed-once')
  })

  it('lets the first answer win', async () => {
    // Two places can answer: the chat and, when they are both offered, the GUI.
    // Only one may resolve the listener, or the agent acts on two decisions.
    const b = bench()
    const { card, settled } = b.cards.offer(body())

    expect(b.cards.settle(card.id, 'user-7', 'allowed-once')).toBe(true)
    expect(b.cards.settle(card.id, 'user-7', 'rejected')).toBe(false)
    await expect(settled).resolves.toBe('allowed-once')
  })

  it('reports a second answer rather than pretending it counted', async () => {
    // The user's answer was not the one acted on, and saying nothing would let
    // them believe it was.
    const b = bench()
    const { card } = b.cards.offer(body())
    b.cards.settle(card.id, 'user-7', 'allowed-once')

    b.cards.settle(card.id, 'user-7', 'rejected')

    expect(b.unmatched).toEqual(['P1:user-7'])
  })

  it('closes the card once it is answered', () => {
    const b = bench()
    const { card } = b.cards.offer(body())

    b.cards.settle(card.id, 'user-7', 'allowed-once')

    expect(b.cards.isOpen(card.id)).toBe(false)
    expect(b.cards.size).toBe(0)
  })

  it('refuses an answer from a different conversation', async () => {
    // A card belongs to the peer it was sent to. Another peer naming the id is
    // guessing, and letting it win would let one user decide another's tool call.
    const b = bench()
    const { card, settled } = b.cards.offer(body({ peerId: 'user-7' }))

    expect(b.cards.settle(card.id, 'user-8', 'allowed-once')).toBe(false)
    expect(b.cards.isOpen(card.id)).toBe(true)
    b.cards.settle(card.id, 'user-7', 'rejected')
    await expect(settled).resolves.toBe('rejected')
  })

  it('reports an answer that names no open card', () => {
    const b = bench()

    b.cards.settle('P9', 'user-7', 'allowed-once')

    expect(b.unmatched).toEqual(['P9:user-7'])
  })

  it('stops an answered card\u2019s timer from firing later', async () => {
    // A timer that outlives its card would resolve an already-settled promise,
    // and the user would be told a card expired after they answered it.
    const b = bench({ timeoutMs: 1_000 })
    const { card } = b.cards.offer(body())
    b.cards.settle(card.id, 'user-7', 'allowed-once')

    expect(b.timers.size).toBe(0)
    b.fire()

    expect(b.expired).toEqual([])
  })
})

describe('a card nobody answers', () => {
  it('is withdrawn when its deadline passes', async () => {
    // The seam has no timeout, so without this an unanswered card holds its turn
    // open for the life of the process - which is exactly the hang a channel
    // without card support produces.
    const b = bench({ timeoutMs: 1_000 })
    const { card, settled } = b.cards.offer(body())

    b.fire()

    expect(b.cards.isOpen(card.id)).toBe(false)
    await expect(settled).resolves.toBe('unavailable')
  })

  it('tells the user the card expired', () => {
    const b = bench({ timeoutMs: 1_000 })
    b.cards.offer(body())

    b.fire()

    expect(b.expired).toEqual(['P1'])
  })

  it('settles an expired card closed rather than granting it', () => {
    // `unavailable` is the seam's own fail-closed answer; anything that read as
    // permission would let an ignored card authorize a tool.
    const b = new PendingCards<string>({ timeoutMs: 1_000, onTimeout: () => 'unavailable' })
    const { settled } = b.offer(body())

    return expect(settled).resolves.toBe('unavailable')
  })

  it('rejects instead of hanging when the policy refuses to answer', async () => {
    // A timeout policy that throws (a question seam has no valid no-answer
    // value) must reject the waiter. Letting the throw escape into the timer
    // would leave the promise pending forever - the very hang this class exists
    // to prevent.
    const cards = new PendingCards<string>({
      timeoutMs: 1_000,
      onTimeout: () => { throw new Error('no answer exists') },
    })

    const { settled } = cards.offer(body())
    cards.disposeAll()

    await expect(settled).rejects.toThrow('no answer exists')
  })

  it('never sets a timer when expiry is disabled', () => {
    // A channel may prefer to leave a card open, and that has to be expressible.
    const b = bench({ timeoutMs: 0 })

    b.cards.offer(body())

    expect(b.timers.size).toBe(0)
  })
})

describe('stopping the channel', () => {
  it('settles every open card instead of abandoning it', async () => {
    // Each waiting card is inside a turn. Dropping the promise wedges that turn
    // exactly as an unanswered card does, so disposal has to answer.
    const b = bench()
    const first = b.cards.offer(body())
    const second = b.cards.offer(body())

    b.cards.disposeAll()

    await expect(first.settled).resolves.toBe('unavailable')
    await expect(second.settled).resolves.toBe('unavailable')
  })

  it('leaves no card open afterwards', () => {
    const b = bench()
    b.cards.offer(body())

    b.cards.disposeAll()

    expect(b.cards.size).toBe(0)
  })

  it('cancels the timers of the cards it settled', () => {
    // Otherwise a stopped channel's timers fire later and try to expire cards
    // that belong to a run that is gone.
    const b = bench({ timeoutMs: 1_000 })
    b.cards.offer(body())
    b.cards.offer(body())

    b.cards.disposeAll()

    expect(b.timers.size).toBe(0)
  })

  it('does not report a disposed card as a lost race', () => {
    // Disposal is the channel stopping, not another answerer winning; telling
    // the user their answer lost would be a lie.
    const b = bench()
    const { card } = b.cards.offer(body())
    b.cards.disposeAll()

    b.cards.settle(card.id, 'user-7', 'allowed-once')

    expect(b.unmatched).toEqual(['P1:user-7'])
  })

  it('can be used again after disposal', () => {
    // A channel run is replaced on reconnect, and the registry is owned by the
    // run rather than the process.
    const b = bench()
    b.cards.offer(body())
    b.cards.disposeAll()

    const { card } = b.cards.offer(body())

    expect(b.cards.isOpen(card.id)).toBe(true)
  })
})

describe('the card a reply names', () => {
  it('is readable while it is open', () => {
    const b = bench()
    const { card } = b.cards.offer(body({ toolName: 'write' }))

    expect(b.cards.get(card.id)?.toolName).toBe('write')
  })

  it('reports the peer it was sent to, so a reply can be attributed', () => {
    const b = bench()
    const { card } = b.cards.offer(body({ peerId: 'user-9' }))

    expect(b.cards.peerOf(card.id)).toBe('user-9')
  })

  it('is gone once answered', () => {
    const b = bench()
    const { card } = b.cards.offer(body())
    b.cards.settle(card.id, 'user-7', 'allowed-once')

    expect(b.cards.get(card.id)).toBeUndefined()
  })
})

describe('scheduling', () => {
  it('uses the injected clock rather than the real one', () => {
    // The timeout is minutes long in production, so the suite must not wait for
    // it - and this is what proves it does not.
    const schedule = vi.fn(() => 1 as unknown as ReturnType<typeof setTimeout>)
    const cards = new PendingCards<string>({
      timeoutMs: 30 * 60 * 1_000,
      onTimeout: () => 'unavailable',
      schedule,
    })

    cards.offer(body())

    expect(schedule).toHaveBeenCalledWith(expect.any(Function), 30 * 60 * 1_000)
  })
})
