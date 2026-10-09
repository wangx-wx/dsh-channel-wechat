/**
 * The command-line entry for this channel.
 *
 * `dsh <profile> login` reaches the profile as an app argument. An argument no
 * plugin claims is ignored silently — the profile boots normally and nothing
 * happens — so this module exists to claim it, and the rows that act on it read
 * the value published here.
 *
 * Following the launcher's contract, the command's action validates before it
 * publishes: `program.error()` writes its message and requests a process exit,
 * so anything published first would be a lie about a rejected invocation.
 *
 * @module dsh-channel-wechat/startup
 */

import { Command } from 'commander'
import type { Context } from '@deepseek-ai/cordis'
import { parseCmdline } from '@deepseek-ai/dsh-cmdline'

/** Stable Cordis plugin name. */
export const name = 'channel-wechat-startup'

/** The launcher must have supplied the command line before this can run. */
export const inject = ['cmdlineArgs']

/** Service published here and injected by the rows that act on it. */
export const WECHAT_STARTUP_SERVICE = 'wechatStartup'

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
    .addHelpText('after', `
Examples:
  dsh web login      scan a QR code to connect WeChat
  dsh web status     show the stored login, if any
  dsh web            start normally, without touching WeChat
`)
}

/**
 * Parse and publish this invocation's request as an ordinary Cordis service.
 * @param ctx - plugin context carrying the command line.
 */
export function apply(ctx: Context): void {
  const program = wechatCommand()
  program.action(() => {
    const action = program.args[0]
    const json = program.opts<{ json?: boolean }>().json === true

    // Validation precedes publication: `program.error` requests a process exit,
    // and a service published before it would describe an invocation that was
    // actually rejected.
    if (action !== undefined && !(ACTIONS as readonly string[]).includes(action)) {
      program.error(`error: unknown action ${JSON.stringify(action)}`)
    }
    ctx.provide(WECHAT_STARTUP_SERVICE, {
      action: (action ?? 'none') as WechatStartupValues['action'],
      ...(json ? { json } : {}),
    } satisfies WechatStartupValues)
  })
  parseCmdline(ctx, program)
}
