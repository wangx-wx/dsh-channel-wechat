import { randomUUID } from 'node:crypto'

/**
 * Wire layer for the WeChat iLink bot API.
 *
 * This is the protocol half of the channel and deliberately depends on nothing
 * from the harness: it takes its `fetch`, its route tag, and its bot agent as
 * inputs so the same code can run under a test, a CLI, or the plugin host.
 *
 * Shapes and header names come from docs/protocol/protocol_zh_CN.md, which is
 * itself reproduced from Tencent's openclaw-weixin; the error classification
 * (`classifyFetchError`) is adapted from that project's `src/api/api.ts`.
 * See THIRD_PARTY_NOTICES.md.
 *
 * Adapted from @tencent-weixin/openclaw-weixin (MIT, Copyright (C) 2026 Tencent)
 *
 * @module dsh-channel-wechat/wechat/api
 */

/** Header set shared by GET and POST requests. */
export interface ApiClientOptions {
  /** Injected transport; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch
  /** Deployment route tag, sent as `SKRouteTag` when present. */
  routeTag?: string
  /** This build's version, used for `channel_version` and the client-version header. */
  channelVersion?: string
  /** Observable bot agent string; defaults to this package's marker. */
  botAgent?: string
}

/** One GET request. */
export interface ApiGetParams {
  /** API base URL; a missing trailing slash is tolerated. */
  baseUrl: string
  /** Path and query, already encoded. */
  endpoint: string
  /** Client-side abort after this many milliseconds. */
  timeoutMs?: number
  /**
   * Caller abort, forwarded to the request itself.
   *
   * A request that only stops being *awaited* keeps its socket open and holds
   * the process alive; a held long poll is the case that matters.
   */
  signal?: AbortSignal
  /** Diagnostic label used in error messages. */
  label: string
}

/** One POST request. */
export interface ApiPostParams extends ApiGetParams {
  /** Request body, already serialized. */
  body: string
  /** Bot token; omitted on requests the protocol leaves unauthenticated. */
  token?: string
}

/**
 * The raw transports, which is all the login path needs.
 *
 * Kept separate from {@link ApiClient} so a caller that only polls QR status
 * does not have to provide the message methods it never calls.
 */
export interface ApiTransport {
  /** Send an unauthenticated GET. */
  get(params: ApiGetParams): Promise<string>
  /** Send a JSON POST, optionally authenticated. */
  post(params: ApiPostParams): Promise<string>
}

/**
 * The message methods, which is all the channel runtime needs.
 *
 * Separate from {@link ApiTransport} so a caller that only polls and sends does
 * not have to provide the raw QR transports it never calls.
 */
export interface MessageApi {
  /** Long-poll for messages. */
  getUpdates(params: GetUpdatesParams): Promise<GetUpdatesResult>
  /** Send one text message to a conversation. */
  sendText(params: SendTextParams): Promise<void>
  /** Ask where one object may be uploaded, and what metadata to declare. */
  getUploadUrl(params: GetUploadUrlParams): Promise<GetUploadUrlResult>
  /** Send one uploaded file to a conversation. */
  sendFile(params: SendFileParams): Promise<void>
}

/** Media kinds the server accepts for an upload. */
export const UploadMediaType = { IMAGE: 1, VIDEO: 2, FILE: 3, VOICE: 4 } as const

/**
 * The typing indicator, which only a deployment that composes one needs.
 *
 * Kept apart from {@link MessageApi} so a transport that does not implement it
 * - every test stub, and the login path - still satisfies the message surface.
 */
export interface TypingApi {
  /** Fetch one user's typing ticket; an empty string means the server declined. */
  getConfig(params: GetConfigParams): Promise<string>
  /** Report one user's typing status. */
  sendTyping(params: SendTypingParams): Promise<void>
}

/** The complete API surface. */
export interface ApiClient extends ApiTransport, MessageApi, TypingApi {}

