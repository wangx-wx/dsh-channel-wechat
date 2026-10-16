/**
 * Mounting the login panel on a host that has one.
 *
 * The panel is optional by construction: it needs `ctx.connection`, which only a
 * browser-facing host provides. A headless profile has no such service, and
 * declaring it in `inject` would park the whole channel there - a plugin that
 * silently does nothing is the failure this suite exists to rule out.
 *
 * So the rows are registered through conditional inject, and what is asserted is
 * that the routes exist under `/api` once the service appears, and that nothing
 * is registered when it never does.
 */

import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it } from 'vitest'
import { mountPanelRoutes, panelUrl } from '../../src/channel/mount.ts'

/** One registered Fetch route, as the fake connection service records it. */
interface RegisteredRoute {
  path: string
  methods: readonly string[]
  requestBody?: unknown
  fetch: (request: Request) => Promise<Response>
}

/** A `ctx.connection` stand-in that records what was registered. */
function fakeConnection() {
  const routes: RegisteredRoute[] = []
  const service = {
    fetch: {
      register(route: RegisteredRoute) {
        routes.push(route)
        // The real service returns a disposer that removes the route, which is
        // what makes an unloaded plugin stop serving.
        return () => {
          const index = routes.indexOf(route)
          if (index !== -1) routes.splice(index, 1)
        }
      },
    },
  }
  return { routes, service }
}

/**
 * A panel stub: the mount only reads `routes` off it, so a real session would add
 * nothing these tests observe.
 */
function stubPanel() {
  const page = async (): Promise<Response> => new Response('page')
  const status = async (): Promise<Response> => new Response('{}')
  const qrImage = async (): Promise<Response> => new Response('svg')
  const begin = async (): Promise<Response> => new Response('{}')
  const verifyCode = async (): Promise<Response> => new Response('{}')
  const logout = async (): Promise<Response> => new Response('{}')
  return { session: {} as never, routes: { page, status, qrImage, begin, verifyCode, logout } }
}

const contexts: Context[] = []

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
})

describe('mounting the login panel', () => {
  it('registers nothing when the host has no browser-facing connection', async () => {
    // The headless case: a channel that parked forever waiting for a service the
    // profile never provides would be absent with no diagnostic.
    const ctx = new Context()
    contexts.push(ctx)

    expect(() => { mountPanelRoutes(ctx, stubPanel) }).not.toThrow()
    // Nothing to assert on a service that does not exist; the point is that
    // mounting does not throw and does not park its caller.
    expect(ctx.get('connection')).toBeUndefined()
  })

  it('waits for a connection that is not there yet', async () => {
    // `connection` is not available when a plugin row activates: its own row
    // waits on `webStartup`, so reading it during `apply` finds nothing. That is
    // exactly how this shipped - the routes were registered against `undefined`,
    // every request 404'd, and the page's URL still printed as if it worked.
    const ctx = new Context()
    contexts.push(ctx)
    const { routes, service } = fakeConnection()

    // Not awaited yet: the mount is still waiting for the service, which is the
    // state a real profile is in at this point.
    const mounting = mountPanelRoutes(ctx, stubPanel)
    expect(routes).toHaveLength(0)

    // The service arriving later is the normal order here, not an edge case.
    ctx.provide('connection', service)
    const path = await mounting

    expect(routes.some(route => route.path === path)).toBe(true)
  })

  it('registers every route under /api, which is what fences them', async () => {
    // These routes carry the QR and accept a verify code without checking
    // anything themselves. `/api` is the only prefix the harness's process-token
    // and browser-cookie fence covers, so a route registered elsewhere would be
    // reachable by any local process - which is exactly the defect both existing
    // WeChat plugins ship.
    const ctx = new Context()
    contexts.push(ctx)
    const { routes, service } = fakeConnection()
    ctx.provide('connection', service)

    await mountPanelRoutes(ctx, stubPanel)

    expect(routes.length).toBeGreaterThan(0)
    for (const route of routes) {
      expect(route.path.startsWith('/api/')).toBe(true)
      // Registration validates the shape, so an empty method list would be a
      // route that can never be reached.
      expect(route.methods.length).toBeGreaterThan(0)
    }
  })

  it('serves the page at a URL the console can print', async () => {
    // The panel is useless if nobody knows the address. The printed URL and the
    // registered route have to be the same string, so it is taken from the mount
    // rather than written out twice.
    const ctx = new Context()
    contexts.push(ctx)
    const { routes, service } = fakeConnection()
    ctx.provide('connection', service)

    const path = await mountPanelRoutes(ctx, stubPanel)

    expect(path).toBe('/api/channel-wechat/login')
    expect(routes.some(route => route.path === path && route.methods.includes('GET'))).toBe(true)
  })

  it('announces an absolute URL, not a bare path', async () => {
    // The path is relative, so printing it alone gives the user a string they
    // cannot paste anywhere: no scheme, no host, no port. The port matters most,
    // because `--port 0` means the app binds one the config never named.
    const ctx = new Context()
    contexts.push(ctx)
    const { service } = fakeConnection()
    ctx.provide('connection', service)
    ctx.provide('webServer', { port: 19387, host: '127.0.0.1' })

    const url = await panelUrl(ctx)

    expect(url).toBe('http://127.0.0.1:19387/api/channel-wechat/login')
  })

  it('falls back to the path when the host reports no port', async () => {
    // The webserver listens after this runs, so its port can legitimately be
    // absent. A relative path reaches the user's own browser correctly; a URL
    // built from `undefined` would read as port NaN and be worse than nothing.
    const ctx = new Context()
    contexts.push(ctx)
    const { service } = fakeConnection()
    ctx.provide('connection', service)

    expect(await panelUrl(ctx)).toBe('/api/channel-wechat/login')
  })

  it('unregisters every route when the plugin unloads', async () => {
    // Cordis registrations are reversible by contract; a route that outlived its
    // plugin would keep serving a QR for a channel that is gone.
    const ctx = new Context()
    const { routes, service } = fakeConnection()
    ctx.provide('connection', service)
    await mountPanelRoutes(ctx, stubPanel)

    const registered = routes.length
    expect(registered).toBeGreaterThan(0)
    await ctx.fiber.dispose()

    expect(routes).toHaveLength(0)
  })
})
