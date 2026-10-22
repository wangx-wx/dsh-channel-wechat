/**
 * The channel's own model and permission settings, driven through the real
 * `apply`.
 *
 * This file exists because of the defect pattern this repository keeps
 * repeating: a unit test injects its own collaborator, so **no test observes
 * whether `apply` wired it up at all**. Everything here starts from the built
 * entry point and the real `apply`, with the profile's services provided around
 * it, and then reads back what the running channel actually did.
 *
 * Both settings have a silent failure mode, which is why they are worth pinning
 * end to end rather than trusting the units:
 *
 *  - a model that never reaches the registry produces a session whose first turn
 *    fails on the system prompt's `{{model}}` reference, which the user reads as
 *    "I sent a message and got nothing";
 *  - a permission that never reaches the permission service leaves the session
 *    on the composition's default, which is indistinguishable from the setting
 *    having been honoured - the user believes they are read-only and are not.
 *
 * The wire is stubbed at `fetch`, so nothing here touches a network or a real
 * WeChat account.
 */

import { readFileSync } from 'node:fs'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { LlmAdapter, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { REPO_ROOT } from '../support/harness.ts'
import { accountKey } from '../../src/credentials.ts'

/** The credential record key this suite's stubbed store reports. */
function accountKeyOf(accountId: string): string {
  return accountKey(accountId)
}

/** The persona the web app configures; it is why a missing model fails loudly. */
const WEB_APP_SYSTEM_PROMPT = {
  personaPrefix: 'You are a coding agent powered by the {{model}} model.',
  personaSuffix: 'Your working directory is {{cwd}}.',
}

const contexts: Context[] = []
/** Temporary DSH_HOMEs, so this suite never writes into a developer's own. */
const homes: string[] = []
/** The `DSH_HOME` in force before this suite changed it. */
let previousHome: string | undefined
let homeChanged = false

afterEach(async () => {
  while (contexts.length > 0) await contexts.pop()?.fiber.dispose()
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
  if (homeChanged) {
    if (previousHome === undefined) delete process.env['DSH_HOME']
    else process.env['DSH_HOME'] = previousHome
    homeChanged = false
  }
  vi.unstubAllGlobals()
})

/** A model that answers immediately, recording which route it was called on. */
class RecordingAdapter extends LlmAdapter {
  readonly calls: { provider: string; model: string }[] = []

  override async * stream(options: { provider: string; model: string }): AsyncIterable<StreamChunk> {
    this.calls.push({ provider: options.provider, model: options.model })
    // The same chunk sequence the real-loop suite uses: the reply is committed
    // from `block-end`, so a `text-delta` alone produces no `assistant/message`
    // and the channel has nothing to send back.
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: 'ok' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'ok' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

/** The built entry the manifest advertises, so this drives the shipped artifact. */
function builtEntry(): string {
  const manifest = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')) as { main?: string }
  return join(REPO_ROOT, manifest.main ?? 'lib/index.js')
}

/** The account the credentials store reports, so the channel polls with no login. */
const STORED_ACCOUNT = {
  kind: 'grant',
  payload: { botToken: 'bot-token', baseUrl: 'https://wechat.invalid' },
}

/** One inbound WeChat text message, as the wire delivers it. */
const INBOUND = {
  message_id: 1,
  from_user_id: 'user-7',
  message_type: 1,
  message_state: 2,
  context_token: 'ctx-1',
  item_list: [{ type: 1, text_item: { text: 'hello' } }],
}

/** Everything a test inspects after the run. */
interface World {
  readonly ctx: Context
  /** Every model route an adapter was actually called on. */
  readonly calls: { provider: string; model: string }[]
  /** Presets the permission service was asked to record, with the session they hit. */
  readonly permissionCalls: { session: unknown; preset: string }[]
  /** Every text the channel sent back to WeChat. */
  readonly sent: { peerId: string; text: string }[]
  /** Polls the wire has answered, so a test can wait for delivery to have happened. */
  polls: () => number
  /** Raise one waterfall exactly as the approval seam does. */
  waterfall: (name: string, request: unknown) => Promise<string>
  /** Every typing-shaped request the run made, in order. */
  typingCalls: readonly { kind: 'getconfig' | 'sendtyping'; userId: string; status: number }[]
  /**
   * Apply a config change the way the GUI does.
   *
   * `cwd` and every other field here are `volatile`, and a volatile-only change
   * is committed in place by the Loader - which is what makes this the exact
   * path a save from the plugin page takes. Driving `update()` is therefore
   * closer to the defect than writing the patch file and rebooting.
   */
  reconfigure: (next: Record<string, unknown>) => Promise<void>
  /** Hand the wire one more batch of messages on its next poll. */
  deliver: (msgs: readonly unknown[]) => void
}

/**
 * Boot the real plugin row against a stubbed wire.
 *
 * @param config - the plugin config, as the profile's patch layer supplies it.
 * @param options - whether the deployment composes a permission service.
 * @returns the world, once `apply` has returned and the detached run has started.
 */
async function boot(
  config: Record<string, unknown>,
  options: { withPermission?: boolean; messages?: readonly unknown[] } = {},
): Promise<World> {
  const module = await import(builtEntry())
  const ctx = new Context()
  contexts.push(ctx)

  // The plugin writes its diagnostic log under `$DSH_HOME`. Pointing that at a
  // temporary directory is what keeps this suite out of the developer's real
  // `~/.dsh` - the first run of this file tried to write there and was refused
  // by the sandbox, which is the only reason it was noticed.
  const home = mkdtempSync(join(tmpdir(), 'dsh-wechat-policy-'))
  homes.push(home)
  if (!homeChanged) { previousHome = process.env['DSH_HOME']; homeChanged = true }
  process.env['DSH_HOME'] = home

  await mountAgentLoopTestDependencies(ctx, { systemPrompt: WEB_APP_SYSTEM_PROMPT })
  await mountAgentLoopTestHarness(ctx)

  // Adapters for both routes: the configured one and the profile's default. Both
  // must exist so the assertion is about *which* route ran, rather than about
  // which one happened to be registered.
  const adapter = new RecordingAdapter()
  ctx.llm.registerAdapter(['wechat-scripted'], adapter)
  ctx.llm.registerAdapter(['profile-default'], adapter)

  const messages = options.messages ?? [INBOUND]
  const sent: { peerId: string; text: string }[] = []
  /** Every typing-shaped request the run made, in order. */
  const typingCalls: { kind: 'getconfig' | 'sendtyping'; userId: string; status: number }[] = []
  let polls = 0
  // The message the wire hands over on its next poll, consumed once and then
  // reset. A reconfigure test needs to inject a second message *after* the
  // remount, which is the situation the defect reports.
  let pending: readonly unknown[] | undefined

  // The record key must be one `listAccounts` accepts, or the channel finds no
  // account and never starts polling - a failure that looks like "the plugin did
  // nothing" rather than like a stub mistake.
  const accountKey = accountKeyOf('bot-1')
  ctx.provide('credentials', {
    listRecords: async () => [{ key: accountKey }],
    readRecord: async () => STORED_ACCOUNT,
    modifyRecord: async () => undefined,
    deleteRecord: async () => undefined,
  })
  ctx.provide('commands', { execute: async () => undefined, list: () => [] })
  ctx.provide('agentDefaultModel', {
    currentSelection: () => ({ provider: 'profile-default', model: 'profile-model' }),
  })
  const { provideCmdline } = await import('@deepseek-ai/dsh-cmdline')
  provideCmdline(ctx, { args: [], exit: () => {}, ready: { commit() {}, await: async () => {} } } as never)

  const permissionCalls: { session: unknown; preset: string }[] = []
  if (options.withPermission === true) {
    ctx.provide('permissionPresets', {
      set: (session: unknown, preset: string) => { permissionCalls.push({ session, preset }) },
    })
  }

  // One poll carrying the message, then empty polls. `msgs` is the only field
  // the parser reads beyond the cursor.
  vi.stubGlobal('fetch', (async (input: string | URL, init?: RequestInit) => {
    const url = String(input)
    if (url.includes('getupdates')) {
      polls += 1
      let msgs: readonly unknown[] = []
      if (pending !== undefined) { msgs = pending; pending = undefined }
      else if (polls === 1) msgs = messages
      const body = { ret: 0, get_updates_buf: `c${String(polls)}`, msgs }
      return new Response(JSON.stringify(body), { status: 200 })
    }
    if (url.includes('sendmessage')) {
      // Recorded here rather than through the API's return value, so the
      // assertion is about what actually left the process. The message is nested
      // under `msg`; reading the top level yields an empty string and a test that
      // passes for the wrong reason.
      const parsed = JSON.parse(String(init?.body ?? '{}')) as {
        msg?: { to_user_id?: string, item_list?: { text_item?: { text?: string } }[] }
      }
      sent.push({
        peerId: parsed.msg?.to_user_id ?? '',
        text: parsed.msg?.item_list?.[0]?.text_item?.text ?? '',
      })
      return new Response('{}', { status: 200 })
    }
    if (url.includes('getconfig')) {
      // The ticket the indicator needs. Answering it is what lets the assertion
      // below be about the *status* reports rather than about a missing ticket.
      typingCalls.push({ kind: 'getconfig', userId: '', status: 0 })
      return new Response(JSON.stringify({ ret: 0, typing_ticket: 'ticket-1' }), { status: 200 })
    }
    if (url.includes('sendtyping')) {
      const parsed = JSON.parse(String(init?.body ?? '{}')) as {
        ilink_user_id?: string, typing_ticket?: string, status?: number
      }
      typingCalls.push({
        kind: 'sendtyping',
        userId: parsed.ilink_user_id ?? '',
        status: parsed.status ?? 0,
      })
      return new Response(JSON.stringify({ ret: 0 }), { status: 200 })
    }
    return new Response('{}', { status: 200 })
  }) as unknown as typeof fetch)

  const fiber = ctx.plugin(module, { cwd: '/work', ...config })
  await fiber

  /** The real dispatch, narrowed to what this suite raises. */
  const waterfall = ctx.waterfall.bind(ctx) as unknown as (
    thisArg: unknown,
    name: string,
    request: unknown,
    fallback: () => Promise<string>,
  ) => Promise<string>

  return {
    ctx,
    calls: adapter.calls,
    permissionCalls,
    sent,
    polls: () => polls,
    typingCalls,
    waterfall: (name, request) => waterfall(
      request as never,
      name,
      request,
      // The seam's own "nobody claimed it" value. A card the channel did not
      // send would resolve immediately to this instead of hanging the test.
      async () => 'unavailable',
    ),
    reconfigure: async next => {
      await (fiber as never as { update: (config: unknown) => Promise<void> }).update({ cwd: '/work', ...config, ...next })
    },
    deliver: (msgs: readonly unknown[]) => { pending = msgs },
  }
}

/** Wait until a condition holds, so a detached run can make progress. */
async function until(check: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (check()) return
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  throw new Error('condition never held')
}

/** The session this channel created for the test peer, once it exists. */
function sessionOf(ctx: Context): { header: { config: { provider?: string; model?: string } } } | undefined {
  return ctx.agents.get('channel-wechat-user-7' as never)?.session as never
}

describe('the model this channel configures', () => {
  it('runs the turn on the configured route instead of the profile default', async () => {
    // The observable consequence of the setting, and the reason it is worth an
    // end-to-end test: reading the config is easy to wire halfway. Both routes
    // have an adapter here, so what this asserts is *which* one the model was
    // actually called on rather than which one happened to be registered.
    const world = await boot({ provider: 'wechat-scripted', model: 'scripted' })

    // Wait on the reply, not just the model call: the send is a later step of the
    // same turn, so awaiting only the call would race the assertion below.
    await until(() => world.sent.length > 0)

    expect(world.calls[0]).toEqual({ provider: 'wechat-scripted', model: 'scripted' })
    expect(world.sent[0]?.text).toBe('ok')
  })

  it('falls back to the profile default when the pair is empty', async () => {
    // A user who never opened the page must keep the behaviour this plugin had
    // before the fields existed. Asserted on the route that ran, so a channel
    // that pinned an empty provider would fail here rather than pass by accident.
    const world = await boot({ provider: '', model: '' })

    await until(() => world.calls.length > 0)

    expect(world.calls[0]).toEqual({ provider: 'profile-default', model: 'profile-model' })
  })
})

describe('the permission preset this channel configures', () => {
  it('records the configured preset on the session it creates', async () => {
    const world = await boot({ permission: 'read-only' }, { withPermission: true })

    await until(() => world.permissionCalls.length > 0)

    expect(world.permissionCalls).toHaveLength(1)
    expect(world.permissionCalls[0]?.preset).toBe('read-only')
  })

  it('records the configured preset even when it widens access', async () => {
    // The value the user asked to keep available. It is offered deliberately,
    // with the page's own risk confirmation, so the host side must not quietly
    // refuse it.
    const world = await boot({ permission: 'danger-full-access' }, { withPermission: true })

    await until(() => world.permissionCalls.length > 0)

    expect(world.permissionCalls[0]?.preset).toBe('danger-full-access')
  })

  it('records nothing when the deployment composes no permission service', async () => {
    // The headless composition: no confining executor, so no permission service.
    // The channel must still start and run - a throw here would abort session
    // creation and cost the user their reply.
    const world = await boot({ permission: 'read-only' })

    await until(() => sessionOf(world.ctx) !== undefined)

    expect(world.permissionCalls).toEqual([])
  })
})

describe('the session-wide choice on an approval card', () => {
  it('widens the session the card belongs to, through the real wiring', async () => {
    // The card's third option existed in the unit suite only until this case:
    // the service was handed a fake `elevate`, so nothing observed whether
    // `apply` connected one. A missing wiring here degrades to "the option
    // reports failure", which looks like a permission problem rather than a
    // plugin one.
    const world = await boot({ permission: 'workspace-write' }, { withPermission: true })
    await until(() => sessionOf(world.ctx) !== undefined)

    const sessionId = 'channel-wechat-user-7'
    const settled = world.waterfall('approval/request', {
      agent: { id: 'a1', session: { id: sessionId } },
      toolName: 'bash',
      reason: 'run: rm -rf build',
    })
    await until(() => world.sent.some(text => text.text.includes('需要权限确认')))

    const card = world.sent.find(text => text.text.includes('需要权限确认'))?.text ?? ''
    const cardId = /回复：(\S+)/u.exec(card)?.[1] ?? ''
    world.deliver([{
      message_id: 9, from_user_id: 'user-7', message_type: 1,
      context_token: 'ctx-9', item_list: [{ type: 1, text_item: { text: `${cardId} 3` } }],
    }])

    await expect(settled).resolves.toBe('allowed-once')
    await until(() => world.permissionCalls.some(call => call.preset === 'danger-full-access'))

    // The preset lands on the *live* session object, not on an id: `set` is how
    // the host records a durable knob, and a call carrying `undefined` would
    // pass a weaker assertion while changing nothing.
    const widened = world.permissionCalls.find(call => call.preset === 'danger-full-access')
    expect(widened?.session).toBe(sessionOf(world.ctx))
    // Waited for rather than read off the end of the list. The confirmation goes
    // through the same paced queue as every other outbound text, so it lands
    // after the gap the queue enforces - asserting immediately would be a race
    // that happens to pass at a short enough gap.
    await until(() => world.sent.some(entry => /不再弹出审批卡/u.test(entry.text)))
  }, 30_000)
})

describe('the typing indicator, through the real wiring', () => {
  it('shows it around a turn and withdraws it, with a ticket fetched once', async () => {
    // The unit suites cover the cache and the lifecycle separately; this is the
    // only case that observes `apply` building the indicator from the run's own
    // account. Without that wiring every unit still passes and the user sees
    // nothing, which is the failure mode this repository keeps repeating.
    const world = await boot({})

    await until(() => world.typingCalls.some(call => call.kind === 'sendtyping' && call.status === 2))
    await until(() => world.sent.length > 0)

    const kinds = world.typingCalls.map(call => call.kind === 'getconfig' ? 'getconfig' : `sendtyping:${String(call.status)}`)
    // One ticket, then the indicator on and off. The order is the point: a
    // cancel that arrived first would leave the indicator showing.
    expect(kinds).toEqual(['getconfig', 'sendtyping:1', 'sendtyping:2'])
  }, 30_000)
})

describe('saving the page while the channel is running', () => {
  it('still answers the next message after a working directory change', async () => {
    // The reported defect. `cwd` is volatile, so saving it is a volatile-only
    // config change - which the Loader applies *without* tearing the plugin
    // down: it commits the new value and re-runs `apply` for nothing else. What
    // the user sees is t1 set a directory, t2 works, t3 change the directory,
    // t4 silence.
    //
    // Silence, not an error, because the old run is still polling: it holds the
    // account's cursor and a live session for the peer, so the *new* run finds
    // both already taken. The message is polled, delivered to a session whose
    // handle the new run does not own, and nothing comes back.
    const world = await boot({})
    await until(() => world.sent.length > 0)

    await world.reconfigure({ cwd: '/elsewhere' })
    // Let the remount settle, then send the message that used to go unanswered.
    await new Promise(resolve => setTimeout(resolve, 300))
    world.deliver([{ ...INBOUND, message_id: 2, item_list: [{ type: 1, text_item: { text: 'after save' } }] }])

    await until(() => world.sent.length > 1, 8_000)

    expect(world.sent[1]?.text).toBe('ok')
    // Exactly one peer from the replacement's point of view, and exactly one
    // live session under the peer's id. Two would mean the old run still owned
    // one while the new run created another.
    expect(world.ctx.agents.get('channel-wechat-user-7' as never)).toBeDefined()
  }, 30_000)
})
