/**
 * What the command-line action actually does.
 *
 * The startup provider parses the argument; this turns it into work — run the
 * QR login, print the code, store the credentials, and ask the launcher to
 * exit. The observable contract is the printed text, the stored account, and
 * the exit code, which is what a user and a script both see.
 */

import { describe, expect, it } from 'vitest'
import { runStartupAction } from '../../src/login-command.ts'
import type { ApiClient } from '../../src/wechat/api.ts'
import type { WechatStartupValues } from '../../src/startup.ts'

/** An API whose QR poll confirms immediately with the given account. */
function confirmingApi(account: { botToken: string; accountId: string; baseUrl?: string }): ApiClient {
  return {
    async post() {
      return JSON.stringify({ qrcode: 'qr-1', qrcode_img_content: 'https://weixin.test/qr-1' })
    },
    async get() {
      return JSON.stringify({
        status: 'confirmed',
        bot_token: account.botToken,
        ilink_bot_id: account.accountId,
        ...(account.baseUrl === undefined ? {} : { baseurl: account.baseUrl }),
      })
    },
  }
}

/** Everything one action run observed. */
function bench(startup: WechatStartupValues, api: ApiClient, stored: unknown[] = []) {
  const out: string[] = []
  const exits: number[] = []
  const saved: unknown[] = []
  return {
    out,
    exits,
    saved,
    run: () => runStartupAction({
      startup,
      api,
      now: () => 0,
      sleep: async () => {},
      timeoutMs: 1_000,
      write: text => void out.push(text),
      exit: code => void exits.push(code),
      saveAccount: async account => void saved.push(account),
      listAccounts: async () => stored as never,
    }),
  }
}

describe('the login action', () => {
  it('prints the QR url, stores the account it gets back, and exits cleanly', async () => {
    const b = bench({ action: 'login' }, confirmingApi({ botToken: 'tok-1', accountId: 'bot-9', baseUrl: 'https://api.test' }))

    await b.run()

    // The url is the only thing the user can act on, so it has to be printed
    // before polling starts; printing it after would offer a dead code.
    expect(b.out.join('')).toContain('https://weixin.test/qr-1')
    expect(b.saved).toEqual([
      { botToken: 'tok-1', accountId: 'bot-9', baseUrl: 'https://api.test', userId: undefined },
    ])
    expect(b.exits).toEqual([0])
  })

  it('prints the account id so the user can confirm which login was stored', async () => {
    const b = bench({ action: 'login' }, confirmingApi({ botToken: 'tok-1', accountId: 'bot-9' }))

    await b.run()

    expect(b.out.join('')).toContain('bot-9')
  })

  it('reports a failure with a non-zero exit and stores nothing', async () => {
    const failing: ApiClient = {
      async post() {
        throw new Error('offline')
      },
      async get() {
        return '{}'
      },
    }
    const b = bench({ action: 'login' }, failing)

    await b.run()

    expect(b.saved).toEqual([])
    expect(b.exits).toEqual([1])
    expect(b.out.join('')).not.toBe('')
  })

  it('leaves the process running when the invocation asked for nothing', async () => {
    // An ordinary `dsh <profile>` must not exit: it starts the server.
    const b = bench({ action: 'none' }, confirmingApi({ botToken: 'tok-1', accountId: 'bot-9' }))

    await b.run()

    expect(b.exits).toEqual([])
    expect(b.saved).toEqual([])
  })
})

describe('the status action', () => {
  it('lists stored accounts and exits without logging in', async () => {
    const b = bench({ action: 'status' }, confirmingApi({ botToken: 'x', accountId: 'unused' }), [
      { botToken: 'tok-1', accountId: 'bot-9' },
    ])

    await b.run()

    expect(b.out.join('')).toContain('bot-9')
    expect(b.exits).toEqual([0])
    // Status must never write: it is the read-only view of the same store.
    expect(b.saved).toEqual([])
  })

  it('says so when nothing is stored, still exiting cleanly', async () => {
    const b = bench({ action: 'status' }, confirmingApi({ botToken: 'x', accountId: 'unused' }), [])

    await b.run()

    expect(b.out.join('')).not.toBe('')
    expect(b.exits).toEqual([0])
  })

  it('prints JSON when the invocation asked for it', async () => {
    const b = bench({ action: 'status', json: true }, confirmingApi({ botToken: 'x', accountId: 'unused' }), [
      { botToken: 'tok-1', accountId: 'bot-9' },
    ])

    await b.run()

    const parsed = JSON.parse(b.out.join('')) as unknown[]
    expect(parsed).toEqual([{ botToken: 'tok-1', accountId: 'bot-9' }])
  })
})

describe('the logout action', () => {
  it('forgets the stored account and exits cleanly', async () => {
    const forgotten: string[] = []
    const b = bench({ action: 'logout' }, confirmingApi({ botToken: 'x', accountId: 'unused' }))

    await runStartupAction({
      startup: { action: 'logout' },
      api: confirmingApi({ botToken: 'x', accountId: 'unused' }),
      write: text => void b.out.push(text),
      exit: code => void b.exits.push(code),
      saveAccount: async () => {},
      listAccounts: async () => [{ botToken: 'tok-1', accountId: 'bot-9' }],
      forgetAccount: async accountId => void forgotten.push(accountId),
    })

    expect(forgotten).toEqual(['bot-9'])
    expect(b.exits).toEqual([0])
  })
})