/** One long poll. */
export interface GetUpdatesParams {
  /** API base URL. */
  baseUrl: string
  /** Bot token. */
  token: string
  /** Cursor from the previous response; empty on a fresh start. */
  cursor?: string
  /** How long the server may hold the request. */
  timeoutMs?: number
  /**
   * Caller abort, forwarded to the request itself.
   *
   * Stopping the channel only stops *awaiting* the poll; without this the held
   * request outlives the shutdown that ended it.
   */
  signal?: AbortSignal
}

/** What a long poll returned. */
export interface GetUpdatesResult {
  /** Messages received since the cursor. */
  msgs: readonly unknown[]
  /** Cursor for the next poll. */
  get_updates_buf: string | undefined
  /** Server-suggested poll timeout. */
  longpolling_timeout_ms: number | undefined
}

/** One outbound text message. */
export interface SendTextParams {
  /** API base URL. */
  baseUrl: string
  /** Bot token. */
  token: string
  /** Destination user. */
  to: string
  /** The text to send. */
  text: string
  /** The conversation token the inbound message issued, when there was one. */
  contextToken?: string | undefined
  /** Request timeout. */
  timeoutMs?: number
}

/** One typing-ticket request. */
export interface GetConfigParams {
  /** API base URL. */
  baseUrl: string
  /** Bot token. */
  token: string
  /** The user the ticket is bound to. */
  userId: string
  /** The conversation's token, when the caller has one. */
  contextToken?: string | undefined
  /** Request timeout. */
  timeoutMs?: number | undefined
}

/** One typing-status report. */
export interface SendTypingParams {
  /** API base URL. */
  baseUrl: string
  /** Bot token. */
  token: string
  /** The user the indicator is shown to. */
  userId: string
  /** The ticket {@link GetConfigParams} returned. */
  ticket: string
  /** See `TypingStatus`: 1 shows the indicator, 2 withdraws it. */
  status: number
  /** Request timeout. */
  timeoutMs?: number | undefined
}

/** One upload authorization request. */
export interface GetUploadUrlParams {
  /** API base URL. */
  baseUrl: string
  /** Bot token. */
  token: string
  /** The object's name on the CDN. */
  filekey: string
  /** See {@link UploadMediaType}. */
  mediaType: number
  /** Destination user. */
  to: string
  /** Plaintext length in bytes. */
  rawsize: number
  /** MD5 of the plaintext, as lowercase hex. */
  rawfilemd5: string
  /** CIPHERTEXT length, which is the padded size - see `aesEcbPaddedSize`. */
  filesize: number
  /** The AES key as lowercase hex. */
  aeskey: string
  /** Request timeout. */
  timeoutMs?: number
}

/** Where one object may be uploaded. */
export interface GetUploadUrlResult {
  /** Authorization parameter, used to build a URL when no complete one came. */
  upload_param: string | undefined
  /** A complete upload URL, preferred over the parameter. */
  upload_full_url: string | undefined
}

/** One outbound file message. */
export interface SendFileParams {
  /** API base URL. */
  baseUrl: string
  /** Bot token. */
  token: string
  /** Destination user. */
  to: string
  /** The conversation token the inbound message issued, when there was one. */
  contextToken?: string | undefined
  /** The name the recipient sees. */
  fileName: string
  /** The download parameter the upload returned. */
  encryptQueryParam: string
  /** The AES key in base64, as the media reference spells it. */
  aesKeyBase64: string
  /** The CIPHERTEXT size, which the sender reports for images and video. */
  ciphertextSize: number
  /** The PLAINTEXT size, which the file item reports. */
  plaintextSize: number
  /** Request timeout. */
  timeoutMs?: number
}

/** Classified transport failure, for diagnostics that survive a redacted log. */
export interface FetchErrorClassification {
  /** Coarse cause. */
  type: 'dns' | 'tcp' | 'tls' | 'timeout' | 'unknown'
  /** Human-readable description. */
  description: string
  /** Underlying error code when one exists. */
  code?: string
}

