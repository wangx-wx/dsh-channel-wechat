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
 */
export class CardService {
  private readonly options: CardServiceOptions
  private readonly approvals: PendingCards<ApprovalOutcomeLike>
  private readonly questions: PendingCards<QuestionAnswerResult>
  private readonly disposers: (() => boolean)[] = []
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
    const shared = {
      timeoutMs: options.timeoutMs,
      allocateId,
      ...(options.onExpired === undefined ? {} : { onExpired: options.onExpired }),
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
   * Map what the user typed to the id a card was issued under.
   *
   * Ids are issued as `P1` and typed as `p1` often enough - a phone keyboard
   * capitalizes the first word - that the comparison is case-insensitive here
   * rather than at each lookup. The canonical id comes back, so the rest of the
   * reply path never sees the raw text.
   * @param typed - the first word of the message.
   * @returns the issued id, or `undefined` when no open card has it.
   */
  private resolveCardId(typed: string): string | undefined {
    if (this.approvals.isOpen(typed) || this.questions.isOpen(typed)) return typed
    const upper = typed.toUpperCase()
    if (upper !== typed && (this.approvals.isOpen(upper) || this.questions.isOpen(upper))) return upper
    return undefined
  }

  /**
   * Whether a message names a card this channel is waiting on.
   *
   * Consulted before delivery, so a reply is answered instead of being sent to
   * the model as a prompt.
   * @param text - the inbound message text.
   * @returns true when this text answers an open card.
   */
  addressesCard(text: string): boolean {
    return parseCardReply(text, typed => this.resolveCardId(typed)) !== undefined
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
  }

  /**
   * Answer one inbound message when it names a card.
   * @param peerId - the peer that sent it.
   * @param text - the message text.
   * @returns whether the message was consumed as a card reply.
   */
  async answer(peerId: string, text: string): Promise<boolean> {
    const reply = parseCardReply(text, typed => this.resolveCardId(typed))
    if (reply === undefined) return false
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
        await this.options.send(peerId, this.elevateSession(approval.sessionId))
        return true
      }
      const won = this.approvals.settle(reply.cardId, peerId, parsed.outcome)
      await this.options.send(peerId, won ? '已收到，正在继续。' : '这张卡片已被其他地方处理了。')
      return true
    }
    const question = this.questions.get(reply.cardId)
    if (question === undefined) return false
    const parsed = readQuestionReply(question, reply.selections)
    if (parsed.kind === 'invalid') {
      await this.options.send(peerId, parsed.text)
      return true
    }
    const won = this.questions.settle(reply.cardId, peerId, { answers: parsed.answers })
    await this.options.send(peerId, won ? '已收到，正在继续。' : '这张卡片已被其他地方处理了。')
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
    })
    await this.options.send(peerId, formatCard(card))
    this.options.onCardSent?.(card)
    if (this.options.shareWithGui) {
      // Both are offered, and whichever settles first wins. The GUI's own
      // answerer is `next()`, so racing the two is what makes either usable.
      return await Promise.race([settled, next()])
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
    })
    await this.options.send(peerId, formatCard(card))
    this.options.onCardSent?.(card)
    if (this.options.shareWithGui) return await Promise.race([settled, next()])
    return await settled
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
