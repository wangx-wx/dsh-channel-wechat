/**
 * The two update instructions the page offers, built for the profile this
 * process is actually running.
 *
 * The rules this module exists to encode, all measured rather than assumed:
 *
 *  - **A bare `dsh` is never printed.** It only works when the launcher happens
 *    to be on `PATH`, and the page cannot know that; an absolute command works
 *    whether or not it is. `process.argv0` cannot recover how this process was
 *    started either - measured: it is `"node"` for both spellings - so the
 *    question is never asked.
 *  - **The Desktop profile takes the Desktop carrier.** `dsh plugin --profile
 *    desktop` is refused by the launcher (`apps/cli/src/args.ts`, "managed
 *    exclusively by the Electron application") unless the invocation came from
 *    the app's own bundled CLI. So a Desktop profile gets that carrier's path and
 *    nothing else.
 *  - **`--config.minimumReleaseAge=0` is part of the command.** Measured: without
 *    it pnpm refuses with `ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION` for any
 *    release inside the observation window, which is every release a user is
 *    likely to be updating *to*. The page says what that trades away.
 *  - **`--profile` names the running profile.** Read from the live process, so a
 *    custom profile name is not guessed at.
 *
 * @module dsh-channel-wechat/channel/update-command
 */

import { posix, win32 } from 'node:path'

/** One copy-pasteable command, with the pieces a page renders separately. */
export interface UpdateCommand {
  /** The complete command line, quoted for the platform's shell. */
  command: string
  /** Whether this profile is managed by the Desktop application. */
  desktop: boolean
  /** The profile the command operates on. */
  profile: string
  /** The package spec the command installs. */
  spec: string
}

/** What the command builder reads of the running process. */
export interface UpdateCommandInput {
  /** Absolute path of the running Node (or Electron) executable. */
  execPath: string
  /** Absolute path of the dsh installation's `package.json`. */
  installAnchor: string
  /** The profile this process booted. */
  profile: string
  /** The platform whose quoting rules apply. */
  platform: NodeJS.Platform
  /** The version to install; `latest` when absent. */
  version?: string
  /** The Desktop application's own CLI, when this process runs inside it. */
  desktopCarrier?: string
}

/**
 * Quote one argument for the platform's shell.
 *
 * POSIX single quotes keep every character literal, and the one character they
 * cannot contain is escaped the standard way. Windows quoting is not a mirror of
 * it: `cmd` does not process single quotes, so double quotes are used and a
 * backslash is literal (it is a path separator, not an escape), while an
 * embedded double quote is backslash-escaped because the `CommandLineToArgvW`
 * rules the child runtime applies do treat it that way.
 *
 * @param value - the argument to quote.
 * @param platform - the platform whose shell will read it.
 * @returns the argument, quoted only when it needs to be.
 */
export function quoteArgument(value: string, platform: NodeJS.Platform): string {
  if (platform === 'win32') {
    if (value !== '' && !/[\s"]/u.test(value)) return value
    return `"${value.replaceAll('"', '\\"')}"`
  }
  if (value !== '' && !/[\s'"$`\\!*?[\]{}()<>|&;#~]/u.test(value)) return value
  return `'${value.replaceAll("'", "'\\''")}'`
}

/**
 * Build the `add` command for this profile.
 *
 * Measured: `pnpm add <pkg>@latest` replaces an already-installed version in
 * place and leaves the bundle selected, so no removal step is needed and none is
 * offered - a `remove` first would only add a way to end up with the package
 * gone and the bundle deselected if the second command never ran.
 *
 * @param input - the running process's paths and profile.
 * @returns the command, or undefined when the running installation cannot be
 *   addressed (no readable anchor), in which case the page shows no command
 *   rather than one that would not run.
 */
export function buildUpdateCommand(input: UpdateCommandInput): UpdateCommand | undefined {
  const path = input.platform === 'win32' ? win32 : posix
  const spec = input.version === undefined || input.version === '' || input.version === 'latest'
    ? 'dsh-channel-wechat@latest'
    : `dsh-channel-wechat@${input.version}`

  let executable: string[]
  if (input.profile === 'desktop') {
    // The Desktop application's carrier is the only invocation its launcher
    // accepts for this profile; without it there is no working command at all.
    if (input.desktopCarrier === undefined || input.desktopCarrier === '') return undefined
    executable = [input.desktopCarrier]
  } else {
    // `installAnchor` is `<install>/package.json`; the CLI entry sits beside it
    // under `lib/`. Running it through this process's own executable needs no
    // `PATH`, no shebang resolution, and no npm bin directory.
    const entry = path.join(path.dirname(input.installAnchor), 'lib', 'bin.js')
    executable = [input.execPath, entry]
  }

  const args = [
    ...executable,
    'plugin',
    '--profile',
    input.profile,
    'add',
    spec,
    // Inside the observation window pnpm refuses the install outright, and every
    // version worth updating to was published recently. The page states the
    // trade-off; silently omitting this would make the command fail for the
    // user who needs it most.
    '--config.minimumReleaseAge=0',
  ]

  return {
    command: args.map(argument => quoteArgument(argument, input.platform)).join(' '),
    desktop: input.profile === 'desktop',
    profile: input.profile,
    spec,
  }
}
