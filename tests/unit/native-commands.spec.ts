/**
 * Forwarding a command line to the harness's own command runtime.
 *
 * This is the half of the surface this plugin does not own: `/goal`, `/compact`,
 * `/permission`, and anything a later plugin registers. The channel forwards the
 * line verbatim and reports whatever the harness says, so the WeChat surface
 * stays as wide as the harness's own rather than a list this plugin maintains.
 */

import { describe, expect, it, vi } from 'vitest'
import { createNativeCommandExecutor, createNativeCommandLister, createSkillClaimer, createSkillLister } from '../../src/bridge/native-commands.ts'

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
    const execute = createNativeCommandExecutor({ commands: f.runtime as never })

    const outcome = await execute('/goal off', agent)

    expect(f.calls[0]?.line).toBe('/goal off')
    expect(f.calls[0]?.agent).toBe(agent)
    // A WeChat message carries no uploads, so the attachment list is empty.
    expect(f.calls[0]?.attachments).toEqual([])
    expect(outcome).toEqual({ kind: 'success', text: 'ok' })
  })

  it('reports the harness\u2019s error text unchanged', async () => {
    const f = fakeCommands({ kind: 'error', text: 'usage: /goal <objective>' })
    const execute = createNativeCommandExecutor({ commands: f.runtime as never })

    const outcome = await execute('/goal', {})

    expect(outcome).toEqual({ kind: 'error', text: 'usage: /goal <objective>' })
  })

  it('reports nothing when the harness does not know the command', async () => {
    // `undefined` means an unknown name or a rejected grammar; the router turns
    // that into a message rather than silence.
    const f = fakeCommands(undefined)
    const execute = createNativeCommandExecutor({ commands: f.runtime as never })

    expect(await execute('/nope', {})).toBeUndefined()
  })

  it('reports nothing when the peer has no agent to run the command against', async () => {
    // Commands resolve against an agent's own scoped view, so without one there
    // is nothing to execute against rather than a global fallback.
    const f = fakeCommands({ kind: 'success', text: 'should not run' })
    const execute = createNativeCommandExecutor({ commands: f.runtime as never })

    expect(await execute('/goal off', undefined)).toBeUndefined()
    expect(f.calls).toEqual([])
  })

  it('does not fail the channel when the harness throws', async () => {
    // A command runtime that is missing or broken must not take the channel
    // down; the user gets an error for the command and the loop continues.
    const commands = {
      async execute() { throw new Error('command runtime unavailable') },
    }
    const execute = createNativeCommandExecutor({ commands: commands as never })

    const outcome = await execute('/goal off', {})

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
    const execute = createNativeCommandExecutor({ commands: commands as never })

    await execute('/goal off', {})

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
    const execute = createNativeCommandExecutor({ commands: commands as never })

    await execute('/goal off', {})
    await execute('/compact', {})

    expect(seen[0]).not.toBe(seen[1])
  })
})

describe('the descriptor list', () => {
  it('reports the harness commands, with their descriptions, for one agent', async () => {
    // `/help` shows these, so they have to come from the agent's own view. The
    // description travels with the name: a listing that dropped it would leave
    // the user guessing what `/compact` does.
    const list = vi.fn(() => [
      { name: 'compact', description: 'Compact the session' },
      { name: 'goal', description: 'Set a goal' },
    ])
    const rows = await createNativeCommandLister({ commands: { list } as never })({})

    expect(rows).toEqual([
      { name: 'compact', description: 'Compact the session' },
      { name: 'goal', description: 'Set a goal' },
    ])
  })

  it('reports nothing when the peer has no agent', async () => {
    const list = vi.fn(() => [{ name: 'goal', description: 'x' }])

    const rows = await createNativeCommandLister({ commands: { list } as never })(undefined)

    expect(rows).toEqual([])
    expect(list).not.toHaveBeenCalled()
  })

  it('reports nothing rather than failing when the runtime throws', async () => {
    const list = vi.fn(() => { throw new Error('unavailable') })

    const names = await createNativeCommandLister({ commands: { list } as never })({})

    expect(names).toEqual([])
  })
})

