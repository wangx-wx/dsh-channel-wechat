/**
 * Which session each peer is currently talking to, and where it runs.
 *
 * A peer's session id started as a pure function of the peer. That is what makes
 * a restart find the same conversation, and it is also what `/new` cannot work
 * with: ending a session disposed the handle while the persisted session
 * survived, so the next message resumed the conversation the user had just
 * ended. The session boundary exposes no delete, so "start a new conversation"
 * can only mean "use a different id from now on".
 *
 * That choice has to outlive the process. Keeping it in memory would make `/new`
 * true until the next restart and then silently resume the old conversation,
 * which is the same broken promise in a slower form.
 *
 * **The working directory rides the same file, and for the same reason.** A
 * session records `cwd` once and can never be moved, so `/cwd` means "start a
 * different conversation in that directory". If the directory lived only in
 * memory, a restart would drop it and the next message would create a session
 * back in the configured default - the user would find their switch silently
 * undone, which is exactly the `/new` defect in another costume.
 *
 * It is channel state rather than a credential, so it sits beside the cursor in
 * the directory this plugin owns.
 *
 * @module dsh-channel-wechat/channel/peer-session-store
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'

/** The directory this plugin keeps its own state in, under the harness home. */
const STATE_DIRNAME = 'channel-wechat'

/** The file holding every peer's current generation and directory. */
const PEER_SESSIONS_FILENAME = 'peer-sessions.json'

/**
 * The path of the peer-session file.
 *
 * One file for every peer rather than one per peer: the set of peers is
 * unbounded and each entry is a single integer plus at most one path, so a file
 * per peer would trade a bounded document for unbounded inode churn.
 * @param stateDir - the directory this plugin owns.
 * @returns the absolute path of the peer-session file.
 */
export function peerSessionFilePath(stateDir: string): string {
  return join(stateDir, PEER_SESSIONS_FILENAME)
}

/** The shape written to disk. */
interface PeerSessionsFile {
  /** One generation per peer id. */
  peers: Record<string, number>
  /**
   * One working directory per peer id, for peers that switched.
   *
   * Absent entries mean "no switch", which falls through to the channel's
   * configured directory. Optional rather than defaulted so a file written by
   * an earlier version - which had no such field - keeps loading.
   */
  cwds?: Record<string, string>
}

/**
 * Reads and advances each peer's conversation generation.
 *
 * Writes go through a temporary file and a rename, so a crash mid-write cannot
 * leave a half-written file for the next start to parse. Reads and writes are
 * serialized in-process, because `/new` is a read-modify-write over one shared
 * file and two peers typing it at once would otherwise lose one entry.
 */
export class PeerSessionStore {
  private readonly stateDir: string
  /** Serializes every read-modify-write, so two peers cannot clobber each other. */
  private tail: Promise<unknown> = Promise.resolve()

  /**
   * @param stateDir - where to keep generations; defaults under the harness home.
   */
  constructor(stateDir?: string) {
    this.stateDir = stateDir ?? join(resolveDshHome(), STATE_DIRNAME)
  }

  /**
   * Read one peer's current generation.
   * @param peerId - the WeChat sender id.
   * @returns the generation; zero when this peer has never started a new one.
   */
  async generation(peerId: string): Promise<number> {
    // Read behind the write queue, so a caller never observes a value from
    // before a rotation it already awaited.
    return await this.serialized(() => Promise.resolve(this.read().peers[peerId] ?? 0))
  }

  /**
   * Advance one peer's generation, so its next message starts a new session.
   * @param peerId - the WeChat sender id.
   * @returns the generation now current for that peer.
   */
  async startNew(peerId: string): Promise<number> {
    return await this.serialized(() => {
      const state = this.read()
      const next = (state.peers[peerId] ?? 0) + 1
      this.write({ ...state, peers: { ...state.peers, [peerId]: next } })
      return Promise.resolve(next)
    })
  }

