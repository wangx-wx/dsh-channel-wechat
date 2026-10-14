/**
 * Uploading one object's ciphertext to the WeChat CDN.
 *
 * Two things about this exchange are easy to get wrong and both fail quietly:
 *
 *  - **Success is a response header, not a status.** The `x-encrypted-param`
 *    header carries the download parameter the later `sendmessage` cites. A 200
 *    without it means the object cannot be fetched, so treating the status alone
 *    as success produces a message that refers to nothing.
 *  - **The body is ciphertext**, so the size the server was told in
 *    `getuploadurl` (`aesEcbPaddedSize`) must match what is actually posted.
 *
 * A 4xx is not retried - it is a rejected request and repeating it changes
 * nothing - while a 5xx is transient and retried to a fixed bound.
 *
 * Adapted from @tencent-weixin/openclaw-weixin (MIT, Copyright (C) 2026 Tencent)
 * `src/cdn/cdn-upload.ts`.
 *
 * @module dsh-channel-wechat/wechat/cdn-upload
 */

import { buildCdnUploadUrl } from './cdn.ts'
import { encryptAesEcb } from './crypto.ts'

/** How many times a transient upload failure is retried. */
export const UPLOAD_MAX_ATTEMPTS = 3

/** One upload request. */
export interface CdnUploadParams {
  /** The plaintext to encrypt and upload. */
  data: Uint8Array
  /** The 16-byte AES key, which the send message later cites in base64. */
  key: Uint8Array
  /** The object's name on the CDN. */
  filekey: string
  /** A complete upload URL, when `getuploadurl` returned one. */
  uploadFullUrl?: string
  /** The authorization parameter, used to build a URL when none was returned. */
  uploadParam?: string
  /** The media CDN base. */
  cdnBaseUrl: string
  /** Injected transport; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch
}

/**
 * Encrypt one object and upload it.
 * @param params - the bytes, the key, and the upload target.
 * @returns the download parameter to cite in `sendmessage`.
 * @throws when no target was supplied, or every attempt failed.
 */
export async function uploadToCdn(params: CdnUploadParams): Promise<{ downloadParam: string }> {
  const target = params.uploadFullUrl !== undefined && params.uploadFullUrl.trim() !== ''
    ? params.uploadFullUrl
    : params.uploadParam === undefined
      ? undefined
      : buildCdnUploadUrl({ cdnBaseUrl: params.cdnBaseUrl, uploadParam: params.uploadParam, filekey: params.filekey })
  if (target === undefined) {
    throw new Error('channel-wechat: no upload URL (need upload_full_url or upload_param)')
  }

  const ciphertext = encryptAesEcb(params.data, params.key)
  const fetchImpl = params.fetchImpl ?? globalThis.fetch
  let lastError: unknown
  for (let attempt = 1; attempt <= UPLOAD_MAX_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetchImpl(target, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: ciphertext,
      })
      if (response.status >= 400 && response.status < 500) {
        // Rejected, not transient: the same request will be rejected again.
        throw new Error(`channel-wechat: CDN upload rejected ${String(response.status)}: ${await errorText(response)}`)
      }
      if (response.status !== 200) {
        throw new Error(`channel-wechat: CDN upload failed ${String(response.status)}: ${await errorText(response)}`)
      }
      const downloadParam = response.headers.get('x-encrypted-param')
      if (downloadParam === null || downloadParam === '') {
        // A 200 with no parameter gives nothing to cite, so the object is
        // unreachable however healthy the status looks.
        throw new Error('channel-wechat: CDN upload response carried no x-encrypted-param header')
      }
      return { downloadParam }
    } catch (error) {
      lastError = error
      // The client-error message is final; anything else is worth another try.
      if (error instanceof Error && error.message.includes('rejected')) throw error
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error('channel-wechat: CDN upload failed')
}

/** The server's own explanation, when it sent one. */
async function errorText(response: Response): Promise<string> {
  const header = response.headers.get('x-error-message')
  if (header !== null && header !== '') return header
  return await response.text().catch(() => '(unreadable)')
}
