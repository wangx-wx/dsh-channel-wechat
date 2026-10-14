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

import { isAbsolute } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
// Type-only, for the `ctx.agentDefaultModel` declaration it merges into
// `Context`. The service is provided by the profile, not by this plugin, so
// nothing is imported at runtime.
import type {} from '@deepseek-ai/dsh-agent-default-model'
import { loadAccount, listAccounts, saveAccount, forgetAccount } from './credentials.ts'
import { runStartupAction } from './login-command.ts'
import { WECHAT_STARTUP_SERVICE, type WechatStartupValues } from './startup.ts'
import { createApiClient } from './wechat/api.ts'
import type { AgentPresetsLike } from './bridge/peer-map.ts'
import { createNativeCommandExecutor, createNativeCommandLister, type CommandRuntimeLike } from './bridge/native-commands.ts'
import { CursorStore } from './channel/cursor-store.ts'
import { PeerSessionStore } from './channel/peer-session-store.ts'
import { createSingleRun, type SingleRun } from './channel/single-run.ts'
import { mountPanelRoutes, panelUrl } from './channel/mount.ts'
import { createReporter, type Report } from './channel/report.ts'
import { createLogFileSink, logDirPath } from './channel/log-file.ts'
import { createPanel } from './channel/panel.ts'
import { startChannelFromStore } from './channel/runtime.ts'
import type { Channel } from './channel/channel.ts'
import { CardService } from './bridge/cards-service.ts'
import { prepareMedia as prepareMediaBlocks } from './bridge/media.ts'
import type { InboundMedia } from './wechat/inbound.ts'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { FileAttachmentRef, ImageAttachmentRef, ImageMediaType } from '@deepseek-ai/dsh-attachment'
import { downloadMedia } from './wechat/media-download.ts'
import { CDN_BASE_URL } from './wechat/cdn.ts'

/**
 * How long an interaction card stays answerable.
 *
 * Thirty minutes matches the reference implementation and is a human patience
 * bound rather than a technical one: the point is that it is finite, because the
 * seam has no deadline of its own and an ignored card would hold its turn open
 * for the life of the process.
 */
const CARD_TIMEOUT_MS = 30 * 60 * 1_000

/** Plugin name reported in boot audits and `pending (waiting for service: …)` lines. */
export const name = 'channel-wechat'

/**
 * Plugin configuration.
 *
 * `cwd` is required and has no default on purpose. A session's working
 * directory is immutable once recorded, and the web app's system prompt reads
 * it through `{{cwd}}`; a prompt variable with no value fails the turn before
 * the provider is called. Defaulting it would hide a deployment mistake behind
 * a directory the operator never chose, and (worse) silently record that
 * directory into sessions that cannot be moved afterwards.
 */
export interface Config {
  /** Absolute working directory every session this plugin creates records. */
  cwd: string
  /**
   * How this channel answers DSH's interaction cards.
   *
   * Defaults to `wechat`, because a card sent to one conversation should have
   * one place to answer it. `both` also offers the GUI card, and the first answer
   * wins - but this channel cannot withdraw the GUI card once WeChat has
   * answered, so the GUI card then lingers until the turn ends.
   *
   * Optional because the schema defaults it: a profile that predates this key
   * must keep loading.
   */
  cards?: 'wechat' | 'both'
}

/** Runtime schema for {@link Config}; `cwd` must be an absolute path. */
export const Config: z<Config> = z.object({
  // Absolute on purpose: the session boundary rejects a relative `cwd`, and
  // failing at the profile boundary names the offending value.
  cwd: z.string().required(),
  // Defaulted rather than required: the common deployment wants one place to
  // answer a card, and requiring the key would make every existing profile fail
  // to load for a choice it does not have to make.
  cards: z.union([z.const('wechat'), z.const('both')]).default('wechat'),
})

/**
 * Host services this plugin needs. `wechatStartup` is the parsed invocation,
 * `credentials` is where a login is persisted, and `agents` is what the channel
 * creates its sessions through; the loader parks this row until all five exist.
 * `commands` is the harness's own command surface, which WeChat forwards to
 * rather than maintaining a list of its own.
 *
 * `agentDefaultModel` is required rather than looked up on demand because
 * `ctx.agents` does not apply a default selection itself - every caller reads
 * this service and passes the result in. A session created without one has no
 * model, and the turn fails before reaching the provider:
 *
 *   prompt variable "{{model}}" has no value for this assembly
 *
 * The user sees their message arrive and no reply, so the row waits for the
 * service instead of coming up able to lose every turn.
 */
