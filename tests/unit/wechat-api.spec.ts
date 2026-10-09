/**
 * The wire layer every later piece sits on. Two things matter here and nowhere
 * downstream: that the request is shaped the way the protocol document says
 * (headers, base URL joining, timeout), and that a transport failure is
 * reported as a failure rather than silently becoming an empty success.
 *
 * The expected values come from docs/protocol/protocol_zh_CN.md's header table,
 * not from re-deriving whatever the implementation happens to do.
 */

import { describe, expect, it, vi } from 'vitest'
import {
  buildBaseInfo,
  buildClientVersion,
  classifyFetchError,
  createApiClient,
} from '../../src/wechat/api.ts'

/** A fetch stand-in returning one canned response and recording its call. */
function stubFetch(response: { status?: number; body?: string; throws?: unknown }) {
  const calls: { url: string; init: RequestInit }[] = []
  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} })
    if (response.throws !== undefined) throw response.throws
    const status = response.status ?? 200
    return new Response(response.body ?? '', { status })
  })
  return { fetchImpl: fetchImpl as unknown as typeof fetch, calls }
}

describe('request shaping', () => {
  it('joins the endpoint onto a base URL that lacks a trailing slash', async () => {
    const { fetchImpl, calls } = stubFetch({ body: '{}' })
    const api = createApiClient({ fetchImpl })

    // The base must carry a path, otherwise resolution replaces it either way
    // and the assertion could never fail. A returned `baseurl` with a prefix is
    // the case where a missing slash silently swallows the last segment.
    await api.get({ baseUrl: 'https://example.test/api/v1', endpoint: 'ilink/bot/x', label: 'probe' })

    expect(calls[0]?.url).toBe('https://example.test/api/v1/ilink/bot/x')
  })

  it('sends the headers the protocol table names for a QR poll', async () => {
    const { fetchImpl, calls } = stubFetch({ body: '{}' })
    const api = createApiClient({ fetchImpl })

    await api.get({ baseUrl: 'https://example.test/', endpoint: 'ilink/bot/status', label: 'probe' })

    const headers = calls[0]?.init.headers as Record<string, string>
    expect(headers['iLink-App-Id']).toBe('bot')
    // Decimal string of 0x00MMNNPP; this build reports itself as 0.0.0.
    expect(headers['iLink-App-ClientVersion']).toBe(String(buildClientVersion('0.0.0')))
    // The QR poll is explicitly unauthenticated in the protocol document.
    expect(headers['AuthorizationType']).toBeUndefined()
    expect(headers['Authorization']).toBeUndefined()
  })

  it('authenticates a token-bearing POST and carries JSON content type', async () => {
    const { fetchImpl, calls } = stubFetch({ body: '{}' })
    const api = createApiClient({ fetchImpl })

    await api.post({
      baseUrl: 'https://example.test/',
      endpoint: 'ilink/bot/send',
      body: JSON.stringify({ hello: 1 }),
      token: 'tok-123',
      label: 'probe',
    })

    const headers = calls[0]?.init.headers as Record<string, string>
    expect(headers['Content-Type']).toBe('application/json')
    expect(headers['AuthorizationType']).toBe('ilink_bot_token')
    expect(headers['Authorization']).toBe('Bearer tok-123')
    // X-WECHAT-UIN is a random uint32 rendered as a decimal string, base64'd.
    const uin = Buffer.from(headers['X-WECHAT-UIN'] ?? '', 'base64').toString('utf8')
    expect(uin).toMatch(/^\d+$/u)
  })

  it('returns the raw response text on success', async () => {
    const { fetchImpl } = stubFetch({ body: '{"ret":0}' })
    const api = createApiClient({ fetchImpl })

    await expect(api.get({ baseUrl: 'https://example.test/', endpoint: 'x', label: 'probe' }))
      .resolves.toBe('{"ret":0}')
  })
})

describe('failure reporting', () => {
  it('throws on a non-2xx response instead of returning its body', async () => {
    const { fetchImpl } = stubFetch({ status: 500, body: 'boom' })
    const api = createApiClient({ fetchImpl })

    await expect(api.get({ baseUrl: 'https://example.test/', endpoint: 'x', label: 'probe' }))
      .rejects.toThrow(/500/u)
  })

  it('aborts a request that outlives its timeout', async () => {
    // The stand-in only settles when its signal aborts, so the call can only
    // succeed if the timeout is actually wired to the request.
    const fetchImpl = ((_url: unknown, init?: RequestInit) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))
    })) as unknown as typeof fetch
    const api = createApiClient({ fetchImpl })

    await expect(api.get({ baseUrl: 'https://example.test/', endpoint: 'x', label: 'probe', timeoutMs: 20 }))
      .rejects.toThrow()
  })

  it('classifies a timeout abort as a timeout', () => {
    const result = classifyFetchError(Object.assign(new Error('aborted'), { name: 'AbortError' }))
    expect(result.type).toBe('timeout')
  })

  it('classifies a DNS failure through the cause chain', () => {
    const error = Object.assign(new Error('fetch failed'), {
      cause: Object.assign(new Error('getaddrinfo ENOTFOUND example.test'), { code: 'ENOTFOUND' }),
    })
    expect(classifyFetchError(error).type).toBe('dns')
  })
})

