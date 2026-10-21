/**
 * The harness's own commands, reached from WeChat.
 *
 * `ctx.commands` resolves a command against one agent's scoped view, so a line
 * is forwarded with the exact receiving agent and the full text. That is what
 * keeps the WeChat surface as wide as the harness's own: `/goal`, `/compact`,
 * `/permission` and anything a later plugin registers all arrive here rather
 * than needing an entry in a list this plugin maintains.
 *
 * The agent is supplied by the caller rather than looked up from the peer id.
 * The channel owns the peer-to-session mapping, so a bridge that re-derived the
 * session id from the peer would carry a second copy of that knowledge - and a
 * second copy is what breaks the moment a peer can have more than one
 * conversation.
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

/** The harness command runtime both bridges need. */
export interface NativeCommandOptions {
  /** The harness command runtime. */
  commands: CommandRuntimeLike
}

/**
 * Build the forwarder the router calls for a non-local command.
 * @param options - the command runtime.
 * @returns a function taking the command line and the agent it runs against.
 */
export function createNativeCommandExecutor(
  options: NativeCommandOptions,
): (line: string, agent: unknown) => Promise<CommandOutcome | undefined> {
  return async (line, agent) => {
    // Commands resolve against an agent's own scoped view, so a caller with no
    // agent has nothing to run against rather than a global fallback.
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

/** One harness command as `/help` presents it. */
export interface NativeCommandRow {
  /** Name without the leading slash. */
  readonly name: string
  /** The harness's own one-line summary; empty when it supplied none. */
  readonly description: string
}

/**
 * Build the lister `/help` uses.
 *
 * The description travels with the name because the GUI's command menu shows
 * one and a help listing that dropped it would leave `/compact` and `/goal`
 * indistinguishable to someone who has not memorized them.
 *
 * @param options - the command runtime.
 * @returns a function returning the commands available to one agent.
 */
export function createNativeCommandLister(
  options: NativeCommandOptions,
): (agent: unknown) => Promise<readonly NativeCommandRow[]> {
  return async (agent) => {
    if (agent === undefined) return []
    try {
      return options.commands.list(agent).map(command => ({
        name: command.name,
        description: command.description,
      }))
    } catch {
      // Help is not worth failing a message over; an empty list shows only the
      // channel's own commands.
      return []
    }
  }
}

/**
 * The slice of the harness's skill registry `/skills` reads.
 *
 * Structural rather than imported, for the same reason the command runtime is:
 * this plugin must also load where the registry is absent, and a composition
 * without `@deepseek-ai/dsh-skill` is a supported deployment.
 */
export interface SkillRegistryLike {
  /**
   * List the skills visible to one lookup.
   *
   * `cwd` selects the project roots to scan and `scope` selects the agent's own
   * layers; both matter, because a preset can mount skills the global layer
   * does not have.
   */
  list(options: {
    cwd?: string
    scope?: unknown
    signal?: AbortSignal
  }): Promise<readonly { name: string; invocation: { userInvocable: boolean } }[]>
}

/** Options for the skill lister. */
export interface SkillListerOptions {
  /** The harness's skill registry. */
  skills: SkillRegistryLike
}

/**
 * Build the lister `/skills` uses.
 *
 * Returns names only, by the user's own decision: a full listing with
 * descriptions fills several phone screens, and the name is what the
 * `/skill-name` invocation gesture needs. Only user-invocable skills are
 * returned, because the others cannot be invoked from a chat line at all.
 *
 * **A peer with no live session still gets a listing.** The agent is the
 * lookup's scope, and passing `undefined` reads the global layer alone - which
 * is exactly what the harness's own catalog does for a session it can only
 * address cold (`session-controller`'s skill catalog resolves the same way).
 * Returning nothing instead would make `/skills` report "no skills" before the
 * user has sent their first ordinary message, which is a false statement about
 * the deployment rather than about that peer.
 *
 * @param options - the skill registry.
 * @returns a function returning the skill names available to one agent.
 */
export function createSkillLister(
  options: SkillListerOptions,
): (agent: unknown, cwd: string | undefined) => Promise<readonly string[]> {
  return async (agent, cwd) => {
    try {
      const skills = await options.skills.list({
        ...(cwd === undefined ? {} : { cwd }),
        // Omitted rather than passed as `undefined`: an explicit key would be a
        // scope value the registry cannot interpret, while an absent one is the
        // documented "global layer alone".
        ...(agent === undefined ? {} : { scope: agent }),
      })
      return skills.filter(skill => skill.invocation.userInvocable).map(skill => skill.name)
    } catch {
      // A listing that fails is not worth failing the command over with a stack
      // trace; an empty answer says "none available", which is the closest
      // truthful thing this boundary can report.
      return []
    }
  }
}
