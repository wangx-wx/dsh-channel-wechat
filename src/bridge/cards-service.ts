/**
 * Answering DSH's interaction cards over WeChat.
 *
 * DSH raises two agent-scoped waterfalls - `approval/request` and
 * `user-questions/request` - and an answerer claims one by returning a value
 * instead of calling `next()`. That is the whole integration surface. Everything
 * else a chat channel needs, DSH deliberately does not provide:
 *
 *  - **The answerer gets no id.** An approval carries a `callId` at best, and a
 *    question carries none at all. So the id a user types to answer is this
 *    channel's own, allocated here.
 *  - **Nothing is raced or expired.** The seams await a returned promise with no
 *    deadline, so a card nobody answers holds its turn open forever.
 *  - **A loser is not told.** Losing means returning into a waterfall that has
 *    already settled, and the caller never learns.
 *
 * `prepend: true` is mandatory on both listeners. Without it the GUI's own
 * answerer runs first, claims the request, and this channel never sees it - a
 * failure with no error message anywhere.
 *
 * @module dsh-channel-wechat/bridge/cards-service
 */

import type { Context } from '@deepseek-ai/cordis'
import {
  formatCard,
  parseCardReply,
  readApprovalReply,
  readQuestionReply,
} from './cards.ts'
import { CardQueue } from './card-queue.ts'
import { PendingCards, type PendingCard, type PendingQuestion } from './pending-cards.ts'

/** One approval outcome, as the seam's vocabulary spells it. */
export type ApprovalOutcomeLike = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'

/** One answer item, as the question seam's vocabulary spells it. */
export interface QuestionAnswerLike {
  /** The answered question's id. */
  readonly id: string
  /** The labels the user chose. */
  readonly selected: readonly string[]
  /** Free text, when the question had no options. */
  readonly custom?: string
}

/** What a claimed question answers with. */
export interface QuestionAnswerResult {
  /** Every question's answer, in request order. */
  readonly answers: readonly QuestionAnswerLike[]
}

/** The slice of the approval event this service reads. */
interface ApprovalRequestLike {
  readonly agent: { readonly id: unknown; readonly session: { readonly id: unknown } }
  readonly toolName?: string
  readonly reason?: string
  readonly displayReason?: Record<string, string>
  /**
   * The cancellation lifetime of the pending request.
   *
   * A cancelled turn aborts this, which is how `/stop` reaches a card: the
   * approval service settles the request itself, but nothing else tells this
   * channel that the card it is holding no longer has a turn behind it.
   */
  readonly signal?: AbortSignal
}

/** The slice of the question event this service reads. */
interface QuestionRequestLike {
  readonly agent?: { readonly id: unknown; readonly session: { readonly id: unknown } }
  readonly questions: readonly {
    readonly id: string
    readonly question: string
    readonly detail?: string
    readonly header?: string
    readonly options?: readonly { readonly label: string; readonly description?: string }[]
    readonly multiSelect?: boolean
  }[]
  /** The cancellation lifetime of the pending request; see `ApprovalRequestLike.signal`. */
  readonly signal?: AbortSignal
}

/** The context surface the two listeners need. */
type EventContextLike = Pick<Context, 'on'> & {
  on(event: 'approval/request', listener: (...args: never[]) => unknown, options?: { prepend?: boolean }): () => boolean
  on(event: 'user-questions/request', listener: (...args: never[]) => unknown, options?: { prepend?: boolean }): () => boolean
}

