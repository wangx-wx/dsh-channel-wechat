/**
 * The cards this channel has sent and is waiting to have answered.
 *
 * DSH's approval and question seams are waterfalls: a listener either returns an
 * answer or delegates with `next()`. Nothing in the seam races the two, expires
 * a request, or tells a late answerer that it lost - and the answerer is not even
 * given an id, only the request object. So a channel that wants a card answered
 * over chat has to supply all of that itself, and this is where it lives.
 *
 * Three properties, each because the alternative fails:
 *
 *  - **First answer wins.** A card can be answered from more than one place, and
 *    only one settle may resolve the waiting listener; a second would be a
 *    decision the agent never asked for twice.
 *  - **A late answerer is told.** Losing a race silently tells the user their
 *    answer was accepted when the agent already acted on someone else's.
 *  - **Nothing waits forever.** The seam has no timeout, so an unanswered card
 *    would hold its turn open for the life of the process.
 *
 * @module dsh-channel-wechat/bridge/pending-cards
 */

/** One question as a card carries it, mirroring the seam's own shape. */
export interface PendingQuestion {
  /** Stable caller-supplied id, echoed in the answer. */
  readonly id: string
  /** The question to display. */
  readonly question: string
  /** Supporting detail rendered with the question. */
  readonly detail?: string
  /** Short heading. */
  readonly header?: string
  /** Choices, when the question offers any. */
  readonly options?: readonly { readonly label: string; readonly description?: string }[]
  /** Whether more than one option may be chosen. */
  readonly multiSelect?: boolean
}

/** Which seam a card came from. */
export type CardKind = 'approval' | 'question'

/**
 * One card awaiting an answer.
 *
 * The peer is part of the card rather than looked up at reply time: the reply
 * arrives as a WeChat message from that peer, and finding the request it belongs
 * to depends on knowing which conversation it came from.
 */
export interface PendingCard {
  /** The short id the user types to answer this card. */
  readonly id: string
  /** Which seam produced it. */
  readonly kind: CardKind
  /** The peer the card was sent to. */
  readonly peerId: string
  /** The session whose turn is waiting, for diagnostics and cancellation. */
  readonly sessionId: string
  /** The tool awaiting a decision, for an approval card. */
  readonly toolName?: string
  /** The asker's raw reason, for an approval card. */
  readonly reason?: string
  /** The asker's localized reason, preferred for display when present. */
  readonly displayReason?: string
  /** The questions to put to the user; empty for an approval card. */
  readonly questions: readonly PendingQuestion[]
}

/** A card plus the machinery that settles it. */
interface Entry<Value> {
  card: PendingCard
  /** Resolves the listener waiting on this card; called at most once. */
  resolve: (value: Value) => void
  /** Rejects the listener, for a seam where no valid answer exists. */
  reject: (error: unknown) => void
  /**
   * Fires when the card is given up on, so its turn is not held open.
   *
   * Mutable because a card may be offered before it is shown: its countdown
   * starts when {@link PendingCards.arm} is called, not when it was queued.
   */
  timer: ReturnType<typeof setTimeout> | undefined
}

/** Collaborators and policy for {@link PendingCards}. */
export interface PendingCardsOptions<Value> {
  /**
   * The value a card settles with when nobody answers it in time.
   *
   * May throw instead, which rejects the waiting listener. That is for a seam
   * where no valid no-answer value exists - inventing an answer would put words
   * in the user's mouth, so refusing is the only honest outcome.
   */
  onTimeout: (card: PendingCard) => Value
  /** How long a card is offered before it is withdrawn; `0` disables expiry. */
  timeoutMs: number
  /** Called when a card expires, so the user can be told. */
  onExpired?: (card: PendingCard) => void
  /**
   * Called when an answer names a card that was not open, so the user learns
   * their reply did nothing instead of assuming it decided something.
   */
  onUnmatched?: (cardId: string, peerId: string) => void
  /** Schedules the expiry; replaced in tests. */
  schedule?: (work: () => void, ms: number) => ReturnType<typeof setTimeout>
  /** Cancels a scheduled expiry; replaced alongside {@link schedule}. */
  cancelSchedule?: (handle: ReturnType<typeof setTimeout>) => void
  /**
   * Allocates the next card id.
   *
   * Injectable so that two registries - one per seam - can share a single id
   * namespace. They must: the reply a user types is matched against the open
   * cards, and with two independent counters both seams would hand out `P1` and
   * a reply could name either.
   */
  allocateId?: () => string
}

