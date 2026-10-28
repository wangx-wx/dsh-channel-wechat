/**
 * The context a peer's slash commands run against.
 *
 * Split out of `channel.ts`, which had grown past its documented size. The
 * boundary is real rather than cosmetic: the channel owns the poll loop, the
 * queue, and the routing; a command only ever needs to *ask* about a peer and
 * *change* its conversation. Everything it needs is therefore expressed here as
 * a small set of callbacks, and the command module never sees the channel.
 *
 * @module dsh-channel-wechat/channel/command-context
 */

import type { PeerMap } from '../bridge/peer-map.ts'
import type { LocalCommandContext } from '../bridge/local-commands.ts'
import type { ModelCommandContext } from '../bridge/model-commands.ts'
import type { NativeCommandRow } from '../bridge/native-commands.ts'
import type { SkillLister } from './channel.ts'

/** What building one peer's command context needs. */
export interface CommandContextOptions {
  /** The peer whose command is running. */
  peerId: string
  /** The peer-to-session map. */
  peers: PeerMap
  /** The account being polled, reported by `/status`. */
  accountId?: string | undefined
  /** Cancel one peer's turn; absent falls back to the lifecycle's own cancel. */
  cancelRunning?: (peerId: string) => Promise<boolean>
  /** Cancel through the lifecycle, used when no override is supplied. */
  cancel: (peerId: string) => Promise<boolean>
  /** Drop one peer's pending cards; absent when no card answerer is composed. */
  cancelCards?: (peerId: string) => number
  /** End a peer's session. */
  endSession: (peerId: string) => Promise<void>
  /** Validate a path and end the session in that directory. */
  changeCwd: (peerId: string, path: string) => Promise<string>
  /** Resolve the harness's own commands for one agent. */
  nativeCommands?: (agent: unknown) => Promise<readonly NativeCommandRow[]>
  /** Resolve the harness's skill names for one agent and directory. */
  skills?: SkillLister
  /** What `/models` and `/model` read and write. */
  models?: ModelCommandContext
}

/**
 * Build the command context for one peer.
 * @param options - the peer, the map, and the callbacks.
 * @returns the context the command router runs against.
 */
export function createCommandContext(options: CommandContextOptions): LocalCommandContext {
  const { peerId, peers } = options
  return {
    peerId,
    cancelRunning: async () => {
      const cancel = options.cancelRunning
      if (cancel !== undefined) return cancel(peerId)
      return options.cancel(peerId)
    },
    ...(options.cancelCards === undefined ? {} : {
      cancelCards: () => options.cancelCards!(peerId),
    }),
    endSession: async () => { await options.endSession(peerId) },
    accountId: options.accountId,
    sessionCount: peers.size,
    // The live session's own header is the durable answer and the only one a
    // tool call actually uses, so it wins over the configured value. After
    // `/new` there is no live handle, and the stored switch is what the next
    // session will record - which is why this goes through the map's own
    // resolution rather than reading only what exists.
    currentCwd: async () => await peers.cwdFor(peerId),
    changeCwd: async path => await options.changeCwd(peerId, path),
    nativeCommands: async () => {
      const list = options.nativeCommands
      if (list === undefined) return []
      // The live handle rather than `sessionFor`: listing what is available must
      // not be the thing that opens a conversation. Passing `undefined` through
      // is deliberate - the lister owns that decision, so a deployment answering
      // from somewhere other than a live agent still can.
      return list(peers.handleFor(peerId)?.agent)
    },
    ...(options.skills === undefined ? {} : {
      skills: async () => {
        // The same resolution `/cwd` reports, so the listing scans the directory
        // the conversation is actually in.
        const cwd = await peers.cwdFor(peerId)
        return options.skills!(peers.handleFor(peerId)?.agent, cwd)
      },
    }),
    models: options.models ?? {
      listModels: undefined,
      switchModel: undefined,
      current: () => ({ provider: '', model: '' }),
    },
  }
}
