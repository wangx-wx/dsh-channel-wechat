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
import { ReplyQueue, THROTTLE_CODE, extractAssistantText } from '../../src/bridge/reply.ts'

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

  it('does not send a message that also calls a tool', () => {
    // The model commits one message per step, and most steps announce what they
    // are about to do and then do it. The prose introduces tool arguments the
    // chat never sees, so delivered alone it ends on a colon and nothing after
    // it - the exact shape a user reported seeing.
    expect(extractAssistantText(assistantEvent('', [
      { type: 'tool-call', name: 'bash' },
      { type: 'text', text: 'now the parser:' },
    ]) as never)).toBeUndefined()
  })

  it('does not read text out of a block that is not a text block', () => {
    // Non-text blocks can carry a `text` field of their own - tool arguments,
    // for one. Reading by field rather than by discriminant would paste that
    // into the user's chat as if the model had said it. `reasoning` is used here
    // rather than `tool-call` so the tool-call rule above does not mask this one.
    expect(extractAssistantText(assistantEvent('', [
      { type: 'reasoning', text: 'SECRET-ARGS' },
      { type: 'text', text: 'the answer' },
    ]) as never)).toBe('the answer')
  })

  it('returns nothing for a turn that was interrupted', () => {
    // An aborted stream still commits what it had accumulated, flagged
    // `interrupted: true` (`agent-loop` settles it from `interruptedBlocks()`).
    // That text is half a sentence cut off mid-thought: sending it after
    // `/stop` reads as the answer, and the user cannot tell it was truncated.
    expect(extractAssistantText({
      type: 'assistant/message',
      data: {
        message: { content: [{ type: 'text', text: 'I was about to expl' }] },
        interrupted: true,
      },
    } as never)).toBeUndefined()
  })

  it('still sends a complete message that carries an explicit interrupted flag of false', () => {
    // Only `true` is the interrupted case; an event that states it is complete
    // is an ordinary answer.
    expect(extractAssistantText({
      type: 'assistant/message',
      data: {
        message: { content: [{ type: 'text', text: 'the answer' }] },
        interrupted: false,
      },
    } as never)).toBe('the answer')
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

describe('a throttled send', () => {
  /** The error the server answers a burst with: HTTP 200, `ret: -2`. */
  function throttle(): Error {
    return Object.assign(new Error('sendmessage: -2 prepare failed'), { code: THROTTLE_CODE })
  }

  it('is retried rather than counted as a failed message', async () => {
    // The server is asking for a slower sender, not rejecting the message. The
    // same send goes through once it waits, so it must not consume the ordinary
    // failure budget.
    let attempts = 0
    const sent: string[] = []
    const queue = new ReplyQueue({
      send: async (_peerId, text) => {
        attempts += 1
        if (attempts <= 2) throw throttle()
        sent.push(text)
      },
      maxAttempts: 1,
      maxThrottleAttempts: 3,
      sleep: async () => {},
    })

    await queue.enqueue('user-7', 'the answer')
    await queue.drain()

    expect(sent).toEqual(['the answer'])
  })

  it('waits longer after each throttle', async () => {
    // A fixed short delay is what lost the reply this was written for: a `-2`
    // retried after one second is still inside the window that produced it.
    const waits: number[] = []
    let attempts = 0
    const queue = new ReplyQueue({
      send: async () => {
        attempts += 1
        if (attempts <= 3) throw throttle()
      },
      maxAttempts: 1,
      maxThrottleAttempts: 4,
      sleep: async ms => void waits.push(ms),
    })

    await queue.enqueue('user-7', 'x')
    await queue.drain()

    expect(waits).toEqual([2_000, 4_000, 8_000])
  })

  it('gives up after its own budget and reports the reply', async () => {
    const onGiveUp = vi.fn()
    let attempts = 0
    const queue = new ReplyQueue({
      send: async () => { attempts += 1; throw throttle() },
      maxAttempts: 3,
      maxThrottleAttempts: 2,
      sleep: async () => {},
      onGiveUp,
    })

    await queue.enqueue('user-7', 'never delivered')
    await queue.drain()

    // Two throttled attempts, not the three ordinary ones: the budgets are
    // separate, so a permanent throttle stops at its own count.
    expect(attempts).toBe(2)
    expect(onGiveUp).toHaveBeenCalledWith('user-7', 'never delivered', expect.anything())
  })

  it('does not treat an ordinary failure as a throttle', async () => {
    // `-14` (suspended account) and a throttle look alike to a naive check; only
    // `-2` means "wait".
    let attempts = 0
    const queue = new ReplyQueue({
      send: async () => {
        attempts += 1
        throw Object.assign(new Error('sendmessage: -14 suspended'), { code: -14 })
      },
      maxAttempts: 3,
      maxThrottleAttempts: 5,
      sleep: async () => {},
    })

    await queue.enqueue('user-7', 'x')
    await queue.drain()

    expect(attempts).toBe(3)
  })
})

describe('pacing sends', () => {
  it('holds the second send until the interval has passed', async () => {
    // Pacing is proactive where the retry is reactive: by the time the server
    // answers `-2`, the burst has already been refused.
    let clock = 0
    const waits: number[] = []
    const sent: string[] = []
    const queue = new ReplyQueue({
      send: async (_peerId, text) => {
        sent.push(text)
        clock += 100
      },
      minIntervalMs: 1_000,
      now: () => clock,
      sleep: async ms => { waits.push(ms); clock += ms },
    })

    await queue.enqueue('user-7', 'first')
    await queue.drain()
    await queue.enqueue('user-7', 'second')
    await queue.drain()

    // The first send completes at t=100 and is stamped there; the second send
    // starts at t=100, so it waits the full interval rather than the remainder.
    expect(waits).toEqual([1_000])
    expect(sent).toEqual(['first', 'second'])
  })

  it('paces each peer separately', async () => {
    // A busy conversation must not delay a quiet one.
    let clock = 0
    const waits: number[] = []
    const queue = new ReplyQueue({
      send: async () => { clock += 100 },
      minIntervalMs: 1_000,
      now: () => clock,
      sleep: async ms => { waits.push(ms); clock += ms },
    })

    await queue.enqueue('busy', 'one')
    await queue.drain()
    await queue.enqueue('quiet', 'two')
    await queue.drain()

    expect(waits).toEqual([])
  })

  it('does not wait when pacing is off', async () => {
    const waits: number[] = []
    const queue = new ReplyQueue({
      send: async () => {},
      sleep: async ms => void waits.push(ms),
    })

    await queue.enqueue('user-7', 'a')
    await queue.drain()
    await queue.enqueue('user-7', 'b')
    await queue.drain()

    expect(waits).toEqual([])
  })
})
