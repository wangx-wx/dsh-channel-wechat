/**
 * Wire layer for the WeChat iLink bot API.
 *
 * This is the protocol half of the channel and deliberately depends on nothing
 * from the harness: it takes its `fetch`, its route tag, and its bot agent as
 * inputs so the same code can run under a test, a CLI, or the plugin host.
 *
 * Shapes and header names come from docs/protocol/protocol_zh_CN.md.
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

/** The API surface later layers depend on. */
export interface ApiClient {
  /** Send an unauthenticated GET. */
  get(params: ApiGetParams): Promise<string>
  /** Send a JSON POST, optionally authenticated. */
  post(params: ApiPostParams): Promise<string>
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
   * Perform one request with an optional timeout.
   * @param url - absolute request URL.
   * @param init - fetch init, including the timeout signal when one applies.
   * @param label - diagnostic label.
   * @returns the raw response text.
   */
  async function send(url: string, init: RequestInit, label: string, timeoutMs: number | undefined): Promise<string> {
    const controller = timeoutMs !== undefined && timeoutMs > 0 ? new AbortController() : undefined
    const timer = controller === undefined ? undefined : setTimeout(() => controller.abort(), timeoutMs)
    try {
      const response = await fetchImpl(url, controller === undefined ? init : { ...init, signal: controller.signal })
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
    }
  }

  return {
    async get(params) {
      const url = new URL(params.endpoint, withTrailingSlash(params.baseUrl)).toString()
      return send(url, { method: 'GET', headers: { ...common } }, params.label, params.timeoutMs)
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
      return send(url, { method: 'POST', headers, body: params.body }, params.label, params.timeoutMs)
    },
  }
}
