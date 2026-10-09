/**
 * QR login state machine.
 *
 * Pure: it takes the current state and one server status, and returns the next
 * state plus the single thing the caller should do about it. Polling, printing,
 * and reading the verify code stay in the caller, so the transition rules can
 * be verified without a network, a clock, or a terminal.
 *
 * Status names and their meanings: docs/protocol/protocol_zh_CN.md.
 *
 * @module dsh-channel-wechat/wechat/login-machine
 */

/** The eight statuses the protocol defines for QR polling. */
export type QrStatus =
  | 'wait'
  | 'scaned'
  | 'confirmed'
  | 'expired'
  | 'need_verifycode'
  | 'verify_code_blocked'
  | 'scaned_but_redirect'
  | 'binded_redirect'

/** One status response body. */
export interface QrStatusResponse {
  /** Which state the server is reporting. */
  status: QrStatus
  /** Issued on confirmation. */
  bot_token?: string
  /** The bot account id; the key later credentials are stored under. */
  ilink_bot_id?: string
  /** API base URL the server wants subsequent requests to use. */
  baseurl?: string
  /** The scanning user's id. */
  ilink_user_id?: string
  /** New host to poll when the status is `scaned_but_redirect`. */
  redirect_host?: string
}

/** Credentials a confirmed login produces. */
export interface LoginCredentials {
  /** Bot token for authenticated requests. */
  botToken: string | undefined
  /** Bot account id. */
  accountId: string
  /** API base URL, when the server supplied one. */
  baseUrl: string | undefined
  /** The user who scanned. */
  userId: string | undefined
}

/** What the caller should do after a transition. */
export type LoginEffect =
  | { kind: 'poll' }
  | { kind: 'announce-scanned' }
  | { kind: 'request-verify-code'; retry: boolean }
  | { kind: 'refresh-qr' }
  | { kind: 'connected'; credentials: LoginCredentials }
  | { kind: 'already-connected' }
  | { kind: 'failed'; message: string }

/** A verify code the user typed, to be sent on subsequent polls. */
export function withVerifyCode(state: LoginState, code: string): LoginState {
  return { ...state, pendingVerifyCode: code }
}

/** A replacement QR code issued after a `refresh-qr` effect. */
export function withRefreshedQr(state: LoginState, qr: { qrcode: string; qrcodeUrl: string }): LoginState {
  // A new code has not been scanned, and it invalidates any code in flight.
  return dropVerifyCode({
    ...state,
    qrcode: qr.qrcode,
    qrcodeUrl: qr.qrcodeUrl,
    scannedAnnounced: false,
    refreshCount: state.refreshCount + 1,
  })
}

/** Everything the machine remembers between polls. */
export interface LoginState {
  /** Current QR value, sent back on each poll. */
  qrcode: string
  /** URL the QR encodes, shown to the user. */
  qrcodeUrl: string
  /** Base URL the next poll goes to; changes on an IDC redirect. */
  apiBaseUrl: string
  /** How many QR codes have been issued, including the first. */
  refreshCount: number
  /** Whether the scanned notice has already been shown for this code. */
  scannedAnnounced: boolean
  /** A code typed but not yet accepted, resent on each poll until it is. */
  pendingVerifyCode?: string
}

/** One transition: the next state and the action it implies. */
export interface LoginTransition {
  /** State to carry into the next poll. */
  state: LoginState
  /** The single action the caller should take. */
  effect: LoginEffect
}

/** The number of QR codes a login may consume before giving up. */
export const MAX_QR_REFRESH_COUNT = 3

/**
 * Advance the machine by one status response.
 *
 * A `refresh-qr` effect is a request, not a result: the caller fetches a new
 * code and applies {@link withRefreshedQr}, which is what consumes the next
 * slot of the refresh budget. Until it does, the state keeps the old QR, so a
 * caller that ignores the effect cannot silently keep polling a dead code.
 * @param state - state carried from the previous poll.
 * @param response - the status the server just reported.
 * @returns the next state and the action it implies.
 */
export function reduceLogin(state: LoginState, response: QrStatusResponse): LoginTransition {
  const base = state

  switch (response.status) {
    case 'confirmed': {
      // A confirmation with no account id cannot be keyed, so it is a failure
      // rather than a login that later requests silently cannot address.
      if (response.ilink_bot_id === undefined || response.ilink_bot_id.trim() === '') {
        return { state: base, effect: { kind: 'failed', message: '登录失败：服务器未返回 ilink_bot_id。' } }
      }
      return {
        state: base,
        effect: {
          kind: 'connected',
          credentials: {
            botToken: response.bot_token,
            accountId: response.ilink_bot_id,
            baseUrl: response.baseurl,
            userId: response.ilink_user_id,
          },
        },
      }
    }
    case 'binded_redirect':
      return { state: base, effect: { kind: 'already-connected' } }
    case 'scaned':
      // A pending code being accepted is what clears it: the server never says
      // the code was right, it just stops asking for one.
      if (base.pendingVerifyCode !== undefined) return { state: dropVerifyCode(base), effect: { kind: 'poll' } }
      if (base.scannedAnnounced) return { state: base, effect: { kind: 'poll' } }
      return { state: { ...base, scannedAnnounced: true }, effect: { kind: 'announce-scanned' } }
    case 'need_verifycode':
      return {
        state: base,
        // Arriving here with a code already pending means the last one was
        // rejected; the server does not report that directly.
        effect: { kind: 'request-verify-code', retry: base.pendingVerifyCode !== undefined },
      }
    case 'expired':
    case 'verify_code_blocked':
      return refresh(base, response.status === 'verify_code_blocked')
    case 'scaned_but_redirect':
      // A redirect that names no host must not clear the current one, or the
      // next poll has no address to go to.
      if (response.redirect_host === undefined || response.redirect_host.trim() === '') {
        return { state: base, effect: { kind: 'poll' } }
      }
      return { state: { ...base, apiBaseUrl: `https://${response.redirect_host.trim()}` }, effect: { kind: 'poll' } }
    case 'wait':
    default:
      return { state: base, effect: { kind: 'poll' } }
  }
}

/** Remove the pending verify code without leaving an undefined property behind. */
function dropVerifyCode(state: LoginState): LoginState {
  const next = { ...state }
  delete next.pendingVerifyCode
  return next
}

/** Ask for a replacement code, or give up when the budget is spent. */
function refresh(state: LoginState, blocked: boolean): LoginTransition {
  // The budget is consumed by {@link withRefreshedQr} when the replacement
  // arrives, so this only decides whether one is still available.
  if (state.refreshCount + 1 > MAX_QR_REFRESH_COUNT) {
    return {
      state,
      effect: {
        kind: 'failed',
        message: blocked ? '多次输入错误，连接流程已停止。请稍后再试。' : '二维码多次失效，连接流程已停止。请稍后再试。',
      },
    }
  }
  return { state: dropVerifyCode(state), effect: { kind: 'refresh-qr' } }
}
