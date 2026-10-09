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
