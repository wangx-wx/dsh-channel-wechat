/**
 * The login orchestration: poll the server, drive the state machine, and stop.
 *
 * The two things that only exist here are the loop's termination (a deadline,
 * and statuses that end it) and the fact that a `refresh-qr` effect becomes a
 * second HTTP call. Both are easy to get wrong in ways that hang a terminal, so
 * the loop is driven against a scripted server with a fake clock.
 */

import { describe, expect, it, vi } from 'vitest'
import type { ApiClient } from '../../src/wechat/api.ts'
import { runQrLogin } from '../../src/wechat/login-runner.ts'
import type { QrStatusResponse } from '../../src/wechat/login-machine.ts'

/** A scripted API: `get` pops the next status, `post` returns the next QR code. */
function scriptedApi(statuses: QrStatusResponse[], qrCodes: string[] = ['qr-1']) {
  const gets: string[] = []
  const posts: string[] = []
  let qrIndex = 0
  const api: ApiClient = {
    async get(params) {
      gets.push(params.endpoint)
      const next = statuses.shift()
      if (next === undefined) throw new Error('script exhausted')
      return JSON.stringify(next)
    },
    async post(params) {
      posts.push(params.body)
      const qrcode = qrCodes[qrIndex] ?? `qr-${qrIndex + 1}`
      qrIndex += 1
      return JSON.stringify({ qrcode, qrcode_img_content: `https://weixin.test/${qrcode}` })
    },
  }
  return { api, gets, posts }
}

/**
 * A clock that advances by exactly what the runner sleeps. A frozen clock never
 * reaches its deadline, so a test whose script runs out would spin forever.
 * The returned `sleep` is passed explicitly rather than spread, so a second
 * `sleep` option can never silently overwrite it.
 */
function fakeClock() {
  let current = 0
  return {
    now: () => current,
    sleep: async (ms: number) => void (current += ms),
  }
}

describe('login runner: happy path', () => {
  it('starts a login, polls, and returns the confirmed credentials', async () => {
    const { api, gets } = scriptedApi([
      { status: 'wait' },
      { status: 'scaned' },
      {
        status: 'confirmed',
        bot_token: 'tok-1',
        ilink_bot_id: 'bot-9',
        baseurl: 'https://api.test',
        ilink_user_id: 'user-7',
      },
    ])

    const result = await runQrLogin({ api, sleep: async () => {}, timeoutMs: 60_000 })

    expect(result).toEqual({
      kind: 'connected',
      credentials: { botToken: 'tok-1', accountId: 'bot-9', baseUrl: 'https://api.test', userId: 'user-7' },
    })
    // `wait` and `scaned` must each produce exactly one poll.
    expect(gets).toHaveLength(3)
  })

  it('hands the QR url to the caller before it starts polling', async () => {
    const { api } = scriptedApi([{ status: 'wait' }], ['qr-42'])
    const seen: string[] = []

    const clock = fakeClock()
    await runQrLogin({
      api,
      sleep: clock.sleep,
      now: clock.now,
      timeoutMs: 60_000,
      // The caller renders this, so an empty url means nothing to scan.
      onQrCode: qr => void seen.push(qr.qrcodeUrl),
    })

    expect(seen).toEqual(['https://weixin.test/qr-42'])
  })

  it('sends the verify code the caller supplies', async () => {
    const { api, gets } = scriptedApi([
      { status: 'need_verifycode' },
      { status: 'confirmed', ilink_bot_id: 'bot-9' },
    ])
    const asked: boolean[] = []

    await runQrLogin({
      api,
      sleep: async () => {},
      timeoutMs: 60_000,
      // The first ask is not a retry; the server never says "wrong code".
      promptForVerifyCode: async (retry) => {
        asked.push(retry)
        return '1234'
      },
    })

    expect(asked).toEqual([false])
    expect(gets[1]).toContain('verify_code=1234')
  })
})

describe('login runner: termination', () => {
  it('stops at the deadline instead of polling forever', async () => {
    // Every poll says `wait`, so only the deadline can end this.
    const { api, gets } = scriptedApi(Array.from({ length: 50 }, () => ({ status: 'wait' })) as QrStatusResponse[])
    let clock = 0

    const result = await runQrLogin({
      api,
      timeoutMs: 100,
      now: () => clock,
      sleep: async (ms) => void (clock += ms),
    })

    expect(result.kind).toBe('failed')
    expect(gets.length).toBeLessThan(50)
  })

  it('gives up when the refresh budget is spent', async () => {
    // The script runs out before the deadline, so only the budget can end it.
    const { api, gets } = scriptedApi([
      { status: 'expired' },
      { status: 'expired' },
      { status: 'expired' },
      { status: 'expired' },
    ])

    const clock = fakeClock()
    const result = await runQrLogin({ api, sleep: clock.sleep, now: clock.now, timeoutMs: 60_000 })

    expect(result.kind).toBe('failed')
    // Three codes issued means two replacements after the first.
    expect(gets).toHaveLength(3)
  })

  it('fetches a replacement QR when the machine asks for one', async () => {
    const { api, posts } = scriptedApi([
      { status: 'expired' },
      { status: 'confirmed', ilink_bot_id: 'bot-9' },
    ])

    const clock = fakeClock()
    await runQrLogin({ api, sleep: clock.sleep, now: clock.now, timeoutMs: 60_000 })

    // One POST for the initial code, one for the replacement.
    expect(posts).toHaveLength(2)
  })

  it('reports an already-bound bot without starting a new login', async () => {
    const { api } = scriptedApi([{ status: 'binded_redirect' }])

    const result = await runQrLogin({ api, sleep: async () => {}, timeoutMs: 60_000 })

    expect(result.kind).toBe('already-connected')
  })
})

describe('login runner: network faults', () => {
  it('treats a failing poll as a wait rather than ending the login', async () => {
    // A gateway timeout is normal against a 35s long poll; aborting the whole
    // login on one would make scanning unreliable.
    let calls = 0
    const api: ApiClient = {
      async post() {
        return JSON.stringify({ qrcode: 'qr-1', qrcode_img_content: 'https://weixin.test/qr-1' })
      },
      async get() {
        calls += 1
        if (calls === 1) throw new Error('gateway timeout')
        return JSON.stringify({ status: 'confirmed', ilink_bot_id: 'bot-9' })
      },
    }

    const result = await runQrLogin({ api, sleep: async () => {}, timeoutMs: 60_000 })

    expect(result.kind).toBe('connected')
  })

  it('reports a failure when the QR itself cannot be fetched', async () => {
    const api: ApiClient = {
      async post() {
        throw new Error('offline')
      },
      async get() {
        return '{}'
      },
    }

    const result = await runQrLogin({ api, sleep: async () => {}, timeoutMs: 60_000 })

    expect(result.kind).toBe('failed')
  })
})
