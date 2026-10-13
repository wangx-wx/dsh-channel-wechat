/**
 * Fetching and decrypting one media object from the WeChat CDN.
 *
 * The whole downloaded body is ciphertext with no plaintext prefix, so there is
 * nothing to peek at before decrypting. The key came with the message rather
 * than being derived, and an object may arrive with no key at all - the protocol
 * allows an unencrypted image - so an absent key means "copy the bytes" rather
 * than a failure.
 *
 * The transport is injected rather than reached for, matching the API client,
 * so this can be tested against fixed ciphertext without a network.
 *
 * Adapted from @tencent-weixin/openclaw-weixin (MIT, Copyright (C) 2026 Tencent)
 * `src/cdn/pic-decrypt.ts`.
 *
 * @module dsh-channel-wechat/wechat/media-download
 */

import { buildCdnDownloadUrl } from './cdn.ts'
import { decryptAesEcb, parseAesKey } from './crypto.ts'
import type { InboundMedia } from './inbound.ts'

/** Collaborators for one download. */
export interface MediaDownloadOptions {
  /** The media CDN base, used when the descriptor carried no complete URL. */
  cdnBaseUrl: string
  /** Injected transport; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch
  /** Cancellation, so a stop does not wait out a slow download. */
  signal?: AbortSignal
}

/**
 * Fetch one object and return its plaintext bytes.
 *
 * @param media - the descriptor parsed from the message.
 * @param options - the CDN base and transport.
 * @returns the decrypted bytes; the caller owns their lifetime.
 * @throws when the download fails, so the caller can report it rather than
 *   delivering a message with silently missing media.
 */
export async function downloadMedia(
  media: InboundMedia,
  options: MediaDownloadOptions,
): Promise<Buffer> {
  const url = media.fullUrl ?? buildCdnDownloadUrl(media.encryptQueryParam, options.cdnBaseUrl)
  const fetchImpl = options.fetchImpl ?? globalThis.fetch
  const response = await fetchImpl(url, options.signal === undefined ? {} : { signal: options.signal })
  if (!response.ok) {
    throw new Error(`channel-wechat: CDN download failed ${String(response.status)} ${response.statusText}`)
  }
  const body = Buffer.from(await response.arrayBuffer())
  // No key means the object was stored unencrypted; decrypting it anyway would
  // fail on padding rather than returning the bytes.
  if (media.aesKeyBase64 === undefined) return body
  return decryptAesEcb(body, parseAesKey(media.aesKeyBase64))
}
