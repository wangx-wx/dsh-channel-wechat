/**
 * The login panel as the plugin actually wires it.
 *
 * The unit suites prove each piece: the QR, the attempt, the routes, the
 * completion. What none of them cover is `index.ts` putting them together - and
 * the wiring is where this feature was wrong twice. `connection` is not available
 * when a plugin row activates, so routes registered at `apply` time were attached
 * to `undefined` and every request 404'd while the URL still printed. Then the
 * boot and the panel both started a poll loop over the same account.
 *
 * So this drives the real plugin rows over a real cordis context, with only the
 * wire (global `fetch`) and the agent runtime stubbed, and asserts the panel's
 * whole path: begin, poll, scan, confirm, store, start.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import CredentialsLocal from '@deepseek-ai/dsh-credentials-local'
import { provideCmdline } from '@deepseek-ai/dsh-cmdline'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { inject as channelInject } from '../../src/index.ts'
import { mountChannel } from '../support/config.ts'
import { loadAccount } from '../../src/credentials.ts'

/** One mounted profile, disposed after its test. */
const mounted: Context[] = []
const homes: string[] = []

afterEach(async () => {
  for (const ctx of mounted.splice(0)) await ctx.fiber.dispose()
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
  vi.unstubAllGlobals()
})

/** A temporary DSH_HOME, removed after the test pass or fail. */
function tempHome(prefix: string): string {
  const home = mkdtempSync(join(tmpdir(), prefix))
  homes.push(home)
  return home
}

/** A `ctx.connection` stub that keeps its routes reachable. */
function fakeConnection() {
  const routes = new Map<string, { methods: readonly string[]; fetch: (request: Request) => Promise<Response> }>()
  return {
    routes,
    service: {
      fetch: {
        register(route: { path: string; methods: readonly string[]; fetch: (request: Request) => Promise<Response> }) {
          routes.set(route.path, route)
          return () => { routes.delete(route.path) }
        },
      },
    },
  }
}

/**
 * The bot id a live login actually returned.
 *
 * It starts with a digit and contains `@` and `.`, so it is not a legal
 * credential key segment. Tests that used `bot-9` could not see the defect this
 * pins: the id went into the key verbatim, `credentialKey` threw, and the scan
 * stored nothing while the page reported success.
 */
const LIVE_ACCOUNT_ID = '6f773c2222a6@im.bot'

/** A wire that reports `wait`, then `scaned`, then `confirmed`. */
function stubWire() {
  let polls = 0
  const gets: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request) => {
    const href = String(url)
    gets.push(href)
    if (href.includes('get_bot_qrcode')) {
      return new Response(JSON.stringify({ qrcode: 'qr-1', qrcode_img_content: 'https://weixin.test/qr-1' }), { status: 200 })
    }
    if (href.includes('get_qrcode_status')) {
      polls += 1
      if (polls >= 3) {
        return new Response(JSON.stringify({
          status: 'confirmed',
          bot_token: 'tok-1',
          ilink_bot_id: LIVE_ACCOUNT_ID,
          baseurl: 'https://api.test',
        }), { status: 200 })
      }
      return new Response(JSON.stringify({ status: polls === 2 ? 'scaned' : 'wait' }), { status: 200 })
    }
    // The channel's own poll, once it starts.
    return new Response(JSON.stringify({ ret: 0, msgs: [], get_updates_buf: 'c1' }), { status: 200 })
  }) as unknown as typeof fetch)
  return { gets }
}

/** Poll until a condition holds, so a detached attempt can make progress. */
async function until(check: () => Promise<boolean> | boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await check()) return
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  throw new Error('condition never held')
}

/**
 * Mount the plugin's real rows over a browser-facing host.
 *
 * The connection service is provided *after* the rows mount, because that is the
 * order a real profile uses: the row that owns it waits on `webStartup`, so it
 * publishes later than this plugin activates. Providing it first - which is
 * easier - hides the defect that shipped, where the routes were registered
 * against an undefined service and every request 404'd.
 *
 * @returns the context, the host's registered routes, and how to reach one.
 */