/** Collaborators for {@link CardService}. */
export interface CardServiceOptions {
  /** The context whose waterfalls this service answers. */
  context: EventContextLike
  /**
   * Whether the GUI answerer is also offered each card.
   *
   * Off by default. When off, this channel claims every card for a conversation
   * it owns and the GUI never sees it, which keeps one card in one place. When
   * on, both are offered and the first answer wins - and the GUI card is then
   * this channel's to withdraw, which it cannot do (see the module note on
   * module-scope caveats in the plan).
   */
  shareWithGui: boolean
  /** Resolve the peer a session belongs to, or `undefined` when it is not ours. */
  peerOfSession: (sessionId: string) => string | undefined
  /** Send one card or acknowledgement to a peer. */
  send: (peerId: string, text: string) => Promise<void>
  /** How long a card stays open; `0` leaves it open until the turn ends. */
  timeoutMs: number
  /**
   * Switch one session to full access, for the card's session-wide choice.
   *
   * Absent on a deployment that composes no permission service. The card still
   * offers the choice - it is rendered from a constant - so the answer has to
   * fail closed rather than quietly becoming a one-shot grant.
   *
   * @param sessionId - the session whose turn raised the card.
   * @returns whether the switch took effect; a service that throws is reported
   *   the same way, because the user needs to know either way.
   */
  elevate?: (sessionId: string) => boolean
  /** Observe a card being sent, for diagnostics. */
  onCardSent?: (card: PendingCard) => void
  /** Observe a card expiring unanswered. */
  onExpired?: (card: PendingCard) => void
}

/**
 * The interaction cards one channel run is willing to answer.
 *
 * Both seams are handled here rather than in two modules because their reply
 * syntax, id space, and race rules are one behaviour; splitting them is how the
 * two would come to disagree about what `P1 1` means.
 *
 * **Cards are shown one per conversation at a time.** Parallel tool calls raise
 * their approvals together, and sending them all at once put several long cards
 * and several ids on one phone screen, where the reader has to hold all of them
 * in mind to answer any. Queueing the display costs nothing the user can see:
 * the listeners are already waiting, and each card is displayed the moment the
 * one before it is decided.
 */
export class CardService {
  private readonly options: CardServiceOptions
  private readonly approvals: PendingCards<ApprovalOutcomeLike>
  private readonly questions: PendingCards<QuestionAnswerResult>
  private readonly disposers: (() => boolean)[] = []
  /** One card on screen per conversation; see {@link CardQueue}. */
  private readonly display: CardQueue<PendingCard>
  /** One id space across both seams; see `allocateId`. */
  private nextNumber = 1

  /**
   * @param options - the context, the routing, and the policy.
   */
  constructor(options: CardServiceOptions) {
    this.options = options
    const allocateId = (): string => {
      const id = `P${String(this.nextNumber)}`
      this.nextNumber += 1
      return id
    }
    // Built before the registries, whose expiry hook reaches back into it.
    this.display = new CardQueue<PendingCard>({
      lookup: cardId => this.approvals.get(cardId) ?? this.questions.get(cardId),
      // A card's countdown starts when it is shown, not when it was queued: a
      // card waiting its turn has not been put to anybody, and expiring it
      // would fail a turn on a question the user never saw.
      arm: cardId => (this.approvals.isOpen(cardId) ? this.approvals : this.questions).arm(cardId),
      show: (card, position) => {
        try {
          void this.options.send(card.peerId, formatCard(card, position))
        } catch {
          // `send` only queues, and the transport reports its own retries. A
          // synchronous throw must not escape into the waiting listener, which
          // DSH would read as this answerer failing.
        }
        this.options.onCardSent?.(card)
      },
    })
    const shared = {
      timeoutMs: options.timeoutMs,
      allocateId,
      // The run has to move on when its card expires, or a card nobody answers
      // would hold the display slot for good and every card behind it would
      // never be shown.
      //
      // Told before advancing: advancing displays the next card, and the user
      // should read why the previous one went away before they read its
      // replacement.
      onExpired: (card: PendingCard) => {
        options.onExpired?.(card)
        this.display.release(card)
      },
    }
    this.approvals = new PendingCards<ApprovalOutcomeLike>({
      ...shared,
      // The seam's own "no answerer" value. Every caller already fails closed on
      // it, so an expired card refuses rather than silently authorizing.
      onTimeout: () => 'unavailable',
    })
    this.questions = new PendingCards<QuestionAnswerResult>({
      ...shared,
      // A question has no fail-closed value: any answer would be invented. The
      // listener rejects instead, which the tool surfaces as a failed call.
      onTimeout: () => { throw new CardExpired() },
    })
  }

