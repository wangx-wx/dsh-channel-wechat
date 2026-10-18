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
import type { ModelListing } from '../../src/bridge/model-commands.ts'

/** The catalogue `/models` renders in these tests. */
const CATALOG: ModelListing = {
  options: [
    { provider: 'provider-a', model: 'model-a1', label: 'A1', providerLabel: 'Provider A' },
    { provider: 'provider-a', model: 'model-a2', label: 'A2', providerLabel: 'Provider A' },
    { provider: 'provider-b', model: 'model-b1', label: 'B1', providerLabel: 'Provider B' },
  ],
  failures: [],
}

/** A bench with recording collaborators. */
function bench(overrides: Partial<LocalCommandContext> = {}) {
  const cancelled: string[] = []
  const ended: string[] = []
  const switched: { provider: string; model: string }[] = []
  const ctx: LocalCommandContext = {
    peerId: 'user-7',
    // Returns whether there was a turn to cancel; the reply has to differ,
    // or "stopped" and "nothing was running" look identical to the user.
    cancelRunning: async () => { cancelled.push('user-7'); return true },
    endSession: async () => void ended.push('user-7'),
    accountId: 'bot-9',
    sessionCount: 3,
    nativeCommands: async () => [
      { name: 'compact', description: '压缩以上对话内容' },
      { name: 'goal', description: '设置或查看长期任务目标' },
      { name: 'permission', description: '切换权限预设' },
    ],
    models: {
      listModels: async () => CATALOG,
      switchModel: async selection => { switched.push(selection) },
      current: () => ({ provider: 'provider-a', model: 'model-a1' }),
    },
    ...overrides,
  }
  return { ctx, cancelled, ended, switched, run: (name: string, args = '') => runLocalCommand({ name, args }, ctx) }
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

  it('separates every entry with a blank line', async () => {
    // WeChat renders the text as markdown, where a single newline is a soft
    // break that collapses into a space: a listing built with `\n` arrives as
    // one run-on line even though the bytes are correct and copying it out
    // shows the newlines. Only a blank line starts a new block, so this asserts
    // the blank line rather than the newline - the newline alone was the bug.
    const b = bench()

    const result = await b.run('help')

    const lines = (result.text ?? '').split('\n')
    const adjacentEntries = lines.filter((line, index) => {
      const next = lines[index + 1]
      return next !== undefined && line.startsWith('/') && next.startsWith('/')
    })
    expect(adjacentEntries).toEqual([])
  })

  it('says so when the harness offers no commands', async () => {
    // A peer that has never sent an ordinary message has no session, so there is
    // no agent to resolve a command against and the list is empty. A bare
    // heading with nothing under it reads as "no commands exist", which is a
    // state no deployment reaches - so the empty answer is named.
    const b = bench({ nativeCommands: async () => [] })

    const result = await b.run('help')

    expect(result.text).toMatch(/尚未建立|先发一条/u)
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

describe('/models', () => {
  it('lists every provider and model the registry reports', async () => {
    const b = bench()

    const result = await b.run('models')

    expect(result.kind).toBe('success')
    for (const row of CATALOG.options) {
      expect(result.text).toContain(`/${row.provider}/${row.model}`)
    }
  })

  it('marks the model this plugin currently has configured', async () => {
    // The listing is what a user reads before switching; without the marker they
    // cannot tell what they are changing from.
    const b = bench()

    const result = await b.run('models')

    expect(result.text).toContain('（当前）')
  })

  it('separates every entry with a blank line', async () => {
    // The same markdown rule `/help` had to obey: a single newline is a soft
    // break and arrives as a space.
    const b = bench()

    const result = await b.run('models')

    const lines = (result.text ?? '').split('\n')
    const adjacent = lines.filter((line, index) => {
      const next = lines[index + 1]
      return next !== undefined && line.startsWith('/') && next.startsWith('/')
    })
    expect(adjacent).toEqual([])
  })

  it('names a provider it could not list instead of dropping it', async () => {
    const b = bench({
      models: {
        listModels: async () => ({
          ...CATALOG,
          failures: [{ provider: 'provider-c', message: '连接超时' }],
        }),
        switchModel: async () => {},
        current: () => ({ provider: '', model: '' }),
      },
    })

    const result = await b.run('models')

    expect(result.text).toContain('provider-c')
    expect(result.text).toContain('连接超时')
  })

  it('says so when the deployment has no model catalogue', async () => {
    const b = bench({
      models: { listModels: undefined, switchModel: undefined, current: () => ({ provider: '', model: '' }) },
    })

    const result = await b.run('models')

    expect(result.kind).toBe('error')
  })
})

describe('/model', () => {
  it('switches to a provider and model it can find in the catalogue', async () => {
    const b = bench()

    const result = await b.run('model', 'provider-b/model-b1')

    expect(b.switched).toEqual([{ provider: 'provider-b', model: 'model-b1' }])
    expect(result.kind).toBe('success')
  })

  it('tells the user the current session keeps its model until /new', async () => {
    // The switch writes the plugin's config, which a session reads once at
    // creation. A reply that stopped at "switched" would leave the user talking
    // to the old model and believing otherwise.
    const b = bench()

    const result = await b.run('model', 'provider-b/model-b1')

    expect(result.text).toContain('/new')
  })

  it('refuses a model the catalogue does not offer, without writing', async () => {
    // This is the failure the detached write cannot report: a typo would only
    // reach the log. Validating first is what keeps it visible in the chat.
    const b = bench()

    const result = await b.run('model', 'provider-a/does-not-exist')

    expect(result.kind).toBe('error')
    expect(b.switched).toEqual([])
  })

  it('rejects a line that does not name a provider and model', async () => {
    for (const args of ['', 'model-a1', 'provider-a/', '/model-a1', 'a/b/c']) {
      const b = bench()
      const result = await b.run('model', args)
      expect(result.kind, JSON.stringify(args)).toBe('error')
      expect(b.switched, JSON.stringify(args)).toEqual([])
    }
  })

  it('says so when the deployment has no writable config', async () => {
    const b = bench({
      models: { listModels: async () => CATALOG, switchModel: undefined, current: () => ({ provider: '', model: '' }) },
    })

    const result = await b.run('model', 'provider-b/model-b1')

    expect(result.kind).toBe('error')
  })
})
