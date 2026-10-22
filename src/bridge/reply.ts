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

/**
 * The error code the server uses to ask for a slower sender.
 *
 * It arrives inside an HTTP 200 as `ret`/`errcode: -2` with the message
 * "prepare failed", so a naive sender reads it as a permanent failure. It is not:
 * the same message succeeds once the sender waits, which is why it gets its own
 * backoff instead of the ordinary retry delay.
 */
export const THROTTLE_CODE = -2

/** First pause after a throttle, in milliseconds. */
const THROTTLE_BASE_MS = 2_000

/** Longest pause between throttled attempts, in milliseconds. */
const THROTTLE_MAX_MS = 16_000

/**
 * Whether a failure is the server asking for a slower sender rather than a
 * rejected message.
 *
 * Structural rather than `instanceof`: the transport's error class lives in the
 * protocol layer, and this module deliberately does not depend on it - it only
 * needs the code the error carries.
 * @param error - whatever the send rejected with.
 * @returns whether the server reported a throttle.
 */
export function isThrottled(error: unknown): boolean {
  return typeof error === 'object' && error !== null
    && (error as { code?: unknown }).code === THROTTLE_CODE
}

/** Collaborators for a {@link ReplyQueue}. */
export interface ReplyQueueOptions {
  /** The transport send. */
  send: ReplySender
  /** How many times one reply may be attempted; defaults to 3. */
  maxAttempts?: number
  /**
   * How many throttled attempts one reply may make, on top of {@link maxAttempts}.
   *
   * Separate because a throttle is not a failure of the message: the server is
   * asking to be approached more slowly, and giving up after the ordinary count
   * turns "wait a few seconds" into a message the user never receives.
   */
  maxThrottleAttempts?: number
  /** Called once a reply has exhausted its attempts. */
  onGiveUp?: (peerId: string, text: string, error: unknown) => void
  /** Pause before an ordinary retry, in milliseconds; replaced in tests. */
  retryDelayMs?: number
  /**
   * Smallest gap between two sends to one peer, in milliseconds.
   *
   * Zero disables pacing. A chat transport that throttles bursts needs it: the
   * retry policy only reacts after the server has already refused a message.
   */
  minIntervalMs?: number
  /** Sleep between attempts; replaced in tests so they do not wait. */
  sleep?: (ms: number) => Promise<void>
  /** Clock for pacing; defaults to `Date.now`. */
  now?: () => number
}

/** A queued reply. */
type Queued = Reply

/**
 * Read the reply text out of one session event.
 *
 * **A message that also calls a tool is narration, not an answer.** The model
 * commits one `assistant/message` per step, and most steps say what they are
 * about to do and then do it - "Now the parser:" followed by the `edit` call.
 * The prose introduces arguments the chat never sees, so delivered alone it ends
 * on a colon and nothing after it. Only the message a turn finishes on carries
 * the answer, and that one calls no tool.
 *
 * An interrupted turn commits no answer, and its partial text is not one. The
 * agent loop settles an aborted stream from `interruptedBlocks()` - the text and
 * reasoning it had accumulated - and flags the event `interrupted: true`. That
 * prose stops mid-thought; sending it after `/stop` reads as a reply that was
 * cut off, which is worse than the honest silence.
 *
 * @param event - the committed session event.
 * @returns the text to send, or `undefined` when this event is not the answer.
 */