  /** How many cards are waiting. */
  get pending(): number {
    return this.approvals.size + this.questions.size
  }

  /**
   * The card whichever registry holds it.
   *
   * The two seams share one id space, so an id names exactly one of them and
   * the caller never has to know which.
   * @param cardId - the card id.
   * @returns the card, or `undefined` when it is no longer open.
   */
  private cardOf(cardId: string): PendingCard | undefined {
    return this.approvals.get(cardId) ?? this.questions.get(cardId)
  }

  /**
   * Map what the user typed to the id of an open card, which is case-insensitive
   * because a phone keyboard capitalizes the first word (`p1` for `P1`). The
   * canonical id comes back, so the rest of the reply path never sees the raw
   * text.
   * @param typed - the first word of the message.
   * @returns the issued id, or `undefined` when no open card has it.
   */
  private issuedIdOf(typed: string): string | undefined {
    if (this.cardOf(typed) !== undefined) return typed
    const upper = typed.toUpperCase()
    if (upper !== typed && this.cardOf(upper) !== undefined) return upper
    return undefined
  }

  /**
   * Whether a message names a card this channel holds a decision for.
   *
   * **Deliberately wider than "a card on screen".** This is what the channel
   * consults before delivery to decide whether the message bypasses the peer
   * queue, and a queued card's reply must bypass it too: the queue is held by
   * the very turn that raised the card, so going through it means the answer -
   * even "not your turn yet" - arrives only after that turn ends, which is never.
   *
   * Recognition is not acceptance; `answer` is what decides whether a reply may
   * actually decide the card it names.
   * @param text - the inbound message text.
   * @returns true when this text names any open card of this channel's.
   */
  addressesCard(text: string): boolean {
    return parseCardReply(text, typed => this.issuedIdOf(typed)) !== undefined
  }

  /**
   * Attach both listeners.
   *
   * Separated from the constructor because the caller owns the lifetime and must
   * be able to release the listeners without dropping the open cards.
   */
  attach(): void {
    this.disposers.push(this.options.context.on('approval/request', ((req: ApprovalRequestLike, next: () => Promise<ApprovalOutcomeLike>) => {
      return this.onApproval(req, next)
    }) as never, { prepend: true }))
    this.disposers.push(this.options.context.on('user-questions/request', ((req: QuestionRequestLike, next: () => Promise<QuestionAnswerResult>) => {
      return this.onQuestion(req, next)
    }) as never, { prepend: true }))
  }

  /** Release both listeners and settle every open card. */
  dispose(): void {
    for (const off of this.disposers.splice(0)) off()
    // Settled rather than dropped: each waiting card is inside a live turn, and
    // abandoning its promise wedges that turn exactly as an unanswered card does.
    this.approvals.disposeAll()
    this.questions.disposeAll()
    // The display bookkeeping goes with them. Leaving it behind would point
    // `shown` at cards that no longer exist, and every later display would bail
    // out on a slot that can never be freed.
    this.display.clear()
  }

