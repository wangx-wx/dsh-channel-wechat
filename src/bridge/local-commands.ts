/**
 * The channel's own slash commands.
 *
 * `cancelRunning` returns whether there was a turn to cancel, because "stopped"
 * and "nothing was running" are different answers: reporting the first when the
 * second is true tells the user their task died when it had already finished.
 *
 * `/reconnect` is registered but not implemented. It reports that plainly,
 * because a command that returns success and changes nothing is worse than one
 * that says it is not ready — the user acts on the first.
 *
 * `/cwd` **is** implemented, as "end this conversation and start the next one in
 * that directory". A session's header `cwd` cannot be rewritten, so moving a
 * conversation is not possible; a new session in the new directory is the only
 * honest form of "switch workspace". `new` and `cwd` therefore share the same
 * mechanism and differ only in which directory the next session records.
 *
 * @module dsh-channel-wechat/bridge/local-commands
 */

import { isAbsolute } from 'node:path'
import type { CommandOutcome, ParsedCommand } from './commands.ts'
import type { ModelCommandContext } from './model-commands.ts'
import { listModels, switchModel } from './model-commands.ts'
import type { NativeCommandRow } from './native-commands.ts'

/** What the channel's commands need to know. */
export interface LocalCommandContext {
  /** The peer whose message carried the command. */
  peerId: string
  /**
   * Cancel the peer's running turn.
   * @returns whether there was a turn to cancel.
   */
  cancelRunning: () => Promise<boolean>
  /** End the peer's session, so the next message starts a fresh one. */
  endSession: () => Promise<void>
  /** The account being polled, when one is. */
  accountId: string | undefined
  /** How many peers currently have a session. */
  sessionCount: number
  /**
   * The directory the peer's next session will record.
   *
   * Reported by `/new` and `/cwd`: after a switch the user has no other way to
   * learn which directory the conversation is actually running in, and a
   * session's `cwd` is immutable, so a wrong answer here cannot be corrected
   * later by another message.
   *
   * Asynchronous, and consulted through the channel's own resolution, because
   * the answer after `/new` is the *stored* directory: the live session that
   * knew it has just been ended, and reading only what is live would fall back
   * to the configured default and report a directory the user had moved away
   * from.
   */
  currentCwd: () => Promise<string | undefined>
  /**
   * Move the peer to a new working directory.
   *
   * Ends the current session and makes the next one record `path`, which is the
   * only available form of the change: a session's header `cwd` is immutable.
   * @param path - an absolute directory that exists.
   * @returns the canonical directory the next session will record.
   */
  changeCwd: (path: string) => Promise<string>
  /**
   * Resolve the commands the harness offers this peer, for `/help`.
   *
   * A function rather than a list because the available commands come from the
   * agent's own scoped view: which plugins that agent mounted decides them.
   */
  nativeCommands: () => Promise<readonly NativeCommandRow[]>
  /**
   * Resolve the skills the harness offers this peer, for `/skills`.
   *
   * Names only, by the user's own decision: the descriptions are long enough
   * that a listing of both fills several phone screens, and the name is what
   * `/skill-name` invocation actually needs. Absent when this deployment
   * composes no skill registry.
   */
  skills?: (() => Promise<readonly string[]>) | undefined
  /**
   * What `/models` and `/model` read and write.
   *
   * The same shape both commands need; `undefined` for a deployment that
   * composes no LLM registry or no writable config, where the commands report
   * that plainly rather than pretending.
   */
  models: ModelCommandContext
}

/** Commands this channel has not implemented yet. */
const UNIMPLEMENTED: Record<string, string> = {
  reconnect: '`/reconnect` 尚未实现：重连长轮询需要在当前进程内重建连接，尚未提供。',
}

/**
 * Run one of this channel's commands.
 * @param command - the parsed command.
 * @param ctx - what the command needs to know.
 * @returns the outcome to send back.
 */
