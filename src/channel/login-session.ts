/**
 * The login attempt the panel watches.
 *
 * A browser cannot hold the iLink long poll: each HTTP request is independent,
 * and several race once the page starts polling for status. So the host owns one
 * attempt at a time and every request only reads a snapshot of it.
 *
 * The loop itself is {@link runQrLogin}. What lives here is the part a terminal
 * never needed: the QR outliving the call that fetched it, and the verify code
 * arriving from a later request instead of a prompt.
 *
 * @module dsh-channel-wechat/channel/login-session
 */

import type { ApiTransport } from '../wechat/api.ts'
import type { LoginCredentials, LoginEffect } from '../wechat/login-machine.ts'
import { runQrLogin } from '../wechat/login-runner.ts'

/** What the page should draw. */
export type LoginPhase =
  | 'idle'
  | 'waiting'
  | 'scanned'
  | 'need-verifycode'
  | 'connected'
  | 'already-connected'
  | 'failed'

/** One attempt's observable state. */
export interface LoginSnapshot {
  /** The state the page should render. */
  phase: LoginPhase
  /** The URL to encode into the QR, once one exists. */
  qrcodeUrl?: string | undefined
  /** Why the attempt failed, when it did. */
  message?: string | undefined
  /** The account that connected, once one did. */
  accountId?: string | undefined
}

/** What a session needs from its owner. */
export interface LoginSessionOptions {
  /** Wire client for the login. */
  api: ApiTransport
  /** Receive the credentials a confirmed login produced. */
  onConnected: (credentials: LoginCredentials) => void | Promise<void>
  /** Abandon the attempt after this long. */
  timeoutMs?: number
  /** Pause between polls; tests inject their own. */
  sleep?: (ms: number) => Promise<void>
  /** Monotonic milliseconds; defaults to `Date.now`. */
  now?: () => number
}

/** One login attempt, owned by the host. */
export interface LoginSession {
  /** Begin the attempt. Calling it twice is a no-op. */
  start: () => void
  /** The current state, safe to read from any request. */
  snapshot: () => LoginSnapshot
  /** Answer a `need-verifycode` challenge. */
  submitVerifyCode: (code: string) => void
  /** Abandon the attempt, releasing whatever it is waiting on. */
  stop: () => void
}

/**
 * Create one login attempt.
 *
 * The attempt is started by {@link LoginSession.start} rather than by
 * construction, so a caller that only reads a snapshot never triggers a login.
 * @param options - the wire client, the completion callback, and timing.
 * @returns the session the panel polls.
 */
