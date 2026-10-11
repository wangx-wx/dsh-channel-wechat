/**
 * The login attempt the panel watches.
 *
 * A browser cannot hold the iLink long poll: each HTTP request is independent,
 * and several race once the page starts polling for status. So the host owns one
 * attempt at a time and the panel only reads a snapshot of it.
 *
 * The loop itself is {@link runQrLogin}. What lives here is the part a terminal
 * never needed: the QR outliving the call that fetched it, and the verify code
 * arriving from a later request instead of a prompt.
 *
 * The runner sleeps between polls, so the tests drive it through a gate rather
 * than real timers: `step()` releases exactly one poll. Racing a detached loop
 * with sleeps is how a suite starts passing and failing on scheduling.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ApiTransport } from '../../src/wechat/api.ts'
import type { QrStatusResponse } from '../../src/wechat/login-machine.ts'
import { createLoginSession } from '../../src/channel/login-session.ts'

/** A scripted API: `get` pops the next status, `post` returns a fresh QR code. */
function scriptedApi(statuses: QrStatusResponse[]) {
  const gets: string[] = []
  let qrIndex = 0
  const api: ApiTransport = {
    async get(params) {
      gets.push(params.endpoint)
      const next = statuses.shift()
      if (next === undefined) throw new Error('script exhausted')
      return JSON.stringify(next)
    },
    async post() {
      qrIndex += 1
      return JSON.stringify({ qrcode: `qr-${String(qrIndex)}`, qrcode_img_content: `https://weixin.test/qr-${String(qrIndex)}` })
    },
  }
  return { api, gets }
}

/**
 * A sleep the test releases by hand, so each poll happens when the test says.
 * @returns the sleep to inject, and `step` to release exactly one poll.
 */
function gate() {
  const waiters: Array<() => void> = []
  return {
    pending: (): number => waiters.length,
    sleep: (): Promise<void> => new Promise<void>(resolve => { waiters.push(resolve) }),
    async step(): Promise<void> {
      const release = waiters.shift()
      if (release === undefined) throw new Error('the runner is not waiting on a poll')
      release()
      // Let the released iteration run to its next await.
      for (let turn = 0; turn < 8; turn += 1) await Promise.resolve()
    },
  }
}

const sessions: Array<{ stop: () => void }> = []

afterEach(() => {
  for (const session of sessions.splice(0)) session.stop()
})

/** Build a session and register it for cleanup. */
function sessionFor(...args: Parameters<typeof createLoginSession>) {
  const session = createLoginSession(args[0])
  sessions.push(session)
  return session
}

/** Poll until a condition holds, for work that happens before the first sleep. */
async function until(check: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (check()) return
    await new Promise(resolve => setTimeout(resolve, 1))
  }
  throw new Error('condition never held')
}

describe('a login attempt the panel watches', () => {
  it('exposes the QR code to requests that arrive after it was fetched', async () => {
    // The terminal printed the code inside the call that fetched it. A browser
    // cannot: one request draws the page and another reads the code, so the code
    // has to outlive the fetch that produced it.
    const { api } = scriptedApi([{ status: 'wait' }])
    const session = sessionFor({ api, onConnected: () => {}, sleep: gate().sleep })

    session.start()
    await until(() => session.snapshot().qrcodeUrl !== undefined)

    expect(session.snapshot().qrcodeUrl).toBe('https://weixin.test/qr-1')
  })

  it('reports the phase the page should draw', async () => {
    // One attempt passes through several states, and the page has to say which
    // one: "waiting for you to scan" and "you scanned, now confirm on your
    // phone" look identical otherwise, and the user rescans a live code.
    const { api } = scriptedApi([{ status: 'scaned' }])
    const control = gate()
    const session = sessionFor({ api, onConnected: () => {}, sleep: control.sleep })

    expect(session.snapshot().phase).toBe('idle')
    session.start()
    await until(() => control.pending() > 0)
    await control.step()

    expect(session.snapshot().phase).toBe('scanned')
  })

  it('hands a verify code from a later request to the pending poll', async () => {
    // The server asks for the code the phone displays. A terminal runner awaited
    // a prompt; over HTTP the answer arrives in a separate request, so the
    // runner parks on a promise that this call resolves.
    const { api, gets } = scriptedApi([
      { status: 'need_verifycode' },
      { status: 'confirmed', bot_token: 'tok-1', ilink_bot_id: 'bot-9' },
    ])
    const control = gate()
    const session = sessionFor({ api, onConnected: () => {}, sleep: control.sleep })

    session.start()
    // The runner parks on the verify-code handoff here, not on the sleep gate:
    // a challenge blocks the loop before it can reach the next poll.
    await until(() => session.snapshot().phase === 'need-verifycode')

    session.submitVerifyCode('1234')
    // Answering releases the loop, which then sleeps before its next poll.
    await until(() => control.pending() > 0)
    await control.step()

    // The code reaches the server on the *next* poll, which is the only place
    // the protocol accepts it.
    expect(gets.some(endpoint => endpoint.includes('verify_code=1234'))).toBe(true)
    expect(session.snapshot().phase).toBe('connected')
  })

  it('passes the confirmed credentials to its owner', async () => {
    // Storing them is the reason the attempt exists; a snapshot reading
    // "connected" while nothing was saved would leave the user logged in on
    // screen and logged out in fact.
    const { api } = scriptedApi([
      { status: 'confirmed', bot_token: 'tok-1', ilink_bot_id: 'bot-9', baseurl: 'https://api.test' },
    ])
    const onConnected = vi.fn()
    const session = sessionFor({ api, onConnected, sleep: gate().sleep })

    session.start()
    await until(() => onConnected.mock.calls.length > 0)

    expect(onConnected).toHaveBeenCalledWith({ botToken: 'tok-1', accountId: 'bot-9', baseUrl: 'https://api.test', userId: undefined })
    expect(session.snapshot().phase).toBe('connected')
  })
})
