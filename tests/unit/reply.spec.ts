/**
 * Sending the agent's answer back to WeChat.
 *
 * The reply is built from the durable `assistant/message` event rather than the
 * live stream: the stream's chunks are process-local and dropped when nobody is
 * subscribed, while the committed event is what the session log holds. WeChat
 * has no replay, so a failed send is a lost message — which is why delivery
 * goes through a queue that can be retried rather than a bare awaited call.
 */

import { describe, expect, it, vi } from 'vitest'
import { ReplyQueue, extractAssistantText } from '../../src/bridge/reply.ts'

/** An assistant/message event as the session log records it. */
function assistantEvent(text: string, blocks?: unknown[]) {
  return {
    type: 'assistant/message',
    data: { message: { content: blocks ?? [{ type: 'text', text }] } },
  }
}

describe('extracting the reply text', () => {
  it('reads the text blocks of an assistant message', () => {
    expect(extractAssistantText(assistantEvent('hello') as never)).toBe('hello')
  })

  it('concatenates several text blocks in order', () => {
    expect(extractAssistantText(assistantEvent('', [
      { type: 'text', text: 'part one ' },
      { type: 'text', text: 'part two' },
    ]) as never)).toBe('part one part two')
  })

  it('ignores non-text blocks instead of failing on them', () => {
    // A turn that called a tool carries tool blocks alongside any prose.
    expect(extractAssistantText(assistantEvent('', [
      { type: 'tool-call', name: 'bash' },
      { type: 'text', text: 'done' },
    ]) as never)).toBe('done')
  })

  it('does not read text out of a block that is not a text block', () => {
    // Non-text blocks can carry a `text` field of their own - tool arguments,
    // for one. Reading by field rather than by discriminant would paste that
    // into the user's chat as if the model had said it.
    expect(extractAssistantText(assistantEvent('', [
      { type: 'tool-call', name: 'bash', text: 'SECRET-ARGS' },
      { type: 'text', text: 'the answer' },
    ]) as never)).toBe('the answer')
  })

  it('returns nothing for an event that is not an assistant message', () => {
    expect(extractAssistantText({ type: 'tool/result', data: {} } as never)).toBeUndefined()
  })

  it('returns nothing when the message has no text at all', () => {
    // A tool-only turn has no prose to send; sending an empty message would
    // show the user a blank bubble.
    expect(extractAssistantText(assistantEvent('', [{ type: 'tool-call', name: 'bash' }]) as never)).toBeUndefined()
  })
})

describe('the outbound queue', () => {
  it('sends a queued message', async () => {
    const sent: string[] = []
    const queue = new ReplyQueue({ send: async (_peerId, text) => void sent.push(text) })

    await queue.enqueue('user-7', 'hello')
    await queue.drain()

    expect(sent).toEqual(['hello'])
  })

  it('keeps the peer and token each reply belongs to', async () => {
    const calls: { peerId: string; text: string; contextToken: string | undefined }[] = []
    const queue = new ReplyQueue({
      send: async (peerId, text, contextToken) => void calls.push({ peerId, text, contextToken }),
    })

    await queue.enqueue('user-7', 'hello', 'ctx-1')
    await queue.drain()

    // The token is per-message and issued by the inbound message, so a reply
    // that drops it is unauthenticated for the conversation.
    expect(calls).toEqual([{ peerId: 'user-7', text: 'hello', contextToken: 'ctx-1' }])
  })

  it('preserves send order for one peer', async () => {
    const sent: string[] = []
    const queue = new ReplyQueue({
      send: async (_peerId, text) => {
        await new Promise(resolve => setTimeout(resolve, text === 'first' ? 20 : 1))
        sent.push(text)
      },
    })

    void queue.enqueue('user-7', 'first')
    void queue.enqueue('user-7', 'second')
    await queue.drain()

    expect(sent).toEqual(['first', 'second'])
  })

  it('retries a failed send instead of dropping it', async () => {
    // WeChat has no replay: a dropped send is a message the user never sees,
    // and nothing will re-deliver it.
    let attempts = 0
    const sent: string[] = []
    const queue = new ReplyQueue({
      send: async (_peerId, text) => {
        attempts += 1
        if (attempts < 2) throw new Error('network down')
        sent.push(text)
      },
      maxAttempts: 3,
      retryDelayMs: 0,
    })

    await queue.enqueue('user-7', 'hello')
    await queue.drain()

    expect(attempts).toBe(2)
    expect(sent).toEqual(['hello'])
  })

  it('gives up after the attempt limit and reports it', async () => {
    const onGiveUp = vi.fn()
    const queue = new ReplyQueue({
      send: async () => { throw new Error('always down') },
      maxAttempts: 2,
      retryDelayMs: 0,
      onGiveUp,
    })

    await queue.enqueue('user-7', 'hello')
    await queue.drain()

    expect(onGiveUp).toHaveBeenCalledWith('user-7', 'hello', expect.anything())
  })

  it('keeps serving other peers when one peer keeps failing', async () => {
    // One unreachable conversation must not silence every other user.
    const sent: string[] = []
    const queue = new ReplyQueue({
      send: async (peerId, text) => {
        if (peerId === 'bad') throw new Error('always down')
        sent.push(text)
      },
      maxAttempts: 2,
      retryDelayMs: 0,
    })

    void queue.enqueue('bad', 'never')
    await queue.enqueue('good', 'delivered')
    await queue.drain()

    expect(sent).toEqual(['delivered'])
  })

  it('does not send the same reply twice', async () => {
    // Retrying must repeat the attempt, not duplicate a delivery that already
    // succeeded on a retry.
    const sent: string[] = []
    let attempts = 0
    const queue = new ReplyQueue({
      send: async (_peerId, text) => {
        attempts += 1
        if (attempts === 1) throw new Error('first attempt fails')
        sent.push(text)
      },
      maxAttempts: 3,
      retryDelayMs: 0,
    })

    await queue.enqueue('user-7', 'once')
    await queue.drain()

    expect(sent).toEqual(['once'])
  })

  it('reports how much is still pending', async () => {
    const queue = new ReplyQueue({
      send: async () => { await new Promise(resolve => setTimeout(resolve, 10)) },
    })

    void queue.enqueue('user-7', 'a')
    void queue.enqueue('user-7', 'b')

    expect(queue.pending).toBe(2)
    await queue.drain()
    expect(queue.pending).toBe(0)
  })

  it('rejects an empty reply rather than sending a blank message', async () => {
    const sent: string[] = []
    const queue = new ReplyQueue({ send: async (_peerId, text) => void sent.push(text) })

    await queue.enqueue('user-7', '')
    await queue.drain()

    expect(sent).toEqual([])
  })
})
