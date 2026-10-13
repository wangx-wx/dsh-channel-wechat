/**
 * The channel row over a real cordis context, the real file-backed credentials
 * provider, and the real wire client — stubbing only `fetch`, which is the
 * platform boundary rather than a collaborator.
 *
 * This is the composition the profile performs. It is where "the app argument
 * reaches the login, and the resulting login survives" is proved end to end,
 * as opposed to each piece being proved in isolation.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import CredentialsLocal from '@deepseek-ai/dsh-credentials-local'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import { provideCmdline } from '@deepseek-ai/dsh-cmdline'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { apply as applyChannel, inject as channelInject } from '../../src/index.ts'
import { loadAccount } from '../../src/credentials.ts'
import { apply as applyStartup } from '../../src/startup.ts'
import { saveAccount } from '../../src/credentials.ts'
import { PeerSessionStore } from '../../src/channel/peer-session-store.ts'

/** One mounted profile plus its disposable state. */
interface Booted {
  ctx: Context
  /** The account the login stored, if it stored one. */
  storedAccountId: string | undefined
  dispose: () => Promise<void>
}

const boots: Booted[] = []

/**
 * Homes a test created, removed after it, pass or fail.
 *
 * Cleanup registered here rather than at the end of each test body: an in-body
 * cleanup leaks the directory exactly when an assertion fails, which is when
 * someone is about to run the suite repeatedly.
 */
const homes: string[] = []

/** A temporary DSH_HOME for one test. */
function tempHome(prefix: string): string {
  const home = mkdtempSync(join(tmpdir(), prefix))
  homes.push(home)
  return home
}

afterEach(async () => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
  while (boots.length > 0) await boots.pop()?.dispose()
  vi.unstubAllGlobals()
})

/**
 * Stub `fetch` so the QR request and its status poll succeed without network.
 * @param status - the status the poll should report.
 */
function stubWeixin(status: Record<string, unknown>): void {
  vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request) => {
    const href = String(url)
    if (href.includes('get_bot_qrcode')) {
      return new Response(JSON.stringify({ qrcode: 'qr-1', qrcode_img_content: 'https://weixin.test/qr-1' }), { status: 200 })
    }
    return new Response(JSON.stringify(status), { status: 200 })
  }) as unknown as typeof fetch)
}

/**
 * Mount the two rows the profile mounts, over a launcher command line.
 * @param args - app arguments.
 * @param status - status the QR poll reports.
 * @returns the mounted context and the account id that ended up stored.
 */
async function bootProfile(args: string[], status: Record<string, unknown>): Promise<Booted> {
  const home = tempHome('dsh-wechat-e2e-')
  const previousHome = process.env['DSH_HOME']
  process.env['DSH_HOME'] = home
  stubWeixin(status)

  const exits: number[] = []
  const ctx = new Context()
  provideCmdline(ctx, {
    args,
    exit: (code: number) => void exits.push(code),
    ready: { commit() {}, await: async () => {} },
  } as never)
  await ctx.plugin(CredentialsLocal as never, {} as never)
  await ctx.plugin({ name: 'channel-wechat-startup', inject: ['cmdlineArgs'], apply: applyStartup })
  await ctx.plugin({ name: 'channel-wechat', inject: ['wechatStartup', 'credentials'], apply: applyChannel }, { cwd: '/work' })

  const accountId = typeof status['ilink_bot_id'] === 'string' ? status['ilink_bot_id'] : undefined
  const booted: Booted = {
    ctx,
    storedAccountId: accountId,
    dispose: async () => {
      await ctx.fiber.dispose()
      if (previousHome === undefined) delete process.env['DSH_HOME']
      else process.env['DSH_HOME'] = previousHome
    },
  }
  boots.push(booted)
  return booted
}

/** Wait until a condition holds, so an async apply() has a chance to finish. */
async function until(check: () => Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await check()) return
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error('condition never held')
}

