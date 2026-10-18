/**
 * The channel's own slash commands.
 *
 * `cancelRunning` returns whether there was a turn to cancel, because "stopped"
 * and "nothing was running" are different answers: reporting the first when the
 * second is true tells the user their task died when it had already finished.
 *
 * `/cwd` and `/reconnect` are registered but not implemented. They report that
 * plainly, because a command that returns success and changes nothing is worse
 * than one that says it is not ready — the user acts on the first.
 *
 * @module dsh-channel-wechat/bridge/local-commands
 */

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
   * Resolve the commands the harness offers this peer, for `/help`.
   *
   * A function rather than a list because the available commands come from the
   * agent's own scoped view: which plugins that agent mounted decides them.
   */
  nativeCommands: () => Promise<readonly NativeCommandRow[]>
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
  cwd: '`/cwd` 尚未实现：切换工作目录需要结束当前会话并在新目录新建（cwd 不可变）。目前请在 GUI 中切换工作区。',
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
      return help(ctx)
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

/** End the session so the next message starts a fresh conversation. */
async function startNew(ctx: LocalCommandContext): Promise<CommandOutcome> {
  await ctx.endSession()
  return { kind: 'success', text: '已结束当前会话，下一条消息将开始新的对话。' }
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
  const lines = [
    '本通道命令：',
    '',
    '/stop — 停止当前任务',
    '',
    '/status — 查看账号与会话状态',
    '',
    '/new — 结束当前会话，开始新对话',
    '',
    '/models — 查看可用的供应商与模型',
    '',
    '/model <provider/model> — 切换模型（写入插件配置）',
    '',
    '/cwd <目录> — 切换工作目录（尚未实现）',
    '',
    '/reconnect — 重连（尚未实现）',
    '',
    '/help — 显示本帮助',
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
