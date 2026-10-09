/**
 * The bundle's patch layer is what turns an installed package into mounted
 * rows. A patch file that parses but matches nothing is skipped with only a
 * warning, so a typo'd `insert` anchor or a wrong package name produces a
 * profile that boots cleanly with no channel in it. This drives the real
 * launcher's composition to pin the row's identity.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createTestHarness, linkRepoAsBundle, runDsh, setProfileBundles, type TestHarness } from '../support/harness.ts'

describe('bundle patch layer', () => {
  let harness: TestHarness
  let packageName: string

  beforeAll(() => {
    harness = createTestHarness()
    packageName = linkRepoAsBundle(harness)
    setProfileBundles(harness, ['@deepseek-ai/dsh-base', packageName])
  })

  afterAll(() => harness?.cleanup())

  it('composes both of our rows into the profile tree', () => {
    const result = runDsh(harness, ['--dump-config'])
    expect(result.status, result.stderr.slice(-2000)).toBe(0)

    // Assert the exact (id, name) pairs rather than substrings: a package name
    // like dsh-channel-wechat-TYPO contains the correct one, so a substring
    // check cannot disagree with a broken patch.
    const rows = parseRows(result.stdout)
    expect(rows).toContainEqual({ id: 'channel-wechat', name: packageName })
    // The startup row is what makes `login` reach us at all; its absence would
    // leave the app argument silently unclaimed.
    expect(rows).toContainEqual({ id: 'channel-wechat-startup', name: `${packageName}/startup` })
  })

  it('resolves the startup subpath the row names', async () => {
    // The composition only proves the row text; the loader still has to
    // resolve `dsh-channel-wechat/startup` to a real module. A subpath export
    // the build never emitted fails here rather than in a user's profile.
    const startup = await import('dsh-channel-wechat/startup')

    expect(typeof startup.apply).toBe('function')
    expect(startup.WECHAT_STARTUP_SERVICE).toBe('wechatStartup')
    expect(startup.inject).toEqual(['cmdlineArgs'])
  })

  it('does not merely warn the layer away', () => {
    // A patch that matches no row is reported on stderr while the boot still
    // succeeds, which is exactly the silent failure mode this guards.
    const result = runDsh(harness, ['--dump-config'])
    expect(result.stderr).not.toMatch(/patch.*(did not match|no such|skipped)/iu)
  })
})

/** Extract every `- id: <x>` / `name: <y>` pair the dump prints. */
function parseRows(dump: string): { id: string; name: string }[] {
  const rows: { id: string; name: string }[] = []
  const lines = dump.split('\n')
  for (let index = 0; index < lines.length; index += 1) {
    const idMatch = /^- id: (\S+)$/u.exec(lines[index] ?? '')
    if (!idMatch) continue
    const nameMatch = /^ {2}name: (.+)$/u.exec(lines[index + 1] ?? '')
    if (!nameMatch) continue
    rows.push({ id: idMatch[1]!, name: (nameMatch[1] ?? '').replace(/^'|'$/gu, '') })
  }
  return rows
}
