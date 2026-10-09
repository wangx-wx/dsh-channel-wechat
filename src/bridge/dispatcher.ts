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

import { createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm'

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
}

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
  return createUserMessage({
    // An empty text block is rejected by message construction, so a body that
    // parsed to nothing still has to carry something rather than crash.
    content: [{ type: 'text', text: input.text === '' ? '(空消息)' : input.text }],
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
