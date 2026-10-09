/**
 * The long-poll monitor.
 *
 * Two properties this file exists to guarantee, and both come from the plan's
 * Q36 decision:
 *
 *  - **Polling does not wait for processing.** A message that takes a minute to
 *    answer must not stop the next poll, or the user cannot interrupt the turn
 *    they just started.
 *  - **The cursor advances and survives.** `get_updates_buf` is the only thing
 *    standing between a reconnect and replaying every message ever sent, so it
 *    is saved as soon as the server returns one.
 *
 * The loop is driven against injected collaborators, so it is verified without
 * a network or real time.
 */

import { describe, expect, it } from 'vitest'
import { monitorLoop } from '../../src/channel/monitor.ts'

/** One poll response. */
function response(overrides: { msgs?: unknown[]; cursor?: string; ret?: number; errcode?: number } = {}) {
  return {
    ret: overrides.ret ?? 0,
    ...(overrides.errcode === undefined ? {} : { errcode: overrides.errcode }),
    msgs: overrides.msgs ?? [],
    get_updates_buf: overrides.cursor ?? 'cursor-1',
  }
}

/**
 * A monitor driven by a scripted sequence of responses.
 *
 * `stopAfter` ends the loop once that many polls have happened, which is how
 * these tests avoid depending on an abort that the loop also has to honour.
 */
function scripted(responses: ReturnType<typeof response>[], stopAfter = responses.length) {
  const polls: (string | undefined)[] = []
  const handled: unknown[] = []
  const saved: string[] = []
  let index = 0

  return {
    polls,
    handled,
    saved,
    run: () => monitorLoop({
      initialCursor: undefined,
      poll: async (cursor) => {
        polls.push(cursor)
        const next = responses[index] ?? response()
        index += 1
        return next
      },
      onMessage: async (message) => void handled.push(message),
      saveCursor: async (cursor) => void saved.push(cursor),
      shouldStop: () => index >= stopAfter,
      sleep: async () => {},
      now: () => 0,
      pollTimeoutMs: 60_000,
    }),
  }
}

describe('the poll loop', () => {
  it('carries the cursor the server returned into the next poll', async () => {
    // Without this the server replays from the beginning on every poll.
    const script = scripted([response({ cursor: 'c1' }), response({ cursor: 'c2' })])

    await script.run()

    expect(script.polls).toEqual([undefined, 'c1'])
  })

  it('saves each cursor the server returns', async () => {
    const script = scripted([response({ cursor: 'c1' }), response({ cursor: 'c2' })])

    await script.run()

    expect(script.saved).toEqual(['c1', 'c2'])
  })

  it('keeps the previous cursor when a response carries none', async () => {
    // An empty cursor is "no change", not "reset to the beginning"; treating it
    // as a reset would replay the conversation.
    const script = scripted([response({ cursor: 'c1' }), response({ cursor: '' }), response({ cursor: 'c3' })])

    await script.run()

    expect(script.polls).toEqual([undefined, 'c1', 'c1'])
    expect(script.saved).toEqual(['c1', 'c3'])
  })

  it('starts from a previously saved cursor', async () => {
    const polls: (string | undefined)[] = []
    await monitorLoop({
      initialCursor: 'saved-cursor',
      poll: async (cursor) => {
        polls.push(cursor)
        return response({ cursor: 'saved-cursor' })
      },
      onMessage: async () => {},
      saveCursor: async () => {},
      shouldStop: () => polls.length >= 1,
      sleep: async () => {},
      now: () => 0,
      pollTimeoutMs: 60_000,
    })

    expect(polls).toEqual(['saved-cursor'])
  })

  it('hands every message the server returned to the handler', async () => {
    const script = scripted([response({ msgs: [{ message_id: 1 }, { message_id: 2 }] })])

    await script.run()

    expect(script.handled).toEqual([{ message_id: 1 }, { message_id: 2 }])
  })
})

describe('polling does not wait for processing', () => {
  it('polls again while an earlier message is still being handled', async () => {
    // Q36: the long poll and the work are decoupled, so a slow turn cannot stop
    // the channel from receiving the user's next message.
    const order: string[] = []
    let polls = 0
    let releaseSlow: () => void = () => {}
    const slow = new Promise<void>(resolve => { releaseSlow = resolve })

    await monitorLoop({
      initialCursor: undefined,
      poll: async () => {
        polls += 1
        order.push(`poll-${polls}`)
        return response({ msgs: [{ message_id: polls }], cursor: `c${polls}` })
      },
      onMessage: async (message) => {
        const id = (message as { message_id: number }).message_id
        if (id === 1) {
          order.push('handle-1-start')
          await slow
          order.push('handle-1-end')
        }
      },
      saveCursor: async () => {},
      // Stop after the second poll has been issued, which can only happen if
      // the first message's handler did not block it.
      shouldStop: () => polls >= 2,
      sleep: async () => {},
      now: () => 0,
      pollTimeoutMs: 60_000,
    })

    releaseSlow()
    expect(order).toContain('poll-2')
  })

  it('routes each message through the queue instead of calling the handler directly', async () => {
    // Serialization itself belongs to the session map; what the monitor owes is
    // routing every message through it, or the queue is bypassed entirely.
    const routed: unknown[] = []
    const handled: unknown[] = []
    let polls = 0
    await monitorLoop({
      initialCursor: undefined,
      poll: async () => {
        polls += 1
        return response({ msgs: [{ message_id: 1 }], cursor: `c${polls}` })
      },
      onMessage: async (message) => void handled.push(message),
      serialize: async (message, work) => {
        routed.push(message)
        await work()
      },
      saveCursor: async () => {},
      shouldStop: () => polls >= 1,
      sleep: async () => {},
      now: () => 0,
      pollTimeoutMs: 60_000,
    })

    expect(routed).toEqual([{ message_id: 1 }])
    expect(handled).toEqual([{ message_id: 1 }])
  })
})

