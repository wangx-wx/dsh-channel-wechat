/**
 * The login panel: the attempt, its routes, and what finishing it does.
 *
 * The panel exists so a login completes without a restart. The user scans, and
 * the channel starts polling in the same process; a panel that only saved the
 * credentials would look identical on screen - "已连接" - and deliver nothing,
 * which is the worst version of this feature, because the user has no reason to
 * suspect it.
 *
 * Ordering is part of the contract: the channel resolves its account from the
 * credentials store when it starts, so the write has to commit first.
 *
 * @module dsh-channel-wechat/channel/panel
 */

import type { ApiTransport } from '../wechat/api.ts'
import type { LoginCredentials } from '../wechat/login-machine.ts'
import { createLoginRoutes, type LoginRoutes } from './login-routes.ts'
import { createLoginSession, type LoginSession } from './login-session.ts'

/** What the panel needs from the plugin. */
export interface PanelOptions {
  /** Wire client for the login. */
  api: ApiTransport
  /** Persist a confirmed login. */
  saveAccount: (credentials: LoginCredentials) => Promise<void>
  /** Begin polling as the stored account. */
  startChannel: () => void | Promise<void>
  /** Observe a failure from the write or the start. */
  onError?: (error: unknown) => void
  /** Pause between polls; tests inject their own. */
  sleep?: (ms: number) => Promise<void>
  /** Monotonic milliseconds; defaults to `Date.now`. */
  now?: () => number
  /** Abandon the attempt after this long. */
  timeoutMs?: number
}

/** The panel: one login attempt and the routes that drive it. */
export interface Panel {
  /** The attempt the routes read. */
  session: LoginSession
  /** The routes to mount. */
  routes: LoginRoutes
}

/**
 * Build the panel.
 * @param options - the wire client, the completion actions, and timing.
 * @returns the attempt and its routes.
 */
export function createPanel(options: PanelOptions): Panel {
  const session = createLoginSession({
    api: options.api,
    ...(options.sleep === undefined ? {} : { sleep: options.sleep }),
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    onConnected: credentials => {
      // No single-flight guard here: the session allows one attempt at a time and
      // only one completion per attempt, which is where that belongs.
      void (async () => {
        // The write commits first: the channel reads the store as it starts, so a
        // start that beat the write would poll as the previous account or none.
        await options.saveAccount(credentials)
        await options.startChannel()
      })().catch((error: unknown) => {
        // A failed write or start must not pass for a connected login; the page
        // would claim success for a channel that is not running.
        options.onError?.(error)
      })
    },
  })

  return { session, routes: createLoginRoutes({ session }) }
}
