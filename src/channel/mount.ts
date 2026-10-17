/**
 * Mounting the login panel on a host that has one.
 *
 * The panel is optional by construction: it needs `ctx.connection`, which only a
 * browser-facing host provides. Declaring that in the plugin's `inject` would
 * park the whole channel on a headless profile, where it silently does nothing -
 * the failure mode the boot suite exists to rule out. So the routes are
 * registered only when the service is already present.
 *
 * Every route lives under `/api`, which is the prefix the harness's own
 * process-token and browser-cookie fence covers. A route registered anywhere
 * else is reachable by any local process; both existing WeChat plugins ship that
 * defect.
 *
 * @module dsh-channel-wechat/channel/mount
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Panel } from './panel.ts'
import type { UpdateRoutes } from './update-routes.ts'

/** The path prefix every route shares, and the reason they are authenticated. */
export const PANEL_PREFIX = '/api/channel-wechat'

/** The page's path, which is also the URL a host prints for the user. */
export const PANEL_PATH = `${PANEL_PREFIX}/login`

/** The slice of `ctx.connection` this module uses. */
interface ConnectionLike {
  fetch: {
    register: (route: {
      path: string
      methods: readonly string[]
      requestBody: string
      fetch: (request: Request) => Promise<Response>
    }) => () => void
  }
}

/**
 * Build the link a user can actually open.
 *
 * The page lives at a relative path, which is the right thing to register and
 * the wrong thing to print: a bare path has no scheme, host, or port, so it
 * cannot be pasted anywhere. The port is read from the server rather than the
 * configuration because `--port 0` binds one the config never named.
 *
 * @param ctx - the plugin's cordis context.
 * @returns an absolute URL, or the bare path when the host reports no port yet.
 */
export function panelUrl(ctx: Context): string {
  const server = ctx.get('webServer') as { port?: number; host?: string } | undefined
  // The webserver listens after this runs, so its port can legitimately be
  // absent. A relative path still reaches the user's own browser correctly, while
  // a URL built from `undefined` would read as port NaN.
  if (server?.port === undefined) return PANEL_PATH
  const host = server.host === '0.0.0.0' ? '127.0.0.1' : (server.host ?? '127.0.0.1')
  return `http://${host}:${String(server.port)}${PANEL_PATH}`
}

/**
 * Register the panel's routes on the host's fenced `/api` surface.
 *
 * The connection service is not available when a plugin row activates - its own
 * row waits on `webStartup` - so the routes are attached through a conditional
 * inject that runs when the service arrives, whenever that is. Reading it here
 * instead would find `undefined` on every real profile and register nothing while
 * still reporting a URL, which is a panel that 404s with no diagnostic.
 *
 * @param ctx - the plugin's cordis context.
 * @param createPanel - builds the panel, called only when a host can serve it.
 * @param createUpdate - builds the update routes, called only when a host can
 *   serve them. Absent leaves the update card out entirely rather than mounting
 *   routes that would answer 404.
 * @returns the page's path, for a host that wants to print it.
 */
export async function mountPanelRoutes(
  ctx: Context,
  createPanel: () => Panel,
  createUpdate?: () => UpdateRoutes,
): Promise<string> {
  // Conditional inject rather than a declaration in the plugin's own `inject`:
  // a declared dependency would park the whole channel on a headless profile,
  // where the panel cannot exist and the messaging half still must.
  //
  // Awaited so the routes exist when this returns. A caller that printed the URL
  // before the inject had run would advertise a page that still 404s.
  await ctx.inject(['connection'], injected => {
    const connection = injected.get('connection') as ConnectionLike | undefined
    if (connection?.fetch === undefined) return

    const panel = createPanel()
    // Built inside the conditional inject for the same reason the panel is: the
    // update card reads the profile it belongs to, and that must be read from a
    // host that can actually serve the page.
    const update = createUpdate === undefined ? undefined : createUpdate()
    // Registered through `ctx.effect`, so unloading removes them: a route that
    // outlived the plugin would keep serving a QR for a channel that is gone.
    injected.effect(() => {
      const disposers = [
        connection.fetch.register({
          path: PANEL_PATH,
          methods: ['GET'],
          requestBody: 'buffered',
          fetch: () => panel.routes.page(),
        }),
        connection.fetch.register({
          path: `${PANEL_PREFIX}/status`,
          methods: ['GET'],
          requestBody: 'buffered',
          fetch: () => panel.routes.status(),
        }),
        connection.fetch.register({
          path: `${PANEL_PREFIX}/qr.svg`,
          methods: ['GET'],
          requestBody: 'buffered',
          fetch: () => panel.routes.qrImage(),
        }),
        connection.fetch.register({
          path: `${PANEL_PREFIX}/begin`,
          methods: ['POST'],
          requestBody: 'buffered',
          fetch: () => panel.routes.begin(),
        }),
        connection.fetch.register({
          path: `${PANEL_PREFIX}/verify-code`,
          methods: ['POST'],
          requestBody: 'buffered',
          fetch: (request: Request) => panel.routes.verifyCode(request),
        }),
        connection.fetch.register({
          path: `${PANEL_PREFIX}/logout`,
          methods: ['POST'],
          requestBody: 'buffered',
          fetch: () => panel.routes.logout(),
        }),
        connection.fetch.register({
          path: `${PANEL_PREFIX}/models`,
          methods: ['GET'],
          requestBody: 'buffered',
          fetch: () => panel.routes.models(),
        }),
        ...update === undefined ? [] : [
          connection.fetch.register({
            path: `${PANEL_PREFIX}/update/check`,
            methods: ['GET'],
            requestBody: 'buffered',
            fetch: () => update.check(),
          }),
          connection.fetch.register({
            path: `${PANEL_PREFIX}/update/command`,
            methods: ['GET'],
            requestBody: 'buffered',
            fetch: () => update.command(),
          }),
        ],
      ]
      return () => { for (const dispose of disposers) dispose() }
    })
  })

  return PANEL_PATH
}
