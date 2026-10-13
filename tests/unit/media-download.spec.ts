/**
 * Downloading one media object: fetch, decrypt, and the cases that must fail
 * loudly rather than quietly.
 *
 * The ciphertext below is real output from
 * `openssl enc -aes-128-ecb -K 000102…0f` over a 33-byte PNG header, so the
 * decryption is checked against an independent implementation rather than
 * against this module's own encryption.
 */

import { describe, expect, it } from 'vitest'
import { CDN_BASE_URL } from '../../src/wechat/cdn.ts'
import { downloadMedia } from '../../src/wechat/media-download.ts'
import type { InboundMedia } from '../../src/wechat/inbound.ts'

/** The FIPS-197 key, in the hex form an image item sends. */
const KEY_HEX = '000102030405060708090a0b0c0d0e0f'

/** `openssl`-produced ciphertext for the PNG header below. */
const CIPHERTEXT_HEX =
  'c8bba2a6bcbe45b24bf686d06facf9703e58f866a0a91436a5b97a9fc8371bdb527e2ed8f3028914c02e1d0cded500d6'

/** The plaintext those bytes decrypt to, byte for byte. */
const PLAINTEXT = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89,
])

/** A fetch that answers with fixed bytes, and records the URL it was asked for. */
function stubFetch(body: Uint8Array, init: { ok?: boolean; status?: number } = {}) {
  const calls: string[] = []
  const fetchImpl = (async (url: string) => {
    calls.push(url)
    return new Response(body, { status: init.status ?? 200 })
  }) as unknown as typeof fetch
  return { calls, fetchImpl }
}

describe('downloading one media object', () => {
  it('decrypts the downloaded body with the key that came with it', () => {
    // The end-to-end case: a real ciphertext in, the original bytes out.
    const { fetchImpl } = stubFetch(Buffer.from(CIPHERTEXT_HEX, 'hex'))

    return expect(downloadMedia(
      { kind: 'image', encryptQueryParam: 'p1', aesKeyBase64: 'AAECAwQFBgcICQoLDA0ODw==' },
      { cdnBaseUrl: CDN_BASE_URL, fetchImpl },
    )).resolves.toEqual(PLAINTEXT)
  })

  it('accepts the hex-string key encoding that files and voice use', () => {
    // Files, voice, and video send the key as base64 of its hex spelling. Both
    // encodings must reach the same plaintext.
    const { fetchImpl } = stubFetch(Buffer.from(CIPHERTEXT_HEX, 'hex'))

    return expect(downloadMedia(
      { kind: 'file', encryptQueryParam: 'p1', aesKeyBase64: 'MDAwMTAyMDMwNDA1MDYwNzA4MDkwYTBiMGMwZDBlMGY=' },
      { cdnBaseUrl: CDN_BASE_URL, fetchImpl },
    )).resolves.toEqual(PLAINTEXT)
  })

  it('copies the bytes when the object carries no key', () => {
    // An image may arrive unencrypted. Decrypting anyway would fail on padding,
    // so the absence of a key has to mean "plain", not "broken".
    const raw = Buffer.from('not encrypted at all')
    const { fetchImpl } = stubFetch(raw)

    return expect(downloadMedia(
      { kind: 'image', encryptQueryParam: 'p1' },
      { cdnBaseUrl: CDN_BASE_URL, fetchImpl },
    )).resolves.toEqual(raw)
  })

  it('prefers the sender\u2019s complete URL over building one from the base', () => {
    // The wire sometimes carries a ready URL; rebuilding from the base when one
    // was supplied would fetch a different (or nonexistent) object.
    const { calls, fetchImpl } = stubFetch(Buffer.from('x'))

    return downloadMedia(
      { kind: 'image', encryptQueryParam: 'p1', fullUrl: 'https://other.test/blob' },
      { cdnBaseUrl: CDN_BASE_URL, fetchImpl },
    ).then(() => {
      expect(calls).toEqual(['https://other.test/blob'])
    })
  })

  it('builds the download URL from the base when no complete URL was sent', () => {
    const { calls, fetchImpl } = stubFetch(Buffer.from('x'))

    return downloadMedia(
      { kind: 'image', encryptQueryParam: 'a b' },
      { cdnBaseUrl: CDN_BASE_URL, fetchImpl },
    ).then(() => {
      expect(calls).toEqual([`${CDN_BASE_URL}/download?encrypted_query_param=a%20b`])
    })
  })

  it('rejects a failed download instead of delivering nothing', async () => {
    // A silent empty buffer would be delivered as a message with no image and
    // no explanation. Failing lets the caller tell the user what happened.
    const { fetchImpl } = stubFetch(Buffer.from('nope'), { status: 404 })

    await expect(downloadMedia(
      { kind: 'image', encryptQueryParam: 'p1' },
      { cdnBaseUrl: CDN_BASE_URL, fetchImpl },
    )).rejects.toThrow(/404/u)
  })

  it('rejects a body that does not decrypt, rather than returning garbage', () => {
    // Ciphertext that is not a whole number of blocks, or a wrong key, must not
    // become a file the user is told was delivered.
    const { fetchImpl } = stubFetch(Buffer.from('too short to be a block'))

    return expect(downloadMedia(
      { kind: 'image', encryptQueryParam: 'p1', aesKeyBase64: 'AAECAwQFBgcICQoLDA0ODw==' },
      { cdnBaseUrl: CDN_BASE_URL, fetchImpl },
    )).rejects.toThrow()
  })

  it('passes the abort signal to the transport', async () => {
    // A stop must not wait out a slow download.
    const controller = new AbortController()
    const seen: (AbortSignal | undefined)[] = []
    const fetchImpl = (async (_url: string, init?: { signal?: AbortSignal }) => {
      seen.push(init?.signal)
      return new Response(Buffer.from('x'))
    }) as unknown as typeof fetch

    await downloadMedia(
      { kind: 'image', encryptQueryParam: 'p1' },
      { cdnBaseUrl: CDN_BASE_URL, fetchImpl, signal: controller.signal },
    )

    expect(seen).toEqual([controller.signal])
  })
})
