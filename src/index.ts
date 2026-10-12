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
import { sessionIdFor } from './bridge/peer-map.ts'
import { createNativeCommandExecutor, createNativeCommandLister, type CommandRuntimeLike } from './bridge/native-commands.ts'
import { CursorStore } from './channel/cursor-store.ts'
import { createSingleRun, type SingleRun } from './channel/single-run.ts'
import { mountPanelRoutes, panelUrl } from './channel/mount.ts'
import { createReporter } from './channel/report.ts'
import { createPanel } from './channel/panel.ts'
import { startChannelFromStore } from './channel/runtime.ts'

/** Plugin name reported in boot audits and `pending (waiting for service: …)` lines. */
export const name = 'channel-wechat'

/**
 * Host services this plugin needs. `wechatStartup` is the parsed invocation,
 * `credentials` is where a login is persisted, and `agents` is what the channel
 * creates its sessions through; the loader parks this row until all four exist.
 * `commands` is the harness's own command surface, which WeChat forwards to
 * rather than maintaining a list of its own.
 */
export const inject = ['wechatStartup', 'credentials', 'agents', 'commands'] as const

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
    // Synchronous: the run is launched detached inside, because awaiting a loop
    // that runs until shutdown would block the rest of boot.
    startChannel(ctx)
    // Detached for the same reason: it waits for a service that arrives later in
    // the boot, and the tree must not be held open on that.
    void mountLoginPanel(ctx)
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
 * Mount the browser login panel when this host can serve one.
 *
 * A browser-facing host is the only place the panel works, and it is the only
 * place a user can log in at all: the launcher hands the same argument list to
 * every app in a profile, and the web app declares no positional, so
 * `dsh <profile> login` dies in the web app's own parser before this plugin sees
 * it. Printing the URL is the whole discovery mechanism - a panel nobody can find
 * is the same as no panel.
 *
 * @param ctx - the plugin's cordis context.
 */
async function mountLoginPanel(ctx: Context): Promise<void> {
  await mountPanelRoutes(ctx, () => createPanel({
    api: createApiClient(),
    saveAccount: account => saveAccount(ctx, account),
    // The channel reads the store as it starts, so this runs after the write;
    // the panel owns that ordering. A start that beat the write would poll as
    // the previous account or as none.
    startChannel: () => startChannel(ctx, { force: true }),
    onError: (error: unknown) => { ctx.logger(name).warn('login panel failed to connect: %s', String(error)) },
  }))

  // `console.log`, not `ctx.logger`: no profile mounts a console exporter for
  // the named logger, so a URL written through it is never seen. The shipped web
  // app prints its own URL the same way.
  //
  // The wording matters and is not decorative. The page is a browser page that
  // shows a QR for the *phone* to scan, so "open it with WeChat" would send the
  // user to the wrong device. And the fence only accepts the launch token at `/`,
  // so the panel URL works in a browser that has already opened the Harness UI -
  // which the desktop app always has, and which the user's browser has by the
  // time they are reading this, because that is where the UI is.
  console.log(`[channel-wechat] 微信登录：在已打开 Harness 界面的浏览器中打开 ${panelUrl(ctx)}，用手机微信扫码`)
}

/**
 * Begin polling as the stored account, if there is one.
 *
 * The run is owned by a {@link createSingleRun}, so the boot's run and the one
 * the login panel starts cannot overlap: two loops over one account would deliver
 * every message twice.
 *
 * @param ctx - the plugin's cordis context.
 * @param options - `force` ends a live run and replaces it, which is what the
 *   panel needs when it connects an account the boot never saw.
 */
function startChannel(ctx: Context, options: { force?: boolean } = {}): void {
  const run = channelRun(ctx)
  run.start(options.force === true ? { force: true } : {})
}

/**
 * The plugin's single run, created on first use.
 *
 * Per context rather than module-level, so two profiles in one process - the
 * shape the HMR and test tiers both use - do not share a run.
 * @param ctx - the plugin's cordis context.
 * @returns the run owner for this context.
 */
function channelRun(ctx: Context): SingleRun {
  const existing = runs.get(ctx)
  if (existing !== undefined) return existing

  const run = createSingleRun({
    // The rejection is absorbed here rather than left to the caller: the launch
    // is detached because the loop runs until shutdown, so an unhandled
    // rejection would surface as a process-level warning instead of a log line.
    launch: signal => {
      void runChannel(ctx, signal).catch((error: unknown) => {
        ctx.logger(name).warn('channel stopped: %s', String(error))
      })
    },
    onError: (error: unknown) => { ctx.logger(name).warn('channel failed to start: %s', String(error)) },
  })
  runs.set(ctx, run)
  // Unloading the plugin ends the poll instead of leaving it running against a
  // dead context.
  ctx.effect(() => () => {
    run.stop()
    runs.delete(ctx)
  })
  return run
}

