/**
 * The QR login state machine, as a pure reducer.
 *
 * Eight statuses, a refresh budget, an IDC redirect, and a verify-code retry —
 * logic that is mostly edge cases, so it is kept free of I/O and time: the
 * caller polls, asks for input, and renders. Every expected value here comes
 * from the status table in docs/protocol/protocol_zh_CN.md and the transition
 * rules the protocol document states beside it.
 */

import { describe, expect, it } from 'vitest'
import {
  MAX_QR_REFRESH_COUNT, reduceLogin, withRefreshedQr, withVerifyCode,
  type LoginState, type QrStatusResponse,
} from '../../src/wechat/login-machine.ts'

/** A freshly started login, before any status is observed. */
function started(): LoginState {
  return {
    qrcode: 'qr-1',
    qrcodeUrl: 'https://weixin.test/qr-1',
    apiBaseUrl: 'https://ilinkai.weixin.qq.com',
    refreshCount: 1,
    scannedAnnounced: false,
  }
}

/** Apply one status response to a state. */
function step(state: LoginState, response: QrStatusResponse) {
  return reduceLogin(state, response)
}

describe('login state machine: terminal outcomes', () => {
  it('reports credentials when the server confirms the scan', () => {
    const { effect } = step(started(), {
      status: 'confirmed',
      bot_token: 'tok-1',
      ilink_bot_id: 'bot-9',
      baseurl: 'https://redirect.test',
      ilink_user_id: 'user-7',
    })

    expect(effect).toEqual({
      kind: 'connected',
      credentials: {
        botToken: 'tok-1',
        accountId: 'bot-9',
        baseUrl: 'https://redirect.test',
        userId: 'user-7',
      },
    })
  })

  it('fails a confirmation that carries no account id', () => {
    // Without the id there is nothing to key credentials by, so accepting the
    // response would store a login that no later request can address.
    const { effect } = step(started(), { status: 'confirmed', bot_token: 'tok-1' })

    expect(effect.kind).toBe('failed')
  })

  it('treats an already-bound bot as done rather than as a failure', () => {
    const { effect } = step(started(), { status: 'binded_redirect' })

    expect(effect).toEqual({ kind: 'already-connected' })
  })
})

describe('login state machine: waiting and scanning', () => {
  it('keeps polling while the code is unread', () => {
    const { effect } = step(started(), { status: 'wait' })

    expect(effect).toEqual({ kind: 'poll' })
  })

  it('announces the scan once, not on every poll that reports it', () => {
    // The server keeps answering `scaned` until the user confirms, so a naive
    // implementation reprints the notice on every poll.
    const first = step(started(), { status: 'scaned' })
    expect(first.effect).toEqual({ kind: 'announce-scanned' })

    const second = step(first.state, { status: 'scaned' })
    expect(second.effect).toEqual({ kind: 'poll' })
  })
})

describe('login state machine: verify code', () => {
  it('asks for the code the first time the server needs one', () => {
    const { effect } = step(started(), { status: 'need_verifycode' })

    expect(effect).toEqual({ kind: 'request-verify-code', retry: false })
  })

  it('marks a repeat request as a retry so the prompt can say the code was wrong', () => {
    // Being asked again while a code is already in flight is the only signal
    // that the last one was rejected; the server never says so directly.
    const asked = step(started(), { status: 'need_verifycode' })
    const answered = withVerifyCode(asked.state, '1234')

    const again = step(answered, { status: 'need_verifycode' })
    expect(again.effect).toEqual({ kind: 'request-verify-code', retry: true })
  })

  it('clears the pending code once the server stops asking for it', () => {
    const asked = step(started(), { status: 'need_verifycode' })
    const answered = withVerifyCode(asked.state, '1234')
    expect(answered.pendingVerifyCode).toBe('1234')

    // `scaned` with a code in flight means the server took it.
    const accepted = step(answered, { status: 'scaned' })
    expect(accepted.state.pendingVerifyCode).toBeUndefined()
  })
})

describe('login state machine: refresh budget', () => {
  it('asks for a fresh code when the current one expires', () => {
    const asked = step(started(), { status: 'expired' })
    expect(asked.effect).toEqual({ kind: 'refresh-qr' })

    // The budget is spent when the replacement arrives, not when it is asked
    // for, so a caller that never fetches one cannot consume it.
    const replaced = withRefreshedQr(asked.state, { qrcode: 'qr-2', qrcodeUrl: 'https://weixin.test/qr-2' })
    expect(replaced.refreshCount).toBe(2)
  })

  it('gives up after the refresh budget is spent', () => {
    // Exhausting the budget must terminate, otherwise a server that keeps
    // answering `expired` spins the caller forever.
    let state = started()
    for (let index = 0; index < MAX_QR_REFRESH_COUNT - 1; index += 1) {
      state = withRefreshedQr(step(state, { status: 'expired' }).state, { qrcode: `qr-${index + 2}`, qrcodeUrl: 'u' })
    }
    expect(state.refreshCount).toBe(MAX_QR_REFRESH_COUNT)

    const { effect } = step(state, { status: 'expired' })
    expect(effect.kind).toBe('failed')
  })

  it('resets the scanned notice because a new code has not been scanned', () => {
    const scanned = step(started(), { status: 'scaned' })
    expect(scanned.state.scannedAnnounced).toBe(true)

    const refreshed = withRefreshedQr(step(scanned.state, { status: 'expired' }).state, { qrcode: 'qr-2', qrcodeUrl: 'u' })
    expect(refreshed.scannedAnnounced).toBe(false)
  })
})

describe('login state machine: verify code blocked', () => {
  it('refreshes the code and drops the blocked one', () => {
    const answered = withVerifyCode(started(), '0000')
    const { effect, state } = step(answered, { status: 'verify_code_blocked' })

    expect(effect).toEqual({ kind: 'refresh-qr' })
    // A blocked code is no longer worth sending.
    expect(state.pendingVerifyCode).toBeUndefined()

    const replaced = withRefreshedQr(state, { qrcode: 'qr-2', qrcodeUrl: 'u' })
    expect(replaced.refreshCount).toBe(2)
  })
})

describe('login state machine: a new code invalidates the old input', () => {
  it('drops a pending verify code when a replacement QR arrives', () => {
    // A code belongs to the QR the server issued alongside it; carrying it
    // onto a fresh code means the next poll sends a code for a dead challenge.
    const answered = withVerifyCode(started(), '1234')
    const replaced = withRefreshedQr(answered, { qrcode: 'qr-2', qrcodeUrl: 'u' })

    expect(replaced.pendingVerifyCode).toBeUndefined()
  })
})

describe('login state machine: IDC redirect', () => {
  it('switches the polling host when the server names one', () => {
    const { state, effect } = step(started(), {
      status: 'scaned_but_redirect',
      redirect_host: 'idc2.weixin.test',
    })

    expect(state.apiBaseUrl).toBe('https://idc2.weixin.test')
    expect(effect).toEqual({ kind: 'poll' })
  })

  it('keeps polling the current host when the redirect names none', () => {
    // Dropping the host here would strand the login on an undefined URL.
    const { state, effect } = step(started(), { status: 'scaned_but_redirect' })

    expect(state.apiBaseUrl).toBe('https://ilinkai.weixin.qq.com')
    expect(effect).toEqual({ kind: 'poll' })
  })
})