async function bootWithPanel() {
  process.env['DSH_HOME'] = tempHome('dsh-wechat-panel-')
  stubWire()

  const ctx = new Context()
  mounted.push(ctx)
  const { routes, service } = fakeConnection()
  provideCmdline(ctx, { args: [], exit: () => {}, ready: { commit() {}, await: async () => {} } } as never)
  await ctx.plugin(CredentialsLocal as never, {} as never)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(CommandRuntime)

  // The row waits on the profile's model selection as well as the rest; a
  // mount without it never activates, so nothing below would observe anything.
  ctx.provide('agentDefaultModel', {
    currentSelection: () => ({ provider: 'deepseek-official', model: 'deepseek-v4.1-flash' }),
  })
  await mountChannel(ctx, [...channelInject], { cwd: '/work' })

  // The host's own rows publish here, after this plugin is already active.
  ctx.provide('connection', service)
  // The port the URL line is built from; `--port 0` means the real app binds one
  // the configuration never named, which is why it is read from the service.
  ctx.provide('webServer', { port: 19999, host: '127.0.0.1' })

  return { ctx, routes }
}

/** Call one registered route, failing loudly when it is absent. */
async function call(routes: Map<string, { fetch: (request: Request) => Promise<Response> }>, path: string, init?: RequestInit): Promise<Response> {
  const route = routes.get(path)
  if (route === undefined) throw new Error(`no route for ${path}; registered: ${[...routes.keys()].join(', ')}`)
  return route.fetch(new Request(`http://127.0.0.1:19999${path}`, init))
}

describe('the panel as the plugin wires it', () => {
  it('registers its routes on a host that provides a connection later', async () => {
    // The defect this replaces: `connection` is undefined during `apply`, so the
    // routes were attached to nothing and the whole panel answered 404 while its
    // URL printed as though it worked.
    const { routes } = await bootWithPanel()
    await until(() => routes.has('/api/channel-wechat/login'))

    expect(routes.has('/api/channel-wechat/login')).toBe(true)
    expect(routes.has('/api/channel-wechat/status')).toBe(true)
    expect(routes.has('/api/channel-wechat/qr.svg')).toBe(true)
  })

  it('walks a login from idle to a stored account', async () => {
    // The whole point of the panel, over the wiring the units do not cover: a
    // request begins an attempt, a later request reads the QR it produced, and
    // the confirmed credentials reach the store - all without a restart.
    const { ctx, routes } = await bootWithPanel()
    await until(() => routes.has('/api/channel-wechat/login'))

    expect(((await (await call(routes, '/api/channel-wechat/status')).json()) as { phase: string }).phase).toBe('idle')

    await call(routes, '/api/channel-wechat/begin', { method: 'POST' })
    await until(async () => {
      const body = (await (await call(routes, '/api/channel-wechat/status')).json()) as { phase: string }
      return body.phase === 'waiting'
    })

    // The QR endpoint answers only once a code exists, and the page fetches it
    // separately from the status document.
    const qr = await call(routes, '/api/channel-wechat/qr.svg')
    expect(qr.status).toBe(200)
    expect(qr.headers.get('content-type')).toContain('image/svg+xml')

    await until(async () => (await loadAccount(ctx, LIVE_ACCOUNT_ID)) !== undefined)
    const stored = await loadAccount(ctx, LIVE_ACCOUNT_ID)
    expect(stored?.botToken).toBe('tok-1')
    expect(stored?.baseUrl).toBe('https://api.test')
  })

  it('starts polling as the account the scan connected', async () => {
    // Storage alone would leave the page saying "已连接" while nothing was
    // delivered, which the user has no way to notice. Success here is the
    // channel's own poll appearing on the wire after the scan confirmed.
    const { routes } = await bootWithPanel()
    await until(() => routes.has('/api/channel-wechat/begin'))
    await call(routes, '/api/channel-wechat/begin', { method: 'POST' })

    const polled = (): boolean => {
      const calls = (globalThis.fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls
      return calls.some(entry => String(entry[0]).includes('getupdates'))
    }
    await until(polled)

    // The poll carries the token the scan produced, which is what proves it
    // started as the connected account rather than as whatever was there before.
    const calls = (globalThis.fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls
    const updateCall = calls.find(entry => String(entry[0]).includes('getupdates'))
    expect(String(updateCall?.[1] === undefined ? '' : JSON.stringify(updateCall[1]))).toContain('tok-1')
  })
})