export function createLoginSession(options: LoginSessionOptions): LoginSession {
  let state: LoginSnapshot = { phase: 'idle' }
  let started = false
  let stopped = false
  /** Resolves the pending verify-code await; buffered when none is parked. */
  let pendingCode: string | undefined
  let releaseVerifyCode: { resolve: (code: string) => void; reject: (error: unknown) => void } | undefined

  /** Reject the runner's sleep so a stopped attempt unwinds. */
  const stoppedError = new Error('login stopped')
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)))

  const applyEffect = (effect: LoginEffect, qrcodeUrl: string | undefined): void => {
    switch (effect.kind) {
      case 'announce-scanned':
        state = { ...state, phase: 'scanned' }
        break
      case 'request-verify-code':
        state = { ...state, phase: 'need-verifycode' }
        break
      case 'refresh-qr':
        // A replacement invalidates the old code, so the page must not keep
        // showing the one it has already fetched.
        state = { ...state, phase: 'waiting' }
        break
      case 'poll':
      case 'connected':
      case 'already-connected':
      case 'failed':
        // The three terminal effects end the runner without being reported
        // through `onEffect`, so they are applied from its result instead. They
        // are listed here so this switch stays exhaustive over `LoginEffect`.
        break
    }
    if (qrcodeUrl !== undefined) state = { ...state, qrcodeUrl }
  }

  /** Park until {@link LoginSession.submitVerifyCode} supplies a code. */
  const waitForVerifyCode = (): Promise<string> => {
    if (pendingCode !== undefined) {
      const code = pendingCode
      pendingCode = undefined
      return Promise.resolve(code)
    }
    return new Promise<string>((resolve, reject) => { releaseVerifyCode = { resolve, reject } })
  }

  /**
   * Apply a finished attempt's outcome.
   *
   * `runQrLogin` returns the terminal effects rather than reporting them through
   * `onEffect`, so a page that only watched `onEffect` would sit on "waiting"
   * forever with no QR and no explanation.
   */
  const finish = (result: Awaited<ReturnType<typeof runQrLogin>>): void => {
    switch (result.kind) {
      case 'connected':
        state = { ...state, phase: 'connected', accountId: result.credentials.accountId }
        break
      case 'already-connected':
        state = { ...state, phase: 'already-connected' }
        break
      case 'failed':
        state = { ...state, phase: 'failed', message: result.message }
        break
    }
  }

  return {
    start(): void {
      if (started) return
      // A second attempt is allowed only after one has ended. A QR expires once
      // its refresh budget is spent, and restarting DSH to retry is exactly what
      // this panel exists to avoid; but a retry after success would replace a
      // working login, so `connected` is terminal.
      if (state.phase === 'connected' || state.phase === 'already-connected') return
      started = true
      // Reset the per-attempt parkings: a previous attempt ended while holding
      // one of them, and reusing it would hand the new run the old answer.
      pendingCode = undefined
      releaseVerifyCode = undefined
      state = { phase: 'idle' }

      // Detached: an attempt runs for minutes while its requests come and go, so
      // awaiting it here would park the caller that merely began it.
      void runQrLogin({
        api: options.api,
        ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
        ...(options.now === undefined ? {} : { now: options.now }),
        sleep: async (ms: number) => {
          if (stopped) throw stoppedError
          await sleep(ms)
          if (stopped) throw stoppedError
        },
        onQrCode: qr => {
          // A code to scan means the attempt is live and waiting on the user,
          // which is a different screen from "idle" and from a refresh.
          state = { ...state, phase: 'waiting', qrcodeUrl: qr.qrcodeUrl }
        },
        onEffect: effect => { applyEffect(effect, undefined) },
        promptForVerifyCode: () => waitForVerifyCode(),
      })
        .then(result => {
          // The run is over either way, so a later `start` may begin a fresh
          // attempt; the phase decides whether it should.
          started = false
          if (result.kind === 'connected') {
            // The owner stores the credentials; the phase already says connected
            // because the page must not wait on a write to stop showing the QR.
            void options.onConnected(result.credentials)
          }
          finish(result)
        })
        .catch(() => {
          // A stop unwinds the runner through its sleep; only a stop is expected
          // here, so it must not be reported as a failed login.
          started = false
          if (!stopped) state = { ...state, phase: 'failed', message: '登录流程意外中断。' }
        })
    },

    snapshot(): LoginSnapshot {
      return { ...state }
    },

    submitVerifyCode(code: string): void {
      const release = releaseVerifyCode
      releaseVerifyCode = undefined
      if (release === undefined) {
        // Arriving before the runner parks must not lose the code: the request
        // that read `need-verifycode` can beat the runner to the await.
        pendingCode = code
        return
      }
      release.resolve(code)
    },

    stop(): void {
      stopped = true
      // Settle the verify-code handoff by rejecting it. `stop` runs from the
      // fiber's disposer while the runner may be parked here with no timer of
      // its own, so leaving it pending would leak the attempt past the plugin
      // that owns it. Rejecting rather than resolving with an empty string keeps
      // an empty code out of the state: the server counts one as a wrong code,
      // and it would spend the retry budget.
      releaseVerifyCode?.reject(stoppedError)
      releaseVerifyCode = undefined
    },
  }
}
