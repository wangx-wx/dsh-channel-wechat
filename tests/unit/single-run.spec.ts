/**
 * One polling run at a time.
 *
 * Two independent paths start the channel: the boot, which reads whatever login
 * is stored, and the login panel, which connects an account that was not there
 * when the boot ran. Left alone they overlap, and two loops polling the same
 * account deliver every message twice - a failure that shows up as duplicated
 * replies in WeChat, with nothing in the logs to connect it to the second start.
 */

import { describe, expect, it, vi } from 'vitest'
import { createSingleRun } from '../../src/channel/single-run.ts'

describe('one polling run at a time', () => {
  it('launches a run and reports it live', () => {
    const launch = vi.fn()
    const run = createSingleRun({ launch })

    run.start()

    expect(launch).toHaveBeenCalledOnce()
    expect(run.live()).toBe(true)
  })

  it('refuses a second run while one is live', () => {
    // The boot starts the channel from the stored login; the panel starts it
    // again when a *new* account connects. Refusing by default is what keeps two
    // loops off one account.
    const launch = vi.fn()
    const run = createSingleRun({ launch })

    run.start()
    run.start()

    expect(launch).toHaveBeenCalledOnce()
  })

  it('ends the live run before replacing it when forced', async () => {
    // The panel's case: the account it just connected is not the one the boot
    // started with, so the old loop has to stop rather than keep polling an
    // account that was replaced.
    const signals: AbortSignal[] = []
    const run = createSingleRun({ launch: signal => { signals.push(signal) } })

    await run.start()
    const first = signals[0]
    await run.start({ force: true })

    expect(signals).toHaveLength(2)
    expect(first?.aborted).toBe(true)
    expect(signals[1]?.aborted).toBe(false)
  })

  it('waits for the previous run to settle before starting its replacement', async () => {
    // Aborting is not stopping. A replacement that began on the abort alone
    // polled alongside the run it replaced: two loops over one account, two
    // writers of one cursor, and a session created by one whose handle only the
    // other could see - which the user experiences as "my message got no reply".
    const order: string[] = []
    let finishFirst: () => void = () => {}
    const run = createSingleRun({
      launch: async signal => {
        const index = order.filter(entry => entry.startsWith('launch')).length
        order.push(`launch${String(index + 1)}`)
        if (index > 0) return
        signal.addEventListener('abort', () => { order.push('aborted1') }, { once: true })
        await new Promise<void>(resolve => { finishFirst = resolve })
        order.push('settled1')
      },
    })

    await run.start()
    const replacing = run.start({ force: true })

    // Still the first run's teardown: nothing of the second has begun.
    await Promise.resolve()
    expect(order).toEqual(['launch1', 'aborted1'])

    finishFirst()
    await replacing

    expect(order).toEqual(['launch1', 'aborted1', 'settled1', 'launch2'])
  })

  it('allows a new run after the previous one was stopped', () => {
    const launch = vi.fn()
    const run = createSingleRun({ launch })

    run.start()
    run.stop()
    run.start()

    expect(launch).toHaveBeenCalledTimes(2)
    expect(run.live()).toBe(true)
  })

  it('aborts the live signal when stopped', () => {
    // The run's own loop watches this signal; a stop that only forgot the
    // controller would leave the poll running against a dead plugin.
    let signal: AbortSignal | undefined
    const run = createSingleRun({ launch: value => { signal = value } })

    run.start()
    run.stop()

    expect(signal?.aborted).toBe(true)
    expect(run.live()).toBe(false)
  })

  it('is not left live when the run ends on its own', async () => {
    // A loop can finish without anyone stopping it - the run limit, a poll that
    // decided to give up. Leaving `current` in place made `live()` claim the
    // channel was running and every later start return early, so the only way
    // to bring it back was to restart the process.
    let finish: () => void = () => {}
    const run = createSingleRun({ launch: () => new Promise<void>(resolve => { finish = resolve }) })

    await run.start()
    expect(run.live()).toBe(true)

    finish()
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(run.live()).toBe(false)
  })

  it('starts again after a run ended on its own', async () => {
    // The half that matters to a user: the state must not merely read as free,
    // a later start has to actually launch.
    let finish: () => void = () => {}
    const launch = vi.fn(() => new Promise<void>(resolve => { finish = resolve }))
    const run = createSingleRun({ launch })

    await run.start()
    finish()
    await new Promise(resolve => setTimeout(resolve, 0))
    await run.start()

    expect(launch).toHaveBeenCalledTimes(2)
    expect(run.live()).toBe(true)
  })

  it('is not left live when the launch throws', () => {
    // A launch failure the caller swallows must not wedge the channel: a run
    // marked live that never started would refuse every later start, so the
    // plugin would be dead until DSH restarted.
    const onError = vi.fn()
    const run = createSingleRun({
      launch: () => { throw new Error('nope') },
      onError,
    })

    run.start()

    expect(onError).toHaveBeenCalledOnce()
    expect(run.live()).toBe(false)
  })
})
