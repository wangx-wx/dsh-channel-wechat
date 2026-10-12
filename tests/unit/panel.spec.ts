/**
 * What finishing a scan does.
 *
 * The panel's reason to exist is that a login completes *without a restart*:
 * the user scans, and the channel starts polling in the same process. A panel
 * that saved the credentials and stopped there would look identical on screen -
 * "已连接" - and deliver nothing, which is the worst version of this feature,
 * because the user has no reason to suspect it.
 *
 * The ordering is part of the contract, not an accident of the code: the channel
 * reads the credentials store when it starts, so a start that beat the write
 * would poll as the previous account or as nobody.
 */

import { describe, expect, it, vi } from 'vitest'
import type { ApiTransport } from '../../src/wechat/api.ts'
import type { QrStatusResponse } from '../../src/wechat/login-machine.ts'
import { createPanel } from '../../src/channel/panel.ts'

/** A scripted API that reports the given statuses, then waits forever. */
function scriptedApi(statuses: QrStatusResponse[]) {
  const api: ApiTransport = {
    async get() {
      const next = statuses.shift()
      if (next === undefined) return JSON.stringify({ status: 'wait' })
      return JSON.stringify(next)
    },
    async post() {
      return JSON.stringify({ qrcode: 'qr-1', qrcode_img_content: 'https://weixin.test/qr-1' })
    },
  }
  return api
}

/**
 * A sleep that yields to the event loop without waiting in real time.
 *
 * A bare `async () => {}` makes the runner's retry loop spin without ever
 * yielding, so a mutant that loops forever starves the test and hangs the suite
 * instead of failing it. Yielding keeps the suite fast while letting a bad
 * mutant reach its assertion.
 */
const yieldSleep = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0))

/** Poll until a condition holds, for work a detached attempt completes. */
async function until(check: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (check()) return
    await new Promise(resolve => setTimeout(resolve, 1))
  }
  throw new Error('condition never held')
}