export function extractAssistantText(event: SessionEvent): string | undefined {
  if (event.type !== 'assistant/message') return undefined
  const data = (event as { data?: { message?: { content?: readonly unknown[] }; interrupted?: unknown } }).data
  // Before the content is read: an interrupted event carries the same blocks an
  // answer would, and only this flag tells the two apart.
  if (data?.interrupted === true) return undefined
  const content = data?.message?.content
  if (!Array.isArray(content)) return undefined
  // Checked before collecting text: a tool-call block means this message is a
  // step's preamble, and its prose is an introduction to arguments that are
  // never delivered.
  const callsTool = content.some(block =>
    typeof block === 'object' && block !== null && (block as { type?: unknown }).type === 'tool-call')
  if (callsTool) return undefined
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
  private readonly maxThrottleAttempts: number
  private readonly onGiveUp: ((peerId: string, text: string, error: unknown) => void) | undefined
  private readonly retryDelayMs: number
  private readonly minIntervalMs: number
  private readonly sleep: (ms: number) => Promise<void>
  private readonly now: () => number
  private readonly queues = new Map<string, Queued[]>()
  private readonly running = new Map<string, Promise<void>>()
  /** Replies taken off a queue and not yet settled, per peer. */
  private readonly inFlight = new Map<string, number>()
  /** When this peer was last sent to, for pacing. */
  private readonly lastSentAt = new Map<string, number>()

  /**
   * @param options - the transport send and retry policy.
   */
  constructor(options: ReplyQueueOptions) {
    this.send = options.send
    this.maxAttempts = options.maxAttempts ?? 3
    this.maxThrottleAttempts = options.maxThrottleAttempts ?? 3
    this.onGiveUp = options.onGiveUp
    this.retryDelayMs = options.retryDelayMs ?? 1_000
    this.minIntervalMs = options.minIntervalMs ?? 0
    this.sleep = options.sleep ?? defaultSleep
    this.now = options.now ?? Date.now
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
    queue.push({ peerId, text, contextToken })
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

  /**
   * Attempt one reply until it succeeds or its attempts run out.
   *
   * Two budgets, not one. An ordinary failure is the message's problem and gets
   * {@link maxAttempts}; a throttle is the server's answer about *rate*, and the
   * same message goes through once the sender waits - so it gets its own budget
   * and its own exponential backoff. Treating the two the same is what lost the
   * answer this was written for: a `-2` retried after one second is still inside
   * the window that produced it, so all three attempts were refused and the reply
   * was dropped.
   */
  private async attempt(reply: Queued): Promise<void> {
    let lastError: unknown
    let failures = 0
    let throttles = 0
    while (failures < this.maxAttempts && throttles < this.maxThrottleAttempts) {
      // Awaited only when there is something to wait for. An unconditional
      // `await` - even on an already-resolved promise - costs a microtask hop
      // before every send, which defers the reply past the point the turn's
      // completion is observed. The channel's reply path is detached, so a send
      // with nothing holding it back has to start in the same run.
      const wait = this.paceDelay(reply.peerId)
      if (wait > 0) await this.sleep(wait)
      try {
        await this.send(reply.peerId, reply.text, reply.contextToken)
        this.lastSentAt.set(reply.peerId, this.now())
        return
      } catch (error) {
        lastError = error
        if (isThrottled(error)) {
          throttles += 1
          if (throttles < this.maxThrottleAttempts) await this.sleep(throttleDelay(throttles))
          continue
        }
        failures += 1
        if (failures < this.maxAttempts) await this.sleep(this.retryDelayMs)
      }
    }
    // Every attempt failed. WeChat will never replay this, so it is reported
    // rather than swallowed; the queue itself stays alive for other peers.
    this.onGiveUp?.(reply.peerId, reply.text, lastError)
  }

  /**
   * How long one send to this peer must still wait, in milliseconds.
   *
   * Pacing is proactive where the retry policy is reactive: by the time the
   * server answers `-2`, the burst has already been refused. The interval is per
   * peer, so a busy conversation does not delay a quiet one.
   * @param peerId - the conversation about to be sent to.
   * @returns the remaining wait, or zero when the send may proceed.
   */
  private paceDelay(peerId: string): number {
    if (this.minIntervalMs <= 0) return 0
    const last = this.lastSentAt.get(peerId)
    if (last === undefined) return 0
    return Math.max(0, this.minIntervalMs - (this.now() - last))
  }
}

/** Pause after the given throttle, doubling and then capped. */
function throttleDelay(throttle: number): number {
  return Math.min(THROTTLE_BASE_MS * 2 ** (throttle - 1), THROTTLE_MAX_MS)
}

/**
 * Sleep without keeping the process alive.
 *
 * The Host waits for the event loop to drain on shutdown, and a reply that is
 * only waiting to be retried has nothing left to do. The queue still holds the
 * promise, so the delay itself is unchanged.
 * @param ms - how long to wait.
 * @returns when the wait is over.
 */
function defaultSleep(ms: number): Promise<void> {
  return new Promise(resolve => {
    const timer = setTimeout(resolve, ms)
    timer.unref()
  })
}