/** The application id this channel presents. */
export const ILINK_APP_ID = 'bot'

/** Bot agent used when no explicit value is supplied. */
const DEFAULT_BOT_AGENT = 'dsh-channel-wechat'

/**
 * Encode a semantic version as the protocol's `0x00MMNNPP` integer.
 * @param version - dotted version, e.g. `1.0.11`.
 * @returns the encoded integer; each component is masked to one byte.
 */
export function buildClientVersion(version: string): number {
  const parts = version.split('.').map(part => Number.parseInt(part, 10))
  const major = Number.isNaN(parts[0]) ? 0 : (parts[0] ?? 0)
  const minor = Number.isNaN(parts[1]) ? 0 : (parts[1] ?? 0)
  const patch = Number.isNaN(parts[2]) ? 0 : (parts[2] ?? 0)
  return ((major & 0xff) << 16) | ((minor & 0xff) << 8) | (patch & 0xff)
}

/**
 * Build the `base_info` block the protocol carries on authenticated requests.
 * @param options - the channel version and bot agent to report.
 * @returns the `base_info` payload.
 */
export function buildBaseInfo(options: { channelVersion?: string; botAgent?: string } = {}): {
  channel_version: string
  bot_agent: string
} {
  return {
    channel_version: options.channelVersion ?? '0.0.0',
    bot_agent: normalizeBotAgent(options.botAgent),
  }
}

/**
 * Collapse a bot agent to something safe to put on the wire.
 * @param raw - candidate value.
 * @returns the trimmed value, or the default when nothing usable remains.
 */
function normalizeBotAgent(raw: string | undefined): string {
  const trimmed = raw?.trim() ?? ''
  return trimmed === '' ? DEFAULT_BOT_AGENT : trimmed.slice(0, 256)
}

/**
 * Classify a transport failure for diagnostics.
 * @param error - the thrown value.
 * @returns the coarse category and a description.
 */
export function classifyFetchError(error: unknown): FetchErrorClassification {
  if (error instanceof Error && error.name === 'AbortError') {
    return { type: 'timeout', description: 'request timeout' }
  }
  const cause = (error as { cause?: unknown } | null | undefined)?.cause
  const code = (cause as { code?: unknown } | null | undefined)?.code
  const text = `${String(cause ?? error ?? '')} ${String(typeof code === 'string' ? code : '')}`
  const matchedCode = typeof code === 'string' ? code : undefined
  const withCode = matchedCode === undefined ? {} : { code: matchedCode }

  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/iu.test(text)) {
    return { type: 'dns', description: 'DNS resolution failed, check DNS configuration', ...withCode }
  }
  if (/ECONNREFUSED/iu.test(text)) {
    return { type: 'tcp', description: 'TCP connection refused', ...withCode }
  }
  if (/UND_ERR_CONNECT_TIMEOUT|ETIMEDOUT|ENETUNREACH|EHOSTUNREACH/iu.test(text)) {
    return { type: 'tcp', description: 'TCP connection timeout or unreachable', ...withCode }
  }
  if (/UND_ERR_SOCKET|SSL|TLS|CERT|UNABLE_TO_VERIFY|DEPTH_ZERO/iu.test(text)) {
    return { type: 'tls', description: 'TLS handshake error', ...withCode }
  }
  return { type: 'unknown', description: 'network request failed' }
}

/** The protocol's own failure code, carried in a 200 response. */
class BusinessError extends Error {
  /**
   * @param label - diagnostic label for the request.
   * @param code - the `ret` or `errcode` value.
   * @param message - the server's `errmsg`, when it sent one.
   */
  constructor(label: string, readonly code: number, message: string) {
    super(`${label}: ${code === 0 ? '' : String(code)} ${message}`.trim())
    this.name = 'BusinessError'
  }
}

