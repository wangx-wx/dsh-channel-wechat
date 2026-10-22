/**
 * Deciding whether a line is a command, and which surface answers it.
 *
 * Split out of `channel.ts`, which had grown past its documented size. The
 * boundary is real: the channel owns the loop, the queue, and the sessions,
 * while this decides only *what kind of line* arrived and *who answers it*.
 * The one thing it cannot decide alone is whether a name is a skill, because
 * that depends on the peer's live agent and directory - so that arrives as a
 * callback rather than being looked up here.
 *
 * Three surfaces, checked in this order, and the order is the rule:
 *
 *  1. **This channel's own commands.** They must win, so `/stop` means stop
 *     whatever a deployment happens to have installed under that name.
 *  2. **The harness's commands.** Resolved against the peer's own agent, so the
 *     surface stays as wide as the harness's rather than a list kept here.
 *  3. **A skill invocation.** Last, because the harness recognizes it by
 *     scanning the *delivered* message: only a line nothing else claimed may be
 *     handed back for delivery. Checking it earlier would let a skill named
 *     `stop` shadow the command.
 *
 * @module dsh-channel-wechat/channel/command-routing
 */

import { LOCAL_COMMANDS, routeCommand, type CommandOutcome, type ParsedCommand } from '../bridge/commands.ts'

/** How to reach one peer's conversation, for the skill lookup. */
export interface CommandPeer {
  /** The peer's live agent, when it has one; `undefined` means no session yet. */
  agent: () => unknown
  /** The directory the conversation is running in, when known. */
  cwd: () => Promise<string | undefined>
}

/** What routing one line needs. */
export interface CommandRoutingOptions {
  /** Answer one of this channel's own commands. */
  handleLocal: (command: ParsedCommand) => CommandOutcome | Promise<CommandOutcome>
  /** Forward a line to the harness's command runtime, resolved against the peer's agent. */
  executeNative: (line: string) => Promise<CommandOutcome | undefined>
  /** Whether a name is a user-invocable skill; absent means skills cannot be typed. */
  claimsSkill?: ((name: string) => Promise<boolean>) | undefined
}

/** What one routed line came to. */
export interface CommandRouting {
  /**
   * The answer to send, or `undefined` when the line belongs to the agent.
   *
   * `undefined` is not "nothing happened": it means the caller must **deliver**
   * the line as a turn, which is the only way a skill invocation works.
   */
  outcome: CommandOutcome | undefined
  /**
   * Whether this line is a command rather than a turn.
   *
   * Used by the queue as well as by the caller, and answered from the same
   * predicate, so the two cannot disagree about which lines bypass the queue.
   * A command bypasses it because it may be the thing that stops the running
   * turn; a skill is a turn and must queue like one.
   */
  isCommand: boolean
}

/**
 * Route one line that starts with a slash.
 * @param text - the line.
 * @param options - the peer and the three surfaces.
 * @returns the answer to send and whether the line was a command at all.
 */
/**
 * Bind a deployment's skill predicate to one peer's conversation.
 *
 * Whether a name is a skill depends on the peer's live agent and directory - a
 * preset can mount skills the global layer lacks - so it cannot be answered from
 * the line alone.
 * @param claims - the deployment's predicate, when it has a skill registry.
 * @param peer - where to read the peer's agent and directory from.
 * @returns the bound predicate, or `undefined` when this deployment has no skills.
 */
export function bindSkillClaim(
  claims: ((name: string, agent: unknown, cwd: string | undefined) => Promise<boolean>) | undefined,
  peer: CommandPeer,
): ((name: string) => Promise<boolean>) | undefined {
  if (claims === undefined) return undefined
  return async name => await claims(name, peer.agent(), await peer.cwd())
}

export async function routeCommandLine(text: string, options: CommandRoutingOptions): Promise<CommandRouting> {
  const outcome = await routeCommand(text, {
    handleLocal: options.handleLocal,
    executeNative: options.executeNative,
    claimSkill: async command => options.claimsSkill === undefined ? false : await options.claimsSkill(command.name),
  })
  // `undefined` from the router means nothing claimed the line - which only
  // happens for a skill, since a genuinely unknown name comes back as an error.
  return { outcome, isCommand: outcome !== undefined }
}

/**
 * Whether a line names a skill, rather than a command.
 *
 * Asked before the queue decision and again inside the router, and answered from
 * one predicate so the two cannot disagree. A local command short-circuits
 * without asking: `/stop` must mean stop, and a failing skill lookup answers
 * "no" so the user sees the unknown-command error rather than a turn that
 * silently carries text no skill will consume.
 * @param name - the command name, without the slash.
 * @param claims - the deployment's skill predicate, when it has one.
 * @returns true when the line must be delivered to the agent.
 */
export async function isSkillInvocation(
  name: string,
  claims: ((name: string) => Promise<boolean>) | undefined,
): Promise<boolean> {
  if (claims === undefined) return false
  if ((LOCAL_COMMANDS as readonly string[]).includes(name)) return false
  try {
    return await claims(name)
  } catch {
    return false
  }
}
