/**
 * The update card's routes, at the HTTP boundary.
 *
 * The one behaviour worth pinning here is that a failed check still answers 200
 * with its own `status` field. Mapping it to an error status would reach the page
 * as a bare network failure: the reason would be lost, and "could not reach the
 * registry" would be indistinguishable from "the route does not exist".
 */

import { describe, expect, it, vi } from 'vitest'
import { createUpdateRoutes } from '../../src/channel/update-routes.ts'

describe('the update routes', () => {
  it('answers a successful check as JSON with its comparison intact', async () => {
    const routes = createUpdateRoutes({
      check: async () => ({ status: 'ready', current: '0.2.1', latest: '0.3.0', newer: true }),
      command: () => undefined,
    })

    const response = await routes.check()

    expect(response.status).toBe(200)
    expect(response.headers.get('Cache-Control')).toBe('no-store')
    await expect(response.json()).resolves.toEqual({ status: 'ready', current: '0.2.1', latest: '0.3.0', newer: true })
  })

  it('serves a failed check as 200 too, carrying the reason', async () => {
    // The page distinguishes the two by `status`, not by HTTP code. A 5xx would
    // strip the reason the page is meant to display.
    const routes = createUpdateRoutes({
      check: async () => ({ status: 'failed', current: '0.2.1', reason: 'offline' }),
      command: () => undefined,
    })

    const response = await routes.check()

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({ status: 'failed', reason: 'offline' })
  })

  it('returns the command when one can be built', async () => {
    const command = {
      command: '/n node /d/lib/bin.js plugin --profile web add dsh-channel-wechat@latest',
      desktop: false,
      profile: 'web',
      spec: 'dsh-channel-wechat@latest',
    }
    const routes = createUpdateRoutes({ check: async () => ({ status: 'failed', current: '', reason: '' }), command: () => command })

    await expect((await routes.command()).json()).resolves.toEqual(command)
  })

  it('refuses with 501 when no command can be built', async () => {
    // An empty command would render a copy button that copies nothing, so the
    // absence is reported instead of papered over.
    const routes = createUpdateRoutes({
      check: async () => ({ status: 'failed', current: '', reason: '' }),
      command: () => undefined,
    })

    const response = await routes.command()

    expect(response.status).toBe(501)
    await expect(response.json()).resolves.toHaveProperty('error')
  })

  it('asks the checker on every request rather than caching at this layer', async () => {
    // The cache belongs to the checker, which knows its own window; a second one
    // here would make the page show a stale answer for reasons the checker
    // cannot see.
    const check = vi.fn(async () => ({ status: 'ready' as const, current: '0.2.1', latest: '0.2.1', newer: false }))
    const routes = createUpdateRoutes({ check, command: () => undefined })

    await routes.check()
    await routes.check()

    expect(check).toHaveBeenCalledTimes(2)
  })
})