describe('finishing a scan', () => {
  it('saves the login and starts the channel without a restart', async () => {
    const saveAccount = vi.fn(async () => {})
    const startChannel = vi.fn()
    const panel = createPanel({
      api: scriptedApi([{ status: 'confirmed', bot_token: 'tok-1', ilink_bot_id: 'bot-9' }]),
      saveAccount,
      startChannel,
      sleep: yieldSleep,
    })

    panel.session.start()
    await until(() => startChannel.mock.calls.length > 0)

    expect(saveAccount).toHaveBeenCalledWith({ botToken: 'tok-1', accountId: 'bot-9', baseUrl: undefined, userId: undefined })
    expect(startChannel).toHaveBeenCalledOnce()
  })

  it('writes the login before the channel reads it', async () => {
    // The channel resolves its account from the credentials store when it
    // starts. A start that beat the write polls as the old account, or as none,
    // while the page reports success.
    const order: string[] = []
    const panel = createPanel({
      api: scriptedApi([{ status: 'confirmed', bot_token: 'tok-1', ilink_bot_id: 'bot-9' }]),
      saveAccount: async () => { order.push('save') },
      startChannel: async () => { order.push('start') },
      sleep: yieldSleep,
    })

    panel.session.start()
    await until(() => order.length === 2)

    expect(order).toEqual(['save', 'start'])
  })

  it('does not begin a second attempt while the first is completing', async () => {
    // `start` is reachable from more than one request: the page begins an
    // attempt and the retry button begins another. A second attempt created
    // while the first is still writing would start two poll loops over one
    // account, and the first loop would keep the session the second replaced.
    const startChannel = vi.fn()
    let releaseSave: (() => void) | undefined
    const panel = createPanel({
      api: scriptedApi([{ status: 'confirmed', bot_token: 'tok-1', ilink_bot_id: 'bot-9' }]),
      saveAccount: () => new Promise<void>(resolve => { releaseSave = resolve }),
      startChannel,
      sleep: yieldSleep,
    })

    panel.session.start()
    await until(() => releaseSave !== undefined)
    panel.session.start()
    // The write is still in flight, so the second start must not have produced a
    // second attempt in the meantime.
    const finishSave = releaseSave
    if (finishSave === undefined) throw new Error('the store write never began')
    finishSave()
    await until(() => startChannel.mock.calls.length > 0)

    expect(startChannel).toHaveBeenCalledOnce()
  })

  it('starts a fresh attempt after one failed, without restarting DSH', async () => {
    // A QR expires after its refresh budget, and the attempt ends in `failed`.
    // Without a second attempt the panel is wedged for the life of the process:
    // every later request is a no-op and the user has to restart DSH to retry,
    // which is exactly what this panel exists to avoid.
    const api = scriptedApi([
      { status: 'confirmed' }, // unusable: no ilink_bot_id
      { status: 'confirmed', bot_token: 'tok-1', ilink_bot_id: 'bot-9' },
    ])
    const startChannel = vi.fn()
    const panel = createPanel({ api, saveAccount: async () => {}, startChannel, sleep: async () => {} })

    panel.session.start()
    await until(() => panel.session.snapshot().phase === 'failed')
    panel.session.start()
    await until(() => startChannel.mock.calls.length > 0)

    expect(panel.session.snapshot().phase).toBe('connected')
  })

  it('never begins another attempt once connected', async () => {
    // A retry after success would re-scan and re-start a channel that is already
    // polling, so the working login would be replaced by a fresh login prompt.
    const startChannel = vi.fn()
    const panel = createPanel({
      api: scriptedApi([{ status: 'confirmed', bot_token: 'tok-1', ilink_bot_id: 'bot-9' }]),
      saveAccount: async () => {},
      startChannel,
      sleep: yieldSleep,
    })

    panel.session.start()
    await until(() => panel.session.snapshot().phase === 'connected')
    panel.session.start()

    expect(panel.session.snapshot().phase).toBe('connected')
    expect(startChannel).toHaveBeenCalledOnce()
  })

  it('reports a failed login without starting the channel', async () => {
    // The attempt can fail after the page has drawn a QR. Starting the channel
    // then would poll with whatever account is stored, or with none, while the
    // page says the connection failed.
    const startChannel = vi.fn()
    const panel = createPanel({
      api: scriptedApi([{ status: 'confirmed' }]), // no ilink_bot_id: unusable
      saveAccount: async () => {},
      startChannel,
      sleep: yieldSleep,
    })

    panel.session.start()
    await until(() => panel.session.snapshot().phase === 'failed')

    expect(startChannel).not.toHaveBeenCalled()
  })
})

describe('when storing the login fails', () => {
  it('does not report the login as connected', async () => {
    // The first live scan exposed this. The account id the server issued
    // (`6f773c2222a6@im.bot`) is not a legal credential key segment, so the write
    // threw - while the page reported "已连接". The user had scanned, succeeded,
    // and stored nothing, with no reason to suspect it.
    const panel = createPanel({
      api: scriptedApi([{ status: 'confirmed', bot_token: 'tok-1', ilink_bot_id: 'bot-9' }]),
      saveAccount: async () => { throw new Error('credential key segment is illegal') },
      startChannel: () => {},
      sleep: yieldSleep,
    })

    panel.session.start()
    await until(() => panel.session.snapshot().phase === 'failed')

    expect(panel.session.snapshot().phase).toBe('failed')
    // The reason has to reach the page: "连接失败" alone leaves the user scanning
    // the same code again.
    expect(panel.session.snapshot().message).toContain('credential key segment')
  })

  it('does not start a channel for a login it could not store', async () => {
    // Starting here would poll as whatever account was stored before, or as
    // nobody, which looks like a working channel that ignores messages.
    const startChannel = vi.fn()
    const panel = createPanel({
      api: scriptedApi([{ status: 'confirmed', bot_token: 'tok-1', ilink_bot_id: 'bot-9' }]),
      saveAccount: async () => { throw new Error('nope') },
      startChannel,
      sleep: yieldSleep,
    })

    panel.session.start()
    await until(() => panel.session.snapshot().phase === 'failed')

    expect(startChannel).not.toHaveBeenCalled()
  })
})
