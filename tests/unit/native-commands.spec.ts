/**
 * Forwarding a command line to the harness's own command runtime.
 *
 * This is the half of the surface this plugin does not own: `/goal`, `/compact`,
 * `/permission`, and anything a later plugin registers. The channel forwards the
 * line verbatim and reports whatever the harness says, so the WeChat surface
 * stays as wide as the harness's own rather than a list this plugin maintains.
 */

import { describe, expect, it, vi } from 'vitest'
import { createNativeCommandExecutor, createNativeCommandLister } from '../../src/bridge/native-commands.ts'

/** A stand-in for `ctx.commands`, recording what it was asked. */
function fakeCommands(outcome: { kind: 'success' | 'error'; text?: string } | undefined) {
  const calls: { agent: unknown; line: string; attachments: readonly unknown[] }[] = []
  return {
    calls,
    runtime: {
      async execute(agent: unknown, line: string, attachments: readonly unknown[]) {
        calls.push({ agent, line, attachments })
        if (outcome === undefined) return undefined
        return { commandId: 'cmd-1', result: outcome }
      },
    },
  }
}

describe('forwarding to the harness', () => {
  it('passes the exact line and the receiving agent', async () => {
    // The harness documents this call shape: the exact receiving agent, the
    // full command line, and the submission's ordered attachments. Anything
    // else resolves a different command view.
    const f = fakeCommands({ kind: 'success', text: 'ok' })
    const agent = { id: 'session-1' }
    const execute = createNativeCommandExecutor({
      commands: f.runtime as never,
      agentFor: () => agent as never,
    })

    const outcome = await execute('/goal off', 'user-7')

    expect(f.calls[0]?.line).toBe('/goal off')
    expect(f.calls[0]?.agent).toBe(agent)
    // A WeChat message carries no uploads, so the attachment list is empty.
    expect(f.calls[0]?.attachments).toEqual([])
    expect(outcome).toEqual({ kind: 'success', text: 'ok' })
  })

  it('reports the harness\u2019s error text unchanged', async () => {
    const f = fakeCommands({ kind: 'error', text: 'usage: /goal <objective>' })
    const execute = createNativeCommandExecutor({ commands: f.runtime as never, agentFor: () => ({}) as never })

    const outcome = await execute('/goal', 'user-7')

    expect(outcome).toEqual({ kind: 'error', text: 'usage: /goal <objective>' })
  })

  it('reports nothing when the harness does not know the command', async () => {
    // `undefined` means an unknown name or a rejected grammar; the router turns
    // that into a message rather than silence.
    const f = fakeCommands(undefined)
    const execute = createNativeCommandExecutor({ commands: f.runtime as never, agentFor: () => ({}) as never })

    expect(await execute('/nope', 'user-7')).toBeUndefined()
  })

  it('reports nothing when the peer has no agent to run the command against', async () => {
    // Commands resolve against an agent's own scoped view, so without one there
    // is nothing to execute against rather than a global fallback.
    const f = fakeCommands({ kind: 'success', text: 'should not run' })
    const execute = createNativeCommandExecutor({ commands: f.runtime as never, agentFor: () => undefined })

    expect(await execute('/goal off', 'user-7')).toBeUndefined()
    expect(f.calls).toEqual([])
  })

  it('does not fail the channel when the harness throws', async () => {
    // A command runtime that is missing or broken must not take the channel
    // down; the user gets an error for the command and the loop continues.
    const commands = {
      async execute() { throw new Error('command runtime unavailable') },
    }
    const execute = createNativeCommandExecutor({ commands: commands as never, agentFor: () => ({}) as never })

    const outcome = await execute('/goal off', 'user-7')

    expect(outcome?.kind).toBe('error')
    expect(outcome?.text).toContain('command runtime unavailable')
  })

  it('passes an abort signal so a cancelled command stops', async () => {
    // The signature takes a signal; supplying one that is never aborted would
    // make a long-running command uncancellable.
    const seen: (AbortSignal | undefined)[] = []
    const commands = {
      async execute(_agent: unknown, _line: string, _attachments: unknown, signal: AbortSignal) {
        seen.push(signal)
        return { commandId: 'c', result: { kind: 'success' as const, text: 'ok' } }
      },
    }
    const execute = createNativeCommandExecutor({ commands: commands as never, agentFor: () => ({}) as never })

    await execute('/goal off', 'user-7')

    expect(seen[0]).toBeInstanceOf(AbortSignal)
  })

  it('gives each invocation its own signal', async () => {
    // Two commands from one peer must not share cancellation state.
    const seen: AbortSignal[] = []
    const commands = {
      async execute(_agent: unknown, _line: string, _attachments: unknown, signal: AbortSignal) {
        seen.push(signal)
        return { commandId: 'c', result: { kind: 'success' as const, text: 'ok' } }
      },
    }
    const execute = createNativeCommandExecutor({ commands: commands as never, agentFor: () => ({}) as never })

    await execute('/goal off', 'user-7')
    await execute('/compact', 'user-7')

    expect(seen[0]).not.toBe(seen[1])
  })
})

describe('the descriptor list', () => {
  it('reports the command names the harness offers for one agent', async () => {
    // `/help` shows these, so they have to come from the agent's own view.
    const list = vi.fn(() => [
      { name: 'compact', description: 'Compact the session' },
      { name: 'goal', description: 'Set a goal' },
    ])
    const names = await createNativeCommandLister({ commands: { list } as never, agentFor: () => ({}) as never })('user-7')

    expect(names).toEqual(['compact', 'goal'])
  })

  it('reports nothing when the peer has no agent', async () => {
    const list = vi.fn(() => [{ name: 'goal', description: 'x' }])

    const names = await createNativeCommandLister({ commands: { list } as never, agentFor: () => undefined })('user-7')

    expect(names).toEqual([])
    expect(list).not.toHaveBeenCalled()
  })

  it('reports nothing rather than failing when the runtime throws', async () => {
    const list = vi.fn(() => { throw new Error('unavailable') })

    const names = await createNativeCommandLister({ commands: { list } as never, agentFor: () => ({}) as never })('user-7')

    expect(names).toEqual([])
  })
})
