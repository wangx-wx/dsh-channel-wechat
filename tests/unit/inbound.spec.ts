/**
 * Turning one `getUpdates` message into something the agent can be given.
 *
 * Pure: the fields are read from the protocol document's `WeixinMessage` and
 * `MessageItem` tables, and nothing here reaches a network or a context. The
 * cases that matter are the ones where a plausible implementation silently
 * does the wrong thing — treating the bot's own echo as user input, or losing
 * the context token a reply must carry.
 */

import { describe, expect, it } from 'vitest'
import { parseInboundMessage, type WeixinMessage } from '../../src/wechat/inbound.ts'

/**
 * A message as the server sends it: only the fields under test are set.
 *
 * `omit` removes fields rather than setting them to `undefined`, because an
 * absent field and a present-but-undefined one are different types here and
 * the wire cannot send the latter.
 */
function message(overrides: Partial<WeixinMessage> = {}, omit: (keyof WeixinMessage)[] = []): WeixinMessage {
  const base: WeixinMessage = {
    message_id: 1,
    from_user_id: 'user-7',
    to_user_id: 'bot-9',
    message_type: 1,
    message_state: 2,
    context_token: 'ctx-1',
    item_list: [{ type: 1, text_item: { text: 'hi' } }],
    ...overrides,
  }
  for (const key of omit) delete base[key]
  return base
}

describe('reading a user message', () => {
  it('carries the text, the sender, and the token a reply must echo', () => {
    const parsed = parseInboundMessage(message())

    // `context_token` is per-message and issued only by inbound messages, so
    // dropping it makes every reply unauthenticated for the conversation.
    expect(parsed).toEqual({
      peerId: 'user-7',
      text: 'hi',
      contextToken: 'ctx-1',
      messageId: 1,
    })
  })

  it('uses the voice transcription when the message carries one', () => {
    // The protocol puts the transcription in the item's own `text`, so reading
    // only `text_item` would drop voice messages entirely.
    const parsed = parseInboundMessage(message({
      item_list: [{ type: 3, voice_item: { text: '语音转写内容' } }],
    }))

    expect(parsed?.text).toBe('语音转写内容')
  })

  it('prefers text over a media item in the same message', () => {
    const parsed = parseInboundMessage(message({
      item_list: [
        { type: 2, image_item: { media: { encrypt_query_param: 'p' } } },
        { type: 1, text_item: { text: 'look at this' } },
      ],
    }))

    expect(parsed?.text).toBe('look at this')
  })

  it('names a media-only message instead of returning empty text', () => {
    // An image with no caption still has to reach the agent as something; an
    // empty string would look like a blank message a user never sent.
    const parsed = parseInboundMessage(message({
      item_list: [{ type: 2, image_item: { media: { encrypt_query_param: 'p' } } }],
    }))

    expect(parsed?.text).toBeTruthy()
  })
})

describe('messages that are not user input', () => {
  it('ignores the bot\u2019s own message', () => {
    // Every reply we send echoes back through getUpdates as message_type 2.
    // Treating one as input would make the channel talk to itself.
    expect(parseInboundMessage(message({ message_type: 2 }))).toBeUndefined()
  })

  it('ignores a message that is still being generated', () => {
    // state 1 is an in-progress placeholder; acting on it feeds a partial turn
    // into the agent, and state 2 arrives later with the same content.
    expect(parseInboundMessage(message({ message_state: 1 }))).toBeUndefined()
  })

  it('ignores a message with no sender', () => {
    expect(parseInboundMessage(message({ from_user_id: '' }))).toBeUndefined()
  })

  it('keeps a message whose token is missing, rather than dropping user input', () => {
    // The protocol says the client logs and continues without a token. Dropping
    // the message would lose what the user typed; dropping the token only
    // weakens the reply.
    const parsed = parseInboundMessage(message({}, ['context_token']))

    expect(parsed?.text).toBe('hi')
    expect(parsed?.contextToken).toBeUndefined()
  })

  it('keeps a message with no item list, so the user is at least acknowledged', () => {
    // Defensive: `item_list` is optional in the protocol types.
    const parsed = parseInboundMessage(message({}, ['item_list']))

    expect(parsed?.peerId).toBe('user-7')
  })
})

describe('message identity', () => {
  it('falls back to the sequence number when message_id is absent', () => {
    // The id is what the reply is correlated against, and `message_id` is
    // optional in the protocol types.
    const parsed = parseInboundMessage(message({ seq: 42 }, ['message_id']))

    expect(parsed?.messageId).toBe(42)
  })
})
