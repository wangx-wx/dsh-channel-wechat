/**
 * The login routes the panel talks to.
 *
 * These are plain functions from a request to a response, so the whole page and
 * its API are testable without a server, a socket, or a browser. What matters
 * here is the page's contract: what the QR endpoint answers before any login has
 * started, and that the status document is what the page draws from.
 *
 * The routes are mounted under `/api` by the composition row, which is what puts
 * them behind the harness's own process-token and browser-cookie fence. That is
 * asserted in the integration suite, not here.
 */

import { describe, expect, it, vi } from 'vitest'
import { createLoginRoutes } from '../../src/channel/login-routes.ts'
import type { LoginSnapshot } from '../../src/channel/login-session.ts'

/** A session stub that reports one fixed snapshot. */
function stubSession(snapshot: LoginSnapshot) {
  return {
    snapshot: () => snapshot,
    start: vi.fn(),
    submitVerifyCode: vi.fn(),
    stop: vi.fn(),
  }
}

describe('the login page', () => {
  it('is a self-contained HTML document', async () => {
    // The page is served to a browser with no build step and no client plugin,
    // so everything it needs has to be inside it. A `<script src>` pointing at a
    // bundle this plugin does not ship would 404 and leave a blank page, which is
    // why "self-contained" is asserted as the absence of external references
    // rather than by spotting a tag.
    const routes = createLoginRoutes({ session: stubSession({ phase: 'idle' }) })

    const response = await routes.page()
    const body = await response.text()

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/html')
    expect(body).toContain('<!doctype html>')
    // No `<script src=...>` and no `<link rel=stylesheet>`: every reference to
    // another resource would have to resolve, and none exists to resolve to.
    expect(body).not.toMatch(/<script[^>]+src=/iu)
    expect(body).not.toMatch(/<link[^>]+rel=["']?stylesheet/iu)
    // The instruction the user acts on is present in the page itself.
    expect(body).toContain('扫描二维码')
  })

  it('does not let the browser cache the page', async () => {
    // The page reflects whether a login is running. A cached copy would show a
    // stale QR, or hide one that is live.
    const routes = createLoginRoutes({ session: stubSession({ phase: 'idle' }) })

    expect((await routes.page()).headers.get('cache-control')).toContain('no-store')
  })
})

describe('the login status document', () => {
  it('reports the phase the page draws from', async () => {
    const routes = createLoginRoutes({ session: stubSession({ phase: 'scanned' }) })

    const response = await routes.status()
    const body = (await response.json()) as Record<string, unknown>

    expect(response.status).toBe(200)
    expect(body['phase']).toBe('scanned')
  })

  it('is never cached, because its whole purpose is to change', async () => {
    // The page polls this and redraws from the answer. A cached copy would pin
    // the page to whatever phase it first saw - a QR for a login that already
    // finished, or a "waiting" screen for one that failed.
    const routes = createLoginRoutes({ session: stubSession({ phase: 'scanned' }) })

    const response = await routes.status()

    expect(response.headers.get('cache-control')).toContain('no-store')
    expect(response.headers.get('content-type')).toContain('application/json')
  })

  it('omits the QR URL when there is none, rather than sending null', async () => {
    // The page decides whether to show an image by whether a URL is present.
    // Sending null would make `if (status.qrcodeUrl)` true and draw a broken
    // image with the literal string "null".
    const routes = createLoginRoutes({ session: stubSession({ phase: 'idle' }) })

    const body = (await (await routes.status()).json()) as Record<string, unknown>

    expect('qrcodeUrl' in body).toBe(false)
  })

  it('includes the QR URL when a code is pending', async () => {
    // The other half of that contract: omitting the field must be a decision
    // about absence, not a field that is never sent at all.
    const routes = createLoginRoutes({
      session: stubSession({ phase: 'waiting', qrcodeUrl: 'https://weixin.test/qr-1' }),
    })

    const body = (await (await routes.status()).json()) as Record<string, unknown>

    expect(body['qrcodeUrl']).toBe('https://weixin.test/qr-1')
  })
})

describe('the QR image', () => {
  it('answers 404 before a code exists instead of an empty image', async () => {
    // A login is only started by the page calling begin, so the image endpoint
    // is reachable first. An empty SVG would render as a blank box with no hint
    // that anything was wrong.
    const routes = createLoginRoutes({ session: stubSession({ phase: 'idle' }) })

    const response = await routes.qrImage()

    expect(response.status).toBe(404)
  })

  it('renders the pending URL as an SVG', async () => {
    const routes = createLoginRoutes({
      session: stubSession({ phase: 'waiting', qrcodeUrl: 'https://weixin.test/qr-1' }),
    })

    const response = await routes.qrImage()
    const body = await response.text()

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('image/svg+xml')
    expect(body).toContain('<svg')
  })
})

describe('starting and answering a login', () => {
  it('starts the attempt', async () => {
    const session = stubSession({ phase: 'idle' })
    const routes = createLoginRoutes({ session })

    const response = await routes.begin()

    expect(response.status).toBe(200)
    expect(session.start).toHaveBeenCalledOnce()
  })

  it('accepts a verify code the phone displayed', async () => {
    // The code arrives as form data, because the page posts it from a form: a
    // JSON body would need a content type the browser form does not send.
    const session = stubSession({ phase: 'need-verifycode' })
    const routes = createLoginRoutes({ session })

    const response = await routes.verifyCode(new Request('http://localhost/x', {
      method: 'POST',
      body: new URLSearchParams({ code: '1234' }),
    }))

    expect(response.status).toBe(200)
    expect(session.submitVerifyCode).toHaveBeenCalledWith('1234')
  })

  it('rejects an empty verify code without disturbing the attempt', async () => {
    // Submitting the form by accident must not send an empty code, which the
    // server counts as a wrong one and which spends the retry budget.
    const session = stubSession({ phase: 'need-verifycode' })
    const routes = createLoginRoutes({ session })

    const response = await routes.verifyCode(new Request('http://localhost/x', {
      method: 'POST',
      body: new URLSearchParams({ code: '   ' }),
    }))

    expect(response.status).toBe(400)
    expect(session.submitVerifyCode).not.toHaveBeenCalled()
  })
})
