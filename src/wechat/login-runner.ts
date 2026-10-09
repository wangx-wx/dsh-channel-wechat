/**
 * Login orchestration.
 *
 * Drives the state machine in {@link ./login-machine.ts} against the wire layer
 * in {@link ./api.ts}: fetch a QR code, poll its status on a deadline, fetch
 * replacements when asked, and stop at a terminal status.
 *
 * Everything with an outside dependency — sleeping, the clock, the verify-code
 * prompt, and rendering — arrives as an option, so the loop is testable without
 * a network, a terminal, or real time.
 *
 * @module dsh-channel-wechat/wechat/login-runner
 */

import type { ApiClient } from './api.ts'
import {
  reduceLogin,
  withRefreshedQr,
  withVerifyCode,
  type LoginCredentials,
  type LoginEffect,
  type LoginState,
  type QrStatusResponse,
} from './login-machine.ts'

/** The API base URL every login starts from, per the protocol document. */
export const LOGIN_BASE_URL = 'https://ilinkai.weixin.qq.com'

/** `bot_type` value this channel build presents. */
export const DEFAULT_BOT_TYPE = '3'

/** How long the server may hold a status poll open. */
const POLL_TIMEOUT_MS = 35_000

/** Pause between polls once one returns. */
const POLL_INTERVAL_MS = 1_000

/** How long a login may run before it is abandoned. */
const DEFAULT_TIMEOUT_MS = 480_000

/** Outcome of a whole login attempt. */
export type LoginResult =
  | { kind: 'connected'; credentials: LoginCredentials }
  | { kind: 'already-connected' }
  | { kind: 'failed'; message: string }

/** Collaborators the runner needs from its caller. */
export interface LoginRunnerOptions {
  /** Wire client, already configured with the caller's metadata. */
  api: ApiClient
  /** Abandon the login after this long. */
  timeoutMs?: number
  /** `bot_type` to request; defaults to this build's. */
  botType?: string
  /** Monotonic milliseconds; defaults to `Date.now`. */
  now?: () => number
  /** Pause between polls; defaults to a real timer. */
  sleep?: (ms: number) => Promise<void>
  /** Ask the user for the verify code; `retry` means the last one was wrong. */
  promptForVerifyCode?: (retry: boolean) => Promise<string>
  /** Observe each effect, for progress reporting. */
  onEffect?: (effect: LoginEffect, state: LoginState) => void
  /** Receive each QR code to display, before polling begins. */
  onQrCode?: (qr: { qrcode: string; qrcodeUrl: string }) => void
}

/**
 * Run one QR login to completion.
 * @param options - the wire client and the caller-supplied collaborators.
 * @returns the login outcome.
 */
export async function runQrLogin(options: LoginRunnerOptions): Promise<LoginResult> {
  const { api } = options
  const botType = options.botType ?? DEFAULT_BOT_TYPE
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const now = options.now ?? Date.now
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)))

  let state: LoginState
  try {
    state = await startLogin(api, botType)
    options.onQrCode?.({ qrcode: state.qrcode, qrcodeUrl: state.qrcodeUrl })
  } catch (error) {
    return { kind: 'failed', message: `无法获取二维码：${messageOf(error)}` }
  }

  const deadline = now() + timeoutMs
  while (now() < deadline) {
    let response: QrStatusResponse
    try {
      response = await pollStatus(api, state)
    } catch {
      // A single failed poll is routine against a long poll (gateway timeouts
      // arrive as errors), so it reads as "no news" rather than ending a login
      // the user may still be scanning.
      response = { status: 'wait' }
    }

    const transition = reduceLogin(state, response)
    state = transition.state

    switch (transition.effect.kind) {
      case 'poll':
        break
      case 'announce-scanned':
        options.onEffect?.(transition.effect, state)
        break
      case 'request-verify-code': {
        options.onEffect?.(transition.effect, state)
        const code = await options.promptForVerifyCode?.(transition.effect.retry)
        // No prompt available means the challenge cannot be answered; leaving
        // the state untouched keeps polling until the deadline rather than
        // sending an empty code the server would reject as a wrong one.
        if (code !== undefined) state = withVerifyCode(state, code)
        break
      }
      case 'refresh-qr': {
        options.onEffect?.(transition.effect, state)
        try {
          state = withRefreshedQr(state, await fetchQr(api, botType))
        } catch (error) {
          return { kind: 'failed', message: `刷新二维码失败：${messageOf(error)}` }
        }
        break
      }
      case 'connected':
        return { kind: 'connected', credentials: transition.effect.credentials }
      case 'already-connected':
        return { kind: 'already-connected' }
      case 'failed':
        return { kind: 'failed', message: transition.effect.message }
    }

    await sleep(POLL_INTERVAL_MS)
  }

  return { kind: 'failed', message: '登录超时，请重试。' }
}

/** Request an initial QR code and build the starting state. */
async function startLogin(api: ApiClient, botType: string): Promise<LoginState & { qrcodeUrl: string }> {
  const qr = await fetchQr(api, botType)
  return {
    qrcode: qr.qrcode,
    qrcodeUrl: qr.qrcodeUrl,
    apiBaseUrl: LOGIN_BASE_URL,
    refreshCount: 1,
    scannedAnnounced: false,
  }
}

/** Fetch one QR code. */
async function fetchQr(api: ApiClient, botType: string): Promise<{ qrcode: string; qrcodeUrl: string }> {
  const raw = await api.post({
    baseUrl: LOGIN_BASE_URL,
    endpoint: `ilink/bot/get_bot_qrcode?bot_type=${encodeURIComponent(botType)}`,
    body: JSON.stringify({ local_token_list: [] }),
    label: 'get_bot_qrcode',
  })
  return parseQrResponse(raw)
}

/**
 * Read a QR response body.
 * @param raw - response text.
 * @returns the code and the URL to display.
 * @throws when either field is missing, since a code without a URL is unusable.
 */
export function parseQrResponse(raw: string): { qrcode: string; qrcodeUrl: string } {
  const parsed = JSON.parse(raw) as { qrcode?: unknown; qrcode_img_content?: unknown }
  if (typeof parsed.qrcode !== 'string' || parsed.qrcode === '') throw new Error('响应缺少 qrcode')
  if (typeof parsed.qrcode_img_content !== 'string') throw new Error('响应缺少 qrcode_img_content')
  return { qrcode: parsed.qrcode, qrcodeUrl: parsed.qrcode_img_content }
}

/** Poll one status, carrying the pending verify code when there is one. */
async function pollStatus(api: ApiClient, state: LoginState): Promise<QrStatusResponse> {
  let endpoint = `ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(state.qrcode)}`
  if (state.pendingVerifyCode !== undefined) {
    endpoint += `&verify_code=${encodeURIComponent(state.pendingVerifyCode)}`
  }
  const raw = await api.get({
    baseUrl: state.apiBaseUrl,
    endpoint,
    timeoutMs: POLL_TIMEOUT_MS,
    label: 'get_qrcode_status',
  })
  return JSON.parse(raw) as QrStatusResponse
}

/** Render an unknown thrown value as a message. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
