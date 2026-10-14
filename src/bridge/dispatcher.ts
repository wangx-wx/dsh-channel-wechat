/**
 * Turning one parsed WeChat message into agent input.
 *
 * The message is a real `UserMessage`, so it lands in the durable session log
 * and is visible to the model like any other input, and it is delivered with
 * `followup` — the only one of the three send methods that starts a turn and
 * can therefore produce a reply. `steer` would interrupt whatever is already
 * running and `inject` never starts a turn at all.
 *
 * The source is `{ kind: 'user' }`, which is the plan's decision (Q37) and not
 * an oversight: a WeChat message then inherits the authority and the local
 * timezone that any other human input gets. The channel is single-party and the
 * operator is the user, so that inheritance is what was asked for. If this ever
 * serves a group or an untrusted source, this kind must become its own
 * declare-merged source instead.
 *
 * @module dsh-channel-wechat/bridge/dispatcher
 */

import { createUserMessage, type ContentBlock, type UserMessage } from '@deepseek-ai/dsh-llm'

/** What one inbound message contributes. */
export interface InboundInput {
  /** The other party. */
  peerId: string
  /** The text to deliver. */
  text: string
  /** The token a reply must echo; unused here, carried for the reply path. */
  contextToken: string | undefined
  /** The message this delivery correlates with. */
  messageId: number | undefined
  /**
   * Media blocks to append after the text, already admitted by the store.
   *
   * Admitted rather than raw because the store's durable references are what a
   * message may legally cite; raw bytes cannot reach a model.
   */
  parts?: readonly ContentBlock[]
  /**
   * Notes for media that could not be attached.
   *
   * Folded into the text rather than added as their own block, because they are
   * words for the model to read and the message has exactly one text block.
   */
  notes?: readonly string[]
  /**
   * The text of the message this one quotes.
   *
   * DSH messages have no quote field, so the context travels as text. It is
   * placed FIRST, because reading the quoted words and then the reply is the
   * order a person understands.
   */
  quote?: string
}

/** The marker that sets a quoted passage apart from the user's own words. */
const QUOTE_PREFIX = '[引用] '

/** The subset of `Agent` this module sends through. */
export interface AgentLike {
  /** Queue a message as the next turn and wake the loop. */
  followup(message: UserMessage): void
}

/** Options for one delivery. */
export interface DeliverOptions {
  /** Whether the agent is still the live one for its session. */
  isLive?: () => boolean
}

/**
 * Build the user message for one inbound input.
 * @param input - the parsed inbound message.
 * @returns a frozen user message with a fresh identity.
 */
export function buildUserMessage(input: InboundInput): UserMessage {
  // Notes are appended to the user's own words, so one text block still carries
  // everything they said plus whatever could not be attached.
  const notes = input.notes ?? []
  // A quote that is only whitespace carries nothing, and its marker would claim
  // a quote existed when none did.
  const quote = input.quote !== undefined && input.quote.trim() !== '' ? input.quote.trim() : undefined
  const body = [input.text, ...notes].filter(part => part !== '').join('\n')
  // The quoted words come first, on their own line, so the model reads the thing
  // being referred to before the reply that refers to it.
  const text = quote === undefined ? body : `${QUOTE_PREFIX}${quote}\n${body}`
  return createUserMessage({
    // An empty text block is rejected by message construction, so a body that
    // parsed to nothing still has to carry something rather than crash.
    content: [
      { type: 'text', text: text === '' ? '(空消息)' : text },
      ...(input.parts ?? []),
    ],
    source: { kind: 'user' },
  })
}

/**
 * Deliver one inbound message as the agent's next turn.
 * @param agent - the live agent for the message's session.
 * @param input - the parsed inbound message.
 * @param options - the liveness check, when the caller can supply one.
 * @throws when the liveness check reports the agent is gone, because the
 *   message would otherwise be accepted and silently dropped.
 */
export function deliverInbound(agent: AgentLike, input: InboundInput, options: DeliverOptions = {}): void {
  if (options.isLive !== undefined && !options.isLive()) {
    throw new Error(`channel-wechat: dropped message ${String(input.messageId)}; the agent for ${input.peerId} is no longer live`)
  }
  agent.followup(buildUserMessage(input))
}
