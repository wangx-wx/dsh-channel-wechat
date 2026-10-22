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
import { spawn, spawnSync } from 'node:child_process'
import { REAL_DEPS, launcherCommand, resolveCheckout } from './launcher.ts'

/** Repository root, resolved from this file's location under tests/support. */
export const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url))

/**
 * The launcher the integration suites drive.
 *
 * Resolution lives in `launcher.ts` so its search order is unit-testable.
 * Importing this module resolves eagerly on purpose: an integration run without
 * a usable launcher should fail here, with the message that says how to provide
 * one, rather than part-way through a suite.
 */
export const DSH_CHECKOUT = resolveCheckout(process.env, REAL_DEPS)

/** The launcher command, as `[executable, ...leading arguments]`. */
export const DSH_COMMAND: readonly string[] = launcherCommand(DSH_CHECKOUT, REAL_DEPS)

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
  return spawnSync(DSH_COMMAND[0]!, [...DSH_COMMAND.slice(1), profile, ...args], {
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
 *
 * A directory symlink is the ordinary form and the cheapest: the profile then
 * reads this working tree directly, so a test sees the code under test rather
 * than a copy that could drift from it.
 *
 * **Windows without the right to create symlinks falls back to a junction.**
 * Creating a symlink there needs either Administrator or Developer Mode, and a
 * contributor running as an ordinary user has neither - `symlinkSync` then
 * throws EPERM and every suite that links the repository dies at setup. A
 * junction is the same directory redirect and needs no privilege; it cannot
 * point at a file or a network path, neither of which this needs.
 *
 * @param harness - the isolated home to mutate.
 * @returns the package name the profile now resolves.
 */
export function linkRepoAsBundle(harness: TestHarness): string {
  const manifest = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')) as { name: string }
  const modules = join(harness.profileDir, 'node_modules')
  mkdirSync(modules, { recursive: true })
  const target = join(modules, manifest.name)
  try {
    symlinkSync(REPO_ROOT, target, 'dir')
  } catch (error: unknown) {
    // Only the privilege failure is retried; any other reason to fail is a
    // real problem and retrying would hide it behind a different message.
    if (process.platform !== 'win32' || !hasCode(error, 'EPERM')) throw error
    symlinkSync(REPO_ROOT, target, 'junction')
  }
  return manifest.name
}

/**
 * Whether a caught value carries one error code.
 * @param error - the caught value.
 * @param code - the code to test for.
 * @returns true when the value is an Error with that code.
 */
function hasCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code
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

/** A booted web app, still running. */
export interface RunningProfile {
  /** The port the app actually bound; `--port 0` asks the OS for a free one. */
  readonly port: number
  /**
   * The launch token the app printed in its URL.
   *
   * The browser fence only accepts it on `GET /`, which is what exchanges it for
   * the signed cookie every `/api` and `/plugins` request needs. A test that
   * fetches those routes has to perform that exchange first, exactly as a browser
   * does, or it sees 401 and concludes the route is missing.
   */
  readonly token: string
  /** Kill the app and wait for it to exit. */
  readonly stop: () => Promise<void>
}

/**
 * Boot a profile's real web app and wait for it to serve.
 *
 * This is the only check that covers the whole boot: a plugin that rejects an
 * argument belonging to another app in the profile makes `program.error()` exit
 * the process before anything is published, which no in-process assertion can
 * observe because the failure is the boot itself.
 *
 * @param harness - the isolated home to run against.
 * @param args - app arguments after the profile name.
 * @returns the bound port and a stop callback.
 * @throws if the process exits before it serves, quoting its output.
 */
export async function startProfile(harness: Pick<TestHarness, 'home'>, args: readonly string[]): Promise<RunningProfile> {
  const child = spawn(DSH_COMMAND[0]!, [...DSH_COMMAND.slice(1), PROFILE_NAME, ...args], {
    env: { ...process.env, DSH_HOME: harness.home },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', chunk => { output += String(chunk) })
  child.stderr.on('data', chunk => { output += String(chunk) })

  let exited: { code: number | null } | undefined
  child.on('exit', code => { exited = { code } })

  const stop = async (): Promise<void> => {
    if (exited) return
    child.kill('SIGTERM')
    await new Promise<void>(resolve => {
      child.on('exit', () => resolve())
      setTimeout(() => { child.kill('SIGKILL'); resolve() }, 5_000).unref()
    })
  }

  const deadline = Date.now() + 120_000
  while (Date.now() < deadline) {
    // The line the web app prints once it is listening, which carries the port
    // it actually bound - `--port 0` makes the requested value useless - and the
    // launch token, which the browser exchanges for its session cookie.
    const match = /^dsh web: http:\/\/127\.0\.0\.1:(\d+)\/\?token=(\S+)$/mu.exec(output)
    if (match) return { port: Number(match[1]), token: match[2]!, stop }
    if (exited) throw new Error(`profile ${PROFILE_NAME} exited with ${String(exited.code)} before serving:\n${output.slice(-2000)}`)
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  await stop()
  throw new Error(`profile ${PROFILE_NAME} never reported a listening port:\n${output.slice(-2000)}`)
}

/**
 * Exchange the launch token for the browser session cookie, as a browser does.
 *
 * The fence accepts the token only on `GET /`; anything else - including
 * `/plugins` and `/api` - answers 401 without the signed cookie it writes. A
 * test that skipped this would read a 401 as "the route does not exist".
 *
 * @param profile - the running app to authenticate against.
 * @returns the `Cookie` header value to send on later requests.
 */
export async function authenticate(profile: Pick<RunningProfile, 'port' | 'token'>): Promise<string> {
  const url = `http://127.0.0.1:${String(profile.port)}/?token=${profile.token}`
  const response = await fetch(url, { redirect: 'manual' })
  // Redirected to the clean URL, which is what drops the token from history.
  if (response.status !== 303 && response.status !== 302) {
    throw new Error(`token exchange answered ${String(response.status)}, expected a redirect`)
  }
  const header = response.headers.get('set-cookie')
  if (header === null) throw new Error('token exchange set no cookie')
  return header.split(';')[0]!
}
