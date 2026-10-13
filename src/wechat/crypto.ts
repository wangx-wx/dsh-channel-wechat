/**
 * Media crypto for the WeChat CDN.
 *
 * The CDN stores every object as AES-128-ECB ciphertext with PKCS#7 padding,
 * and hands the key to the client rather than deriving it. Two encodings of that
 * key are seen in the wild, and telling them apart is the whole difficulty:
 * a 16-byte base64 payload is the key itself, while a 32-byte payload is the
 * ASCII hex of the key and needs a second decode. Guessing wrong yields a
 * decryption failure that looks like a corrupt download rather than a misread
 * key, which is why `parseAesKey` refuses anything it cannot classify instead of
 * trying the bytes anyway.
 *
 * ECB is the mode the protocol uses, not a choice made here: it has no IV, so
 * identical plaintext blocks produce identical ciphertext. That is a real
 * weakness and it is not this module's to fix - the server expects ECB.
 *
 * Adapted from @tencent-weixin/openclaw-weixin (MIT, Copyright (C) 2026 Tencent)
 * `src/cdn/aes-ecb.ts` and `src/cdn/pic-decrypt.ts` (parseAesKey).
 *
 * @module dsh-channel-wechat/wechat/crypto
 */

import { createCipheriv, createDecipheriv } from 'node:crypto'

/** The AES block size, and therefore the key size for AES-128. */
const BLOCK_BYTES = 16

/** Encrypt with AES-128-ECB and PKCS#7 padding, which is the cipher's default. */
export function encryptAesEcb(plaintext: Uint8Array, key: Uint8Array): Buffer {
  const cipher = createCipheriv('aes-128-ecb', key, null)
  return Buffer.concat([cipher.update(plaintext), cipher.final()])
}

/**
 * Decrypt AES-128-ECB and strip the PKCS#7 padding.
 * @param ciphertext - the whole downloaded body; the protocol leaves no prefix plaintext.
 * @param key - exactly 16 bytes.
 */
export function decryptAesEcb(ciphertext: Uint8Array, key: Uint8Array): Buffer {
  const decipher = createDecipheriv('aes-128-ecb', key, null)
  return Buffer.concat([decipher.update(ciphertext), decipher.final()])
}

/**
 * The ciphertext size PKCS#7 padding produces for a given plaintext size.
 *
 * Uploads declare this as `filesize` so the server knows what to expect, and a
 * body that already fills a block still grows by a whole block - padding always
 * adds at least one byte.
 * @param plaintextSize - the plaintext length in bytes.
 * @returns the padded ciphertext length in bytes.
 */
export function aesEcbPaddedSize(plaintextSize: number): number {
  return Math.ceil((plaintextSize + 1) / BLOCK_BYTES) * BLOCK_BYTES
}

/**
 * Turn the server's base64 `aes_key` into the raw 16 key bytes.
 *
 * Two encodings occur, and both are accepted because rejecting one would break
 * a whole media type:
 *  - base64 of the raw 16 bytes - what images send;
 *  - base64 of a 32-character hex string - what files, voice, and video send.
 *
 * @param aesKeyBase64 - the `aes_key` field exactly as it arrived.
 * @returns the 16 raw key bytes.
 * @throws when the value decodes to anything else, because a wrong-length key
 *   cannot be used and silently truncating it would fail later as corruption.
 */
export function parseAesKey(aesKeyBase64: string): Buffer {
  const decoded = Buffer.from(aesKeyBase64, 'base64')
  if (decoded.length === BLOCK_BYTES) return decoded
  if (decoded.length === BLOCK_BYTES * 2 && /^[0-9a-fA-F]{32}$/u.test(decoded.toString('ascii'))) {
    return Buffer.from(decoded.toString('ascii'), 'hex')
  }
  throw new Error(
    `channel-wechat: aes_key must decode to 16 raw bytes or a 32-character hex string, got ${String(decoded.length)} bytes`,
  )
}