  /**
   * Answer one inbound message when it names a card.
   * @param peerId - the peer that sent it.
   * @param text - the message text.
   * @returns whether the message was consumed as a card reply.
   */
  async answer(peerId: string, text: string): Promise<boolean> {
    const reply = parseCardReply(text, typed => this.issuedIdOf(typed))
    if (reply === undefined) return false
    // Named a real card, but one that is still waiting its turn. Said out loud
    // rather than dropped: returning `false` would send `P2 1` to the model as
    // prose, queued behind the very turn it was meant to unblock.
    if (!this.display.isShown(reply.cardId)) return await this.refuseUnshown(peerId, reply.cardId)
    const approval = this.approvals.get(reply.cardId)
    if (approval !== undefined) {
      const parsed = readApprovalReply(reply.selections)
      if (parsed.kind === 'invalid') {
        // Not delivered to the model either: the user was answering a card, and
        // the card stays open so they can retry.
        await this.options.send(peerId, parsed.text)
        return true
      }
      if (parsed.kind === 'elevate') {
        // Elevation is two effects, and losing the race must still prevent the
        // permission change: settling first is what makes this order safe.
        const won = this.approvals.settle(reply.cardId, peerId, 'allowed-once')
        if (!won) {
          await this.options.send(peerId, '这张卡片已被其他地方处理了。')
          return true
        }
        // Queued before advancing: advancing is what displays the next card,
        // and sends are ordered per peer - so the receipt has to be in the
        // queue first or the user sees a new question before any word that
        // their last answer landed.
        await this.options.send(peerId, this.elevateSession(approval.sessionId))
        this.display.release(approval)
        return true
      }
      const won = this.approvals.settle(reply.cardId, peerId, parsed.outcome)
      await this.options.send(peerId, won ? '已收到，正在继续。' : '这张卡片已被其他地方处理了。')
      if (won) this.display.release(approval)
      return true
    }
    const question = this.questions.get(reply.cardId)
    if (question === undefined) return false
    const parsed = readQuestionReply(question, reply.selections, reply.raw)
    if (parsed.kind === 'invalid') {
      await this.options.send(peerId, parsed.text)
      return true
    }
    if (parsed.kind === 'discuss') {
      // The user chose to talk it through. Closing the card is the whole point:
      // what they say next is an ordinary message and reaches the model as one.
      await this.options.send(peerId, '好的，这张卡已作废。直接说你的想法就行，我会接着聊。')
      this.display.release(question)
      this.questions.withdraw(reply.cardId, { error: new CardHandedBackToChat() })
      return true
    }
    const won = this.questions.settle(reply.cardId, peerId, { answers: parsed.answers })
    await this.options.send(peerId, won ? '已收到，正在继续。' : '这张卡片已被其他地方处理了。')
    if (won) this.display.release(question)
    return true
  }

  /**
   * Explain that the card a reply names has not been shown yet.
   *
   * Reached only for a card this channel actually holds, so the answer stays
   * inside the user's own conversation: a card belonging to another peer is
   * neither mentioned nor decided here.
   * @param peerId - the peer that sent it.
   * @param cardId - the card it named.
   * @returns whether a message was sent about it.
   */
  private async refuseUnshown(peerId: string, cardId: string): Promise<boolean> {
    const card = this.cardOf(cardId)
    // Another conversation's card: not this peer's to learn about. Handed back
    // as unclaimed so it reaches the model rather than being swallowed.
    if (card === undefined || card.peerId !== peerId) return false
    const shown = this.display.shownOf(peerId)
    const ahead = this.display.waitingIndex(cardId)
    const waiting = shown === undefined
      ? `前面还有 ${String(ahead)} 张`
      : `请先回答当前这张（${shown}）`
    await this.options.send(peerId, `这张卡还没轮到，${waiting}，轮到时我会直接发给你。`)
    return true
  }

  /**
   * Widen one session and describe what happened.
   *
   * A missing service and a throwing one are the same outcome to the user: the
   * session did not change. Both are reported rather than swallowed, because
   * silence would let them believe the cards were off while they keep arriving.
   *
   * @param sessionId - the session whose card offered the choice.
   * @returns the message to send back.
   */
  private elevateSession(sessionId: string): string {
    const elevate = this.options.elevate
    if (elevate === undefined) return '权限未能切换：这个部署没有权限服务。本次调用已放行。'
    let widened: boolean
    try {
      widened = elevate(sessionId)
    } catch {
      widened = false
    }
    return widened
      ? '已切换本会话为完全权限，之后不再弹出审批卡；/new 之后恢复配置的权限。'
      : '权限未能切换。本次调用已放行，但后续仍会弹出审批卡。'
  }

