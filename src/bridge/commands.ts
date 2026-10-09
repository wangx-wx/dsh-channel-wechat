/**
 * Slash commands over WeChat.
 *
 * Two surfaces sit behind one line of text:
 *
 *  - **This channel's own commands** — `/stop`, `/status`, `/new`, `/cwd`,
 *    `/reconnect`, `/help`. They are handled here because only the channel
 *    knows its peers, its sessions, and its connection.
 *  - **The harness's commands** — `/goal`, `/compact`, `/permission`, and
 *    anything a later plugin registers. They are forwarded to `ctx.commands`,
 *    so the surface stays as wide as the harness's own rather than a list this
 *    plugin has to keep in sync.
 *
 * The routing matters as much as the parsing: a command is handled *outside*
 * the peer's turn queue. A `/stop` that queued behind the turn it means to stop
 * could never arrive.
 *
 * @module dsh-channel-wechat/bridge/commands
 */

/** A parsed command line. */
export interface ParsedCommand {
  /** The command name, without the leading slash. */
  name: string
  /** Everything after the separating whitespace, verbatim. */
  args: string
}

/** A command's outcome, shaped like the harness's own result. */
export interface CommandOutcome {
  /** Whether the command succeeded. */
  kind: 'success' | 'error'
  /** Text to show the user, when there is any. */
  text?: string
}

/** The channel's own command names. */
export const LOCAL_COMMANDS = ['stop', 'status', 'new', 'cwd', 'help', 'reconnect'] as const

/**
 * The harness's command grammar, from its own parser.
 *
 * Anchored at byte zero, a lowercase-initial identifier, then end-of-input or
 * whitespace. Sharing the grammar keeps this channel's reading of a command
 * line identical to the one the harness will apply when the line is forwarded.
 */
const COMMAND_PATTERN = /^\/([a-z][a-z0-9_-]*)(?=$|[\t\n\r ])/u

/**
 * Read a command line.
 * @param text - the message text.
 * @returns the parsed command, or `undefined` when this is not one.
 */
export function parseCommandLine(text: string): ParsedCommand | undefined {
  const match = COMMAND_PATTERN.exec(text)
  if (match === null) return undefined
  const name = match[1]
  if (name === undefined) return undefined
  // `rawInput` keeps the separating whitespace in the harness; the arguments
  // are what follows it, with surrounding whitespace dropped.
  return { name, args: text.slice(match[0].length).trim() }
}

/** Collaborators for {@link routeCommand}. */
export interface RouteOptions {
  /** Handle one of this channel's commands. */
  handleLocal: (command: ParsedCommand) => CommandOutcome | Promise<CommandOutcome>
  /**
   * Forward a line to the harness's command runtime.
   * @returns its outcome, or `undefined` when the harness does not know it.
   */
  executeNative: (line: string) => Promise<CommandOutcome | undefined>
}

/**
 * Route one piece of message text.
 * @param text - the message text.
 * @param options - the two handlers.
 * @returns the outcome, or `undefined` when this is ordinary text.
 */
export async function routeCommand(text: string, options: RouteOptions): Promise<CommandOutcome | undefined> {
  const command = parseCommandLine(text)
  if (command === undefined) return undefined

  if ((LOCAL_COMMANDS as readonly string[]).includes(command.name)) {
    return options.handleLocal(command)
  }

  // Everything else belongs to the harness. It returns `undefined` for both an
  // unknown name and a grammar it rejects, so the channel says so rather than
  // silently swallowing what the user typed.
  const outcome = await options.executeNative(text)
  if (outcome !== undefined) return outcome
  return { kind: 'error', text: `未知命令：/${command.name}` }
}
