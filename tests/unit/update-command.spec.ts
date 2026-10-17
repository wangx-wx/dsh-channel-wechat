/**
 * The update instruction the page shows, and the one decision that makes it
 * safe to show at all.
 *
 * Measured facts behind these tests, each of which failed once in the field:
 *
 *  - a bare `dsh` in the command only works when the launcher is on `PATH`, and
 *    `process.argv0` cannot report whether it was (it is `"node"` for both a
 *    bare-name and an absolute-path start), so the command is always absolute;
 *  - `dsh plugin --profile desktop` is refused unless the invocation is the
 *    Desktop application's own carrier;
 *  - pnpm refuses a release inside its observation window unless
 *    `--config.minimumReleaseAge=0` is passed.
 */

import { describe, expect, it } from 'vitest'
import { buildUpdateCommand, quoteArgument } from '../../src/channel/update-command.ts'

const MAC = {
  execPath: '/Users/w/.nvm/versions/node/v24.16.0/bin/node',
  installAnchor: '/opt/dsh/node_modules/@deepseek-ai/dsh/package.json',
  profile: 'web',
  platform: 'darwin' as NodeJS.Platform,
}

describe('quoting one argument', () => {
  it('leaves a plain argument alone on POSIX', () => {
    expect(quoteArgument('plugin', 'darwin')).toBe('plugin')
  })

  it('quotes a POSIX path containing a space', () => {
    // The path a macOS install with a space in its name produces, and the one
    // case where an unquoted command silently runs two commands instead of one.
    expect(quoteArgument('/Applications/Some App/bin/node', 'darwin')).toBe("'/Applications/Some App/bin/node'")
  })

  it('escapes a single quote the POSIX way', () => {
    expect(quoteArgument("/tmp/it's here", 'darwin')).toBe("'/tmp/it'\\''s here'")
  })

  it('quotes with double quotes on Windows and keeps backslashes literal', () => {
    // `cmd` does not process single quotes, and a backslash is a path separator
    // rather than an escape - so a Windows path must NOT be POSIX-escaped.
    expect(quoteArgument('C:\\Users\\w\\bin\\node.exe', 'win32')).toBe('C:\\Users\\w\\bin\\node.exe')
    expect(quoteArgument('C:\\Program Files\\node.exe', 'win32')).toBe('"C:\\Program Files\\node.exe"')
  })

  it('escapes an embedded double quote on Windows only', () => {
    expect(quoteArgument('C:\\a"b', 'win32')).toBe('"C:\\a\\"b"')
  })
})

describe('building the update command', () => {
  it('never prints a bare dsh, and runs the CLI entry through this process', () => {
    const built = buildUpdateCommand(MAC)!

    // The whole point: no `PATH` lookup anywhere in the command. Neither path
    // here needs quoting, so both appear bare - quoting is for spaces, not a
    // decoration applied to every argument.
    expect(built.command.startsWith('/Users/w/.nvm/versions/node/v24.16.0/bin/node ')).toBe(true)
    expect(built.command).toContain('/opt/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js')
    expect(built.command).not.toMatch(/(^|\s)dsh(\s|$)/u)
  })

  it('names the running profile rather than assuming web', () => {
    // A custom profile is the normal case for anyone who is not on a shipped
    // template, and a wrong `--profile` edits a different profile than the one
    // the page belongs to.
    const built = buildUpdateCommand({ ...MAC, profile: 'channel-test' })!
    expect(built.command).toContain('--profile channel-test')
    expect(built.profile).toBe('channel-test')
  })

  it('carries the minimumReleaseAge override that makes the install work', () => {
    // Measured: without it pnpm answers ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION
    // for any recent release, which is exactly what an update targets.
    expect(buildUpdateCommand(MAC)!.command).toContain('--config.minimumReleaseAge=0')
  })

  it('installs latest by default and a named version when asked', () => {
    expect(buildUpdateCommand(MAC)!.spec).toBe('dsh-channel-wechat@latest')
    expect(buildUpdateCommand({ ...MAC, version: '0.2.2' })!.spec).toBe('dsh-channel-wechat@0.2.2')
  })

  it('uses the Desktop carrier for the Desktop profile and refuses without it', () => {
    // The launcher rejects `plugin --profile desktop` from any other entry, so a
    // command built from `execPath` would be one the user cannot run.
    const carrier = '/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh'
    const built = buildUpdateCommand({ ...MAC, profile: 'desktop', desktopCarrier: carrier })!

    expect(built.desktop).toBe(true)
    expect(built.command.startsWith(`'${carrier}'`)).toBe(true)
    expect(built.command).not.toContain('lib/bin.js')

    // No carrier means no honest command: the page shows none rather than a
    // command that the launcher would refuse.
    expect(buildUpdateCommand({ ...MAC, profile: 'desktop' })).toBeUndefined()
  })

  it('builds a Windows command with the platform separator', () => {
    const built = buildUpdateCommand({
      execPath: 'C:\\Program Files\\nodejs\\node.exe',
      installAnchor: 'C:\\dsh\\node_modules\\@deepseek-ai\\dsh\\package.json',
      profile: 'web',
      platform: 'win32',
    })!

    // `win32` joining, not POSIX: a mixed command is one cmd cannot run.
    expect(built.command).toContain('"C:\\Program Files\\nodejs\\node.exe"')
    expect(built.command).toContain('C:\\dsh\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js')
    expect(built.command).not.toContain('/')
  })
})
