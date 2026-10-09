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
