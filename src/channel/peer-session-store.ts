/**
 * Which session each peer is currently talking to.
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

/** The file holding every peer's current generation. */
const PEER_SESSIONS_FILENAME = 'peer-sessions.json'

/**
 * The path of the peer-session file.
 *
 * One file for every peer rather than one per peer: the set of peers is
 * unbounded and each entry is a single integer, so a file per peer would trade
 * a bounded document for unbounded inode churn.
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
    return await this.serialized(() => Promise.resolve(this.read()[peerId] ?? 0))
  }

  /**
   * Advance one peer's generation, so its next message starts a new session.
   * @param peerId - the WeChat sender id.
   * @returns the generation now current for that peer.
   */
  async startNew(peerId: string): Promise<number> {
    return await this.serialized(() => {
      const peers = this.read()
      const next = (peers[peerId] ?? 0) + 1
      this.write({ ...peers, [peerId]: next })
      return Promise.resolve(next)
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
   * Read every peer's generation.
   *
   * Every failure mode answers "no rotation": a missing file is the ordinary
   * first run, and a corrupt one costs at worst a resumed conversation - which
   * is far better than refusing to start the channel.
   * @returns the stored generations, empty when nothing usable is on disk.
   */
  private read(): Record<string, number> {
    let raw: string
    try {
      raw = readFileSync(peerSessionFilePath(this.stateDir), 'utf8')
    } catch {
      return {}
    }
    try {
      const parsed = JSON.parse(raw) as Partial<PeerSessionsFile>
      const peers = parsed.peers
      if (peers === null || typeof peers !== 'object') return {}
      const usable: Record<string, number> = {}
      for (const [peerId, value] of Object.entries(peers)) {
        // A value that is not a non-negative integer is not a generation the
        // channel ever wrote, so it is ignored rather than trusted into a
        // session id.
        if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) usable[peerId] = value
      }
      return usable
    } catch {
      return {}
    }
  }

  /**
   * Replace the file with one set of generations.
   * @param peers - the complete set to write.
   */
  private write(peers: Record<string, number>): void {
    mkdirSync(this.stateDir, { recursive: true })
    const target = peerSessionFilePath(this.stateDir)
    // The temporary name is beside the target, so the rename stays within one
    // filesystem and is therefore atomic.
    const scratch = `${target}.tmp`
    const body: PeerSessionsFile = { peers }
    writeFileSync(scratch, `${JSON.stringify(body)}\n`, { mode: 0o600 })
    renameSync(scratch, target)
  }
}
