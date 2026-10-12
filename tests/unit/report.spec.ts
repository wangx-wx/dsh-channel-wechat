/**
 * Where a channel's problems are reported.
 *
 * The channel reported everything through `ctx.logger`, and no profile mounts a
 * console exporter for the named logger. Every diagnostic was therefore
 * invisible: a failed inbound message, a failed reply, a rejected credential
 * write. Two live defects were found only after temporarily replacing those calls
 * with `console.error`, and one of them - every restart silently dropping every
 * message - had been "reported" to a log nobody could read.
 *
 * A report now has to reach a person running `dsh`, not only a sink that may not
 * be mounted.
 */

import { describe, expect, it, vi } from 'vitest'
import { createReporter } from '../../src/channel/report.ts'

/** A logger that records what it was asked to log. */
function recordingLogger() {
  const calls: { format: string; args: unknown[] }[] = []
  return {
    calls,
    logger: { warn: (format: string, ...args: unknown[]) => { calls.push({ format, args }) } },
  }
}

describe('reporting a problem', () => {
  it('writes a line a person running dsh can see', () => {
    // The whole point: the channel runs in a process whose stdout is what the
    // user is looking at, and the named logger reaches nothing there.
    const written: string[] = []
    const report = createReporter({ logger: recordingLogger().logger, write: line => written.push(line) })

    report('inbound message failed', new Error('boom'))

    expect(written).toEqual(['[channel-wechat] inbound message failed: boom'])
  })

  it('also goes to the logger, so a GUI sink can collect it', () => {
    // Dropping the logger call would trade one blind spot for another: a GUI or
    // an operator's sink reads the logger and never the console.
    const { calls, logger } = recordingLogger()
    const report = createReporter({ logger, write: () => {} })

    report('reply failed', new Error('nope'))

    expect(calls).toHaveLength(1)
    expect(calls[0]?.args).toEqual(['reply failed', 'nope'])
  })

  it('renders a thrown non-Error rather than printing nothing', () => {
    // A rejection is not always an Error, and `String(undefined)` would produce a
    // line reading "undefined" that says nothing about what happened.
    const written: string[] = []
    const report = createReporter({ logger: recordingLogger().logger, write: line => written.push(line) })

    report('channel stopped', 'socket closed')

    expect(written).toEqual(['[channel-wechat] channel stopped: socket closed'])
  })

  it('writes to stderr by default', () => {
    // Defaulting to a silent sink would reintroduce the defect for every caller
    // that forgets to pass one.
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const report = createReporter({ logger: recordingLogger().logger })

      report('inbound message failed', new Error('boom'))

      expect(spy).toHaveBeenCalledWith('[channel-wechat] inbound message failed: boom')
    } finally {
      spy.mockRestore()
    }
  })
})
