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
  /** Command names the harness offers, for `/help`. */
  nativeCommands: readonly string[]
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

/** List both command surfaces. */
function help(ctx: LocalCommandContext): CommandOutcome {
  const lines = [
    '本通道命令：',
    '  /stop          停止当前任务',
    '  /status        查看账号与会话状态',
    '  /new           结束当前会话，开始新对话',
    '  /cwd <目录>    切换工作目录（尚未实现）',
    '  /help          显示本帮助',
    '  /reconnect     重连（尚未实现）',
    '',
    'Harness 命令（由 DSH 提供）：',
    ...ctx.nativeCommands.map(name => `  /${name}`),
  ]
  return { kind: 'success', text: lines.join('\n') }
}