/** A response the server answered with a non-2xx status. */
class HttpStatusError extends Error {
  /**
   * @param label - diagnostic label for the request.
   * @param status - HTTP status the server returned.
   * @param body - response body, which may carry the protocol's error payload.
   */
  constructor(label: string, readonly status: number, readonly body: string) {
    super(`${label} ${String(status)}: ${body}`)
    this.name = 'HttpStatusError'
  }
}

/** Append a trailing slash so a returned `baseurl` cannot swallow a path segment. */
function withTrailingSlash(url: string): string {
  return url.endsWith('/') ? url : `${url}/`
}
/** A fresh client id for one outbound message. */
function generateClientId(): string {
  return randomUUID()
}

/** A random uint32 rendered as its decimal string, then base64'd. */
function randomWechatUin(): string {
  const uint32 = Math.floor(Math.random() * 0x1_0000_0000)
  return Buffer.from(String(uint32), 'utf8').toString('base64')
}

/**
 * Build the API client.
 * @param options - injected transport and request metadata.
 * @returns the client.
 */
export function createApiClient(options: ApiClientOptions = {}): ApiClient {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch
  const channelVersion = options.channelVersion ?? '0.0.0'
  const common: Record<string, string> = {
    'iLink-App-Id': ILINK_APP_ID,
    'iLink-App-ClientVersion': String(buildClientVersion(channelVersion)),
  }
  if (options.routeTag !== undefined && options.routeTag.trim() !== '') {
    common['SKRouteTag'] = options.routeTag.trim()
  }
  void options.botAgent

  /**
   * Perform one request with an optional timeout and an optional caller abort.
   *
   * Both signals abort the same request: the timeout is this call's own
   * deadline, and `signal` is the owner ending it early. The timer is
   * `unref`'d so a request that was already settled cannot hold the process
   * open by itself - a held long poll is the case that matters, because its
   * deadline is 35 seconds past the shutdown that abandoned it.
   *
   * @param url - absolute request URL.
   * @param init - fetch init, including the abort signals when either applies.
   * @param label - diagnostic label.
   * @returns the raw response text.
   */
  async function send(
    url: string,
    init: RequestInit,
    label: string,
    timeoutMs: number | undefined,
    signal: AbortSignal | undefined,
  ): Promise<string> {
    const controller = timeoutMs !== undefined && timeoutMs > 0 ? new AbortController() : undefined
    const timer = controller === undefined ? undefined : setTimeout(() => controller.abort(), timeoutMs)
    // Never let the deadline alone keep the process alive; the request it
    // guards is what should decide that.
    timer?.unref()
    const forward = (): void => { controller?.abort() }
    if (controller !== undefined && signal !== undefined) {
      if (signal.aborted) forward()
      else signal.addEventListener('abort', forward, { once: true })
    }
    const requestSignal = controller?.signal ?? signal
    try {
      const response = await fetchImpl(url, requestSignal === undefined ? init : { ...init, signal: requestSignal })
      const text = await response.text()
      // A non-2xx answer is a server verdict, not a transport fault: it keeps
      // its status and body so callers can read the protocol's error payload.
      if (!response.ok) throw new HttpStatusError(label, response.status, text)
      return text
    } catch (error) {
      if (error instanceof HttpStatusError) throw error
      const classified = classifyFetchError(error)
      throw Object.assign(new Error(`${label}: ${classified.description}`), { classification: classified, cause: error })
    } finally {
      if (timer !== undefined) clearTimeout(timer)
      if (controller !== undefined && signal !== undefined) signal.removeEventListener('abort', forward)
    }
  }

  return {
    async getUpdates(params) {
      const body = JSON.stringify({
        // An absent cursor is sent as an empty string on a fresh start, which
        // is what the protocol documents.
        get_updates_buf: params.cursor ?? '',
        base_info: buildBaseInfo({ channelVersion, ...(options.botAgent === undefined ? {} : { botAgent: options.botAgent }) }),
      })
      const raw = await this.post({
        baseUrl: params.baseUrl,
        endpoint: 'ilink/bot/getupdates',
        body,
        token: params.token,
        ...(params.timeoutMs === undefined ? {} : { timeoutMs: params.timeoutMs }),
        ...(params.signal === undefined ? {} : { signal: params.signal }),
        label: 'getupdates',
      })
      const parsed = JSON.parse(raw) as {
        ret?: number
        errcode?: number
        errmsg?: string
        msgs?: unknown[]
        get_updates_buf?: string
        longpolling_timeout_ms?: number
      }
      return {
        msgs: parsed.msgs ?? [],
        get_updates_buf: typeof parsed.get_updates_buf === 'string' ? parsed.get_updates_buf : undefined,
        longpolling_timeout_ms: typeof parsed.longpolling_timeout_ms === 'number' ? parsed.longpolling_timeout_ms : undefined,
      }
    },
    async sendText(params) {
      const message: Record<string, unknown> = {
        from_user_id: '',
        to_user_id: params.to,
        // Every send carries its own id, so the server can tell a retry from a
        // new message.
        client_id: generateClientId(),
        message_type: 2,
        message_state: 2,
        item_list: [{ type: 1, text_item: { text: params.text } }],
      }
      // The protocol's client sends without a token and warns; inventing one
      // would be worse than sending none.
      if (params.contextToken !== undefined) message['context_token'] = params.contextToken

      const raw = await this.post({
        baseUrl: params.baseUrl,
        endpoint: 'ilink/bot/sendmessage',
        body: JSON.stringify({
          msg: message,
          base_info: buildBaseInfo({ channelVersion, ...(options.botAgent === undefined ? {} : { botAgent: options.botAgent }) }),
        }),
        token: params.token,
        ...(params.timeoutMs === undefined ? {} : { timeoutMs: params.timeoutMs }),
        label: 'sendmessage',
      })
      const parsed = JSON.parse(raw) as { ret?: number; errcode?: number; errmsg?: string }
      // HTTP 200 carrying a failure is still a failure; `-14` in particular
      // means the account's session is suspended.
      const code = parsed.errcode ?? parsed.ret
      if (typeof code === 'number' && code !== 0) {
        throw new BusinessError('sendmessage', code, parsed.errmsg ?? '')
      }
    },
    async getUploadUrl(params) {
      const raw = await this.post({
        baseUrl: params.baseUrl,
        endpoint: 'ilink/bot/getuploadurl',
        body: JSON.stringify({
          filekey: params.filekey,
          media_type: params.mediaType,
          to_user_id: params.to,
          rawsize: params.rawsize,
          rawfilemd5: params.rawfilemd5,
          // The server checks this against what is actually posted, so it must
          // be the padded ciphertext size rather than the plaintext one.
          filesize: params.filesize,
          // Always declared: asking for a thumbnail URL when none will be
          // uploaded makes the server expect a second object.
          no_need_thumb: true,
          aeskey: params.aeskey,
          base_info: buildBaseInfo({ channelVersion, ...(options.botAgent === undefined ? {} : { botAgent: options.botAgent }) }),
        }),
        token: params.token,
        ...(params.timeoutMs === undefined ? {} : { timeoutMs: params.timeoutMs }),
        label: 'getuploadurl',
      })
      const parsed = JSON.parse(raw) as { upload_param?: string; upload_full_url?: string }
      return { upload_param: parsed.upload_param, upload_full_url: parsed.upload_full_url }
    },
    async sendFile(params) {
      if (params.fileName.trim() === '') {
        // The client shows this name, so an unnamed file is one the user cannot
        // identify. Failing here names the mistake where it was made.
        throw new Error('channel-wechat: sendFile requires a non-empty file name')
      }
      const message: Record<string, unknown> = {
        from_user_id: '',
        to_user_id: params.to,
        client_id: generateClientId(),
        message_type: 2,
        message_state: 2,
        item_list: [{
          type: 4,
          file_item: {
            media: {
              encrypt_query_param: params.encryptQueryParam,
              aes_key: params.aesKeyBase64,
              encrypt_type: 1,
            },
            file_name: params.fileName,
            // A decimal string on the wire, and the PLAINTEXT length while the
            // media reference points at the ciphertext.
            len: String(params.plaintextSize),
          },
        }],
      }
      if (params.contextToken !== undefined) message['context_token'] = params.contextToken

      const raw = await this.post({
        baseUrl: params.baseUrl,
        endpoint: 'ilink/bot/sendmessage',
        body: JSON.stringify({
          msg: message,
          base_info: buildBaseInfo({ channelVersion, ...(options.botAgent === undefined ? {} : { botAgent: options.botAgent }) }),
        }),
        token: params.token,
        ...(params.timeoutMs === undefined ? {} : { timeoutMs: params.timeoutMs }),
        label: 'sendmessage',
      })
      const parsed = JSON.parse(raw) as { ret?: number; errcode?: number; errmsg?: string }
      const code = parsed.errcode ?? parsed.ret
      if (typeof code === 'number' && code !== 0) {
        throw new BusinessError('sendmessage', code, parsed.errmsg ?? '')
      }
    },
    async getConfig(params) {
      const raw = await this.post({
        baseUrl: params.baseUrl,
        endpoint: 'ilink/bot/getconfig',
        body: JSON.stringify({
          ilink_user_id: params.userId,
          ...(params.contextToken === undefined ? {} : { context_token: params.contextToken }),
          base_info: buildBaseInfo({ channelVersion, ...(options.botAgent === undefined ? {} : { botAgent: options.botAgent }) }),
        }),
        token: params.token,
        ...(params.timeoutMs === undefined ? {} : { timeoutMs: params.timeoutMs }),
        label: 'getconfig',
      })
      const parsed = JSON.parse(raw) as { ret?: number; typing_ticket?: unknown }
      // Only `ret === 0` is a ticket. Caching a message from a refusal would
      // put server prose into a status report.
      if (parsed.ret !== 0) return ''
      return typeof parsed.typing_ticket === 'string' ? parsed.typing_ticket : ''
    },
    async sendTyping(params) {
      const raw = await this.post({
        baseUrl: params.baseUrl,
        endpoint: 'ilink/bot/sendtyping',
        body: JSON.stringify({
          ilink_user_id: params.userId,
          typing_ticket: params.ticket,
          status: params.status,
          base_info: buildBaseInfo({ channelVersion, ...(options.botAgent === undefined ? {} : { botAgent: options.botAgent }) }),
        }),
        token: params.token,
        ...(params.timeoutMs === undefined ? {} : { timeoutMs: params.timeoutMs }),
        label: 'sendtyping',
      })
      const parsed = JSON.parse(raw) as { ret?: number; errmsg?: string }
      // Unlike the reference client, a rejection is surfaced: it is the only
      // evidence that a cached ticket went stale.
      if (typeof parsed.ret === 'number' && parsed.ret !== 0) {
        throw new BusinessError('sendtyping', parsed.ret, parsed.errmsg ?? '')
      }
    },
    async get(params) {
      const url = new URL(params.endpoint, withTrailingSlash(params.baseUrl)).toString()
      return send(url, { method: 'GET', headers: { ...common } }, params.label, params.timeoutMs, params.signal)
    },
    async post(params) {
      const url = new URL(params.endpoint, withTrailingSlash(params.baseUrl)).toString()
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        AuthorizationType: 'ilink_bot_token',
        'X-WECHAT-UIN': randomWechatUin(),
        ...common,
      }
      if (params.token !== undefined && params.token.trim() !== '') headers['Authorization'] = `Bearer ${params.token.trim()}`
      return send(url, { method: 'POST', headers, body: params.body }, params.label, params.timeoutMs, params.signal)
    },
  }
}
