/**
 * Uploading one object's ciphertext to the CDN.
 *
 * The upload is a raw POST of AES-128-ECB ciphertext, and success is defined by
 * a response HEADER (`x-encrypted-param`) rather than by the body: that header is
 * the download parameter the later `sendmessage` cites, so a 200 without it is a
 * failure that would otherwise be recorded as a success and produce a message
 * referring to an object that cannot be fetched.
 *
 * The transport is injected, so the retry and error rules are testable without a
 * network or a real CDN.
 */

import { describe, expect, it } from 'vitest'
import { CDN_BASE_URL } from '../../src/wechat/cdn.ts'
import { uploadToCdn } from '../../src/wechat/cdn-upload.ts'

/** The FIPS-197 key, as raw bytes. */
const KEY = Buffer.from('000102030405060708090a0b0c0d0e0f', 'hex')

/** `openssl`-produced ciphertext for `hello` under {@link KEY}. */
const CIPHERTEXT_HEX = '5d8749e2af7531b2bf6661e9e5daf012'

/** A fetch that answers one way and records every call. */
function stubFetch(handler: (call: number) => Response) {
  const calls: { url: string; init?: { method?: string; body?: unknown } }[] = []
  const fetchImpl = (async (url: string, init?: { method?: string; body?: unknown }) => {
    calls.push({ url, ...(init === undefined ? {} : { init }) })
    return handler(calls.length)
  }) as unknown as typeof fetch
  return { calls, fetchImpl }
}

describe('uploading ciphertext to the CDN', () => {
  it('posts the encrypted body and returns the download parameter', async () => {
    // The whole contract: ciphertext out, `x-encrypted-param` in.
    const { calls, fetchImpl } = stubFetch(() => new Response(null, {
      status: 200,
      headers: { 'x-encrypted-param': 'download-param-1' },
    }))

    const result = await uploadToCdn({
      data: Buffer.from('hello'),
      key: KEY,
      filekey: 'k1',
      uploadFullUrl: 'https://cdn.test/upload',
      cdnBaseUrl: CDN_BASE_URL,
      fetchImpl,
    })

    expect(result).toEqual({ downloadParam: 'download-param-1' })
    expect(calls).toHaveLength(1)
    // The body is the CIPHERTEXT, verified against openssl rather than against
    // our own encrypt(), so a broken cipher cannot make this pass.
    expect(Buffer.from(calls[0]?.init?.body as Uint8Array).toString('hex')).toBe(CIPHERTEXT_HEX)
    expect(calls[0]?.init?.method).toBe('POST')
  })

  it('builds the upload URL when the server sent no complete one', async () => {
    const { calls, fetchImpl } = stubFetch(() => new Response(null, {
      status: 200,
      headers: { 'x-encrypted-param': 'p' },
    }))

    await uploadToCdn({
      data: Buffer.from('hello'),
      key: KEY,
      filekey: 'k1',
      uploadParam: 'up param',
      cdnBaseUrl: CDN_BASE_URL,
      fetchImpl,
    })

    expect(calls[0]?.url).toBe(`${CDN_BASE_URL}/upload?encrypted_query_param=up%20param&filekey=k1`)
  })

  it('prefers a complete upload URL over building one', async () => {
    // The server sometimes returns a ready URL; rebuilding would post to a
    // different object than the one it authorized.
    const { calls, fetchImpl } = stubFetch(() => new Response(null, {
      status: 200,
      headers: { 'x-encrypted-param': 'p' },
    }))

    await uploadToCdn({
      data: Buffer.from('hello'),
      key: KEY,
      filekey: 'k1',
      uploadFullUrl: 'https://other.test/u',
      uploadParam: 'ignored',
      cdnBaseUrl: CDN_BASE_URL,
      fetchImpl,
    })

    expect(calls[0]?.url).toBe('https://other.test/u')
  })

  it('treats a 200 without the parameter header as a failure', async () => {
    // Without the parameter there is nothing to cite in sendmessage, so a bare
    // 200 means the object is unreachable - reporting success would send a
    // message pointing at nothing.
    const { fetchImpl } = stubFetch(() => new Response(null, { status: 200 }))

    await expect(uploadToCdn({
      data: Buffer.from('hello'), key: KEY, filekey: 'k1',
      uploadFullUrl: 'https://cdn.test/u', cdnBaseUrl: CDN_BASE_URL, fetchImpl,
    })).rejects.toThrow(/x-encrypted-param/u)
  })

  it('does not retry a client error', async () => {
    // A 4xx is a rejected request (bad parameter, expired authorization);
    // retrying it wastes the user's time for the same answer.
    const { calls, fetchImpl } = stubFetch(() => new Response('bad', {
      status: 400,
      headers: { 'x-error-message': 'expired' },
    }))

    await expect(uploadToCdn({
      data: Buffer.from('hello'), key: KEY, filekey: 'k1',
      uploadFullUrl: 'https://cdn.test/u', cdnBaseUrl: CDN_BASE_URL, fetchImpl,
    })).rejects.toThrow()
    expect(calls).toHaveLength(1)
  })

  it('retries a server error and succeeds on a later attempt', async () => {
    // A 5xx is transient; the reference retries up to three times.
    const { calls, fetchImpl } = stubFetch(call => call < 3
      ? new Response('boom', { status: 500 })
      : new Response(null, { status: 200, headers: { 'x-encrypted-param': 'ok' } }))

    const result = await uploadToCdn({
      data: Buffer.from('hello'), key: KEY, filekey: 'k1',
      uploadFullUrl: 'https://cdn.test/u', cdnBaseUrl: CDN_BASE_URL, fetchImpl,
    })

    expect(result).toEqual({ downloadParam: 'ok' })
    expect(calls).toHaveLength(3)
  })

  it('gives up after the third failed attempt', async () => {
    // Bounded, so a persistently broken CDN cannot retry forever.
    const { calls, fetchImpl } = stubFetch(() => new Response('boom', { status: 500 }))

    await expect(uploadToCdn({
      data: Buffer.from('hello'), key: KEY, filekey: 'k1',
      uploadFullUrl: 'https://cdn.test/u', cdnBaseUrl: CDN_BASE_URL, fetchImpl,
    })).rejects.toThrow()
    expect(calls).toHaveLength(3)
  })

  it('refuses to upload when there is no URL at all', async () => {
    // Neither a complete URL nor a parameter: nothing can be uploaded, and
    // posting to a guessed URL would be worse than failing.
    const { calls, fetchImpl } = stubFetch(() => new Response(null, { status: 200 }))

    await expect(uploadToCdn({
      data: Buffer.from('hello'), key: KEY, filekey: 'k1',
      cdnBaseUrl: CDN_BASE_URL, fetchImpl,
    })).rejects.toThrow()
    expect(calls).toHaveLength(0)
  })
})
