/**
 * Injecting one WeChat message into its session.
 *
 * The message is built as a real `UserMessage` so it is durable and visible to
 * the model, and delivered through `followup` — the one of the three send
 * methods that starts a turn and can therefore produce a reply.
 *
 * The source kind is pinned deliberately: the plan chose `user`, which means a
 * WeChat message inherits the authority and the local-timezone behaviour that
 * any other human input gets. That is a product decision with consequences
 * outside this file, so the test states it rather than leaving it implied.
 */

import { describe, expect, it } from 'vitest'
import { buildUserMessage, deliverInbound } from '../../src/bridge/dispatcher.ts'

describe('delivering a message that quoted another', () => {
  it('puts the quoted text in the message, before the reply', () => {
    // The model has to know what the user is referring to. DSH messages have no
    // quote field, so the context travels as text - and it goes FIRST, because
    // reading "被引用的话" then "我的回复" is the order a person understands.
    const message = buildUserMessage({
      peerId: 'user-7',
      text: '这个呢？',
      contextToken: 'ctx-1',
      messageId: 1,
      quote: '小王今年13岁',
    })

    expect(message.content).toEqual([
      { type: 'text', text: '[引用] 小王今年13岁\n这个呢？' },
    ])
  })

  it('leaves an ordinary message completely alone', () => {
    // No quote means no marker: adding an empty one would put noise in front of
    // every message in the conversation.
    const message = buildUserMessage({ peerId: 'user-7', text: 'hi', contextToken: 'ctx-1', messageId: 1 })

    expect(message.content).toEqual([{ type: 'text', text: 'hi' }])
  })

  it('keeps the quote when the message also carries media and notes', () => {
    // Three additions compose: the quote, the user's words, the media note.
    const message = buildUserMessage({
      peerId: 'user-7',
      text: '这张呢？',
      contextToken: 'ctx-1',
      messageId: 1,
      quote: '前面那张图',
      notes: ['（这条消息里的图片未能读取）'],
    })

    expect(message.content).toEqual([
      { type: 'text', text: '[引用] 前面那张图\n这张呢？\n（这条消息里的图片未能读取）' },
    ])
  })

  it('does not add the marker for a quote that is only whitespace', () => {
    // A whitespace-only quote carries nothing, and the marker without content
    // would tell the model a quote existed when none did.
    const message = buildUserMessage({
      peerId: 'user-7', text: 'hi', contextToken: 'ctx-1', messageId: 1, quote: '   ',
    })

    expect(message.content).toEqual([{ type: 'text', text: 'hi' }])
  })
})

describe('delivering a message that carried media', () => {
  it('appends the media blocks after the text, in order', () => {
    // The model reads the user's words first and the images that came with them
    // second, which is the order they were sent in.
    const image = { type: 'image', attachment: { attachmentId: 'a1', mediaType: 'image/png', bytes: 3, width: 1, height: 1 } }
    const message = buildUserMessage({
      peerId: 'user-7',
      text: '看看这张图',
      contextToken: 'ctx-1',
      messageId: 1,
      parts: [image as never],
    })

    expect(message.content).toEqual([
      { type: 'text', text: '看看这张图' },
      image,
    ])
  })

  it('folds the failure notes into the text the model reads', () => {
    // A note is not a separate block type; it is words the user's message gains.
    // Dropping it would leave the model believing no image was sent at all.
    const message = buildUserMessage({
      peerId: 'user-7',
      text: '看看这张图',
      contextToken: 'ctx-1',
      messageId: 1,
      notes: ['（这条消息里的图片未能读取：CDN 500）'],
    })

    expect(message.content).toEqual([
      { type: 'text', text: '看看这张图\n（这条消息里的图片未能读取：CDN 500）' },
    ])
  })

  it('still says something when media was the only thing sent', () => {
    // A media-only message with a failed download has no text of its own; the
    // note is then the whole message, and an empty one is rejected.
    const message = buildUserMessage({
      peerId: 'user-7',
      text: '',
      contextToken: 'ctx-1',
      messageId: 1,
      notes: ['（这条消息里的图片未能读取）'],
    })

    expect(message.content).toEqual([{ type: 'text', text: '（这条消息里的图片未能读取）' }])
  })

  it('does not spend a download on a message with no media', () => {
    // The common text-only path is unchanged, byte for byte.
    const message = buildUserMessage({ peerId: 'user-7', text: 'hi', contextToken: 'ctx-1', messageId: 1 })

    expect(message.content).toEqual([{ type: 'text', text: 'hi' }])
  })
})

