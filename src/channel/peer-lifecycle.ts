/**
 * Ending, moving, and cancelling a peer's conversation.
 *
 * Split out of `channel.ts`, which had grown past its documented size, and
 * because these four operations share one subject: a peer's session and the
 * generation that addresses it. Keeping them together is what makes the ordering
 * rule visible in one place instead of scattered between the channel's own
 * methods.
 *
 * The rule they all obey: **advance the generation before disposing the handle.**
 * Disposing alone was a real defect - a peer's session id was derived from the
 * peer alone, so the persisted session outlived the handle and the next message
 * resumed the conversation the user had just ended, the opposite of what `/new`
 * told them.
 *
 * @module dsh-channel-wechat/channel/peer-lifecycle
 */

import type { PeerMap } from '../bridge/peer-map.ts'

/** What these operations need from the channel. */
export interface PeerLifecycleOptions {
  /** The peer-to-session map, which owns the generations. */
  peers: PeerMap
  /** The session id to peer id routing, which must forget an ended session. */
  sessionToPeer: Map<string, string>
}

/** The operations, bound to one channel's map. */
export interface PeerLifecycle {
  /** Cancel a peer's running turn; reports whether one was cancelled. */
  cancel: (peerId: string) => Promise<boolean>
  /** End a peer's session so the next message starts a fresh one. */
  end: (peerId: string) => Promise<void>
  /** End a peer's session and record the directory the next one uses. */
  endIn: (peerId: string, path: string) => Promise<void>
}

/**
 * Build the lifecycle operations.
 * @param options - the peer map and the routing table.
 * @returns the operations.
 */
export function createPeerLifecycle(options: PeerLifecycleOptions): PeerLifecycle {
  const { peers, sessionToPeer } = options

  /** Forget the routing entry for a handle that is being disposed. */
  const forgetSession = (handle: { agent: { id: unknown } } | undefined): string | undefined => {
    if (handle === undefined) return undefined
    const id = String(handle.agent.id)
    sessionToPeer.delete(id)
    return id
  }

  return {
    async cancel(peerId) {
      // Waits out a session still being created: the turn can start before the
      // session is recorded, which is exactly when a stop matters most.
      const handle = await peers.liveHandleFor(peerId)
      if (handle === undefined) return false
      const agent = handle.agent as unknown as { cancel?: (cause: { kind: string }) => void }
      if (typeof agent.cancel !== 'function') return false
      agent.cancel({ kind: 'user' })
      return true
    },

    async end(peerId) {
      const handle = peers.handleFor(peerId)
      peers.forget(peerId)
      await peers.startNew(peerId)
      if (forgetSession(handle) === undefined) return
      await handle?.dispose()
    },

    async endIn(peerId, path) {
      // Recorded first, then the generation advances, then the old handle goes.
      // Recording last would leave a window where the next message creates a
      // session in the old directory under the new id - one the user cannot move.
      const handle = peers.handleFor(peerId)
      peers.forget(peerId)
      await peers.startNewIn(peerId, path)
      if (forgetSession(handle) === undefined) return
      await handle?.dispose()
    },
  }
}
