/**
 * Claiming this channel's app argument from the shared command line.
 *
 * `dsh <profile> login` reaches the profile as an app argument. An argument no
 * plugin claims is ignored silently — the profile boots normally and nothing
 * happens — so this module exists to claim it, and the channel reads the value
 * this returns.
 *
 * This used to be a separate Loader row (`dsh-channel-wechat/startup`) because
 * only a row that declares `inject` is handed the launcher's command line. It
 * is folded into the main row now: `cmdlineArgs` is provided by every launcher
 * before the tree mounts, so declaring it cannot park the row, and the profile
 * shows one plugin instead of two.
 *
 * Only a known action word is claimed, and nothing is ever rejected. Every app
 * in a profile receives the same argument list, so arguments belonging to
 * another app arrive here too; calling `program.error()` on one of those would
 * request a process exit and abort the whole boot. That is not hypothetical —
 * the desktop host's `--no-open --port 19387` crashed it.
 *
 * @module dsh-channel-wechat/cmdline
 */

import { Command } from 'commander'
import type { Context } from '@deepseek-ai/cordis'
import { parseCmdline } from '@deepseek-ai/dsh-cmdline'

/** What this invocation asked for. */
export interface WechatStartupValues {
  /** The app argument, or `none` for an ordinary start. */
  action: 'login' | 'logout' | 'status' | 'none'
  /** Whether output should be machine-readable. */
  json?: boolean
}

/** The actions this app argument accepts. */
const ACTIONS = ['login', 'logout', 'status'] as const

/**
 * This app's command: one optional positional action, plus `--json`.
 * @returns a fresh program, so a process can parse more than once.
 */
function wechatCommand(): Command {
  return new Command()
    .name('dsh <profile>')
    .description('Connect WeChat to DeepSeek Harness.')
    .helpOption('-h, --help', 'show this help')
    .argument('[action]', 'login | logout | status; omit to start normally')
    .option('--json', 'machine-readable output')
    // The launcher does not decide who owns the command line, so other apps in
    // the same profile receive the same arguments. Rejecting theirs would abort
    // the boot before this plugin published anything, failing the whole app -
    // which is what the desktop host's `--no-open --port 19387` did.
    .allowUnknownOption()
    .allowExcessArguments()
    .addHelpText('after', `
Examples:
  dsh web login      scan a QR code to connect WeChat
  dsh web status     show the stored login, if any
  dsh web            start normally, without touching WeChat
`)
}

/**
 * Parse and claim this invocation's request.
 *
 * Reads through `ctx.get('cmdlineArgs')` rather than a property, because the
 * value is what the launcher provided and `parseCmdline` owns requesting the
 * exit on help or a rejected invocation.
 *
 * @param ctx - the channel's cordis context, which must carry `cmdlineArgs`.
 * @returns the claimed action, `{ action: 'none' }` for an ordinary start, or
 *   `undefined` when commander handled the invocation itself (`--help`,
 *   `--version`) and asked the launcher to exit. The caller must not start the
 *   channel in that last case: the old two-row split got this for free, because
 *   a startup row that never ran published no service for the main row to read.
 */
export function claimAppArgument(ctx: Context): WechatStartupValues | undefined {
  // Set only by the action, which commander runs on a successful parse alone.
  let startup: WechatStartupValues | undefined
  const program = wechatCommand()
  program.action(() => {
    // The command line is shared: every app in the profile receives the same
    // arguments and consumes its own. The desktop host boots this profile with
    // `--no-open --port 19387`, which the web app owns - and a bare `19387` is
    // indistinguishable from an action by shape.
    //
    // So only a known action word is claimed. Anything else means "ordinary
    // start" rather than an error: reporting an error here would fire on
    // another app's flag *value*, and `program.error` exits the boot before any
    // service is published, which fails the whole application rather than this
    // plugin. A mistyped action starts the server instead of being reported,
    // which is the lesser cost.
    const action = program.args.find(argument => (ACTIONS as readonly string[]).includes(argument))
    const json = program.opts<{ json?: boolean }>().json === true
    startup = {
      action: (action ?? 'none') as WechatStartupValues['action'],
      ...(json ? { json } : {}),
    }
  })
  parseCmdline(ctx, program)
  return startup
}