/**
 * The open cards for one channel run.
 *
 * Generic over the value a card settles with, because approvals and questions
 * have different answer shapes but identical racing, expiry, and bookkeeping -
 * and duplicating that machinery per seam is how the two drift apart.
 */
export class PendingCards<Value> {
  private readonly entries = new Map<string, Entry<Value>>()
  private readonly options: PendingCardsOptions<Value>
  /**
   * A counter rather than a uuid: the id is typed by hand on a phone. Shared
   * between the two seams through {@link PendingCardsOptions.allocateId}, so
   * that one id namespace spans every open card.
   */
  private readonly allocateId: () => string

  /**
   * @param options - the timeout policy and its observers.
   */
  constructor(options: PendingCardsOptions<Value>) {
    this.options = options
    this.allocateId = options.allocateId ?? (() => {
      const id = `P${String(this.nextNumber)}`
      this.nextNumber += 1
      return id
    })
  }

  /** Fallback counter for the default allocator. */
  private nextNumber = 1

  /** How many cards are open. */
  get size(): number {
    return this.entries.size
  }

  /**
   * Offer one card and return the promise that settles when it is answered.
   *
   * The caller sends the rendered text itself; this only owns the wait, so the
   * transport stays out of the registry.
   *
   * `arm: false` offers the card without starting its countdown. That exists for
   * a channel that shows cards one at a time: a card still waiting its turn has
   * not been shown to anyone, and expiring it would be timing out a question the
   * user was never asked. {@link arm} starts the countdown when it is displayed.
   * @param card - the card, without its id.
   * @param options - whether to start the countdown now; defaults to yes.
   * @returns the id to render, and the promise the listener returns.
   */
  offer(
    card: Omit<PendingCard, 'id'>,
    options: { arm?: boolean } = {},
  ): { card: PendingCard; settled: Promise<Value> } {
    const id = this.allocateId()
    let resolve!: (value: Value) => void
    let reject!: (error: unknown) => void
    const settled = new Promise<Value>((resolveInner, rejectInner) => {
      resolve = resolveInner
      reject = rejectInner
    })
    const complete: PendingCard = { ...card, id }
    this.entries.set(id, { card: complete, resolve, reject, timer: undefined })
    if (options.arm ?? true) this.arm(id)
    return { card: complete, settled }
  }

  /**
   * Start one card's countdown, as it is shown to the user.
   *
   * A card that is not open is ignored: the run may have moved on it while it
   * waited, and arming a closed card would reschedule a timer for a promise that
   * has already settled.
   * @param cardId - the card being displayed.
   */
  arm(cardId: string): void {
    const entry = this.entries.get(cardId)
    if (entry === undefined || entry.timer !== undefined) return
    if (this.options.timeoutMs <= 0) return
    entry.timer = (this.options.schedule ?? ((work, ms) => setTimeout(work, ms)))(
      () => { this.expire(cardId) },
      this.options.timeoutMs,
    )
  }

  /**
   * Whether an id names a card that is still waiting.
   *
   * This is what decides whether an inbound message is a card reply or an
   * ordinary prompt, so it is an exact lookup rather than a pattern: treating
   * any `<word> <number>` as an answer would swallow messages the user meant for
   * the model.
   * @param cardId - the id the user typed.
   * @returns true when this id is open.
   */
  isOpen(cardId: string): boolean {
    return this.entries.has(cardId)
  }

  /**
   * The open card with this id.
   * @param cardId - the id the user typed.
   * @returns the card, or `undefined` when it is not open.
   */
  get(cardId: string): PendingCard | undefined {
    return this.entries.get(cardId)?.card
  }

  /**
   * The peer a card was sent to, when it is still open.
   * @param cardId - the id the user typed.
   * @returns the peer id, or `undefined` when the card is not open.
   */
  peerOf(cardId: string): string | undefined {
    return this.entries.get(cardId)?.card.peerId
  }