  /**
   * Read the directory one peer's next session will record.
   * @param peerId - the WeChat sender id.
   * @returns the stored absolute directory, or `undefined` when this peer never
   *   switched and should follow the channel's configured directory.
   */
  async cwd(peerId: string): Promise<string | undefined> {
    return await this.serialized(() => Promise.resolve(this.read().cwds[peerId]))
  }

  /**
   * Record one peer's working directory for its next session.
   *
   * Written through the same read-modify-write queue as a rotation, because the
   * two fields share one document: two peers running `/cwd` and `/new` at once
   * would otherwise each write the other's field away.
   * @param peerId - the WeChat sender id.
   * @param path - the absolute directory to record.
   */
  async setCwd(peerId: string, path: string): Promise<void> {
    await this.serialized(() => {
      const state = this.read()
      this.write({ ...state, cwds: { ...state.cwds, [peerId]: path } })
      return Promise.resolve(undefined)
    })
  }

  /**
   * Run one read-modify-write after every earlier one has settled.
   *
   * A rejected operation must not wedge the queue for the rest of the process,
   * so the chain continues on failure while the caller still sees the rejection.
   * @param work - the operation to run.
   * @returns the operation's result.
   */
  private async serialized<Value>(work: () => Promise<Value>): Promise<Value> {
    const run = this.tail.then(work, work)
    this.tail = run.then(() => undefined, () => undefined)
    return await run
  }

  /**
   * Read every peer's generation and recorded directory.
   *
   * Every failure mode answers "no rotation, no switch": a missing file is the
   * ordinary first run, and a corrupt one costs at worst a resumed conversation
   * in the configured directory - which is far better than refusing to start the
   * channel. A `cwds` field that is not an object is dropped rather than
   * trusted, so a hand-edited file cannot put a session somewhere impossible.
   * @returns the stored state, empty when nothing usable is on disk.
   */
  private read(): { peers: Record<string, number>; cwds: Record<string, string> } {
    let raw: string
    try {
      raw = readFileSync(peerSessionFilePath(this.stateDir), 'utf8')
    } catch {
      return { peers: {}, cwds: {} }
    }
    try {
      const parsed = JSON.parse(raw) as Partial<PeerSessionsFile>
      const peers = parsed.peers
      if (peers === null || typeof peers !== 'object') return { peers: {}, cwds: {} }
      const usable: Record<string, number> = {}
      for (const [peerId, value] of Object.entries(peers)) {
        // A value that is not a non-negative integer is not a generation the
        // channel ever wrote, so it is ignored rather than trusted into a
        // session id.
        if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) usable[peerId] = value
      }
      const cwds: Record<string, string> = {}
      const stored = parsed.cwds
      if (stored !== null && typeof stored === 'object') {
        for (const [peerId, value] of Object.entries(stored)) {
          // Only a non-empty string is a directory this channel could have
          // written; whether it still exists is decided when a session is
          // created, not here.
          if (typeof value === 'string' && value !== '') cwds[peerId] = value
        }
      }
      return { peers: usable, cwds }
    } catch {
      return { peers: {}, cwds: {} }
    }
  }

  /**
   * Replace the file with one complete state.
   *
   * Both fields are always written, because they share a document: a partial
   * write would drop the other one.
   * @param state - the complete state to write.
   */
  private write(state: { peers: Record<string, number>; cwds: Record<string, string> }): void {
    mkdirSync(this.stateDir, { recursive: true })
    const target = peerSessionFilePath(this.stateDir)
    // The temporary name is beside the target, so the rename stays within one
    // filesystem and is therefore atomic.
    const scratch = `${target}.tmp`
    const body: PeerSessionsFile = { peers: state.peers, cwds: state.cwds }
    writeFileSync(scratch, `${JSON.stringify(body)}\n`, { mode: 0o600 })
    renameSync(scratch, target)
  }
}
