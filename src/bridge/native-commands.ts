/**
 * The harness's own commands, reached from WeChat.
 *
 * `ctx.commands` resolves a command against one agent's scoped view, so a line
 * is forwarded with the exact receiving agent and the full text. That is what
 * keeps the WeChat surface as wide as the harness's own: `/goal`, `/compact`,
 * `/permission` and anything a later plugin registers all arrive here rather
 * than needing an entry in a list this plugin maintains.
 *
 * A WeChat message carries no uploads, so every forward passes an empty
 * attachment list.
 *
 * @module dsh-channel-wechat/bridge/native-commands
 */

import type { CommandOutcome } from './commands.ts'

/** The slice of `ctx.commands` these bridges use. */
export interface CommandRuntimeLike {
  /** Run one command against an agent's view. */
  execute(
    agent: unknown,
    line: string,
    attachments: readonly unknown[],
    signal: AbortSignal,
  ): Promise<{ result: { kind: 'success' | 'error'; text?: string } } | undefined>
  /** List the commands available to one agent. */
  list(agent: unknown): readonly { name: string; description: string }[]
}

/** Collaborators both bridges need. */
export interface NativeCommandOptions {
  /** The harness command runtime. */
  commands: CommandRuntimeLike
  /** Resolve the live agent a peer's command runs against. */
  agentFor: (peerId: string) => unknown | undefined
}

/**
 * Build the forwarder the router calls for a non-local command.
 * @param options - the runtime and the agent lookup.
 * @returns a function taking the command line and the peer.
 */
export function createNativeCommandExecutor(
  options: NativeCommandOptions,
): (line: string, peerId: string) => Promise<CommandOutcome | undefined> {
  return async (line, peerId) => {
    const agent = options.agentFor(peerId)
    // Commands resolve against an agent's own scoped view, so without one there
    // is nothing to run against rather than a global fallback.
    if (agent === undefined) return undefined

    try {
      // A fresh signal per invocation: two commands from one peer must not share
      // cancellation state, and a command that runs long must stay cancellable.
      const execution = await options.commands.execute(agent, line, [], new AbortController().signal)
      if (execution === undefined) return undefined
      const result = execution.result
      if (result.kind === 'success') {
        return { kind: 'success', ...(result.text === undefined ? {} : { text: result.text }) }
      }
      // The harness's error variant always carries text; an empty one would
      // reach the user as a blank reply, so it is named instead.
      return { kind: 'error', text: result.text ?? '命令执行失败' }
    } catch (error) {
      // A broken command runtime must not take the channel down: the user gets
      // an error for this command and the loop keeps polling.
      return { kind: 'error', text: `命令执行失败：${error instanceof Error ? error.message : String(error)}` }
    }
  }
}

/**
 * Build the lister `/help` uses.
 * @param options - the runtime and the agent lookup.
 * @returns a function returning the command names available to a peer.
 */
export function createNativeCommandLister(
  options: NativeCommandOptions,
): (peerId: string) => Promise<readonly string[]> {
  return async (peerId) => {
    const agent = options.agentFor(peerId)
    if (agent === undefined) return []
    try {
      return options.commands.list(agent).map(command => command.name)
    } catch {
      // Help is not worth failing a message over; an empty list shows only the
      // channel's own commands.
      return []
    }
  }
}
