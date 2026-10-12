/**
 * Starting the channel from a stored login.
 *
 * A normal `dsh <profile>` start finds whatever account the `login` action
 * stored and begins polling with it. Three things this has to get right:
 * it must not start without an account, it must use the account's own token and
 * base URL, and it must let the run stop cleanly.
 *
 * The poll and the send are injected, so this is verified without a network.
 */

import type { SessionId } from '@deepseek-ai/dsh-session'
import { describe, expect, it } from 'vitest'
import { startChannelFromStore } from '../../src/channel/runtime.ts'
import type { WechatAccount } from '../../src/credentials.ts'

/** An account as the login action would have stored it. */
function account(overrides: Partial<WechatAccount> = {}): WechatAccount {
  return { botToken: 'tok-1', accountId: 'bot-9', baseUrl: 'https://api.test', ...overrides }
}

/** The text the scripted model answers with. */
const MODEL_ANSWER = 'hello from the model'

/** What one start observed. */
function bench(accounts: WechatAccount[]) {
  const polls: { baseUrl: string; token: string; cursor: string | undefined }[] = []
  const sent: { to: string; text: string; contextToken: string | undefined }[] = []
  const saved: string[] = []
  let clock = 0
  let pollsDone = 0
  /**
   * The listener the runtime subscribed with, when it subscribed at all.
   *
   * Left `undefined` by a runtime that never subscribes, which is the defect
   * this bench exists to see: the model answers, and nothing carries the answer
   * back out.
   */
  let sessionEvents: ((session: { id: unknown }, event: unknown) => void) | undefined
  /** Sessions the fake registry currently holds, as the real one does. */
  const live = new Map<string, { readonly id: SessionId }>()
  const messages: unknown[] = []
  const disposed: string[] = []

  const b = {
    polls,
    sent,
    saved,
    messages,
    disposed,
    /** Harness commands this run forwarded, in order. */
    forwarded: [] as string[],
    /** Command names the harness offers, for `/help`. */
    nativeCommands: undefined as readonly string[] | undefined,
    /** Set to override the forwarder; defaults to a recording success. */
    executeNativeCommand: undefined as
      | ((line: string) => Promise<{ kind: 'success' | 'error'; text?: string } | undefined>)
      | undefined,
    run: (signal?: AbortSignal) => startChannelFromStore({
      listAccounts: async () => accounts,
      api: {
        async getUpdates(params) {
          polls.push({ baseUrl: params.baseUrl, token: params.token, cursor: params.cursor })
          pollsDone += 1
          return {
            msgs: pollsDone === 1 ? messages : [],
            get_updates_buf: `c${pollsDone}`,
            longpolling_timeout_ms: undefined,
          }
        },
        async sendText(params) {
          sent.push({ to: params.to, text: params.text, contextToken: params.contextToken })
        },
      },
      createRegistry: () => ({
        async create({ sessionId }) {
          const handle = {
            agent: {
              id: sessionId,
              followup: () => {},
              // The answer is committed while the turn is still in flight,
              // which is when the reply path reads it.
              whenIdle: async () => {
                sessionEvents?.(
                  { id: sessionId },
                  { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: MODEL_ANSWER }] } } },
                )
              },
            },
            dispose: async () => void disposed.push(sessionId),
          }
          // Reported live, as the real registry does after `create` resolves.
          // `require` refuses to deliver to a session the registry does not
          // know, so a `get` that always answered `undefined` would make every
          // delivery throw before the agent ever saw the message.
          live.set(sessionId, handle.agent)
          return handle
        },
        async resume() { throw new Error('no persisted session') },
        get: (id: string) => live.get(id),
      }),
      // Where the plugin hands over its session-event subscription. The reply
      // path reads the durable `assistant/message` event, so a run that never
      // subscribes sends nothing back.
      sessionEvents: {
        on: (_event: 'session/event', listener: (session: { id: unknown }, event: unknown) => void) => {
          sessionEvents = listener
          return () => { sessionEvents = undefined }
        },
      },
      saveCursor: async cursor => void saved.push(cursor),
      // Defaults to "no persisted session", which is what these tests set up.
      // A restart against an existing session has its own case below.
      sessionExists: async () => false,
      cwd: '/work',
      executeNativeCommand: (line: string) => {
        const custom = b.executeNativeCommand
        if (custom !== undefined) return custom(line)
        b.forwarded.push(line)
        return Promise.resolve({ kind: 'success' as const, text: 'ok' })
      },
      ...(b.nativeCommands === undefined ? {} : { nativeCommands: async () => b.nativeCommands ?? [] }),
      sleep: async (ms: number) => { clock += ms },
      now: () => clock,
      pollTimeoutMs: 1_000,
      maxRunMs: 3_000,
      ...(signal === undefined ? {} : { signal }),
    }),
  }
  return b
}

