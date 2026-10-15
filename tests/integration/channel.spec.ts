/**
 * The channel row over a real cordis context, the real file-backed credentials
 * provider, and the real wire client — stubbing only `fetch`, which is the
 * platform boundary rather than a collaborator.
 *
 * This is the composition the profile performs. It is where "the app argument
 * reaches the login, and the resulting login survives" is proved end to end,
 * as opposed to each piece being proved in isolation.
 */

import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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

  it('answers an approval request over WeChat', async () => {
    // The production half of the card support, and the defect it exists for: a
    // turn that asks for approval with no answerer on this channel never
    // finishes, so the user gets no reply at all. Every other suite injects a
    // `CardService` itself, so none of them can see whether `index.ts` attaches
    // one.
    //
    // Raised through the real waterfall, which is exactly what
    // `ApprovalService.request()` calls - so a listener the plugin registered is
    // the only thing that can claim this request.
    const previous = process.env['DSH_HOME']
    const home = tempHome('dsh-wechat-cards-')
    process.env['DSH_HOME'] = home

    /** Text the channel sent over the wire, in order. */
    const sentTexts: string[] = []
    /** The id the card told the user to reply with. */
    let cardId = ''
    /** Set once the card has been sent, which is when a reply becomes valid. */
    let cardSent = false
    /** Set once the reply has been delivered, so it is not replayed. */
    let replied = false
    let polls = 0
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request, init?: { body?: unknown }) => {
      const href = String(url)
      if (href.includes('getupdates')) {
        polls += 1
        // The reply is delivered through the real inbound path rather than by
        // reaching into the channel, and only once the card has gone out - which
        // is also the ordering a person produces by reading before answering.
        // The reply is delivered by whichever poll first finds the card sent -
        // not a fixed poll number, because the card goes out only once the
        // waterfall is raised and the loop keeps polling meanwhile.
        const msgs = polls === 1
          ? [{
            message_id: 1, from_user_id: 'user-7', message_type: 1,
            context_token: 'ctx-1', item_list: [{ type: 1, text_item: { text: 'hi' } }],
          }]
          : cardSent && !replied && cardId !== ''
            ? (replied = true, [{
              message_id: 2, from_user_id: 'user-7', message_type: 1,
              context_token: 'ctx-2', item_list: [{ type: 1, text_item: { text: `${cardId} 1` } }],
            }])
            : []
        return new Response(JSON.stringify({ ret: 0, msgs, get_updates_buf: `c${polls}` }), { status: 200 })
      }
      if (href.includes('sendmessage')) {
        const body = JSON.parse(String(init?.body ?? '{}')) as {
          msg?: { item_list?: { text_item?: { text?: string } }[] }
        }
        const text = body.msg?.item_list?.[0]?.text_item?.text
        if (typeof text === 'string') {
          sentTexts.push(text)
          if (text.includes('需要权限确认')) {
            cardSent = true
            cardId = /回复：(\S+)/u.exec(text)?.[1] ?? ''
          }
        }
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

    let card = ''
    let outcome: string | undefined
    try {
      // The first message creates the session, and that mapping is how a card
      // finds the conversation it belongs to.
      await until(async () => live.size > 0, 3_000)
      const sessionId = 'channel-wechat-user-7'

      // `ctx.waterfall` is called through a narrow structural view: this suite
      // needs the real dispatch (only a listener the plugin registered can claim
      // the request) without taking a dependency on the approval package just
      // for its event augmentation.
      const waterfall = ctx.waterfall.bind(ctx) as unknown as (
        thisArg: unknown,
        name: string,
        request: unknown,
        fallback: () => Promise<string>,
      ) => Promise<string>
      const settled = waterfall(
        { id: 'a1', session: { id: sessionId } },
        'approval/request',
        {
          agent: { id: 'a1', session: { id: sessionId } },
          toolName: 'bash',
          reason: 'run: rm -rf build',
        },
        async () => 'unavailable',
      )
      // Held so an unresolved waterfall fails this test loudly instead of
      // leaving an unhandled rejection behind the assertion it should produce.
      void settled.catch(() => undefined)

      // The card reaches the user, and the reply then travels the same path a
      // person's message does.
      await until(async () => cardSent, 3_000)
      card = sentTexts.find(text => text.includes('需要权限确认')) ?? ''
      outcome = await settled
    } finally {
      await ctx.fiber.dispose()
      if (previous === undefined) delete process.env['DSH_HOME']
      else process.env['DSH_HOME'] = previous
    }

    // The card showed what was being decided...
    expect(card).toContain('bash')
    expect(card).toContain('rm -rf build')
    // ...and the reply reached the asker as the one-shot grant.
    expect(outcome).toBe('allowed-once')
  }, 30_000)

  it('admits an inbound image and delivers it as an image block', async () => {
    // The production half of M4's inbound path, and the defect it exists for:
    // every other media test injects a preparer, so none of them can see whether
    // `index.ts` ever builds one. If it does not, the image arrives as the text
    // `[图片]` and the model is told nothing.
    //
    // The store is the real `AttachmentStore` API, stubbed only where it would
    // touch a filesystem, so what is proven is the call sequence the plugin makes.
    const previous = process.env['DSH_HOME']
    const home = tempHome('dsh-wechat-media-')
    process.env['DSH_HOME'] = home

    /** Bytes the store was asked to admit. */
    const admitted: { data: Uint8Array; mediaType: string }[] = []
    /** Content the channel handed the agent. */
    const delivered: { content: readonly unknown[] }[] = []
    /** Ciphertext for the 1x1 PNG, produced by `openssl` (see the unit suite). */
    const CIPHERTEXT = 'c8bba2a6bcbe45b24bf686d06facf9703e58f866a0a91436a5b97a9fc8371bdb527e2ed8f3028914c02e1d0cded500d6'
    let polls = 0

    vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request) => {
      const href = String(url)
      if (href.includes('/download')) {
        return new Response(Buffer.from(CIPHERTEXT, 'hex'), { status: 200 })
      }
      if (href.includes('getupdates')) {
        polls += 1
        return new Response(JSON.stringify({
          ret: 0,
          msgs: polls === 1
            ? [{
              message_id: 1,
              from_user_id: 'user-7',
              message_type: 1,
              context_token: 'ctx-1',
              item_list: [{
                type: 2,
                image_item: {
                  // The item-level hex key, which the parser must normalize.
                  aeskey: '000102030405060708090a0b0c0d0e0f',
                  media: { encrypt_query_param: 'p1' },
                },
              }],
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
    // The model must declare image input, or the image is described instead of
    // attached - which is the correct behaviour but not what this test is about.
    ctx.provide('llm', {
      async resolveModelInfo() { return { inputModalities: ['text', 'image'] } },
    })
    // One real image, admitted through the store's own interface.
    ctx.provide('attachments', {
      async saveImages(inputs: readonly { data: Uint8Array; mediaType: string }[]) {
        for (const input of inputs) admitted.push(input)
        return inputs.map((input, index) => ({
          attachmentId: `att-${String(index)}`,
          mediaType: input.mediaType,
          bytes: input.data.length,
          width: 1,
          height: 1,
        }))
      },
      async saveFile(input: { data: Uint8Array; name?: string }) {
        return { attachmentId: 'file-0', name: input.name ?? 'f', bytes: input.data.length }
      },
    })
    const live = new Map<string, unknown>()
    ctx.provide('agents', {
      async create({ sessionId }: { sessionId: string }) {
        const agent = {
          id: sessionId,
          followup: (message: { content: readonly unknown[] }) => { delivered.push(message) },
          whenIdle: async () => {},
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
      await until(async () => delivered.length > 0, 5_000)
    } finally {
      await ctx.fiber.dispose()
      if (previous === undefined) delete process.env['DSH_HOME']
      else process.env['DSH_HOME'] = previous
    }

    // The store was asked for the right format, sniffed from the bytes rather
    // than assumed...
    expect(admitted).toHaveLength(1)
    expect(admitted[0]?.mediaType).toBe('image/png')
    // ...and the admitted reference reached the agent as a real image block,
    // after the label that stands in for the media.
    expect(delivered[0]?.content).toEqual([
      { type: 'text', text: '[图片]' },
      {
        type: 'image',
        attachment: { attachmentId: 'att-0', mediaType: 'image/png', bytes: 33, width: 1, height: 1 },
      },
    ])
  }, 30_000)

  it('uploads and sends a file the agent declared with present', async () => {
    // The production half of the outbound path, and the defect it exists for:
    // every other deliverable test injects the sender, so none of them can see
    // whether `index.ts` ever builds one. Without it a declared file reaches the
    // GUI and never the user's phone.
    const previous = process.env['DSH_HOME']
    const home = tempHome('dsh-wechat-deliver-')
    process.env['DSH_HOME'] = home

    /** Every request the plugin made, in order. */
    const calls: { url: string; body?: unknown }[] = []
    let polls = 0
    // The plugin's own lines go to `console.error`; captured so the SUCCESS of a
    // send is observable. Without this, "no output" cannot be told apart from
    // "nothing ran" - which is exactly the ambiguity a live test left behind.
    const logged: string[] = []
    const consoleError = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      logged.push(args.map(String).join(' '))
    })
    /** The file being presented, which the plugin must read from disk. */
    const dir = mkdtempSync(join(tmpdir(), 'dsh-present-'))
    const filePath = join(dir, 'report.txt')
    writeFileSync(filePath, 'hello deliverable')

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

    vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request, init?: { body?: unknown }) => {
      const href = String(url)
      calls.push({ url: href, ...(init?.body === undefined ? {} : { body: init.body }) })
      console.error('STAGE call:', href.slice(0, 70))
      if (href.includes('getupdates')) {
        // One message, because the session-to-peer mapping is recorded as a
        // message is delivered - and a presented file finds its conversation
        // through that mapping.
        polls += 1
        return new Response(JSON.stringify({
          ret: 0,
          msgs: polls === 1
            ? [{
              message_id: 1, from_user_id: 'user-7', message_type: 1,
              context_token: 'ctx-1', item_list: [{ type: 1, text_item: { text: 'hi' } }],
            }]
            : [],
          get_updates_buf: `c${polls}`,
        }), { status: 200 })
      }
      if (href.includes('getuploadurl')) {
        // A COMPLETE url rather than a bare parameter: this is the branch the
        // runtime maps from the wire's snake_case, and it is preferred over
        // rebuilding one - so a mapping slip here posts to the wrong object.
        return new Response(JSON.stringify({ ret: 0, upload_full_url: 'https://cdn.test/authorized' }), { status: 200 })
      }
      if (href === 'https://cdn.test/authorized' || href.includes('/upload?')) {
        // The CDN answers success with a HEADER, not a body.
        return new Response(null, { status: 200, headers: { 'x-encrypted-param': 'dl-1' } })
      }
      return new Response(JSON.stringify({ ret: 0 }), { status: 200 })
    }) as unknown as typeof fetch)

    await ctx.plugin({ name: 'channel-wechat-startup', inject: ['cmdlineArgs'], apply: applyStartup })
    await ctx.plugin({
      name: 'channel-wechat',
      inject: ['wechatStartup', 'credentials', 'agents', 'commands', 'agentDefaultModel'],
      apply: applyChannel,
    }, { cwd: dir })

    try {
      // The mapping from session to peer is built when a message arrives, which
      // is also how the presented file finds its conversation.
      await until(async () => live.size > 0, 3_000)
      // The session-to-peer mapping is recorded as a message is delivered, so
      // the poll must have answered at least once before the event can route.
      await until(async () => calls.some(call => call.url.includes('getupdates')), 3_000)
      const sessionId = 'channel-wechat-user-7'
      // Raised the way the real listener raises it: through the context's own
      // event surface, from the tool's own event shape.
      // Emitted through a structural view, because the event's arguments are
      // typed per event name and this suite needs only the session-id routing.
      const emit = ctx.emit.bind(ctx) as unknown as (
        name: string, session: { id: string; header: { cwd: string } }, event: unknown,
      ) => void
      emit('session/event',
        { id: sessionId, header: { cwd: dir } },
        { type: 'deliverables/presented', data: { turn: 1, callId: 'c1', files: [{ path: filePath, description: '报表' }] } })

      await until(async () => calls.some(call => call.url.includes('sendmessage')), 5_000)
      console.error('STAGE sent')
    } finally {
      await ctx.fiber.dispose()
      if (previous === undefined) delete process.env['DSH_HOME']
      else process.env['DSH_HOME'] = previous
    }

    // The file was uploaded to the CDN with metadata the server checks...
    const uploadAsk = calls.find(call => call.url.includes('getuploadurl'))
    const ask = JSON.parse(String(uploadAsk?.body ?? '{}')) as Record<string, unknown>
    expect(ask['rawsize']).toBe('hello deliverable'.length)
    // 17 plaintext bytes pad to 32 with PKCS#7, which is what the server checks
    // against what is actually posted.
    expect(ask['filesize']).toBe(32)
    // ...the ciphertext was posted, and the download parameter was read from the
    // response header...
    expect(calls.some(call => call.url === 'https://cdn.test/authorized')).toBe(true)
    // ...and the message the user receives cites that parameter and the name.
    const send = calls.find(call => call.url.includes('sendmessage'))
    const body = JSON.parse(String(send?.body ?? '{}')) as { msg?: { item_list?: unknown[] } }
    expect(body.msg?.item_list).toEqual([{
      type: 4,
      file_item: {
        media: { encrypt_query_param: 'dl-1', aes_key: expect.any(String), encrypt_type: 1 },
        file_name: 'report.txt',
        len: String('hello deliverable'.length),
      },
    }])

    // A successful send says so. Only failures were recorded before this, so a
    // silent success and a silent no-op looked identical from the outside - and
    // that ambiguity is what made a live test unable to answer whether the file
    // had gone out.
    consoleError.mockRestore()
    expect(logged.join('\n')).toMatch(/已发送文件/u)
    expect(logged.join('\n')).toContain('report.txt')
    expect(logged.join('\n')).toContain('user-7')
  }, 30_000)

  it('reports an unreadable reference through the plugin\u2019s own reporter', async () => {
    // The production wiring, and the gap a mutation exposed: every composition
    // test injects the reporter, so none of them can see whether `index.ts`
    // wires one. Without it the wire shape is recorded nowhere, and telling an
    // unreadable reference from an ordinary message needs a phone screenshot.
    const previous = process.env['DSH_HOME']
    const home = tempHome('dsh-wechat-quote-')
    process.env['DSH_HOME'] = home

    /** The plugin's own lines, which go to `console.error`. */
    const logged: string[] = []
    const consoleError = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      logged.push(args.map(String).join(' '))
    })
    let polls = 0

    vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request) => {
      const href = String(url)
      if (href.includes('getupdates')) {
        polls += 1
        return new Response(JSON.stringify({
          ret: 0,
          msgs: polls === 1
            ? [{
              message_id: 1, from_user_id: 'user-7', message_type: 1,
              context_token: 'ctx-1',
              // The shape seen on a phone: a reference with its content omitted.
              item_list: [{ type: 1, text_item: { text: '他妈妈呢？' }, ref_msg: { svr_id: '123' } }],
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

    try {
      await until(async () => logged.some(line => line.includes('引用的消息内容未能读取')), 5_000)
    } finally {
      await ctx.fiber.dispose()
      consoleError.mockRestore()
      if (previous === undefined) delete process.env['DSH_HOME']
      else process.env['DSH_HOME'] = previous
    }

    expect(logged.join('\n')).toContain('引用的消息内容未能读取')
    expect(logged.join('\n')).toContain('user-7')
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

  it('writes its diagnostics to a file the harness home owns', async () => {
    // The seam this suite exists for. Every unit test injects its own sink, so
    // none of them can observe whether `apply` ever builds one - the exact shape
    // that hid a missing `sessionEvents` subscription, a missing `cwd`, and a
    // missing unreadable-quote report. A `createLogFileSink` that is correct and
    // simply never called looks identical from the unit suite's side.
    //
    // On the desktop app this file is the only trace a diagnostic leaves: the
    // host's stdout goes to a process with no terminal and no log file.
    const previous = process.env['DSH_HOME']
    const home = tempHome('dsh-wechat-log-')
    process.env['DSH_HOME'] = home

    vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request) => {
      if (String(url).includes('getupdates')) {
        return new Response(JSON.stringify({ ret: 0, msgs: [], get_updates_buf: 'c1' }), { status: 200 })
      }
      return new Response(JSON.stringify({ ret: 0 }), { status: 200 })
    }) as unknown as typeof fetch)

    const ctx = new Context()
    provideCmdline(ctx, { args: [], exit: () => {}, ready: { commit() {}, await: async () => {} } } as never)
    await ctx.plugin(CredentialsLocal as never, {} as never)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(CommandRuntime)
    ctx.provide('agentDefaultModel', {
      currentSelection: () => ({ provider: 'deepseek-official', model: 'deepseek-v4.1-flash' }),
    })
    await saveAccount(ctx, { botToken: 'tok-1', accountId: 'bot-9' })
    await ctx.plugin({ name: 'channel-wechat-startup', inject: ['cmdlineArgs'], apply: applyStartup })
    await ctx.plugin({ name: 'channel-wechat', inject: ['wechatStartup', 'credentials', 'agents'], apply: applyChannel }, { cwd: '/work' })

    // `polling as` is reported once the loop's first poll succeeds, so waiting
    // for the file to contain it waits for the real run rather than for a timer.
    const logDir = join(home, 'channel-wechat', 'log')
    await until(async () => {
      try {
        return readdirSync(logDir).some(entry => readFileSync(join(logDir, entry), 'utf8').includes('polling as'))
      } catch {
        return false
      }
    })
    await ctx.fiber.dispose()

    const files = readdirSync(logDir)
    expect(files).toHaveLength(1)
    expect(files[0]).toMatch(/^channel-wechat-\d{4}-\d{2}-\d{2}\.log$/u)
    const body = readFileSync(join(logDir, files[0]!), 'utf8')
    // The account it polls as, reported through the production reporter.
    expect(body).toContain('[channel-wechat] polling as: bot-9')
    // One line per report, each newline-terminated: appending line by line is
    // what makes the file readable while the process is still running.
    expect(body.endsWith('\n')).toBe(true)

    if (previous === undefined) delete process.env['DSH_HOME']
    else process.env['DSH_HOME'] = previous
  }, 30_000)

  it('writes the login address to the log file, not only to a terminal', async () => {
    // The whole reason the log file exists is the desktop app, where the host's
    // stdout goes to a process with no terminal and no log file. So the one line
    // a first-time user needs - where to scan the QR - was the one line that
    // survived only in a place that user cannot see.
    //
    // Observed on a real desktop install: the plugin loaded, its routes answered,
    // and the user had no login address and no log directory at all. Every other
    // report is written only once there is an account to poll; with none, this
    // line was the only thing that would have created the file.
    const previous = process.env['DSH_HOME']
    const home = tempHome('dsh-wechat-login-line-')
    process.env['DSH_HOME'] = home

    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ret: 0 }), { status: 200 })) as unknown as typeof fetch)

    const ctx = new Context()
    provideCmdline(ctx, { args: [], exit: () => {}, ready: { commit() {}, await: async () => {} } } as never)
    await ctx.plugin(CredentialsLocal as never, {} as never)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(CommandRuntime)
    ctx.provide('agentDefaultModel', {
      currentSelection: () => ({ provider: 'deepseek-official', model: 'deepseek-v4.1-flash' }),
    })
    // A browser-facing host, which is the only place a panel exists at all.
    ctx.provide('connection', {
      fetch: { register: () => () => {} },
    } as never)
    ctx.provide('webServer', { port: 19387, host: '127.0.0.1' })
    // No account: the state a first-time user is in, and the state in which
    // `polling as` never runs to create the file.
    await ctx.plugin({ name: 'channel-wechat-startup', inject: ['cmdlineArgs'], apply: applyStartup })
    await ctx.plugin({ name: 'channel-wechat', inject: ['wechatStartup', 'credentials', 'agents'], apply: applyChannel }, { cwd: '/work' })

    const logDir = join(home, 'channel-wechat', 'log')
    await until(async () => {
      try {
        return readdirSync(logDir).some(entry => readFileSync(join(logDir, entry), 'utf8').includes('微信登录'))
      } catch {
        return false
      }
    })
    await ctx.fiber.dispose()

    const files = readdirSync(logDir)
    const body = readFileSync(join(logDir, files[0]!), 'utf8')
    // The address a person can actually open, with the port the host bound.
    expect(body).toContain('http://127.0.0.1:19387/api/channel-wechat/login')

    if (previous === undefined) delete process.env['DSH_HOME']
    else process.env['DSH_HOME'] = previous
  }, 30_000)

  it('records a channel that dies before it ever polls', async () => {
    // The diagnostics most worth keeping are the ones from a channel that never
    // came up: on the desktop app the file is the only trace, and a start
    // failure is otherwise a message the user watches arrive with no reply.
    //
    // This deliberately omits `agentDefaultModel`, which the run reads. The
    // throw happens inside the detached launch, so nothing surfaces at the call
    // site - only the reporter sees it, which is what makes this the test that
    // proves `channel stopped` was routed there rather than to the logger that
    // reaches nothing on that host.
    const previous = process.env['DSH_HOME']
    const home = tempHome('dsh-wechat-crash-')
    process.env['DSH_HOME'] = home

    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ret: 0 }), { status: 200 })) as unknown as typeof fetch)

    const ctx = new Context()
    provideCmdline(ctx, { args: [], exit: () => {}, ready: { commit() {}, await: async () => {} } } as never)
    await ctx.plugin(CredentialsLocal as never, {} as never)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(CommandRuntime)
    await saveAccount(ctx, { botToken: 'tok-1', accountId: 'bot-9' })
    await ctx.plugin({ name: 'channel-wechat-startup', inject: ['cmdlineArgs'], apply: applyStartup })
    await ctx.plugin({ name: 'channel-wechat', inject: ['wechatStartup', 'credentials', 'agents'], apply: applyChannel }, { cwd: '/work' })

    const logDir = join(home, 'channel-wechat', 'log')
    await until(async () => {
      try {
        return readdirSync(logDir).some(entry => readFileSync(join(logDir, entry), 'utf8').includes('channel stopped'))
      } catch {
        return false
      }
    })
    await ctx.fiber.dispose()

    const body = readFileSync(join(logDir, readdirSync(logDir)[0]!), 'utf8')
    expect(body).toContain('[channel-wechat] channel stopped: ')
    expect(body).toContain('agentDefaultModel')

    if (previous === undefined) delete process.env['DSH_HOME']
    else process.env['DSH_HOME'] = previous
  }, 30_000)
})
