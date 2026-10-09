/**
 * dsh-channel-wechat — a WeChat (iLink / ClawBot) channel for DeepSeek Harness.
 *
 * The bundle's rows live in cordis.patch.yml. The startup row parses this
 * invocation's app argument and publishes `wechatStartup`; this row acts on it.
 * An ordinary `dsh <profile>` has no action and is left alone, so the profile
 * starts as it would without this plugin.
 *
 * @module dsh-channel-wechat
 */

import type { Context } from '@deepseek-ai/cordis'
import { loadAccount, listAccounts, saveAccount, forgetAccount } from './credentials.ts'
import { runStartupAction } from './login-command.ts'
import { WECHAT_STARTUP_SERVICE, type WechatStartupValues } from './startup.ts'
import { createApiClient } from './wechat/api.ts'
import { CursorStore } from './channel/cursor-store.ts'
import { startChannelFromStore } from './channel/runtime.ts'

/** Plugin name reported in boot audits and `pending (waiting for service: …)` lines. */
export const name = 'channel-wechat'

/**
 * Host services this plugin needs. `wechatStartup` is the parsed invocation,
 * `credentials` is where a login is persisted, and `agents` is what the channel
 * creates its sessions through; the loader parks this row until all three exist.
 */
export const inject = ['wechatStartup', 'credentials', 'agents'] as const

/**
 * Act on the invocation the startup row parsed.
 * @param ctx - the plugin's cordis context.
 */
export function apply(ctx: Context): void {
  const startup = ctx.get(WECHAT_STARTUP_SERVICE) as WechatStartupValues | undefined
  if (startup === undefined) return

  // An ordinary start begins polling as whatever account the login action
  // stored; exiting here would kill the server the user asked for.
  if (startup.action === 'none') {
    // Detached: the launcher owns process lifetime, and awaiting this would
    // block the rest of boot on a loop that runs until shutdown.
    void startChannel(ctx).catch((error: unknown) => {
      ctx.logger(name).warn('channel failed to start: %s', String(error))
    })
    return
  }

  // Read through the global service store, not the property proxy: `appExit` is
  // an optional host value the launcher provides, never an injected dependency.
  const exit = ctx.get('appExit')
  if (exit === undefined) {
    throw new Error('channel-wechat: the launcher must provide ctx.appExit before the tree mounts')
  }

  const write = (text: string): void => { ctx.logger(name).info(text.trimEnd()) }
  const run = runStartupAction({
    startup,
    api: createApiClient(),
    write,
    exit,
    saveAccount: account => saveAccount(ctx, account),
    listAccounts: () => listAccounts(ctx),
    forgetAccount: accountId => forgetAccount(ctx, accountId),
    // The terminal is in front of the user during `login`, so the verify code
    // is read from stdin; the runner only asks when the server requires one.
    promptForVerifyCode: () => promptStdin('输入手机微信显示的数字，以继续连接：'),
  })

  // The launcher owns process lifetime and the work outlives this call, as the
  // shipped headless runner does; a rejection must surface rather than vanish.
  void run.catch((error: unknown) => {
    write(`连接失败：${error instanceof Error ? error.message : String(error)}`)
    exit(1)
  })
}

/**
 * Begin polling as the stored account, if there is one.
 * @param ctx - the plugin's cordis context.
 */
async function startChannel(ctx: Context): Promise<void> {
  const controller = new AbortController()
  // The plugin's own fiber owns the run: unloading disposes it, which is what
  // stops the poll instead of leaving it running against a dead context.
  ctx.effect(() => () => controller.abort())

  // One account in v1, so one cursor; the store is per-account for the
  // multi-account release the data structures already allow.
  const cursors = new CursorStore()
  const accounts = await listAccounts(ctx)
  const account = accounts[0]

  void startChannelFromStore({
    listAccounts: async () => (account === undefined ? [] : [account]),
    api: createApiClient(),
    createRegistry: () => ctx.agents as never,
    // Resolved before the run so a restart resumes where the last one stopped
    // rather than replaying the conversation it already answered.
    ...(account === undefined ? {} : { initialCursor: await cursors.load(account.accountId) }),
    saveCursor: cursor => account === undefined ? Promise.resolve() : cursors.save(account.accountId, cursor),
    onStarted: accountId => { ctx.logger(name).info('polling as %s', accountId) },
    onMessageError: (error, _message) => { ctx.logger(name).warn('inbound message failed: %s', String(error)) },
    onReplyError: (error, peerId) => { ctx.logger(name).warn('reply to %s failed: %s', peerId, String(error)) },
    signal: controller.signal,
  }).catch((error: unknown) => {
    ctx.logger(name).warn('channel stopped: %s', String(error))
  })
}

/**
 * Read one line from stdin.
 * @param prompt - text to show before reading.
 * @returns the trimmed line.
 */
async function promptStdin(prompt: string): Promise<string> {
  process.stdout.write(prompt)
  return new Promise((resolve) => {
    let input = ''
    const onData = (chunk: Buffer | string): void => {
      input += chunk.toString()
      if (!input.includes('\n')) return
      process.stdin.removeListener('data', onData)
      process.stdin.pause()
      resolve(input.trim())
    }
    process.stdin.resume()
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', onData)
  })
}