describe('starting from a stored account', () => {
  it('resumes a session that a previous run left on disk', async () => {
    // The second live scan exposed this. A peer's session id is derived from the
    // peer, so after any restart the id already has persisted state. The runtime
    // never supplied `sessionExists`, so its default (`false`) made every restart
    // call `create` for an id that already existed, and the registry rejected it:
    //
    //   SessionAlreadyExistsError: session "channel-wechat-…" already exists
    //
    // The message was then dropped and the cursor advanced past it, so every
    // inbound message was lost for the life of the process - with the failure
    // visible only through `ctx.logger`, which no profile exports.
    const resumed: string[] = []
    const created: string[] = []
    let clock = 0
    let rounds = 0

    await startChannelFromStore({
      listAccounts: async () => [account()],
      api: {
        async getUpdates() {
          rounds += 1
          return {
            msgs: rounds === 1 ? [{ from_user_id: 'user-7', msgtype: 1, text_item: { text: 'hi' } }] : [],
            get_updates_buf: `c${rounds}`,
            longpolling_timeout_ms: undefined,
          }
        },
        async sendText() {},
      },
      createRegistry: () => ({
        async create({ sessionId }) {
          created.push(sessionId)
          // The registry rejects a create for an id that already has state, which
          // is what the live run hit.
          throw new Error(`SessionAlreadyExistsError: session "${sessionId}" already exists`)
        },
        async resume({ resumeSessionId }) {
          resumed.push(resumeSessionId)
          return { agent: { id: resumeSessionId, followup: () => {}, whenIdle: async () => {} }, dispose: async () => {} }
        },
        get: () => undefined,
      }),
      // No turn runs in this case, so nothing needs to answer.
      sessionEvents: { on: () => () => {} },
      // The previous run left this peer's session on disk.
      sessionExists: async () => true,
      cwd: '/work',
      saveCursor: async () => {},
      sleep: async (ms: number) => { clock += ms },
      now: () => clock,
      pollTimeoutMs: 1_000,
      maxRunMs: 3_000,
    })

    expect(resumed).toEqual(['channel-wechat-user-7'])
    expect(created).toEqual([])
  })

  it('polls with the stored token and base URL', async () => {
    const b = bench([account()])

    await b.run()

    expect(b.polls.length).toBeGreaterThan(0)
    expect(b.polls[0]?.token).toBe('tok-1')
    expect(b.polls[0]?.baseUrl).toBe('https://api.test')
  })

  it('falls back to the documented base URL when the server never sent one', async () => {
    // The protocol's fixed entry point; a login that confirmed without a
    // `baseurl` still has somewhere to poll.
    const b = bench([account({ baseUrl: undefined })])

    await b.run()

    expect(b.polls[0]?.baseUrl).toBe('https://ilinkai.weixin.qq.com')
  })

  it('saves every cursor it receives', async () => {
    // The loop keeps polling until its run limit, so each response's cursor is
    // saved; the first is the one a restart resumes from.
    const b = bench([account()])

    await b.run()

    expect(b.saved.length).toBeGreaterThan(0)
    expect(b.saved[0]).toBe('c1')
    expect(b.saved).toEqual(b.polls.map((_, index) => `c${index + 1}`))
  })

  it('does not start when no account is stored', async () => {
    // Without credentials there is nothing to poll as; starting would produce
    // an unauthenticated request loop.
    const b = bench([])

    await b.run()

    expect(b.polls).toEqual([])
  })

  it('does not start when the stored account has no token', async () => {
    // A record without a token cannot authenticate anything.
    const b = bench([account({ botToken: undefined })])

    await b.run()

    expect(b.polls).toEqual([])
  })
})

