/**
 * Where an answer leaves the channel.
 *
 * Split out of `channel.ts` for two reasons. The file was already past its
 * documented size, and this is a genuinely separate concern: the channel decides
 * *what* to send and *to whom*, while this decides how much of it one message
 * can carry.
 *
 * The rules themselves live one level down: {@link ./../bridge/split} cuts the
 * text and {@link ./../bridge/reply} paces and retries. This is the seam that
 * turns one answer into the calls that queue it.
 *
 * @module dsh-channel-wechat/channel/outbound
 */

import { DEFAULT_MAX_CHARS, splitMessage } from '../bridge/split.ts'
import type { ReplyQueue } from '../bridge/reply.ts'

/** How one answer is turned into queued messages. */
export interface OutboundOptions {
  /** The queue every piece goes through. */
  queue: ReplyQueue
  /** Longest text one message may carry; absent uses the splitter's default. */
  maxMessageChars?: number
}

/** The token a conversation issued, per peer. */
export type TokenLookup = (peerId: string) => string | undefined

/** Queue one answer as the messages the transport will accept. */
export type OutboundSend = (peerId: string, text: string, token: TokenLookup) => void

/**
 * Build the function that queues one answer.
 *
 * **Synchronous on purpose.** `ReplyQueue.enqueue` starts its pump in the same
 * call, so a send that was reached has already been started by the time this
 * returns. Making this `async` costs a microtask hop before every reply, which is
 * enough to defer a send past the point where the turn's completion is observed
 * - and the caller detaches the reply path, so nothing would wait for it.
 *
 * Every outbound text goes through here, so the length ceiling is enforced in one
 * place rather than at each call site. The pieces are queued in order and the
 * queue keeps one peer's sends ordered, so a split answer still reads top to
 * bottom.
 *
 * @param options - the queue and the length ceiling.
 * @returns the function that queues one answer.
 */
export function createOutbound(options: OutboundOptions): OutboundSend {
  const maxChars = options.maxMessageChars ?? DEFAULT_MAX_CHARS
  return (peerId, text, token) => {
    const parts = splitMessage(text, maxChars)
    // Queued without awaiting: `enqueue` registers its pump synchronously, so
    // awaiting it would only add a hop, not a guarantee.
    for (const part of parts) void options.queue.enqueue(peerId, part, token(peerId))
  }
}
