/**
 * The two typing calls, and the ticket cache that makes them usable.
 *
 * WeChat has no push API for "the bot is typing". It takes a ticket obtained
 * once per user and then a status report that has to be renewed while the bot
 * works. Everything here is about the shapes the protocol document specifies
 * (`docs/protocol/protocol_zh_CN.md:301-349`) and about what happens when the
 * ticket cannot be had: the answer must be "no indicator", never "delay the
 * message".
 */

import { describe, expect, it, vi } from 'vitest'
import { createApiClient } from '../../src/wechat/api.ts'
import { TypingTicketCache, TypingStatus } from '../../src/wechat/typing.ts'

/** A fetch stand-in returning one canned response and recording its calls. */
function stubFetch(response: { status?: number; body?: string } = {}) {
  const calls: { url: string; body: unknown }[] = []
  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body ?? '{}')) })
    return new Response(response.body ?? '{"ret":0}', { status: response.status ?? 200 })
  })
  return { fetchImpl: fetchImpl as unknown as typeof fetch, calls }
}

describe('getConfig', () => {
  it('asks for the ticket with the user and context token the protocol names', async () => {
    const { fetchImpl, calls } = stubFetch({ body: '{"ret":0,"typing_ticket":"t-1"}' })
    const api = createApiClient({ fetchImpl })

    const result = await api.getConfig({
      baseUrl: 'https://example.test/', token: 'tok', userId: 'user-7', contextToken: 'ctx-1',
    })

    expect(result).toBe('t-1')
    expect(calls[0]?.url).toContain('ilink/bot/getconfig')
    expect(calls[0]?.body).toMatchObject({
      ilink_user_id: 'user-7',
      context_token: 'ctx-1',
    })
  })

  it('answers an empty ticket when the server reports no success code', async () => {
    // A non-zero `ret` is the server declining, not a ticket. Caching the
    // message text instead would send a status with garbage in it.
    const { fetchImpl } = stubFetch({ body: '{"ret":-1,"errmsg":"nope","typing_ticket":"leak"}' })
    const api = createApiClient({ fetchImpl })

    await expect(api.getConfig({ baseUrl: 'https://example.test/', token: 't', userId: 'u' }))
      .resolves.toBe('')
  })
})

describe('sendTyping', () => {
  it('reports the status the caller asked for', async () => {
    const { fetchImpl, calls } = stubFetch()
    const api = createApiClient({ fetchImpl })

    await api.sendTyping({
      baseUrl: 'https://example.test/', token: 'tok', userId: 'user-7', ticket: 't-1', status: TypingStatus.TYPING,
    })

    expect(calls[0]?.url).toContain('ilink/bot/sendtyping')
    expect(calls[0]?.body).toMatchObject({
      ilink_user_id: 'user-7',
      typing_ticket: 't-1',
      status: 1,
    })
  })

  it('uses 2 to cancel, which is what stops an indicator that outlived its turn', async () => {
    const { fetchImpl, calls } = stubFetch()
    const api = createApiClient({ fetchImpl })

    await api.sendTyping({
      baseUrl: 'https://example.test/', token: 'tok', userId: 'user-7', ticket: 't-1', status: TypingStatus.CANCEL,
    })

    expect(calls[0]?.body).toMatchObject({ status: 2 })
  })

  it('reports a non-zero result code as a failure', async () => {
    // The official client ignores the body. This channel needs the failure:
    // it is the signal that the cached ticket went stale.
    const { fetchImpl } = stubFetch({ body: '{"ret":-1,"errmsg":"bad ticket"}' })
    const api = createApiClient({ fetchImpl })

    await expect(api.sendTyping({
      baseUrl: 'https://example.test/', token: 't', userId: 'u', ticket: 'x', status: TypingStatus.TYPING,
    })).rejects.toThrow(/bad ticket|typing|sendtyping/iu)
  })
})

describe('the ticket cache', () => {
  it('fetches once and reuses the ticket', async () => {
    const getConfig = vi.fn(async () => 't-1')
    const cache = new TypingTicketCache({ getConfig, now: () => 0 })

    expect(await cache.ticket('user-7')).toBe('t-1')
    expect(await cache.ticket('user-7')).toBe('t-1')
    expect(getConfig).toHaveBeenCalledTimes(1)
  })

  it('keeps one ticket per user', async () => {
    // The ticket is issued per `ilink_user_id`, so sharing one across users
    // would address the wrong conversation.
    const getConfig = vi.fn(async ({ userId }: { userId: string }) => `t-${userId}`)
    const cache = new TypingTicketCache({ getConfig, now: () => 0 })

    expect(await cache.ticket('a')).toBe('t-a')
    expect(await cache.ticket('b')).toBe('t-b')
  })

  it('refetches after the ticket expires', async () => {
    // A ticket is not valid forever, and an expired one makes every status
    // report fail. The entry therefore carries a deadline of its own.
    let clock = 0
    let issued = 0
    const getConfig = vi.fn(async () => {
      issued += 1
      return `t-${String(issued)}`
    })
    const cache = new TypingTicketCache({ getConfig, now: () => clock, ttlMs: 1_000 })

    expect(await cache.ticket('u')).toBe('t-1')
    clock = 1_001
    expect(await cache.ticket('u')).toBe('t-2')
  })

  it('drops the ticket on demand, so the next call refetches', async () => {
    // `sendTyping` failing is the only evidence that a ticket went stale
    // before its deadline. Without this the cache would keep handing out the
    // rejected value until the TTL ran out.
    let issued = 0
    const getConfig = vi.fn(async () => {
      issued += 1
      return `t-${String(issued)}`
    })
    const cache = new TypingTicketCache({ getConfig, now: () => 0 })

    expect(await cache.ticket('u')).toBe('t-1')
    cache.invalidate('u')
    expect(await cache.ticket('u')).toBe('t-2')
  })

  it('answers an empty ticket rather than blocking when the fetch fails', async () => {
    // The indicator is a nicety. Delaying a reply because its ticket could not
    // be fetched would trade the useful part for the decoration.
    const getConfig = vi.fn(async () => { throw new Error('offline') })
    const cache = new TypingTicketCache({ getConfig, now: () => 0 })

    await expect(cache.ticket('u')).resolves.toBe('')
  })

  it('backs off after a failure instead of retrying on every message', async () => {
    // A burst of messages while the ticket endpoint is down must not produce a
    // burst of failing requests.
    let clock = 0
    const getConfig = vi.fn(async () => { throw new Error('offline') })
    const cache = new TypingTicketCache({ getConfig, now: () => clock, retryBackoffMs: 2_000 })

    await cache.ticket('u')
    expect(getConfig).toHaveBeenCalledTimes(1)
    await cache.ticket('u')
    expect(getConfig).toHaveBeenCalledTimes(1)

    clock = 2_001
    await cache.ticket('u')
    expect(getConfig).toHaveBeenCalledTimes(2)
  })
})
