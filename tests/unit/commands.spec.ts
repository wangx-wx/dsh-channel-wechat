/**
 * Recognising and routing a slash command.
 *
 * The routing decision is the load-bearing part: a command must be handled
 * *outside* the peer's turn queue. A `/stop` that queued behind the turn it
 * means to stop could never arrive, and the plan's acceptance for M3 is that it
 * interrupts running work.
 *
 * Parsing follows the harness's own grammar so that DSH's native commands and
 * this channel's agree on what a command line looks like.
 */

import { describe, expect, it } from 'vitest'
import { parseCommandLine, routeCommand } from '../../src/bridge/commands.ts'

describe('recognising a command line', () => {
  it('reads a bare command', () => {
    expect(parseCommandLine('/stop')).toEqual({ name: 'stop', args: '' })
  })

  it('keeps the arguments as written', () => {
    // The harness writes the raw remainder into `command/run`'s args, so the
    // text after the name has to survive intact.
    expect(parseCommandLine('/cwd /tmp/some dir')).toEqual({ name: 'cwd', args: '/tmp/some dir' })
  })

  it('requires the slash at the very start', () => {
    // The harness grammar anchors at byte zero: a slash later in the message is
    // ordinary text, not a command.
    expect(parseCommandLine('please /stop')).toBeUndefined()
    expect(parseCommandLine(' /stop')).toBeUndefined()
  })

  it('accepts a command followed by a tab or newline', () => {
    expect(parseCommandLine('/stop\tnow')).toEqual({ name: 'stop', args: 'now' })
  })

  it('rejects a name that is not a lowercase identifier', () => {
    // Matching the harness grammar: names start lowercase and may contain
    // digits, hyphens, and underscores.
    expect(parseCommandLine('/Stop')).toBeUndefined()
    expect(parseCommandLine('/stop!')).toBeUndefined()
  })

  it('is not fooled by ordinary text that happens to start with a slash', () => {
    expect(parseCommandLine('/')).toBeUndefined()
    expect(parseCommandLine('//comment')).toBeUndefined()
  })

  it('accepts hyphens and digits in a name', () => {
    expect(parseCommandLine('/session-log-export')).toEqual({ name: 'session-log-export', args: '' })
  })
})

describe('routing a command', () => {
  /** A bench recording what each route did. */
  function bench(overrides: {
    native?: (line: string) => Promise<{ kind: 'success' | 'error'; text?: string } | undefined>
  } = {}) {
    const handled: { name: string; args: string }[] = []
    const nativeLines: string[] = []
    return {
      handled,
      nativeLines,
      run: (text: string) => routeCommand(text, {
        handleLocal: (command) => { handled.push(command); return { kind: 'success' as const, text: `${command.name} done` } },
        executeNative: async (line) => {
          nativeLines.push(line)
          return overrides.native === undefined ? undefined : overrides.native(line)
        },
      }),
    }
  }

  it('sends a command this channel owns to its own handler', async () => {
    const b = bench()

    const result = await b.run('/stop')

    expect(b.handled).toEqual([{ name: 'stop', args: '' }])
    expect(result).toEqual({ kind: 'success', text: 'stop done' })
    // A locally-owned command must not also reach the harness.
    expect(b.nativeLines).toEqual([])
  })

  it('passes an unknown command to the harness instead of rejecting it', async () => {
    // DSH owns the native command surface; swallowing one it owns would make
    // `/plan`, `/compact` and the rest silently unavailable over WeChat.
    const b = bench({ native: async () => ({ kind: 'success', text: 'native reply' }) })

    const result = await b.run('/goal off')

    expect(b.handled).toEqual([])
    expect(b.nativeLines).toEqual(['/goal off'])
    expect(result).toEqual({ kind: 'success', text: 'native reply' })
  })

  it('reports an unrecognised command the harness also does not know', async () => {
    // The harness returns undefined for both a syntax error and an unknown
    // name, so the channel has to say something rather than staying silent.
    const b = bench({ native: async () => undefined })

    const result = await b.run('/nonsense')

    // The channel has to produce an outcome here: the harness returns
    // `undefined` for an unknown name, and silence would look like nothing
    // happened.
    expect(result?.kind).toBe('error')
  })

  it('leaves ordinary text alone', async () => {
    const b = bench()

    const result = await b.run('hello there')

    expect(result).toBeUndefined()
    expect(b.handled).toEqual([])
    expect(b.nativeLines).toEqual([])
  })

  it('treats a native result as the reply text', async () => {
    const b = bench({ native: async () => ({ kind: 'error', text: 'nope: bad argument' }) })

    const result = await b.run('/compact x')

    expect(result).toEqual({ kind: 'error', text: 'nope: bad argument' })
  })
})
