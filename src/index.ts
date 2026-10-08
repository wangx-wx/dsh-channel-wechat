/**
 * dsh-channel-wechat — a WeChat (iLink / ClawBot) channel for DeepSeek Harness.
 *
 * The bundle's rows live in cordis.patch.yml; this module is the Host half the
 * rows activate. M0 carries no behaviour yet: it exists so the profile loader
 * has a real module to import, which is what proves the export form
 * (function plugin with `name`/`apply`) is the one dsh mounts.
 *
 * @module dsh-channel-wechat
 */

import type { Context } from '@deepseek-ai/cordis'

/** Plugin name reported in boot audits and `pending (waiting for service: …)` lines. */
export const name = 'channel-wechat'

/** Host services this plugin needs mounted before it activates; M0 needs none. */
export const inject = [] as const

/**
 * Activate the channel on the profile's context.
 * @param ctx - the plugin's cordis context.
 */
export function apply(ctx: Context): void {
  // ctx.logger is the named-logger service: calling it returns a logger bound
  // to this plugin, which is what keeps boot output attributable.
  ctx.logger(name).info('dsh-channel-wechat loaded')
}