  /**
   * Answer one card.
   *
   * The first answer resolves the waiting listener and every later one is
   * reported instead, because the agent has already acted: accepting a second
   * answer would let the user believe they changed a decision already made.
   * @param cardId - the id the user typed.
   * @param peerId - the peer that answered, so a reply from the wrong
   *   conversation cannot decide this card.
   * @param value - the outcome to settle the listener with.
   * @returns whether this answer was the one that counted.
   */
  settle(cardId: string, peerId: string, value: Value): boolean {
    const entry = this.entries.get(cardId)
    // A card belongs to the conversation it was sent to. Another peer naming the
    // id is guessing, and letting it win would let one user decide another's
    // tool call.
    if (entry === undefined || entry.card.peerId !== peerId) {
      this.options.onUnmatched?.(cardId, peerId)
      return false
    }
    this.entries.delete(cardId)
    if (entry.timer !== undefined) (this.options.cancelSchedule ?? clearTimeout)(entry.timer)
    entry.resolve(value)
    return true
  }

  /**
   * Close one card for a reason of the caller's choosing.
   *
   * Distinct from answering, which only a user may do, and from expiring, which
   * says the user ignored the card. This is "the card no longer applies": the
   * turn was stopped, another answerer won, or the user asked to discuss
   * instead. The outcome is the caller's because the three are different facts
   * and the waiting listener acts on them differently.
   * @param cardId - the card to close.
   * @param outcome - the value to resolve with, or the error to reject with.
   * @returns whether there was an open card to close.
   */
  withdraw(cardId: string, outcome: { value: Value } | { error: unknown }): boolean {
    const entry = this.entries.get(cardId)
    if (entry === undefined) return false
    this.entries.delete(cardId)
    if (entry.timer !== undefined) (this.options.cancelSchedule ?? clearTimeout)(entry.timer)
    if ('error' in outcome) entry.reject(outcome.error)
    else entry.resolve(outcome.value)
    return true
  }

  /**
   * Close every card one peer holds; cards belonging to other peers are left
   * alone.
   *
   * A card belongs to the conversation it was sent to, so an action on one
   * conversation - `/stop`, above all - must not reach into another's turn.
   * @param peerId - the conversation whose cards are dropped.
   * @param outcome - the value to resolve with, or the error to reject with.
   * @returns how many cards were closed.
   */
  withdrawAll(peerId: string, outcome: { value: Value } | { error: unknown }): number {
    // Collected first: `withdraw` deletes from the map being iterated.
    const mine = [...this.entries]
      .filter(([, entry]) => entry.card.peerId === peerId)
      .map(([id]) => id)
    for (const id of mine) this.withdraw(id, outcome)
    return mine.length
  }

  /**
   * Withdraw every card, so nothing waits on a channel that has stopped.
   *
   * Each open card settles rather than being abandoned: the listener holding it
   * is inside a turn, and dropping the promise would wedge that turn exactly as
   * an unanswered card does.
   */
  disposeAll(): void {
    for (const [id, entry] of [...this.entries]) {
      this.entries.delete(id)
      if (entry.timer !== undefined) (this.options.cancelSchedule ?? clearTimeout)(entry.timer)
      this.settleByTimeout(entry)
    }
  }

  /** Withdraw one expired card, telling the user it is gone. */
  private expire(cardId: string): void {
    const entry = this.entries.get(cardId)
    if (entry === undefined) return
    this.entries.delete(cardId)
    this.options.onExpired?.(entry.card)
    this.settleByTimeout(entry)
  }

  /**
   * Give up on one card, answering or refusing according to the policy.
   *
   * A throwing `onTimeout` has to become a rejection here rather than escaping
   * into the timer: a throw out of a timer callback would leave the waiting
   * promise pending forever, which is the exact hang this class exists to
   * prevent.
   */
  private settleByTimeout(entry: Entry<Value>): void {
    try {
      entry.resolve(this.options.onTimeout(entry.card))
    } catch (error: unknown) {
      entry.reject(error)
    }
  }
}