describe('client version encoding', () => {
  it('encodes as 0x00MMNNPP', () => {
    // Straight from the protocol document's worked example.
    expect(buildClientVersion('1.0.11')).toBe(0x0001000b)
  })

  it('caps each component at one byte', () => {
    expect(buildClientVersion('257.1.0')).toBe((1 << 16) | (1 << 8))
  })
})

describe('base_info', () => {
  it('carries the channel version and a bot agent', () => {
    const info = buildBaseInfo({ channelVersion: '9.9.9' })
    expect(info.channel_version).toBe('9.9.9')
    expect(typeof info.bot_agent).toBe('string')
    expect(info.bot_agent.length).toBeGreaterThan(0)
  })
})

describe('the two calls the channel makes', () => {
  it('polls updates with the cursor and the base metadata', async () => {
    const { fetchImpl, calls } = stubFetch({ body: '{"ret":0,"msgs":[],"get_updates_buf":"c2"}' })
    const api = createApiClient({ fetchImpl, channelVersion: '1.2.3' })

    const response = await api.getUpdates({
      baseUrl: 'https://example.test/',
      token: 'tok-1',
      cursor: 'c1',
      timeoutMs: 5_000,
    })

    const body = JSON.parse(String(calls[0]?.init.body)) as Record<string, unknown>
    // The cursor is what stops the server replaying the whole conversation.
    expect(body['get_updates_buf']).toBe('c1')
    expect(body['base_info']).toEqual({ channel_version: '1.2.3', bot_agent: expect.any(String) })
    expect(response.get_updates_buf).toBe('c2')
    expect(calls[0]?.url).toContain('getupdates')
  })

  it('sends the first poll without a cursor', async () => {
    // The protocol says to send an empty string on a fresh start.
    const { fetchImpl, calls } = stubFetch({ body: '{}' })
    const api = createApiClient({ fetchImpl })

    await api.getUpdates({ baseUrl: 'https://example.test/', token: 'tok-1' })

    const body = JSON.parse(String(calls[0]?.init.body)) as Record<string, unknown>
    expect(body['get_updates_buf']).toBe('')
  })

  it('sends text with the destination and the conversation token', async () => {
    const { fetchImpl, calls } = stubFetch({ body: '{"ret":0}' })
    const api = createApiClient({ fetchImpl })

    await api.sendText({
      baseUrl: 'https://example.test/',
      token: 'tok-1',
      to: 'user-7',
      text: 'hello',
      contextToken: 'ctx-1',
    })

    const body = JSON.parse(String(calls[0]?.init.body)) as { msg: Record<string, unknown> }
    expect(body.msg['to_user_id']).toBe('user-7')
    expect(body.msg['context_token']).toBe('ctx-1')
    expect(body.msg['message_type']).toBe(2)
    expect(body.msg['message_state']).toBe(2)
    expect(body.msg['item_list']).toEqual([{ type: 1, text_item: { text: 'hello' } }])
    // Every send needs its own id, or the server cannot tell a retry from a
    // new message.
    expect(typeof body.msg['client_id']).toBe('string')
    expect((body.msg['client_id'] as string).length).toBeGreaterThan(0)
  })

  it('omits the token when the conversation never issued one', async () => {
    // The protocol's client sends anyway and warns; a fabricated token would be
    // worse than none.
    const { fetchImpl, calls } = stubFetch({ body: '{"ret":0}' })
    const api = createApiClient({ fetchImpl })

    await api.sendText({ baseUrl: 'https://example.test/', token: 'tok-1', to: 'user-7', text: 'hi' })

    const body = JSON.parse(String(calls[0]?.init.body)) as { msg: Record<string, unknown> }
    expect(body.msg['context_token']).toBeUndefined()
  })

  it('gives two sends different client ids', async () => {
    const { fetchImpl, calls } = stubFetch({ body: '{"ret":0}' })
    const api = createApiClient({ fetchImpl })

    await api.sendText({ baseUrl: 'https://example.test/', token: 't', to: 'u', text: 'a' })
    await api.sendText({ baseUrl: 'https://example.test/', token: 't', to: 'u', text: 'b' })

    const first = (JSON.parse(String(calls[0]?.init.body)) as { msg: Record<string, string> }).msg['client_id']
    const second = (JSON.parse(String(calls[1]?.init.body)) as { msg: Record<string, string> }).msg['client_id']
    expect(first).not.toBe(second)
  })

  it('rejects a non-zero business code instead of reporting success', async () => {
    // `ret` is the protocol's own success flag; an HTTP 200 carrying a failure
    // is still a failure.
    const { fetchImpl } = stubFetch({ body: '{"ret":-14,"errmsg":"session expired"}' })
    const api = createApiClient({ fetchImpl })

    await expect(api.sendText({ baseUrl: 'https://example.test/', token: 't', to: 'u', text: 'hi' }))
      .rejects.toThrow(/session expired|-14/u)
  })

  it('accepts a response that carries no business code', async () => {
    // Not every endpoint sets `ret`; an absent one is not a failure.
    const { fetchImpl } = stubFetch({ body: '{}' })
    const api = createApiClient({ fetchImpl })

    // Resolving is the whole assertion: this call returns nothing.
    await expect(api.sendText({ baseUrl: 'https://example.test/', token: 't', to: 'u', text: 'hi' }))
      .resolves.toBeUndefined()
  })
})