describe('a profile boot with the login action', () => {
  it('stores a login that a later process can read', async () => {
    const { ctx, storedAccountId } = await bootProfile(['login'], {
      status: 'confirmed',
      bot_token: 'tok-1',
      ilink_bot_id: 'bot-9',
      baseurl: 'https://api.test',
    })

    await until(async () => (await loadAccount(ctx, 'bot-9')) !== undefined)
    const stored = await loadAccount(ctx, 'bot-9')

    expect(storedAccountId).toBe('bot-9')
    expect(stored?.botToken).toBe('tok-1')
    expect(stored?.baseUrl).toBe('https://api.test')
  })

  it('answers a WeChat message with the model reply', async () => {
    // The reply path's production wiring, end to end and through the real
    // `apply`. `Channel.attach` existing proves nothing on its own: the answer is
    // read from the committed `assistant/message` event, so a run that never
    // subscribes receives the message, runs the turn, and sends nothing back -
    // silently, reporting itself healthy while the user waits forever.
    //
    // Nothing here calls `attach`, and nothing stubs the subscription. The
    // registry emits a real `session/event` on the real context, which is the
    // only way to see whether `index.ts` subscribed at all. The unit suite cannot
    // see it: it calls `startChannelFromStore` directly, skipping `index.ts`.
    const previous = process.env['DSH_HOME']
    const home = tempHome('dsh-wechat-reply-')
    process.env['DSH_HOME'] = home

    const peerId = 'user-7'
    const sentTexts: string[] = []
    /** Agents this stand-in registry considers live. */
    const live = new Map<string, unknown>()
    /** The context the registry emits on, set once the plugin is mounted. */
    let context: Context | undefined

    // The message is delivered on the first poll only. Returning it every time
    // would make the loop re-deliver it with no pause, spinning the event loop
    // hard enough that the worker never gets to settle.
    let polls = 0
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const href = String(url)
      if (href.includes('getupdates')) {
        polls += 1
        return new Response(JSON.stringify({
          ret: 0,
          msgs: polls === 1
            ? [{
              message_id: 1, from_user_id: peerId, message_type: 1, context_token: 'ctx-1',
              item_list: [{ type: 1, text_item: { text: 'hi' } }],
            }]
            : [],
          get_updates_buf: `c${polls}`,
        }), { status: 200 })
      }
      if (href.includes('sendmessage')) {
        const body = JSON.parse(String(init?.body ?? '{}')) as {
          msg?: { item_list?: { text_item?: { text?: string } }[] }
        }
        const text = body.msg?.item_list?.[0]?.text_item?.text
        if (typeof text === 'string') sentTexts.push(text)
        return new Response(JSON.stringify({ ret: 0 }), { status: 200 })
      }
      return new Response(JSON.stringify({ ret: 0 }), { status: 200 })
    }) as unknown as typeof fetch)

    const ctx = new Context()
    context = ctx
    provideCmdline(ctx, { args: [], exit: () => {}, ready: { commit() {}, await: async () => {} } } as never)
    await ctx.plugin(CredentialsLocal as never, {} as never)
    await ctx.plugin(CommandRuntime)
    // The row waits on this service, so a mount without it never activates.
    ctx.provide('agentDefaultModel', {
      currentSelection: () => ({ provider: 'deepseek-official', model: 'deepseek-v4.1-flash' }),
    })
    // A stand-in for the agent registry, in place of the whole agent loop: what
    // is under test is the subscription `index.ts` takes, not the loop. It
    // reports its session live, because `require` refuses to deliver to a
    // session the registry does not know.
    ctx.provide('agents', {
      async create({ sessionId }: { sessionId: string }) {
        const agent = {
          id: sessionId,
          followup: () => {},
          // The answer is committed while the turn is still in flight, which is
          // when the reply path reads it. Emitted on the real context, so the
          // listener under test is whatever the plugin actually registered.
          whenIdle: async () => {
            // Cast through `never`: the emitted event is typed as a `SessionEvent`
            // and the session as a `Session`, which the reply path never needs -
            // it reads `String(session.id)` and `event.type`. Building the full
            // branded shapes here would test the test.
            const emit = context?.emit as unknown as (
              name: string, session: unknown, event: unknown,
            ) => void
            emit?.call(context, 'session/event', { id: sessionId }, {
              type: 'assistant/message',
              data: { message: { content: [{ type: 'text', text: 'hello from the model' }] } },
            })
          },
        }
        live.set(sessionId, agent)
        return { agent, dispose: async () => void live.delete(sessionId) }
      },
      async resume() { throw new Error('no persisted session') },
      get: (id: string) => live.get(id),
    })
    await saveAccount(ctx, { botToken: 'tok-1', accountId: 'bot-9' })
    await ctx.plugin({ name: 'channel-wechat-startup', inject: ['cmdlineArgs'], apply: applyStartup })
    await ctx.plugin({
      name: 'channel-wechat',
      inject: ['wechatStartup', 'credentials', 'agents', 'commands', 'agentDefaultModel'],
      apply: applyChannel,
    }, { cwd: '/work' })

    try {
      await until(async () => sentTexts.length > 0, 3_000)
    } finally {
      // Disposed in a `finally`, because the run is detached and polls on a real
      // timer: a failed assertion that skipped this would leave the loop running
      // and hang the worker instead of reporting the failure.
      await ctx.fiber.dispose()
      if (previous === undefined) delete process.env['DSH_HOME']
      else process.env['DSH_HOME'] = previous
    }

    expect(sentTexts).toContain('hello from the model')
  }, 30_000)

  it('gives a new session the model the profile selected', async () => {
    // `ctx.agents` does not apply a default model itself; every caller reads
    // `agentDefaultModel` and passes the selection in. A caller that skips it
    // creates a session with no model, and the system prompt's `{{model}}`
    // variable then has no value, so the turn fails before the model is called:
    //
    //   prompt variable "{{model}}" has no value for this assembly
    //     (section "deployment:persona-prefix")
    //
    // The user sees a message arrive and no reply, which is what a real instance
    // did. Asserted through the real `apply`, because `runtime.spec.ts` supplies
    // `sessionOptions` itself and so cannot see whether production does.
    const previous = process.env['DSH_HOME']
    const home = tempHome('dsh-wechat-model-')
    process.env['DSH_HOME'] = home

    /** What the channel asked the registry to create. */
    const asked: { provider?: string; model?: string }[] = []
    const live = new Map<string, unknown>()
    let polls = 0

    vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request) => {
      if (String(url).includes('getupdates')) {
        polls += 1
        return new Response(JSON.stringify({
          ret: 0,
          msgs: polls === 1
            ? [{
              message_id: 1, from_user_id: 'user-7', message_type: 1,
              item_list: [{ type: 1, text_item: { text: 'hi' } }],
            }]
            : [],
          get_updates_buf: `c${polls}`,
        }), { status: 200 })
      }
      return new Response(JSON.stringify({ ret: 0 }), { status: 200 })
    }) as unknown as typeof fetch)

    const ctx = new Context()
    provideCmdline(ctx, { args: [], exit: () => {}, ready: { commit() {}, await: async () => {} } } as never)
    await ctx.plugin(CredentialsLocal as never, {} as never)
    await ctx.plugin(CommandRuntime)
    // The profile's selection, which the channel has to read and pass on.
    ctx.provide('agentDefaultModel', {
      currentSelection: () => ({ provider: 'deepseek-official', model: 'deepseek-v4.1-flash' }),
    })
    ctx.provide('agents', {
      async create({ sessionId, agentOptions }: { sessionId: string; agentOptions?: { provider?: string; model?: string } }) {
        asked.push(agentOptions ?? {})
        const agent = { id: sessionId, followup: () => {}, whenIdle: async () => {} }
        live.set(sessionId, agent)
        return { agent, dispose: async () => void live.delete(sessionId) }
      },
      async resume() { throw new Error('no persisted session') },
      get: (id: string) => live.get(id),
    })
    await saveAccount(ctx, { botToken: 'tok-1', accountId: 'bot-9' })
    await ctx.plugin({ name: 'channel-wechat-startup', inject: ['cmdlineArgs'], apply: applyStartup })
    await ctx.plugin({
      name: 'channel-wechat',
      inject: ['wechatStartup', 'credentials', 'agents', 'commands', 'agentDefaultModel'],
      apply: applyChannel,
    }, { cwd: '/work' })

    try {
      await until(async () => asked.length > 0, 3_000)
    } finally {
      await ctx.fiber.dispose()
      if (previous === undefined) delete process.env['DSH_HOME']
      else process.env['DSH_HOME'] = previous
    }

    expect(asked[0]).toEqual({ provider: 'deepseek-official', model: 'deepseek-v4.1-flash' })
  }, 30_000)

  it('records the configured working directory on a new session', async () => {
    // The system prompt's `{{cwd}}` reads the session header, and a header
    // cannot be edited after creation - so a session created without one fails
    // every turn for its whole life, with the failure surfacing as "the user
    // sent a message and got nothing".
    //
    // Asserted through the real `apply`, because the real-loop suite builds its
    // own `Channel` and passes `cwd` itself: it proves the plumbing works while
    // saying nothing about whether `index.ts` supplies the profile's value.
    const previous = process.env['DSH_HOME']
    const home = tempHome('dsh-wechat-cwd-')
    process.env['DSH_HOME'] = home

    const asked: { cwd?: string }[] = []
    const live = new Map<string, unknown>()
    let polls = 0

    vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request) => {
      if (String(url).includes('getupdates')) {
        polls += 1
        return new Response(JSON.stringify({
          ret: 0,
          msgs: polls === 1
            ? [{
              message_id: 1, from_user_id: 'user-7', message_type: 1,
              item_list: [{ type: 1, text_item: { text: 'hi' } }],
            }]
            : [],
          get_updates_buf: `c${polls}`,
        }), { status: 200 })
      }
      return new Response(JSON.stringify({ ret: 0 }), { status: 200 })
    }) as unknown as typeof fetch)

    const ctx = new Context()
    provideCmdline(ctx, { args: [], exit: () => {}, ready: { commit() {}, await: async () => {} } } as never)
    await ctx.plugin(CredentialsLocal as never, {} as never)
    await ctx.plugin(CommandRuntime)
    ctx.provide('agentDefaultModel', {
      currentSelection: () => ({ provider: 'deepseek-official', model: 'deepseek-v4.1-flash' }),
    })
    ctx.provide('agents', {
      async create({ sessionId, meta }: { sessionId: string; meta?: { cwd?: string } }) {
        asked.push(meta ?? {})
        const agent = { id: sessionId, followup: () => {}, whenIdle: async () => {} }
        live.set(sessionId, agent)
        return { agent, dispose: async () => void live.delete(sessionId) }
      },
      async resume() { throw new Error('no persisted session') },
      get: (id: string) => live.get(id),
    })
    await saveAccount(ctx, { botToken: 'tok-1', accountId: 'bot-9' })
    await ctx.plugin({ name: 'channel-wechat-startup', inject: ['cmdlineArgs'], apply: applyStartup })
    // The profile supplies the directory; the plugin must record it.
    await ctx.plugin({
      name: 'channel-wechat',
      inject: ['wechatStartup', 'credentials', 'agents', 'commands', 'agentDefaultModel'],
      apply: applyChannel,
    }, { cwd: '/work' })

    try {
      await until(async () => asked.length > 0, 3_000)
    } finally {
      await ctx.fiber.dispose()
      if (previous === undefined) delete process.env['DSH_HOME']
      else process.env['DSH_HOME'] = previous
    }

    expect(asked[0]).toEqual({ cwd: '/work' })
  }, 30_000)

  it("mounts the profile's agent preset on a new session", async () => {
    // The web app disables every model-facing tool row on the host plane and
    // moves them behind agent presets ("the agent plane moves behind agent
    // presets"), so a session that mounts no preset has no tools at all. The
    // model still emits tool-call syntax from its training - DeepSeek leaks its
    // `｜DSML｜` markup - and the user reads that markup as garbled text instead
    // of an answer.
    //
    // Asserted through the real `apply`. The real-loop suite mounts the agent
    // loop testkit, which composes no preset registry, so nothing there can
    // observe whether this plugin joins one.
    const previous = process.env['DSH_HOME']
    const home = tempHome('dsh-wechat-preset-')
    process.env['DSH_HOME'] = home

    /** Preset ids the plugin asked the profile to resolve. */
    const resolved: (string | undefined)[] = []
    /** Presets the plugin mounted on a session. */
    const mounted: (string | undefined)[] = []
    let polls = 0

    vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request) => {
      if (String(url).includes('getupdates')) {
        polls += 1
        return new Response(JSON.stringify({
          ret: 0,
          msgs: polls === 1
            ? [{
              message_id: 1, from_user_id: 'user-7', message_type: 1,
              item_list: [{ type: 1, text_item: { text: 'hi' } }],
            }]
            : [],
          get_updates_buf: `c${polls}`,
        }), { status: 200 })
      }
      return new Response(JSON.stringify({ ret: 0 }), { status: 200 })
    }) as unknown as typeof fetch)

    const ctx = new Context()
    provideCmdline(ctx, { args: [], exit: () => {}, ready: { commit() {}, await: async () => {} } } as never)
    await ctx.plugin(CredentialsLocal as never, {} as never)
    await ctx.plugin(CommandRuntime)
    ctx.provide('agentDefaultModel', {
      currentSelection: () => ({ provider: 'deepseek-official', model: 'deepseek-v4.1-flash' }),
    })
    // The id is deliberately not one a hardcoding plugin could guess, so this
    // can only pass by asking the profile for its default.
    ctx.provide('agentPresets', {
      resolve: (id?: string) => {
        resolved.push(id)
        return Promise.resolve({ id: id ?? 'from-profile' })
      },
      mount: (_agentCtx: unknown, id?: string) => {
        mounted.push(id)
        return Promise.resolve({ id: id ?? 'from-profile' })
      },
    })
    ctx.provide('agents', {
      async create({ sessionId, setup }: {
        sessionId: string
        setup?: (agentCtx: unknown, agent: unknown) => unknown
      }) {
        const agent = { id: sessionId, followup: () => {}, whenIdle: async () => {} }
        // The real registry awaits setup before publishing the agent, which is
        // where a preset has to be composed.
        await setup?.(ctx, agent)
        return { agent, dispose: async () => {} }
      },
      async resume() { throw new Error('no persisted session') },
      get: () => undefined,
    })
    await saveAccount(ctx, { botToken: 'tok-1', accountId: 'bot-9' })
    await ctx.plugin({ name: 'channel-wechat-startup', inject: ['cmdlineArgs'], apply: applyStartup })
    await ctx.plugin({
      name: 'channel-wechat',
      inject: ['wechatStartup', 'credentials', 'agents', 'commands', 'agentDefaultModel'],
      apply: applyChannel,
    }, { cwd: '/work' })

    try {
      await until(async () => mounted.length > 0, 3_000)
    } finally {
      await ctx.fiber.dispose()
      if (previous === undefined) delete process.env['DSH_HOME']
      else process.env['DSH_HOME'] = previous
    }

    expect(resolved).toEqual([undefined])
    expect(mounted).toEqual(['from-profile'])
  }, 30_000)

  it('persists a conversation rotation when /new runs', async () => {
    // The production half of `/new`. Advancing the generation in memory honors
    // the command until the process ends and then resumes the conversation the
    // user was told was over, so the store has to be wired in `index.ts` - and
    // the channel's own suites inject one themselves, meaning nothing there can
    // observe whether production does.
    //
    // Read back through a fresh `PeerSessionStore` over the same DSH_HOME, which
    // is precisely what the next process does.
    const previous = process.env['DSH_HOME']
    const home = tempHome('dsh-wechat-new-')
    process.env['DSH_HOME'] = home

    let polls = 0
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request) => {
      if (String(url).includes('getupdates')) {
        polls += 1
        // The second poll carries `/new`, which is the command under test.
        return new Response(JSON.stringify({
          ret: 0,
          msgs: polls === 1
            ? [{
              message_id: 1, from_user_id: 'user-7', message_type: 1,
              context_token: 'ctx-1', item_list: [{ type: 1, text_item: { text: '/new' } }],
            }]
            : [],
          get_updates_buf: `c${polls}`,
        }), { status: 200 })
      }
      return new Response(JSON.stringify({ ret: 0 }), { status: 200 })
    }) as unknown as typeof fetch)

    const ctx = new Context()
    provideCmdline(ctx, { args: [], exit: () => {}, ready: { commit() {}, await: async () => {} } } as never)
    await ctx.plugin(CredentialsLocal as never, {} as never)
    await ctx.plugin(CommandRuntime)
    ctx.provide('agentDefaultModel', {
      currentSelection: () => ({ provider: 'deepseek-official', model: 'deepseek-v4.1-flash' }),
    })
    const live = new Map<string, unknown>()
    ctx.provide('agents', {
      async create({ sessionId }: { sessionId: string }) {
        const agent = { id: sessionId, followup: () => {}, whenIdle: async () => {} }
        live.set(sessionId, agent)
        return { agent, dispose: async () => void live.delete(sessionId) }
      },
      async resume() { throw new Error('no persisted session') },
      get: (id: string) => live.get(id),
    })
    await saveAccount(ctx, { botToken: 'tok-1', accountId: 'bot-9' })
    await ctx.plugin({ name: 'channel-wechat-startup', inject: ['cmdlineArgs'], apply: applyStartup })
    await ctx.plugin({
      name: 'channel-wechat',
      inject: ['wechatStartup', 'credentials', 'agents', 'commands', 'agentDefaultModel'],
      apply: applyChannel,
    }, { cwd: '/work' })

    let stored = -1
    try {
      // `/new` replies before it is observable on disk, so wait on the file the
      // rotation is supposed to leave behind rather than on the reply.
      await until(async () => (await new PeerSessionStore().generation('user-7')) > 0, 5_000)
      // Read while DSH_HOME still points at this test's home: the store resolves
      // it per call, so a read after the restore would consult the real profile.
      stored = await new PeerSessionStore().generation('user-7')
    } finally {
      await ctx.fiber.dispose()
      if (previous === undefined) delete process.env['DSH_HOME']
      else process.env['DSH_HOME'] = previous
    }

    expect(stored).toBe(1)
  }, 30_000)

  it('reaches the right agent for a native command after a rotation', async () => {
    // A peer past generation zero has its live session under a rotated id. The
    // plugin used to rebuild that id from the peer alone to find the agent for a
    // native command, which silently resolved generation zero - so after `/new`,
    // `/goal` and `/compact` found no agent and were dropped without a word.
    const previous = process.env['DSH_HOME']
    const home = tempHome('dsh-wechat-native-')
    process.env['DSH_HOME'] = home
    // Seeded as the next process would find it: this peer already ran `/new`.
    await new PeerSessionStore().startNew('user-7')

    /** Agents the command runtime was asked to run against. */
    const forwarded: unknown[] = []
    let polls = 0

    vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request) => {
      if (String(url).includes('getupdates')) {
        polls += 1
        return new Response(JSON.stringify({
          ret: 0,
          msgs: polls === 1
            ? [{
              message_id: 1, from_user_id: 'user-7', message_type: 1,
              context_token: 'ctx-1', item_list: [{ type: 1, text_item: { text: '/goal off' } }],
            }]
            : [],
          get_updates_buf: `c${polls}`,
        }), { status: 200 })
      }
      return new Response(JSON.stringify({ ret: 0 }), { status: 200 })
    }) as unknown as typeof fetch)

    const ctx = new Context()
    provideCmdline(ctx, { args: [], exit: () => {}, ready: { commit() {}, await: async () => {} } } as never)
    await ctx.plugin(CredentialsLocal as never, {} as never)
    ctx.provide('agentDefaultModel', {
      currentSelection: () => ({ provider: 'deepseek-official', model: 'deepseek-v4.1-flash' }),
    })
    const live = new Map<string, unknown>()
    ctx.provide('agents', {
      async create({ sessionId }: { sessionId: string }) {
        const agent = { id: sessionId, followup: () => {}, whenIdle: async () => {} }
        live.set(sessionId, agent)
        return { agent, dispose: async () => void live.delete(sessionId) }
      },
      async resume() { throw new Error('no persisted session') },
      get: (id: string) => live.get(id),
    })
    // The harness's command surface, which the channel forwards native commands
    // to. What matters here is which agent it is handed.
    ctx.provide('commands', {
      execute: async (agent: unknown, line: string) => {
        forwarded.push(agent)
        return { result: { kind: 'success', text: `ran ${line}` } }
      },
      list: () => [],
    })
    await saveAccount(ctx, { botToken: 'tok-1', accountId: 'bot-9' })
    await ctx.plugin({ name: 'channel-wechat-startup', inject: ['cmdlineArgs'], apply: applyStartup })
    await ctx.plugin({
      name: 'channel-wechat',
      inject: ['wechatStartup', 'credentials', 'agents', 'commands', 'agentDefaultModel'],
      apply: applyChannel,
    }, { cwd: '/work' })

    try {
      await until(async () => forwarded.length > 0, 3_000)
    } finally {
      await ctx.fiber.dispose()
      if (previous === undefined) delete process.env['DSH_HOME']
      else process.env['DSH_HOME'] = previous
    }

    // The agent must be the live one for this peer's *current* conversation, not
    // a lookup that missed it.
    expect(forwarded).toEqual([live.get('channel-wechat-user-7~g1')])
  }, 30_000)

  it('resumes a session a previous run left behind instead of recreating it', async () => {
    // Every restart of a real instance hits this. A peer's session id is derived
    // from the peer, so the id already has persisted state; a run that probes
    // nothing calls `create` for it and the registry rejects the create, which
    // drops every inbound message for the life of the process.
    //
    // Asserted through the real `apply`, because that is where the probe has to
    // be supplied. `runtime.spec.ts` passes `sessionExists` itself, so it proves
    // the seam works while saying nothing about whether production uses it.
    const previous = process.env['DSH_HOME']
    const home = tempHome('dsh-wechat-resume-')
    process.env['DSH_HOME'] = home

    const calls: string[] = []
    // One inbound message, because resolving a session is what a delivered
    // message does; an empty poll would never reach the probe at all. Delivered
    // once, so the loop does not re-deliver it without pausing.
    let polls = 0
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request) => {
      if (String(url).includes('getupdates')) {
        polls += 1
        return new Response(JSON.stringify({
          ret: 0,
          msgs: polls === 1
            ? [{
              message_id: 1, from_user_id: 'user-7', message_type: 1,
              item_list: [{ type: 1, text_item: { text: 'hi' } }],
            }]
            : [],
          get_updates_buf: `c${polls}`,
        }), { status: 200 })
      }
      return new Response(JSON.stringify({ ret: 0 }), { status: 200 })
    }) as unknown as typeof fetch)

    const ctx = new Context()
    provideCmdline(ctx, { args: [], exit: () => {}, ready: { commit() {}, await: async () => {} } } as never)
    await ctx.plugin(CredentialsLocal as never, {} as never)
    await ctx.plugin(CommandRuntime)
    // The registry records which verb the channel chose. `create` throws for an
    // id that already has state, exactly as the real one does, so a run that
    // picks the wrong verb fails here rather than silently losing messages.
    const peerSessionId = `channel-wechat-${'user-7'}`
    const live = new Map<string, unknown>()
    ctx.provide('agents', {
      async create({ sessionId }: { sessionId: string }) {
        throw new Error(`SessionAlreadyExistsError: session "${sessionId}" already exists`)
      },
      async resume({ resumeSessionId }: { resumeSessionId: string }) {
        calls.push(`resume:${resumeSessionId}`)
        const agent = { id: resumeSessionId, followup: () => {}, whenIdle: async () => {} }
        live.set(resumeSessionId, agent)
        return { agent, dispose: async () => void live.delete(resumeSessionId) }
      },
      get: (id: string) => live.get(id),
    })
    // Required by the row, and the selection every session is created with.
    ctx.provide('agentDefaultModel', {
      currentSelection: () => ({ provider: 'deepseek-official', model: 'deepseek-v4.1-flash' }),
    })
    // The durable store reports the peer's session as already present, which is
    // what a restart finds. This is the service `sessionExistsOf` asks.
    ctx.provide('sessionPersistence', {
      stat: async (id: string) => (id === peerSessionId ? { header: { id } } : undefined),
    })

    await saveAccount(ctx, { botToken: 'tok-1', accountId: 'bot-9' })
    await ctx.plugin({ name: 'channel-wechat-startup', inject: ['cmdlineArgs'], apply: applyStartup })
    await ctx.plugin({
      name: 'channel-wechat',
      inject: ['wechatStartup', 'credentials', 'agents', 'commands', 'agentDefaultModel'],
      apply: applyChannel,
    }, { cwd: '/work' })

    try {
      // The resumed handle appears once the message is delivered, which is the
      // moment the probe has to have answered "exists".
      await until(async () => live.has(peerSessionId), 3_000)
    } finally {
      await ctx.fiber.dispose()
      if (previous === undefined) delete process.env['DSH_HOME']
      else process.env['DSH_HOME'] = previous
    }

    expect(calls).toEqual([`resume:${peerSessionId}`])
  }, 30_000)

  it('requests the QR code from the channel before it polls', async () => {
    await bootProfile(['login'], { status: 'confirmed', bot_token: 't', ilink_bot_id: 'bot-9' })

    const calls = (globalThis.fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls
    expect(String(calls[0]?.[0])).toContain('get_bot_qrcode')
  })
})

