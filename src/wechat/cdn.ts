/**
 * The WeChat media CDN: where objects are downloaded from and uploaded to.
 *
 * Both directions share one shape - a base URL plus a query parameter - so the
 * builders live together rather than one per direction. The parameter is
 * percent-encoded in both, because it is opaque and routinely contains `+`, `/`,
 * and `=`: leaving them raw makes `+` decode as a space server-side and the
 * request fail in a way that looks like an expired object rather than a bad URL.
 *
 * Adapted from @tencent-weixin/openclaw-weixin (MIT, Copyright (C) 2026 Tencent)
 * `src/cdn/cdn-url.ts`.
 *
 * @module dsh-channel-wechat/wechat/cdn
 */

/** The media CDN the protocol points at, used when a login does not override it. */
export const CDN_BASE_URL = 'https://novac2c.cdn.weixin.qq.com/c2c'

/**
 * Join a base URL and a path, tolerating either spelling of the separator.
 *
 * The base comes from the login response and may already end in `/`; joining it
 * naively yields `//download`, which is a different path and 404s.
 * @param baseUrl - the CDN or API base.
 * @param path - the path to append, without a leading slash.
 * @returns the joined URL.
 */
export function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl}/${path}`
}

/**
 * Build the URL one encrypted object is downloaded from.
 * @param encryptedQueryParam - `CDNMedia.encrypt_query_param`.
 * @param cdnBaseUrl - the media CDN base.
 * @returns the absolute download URL.
 */
export function buildCdnDownloadUrl(encryptedQueryParam: string, cdnBaseUrl: string): string {
  return `${joinUrl(cdnBaseUrl, 'download')}?encrypted_query_param=${encodeURIComponent(encryptedQueryParam)}`
}

/**
 * Build the URL a ciphertext body is uploaded to, when the server did not
 * supply a complete one of its own.
 * @param params - the base URL, the authorization parameter, and the object key.
 * @returns the absolute upload URL.
 */
export function buildCdnUploadUrl(params: {
  cdnBaseUrl: string
  uploadParam: string
  filekey: string
}): string {
  const query = `encrypted_query_param=${encodeURIComponent(params.uploadParam)}`
  return `${joinUrl(params.cdnBaseUrl, 'upload')}?${query}&filekey=${encodeURIComponent(params.filekey)}`
}