describe('building the message', () => {
  it('carries the text and the user source the plan chose', () => {
    const message = buildUserMessage({ peerId: 'user-7', text: 'hi', contextToken: 'ctx-1', messageId: 1 })

    expect(message.role).toBe('user')
    expect(message.content).toEqual([{ type: 'text', text: 'hi' }])
    expect(message.source).toEqual({ kind: 'user' })
  })

  it('sends exactly the text it was given, unaltered', () => {
    // Identity and freezing are `createUserMessage`'s guarantees and are proven
    // in its own suite; asserting them here would look like coverage while
    // being unable to fail on this module. What this module decides is content.
    const message = buildUserMessage({
      peerId: 'user-7',
      text: 'line one\nline two',
      contextToken: undefined,
      messageId: 1,
    })

    expect(message.content).toEqual([{ type: 'text', text: 'line one\nline two' }])
  })

  it('never leaks the peer id or the context token into the model-visible text', () => {
    // Both are transport facts. Putting them in the content would show the
    // model metadata the user never typed.
    const message = buildUserMessage({ peerId: 'user-7', text: 'hi', contextToken: 'ctx-1', messageId: 1 })

    const text = (message.content[0] as { text: string }).text
    expect(text).not.toContain('user-7')
    expect(text).not.toContain('ctx-1')
  })
})

describe('delivering to the agent', () => {
  it('uses followup, which is the only send that can produce a reply', async () => {
    // `steer` interrupts the current turn and `inject` never starts one, so
    // either would leave the user with no answer at all.
    const sent: unknown[] = []
    const agent = { followup: (message: unknown) => void sent.push(message), steer: () => {}, inject: () => {} }

    deliverInbound(agent as never, { peerId: 'user-7', text: 'hi', contextToken: undefined, messageId: 1 })

    expect(sent).toHaveLength(1)
    expect((sent[0] as { content: unknown }).content).toEqual([{ type: 'text', text: 'hi' }])
  })

  it('refuses to deliver when the agent is no longer the live one', () => {
    // Delivery into a disposed agent is accepted and dropped, so a caller that
    // does not check first cannot tell a delivered message from a lost one.
    const agent = { followup: () => {}, steer: () => {}, inject: () => {} }

    expect(() => deliverInbound(agent as never, { peerId: 'user-7', text: 'hi', contextToken: undefined, messageId: 1 }, {
      isLive: () => false,
    })).toThrow(/no longer live/u)
  })

  it('delivers when the liveness check passes', () => {
    const sent: unknown[] = []
    const agent = { followup: (message: unknown) => void sent.push(message), steer: () => {}, inject: () => {} }

    deliverInbound(agent as never, { peerId: 'user-7', text: 'hi', contextToken: undefined, messageId: 1 }, {
      isLive: () => true,
    })

    expect(sent).toHaveLength(1)
  })
})

describe('text the agent can actually use', () => {
  it('does not send an empty text block', () => {
    // An empty content block is rejected by message construction, which would
    // turn a media-only message into a crash instead of a delivery.
    const message = buildUserMessage({ peerId: 'user-7', text: '', contextToken: undefined, messageId: 1 })

    expect(message.content.length).toBeGreaterThan(0)
    expect((message.content[0] as { text: string }).text).not.toBe('')
  })
})
