/**
 * Mounting the channel the way a profile does.
 *
 * `cwd` and `cards` are volatile, so the channel reads them through `.get()`.
 * A test that mounts an inline plugin object with a bare literal
 * (`{ cwd: '/x' }`) bypasses the schema, so the plugin would receive a plain
 * string and its first `.get()` would throw - a failure about the test's mount
 * rather than about the behaviour under test.
 *
 * Attaching the exported `Config` is what makes an in-process mount match a real
 * profile: cordis resolves the schema and hands the plugin references. The cast
 * is needed because cordis types the argument as the *resolved* config, while a
 * profile - and therefore a test - supplies raw values for the schema to resolve.
 */

import type { Context } from '@deepseek-ai/cordis'
import { apply as applyChannel, Config } from '../../src/index.ts'

/** Raw profile values, as a test writes them in a patch file. */
export interface RawChannelConfig {
  cwd: string
  cards?: 'wechat' | 'both'
}

/**
 * Mount the channel with raw config values resolved through the real schema.
 *
 * @param ctx - the context to mount into.
 * @param inject - services this mount waits for; pass the subset the test's
 *   collaborators actually provide. Production's list is `channelInject`.
 * @param config - raw values, resolved by `Config` exactly as a profile does.
 * @returns the fiber, so a caller can await activation or dispose it.
 */
export function mountChannel(
  ctx: Context,
  inject: readonly string[],
  config: RawChannelConfig,
): ReturnType<Context['plugin']> {
  return ctx.plugin({ name: 'channel-wechat', inject, apply: applyChannel, Config }, config as never)
}
