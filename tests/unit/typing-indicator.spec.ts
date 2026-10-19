/**
 * The indicator during one turn.
 *
 * Two properties decide whether this is usable in practice: it must not outlive
 * its turn (a bot stuck on "typing" reads as hung), and it must never prevent a
 * reply. The renewal interval comes from the reference client's five seconds,
 * which is also the evidence that a single report does not persist.
 */

import { describe, expect, it, vi } from 'vitest'
import { createTypingIndicator } from '../../src/channel/typing-indicator.ts'

/** A controllable clock and the timers registered against it. */
function timers() {
  const scheduled: { work: () => void | Promise<void>; ms: number; handle: object }[] = []
  const cancelled: object[] = []
  return {
    scheduled,
    cancelled,
    schedule: (work: () => void | Promise<void>, ms: number) => {
      const handle = { id: scheduled.length }
      scheduled.push({ work, ms, handle })
      return handle as never
    },
    cancelSchedule: (handle: ReturnType<typeof setInterval>) => { cancelled.push(handle) },
  }
}

/** An indicator over recording collaborators. */
function bench(options: {
  ticket?: (userId: string) => Promise<string>
  report?: (params: { userId: string; ticket: string; status: number }) => Promise<void>
} = {}) {
  const reports: { userId: string; ticket: string; status: number }[] = []
  const invalidated: string[] = []
  const errors: unknown[] = []
  const t = timers()
  const indicator = createTypingIndicator({
    ticket: options.ticket ?? (async () => 't-1'),
    report: options.report ?? (async params => { reports.push(params) }),
    invalidate: userId => { invalidated.push(userId) },
    schedule: t.schedule,
    cancelSchedule: t.cancelSchedule,
    onError: error => { errors.push(error) },
  })
  return { indicator, reports, invalidated, errors, timers: t }
}

describe('showing the indicator', () => {
  it('reports the typing status with the user’s ticket', async () => {
    const b = bench()

    await b.indicator.start('user-7')

    expect(b.reports).toEqual([{ userId: 'user-7', ticket: 't-1', status: 1 }])
  })

  it('does nothing at all when there is no ticket', async () => {
    // A deployment without the ticket endpoint, or a user whose fetch failed,
    // must not produce a status report with an empty ticket in it.
    const b = bench({ ticket: async () => '' })

    await b.indicator.start('user-7')

    expect(b.reports).toEqual([])
    expect(b.timers.scheduled).toEqual([])
  })

  it('renews on the reference client’s five-second interval', async () => {
    // The indicator expires, so one report is not enough for a turn that runs
    // for a minute.
    const b = bench()

    await b.indicator.start('user-7')

    expect(b.timers.scheduled).toHaveLength(1)
    expect(b.timers.scheduled[0]?.ms).toBe(5_000)
  })

  it('re-reports when the renewal fires', async () => {
    const b = bench()
    await b.indicator.start('user-7')

    await b.timers.scheduled[0]?.work()

    expect(b.reports).toHaveLength(2)
  })
})

describe('withdrawing the indicator', () => {
  it('reports the cancel status and stops renewing', async () => {
    const b = bench()
    await b.indicator.start('user-7')

    await b.indicator.stop('user-7')

    expect(b.reports.at(-1)).toEqual({ userId: 'user-7', ticket: 't-1', status: 2 })
    expect(b.timers.cancelled).toHaveLength(1)
  })

  it('does nothing for a turn that never showed one', async () => {
    const b = bench({ ticket: async () => '' })
    await b.indicator.start('user-7')

    await b.indicator.stop('user-7')

    expect(b.reports).toEqual([])
  })

  it('does not renew after the turn ended, even if a tick was already queued', async () => {
    // The timer callback can run after `stop` in the same event loop turn. A
    // renewal that fired then would leave the indicator on with nobody to
    // withdraw it.
    const b = bench()
    await b.indicator.start('user-7')
    const tick = b.timers.scheduled[0]?.work
    await b.indicator.stop('user-7')

    await tick?.()

    expect(b.reports.map(report => report.status)).toEqual([1, 2])
  })
})

describe('failures', () => {
  it('drops a ticket the first report was refused with', async () => {
    // A refusal is the only evidence a cached ticket went stale before its
    // deadline. Continuing to renew it would keep sending a known-bad value.
    const b = bench({ report: async () => { throw new Error('bad ticket') } })

    await b.indicator.start('user-7')

    expect(b.invalidated).toEqual(['user-7'])
    expect(b.timers.scheduled).toEqual([])
    expect(b.errors).toHaveLength(1)
  })

  it('stops renewing when a later report is refused', async () => {
    let calls = 0
    const b = bench({
      report: async () => {
        calls += 1
        if (calls > 1) throw new Error('expired')
      },
    })
    await b.indicator.start('user-7')

    await b.timers.scheduled[0]?.work()

    expect(b.invalidated).toEqual(['user-7'])
    expect(b.timers.cancelled).toHaveLength(1)
  })

  it('never rejects out of start or stop', async () => {
    // Both run inside a live turn. A rejection here would turn a decoration
    // failure into a failed reply.
    const b = bench({
      ticket: async () => { throw new Error('offline') },
      report: async () => { throw new Error('refused') },
    })

    await expect(b.indicator.start('user-7')).resolves.toBeUndefined()
    await expect(b.indicator.stop('user-7')).resolves.toBeUndefined()
  })

  it('replaces a previous indicator for the same user instead of stacking timers', async () => {
    // The status is per user, so two renewals would only race each other.
    const b = bench()
    await b.indicator.start('user-7')
    await b.indicator.start('user-7')

    expect(b.timers.scheduled).toHaveLength(2)
    expect(b.timers.cancelled).toHaveLength(1)
  })
})
