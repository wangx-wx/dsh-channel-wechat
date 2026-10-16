/**
 * The bundle's patch layer is what turns an installed package into mounted
 * rows. A patch file that parses but matches nothing is skipped with only a
 * warning, so a typo'd `insert` anchor or a wrong package name produces a
 * profile that boots cleanly with no channel in it. This drives the real
 * launcher's composition to pin the row's identity.
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createTestHarness, linkRepoAsBundle, REPO_ROOT, runDsh, setProfileBundles, type TestHarness } from '../support/harness.ts'

describe('bundle patch layer', () => {
  let harness: TestHarness
  let packageName: string

  beforeAll(() => {
    harness = createTestHarness()
    packageName = linkRepoAsBundle(harness)
    setProfileBundles(harness, ['@deepseek-ai/dsh-base', packageName])
  })

  afterAll(() => harness?.cleanup())

  it('composes exactly one row for this plugin', () => {
    const result = runDsh(harness, ['--dump-config'])
    expect(result.status, result.stderr.slice(-2000)).toBe(0)

    // Assert the exact (id, name) pair rather than substrings: a package name
    // like dsh-channel-wechat-TYPO contains the correct one, so a substring
    // check cannot disagree with a broken patch.
    const rows = parseRows(result.stdout)
    expect(rows).toContainEqual({ id: 'channel-wechat', name: packageName })
    // Exactly one row, which is the user-visible half of folding the startup
    // row in: two rows showed up as two plugin cards in the GUI. Named
    // explicitly so a re-introduced second row fails here with its name in the
    // message rather than as an anonymous count mismatch.
    expect(rows.filter(row => row.name.startsWith(packageName))).toEqual([
      { id: 'channel-wechat', name: packageName },
    ])
  })

  it('ships a client half the profile can serve', async () => {
    // The browser half is what puts the login button in the GUI. A manifest that
    // declares `dsh.client` but exports no `./client` fails the whole client
    // activation loudly in a user's profile, so the two are pinned to each other
    // here rather than to a remembered filename.
    const manifest = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')) as {
      exports?: Record<string, unknown>
      dsh?: { client?: { platform?: string } }
    }
    expect(manifest.dsh?.client?.platform).toBe('web')

    const client = await import(`${packageName}/client`).catch(() => undefined)
    // The bundle runs in a browser and registers itself on a global the Node
    // loader does not have; importing it here is impossible. What this asserts
    // is that the export resolves at all and that the file it names exists,
    // which is the half a build can silently drop.
    expect(manifest.exports?.['./client']).toBeTypeOf('string')
    expect(existsSync(join(REPO_ROOT, String(manifest.exports?.['./client'])))).toBe(true)
    void client
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
