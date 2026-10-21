/**
 * The channel's own commands.
 *
 * They split by what this plugin can actually do today:
 *
 *  - `/stop` cancels the running turn. This is the one the plan's M3 acceptance
 *    names, and it works because a command is handled outside the peer's queue.
 *  - `/status` reports which account is polling and how many peers have sessions.
 *  - `/new` ends the current session so the next message starts a fresh one, and
 *    names the directory the new one will record.
 *  - `/cwd` ends the session and starts the next one in another directory, which
 *    is the only form the change can take: a session's header `cwd` is immutable.
 *  - `/help` and its alias `/h` list what is available, including the harness's
 *    own commands.
 *  - `/skills` lists the names of the skills this peer can invoke.
 *  - `/models` lists the live catalogue and `/model` switches this plugin's own
 *    configured pair. Both are covered in full below.
 *  - `/reconnect` is registered but not implemented. It reports that plainly: a
 *    command that silently did nothing would be worse than one that says it is
 *    not ready.
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
  const moved: string[] = []
  const ctx: LocalCommandContext = {
    peerId: 'user-7',
    // Returns whether there was a turn to cancel; the reply has to differ,
    // or "stopped" and "nothing was running" look identical to the user.
    cancelRunning: async () => { cancelled.push('user-7'); return true },
    endSession: async () => void ended.push('user-7'),
    accountId: 'bot-9',
    sessionCount: 3,
    currentCwd: async () => '/work/current',
    changeCwd: async (path) => { moved.push(path); return path },
    nativeCommands: async () => [
      { name: 'compact', description: '压缩以上对话内容' },
      { name: 'goal', description: '设置或查看长期任务目标' },
      { name: 'permission', description: '切换权限预设' },
    ],
    skills: async () => ['release-workflow', 'tdd'],
    models: {
      listModels: async () => CATALOG,
      switchModel: async selection => { switched.push(selection) },
      current: () => ({ provider: 'provider-a', model: 'model-a1' }),
    },
    ...overrides,
  }
  return { ctx, cancelled, ended, switched, moved, run: (name: string, args = '') => runLocalCommand({ name, args }, ctx) }
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

  it('names the directory the new session will record', async () => {
    // A session's `cwd` cannot be corrected after creation, so a user who
    // assumed `/new` had moved somewhere else would have no way to find out
    // until tools started writing in the wrong place.
    const b = bench()

    const result = await b.run('new')

    expect(result.text).toContain('/work/current')
  })

  it('asks for the directory after ending the session, so a stored switch survives', async () => {
    // The order is load-bearing and was a real defect: `/new` ended the session
    // first and then read a directory that only the live session knew, so it
    // fell back to the configured default. A peer that had used `/cwd` was told
    // its new conversation would run somewhere it had moved away from.
    const seen: string[] = []
    const b = bench({
      endSession: async () => { seen.push('endSession') },
      currentCwd: async () => { seen.push('currentCwd'); return '/work/switched' },
    })

    const result = await b.run('new')

    expect(seen).toEqual(['endSession', 'currentCwd'])
    expect(result.text).toContain('/work/switched')
  })
})

describe('/cwd', () => {
  it('moves the peer to the directory it was given', async () => {
    const b = bench()

    const result = await b.run('cwd', '/work/next')

    expect(b.moved).toEqual(['/work/next'])
    expect(result.kind).toBe('success')
    expect(result.text).toContain('/work/next')
  })

  it('says the switch starts a new conversation', async () => {
    // The one thing a user must understand: the history does not come along.
    // Reporting success without it reads as "this conversation moved".
    const b = bench()

    const result = await b.run('cwd', '/work/next')

    expect(result.text).toMatch(/新对话|新的对话/u)
  })

  it('reports the directory it actually switched to, not the one asked for', async () => {
    // The channel canonicalizes the path, so the answer is what the session
    // will record. Reporting the raw argument would name a spelling that the
    // session header does not hold.
    const b = bench({ changeCwd: async () => 'D:\\work\\canonical' })

    const result = await b.run('cwd', 'D:\\work\\next')

    expect(result.text).toContain('D:\\work\\canonical')
  })

  it('refuses a relative path instead of guessing what it meant', async () => {
    // The process's own directory is invisible from WeChat, so resolving a
    // relative path would put the conversation somewhere the user did not name.
    const b = bench()

    const result = await b.run('cwd', 'relative/dir')

    expect(result.kind).toBe('error')
    expect(b.moved).toEqual([])
  })

  it('reports a directory that cannot be used, without moving', async () => {
    const b = bench({ changeCwd: async () => { throw new Error('目录不存在') } })

    const result = await b.run('cwd', '/work/missing')

    expect(result.kind).toBe('error')
    expect(result.text).toContain('目录不存在')
  })

  it('reports the current directory when given no argument', async () => {
    const b = bench()

    const result = await b.run('cwd')

    expect(result.kind).toBe('success')
    expect(result.text).toContain('/work/current')
    expect(b.moved).toEqual([])
  })
})

describe('/skills', () => {
  it('lists the skill names this peer can invoke', async () => {
    const b = bench()

    const result = await b.run('skills')

    expect(result.kind).toBe('success')
    expect(result.text).toContain('/release-workflow')
    expect(result.text).toContain('/tdd')
  })

  it('lists names only, not descriptions', async () => {
    // The user's own decision: descriptions run to several phone screens.
    const b = bench({ skills: async () => ['only-name'] })

    const result = await b.run('skills')

    const lines = (result.text ?? '').split('\n').filter(line => line.startsWith('/'))
    expect(lines).toEqual(['/only-name'])
  })

  it('separates every entry with a blank line', async () => {
    // The same markdown rule `/help` and `/models` obey: a single newline is a
    // soft break and arrives as a space.
    const b = bench()

    const result = await b.run('skills')

    const lines = (result.text ?? '').split('\n')
    const adjacent = lines.filter((line, index) => {
      const next = lines[index + 1]
      return next !== undefined && line.startsWith('/') && next.startsWith('/')
    })
    expect(adjacent).toEqual([])
  })

  it('says so when there are none, rather than sending a blank message', async () => {
    const b = bench({ skills: async () => [] })

    const result = await b.run('skills')

    expect(result.kind).toBe('success')
    expect(result.text).toMatch(/没有/u)
  })

  it('says so when the deployment has no skill registry', async () => {
    // Distinguished from "the registry exists and is empty": only one of the
    // two is fixed by installing a skill.
    const b = bench({ skills: undefined })

    const result = await b.run('skills')

    expect(result.kind).toBe('error')
    expect(result.text).toMatch(/技能注册表|没有/u)
  })

  it('reports a failing registry instead of claiming there are none', async () => {
    const b = bench({ skills: async () => { throw new Error('registry exploded') } })

    const result = await b.run('skills')

    expect(result.kind).toBe('error')
    expect(result.text).toContain('registry exploded')
  })
})

describe('/help', () => {
  it('lists the channel\u2019s own commands', async () => {
    const b = bench()

    const result = await b.run('help')

    for (const name of ['/stop', '/status', '/new', '/cwd', '/help', '/reconnect', '/models', '/model', '/skills']) {
      expect(result.text).toContain(name)
    }
  })

  it('advertises the /h alias', async () => {
    // The alias is a separate entry in the router, so a help listing that
    // mentioned only `/help` would leave it undiscoverable.
    const b = bench()

    const result = await b.run('help')

    expect(result.text).toContain('/h')
  })

  it('describes what each of the newer commands does', async () => {
    // The name alone is not enough for `/models` and `/model`: the listing used
    // to advertise `/model <序号|provider/model>` after the syntax was settled
    // as `provider/model` only, and a bare name would have hidden that.
    const b = bench()

    const result = await b.run('help')

    expect(result.text).toMatch(/\/models — 查看/u)
    expect(result.text).toMatch(/\/model <provider\/model> — 切换/u)
    expect(result.text).toMatch(/\/skills — 列出/u)
  })

  it('reports the current working directory', async () => {
    // `/cwd` with no argument is the only way to ask, and the directory decides
    // where every tool call runs.
    const b = bench()

    const result = await b.run('help')

    expect(result.text).toContain('/work/current')
  })

  it('lists the harness commands available to the user', async () => {
    // The native surface is the larger half of what a user can type; a help
    // that only listed this plugin's own commands would misrepresent it.
    const b = bench()

    const result = await b.run('help')

    expect(result.text).toContain('/goal')
    expect(result.text).toContain('/compact')
  })

  it('marks the commands that are not implemented yet', async () => {
    // /reconnect is registered but does nothing; help must not present it as
    // working.
    const b = bench()

    const result = await b.run('help')

    expect(result.text).toMatch(/reconnect.*(尚未|未实现|not)/u)
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

describe('/h', () => {
  it('is the same command as /help', async () => {
    // One implementation, two spellings: `/h` is what a phone keyboard makes
    // easiest, and a second code path would drift from the first.
    const short = await bench().run('h')
    const long = await bench().run('help')

    expect(short).toEqual(long)
  })

  it('accepts arguments without changing its answer', async () => {
    // The parser hands `/h foo` the same shape it hands `/help foo`; neither
    // command takes an argument, and both must still answer.
    const b = bench()

    const result = await b.run('h', 'anything')

    expect(result.kind).toBe('success')
    expect(result.text).toContain('/stop')
  })
})

describe('commands that are not implemented yet', () => {
  it('/reconnect reports that it is not available rather than pretending', async () => {
    const b = bench()

    const result = await b.run('reconnect')

    expect(result.kind).toBe('error')
  })

  it('never reports success for an unimplemented command', async () => {
    // The failure mode this guards: a registered command that returns success
    // and changes nothing, so the user believes it worked.
    const result = await bench().run('reconnect')
    expect(result.kind).toBe('error')
  })
})

describe('an unknown local name', () => {
  it('is not handled here', async () => {
    // Routing sends only the known names to this module; reaching it with
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

  it('says the switch applies to the next message, not only to a new session', async () => {
    // The trap this asserts against is the opposite of the obvious guess: the
    // reply used to tell the user to send `/new`, which was wrong. A resumed
    // conversation seeds its first request from `agentOptions`, so the written
    // config reaches the existing session. Asserting `/new` here would pass on
    // the word inside "不必 `/new`" and describe the wrong behaviour anyway.
    const b = bench()

    const result = await b.run('model', 'provider-b/model-b1')

    expect(result.text).toMatch(/下一条消息/u)
    expect(result.text).toContain('不必 `/new`')
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