/** One run owner per context, so a reload does not inherit a dead one. */
const runs = new WeakMap<Context, SingleRun>()

/**
 * Poll until the signal aborts.
 * @param ctx - the plugin's cordis context.
 * @param signal - aborted when this run is replaced or the plugin unloads.
 */
async function runChannel(ctx: Context, signal: AbortSignal): Promise<void> {
  const report = createReporter({ logger: ctx.logger(name) })
  // One account in v1, so one cursor; the store is per-account for the
  // multi-account release the data structures already allow.
  const cursors = new CursorStore()
  const accounts = await listAccounts(ctx)
  const account = accounts[0]

  await startChannelFromStore({
    listAccounts: async () => (account === undefined ? [] : [account]),
    api: createApiClient(),
    createRegistry: () => ctx.agents as never,
    // A peer's session id is a pure function of the peer, so after any restart it
    // already has persisted state. Without this probe the map defaults to "never
    // exists", calls `create` for an id that does, and the registry rejects it -
    // dropping every inbound message for the life of the process.
    sessionExists: sessionExistsOf(ctx),
    // The model's answer is read from the durable `assistant/message` event, so
    // a run that does not subscribe here answers into nothing. No test that
    // calls `Channel.attach` itself can see that - only the production wiring
    // subscribing is the thing being asserted.
    sessionEvents: ctx,
    // Resolved before the run so a restart resumes where the last one stopped
    // rather than replaying the conversation it already answered.
    ...(account === undefined ? {} : { initialCursor: await cursors.load(account.accountId) }),
    saveCursor: cursor => account === undefined ? Promise.resolve() : cursors.save(account.accountId, cursor),
    // The harness owns the wider command surface; the channel forwards to it so
    // `/goal`, `/compact` and the rest work over WeChat without this plugin
    // tracking them.
    executeNativeCommand: createNativeCommandExecutor({
      commands: commandsOf(ctx),
      agentFor: peerId => agentFor(ctx, peerId),
    }),
    nativeCommands: createNativeCommandLister({
      commands: commandsOf(ctx),
      agentFor: peerId => agentFor(ctx, peerId),
    }),
    onStarted: accountId => { report('polling as', accountId) },
    // These two are the ones that hid a live defect: every restart rejected the
    // session create and reported it here, where nothing could read it.
    onMessageError: (error, _message) => { report('inbound message failed', error) },
    onReplyError: (error, peerId) => { report(`reply to ${peerId} failed`, error) },
    signal,
  })
}

/**
 * Probe whether a peer's session already has persisted state.
 *
 * Asked of `sessionPersistence`, which is the only service that knows about
 * sessions on disk: `ctx.sessions` tracks live sessions only, so it reads as
 * "absent" for exactly the case this needs to detect - a session a previous run
 * left behind.
 *
 * A missing persistence service is treated as "absent" rather than thrown: a
 * composition without durable sessions cannot have a persisted one either, so
 * creating is the correct answer there.
 *
 * @param ctx - the plugin's cordis context.
 * @returns the probe the peer map consults before creating a session.
 */
function sessionExistsOf(ctx: Context): (sessionId: string) => Promise<boolean> {
  const persistence = ctx.get('sessionPersistence') as
    | { stat: (id: string, options?: { signal?: AbortSignal }) => Promise<unknown> }
    | undefined
  if (persistence === undefined) return async () => false
  return async sessionId => {
    try {
      // A non-undefined result is the durable header, so it exists.
      return (await persistence.stat(sessionId)) !== undefined
    } catch {
      // An unreadable store is not a reason to attempt a create that would throw
      // for a session that does exist; resuming reports its own failure.
      return true
    }
  }
}

/** The harness's command runtime. */
function commandsOf(ctx: Context): CommandRuntimeLike {
  const commands = ctx.get('commands') as CommandRuntimeLike | undefined
  if (commands === undefined) {
    // `inject` guarantees this, so reaching it means the composition changed
    // under the plugin; failing loudly beats commands silently doing nothing.
    throw new Error('channel-wechat: ctx.commands is not mounted')
  }
  return commands
}

/**
 * Resolve the live agent for one peer.
 *
 * Command resolution is per agent: `ctx.commands` answers against the scoped
 * view of the agent it is given, so a peer with no session has no commands
 * rather than a global fallback.
 * @param ctx - the plugin's cordis context.
 * @param peerId - the WeChat sender id.
 * @returns the agent, or `undefined` when this peer has no session.
 */
function agentFor(ctx: Context, peerId: string): unknown {
  const agents = ctx.get('agents') as { get?: (id: string) => unknown } | undefined
  return agents?.get?.(sessionIdFor(peerId))
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
