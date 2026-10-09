/**
 * Sending the agent's answer back to WeChat.
 *
 * Two decisions shape this file:
 *
 * **The reply comes from the durable event.** `assistant/message` is what the
 * session log commits; the live `assistant-stream` chunks are process-local and
 * dropped when nobody is subscribed, so a reply built from them would be
 * missing chunks after a reload.
 *
 * **Delivery goes through a queue.** WeChat has no replay or delivery receipt,
 * so a failed send is a message the user never sees and nothing will retry. The
 * queue retries a bounded number of times, keeps one peer's sends in order, and
 * lets one unreachable peer fail without silencing the others.
 *
 * @module dsh-channel-wechat/bridge/reply
 */

import type { SessionEvent } from '@deepseek-ai/dsh-session'

/** One peer's reply as the sender needs it. */
export interface Reply {
  /** The destination user. */
  peerId: string
  /** The text to send. */
  text: string
  /** The token the conversation's last inbound message issued, when there was one. */
  contextToken: string | undefined
}

/** Sends one reply; rejects when the send failed and may be retried. */
export type ReplySender = (peerId: string, text: string, contextToken: string | undefined) => Promise<void>

/** Collaborators for a {@link ReplyQueue}. */
export interface ReplyQueueOptions {
  /** The transport send. */
  send: ReplySender
  /** How many times one reply may be attempted; defaults to 3. */
  maxAttempts?: number
  /** Called once a reply has exhausted its attempts. */
  onGiveUp?: (peerId: string, text: string, error: unknown) => void
  /** Pause before a retry, in milliseconds; replaced in tests. */
  retryDelayMs?: number
}

/** A queued reply plus its attempt count. */
interface Queued extends Reply {
  attempts: number
}

/**
 * Read the reply text out of one session event.
 * @param event - the committed session event.
 * @returns the concatenated text, or `undefined` when there is none to send.
 */
export function extractAssistantText(event: SessionEvent): string | undefined {
  if (event.type !== 'assistant/message') return undefined
  const content = (event as { data?: { message?: { content?: readonly unknown[] } } }).data?.message?.content
  if (!Array.isArray(content)) return undefined
  const text = content
    .filter((block): block is { type: 'text'; text: string } =>
      typeof block === 'object' && block !== null
      && (block as { type?: unknown }).type === 'text'
      && typeof (block as { text?: unknown }).text === 'string')
    .map(block => block.text)
    .join('')
  // A tool-only turn has prose to show nobody; an empty message would render as
  // a blank bubble in the user's chat.
  return text === '' ? undefined : text
}

/**
 * A per-peer outbound queue.
 *
 * Sends run one at a time per peer, in the order they were enqueued, so a slow
 * reply cannot be overtaken by the next one. Different peers proceed
 * independently.
 */
export class ReplyQueue {
  private readonly send: ReplySender
  private readonly maxAttempts: number
  private readonly onGiveUp: ((peerId: string, text: string, error: unknown) => void) | undefined
  private readonly retryDelayMs: number
  private readonly queues = new Map<string, Queued[]>()
  private readonly running = new Map<string, Promise<void>>()
  /** Replies taken off a queue and not yet settled, per peer. */
  private readonly inFlight = new Map<string, number>()

  /**
   * @param options - the transport send and retry policy.
   */
  constructor(options: ReplyQueueOptions) {
    this.send = options.send
    this.maxAttempts = options.maxAttempts ?? 3
    this.onGiveUp = options.onGiveUp
    this.retryDelayMs = options.retryDelayMs ?? 1_000
  }

  /** How many replies are queued or in flight. */
  get pending(): number {
    let total = 0
    for (const queue of this.queues.values()) total += queue.length
    for (const count of this.inFlight.values()) total += count
    return total
  }

  /**
   * Queue one reply.
   * @param peerId - the destination user.
   * @param text - the reply text; an empty one is discarded.
   * @param contextToken - the token the conversation issued.
   * @returns when the reply has been queued (not necessarily sent).
   */
  async enqueue(peerId: string, text: string, contextToken?: string): Promise<void> {
    // Nothing to send; queuing it would put a blank bubble in the chat.
    if (text.trim() === '') return
    const queue = this.queues.get(peerId) ?? []
    queue.push({ peerId, text, contextToken, attempts: 0 })
    this.queues.set(peerId, queue)
    if (!this.running.has(peerId)) this.running.set(peerId, this.pump(peerId))
  }

  /** Wait until every queued reply has been attempted to completion. */
  async drain(): Promise<void> {
    // `enqueue` registers its pump synchronously, so a peer in `running` here
    // has already had its work started; waiting on those promises and then
    // re-checking covers a pump that queued more behind it.
    while (true) {
      const running = [...this.running.values()]
      if (running.length === 0) return
      await Promise.all(running)
    }
  }

  /** Take replies for one peer until its queue empties. */
  private async pump(peerId: string): Promise<void> {
    try {
      while (true) {
        const queue = this.queues.get(peerId)
        const next = queue?.shift()
        if (next === undefined) {
          this.queues.delete(peerId)
          return
        }
        this.inFlight.set(peerId, (this.inFlight.get(peerId) ?? 0) + 1)
        try {
          await this.attempt(next)
        } finally {
          this.inFlight.delete(peerId)
        }
      }
    } finally {
      this.running.delete(peerId)
    }
  }

  /** Attempt one reply until it succeeds or its attempts run out. */
  private async attempt(reply: Queued): Promise<void> {
    let lastError: unknown
    while (reply.attempts < this.maxAttempts) {
      reply.attempts += 1
      try {
        await this.send(reply.peerId, reply.text, reply.contextToken)
        return
      } catch (error) {
        lastError = error
        if (reply.attempts < this.maxAttempts && this.retryDelayMs > 0) {
          await new Promise(resolve => setTimeout(resolve, this.retryDelayMs))
        }
      }
    }
    // Every attempt failed. WeChat will never replay this, so it is reported
    // rather than swallowed; the queue itself stays alive for other peers.
    this.onGiveUp?.(reply.peerId, reply.text, lastError)
  }
}