describe('the skill list', () => {
  /** A registry answering with the given skills. */
  function registry(skills: readonly { name: string; invocation: { userInvocable: boolean } }[]) {
    return { list: async () => skills }
  }

  it('reports the names of the user-invocable skills', async () => {
    // Names only, by the user's decision: descriptions fill several phone
    // screens, and the name is what the `/skill-name` gesture needs.
    const list = createSkillLister({
      skills: registry([
        { name: 'release-workflow', invocation: { userInvocable: true } },
        { name: 'tdd', invocation: { userInvocable: true } },
      ]) as never,
    })

    expect(await list({ id: 'agent-1' }, '/work')).toEqual(['release-workflow', 'tdd'])
  })

  it('leaves out skills a human cannot invoke', async () => {
    // A model-only skill cannot be typed as a command, so listing it would
    // advertise something that does not work.
    const list = createSkillLister({
      skills: registry([
        { name: 'model-only', invocation: { userInvocable: false } },
        { name: 'both', invocation: { userInvocable: true } },
      ]) as never,
    })

    expect(await list({ id: 'agent-1' }, '/work')).toEqual(['both'])
  })

  it('resolves against the agent scope and the directory it is given', async () => {
    // The harness's own catalog resolves exactly this way, so a listing that
    // ignored either would show a different set than the model sees.
    const seen: { cwd?: string; scope?: unknown }[] = []
    const agent = { id: 'agent-1' }
    const list = createSkillLister({
      skills: {
        async list(options: { cwd?: string; scope?: unknown }) {
          seen.push({ ...(options.cwd === undefined ? {} : { cwd: options.cwd }), scope: options.scope })
          return []
        },
      } as never,
    })

    await list(agent, '/work/project')

    expect(seen).toEqual([{ cwd: '/work/project', scope: agent }])
  })

  it('omits the directory when the peer has none', async () => {
    // Passing `undefined` through is what lets the provider fall back to its own
    // project-root search instead of scanning a literal placeholder.
    const seen: (string | undefined)[] = []
    const list = createSkillLister({
      skills: {
        async list(options: { cwd?: string }) { seen.push(options.cwd); return [] },
      } as never,
    })

    await list({ id: 'agent-1' }, undefined)

    expect(seen).toEqual([undefined])
  })

  it('still lists the global skills for a peer with no session yet', async () => {
    // A peer that has never sent an ordinary message has no agent. Answering
    // "none" would be a false statement about the deployment: the user's skills
    // are installed, and `/skills` is exactly how they would find out. The
    // lookup therefore omits the scope and reads the global layer, the same way
    // the harness's own cold skill catalog does.
    const seen: unknown[] = []
    const list = createSkillLister({
      skills: {
        async list(options: { scope?: unknown }) {
          seen.push(options.scope)
          return [{ name: 'tdd', invocation: { userInvocable: true } }]
        },
      } as never,
    })

    expect(await list(undefined, '/work')).toEqual(['tdd'])
    expect(seen).toEqual([undefined])
  })

  it('lets a failing registry surface, so the command can report it', async () => {
    // Swallowing this into `[]` made `/skills` answer "当前没有可用的技能" for a
    // registry that had just thrown - a false statement about the deployment,
    // and one that hides the only evidence of the failure. `/help` may degrade
    // to its own command list; `/skills` *is* the listing, so it must not.
    const list = createSkillLister({
      skills: { list: async () => { throw new Error('broken') } } as never,
    })

    await expect(list({ id: 'agent-1' }, '/work')).rejects.toThrow('broken')
  })
})

describe('recognising a skill invocation', () => {
  /** A registry answering with the given skills. */
  function registry(skills: readonly { name: string; invocation: { userInvocable: boolean } }[]) {
    return { list: async () => skills }
  }

  it('accepts a name the listing would have shown', async () => {
    // The two must agree: a name `/skills` advertises and this rejects is a
    // gesture that cannot work, which is the defect this exists to fix.
    const claims = createSkillClaimer({
      skills: registry([
        { name: 'release-workflow', invocation: { userInvocable: true } },
      ]) as never,
    })

    await expect(claims('release-workflow', { id: 'agent-1' }, '/work')).resolves.toBe(true)
  })

  it('rejects a name the listing would have left out', async () => {
    // A model-only skill cannot be typed as a command, so claiming it would
    // deliver text no skill consumes and no answer ever arrives.
    const claims = createSkillClaimer({
      skills: registry([
        { name: 'model-only', invocation: { userInvocable: false } },
      ]) as never,
    })

    await expect(claims('model-only', { id: 'agent-1' }, '/work')).resolves.toBe(false)
  })

  it('rejects an ordinary mistyped command', async () => {
    const claims = createSkillClaimer({
      skills: registry([{ name: 'tdd', invocation: { userInvocable: true } }]) as never,
    })

    await expect(claims('stpo', { id: 'agent-1' }, '/work')).resolves.toBe(false)
  })

  it('looks up against the same agent scope and directory as the listing', async () => {
    const seen: { cwd?: string; scope?: unknown }[] = []
    const agent = { id: 'agent-1' }
    const claims = createSkillClaimer({
      skills: {
        async list(options: { cwd?: string; scope?: unknown }) {
          seen.push({ ...(options.cwd === undefined ? {} : { cwd: options.cwd }), scope: options.scope })
          return [{ name: 'tdd', invocation: { userInvocable: true } }]
        },
      } as never,
    })

    await claims('tdd', agent, '/work/project')

    expect(seen).toEqual([{ cwd: '/work/project', scope: agent }])
  })
})

