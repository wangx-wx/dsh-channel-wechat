/**
 * Where the long-poll cursor is kept between runs.
 *
 * `get_updates_buf` tells the server which messages are new. Losing it is not
 * fatal — the server re-sends what it still holds — but losing it on every
 * start means every restart replays the recent conversation as fresh turns, and
 * the user gets answers to messages that were already answered.
 *
 * It is not a credential, so it does not belong in the credential store: it is
 * a small piece of channel state this plugin owns, written beside its other
 * files under the harness home.
 *
 * @module dsh-channel-wechat/channel/cursor-store
 */

import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'

/** The directory this plugin keeps its own state in, under the harness home. */
const STATE_DIRNAME = 'channel-wechat'

/** The file extension for one account's cursor. */
const CURSOR_SUFFIX = '.cursor.json'

/**
 * Build the cursor path for one account.
 *
 * The account id is percent-encoded rather than interpolated raw: it comes from
 * the server and is otherwise opaque, so an id containing a separator must not
 * be able to point outside the state directory.
 * @param stateDir - the directory this plugin owns.
 * @param accountId - the server-issued account id.
 * @returns the absolute path of that account's cursor file.
 */
export function cursorFilePath(stateDir: string, accountId: string): string {
  return join(stateDir, `${encodeURIComponent(accountId)}${CURSOR_SUFFIX}`)
}

/** The shape written to disk. */
interface CursorFile {
  /** The cursor the server returned. */
  cursor: string
}

/**
 * Reads and writes one account's poll cursor.
 *
 * Writes go through a temporary file and a rename, so a crash mid-write cannot
 * leave a half-written cursor for the next start to parse.
 */
export class CursorStore {
  private readonly stateDir: string

  /**
   * @param stateDir - where to keep cursors; defaults under the harness home.
   */
  constructor(stateDir?: string) {
    this.stateDir = stateDir ?? join(resolveDshHome(), STATE_DIRNAME)
  }

  /**
   * Read one account's cursor.
   * @param accountId - the server-issued account id.
   * @returns the cursor, or `undefined` when there is none to resume from.
   */
  async load(accountId: string): Promise<string | undefined> {
    let raw: string
    try {
      raw = readFileSync(cursorFilePath(this.stateDir, accountId), 'utf8')
    } catch {
      // No file is the ordinary case on a first run.
      return undefined
    }
    try {
      const parsed = JSON.parse(raw) as Partial<CursorFile>
      return typeof parsed.cursor === 'string' && parsed.cursor !== '' ? parsed.cursor : undefined
    } catch {
      // A corrupt cursor costs a replay, which is much better than refusing to
      // start. It is treated as absent.
      return undefined
    }
  }

  /**
   * Persist one account's cursor.
   * @param accountId - the server-issued account id.
   * @param cursor - the cursor the server returned.
   */
  async save(accountId: string, cursor: string): Promise<void> {
    mkdirSync(this.stateDir, { recursive: true })
    const target = cursorFilePath(this.stateDir, accountId)
    // The temporary name is beside the target, so the rename stays within one
    // filesystem and is therefore atomic.
    const scratch = `${target}.tmp`
    const body: CursorFile = { cursor }
    writeFileSync(scratch, `${JSON.stringify(body)}\n`, { mode: 0o600 })
    renameSync(scratch, target)
  }

  /**
   * Forget one account's cursor.
   * @param accountId - the server-issued account id.
   */
  async clear(accountId: string): Promise<void> {
    rmSync(cursorFilePath(this.stateDir, accountId), { force: true })
  }
}
