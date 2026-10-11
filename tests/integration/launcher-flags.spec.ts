/**
 * The launcher does not decide who owns the command line: the flags before the
 * first unrecognised token are the launcher's, and everything after is handed
 * to *every* app in the profile unchanged.
 *
 * That makes an unowned argument a boot hazard rather than a cosmetic one. A
 * plugin that parses strictly and calls `program.error()` exits the process
 * while the profile is still composing, so the failure is not "this plugin did
 * nothing" but "the application did not start".
 *
 * This is exactly what shipped: the desktop host boots its profile with
 * `--no-open --port 19387`, which the web app owns, and this plugin's commander
 * program rejected `--no-open`. The host died with `DesktopHostFatalError:
 * cannot create effect on inactive context` - a message that names neither this
 * plugin nor a flag, because by then the boot had already collapsed.
 *
 * So the assertion has to be the boot itself. Nothing in-process can observe
 * it: `exit` is a request the launcher honours later, and the real failure is
 * the absence of a listening server.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createTestHarness, linkRepoAsBundle, setProfileBundles, startProfile, type TestHarness } from '../support/harness.ts'

/** The arguments the desktop host hardcodes when it boots its profile. */
const DESKTOP_ARGS = ['--no-open', '--port', '0'] as const

describe('booting the real web app with another app\u2019s flags', () => {
  let harness: TestHarness

  beforeAll(() => {
    harness = createTestHarness()
    const packageName = linkRepoAsBundle(harness)
    setProfileBundles(harness, ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', packageName])
  })

  afterAll(() => harness?.cleanup())

  it('serves instead of exiting when handed flags it does not own', async () => {
    // `--port 0` rather than a literal: the test must not collide with a real
    // dev server, and the app prints the port it bound.
    const running = await startProfile(harness, DESKTOP_ARGS)
    try {
      // A live HTTP listener is the evidence that boot completed. A 401 is the
      // expected answer - the app is authenticated - so anything but a refused
      // connection proves the server is up.
      const response = await fetch(`http://127.0.0.1:${String(running.port)}/`)
      expect(response.status).toBe(401)
    } finally {
      await running.stop()
    }
  }, 180_000)
})

describe('the app argument on a profile that mounts the web app', () => {
  let harness: TestHarness

  beforeAll(() => {
    harness = createTestHarness()
    const packageName = linkRepoAsBundle(harness)
    setProfileBundles(harness, ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', packageName])
  })

  afterAll(() => harness?.cleanup())

  it('is rejected by the web app, so this plugin never sees it', async () => {
    // A characterisation of a hard constraint, not a desired outcome - it is
    // recorded because it invalidates this plugin's CLI login design.
    //
    // Every app in a profile parses the same argument list, and each one
    // rejects what it does not declare: `dsh-web-app`'s program declares flags
    // only, no positional. So `dsh <profile> login` dies in the *web app* -
    // whose row is composed long before this plugin's - and `parseCmdline`
    // turns that grammar rejection into `exit(1)`. The command never reaches
    // this plugin, on any profile that mounts the web app.
    //
    // The message is commander's generic one rather than ours, which is the
    // evidence that this plugin is not the one refusing.
    await expect(startProfile(harness, ['login'])).rejects.toThrow(/too many arguments.*login/u)
  }, 180_000)
})