describe('the reply path', () => {
  it('sends the model\'s answer back to WeChat', async () => {
    // The whole point of the channel: an answer the user never receives is the
    // same as no answer. The production run has to take the subscription the
    // reply is read from - `attach` existing is not the same as `attach` being
    // called, and a test that calls it itself cannot tell the difference.
    const b = bench([account()])
    b.messages.push({
      message_id: 1, from_user_id: 'user-7', message_type: 1,
      item_list: [{ type: 1, text_item: { text: 'hi' } }],
    })

    await b.run()

    expect(b.sent.map(entry => entry.text)).toContain(MODEL_ANSWER)
  })
})

describe('the command surface', () => {
  it('names the polling account so /status is useful', async () => {
    // Without the account id the channel cannot say which login is live, and
    // the user has no way to tell a working start from a stale one.
    const b = bench([account()])
    b.messages.push({
      message_id: 1, from_user_id: 'user-7', message_type: 1,
      item_list: [{ type: 1, text_item: { text: '/status' } }],
    })

    await b.run()

    expect(b.sent.map(entry => entry.text).join('')).toContain('bot-9')
  })

  it('forwards a harness command instead of sending it to the model', async () => {
    // `/goal off` belongs to the harness; letting it reach the model would burn
    // a turn to have the model explain a command it cannot run.
    const b = bench([account()])
    b.messages.push({
      message_id: 1, from_user_id: 'user-7', message_type: 1,
      item_list: [{ type: 1, text_item: { text: '/goal off' } }],
    })

    await b.run()

    expect(b.forwarded).toEqual(['/goal off'])
  })

  it('lists the harness commands to /help', async () => {
    // The native surface is the larger half of what a user can type.
    const b = bench([account()])
    b.nativeCommands = ['compact', 'goal']
    b.messages.push({
      message_id: 1, from_user_id: 'user-7', message_type: 1,
      item_list: [{ type: 1, text_item: { text: '/help' } }],
    })

    await b.run()

    expect(b.sent.map(entry => entry.text).join('')).toContain('/goal')
  })

  it('does not forward an ordinary message as a command', async () => {
    const b = bench([account()])
    b.messages.push({
      message_id: 1, from_user_id: 'user-7', message_type: 1,
      item_list: [{ type: 1, text_item: { text: 'hello' } }],
    })

    await b.run()

    expect(b.forwarded).toEqual([])
  })
})

describe('stopping', () => {
  it('releases every session it opened before returning', async () => {
    // A session left behind keeps its registry slot and write lease, so the
    // next start for that peer id would fail.
    const b = bench([account()])
    b.messages.push({
      message_id: 1,
      from_user_id: 'user-7',
      message_type: 1,
      item_list: [{ type: 1, text_item: { text: 'hi' } }],
    })

    await b.run()

    expect(b.disposed.length).toBeGreaterThan(0)
    expect(b.disposed).toContain('channel-wechat-user-7')
  })

  it('ends promptly when the signal aborts', async () => {
    const controller = new AbortController()
    const b = bench([account()])

    const running = b.run(controller.signal)
    await new Promise(resolve => setTimeout(resolve, 5))
    controller.abort()

    await expect(Promise.race([running, new Promise(resolve => setTimeout(() => resolve('timeout'), 500))]))
      .resolves.not.toBe('timeout')
  })
})
