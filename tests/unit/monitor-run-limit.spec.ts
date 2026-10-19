/**
 * How long the loop is willing to keep polling.
 *
 * The loop used to carry a hardcoded 24-hour deadline, and the production wiring
 * never overrode it. A channel that is supposed to answer whenever the process
 * is up therefore went silent one day after boot, with no error - the loop
 * simply returned, which reads exactly like a quiet night. These cases pin the
 * two halves of the fix: the limit still works when a caller asks for one, and
 * an ordinary deployment does not acquire one by default.
 */

import { describe, expect, it } from 'vitest'
import { DEFAULT_MAX_RUN_MS, monitorLoop } from '../../src/channel/monitor.ts'

/** A response with nothing in it, so the loop only spends time sleeping. */
const emptyResponse = () => ({ msgs: [], get_updates_buf: undefined })

describe('the run limit', () => {
  it('does not impose a default limit on an ordinary deployment', () => {
    // A finite default is what made the channel stop by itself. `Infinity` here
    // means "no deadline"; the loop still ends on its own signal.
    expect(DEFAULT_MAX_RUN_MS).toBe(Infinity)
  })

  it('honours an explicit limit', async () => {
    // The limit is still a supported test and defence seam; only the default
    // changed. A caller that names one must still be obeyed.
    let clock = 0
    let polls = 0
    await monitorLoop({
      initialCursor: undefined,
      poll: async () => {
        polls += 1
        return emptyResponse()
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

  it('keeps polling when no limit was asked for, until stopped', async () => {
    // The user-visible half: a deployment that names no limit must not stop by
    // itself. A finite clock cannot run forever, so the loop is stopped by its
    // own predicate after enough polls to prove no deadline interrupted it.
    let clock = 0
    let polls = 0
    await monitorLoop({
      initialCursor: undefined,
      poll: async () => {
        polls += 1
        return emptyResponse()
      },
      onMessage: async () => {},
      saveCursor: async () => {},
      shouldStop: () => polls >= 50,
      sleep: async (ms: number) => { clock += ms },
      now: () => clock,
      pollTimeoutMs: 1_000,
    })

    expect(polls).toBe(50)
  })
})