describe('the row\'s declared dependencies', () => {
  it('waits for the parsed invocation and the credentials store', () => {
    // All four are load-bearing: without `wechatStartup` the row cannot know
    // what was asked, without `credentials` it would activate before the store
    // it writes through exists, without `agents` the channel would reach for an
    // unmounted registry and start polling with nowhere to deliver, and without
    // `commands` the harness's own command surface would be unreachable over
    // WeChat.
    expect(channelInject).toEqual(['wechatStartup', 'credentials', 'agents', 'commands', 'agentDefaultModel'])
  })
})

describe('a profile boot with no action', () => {
  it('starts the channel when a login is already stored', async () => {
    // The M2 acceptance path: an ordinary start finds the stored account and
    // begins polling as it, with no app argument involved.
    const previous = process.env['DSH_HOME']
    const home = tempHome('dsh-wechat-start-')
    process.env['DSH_HOME'] = home

    // Stub only the platform boundary: the poll and the send go through it.
    const requested: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request) => {
      requested.push(String(url))
      if (String(url).includes('getupdates')) {
        return new Response(JSON.stringify({ ret: 0, msgs: [], get_updates_buf: 'c1' }), { status: 200 })
      }
      return new Response(JSON.stringify({ ret: 0 }), { status: 200 })
    }) as unknown as typeof fetch)

    const ctx = new Context()
    provideCmdline(ctx, { args: [], exit: () => {}, ready: { commit() {}, await: async () => {} } } as never)
    await ctx.plugin(CredentialsLocal as never, {} as never)
    // The channel creates sessions through the agent registry, so a profile
    // that starts it must have one mounted.
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(CommandRuntime)
    ctx.provide('agentDefaultModel', {
      currentSelection: () => ({ provider: 'deepseek-official', model: 'deepseek-v4.1-flash' }),
    })
    await saveAccount(ctx, { botToken: 'tok-1', accountId: 'bot-9' })
    await ctx.plugin({ name: 'channel-wechat-startup', inject: ['cmdlineArgs'], apply: applyStartup })
    await ctx.plugin({ name: 'channel-wechat', inject: ['wechatStartup', 'credentials', 'agents'], apply: applyChannel }, { cwd: '/work' })

    // The loop runs detached, so give it a moment to issue its first poll.
    await new Promise(resolve => setTimeout(resolve, 150))
    await ctx.fiber.dispose()

    expect(requested.some(url => url.includes('getupdates'))).toBe(true)
    if (previous === undefined) delete process.env['DSH_HOME']
    else process.env['DSH_HOME'] = previous
  }, 30_000)

  it('starts the server instead of performing a login', async () => {
    // An ordinary `dsh <profile>` must not log in or exit; the fetch stub
    // would throw if anything reached for the QR endpoint.
    const { ctx } = await bootProfile([], { status: 'confirmed', bot_token: 't', ilink_bot_id: 'bot-9' })

    expect(ctx.get('wechatStartup')).toEqual({ action: 'none' })
    // Nothing reached the wire: the stub records every call, and a login would
    // have fetched a QR code first.
    const calls = (globalThis.fetch as unknown as { mock?: { calls: unknown[] } }).mock?.calls ?? []
    expect(calls).toHaveLength(0)
    // Nothing was stored either, which is what a user-visible hijack would do.
    expect(await loadAccount(ctx, 'bot-9')).toBeUndefined()
  })
})
