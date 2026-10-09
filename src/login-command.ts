/**
 * What a command-line action does once the startup provider has parsed it.
 *
 * Kept separate from the command-line parsing and free of any Cordis context:
 * the action's job is a sequence of side effects (print, store, exit), and
 * taking them as inputs is what lets this run in a test without a loader tree,
 * a terminal, or a mounted credentials provider.
 *
 * @module dsh-channel-wechat/login-command
 */

import type { WechatAccount } from './credentials.ts'
import type { WechatStartupValues } from './startup.ts'
import type { ApiTransport } from './wechat/api.ts'
import { runQrLogin } from './wechat/login-runner.ts'

/** Everything one action run needs from its caller. */
export interface StartupActionOptions {
  /** What the invocation asked for. */
  startup: WechatStartupValues
  /** Wire client for the login. */
  api: ApiTransport
  /** Sink for user-facing text. */
  write: (text: string) => void
  /** Request a bounded process exit. */
  exit: (code: number) => void
  /** Persist one login. */
  saveAccount: (account: WechatAccount) => Promise<void>
  /** Enumerate stored logins. */
  listAccounts: () => Promise<WechatAccount[]>
  /** Remove one stored login; only the logout action uses it. */
  forgetAccount?: (accountId: string) => Promise<void>
  /** Monotonic milliseconds; defaults to `Date.now`. */
  now?: () => number
  /** Pause between polls; defaults to a real timer. */
  sleep?: (ms: number) => Promise<void>
  /** How long the login may run. */
  timeoutMs?: number
  /** Ask for the verify code when the server requires one. */
  promptForVerifyCode?: (retry: boolean) => Promise<string>
}

/**
 * Perform the invocation's action.
 * @param options - the action and its collaborators.
 * @returns when the action has finished and its exit has been requested.
 */
export async function runStartupAction(options: StartupActionOptions): Promise<void> {
  switch (options.startup.action) {
    case 'login':
      return runLogin(options)
    case 'logout':
      return runLogout(options)
    case 'status':
      return runStatus(options)
    case 'none':
      // An ordinary `dsh <profile>` starts the server: it must not exit here.
      return
  }
}

/** Connect a new account by scanning a QR code. */
async function runLogin(options: StartupActionOptions): Promise<void> {
  const result = await runQrLogin({
    api: options.api,
    // The url is printed as soon as the code exists: a code the user cannot
    // see is not a login they can complete.
    onQrCode: qr => options.write(`用手机微信扫描以下二维码，以继续连接：\n${qr.qrcodeUrl}\n`),
    onEffect: effect => {
      if (effect.kind === 'announce-scanned') options.write('正在验证\n')
    },
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.sleep === undefined ? {} : { sleep: options.sleep }),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    ...(options.promptForVerifyCode === undefined ? {} : { promptForVerifyCode: options.promptForVerifyCode }),
  })

  if (result.kind === 'connected') {
    await options.saveAccount(result.credentials)
    options.write(`已连接到微信：${result.credentials.accountId}\n`)
    options.exit(0)
    return
  }
  if (result.kind === 'already-connected') {
    options.write('已连接过此 Harness，无需重复连接。\n')
    options.exit(0)
    return
  }
  options.write(`${result.message}\n`)
  options.exit(1)
}

/** Forget every stored account. */
async function runLogout(options: StartupActionOptions): Promise<void> {
  const accounts = await options.listAccounts()
  if (accounts.length === 0) {
    options.write('没有存储的微信登录。\n')
    options.exit(0)
    return
  }
  for (const account of accounts) await options.forgetAccount?.(account.accountId)
  options.write(`已移除 ${String(accounts.length)} 个微信登录。\n`)
  options.exit(0)
}

/** Show what is stored, without changing it. */
async function runStatus(options: StartupActionOptions): Promise<void> {
  const accounts = await options.listAccounts()
  if (options.startup.json === true) {
    // Machine-readable output is one JSON document, so a script can parse the
    // whole stream rather than scrape lines.
    options.write(`${JSON.stringify(accounts)}\n`)
    options.exit(0)
    return
  }
  if (accounts.length === 0) {
    options.write('没有存储的微信登录。\n')
    options.exit(0)
    return
  }
  for (const account of accounts) options.write(`账号：${account.accountId}\n`)
  options.exit(0)
}
