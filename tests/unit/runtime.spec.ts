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

import { describe, expect, it } from 'vitest'
import { startChannelFromStore } from '../../src/channel/runtime.ts'
import type { WechatAccount } from '../../src/credentials.ts'

/** An account as the login action would have stored it. */
function account(overrides: Partial<WechatAccount> = {}): WechatAccount {
  return { botToken: 'tok-1', accountId: 'bot-9', baseUrl: 'https://api.test', ...overrides }
}

/** What one start observed. */
function bench(accounts: WechatAccount[]) {
  const polls: { baseUrl: string; token: string; cursor: string | undefined }[] = []
  const sent: { to: string; text: string; contextToken: string | undefined }[] = []
  const saved: string[] = []
  let clock = 0
  let pollsDone = 0
  const messages: unknown[] = []
  const disposed: string[] = []

  return {
    polls,
    sent,
    saved,
    messages,
    disposed,
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
          return {
            agent: {
              id: sessionId,
              followup: () => {},
              whenIdle: async () => {},
            },
            dispose: async () => void disposed.push(sessionId),
          }
        },
        async resume() { throw new Error('no persisted session') },
        get: () => undefined,
      }),
      saveCursor: async cursor => void saved.push(cursor),
      sleep: async (ms: number) => { clock += ms },
      now: () => clock,
      pollTimeoutMs: 1_000,
      maxRunMs: 3_000,
      ...(signal === undefined ? {} : { signal }),
    }),
  }
}

describe('starting from a stored account', () => {
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
