/**
 * The media crypto: AES-128-ECB and the two `aes_key` encodings.
 *
 * Every expected ciphertext here comes from an INDEPENDENT source - the
 * published FIPS-197 C.1 vector, and `openssl enc -aes-128-ecb` for the
 * PKCS#7 cases. Recomputing them with the very code under test would make the
 * suite pass by construction and able to agree with a broken cipher.
 */

import { describe, expect, it } from 'vitest'
import {
  aesEcbPaddedSize,
  decryptAesEcb,
  encryptAesEcb,
  parseAesKey,
} from '../../src/wechat/crypto.ts'
import { CDN_BASE_URL, buildCdnDownloadUrl, buildCdnUploadUrl } from '../../src/wechat/cdn.ts'

/** The FIPS-197 C.1 key, and the encoding the CDN sends it in. */
const KEY_HEX = '000102030405060708090a0b0c0d0e0f'

/** Decode a hex string, so a test vector reads as the published bytes. */
function hex(text: string): Uint8Array {
  return Uint8Array.from(text.match(/../gu)!.map(byte => Number.parseInt(byte, 16)))
}

/** Render bytes as lowercase hex, for comparison with a published vector. */
function toHex(bytes: Uint8Array): string {
  return [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('')
}

describe('AES-128-ECB', () => {
  it('matches the published FIPS-197 C.1 vector', () => {
    // FIPS-197 Appendix C.1: key 000102…0f, plaintext 00112233…ff,
    // ciphertext 69c4e0d86a7b0430d8cdb78070b4c55a. No padding, because the
    // vector is exactly one block - and it is the published value, not one this
    // code produced.
    // Compared over the first block: the vector is a single unpadded block, while
    // this function always pads, so a 16-byte plaintext produces the vector
    // followed by a whole padding block. Comparing the block itself keeps the
    // assertion tied to the published bytes rather than to our padding.
    const ciphertext = encryptAesEcb(hex('00112233445566778899aabbccddeeff'), hex(KEY_HEX))

    expect(toHex(ciphertext.slice(0, 16))).toBe('69c4e0d86a7b0430d8cdb78070b4c55a')
    expect(ciphertext.length).toBe(32)
  })

  it('pads a partial block with PKCS#7, as the CDN expects', () => {
    // `openssl enc -aes-128-ecb -K 000102…0f` over "hello" (5 bytes), the
    // padding-on default. The 16-byte result proves a 5-byte body became a full
    // padded block rather than being left short.
    const ciphertext = encryptAesEcb(new TextEncoder().encode('hello'), hex(KEY_HEX))

    expect(ciphertext.length).toBe(16)
    expect(toHex(ciphertext)).toBe('5d8749e2af7531b2bf6661e9e5daf012')
  })

  it('round-trips arbitrary bytes', () => {
    // Property rather than a vector: whatever goes in must come out. This is the
    // one assertion that does not need an external oracle.
    const key = hex(KEY_HEX)
    const plaintext = new TextEncoder().encode('a longer body that spans more than one block: 中文')

    expect(toHex(decryptAesEcb(encryptAesEcb(plaintext, key), key))).toBe(toHex(plaintext))
  })

  it('sizes a padded body the way the upload metadata needs', () => {
    // `filesize` in getuploadurl is the CIPHERTEXT size the server must expect.
    // ceil((n+1)/16)*16: a body that is already a multiple of 16 grows by a whole
    // block, because PKCS#7 always adds at least one byte.
    expect(aesEcbPaddedSize(0)).toBe(16)
    expect(aesEcbPaddedSize(5)).toBe(16)
    expect(aesEcbPaddedSize(15)).toBe(16)
    expect(aesEcbPaddedSize(16)).toBe(32)
    expect(aesEcbPaddedSize(17)).toBe(32)
  })
})

describe('parsing the aes_key the server sends', () => {
  it('reads base64 of the raw 16 key bytes', () => {
    // The image form: base64 decodes straight to the key.
    const key = parseAesKey('AAECAwQFBgcICQoLDA0ODw==')

    expect(toHex(key)).toBe(KEY_HEX)
  })

  it('reads base64 of a 32-character hex string, as file/voice/video use', () => {
    // The second form seen in the wild: base64 decodes to 32 ASCII hex chars,
    // which must then be hex-decoded. Treating those 32 bytes as the key would
    // produce a wrong key and a decryption failure that looks like corruption.
    const key = parseAesKey('MDAwMTAyMDMwNDA1MDYwNzA4MDkwYTBiMGMwZDBlMGY=')

    expect(toHex(key)).toBe(KEY_HEX)
  })

  it('rejects a key that is neither 16 raw bytes nor 32 hex characters', () => {
    expect(() => parseAesKey('c2hvcnQ=')).toThrow()
    expect(() => parseAesKey('')).toThrow()
  })

  it('rejects 32 bytes that are not hex, rather than inventing a key', () => {
    // 32 ASCII characters that are not hexadecimal: the "hex form" check must be
    // a real check, not just a length test.
    const notHex = Buffer.from('z'.repeat(32), 'ascii').toString('base64')

    expect(() => parseAesKey(notHex)).toThrow()
  })
})

describe('the CDN URLs', () => {
  it('encodes the download parameter rather than pasting it in', () => {
    // `encrypt_query_param` is opaque and base64-ish, so it routinely contains
    // `+`, `/`, and `=`. Unencoded, `+` becomes a space server-side and the
    // download 404s - which reads as "the image expired" rather than a bug here.
    const url = buildCdnDownloadUrl('a+b/c=d', CDN_BASE_URL)

    expect(url).toBe('https://novac2c.cdn.weixin.qq.com/c2c/download?encrypted_query_param=a%2Bb%2Fc%3Dd')
  })

  it('builds an upload URL carrying both the parameter and the file key', () => {
    // The upload URL needs both: the parameter authorizes the write and the
    // filekey is the object's name, so dropping either produces a rejected
    // upload.
    const url = buildCdnUploadUrl({ cdnBaseUrl: CDN_BASE_URL, uploadParam: 'p q', filekey: 'k/1' })

    expect(url).toBe('https://novac2c.cdn.weixin.qq.com/c2c/upload?encrypted_query_param=p%20q&filekey=k%2F1')
  })

  it('does not double a trailing slash on a base URL that has one', () => {
    // The base URL comes from the login response and may or may not end in `/`;
    // `//download` is a different path and 404s.
    const url = buildCdnDownloadUrl('x', 'https://example.test/c2c/')

    expect(url).toBe('https://example.test/c2c/download?encrypted_query_param=x')
  })
})
