/**
 * The browser half, observed on a real profile.
 *
 * The repo's recurring defect is a unit test that injects its own collaborator,
 * so no test ever observes whether `apply` wired it up. The browser half has a
 * sharper version of that trap: `dsh.client` is discovered by scanning Loader
 * rows for a manifest field, and every way of getting it wrong is **silent** -
 * a misspelled `platform`, a `./client` export the build never emitted, an id
 * that does not match the package name. The plugin host starts normally, the
 * channel works, and the login button simply is not there.
 *
 * So this boots the shipped launcher and asks it the way a browser does: the
 * package has to appear in the served boot graph, and the URL that graph names
 * has to return the bundle.
 */

import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  authenticate, createTestHarness, linkRepoAsBundle, REPO_ROOT,
  setProfileBundles, startProfile, type RunningProfile, type TestHarness,
} from '../support/harness.ts'

/** The package name the profile resolves, read from our own manifest. */
const PACKAGE_NAME = (JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')) as { name: string }).name

describe('the browser half on a real profile', () => {
  let harness: TestHarness
  let profile: RunningProfile
  /** The session cookie the fence issues, sent on every later request. */
  let cookie: string

  beforeAll(async () => {
    harness = createTestHarness()
    const packageName = linkRepoAsBundle(harness)
    setProfileBundles(harness, ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', packageName])
    // `--port 0` asks the OS for a free port, so the suite cannot collide with a
    // developer's running app; `--no-open` keeps it from launching a browser.
    profile = await startProfile(harness, ['--no-open', '--port', '0'])
    cookie = await authenticate(profile)
  }, 180_000)

  afterAll(async () => {
    await profile?.stop()
    harness?.cleanup()
  })

  it('appears in the served boot graph under its package name', async () => {
    // This is the discovery step. A missing `dsh.client` or a `platform` that is
    // not `web` leaves the package out of the graph with no error anywhere - the
    // failure this suite exists for.
    const html = await (await fetch(pageUrl(profile), { headers: { cookie } })).text()

    expect(html).toContain(PACKAGE_NAME)
    // The graph entry is keyed by the package name, which the browser uses to
    // match the factory the bundle registers. A bundle whose id drifts serves
    // fine and then fails to register, so the id is asserted too.
    expect(html).toContain(`"id":"${PACKAGE_NAME}"`)
  })

  it('serves the bundle its graph entry names', async () => {
    // The other half: the graph can name a URL whose bytes do not exist, which is
    // what a `files[]` or `exports` mistake produces. Fetching it the way the
    // browser does is the only check that covers the two together.
    const html = await (await fetch(pageUrl(profile), { headers: { cookie } })).text()
    const entry = new RegExp(`"id":"${PACKAGE_NAME}","url":"([^"]+)"`, 'u').exec(html)
    expect(entry, `no boot-graph entry for ${PACKAGE_NAME}`).not.toBeNull()

    // The URL in the graph is document-relative and JSON-escaped.
    const url = entry![1]!.replaceAll('&amp;', '&').replace(/^\/?/u, '')
    const response = await fetch(`http://127.0.0.1:${String(profile.port)}/${url}`, { headers: { cookie } })
    expect(response.status).toBe(200)

    const body = await response.text()
    // The loader's lazy-CJS contract: the bundle registers the package name and
    // returns the plugin object. A file that is merely copied is not enough.
    expect(body).toContain('__ModuleLoader__.load')
    expect(body).toContain(`id: '${PACKAGE_NAME}'`)
    expect(body).toContain('apply')
  })
})

/** The app's own page, which carries the boot graph. */
function pageUrl(profile: Pick<RunningProfile, 'port'>): string {
  return `http://127.0.0.1:${String(profile.port)}/`
}
