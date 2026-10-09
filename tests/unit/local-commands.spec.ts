/**
 * The channel's own commands.
 *
 * Six of them, and they split by what this plugin can actually do today:
 *
 *  - `/stop` cancels the running turn. This is the one the plan's M3 acceptance
 *    names, and it works because a command is handled outside the peer's queue.
 *  - `/status` reports which account is polling and how many peers have sessions.
 *  - `/new` ends the current session so the next message starts a fresh one.
 *  - `/help` lists what is available, including the harness's own commands.
 *  - `/cwd` and `/reconnect` are registered but not implemented. They report
 *    that plainly: a command that silently did nothing would be worse than one
 *    that says it is not ready.
 */

import { describe, expect, it } from 'vitest'
import { runLocalCommand, type LocalCommandContext } from '../../src/bridge/local-commands.ts'

/** A bench with recording collaborators. */
function bench(overrides: Partial<LocalCommandContext> = {}) {
  const cancelled: string[] = []
  const ended: string[] = []
  const ctx: LocalCommandContext = {
    peerId: 'user-7',
    // Returns whether there was a turn to cancel; the reply has to differ,
    // or "stopped" and "nothing was running" look identical to the user.
    cancelRunning: async () => { cancelled.push('user-7'); return true },
    endSession: async () => void ended.push('user-7'),
    accountId: 'bot-9',
    sessionCount: 3,
    nativeCommands: async () => ['compact', 'goal', 'permission'],
    ...overrides,
  }
  return { ctx, cancelled, ended, run: (name: string, args = '') => runLocalCommand({ name, args }, ctx) }
}

describe('/stop', () => {
  it('cancels the peer\u2019s running turn', async () => {
    const b = bench()

    const result = await b.run('stop')

    expect(b.cancelled).toEqual(['user-7'])
    expect(result.kind).toBe('success')
  })

  it('says so when nothing was running', async () => {
    // Cancelling an idle agent is not an error, but reporting "stopped" when
    // nothing was running would tell the user their task died when it had
    // already finished.
    const b = bench({ cancelRunning: async () => false })

    const result = await b.run('stop')

    expect(result.kind).toBe('success')
    expect(result.text).toBeTruthy()

    const idle = await bench({ cancelRunning: async () => false }).run('stop')
    const busy = await bench().run('stop')
    expect(idle.text).not.toBe(busy.text)
  })
})

describe('/status', () => {
  it('reports the account and the session count', async () => {
    const b = bench()

    const result = await b.run('status')

    expect(result.kind).toBe('success')
    expect(result.text).toContain('bot-9')
    expect(result.text).toContain('3')
  })

  it('says when no account is polling', async () => {
    const b = bench({ accountId: undefined })

    const result = await b.run('status')

    expect(result.kind).toBe('success')
    // "Not connected" is the useful answer, not a blank line.
    expect(result.text).toMatch(/未|没有|not/u)
  })
})

describe('/new', () => {
  it('ends the current session so the next message starts fresh', async () => {
    const b = bench()

    const result = await b.run('new')

    expect(b.ended).toEqual(['user-7'])
    expect(result.kind).toBe('success')
  })

  it('does not cancel the running turn as a side effect', async () => {
    // `/new` changes which session the next message uses; killing the current
    // work is `/stop`'s job, and conflating them would lose it silently.
    const b = bench()

    await b.run('new')

    expect(b.cancelled).toEqual([])
  })
})

describe('/help', () => {
  it('lists the channel\u2019s own commands', async () => {
    const b = bench()

    const result = await b.run('help')

    for (const name of ['/stop', '/status', '/new', '/cwd', '/help', '/reconnect']) {
      expect(result.text).toContain(name)
    }
  })

  it('lists the harness commands available to the user', async () => {
    // The native surface is the larger half of what a user can type; a help
    // that only listed this plugin's six would misrepresent it.
    const b = bench()

    const result = await b.run('help')

    expect(result.text).toContain('/goal')
    expect(result.text).toContain('/compact')
  })

  it('marks the commands that are not implemented yet', async () => {
    // /cwd and /reconnect are registered but do nothing; help must not present
    // them as working.
    const b = bench()

    const result = await b.run('help')

    expect(result.text).toMatch(/cwd.*(尚未|未实现|not)/u)
  })
})

describe('commands that are not implemented yet', () => {
  it('/cwd reports that it is not available rather than pretending', async () => {
    const b = bench()

    const result = await b.run('cwd', '/tmp/x')

    expect(result.kind).toBe('error')
    expect(result.text).toMatch(/cwd/u)
  })

  it('/reconnect reports that it is not available rather than pretending', async () => {
    const b = bench()

    const result = await b.run('reconnect')

    expect(result.kind).toBe('error')
  })

  it('never reports success for an unimplemented command', async () => {
    // The failure mode this guards: a registered command that returns success
    // and changes nothing, so the user believes it worked.
    for (const name of ['cwd', 'reconnect']) {
      const result = await bench().run(name)
      expect(result.kind, name).toBe('error')
    }
  })
})

describe('an unknown local name', () => {
  it('is not handled here', async () => {
    // Routing sends only the six known names to this module; reaching it with
    // anything else is a routing bug and should be visible as one.
    const b = bench()

    const result = await b.run('nonsense')

    expect(result.kind).toBe('error')
  })
})