  /** Offer an approval to the peer that owns its session. */
  private async onApproval(
    req: ApprovalRequestLike,
    next: () => Promise<ApprovalOutcomeLike>,
  ): Promise<ApprovalOutcomeLike> {
    const peerId = this.options.peerOfSession(String(req.agent.session.id))
    // Not this channel's conversation: delegate so the GUI or any other
    // answerer still gets it.
    if (peerId === undefined) return await next()
    const { card, settled } = this.approvals.offer({
      kind: 'approval',
      peerId,
      sessionId: String(req.agent.session.id),
      ...(req.toolName === undefined ? {} : { toolName: req.toolName }),
      ...(req.reason === undefined ? {} : { reason: req.reason }),
      // The seam types this as a locale map; the card shows one string, so the
      // English copy is preferred and the raw reason is the fallback.
      ...(req.displayReason?.en === undefined ? {} : { displayReason: req.displayReason.en }),
      questions: [],
    }, { arm: false })
    // Queued before the abort is watched: an already-aborted request must find
    // the card in the run it is about to leave, or the run outlives it.
    this.display.enqueue(card)
    this.watchAbort(req.signal, card, () => ({ value: 'cancelled' }))
    if (this.options.shareWithGui) {
      // Both are offered, and whichever settles first wins. The GUI's own
      // answerer is `next()`, so racing the two is what makes either usable.
      // Losing to the GUI leaves this card holding a display slot nobody will
      // ever decide, so it is closed and the next one is shown.
      const gui = await Promise.race([
        settled.then(value => ({ from: 'wechat' as const, value })),
        next().then(value => ({ from: 'gui' as const, value })),
      ])
      if (gui.from === 'gui') await this.announceGuiWon(card)
      return gui.value
    }
    // Claimed outright. `settled` never rejects for an approval: a timeout and a
    // disposal both resolve `unavailable`, which is the seam's fail-closed value.
    return await settled
  }

  /** Offer a question to the peer that owns its session. */
  private async onQuestion(
    req: QuestionRequestLike,
    next: () => Promise<QuestionAnswerResult>,
  ): Promise<QuestionAnswerResult> {
    const sessionId = req.agent === undefined ? undefined : String(req.agent.session.id)
    const peerId = sessionId === undefined ? undefined : this.options.peerOfSession(sessionId)
    if (peerId === undefined || sessionId === undefined) return await next()
    const questions: PendingQuestion[] = req.questions.map(question => ({
      id: question.id,
      question: question.question,
      ...(question.detail === undefined ? {} : { detail: question.detail }),
      ...(question.header === undefined ? {} : { header: question.header }),
      ...(question.options === undefined ? {} : { options: question.options }),
      ...(question.multiSelect === undefined ? {} : { multiSelect: question.multiSelect }),
    }))
    const { card, settled } = this.questions.offer({
      kind: 'question',
      peerId,
      sessionId,
      questions,
    }, { arm: false })
    // A question has no fail-closed answer, so an aborted one rejects exactly as
    // a timeout does: the tool call fails rather than reporting an answer nobody
    // gave.
    this.display.enqueue(card)
    this.watchAbort(req.signal, card, () => ({ error: new CardTurnEnded() }))
    if (this.options.shareWithGui) {
      const gui = await Promise.race([
        settled.then(value => ({ from: 'wechat' as const, value })),
        next().then(value => ({ from: 'gui' as const, value })),
      ])
      if (gui.from === 'gui') await this.announceGuiWon(card)
      return gui.value
    }
    return await settled
  }

  /**
   * Close one card without a decision and move the run on.
   *
   * Separate from the registry's own `withdraw` because the display state has to
   * be advanced against the card's peer *before* the card disappears.
   * @param cardId - the card to close.
   */
  /**
   * Close a card the GUI answered, and say so over chat.
   *
   * Without the word, the card simply vanishes from the transcript on the phone
   * and a reply to it would afterwards read as an ordinary message - so the
   * user is left not knowing whether their answer went anywhere.
   * @param card - the card the other answerer settled.
   */
  private async announceGuiWon(card: PendingCard): Promise<void> {
    const wasShown = this.display.isShown(card.id)
    this.withdrawCard(card.id)
    if (!wasShown) return
    try {
      await this.options.send(card.peerId, '这张卡片已在 Harness 界面里处理了，微信这张作废。')
    } catch {
      // Nothing to do: the card is already closed, and the transport reports
      // its own failures.
    }
  }

