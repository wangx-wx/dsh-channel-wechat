/**
 * Showing one conversation's cards one at a time.
 *
 * Parallel tool calls raise their approvals together, and sending them all at
 * once put several long cards and several ids on one phone screen, where the
 * reader has to hold all of them in mind to answer any. This keeps the display
 * to one card per conversation: the next appears the moment the current one is
 * decided.
 *
 * **Display only.** The cards themselves - their ids, waiting listeners, and
 * expiry - stay in `PendingCards`. A card is queued here as soon as it is
 * offered, so its listener is already waiting and only the *display* is
 * deferred; that is what lets the run be counted up front and makes a card
 * answerable the instant it appears.
 *
 * Split out of `cards-service.ts`, which had grown past its documented size,
 * and because this is a state machine with its own rules rather than another
 * piece of the DSH integration.
 *
 * @module dsh-channel-wechat/bridge/card-queue
 */

/** The slice of a card this module needs. */
export interface QueuedCard {
  /** The id the user types to answer it. */
  readonly id: string
  /** The conversation it belongs to. */
  readonly peerId: string
}

/** What one conversation is showing and what is waiting behind it. */
interface PeerRun {
  /** Cards offered and not yet displayed, in arrival order. */
  readonly waiting: string[]
  /** The card on screen, when there is one. */
  shown: string | undefined
  /** How many cards of this run have already been dealt with. */
  settled: number
  /** Whether a display is already scheduled, so one batch shows one card. */
  scheduled: boolean
}

/** Where one card sits in the run of cards waiting for its peer. */
export interface CardPosition {
  /** One-based position of this card. */
  readonly index: number
  /** How many cards the run holds in total. */
  readonly total: number
}

/** Collaborators for {@link CardQueue}. */
export interface CardQueueOptions<Card extends QueuedCard> {
  /** The card with this id, or `undefined` when it is no longer open. */
  lookup: (cardId: string) => Card | undefined
  /** Record that this card is now on screen, so its countdown starts. */
  arm: (cardId: string) => void
  /** Deliver one card. Only queues; must not be awaited for delivery. */
  show: (card: Card, position: CardPosition) => void
}

/**
 * The display state of every conversation this channel is answering.
 *
 * All methods are synchronous and idempotent: they are called from reply
 * handling, from timers, and from abort listeners, all of which may fire in one
 * batch.
 */
export class CardQueue<Card extends QueuedCard> {
  private readonly runs = new Map<string, PeerRun>()
  private readonly options: CardQueueOptions<Card>

  /**
   * @param options - how to look a card up, arm it, and show it.
   */
  constructor(options: CardQueueOptions<Card>) {
    this.options = options
  }

  /**
   * Queue one card and show it if the conversation is idle.
   * @param card - the card that was just offered.
   */
  enqueue(card: Card): void {
    const run = this.runOf(card.peerId)
    run.waiting.push(card.id)
    this.schedule(run, card.peerId)
  }

  /**
   * Forget that a card was ever queued or shown, and show the next one.
   *
   * Called from every path that closes a card - answered, expired, aborted,
   * withdrawn - because each one frees the display slot.
   *
   * Takes the card rather than its id because the caller usually settles the
   * registry first, and a settled card can no longer be looked up - which is
   * exactly when its peer is needed.
   * @param card - the card that closed.
   */
  release(card: Card): void {
    const run = this.runs.get(card.peerId)
    if (run === undefined) return
    if (run.shown === card.id) {
      run.shown = undefined
      run.settled += 1
      this.schedule(run, card.peerId)
      return
    }
    const index = run.waiting.indexOf(card.id)
    if (index >= 0) run.waiting.splice(index, 1)
  }

  /**
   * Whether a card is the one currently on screen for its conversation.
   * @param cardId - the card id.
   * @returns true when some conversation is displaying it.
   */
  isShown(cardId: string): boolean {
    for (const run of this.runs.values()) {
      if (run.shown === cardId) return true
    }
    return false
  }

  /**
   * The card currently on screen for one conversation.
   * @param peerId - the conversation.
   * @returns its id, or `undefined` when nothing is displayed.
   */
  shownOf(peerId: string): string | undefined {
    return this.runs.get(peerId)?.shown
  }

  /**
   * How many cards of this conversation's run are still ahead of this one.
   * @param cardId - the card in question.
   * @returns its position in the queue, or `-1` when it is not queued.
   */
  waitingIndex(cardId: string): number {
    for (const run of this.runs.values()) {
      const index = run.waiting.indexOf(cardId)
      if (index >= 0) return index
    }
    return -1
  }

  /**
   * Drop a conversation's display state, as `/stop` does.
   * @param peerId - the conversation.
   */
  forget(peerId: string): void {
    this.runs.delete(peerId)
  }

  /** Drop every conversation's display state, as disposal does. */
  clear(): void {
    this.runs.clear()
  }

  /**
   * Ask for the next card to be displayed once the current batch of work has
   * finished.
   *
   * **Deferred rather than immediate.** One turn's cancellation signal is
   * shared by every card that turn raised, so a single abort runs every listener
   * in one batch. Displaying inside each listener would push all the queued
   * cards to the chat and withdraw them in the same breath. Deferring means the
   * batch's withdrawals all land first and only the surviving card is shown.
   *
   * It also keeps a synchronous scheduler from recursing through
   * `expire → release → show → arm → expire`.
   * @param run - the conversation's run state.
   * @param peerId - the conversation.
   */
  private schedule(run: PeerRun, peerId: string): void {
    if (run.scheduled) return
    run.scheduled = true
    queueMicrotask(() => {
      run.scheduled = false
      this.display(run, peerId)
    })
  }

  /**
   * Display the next card, if one is waiting and nothing is on screen.
   * @param run - the conversation's run state.
   * @param peerId - the conversation.
   */
  private display(run: PeerRun, peerId: string): void {
    // The run may have been forgotten between scheduling and running.
    if (this.runs.get(peerId) !== run) return
    if (run.shown !== undefined) return
    const next = run.waiting.shift()
    if (next === undefined) {
      // Nothing left: the run is over, and its bookkeeping would otherwise
      // outlive it for the process's lifetime.
      if (run.settled > 0) this.runs.delete(peerId)
      return
    }
    const card = this.options.lookup(next)
    if (card === undefined) {
      // Closed between being queued and its turn; try the one behind it.
      this.display(run, peerId)
      return
    }
    run.shown = next
    this.options.arm(next)
    try {
      this.options.show(card, { index: run.settled + 1, total: run.settled + 1 + run.waiting.length })
    } catch {
      // Leave the card open and on screen: a transport failure must not decide
      // the turn, and the user may still answer it on a later attempt.
    }
  }

  /**
   * The run state for one conversation, created on first use.
   * @param peerId - the conversation.
   * @returns its run state.
   */
  private runOf(peerId: string): PeerRun {
    const existing = this.runs.get(peerId)
    if (existing !== undefined) return existing
    const created: PeerRun = { waiting: [], shown: undefined, settled: 0, scheduled: false }
    this.runs.set(peerId, created)
    return created
  }
}