describe('failures', () => {
  it('keeps polling after a transport failure', async () => {
    // The poll is a 35-second long poll, so a gateway timeout is routine and
    // must not end the channel.
    let attempts = 0
    const handled: unknown[] = []
    await monitorLoop({
      initialCursor: undefined,
      poll: async () => {
        attempts += 1
        if (attempts === 1) throw new Error('gateway timeout')
        return response({ msgs: [{ message_id: 9 }] })
      },
      onMessage: async (message) => void handled.push(message),
      saveCursor: async () => {},
      shouldStop: () => attempts >= 2,
      sleep: async () => {},
      now: () => 0,
      pollTimeoutMs: 60_000,
    })

    expect(handled).toEqual([{ message_id: 9 }])
  })

  it('does not advance the cursor when the poll failed', async () => {
    // The cursor addresses messages, not polls; advancing it on a failure would
    // skip whatever that poll would have returned. The follow-up poll carries
    // no new cursor, so nothing at all should be saved.
    const saved: string[] = []
    const polls: (string | undefined)[] = []
    let attempts = 0
    await monitorLoop({
      initialCursor: 'keep-me',
      poll: async (cursor) => {
        polls.push(cursor)
        attempts += 1
        if (attempts === 1) throw new Error('boom')
        return response({ cursor: '' })
      },
      onMessage: async () => {},
      saveCursor: async (cursor) => void saved.push(cursor),
      shouldStop: () => attempts >= 2,
      sleep: async () => {},
      now: () => 0,
      pollTimeoutMs: 60_000,
    })

    expect(saved).toEqual([])
    // The failed poll must not have disturbed the cursor either.
    expect(polls).toEqual(['keep-me', 'keep-me'])
  })

  it('reports a message handler failure without ending the loop', async () => {
    // One bad message must not take the channel down - and its failure must
    // surface, since a swallowed one is indistinguishable from a message that
    // was never delivered.
    let polls = 0
    const seen: unknown[] = []
    const reported: { error: unknown; message: unknown }[] = []
    await monitorLoop({
      initialCursor: undefined,
      poll: async () => {
        polls += 1
        return response({ msgs: [{ message_id: polls }], cursor: `c${polls}` })
      },
      onMessage: async (message) => {
        seen.push(message)
        if ((message as { message_id: number }).message_id === 1) throw new Error('handler failed')
      },
      onMessageError: (error, message) => void reported.push({ error, message }),
      saveCursor: async () => {},
      shouldStop: () => polls >= 2,
      sleep: async () => {},
      now: () => 0,
      pollTimeoutMs: 60_000,
    })

    expect(seen).toHaveLength(2)
    expect(reported).toHaveLength(1)
    expect((reported[0]?.error as Error).message).toBe('handler failed')
    expect(reported[0]?.message).toEqual({ message_id: 1 })
  })

  it('stops at the deadline rather than polling forever', async () => {
    let clock = 0
    let polls = 0
    await monitorLoop({
      initialCursor: undefined,
      poll: async () => {
        polls += 1
        return response()
      },
      onMessage: async () => {},
      saveCursor: async () => {},
      shouldStop: () => false,
      sleep: async (ms: number) => { clock += ms },
      now: () => clock,
      pollTimeoutMs: 1_000,
      maxRunMs: 5_000,
    })

    expect(polls).toBeGreaterThan(0)
    expect(clock).toBeLessThanOrEqual(5_000)
  })
})

describe('abort', () => {
  it('stops promptly when aborted, without waiting for the poll to return', async () => {
    // A stop that waits for a 35-second long poll would look hung.
    const controller = new AbortController()
    let polls = 0
    const run = monitorLoop({
      initialCursor: undefined,
      poll: async () => {
        polls += 1
        // Never returns; only the abort can end this loop.
        return new Promise<never>(() => {})
      },
      onMessage: async () => {},
      saveCursor: async () => {},
      shouldStop: () => false,
      signal: controller.signal,
      sleep: async () => {},
      now: () => 0,
      pollTimeoutMs: 60_000,
    })

    await new Promise(resolve => setTimeout(resolve, 5))
    controller.abort()
    await expect(Promise.race([run, new Promise(resolve => setTimeout(() => resolve('timeout'), 200))]))
      .resolves.not.toBe('timeout')
    expect(polls).toBe(1)
  })
})

describe('long-poll timeout', () => {
  it('adopts the timeout the server suggests', async () => {
    // The server can lower it; ignoring the hint keeps a fixed 35s cadence.
    const timeouts: (number | undefined)[] = []
    let polls = 0
    await monitorLoop({
      initialCursor: undefined,
      poll: async (_cursor, timeoutMs) => {
        timeouts.push(timeoutMs)
        polls += 1
        return { ...response(), longpolling_timeout_ms: 12_345 }
      },
      onMessage: async () => {},
      saveCursor: async () => {},
      shouldStop: () => polls >= 2,
      sleep: async () => {},
      now: () => 0,
      pollTimeoutMs: 35_000,
    })

    expect(timeouts).toEqual([35_000, 12_345])
  })
})