  private withdrawCard(cardId: string): void {
    const card = this.cardOf(cardId)
    if (card === undefined) return
    this.display.release(card)
    if (this.approvals.isOpen(cardId)) this.approvals.withdraw(cardId, { value: 'cancelled' })
    else if (this.questions.isOpen(cardId)) this.questions.withdraw(cardId, { error: new CardTurnEnded() })
  }

  /**
   * Close a card when the request it belongs to is cancelled.
   *
   * This is what `/stop` leaves behind: cancelling the turn aborts the signal the
   * request carries, and DSH settles the request itself. Nothing used to tell
   * this channel, so the card stayed open for the full timeout and a later reply
   * "won" a settle and was answered "received, continuing" about a turn that no
   * longer existed.
   * @param signal - the request's cancellation lifetime, when it has one.
   * @param cardId - the card to close.
   * @param outcome - how to settle the waiting listener.
   */
  private watchAbort(
    signal: AbortSignal | undefined,
    card: PendingCard,
    outcome: () => { value: ApprovalOutcomeLike } | { error: unknown },
  ): void {
    if (signal === undefined) return
    const onAbort = (): void => {
      // A card already answered or withdrawn is a no-op: the run has moved on.
      if (this.cardOf(card.id) === undefined) return
      this.display.release(card)
      const settledWith = outcome()
      if ('error' in settledWith) this.questions.withdraw(card.id, settledWith)
      else this.approvals.withdraw(card.id, settledWith)
    }
    if (signal.aborted) {
      onAbort()
      return
    }
    // `once` because the request has one lifetime; the listener is not removed
    // when the card settles first, because nothing here holds the token. Arming
    // it is cheap and a settled card is a no-op above.
    signal.addEventListener('abort', onAbort, { once: true })
  }

  /**
   * Close every card one conversation holds, for `/stop`.
   *
   * The user asked for the turn to end; the cards were questions about that
   * turn, so they end with it. Cards belonging to another conversation are left
   * running.
   * @param peerId - the conversation whose cards are dropped.
   * @returns how many cards were closed.
   */
  withdrawAll(peerId: string): number {
    this.display.forget(peerId)
    const approvals = this.approvals.withdrawAll(peerId, { value: 'cancelled' })
    const questions = this.questions.withdrawAll(peerId, { error: new CardTurnEnded() })
    return approvals + questions
  }
}

/** Raised when a question card expired with nobody answering it. */
export class CardExpired extends Error {
  constructor() {
    // Named so the tool reports an unanswered question rather than an invented
    // one: the model must not receive answers nobody gave.
    super('无人回答这张提问卡，已作废。')
    this.name = 'CardExpired'
  }
}

/**
 * Raised when the turn that raised a card was cancelled.
 *
 * Distinct from {@link CardExpired} because nothing was ignored: the user
 * stopped the work. The tool call still fails, so the model is not handed an
 * answer nobody gave.
 */
export class CardTurnEnded extends Error {
  constructor() {
    super('这一轮已被停止，提问卡随之作废。')
    this.name = 'CardTurnEnded'
  }
}

/**
 * Raised when the user chose to discuss a question instead of answering it.
 *
 * The message says what happened rather than reporting a failure, because the
 * tool result is what the model reads next: "the user declined to pick from the
 * options and wants to talk" is a fact it can act on, and a bare error is not.
 */
export class CardHandedBackToChat extends Error {
  constructor() {
    super('用户没有选择选项，而是想在对话里讨论这个问题；他们接下来会直接发消息。')
    this.name = 'CardHandedBackToChat'
  }
}