export async function runLocalCommand(
  command: ParsedCommand,
  ctx: LocalCommandContext,
): Promise<CommandOutcome> {
  switch (command.name) {
    case 'stop':
      return stop(ctx)
    case 'status':
      return status(ctx)
    case 'new':
      return startNew(ctx)
    case 'help':
    case 'h':
      return help(ctx)
    case 'cwd':
      return changeDirectory(ctx, command.args)
    case 'skills':
      return listSkills(ctx)
    case 'models':
      return listModels(ctx.models)
    case 'model':
      return switchModel(ctx.models, command.args)
    default: {
      const unimplemented = UNIMPLEMENTED[command.name]
      if (unimplemented !== undefined) return { kind: 'error', text: unimplemented }
      return { kind: 'error', text: `未知命令：/${command.name}` }
    }
  }
}

/** Cancel the peer's running turn. */
async function stop(ctx: LocalCommandContext): Promise<CommandOutcome> {
  const stopped = await ctx.cancelRunning()
  return {
    kind: 'success',
    text: stopped ? '已停止当前任务。' : '当前没有正在运行的任务。',
  }
}

/** Report what this channel is doing. */
function status(ctx: LocalCommandContext): CommandOutcome {
  const account = ctx.accountId === undefined
    ? '未登录：发送 `dsh <profile> login` 扫码连接。'
    : `账号 ${ctx.accountId}`
  return { kind: 'success', text: `${account}\n活跃会话：${String(ctx.sessionCount)}` }
}

/**
 * End the session so the next message starts a fresh conversation.
 *
 * The directory is reported because the new conversation inherits it and a
 * session's `cwd` can never be corrected afterwards: a user who assumed `/new`
 * had moved somewhere else would have no way to find out until tools started
 * writing in the wrong place.
 * @param ctx - what the command needs to know.
 * @returns the outcome to send back.
 */
async function startNew(ctx: LocalCommandContext): Promise<CommandOutcome> {
  await ctx.endSession()
  const cwd = await ctx.currentCwd()
  return {
    kind: 'success',
    text: [
      '已结束当前会话，下一条消息将开始新的对话。',
      '',
      `新会话的工作目录：${cwd === undefined ? '（未知，沿用通道配置）' : `\`${cwd}\``}`,
      '',
      '要换到别的目录，先发 `/cwd <绝对路径>`。',
    ].join('\n'),
  }
}

/**
 * Move the peer to a new working directory.
 *
 * Implemented as "end this session, make the next one record that directory",
 * because a session header's `cwd` is immutable: the only way to change where a
 * conversation runs is to start a different conversation. The directory is
 * validated here rather than trusted from the argument, so a typo comes back as
 * a chat message instead of a session whose tools fail on their first call.
 *
 * @param ctx - what the command needs to know.
 * @param args - everything after the command name.
 * @returns the outcome to send back.
 */
async function changeDirectory(ctx: LocalCommandContext, args: string): Promise<CommandOutcome> {
  const path = args.trim()
  if (path === '') {
    const cwd = await ctx.currentCwd()
    return {
      kind: 'success',
      text: [
        `当前工作目录：${cwd === undefined ? '（未知，沿用通道配置）' : `\`${cwd}\``}`,
        '',
        '切换用法：`/cwd <绝对路径>`，例如 `/cwd D:\\workspace\\my-project`。',
        '',
        '切换等于结束当前会话、在新目录开始新对话：会话的工作目录写入后不可修改。',
      ].join('\n'),
    }
  }
  // Absolute only. A relative path would be resolved against a process
  // directory the user cannot see from WeChat, so "the directory I meant" and
  // "the directory it picked" would be two different places.
  if (!isAbsolute(path)) {
    return {
      kind: 'error',
      text: `\`${path}\` 不是绝对路径。请给出完整路径，例如 \`/cwd D:\\workspace\\my-project\`。`,
    }
  }
  try {
    const cwd = await ctx.changeCwd(path)
    return {
      kind: 'success',
      text: [
        `已切换到 \`${cwd}\`。`,
        '',
        '当前会话已结束，下一条消息会在该目录开始新的对话；旧对话仍保留在磁盘上。',
      ].join('\n'),
    }
  } catch (error: unknown) {
    return {
      kind: 'error',
      text: `无法切换到 \`${path}\`：${error instanceof Error ? error.message : String(error)}`,
    }
  }
}

