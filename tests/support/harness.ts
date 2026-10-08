/**
 * A throwaway dsh home for tests that must observe a real profile boot.
 *
 * The launcher composes a profile from `$DSH_HOME/profiles/<name>`; pointing
 * DSH_HOME at a temp directory is what lets a test mount this repository as a
 * bundle without touching the developer's own profiles. Nothing here starts a
 * profile — callers drive the real `dsh` launcher themselves so the system
 * under test is the shipped one, not a reimplementation of its composition.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

/** Repository root, resolved from this file's location under tests/support. */
export const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url))

/** The launcher shipped inside the DeepSeek Harness application bundle. */
export const DSH_LAUNCHER = '/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh'

/** The profile name every isolated home uses. */
export const PROFILE_NAME = 'channel-test'

export interface TestHarness {
  /** DSH_HOME for every launcher invocation in this test. */
  readonly home: string
  /** The profile directory under {@link home}. */
  readonly profileDir: string
  /** Remove the whole isolated home. */
  cleanup: () => void
}

/**
 * Run the real launcher against an isolated home.
 * @param harness - the isolated home to run against.
 * @param args - launcher arguments after the profile name.
 * @returns the finished process, with stdout/stderr captured as text.
 */
export function runDsh(harness: Pick<TestHarness, 'home'>, args: readonly string[], profile = PROFILE_NAME) {
  return spawnSync(DSH_LAUNCHER, [profile, ...args], {
    env: { ...process.env, DSH_HOME: harness.home },
    encoding: 'utf8',
    timeout: 180_000,
  })
}

/**
 * Create an isolated DSH_HOME with a profile initialized by the real launcher,
 * so the files are the ones a user gets rather than a hand-written
 * approximation that could drift from the shipped template.
 * @param template - shipped profile template to initialize from.
 * @returns the harness paths plus a cleanup callback.
 */
export function createTestHarness(template = 'web'): TestHarness {
  const home = mkdtempSync(join(tmpdir(), 'dsh-channel-wechat-'))
  const harness: TestHarness = {
    home,
    profileDir: join(home, 'profiles', PROFILE_NAME),
    cleanup: () => rmSync(home, { recursive: true, force: true }),
  }
  // The launcher initializes the profile itself; pre-creating the directory
  // makes `--from-default-profile` refuse to touch an existing profile.
  const init = runDsh(harness, ['--from-default-profile', template, '--dump-config'])
  if (init.error) throw init.error
  if (init.status !== 0 || !readFileExists(join(harness.profileDir, 'package.json'))) {
    throw new Error(`profile init failed: ${(init.stderr || init.stdout).slice(-2000)}`)
  }
  return harness
}

function readFileExists(path: string): boolean {
  try {
    readFileSync(path)
    return true
  } catch {
    return false
  }
}

/**
 * Link this repository into the profile as if it had been installed from npm.
 * @param harness - the isolated home to mutate.
 * @returns the package name the profile now resolves.
 */
export function linkRepoAsBundle(harness: TestHarness): string {
  const manifest = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')) as { name: string }
  const modules = join(harness.profileDir, 'node_modules')
  mkdirSync(modules, { recursive: true })
  symlinkSync(REPO_ROOT, join(modules, manifest.name), 'dir')
  return manifest.name
}

/**
 * Replace the profile's bundle list, preserving every other manifest field.
 * @param harness - the isolated home to mutate.
 * @param bundles - the ordered bundle list the profile should boot.
 */
export function setProfileBundles(harness: TestHarness, bundles: readonly string[]): void {
  const path = join(harness.profileDir, 'package.json')
  const manifest = JSON.parse(readFileSync(path, 'utf8')) as { dsh: { profile: { bundles: string[] } } }
  manifest.dsh.profile.bundles = [...bundles]
  writeFileSync(path, JSON.stringify(manifest, undefined, 2))
}
