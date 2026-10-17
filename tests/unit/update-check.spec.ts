/**
 * Reading the newest published version of this package.
 *
 * The plugin page offers an update only when the registry names a newer version
 * than the one this process is running, so three things have to be right:
 *
 *  - the comparison is semver, not string equality (`0.10.0` > `0.9.0`, and
 *    `0.2.1` > `0.2.1-rc.1`, while a prerelease of the same pair sorts below);
 *  - a registry that cannot be read is reported as a failure rather than as
 *    "already up to date" - the two look identical on screen and only one is the
 *    user's situation;
 *  - the answer is read fresh on every call, because every call is a button
 *    press: a release the user just made is visible on the next press.
 */

import { describe, expect, it, vi } from 'vitest'
import { compareVersions, createUpdateChecker, isNewer } from '../../src/channel/update-check.ts'

describe('comparing two versions', () => {
  it('orders plain releases numerically, not as strings', () => {
    // A string comparison would call "0.10.0" older than "0.9.0", which is the
    // one mistake this whole feature exists to avoid.
    expect(compareVersions('0.10.0', '0.9.0')).toBeGreaterThan(0)
    expect(compareVersions('0.9.0', '0.10.0')).toBeLessThan(0)
    expect(compareVersions('0.2.1', '0.2.1')).toBe(0)
  })

  it('sorts a prerelease below the release it precedes', () => {
    // A published release is the newer one: `0.2.1` supersedes `0.2.1-rc.1`.
    expect(compareVersions('0.2.1', '0.2.1-rc.1')).toBeGreaterThan(0)
    expect(compareVersions('0.2.1-rc.2', '0.2.1-rc.1')).toBeGreaterThan(0)
    // And a release is never offered as an upgrade over a newer prerelease of
    // the NEXT version: 0.2.2-rc.1 is ahead of 0.2.1.
    expect(compareVersions('0.2.2-rc.1', '0.2.1')).toBeGreaterThan(0)
  })

  it('treats a missing or malformed version as not newer', () => {
    // The page must never announce an update it cannot justify.
    expect(isNewer(undefined, '0.2.1')).toBe(false)
    expect(isNewer('not-a-version', '0.2.1')).toBe(false)
    expect(isNewer('0.2.1', 'not-a-version')).toBe(false)
    expect(isNewer('0.2.1', '0.2.1')).toBe(false)
    expect(isNewer('0.2.2', '0.2.1')).toBe(true)
  })
})

describe('asking the registry', () => {
  it('returns the latest tag and whether it is newer than the running version', async () => {
    const asked: string[] = []
    const fetchImpl = async (input: string | URL | Request): Promise<Response> => {
      asked.push(String(input))
      return new Response(JSON.stringify({ 'dist-tags': { latest: '0.3.0' } }))
    }
    const check = createUpdateChecker({ currentVersion: '0.2.1', fetchImpl: fetchImpl as typeof fetch })

    await expect(check()).resolves.toEqual({ status: 'ready', current: '0.2.1', latest: '0.3.0', newer: true })

    // The one request a page open costs, and it asks for the `latest` tag rather
    // than the whole document: the full packument for a package with a long
    // history is megabytes this feature never reads.
    expect(asked).toHaveLength(1)
    expect(asked[0]).toContain('/-/package/dsh-channel-wechat/dist-tags')
  })

  it('reports an up-to-date package without inventing an update', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ latest: '0.2.1' })))
    const check = createUpdateChecker({ currentVersion: '0.2.1', fetchImpl: fetchImpl as unknown as typeof fetch })

    await expect(check()).resolves.toEqual({ status: 'ready', current: '0.2.1', latest: '0.2.1', newer: false })
  })

  it('reports a registry failure as a failure, never as up to date', async () => {
    // The failure mode this guards: a catch that returned `newer: false` would
    // tell every offline user their plugin is current, and nothing on screen
    // would distinguish that from the truth.
    const fetchImpl = vi.fn(async () => { throw new Error('offline') })
    const check = createUpdateChecker({ currentVersion: '0.2.1', fetchImpl: fetchImpl as unknown as typeof fetch })

    const result = await check()

    expect(result.status).toBe('failed')
    expect(result).not.toHaveProperty('newer')
  })

  it('treats a non-OK response and a malformed body as failures too', async () => {
    for (const response of [
      new Response('nope', { status: 500 }),
      new Response('not json'),
      new Response(JSON.stringify({})),
      new Response(JSON.stringify({ latest: 42 })),
    ]) {
      const check = createUpdateChecker({
        currentVersion: '0.2.1',
        fetchImpl: (async () => response) as unknown as typeof fetch,
      })
      await expect(check()).resolves.toMatchObject({ status: 'failed' })
    }
  })

  it('asks the registry on every call, because every call is a user pressing the button', async () => {
    // The page no longer checks when it opens; the only caller left is a person
    // who just pressed "check for updates". Serving that from a cache would
    // answer a different question than the one they asked - a release published
    // in the last five minutes would stay invisible until the window expired,
    // and nothing on screen would explain why.
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ latest: '0.3.0' })))
    const check = createUpdateChecker({ currentVersion: '0.2.1', fetchImpl: fetchImpl as unknown as typeof fetch })

    await check()
    await check()
    await check()

    expect(fetchImpl).toHaveBeenCalledTimes(3)
  })

  it('does not cache a failure, so a retry can succeed', async () => {
    // A cached failure would make every later open report the same error even
    // after the network came back, which looks like a broken page.
    let calls = 0
    const fetchImpl = vi.fn(async () => {
      calls += 1
      if (calls === 1) throw new Error('offline')
      return new Response(JSON.stringify({ latest: '0.3.0' }))
    })
    const check = createUpdateChecker({ currentVersion: '0.2.1', fetchImpl: fetchImpl as unknown as typeof fetch })

    expect((await check()).status).toBe('failed')
    await expect(check()).resolves.toMatchObject({ status: 'ready', latest: '0.3.0' })
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })
})