/**
 * List the skills this peer can invoke.
 *
 * Names only: the description of every installed skill runs to several phone
 * screens, and `/help` already documents that a name can be invoked as its own
 * slash command. An empty list is reported as a fact rather than as a blank
 * message, because "this deployment has no skills" and "the listing broke" look
 * identical otherwise.
 *
 * @param ctx - what the command needs to know.
 * @returns the listing.
 */
async function listSkills(ctx: LocalCommandContext): Promise<CommandOutcome> {
  const list = ctx.skills
  if (list === undefined) {
    return { kind: 'error', text: '当前部署没有技能注册表，无法列出技能。' }
  }
  let names: readonly string[]
  try {
    names = await list()
  } catch (error: unknown) {
    return { kind: 'error', text: `读取技能列表失败：${error instanceof Error ? error.message : String(error)}` }
  }
  if (names.length === 0) {
    return {
      kind: 'success',
      text: [
        '当前没有可用的技能。',
        '',
        '技能来自项目里的 `.dsh/skills`、`.agents/skills`，以及用户级的 `~/.dsh/skills`、`~/.agents/skills`。',
      ].join('\n'),
    }
  }
  // One per paragraph, separated by a blank line: WeChat renders markdown, where
  // a single newline collapses into a space and the whole list arrives as one
  // run-on line. The same rule `/help` and `/models` obey.
  return {
    kind: 'success',
    text: [
      `可用技能（${String(names.length)} 个）：`,
      '',
      ...names.flatMap((name, index) => [...(index === 0 ? [] : ['']), `/${name}`]),
      '',
      '发送 `/技能名` 可直接调用；技能的完整说明由模型在需要时加载。',
    ].join('\n'),
  }
}

/**
 * List both command surfaces.
 *
 * **One command per paragraph, separated by a blank line.** WeChat renders the
 * text as markdown, where a single newline is a soft break that collapses into
 * a space; only a blank line starts a new block. A listing built with `\n`
 * therefore arrives as one run-on line even though the bytes are correct -
 * copying it out of the chat shows the newlines that were always there. The
 * alignment spaces the previous version relied on were lost the same way
 * (markdown collapses runs of spaces), which is why the separator is an
 * explicit em dash rather than padding.
 *
 * @param ctx - what the command needs to know.
 * @returns the help text.
 */
async function help(ctx: LocalCommandContext): Promise<CommandOutcome> {
  // The harness's own commands are read first: an empty answer is a fact worth
  // stating, not a heading with nothing under it.
  const native = await ctx.nativeCommands()
  const cwd = await ctx.currentCwd()
  const lines = [
    '本通道命令：',
    '',
    '/stop — 停止当前任务',
    '',
    '/status — 查看账号与会话状态',
    '',
    '/new — 结束当前会话，开始新对话',
    '',
    '/cwd [绝对路径] — 查看或切换工作目录（切换=在新目录开始新对话）',
    '',
    '/skills — 列出可调用的技能名称',
    '',
    '/models — 查看可用的供应商与模型',
    '',
    '/model <provider/model> — 切换模型（写入插件配置）',
    '',
    '/reconnect — 重连（尚未实现）',
    '',
    '/help 或 /h — 显示本帮助',
    '',
    `当前工作目录：${cwd === undefined ? '（未知，沿用通道配置）' : `\`${cwd}\``}`,
    '',
    'Harness 命令（由 DSH 提供）：',
    '',
    ...(native.length === 0
      // Distinguished from "the harness has no commands", which is not a state
      // any deployment reaches: an empty list here means this peer has no
      // session yet, so there is no agent to resolve a command against.
      ? ['（本会话尚未建立，先发一条普通消息即可看到完整列表）']
      // Flattened with a blank line between entries for the same reason as the
      // listing above: these arrive from the harness one name each, and joining
      // them with a single newline would collapse them into one line on screen.
      : native.flatMap((command, index) => [
        ...(index === 0 ? [] : ['']),
        command.description === '' ? `/${command.name}` : `/${command.name} — ${command.description}`,
      ])),
  ]
  return { kind: 'success', text: lines.join('\n') }
}