export const inject = ['wechatStartup', 'credentials', 'agents', 'commands', 'agentDefaultModel'] as const

/**
 * Act on the invocation the startup row parsed.
 * @param ctx - the plugin's cordis context.
 */
export function apply(ctx: Context, config: Config): void {
  const startup = ctx.get(WECHAT_STARTUP_SERVICE) as WechatStartupValues | undefined
  if (startup === undefined) return

  // Validated here rather than trusted from the schema, because a profile can
  // supply an absolute-looking value that the session boundary would still
  // reject later, once the failure is far from its cause.
  if (!isAbsolute(config.cwd)) {
    throw new Error(`channel-wechat: cwd must be an absolute path, got ${JSON.stringify(config.cwd)}`)
  }

  // An ordinary start begins polling as whatever account the login action
  // stored; exiting here would kill the server the user asked for.
  if (startup.action === 'none') {
    // Synchronous: the run is launched detached inside, because awaiting a loop
    // that runs until shutdown would block the rest of boot.
    startChannel(ctx, config)
    // Detached for the same reason: it waits for a service that arrives later in
    // the boot, and the tree must not be held open on that.
    void mountLoginPanel(ctx, config)
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
async function mountLoginPanel(ctx: Context, config: Config): Promise<void> {
  await mountPanelRoutes(ctx, () => createPanel({
    api: createApiClient(),
    saveAccount: account => saveAccount(ctx, account),
    // The channel reads the store as it starts, so this runs after the write;
    // the panel owns that ordering. A start that beat the write would poll as
    // the previous account or as none.
    startChannel: () => startChannel(ctx, config, { force: true }),
    onError: (error: unknown) => { reporterFor(ctx)('login panel failed to connect', error) },
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
function startChannel(ctx: Context, config: Config, options: { force?: boolean } = {}): void {
  const run = channelRun(ctx, config)
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
function channelRun(ctx: Context, config: Config): SingleRun {
  const existing = runs.get(ctx)
  if (existing !== undefined) return existing

  const run = createSingleRun({
    // The rejection is absorbed here rather than left to the caller: the launch
    // is detached because the loop runs until shutdown, so an unhandled
    // rejection would surface as a process-level warning instead of a log line.
    launch: signal => {
      void runChannel(ctx, config, signal).catch((error: unknown) => {
        reporterFor(ctx)('channel stopped', error)
      })
    },
    onError: (error: unknown) => { reporterFor(ctx)('channel failed to start', error) },
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

/** One reporter per context, so every diagnostic lands in the same file. */
const reporters = new WeakMap<Context, Report>()

/**
 * The reporter for one context.
 *
 * Shared rather than built per call site: the channel's start, its run, and the
 * login panel all report, and three reporters would open three sinks over one
 * file. It is also what makes the file the *only* place these lines survive on a
 * host with no terminal - the reason this exists at all.
 *
 * The durable sink resolves its directory once, from the harness home. It is
 * built lazily and kept, because the file is appended to, not rewritten.
 * @param ctx - the plugin's cordis context.
 * @returns the reporter this context uses everywhere.
 */
function reporterFor(ctx: Context): Report {
  const existing = reporters.get(ctx)
  if (existing !== undefined) return existing
  const report = createReporter({
    logger: ctx.logger(name),
    also: createLogFileSink({
      dir: logDirPath(),
      // A failed write is itself worth knowing about, and the console is where
      // whoever is watching can still see it.
      onError: error => { console.error(`[channel-wechat] could not write the log file: ${String(error)}`) },
    }),
  })
  reporters.set(ctx, report)
  return report
}

/**
 * Poll until the signal aborts.
 * @param ctx - the plugin's cordis context.
 * @param signal - aborted when this run is replaced or the plugin unloads.
 */
async function runChannel(ctx: Context, config: Config, signal: AbortSignal): Promise<void> {
  const report = reporterFor(ctx)
  // One account in v1, so one cursor; the store is per-account for the
  // multi-account release the data structures already allow.
  const cursors = new CursorStore()
  const accounts = await listAccounts(ctx)
  const account = accounts[0]
  // Resolved once, so every session in this run joins the same preset even if
  // the profile's default changes mid-run.
  const presets = presetsOf(ctx)
  // The durable record of which conversation each peer is in. Wired here rather
  // than defaulted inside the channel: without it `/new` rotates only in memory
  // and the next restart resumes the very conversation the user ended.
  const generations = new PeerSessionStore()
  // The channel is built inside `startChannelFromStore`, while the card service
  // has to exist before it - the channel routes replies through it. One of the
  // two must therefore be introduced after the other, and this holder is that
  // seam: the service tolerates an unset channel by delegating, which is the
  // correct answer in the window before the loop starts.
  const channelRef: { current: Channel | undefined } = { current: undefined }
  const cards = new CardService({
    context: ctx,
    shareWithGui: (config.cards ?? 'wechat') === 'both',
    peerOfSession: sessionId => channelRef.current?.peerOfSession(sessionId),
    send: async (peerId, text) => { await channelRef.current?.sendToPeer(peerId, text) },
    // Finite so an ignored card cannot hold its turn open for the life of the
    // process; long enough that a person can read it and answer.
    timeoutMs: CARD_TIMEOUT_MS,
    onExpired: card => {
      // Said out loud, so the user learns the card lapsed instead of waiting on
      // a decision nobody can make any more.
      void channelRef.current?.sendToPeer(card.peerId, '这张卡片已超时作废。')
    },
  })
  // Attached before the loop starts: a request arriving with the first poll must
  // find an answerer, and one arriving before the channel exists simply
  // delegates to the GUI.
  cards.attach()

  // Built once per run. The store and the route's image capability are both
  // optional: a deployment without an attachment store still runs, and simply
  // delivers the media label instead of the image.
  const prepareMedia = buildMediaPreparer(ctx, modelSelectionOf(ctx), report)

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
    // Every session gets the profile's selected model. `ctx.agents` applies no
    // default of its own, so a session created without this has no model at all
    // and the first turn fails on the system prompt's `{{model}}` reference.
    sessionOptions: modelSelectionOf(ctx),
    // Recorded on every session this run creates. The web app's system prompt
    // reads it through `{{cwd}}`, and a session header cannot be edited later, so
    // a session created without one fails every turn for its whole life.
    cwd: config.cwd,
    // The profile's preset registry, when it has one. A surface that keeps its
    // model-facing tools behind presets (the web app) leaves a session that
    // mounts none with no tools at all, and the model then emits raw tool-call
    // syntax - DeepSeek's `｜DSML｜` markup - which the user reads as garbled
    // text. Read through `get` rather than injected: `inject` would park this
    // row on a deployment that composes no preset roster (headless), where the
    // tool rows sit on the host plane and joining a preset is neither possible
    // nor needed - and the plan requires this plugin to run on both.
    ...(presets === undefined ? {} : { presets }),
    generations,
    cards,
    ...(prepareMedia === undefined ? {} : { prepareMedia }),
    onChannel: channel => { channelRef.current = channel },
    // Resolved before the run so a restart resumes where the last one stopped
    // rather than replaying the conversation it already answered.
    ...(account === undefined ? {} : { initialCursor: await cursors.load(account.accountId) }),
    saveCursor: cursor => account === undefined ? Promise.resolve() : cursors.save(account.accountId, cursor),
    // The harness owns the wider command surface; the channel forwards to it so
    // `/goal`, `/compact` and the rest work over WeChat without this plugin
    // tracking them.
    executeNativeCommand: createNativeCommandExecutor({ commands: commandsOf(ctx) }),
    nativeCommands: createNativeCommandLister({ commands: commandsOf(ctx) }),
    onStarted: accountId => { report('polling as', accountId) },
    // These two are the ones that hid a live defect: every restart rejected the
    // session create and reported it here, where nothing could read it.
    onMessageError: (error, _message) => { report('inbound message failed', error) },
    // Names the wire shape rather than leaving it to be inferred: a quoted reply
    // whose content never arrived and an ordinary message look identical once
    // delivered.
    onUnreadableQuote: detail => { report('引用的消息内容未能读取', detail) },
    onReplyError: (error, peerId) => { report(`reply to ${peerId} failed`, error) },
    // A send that worked is recorded too: with only failures logged, "no output"
    // is indistinguishable from "nothing ran", which is exactly what left a live
    // test unable to say whether a file had gone out.
    onDeliverableSent: (label, detail) => { report(label, detail) },
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

/**
 * Build the media preparer for one run, or `undefined` when media is impossible.
 *
 * Returns a function rather than being inlined because three separate things can
 * make media unavailable - no attachment store, no image-capable model, no
 * downloaded bytes - and each has to degrade to the label rather than to a lost
 * message.
 *
 * @param ctx - the plugin's context, read with `get` because neither service is
 *   guaranteed: `attachments` is absent on a surface that mounts no store, and
 *   `llm` on a surface that registers no adapter.
 * @param selection - the provider and model the profile chose.
 * @param report - where a media failure is recorded.
 * @returns the preparer, or `undefined` when this deployment cannot attach media.
 */
function buildMediaPreparer(
  ctx: Context,
  selection: { provider: string; model: string },
  report: (label: string, detail: unknown) => void,
): ((media: readonly InboundMedia[]) => Promise<{ parts: readonly ContentBlock[]; notes: readonly string[] }>) | undefined {
  const store = ctx.get('attachments') as AttachmentStoreLike | undefined
  if (store === undefined) return undefined
  // Resolved per message rather than once, because the model can change between
  // turns and a session that switched to a text-only model must stop attaching.
  const supportsImage = async (): Promise<boolean> => {
    const llm = ctx.get('llm') as LlmLike | undefined
    if (llm === undefined) return false
    try {
      const info = await llm.resolveModelInfo(selection.provider, selection.model)
      return info?.inputModalities?.includes('image') ?? false
    } catch {
      // A lookup that fails must not claim support: sending an image the
      // provider then rejects loses the whole message, while a label only costs
      // the image.
      return false
    }
  }
  return async media => await prepareMediaBlocks(media, {
    download: async item => await downloadMedia(item, { cdnBaseUrl: CDN_BASE_URL }),
    // `saveImages` validates then commits, and returns one reference per input,
    // so the single-element call is the same path the batch one takes.
    admitImage: async input => (await store.saveImages([input]))[0] as ImageAttachmentRef,
    admitFile: async input => await store.saveFile(input),
    supportsImage,
    report,
  })
}

/** The slice of the attachment store this module uses. */
interface AttachmentStoreLike {
  saveImages: (inputs: readonly { data: Uint8Array; mediaType: ImageMediaType; name?: string }[]) => Promise<readonly ImageAttachmentRef[]>
  saveFile: (input: { data: Uint8Array; name?: string }) => Promise<FileAttachmentRef>
}

/** The slice of the LLM runtime this module uses. */
interface LlmLike {
  resolveModelInfo: (provider: string, model: string) => Promise<{ inputModalities?: readonly string[] } | undefined>
}

/**
 * The provider and model the profile selected.
 *
 * Read per run rather than captured once, so a selection changed in the GUI
 * applies to the sessions started after it. `currentSelection` is the same
 * accessor the shipped headless runner and the web session controller use.
 * @param ctx - the plugin's cordis context.
 * @returns the selection to pass to every create and resume.
 */
function modelSelectionOf(ctx: Context): { provider: string; model: string } {
  const selection = ctx.agentDefaultModel.currentSelection()
  return { provider: selection.provider, model: selection.model }
}

/**
 * The profile's agent-preset registry, when it composes one.
 *
 * Read through `get` rather than declared in `inject`, because a deployment
 * without a preset roster is a supported composition rather than a broken one:
 * the headless bundle keeps its model-facing tool rows on the host plane, where
 * an agent reads them from the global layer, so it composes no registry and
 * mounting a preset there is neither possible nor needed. Declaring it in
 * `inject` would park this whole row on that deployment and the channel would
 * never start.
 *
 * On a surface that DOES keep those rows behind presets - the web app disables
 * every model-facing tool row on the host plane - a session that mounts no
 * preset has no tools at all. The model then emits tool-call syntax from its
 * training, and the user reads that markup as garbled text instead of an answer.
 *
 * @param ctx - the plugin's cordis context.
 * @returns the registry, or `undefined` when this deployment has none.
 */
function presetsOf(ctx: Context): AgentPresetsLike | undefined {
  return ctx.get('agentPresets') as AgentPresetsLike | undefined
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
