/**
 * Which session each peer is currently talking to.
 *
 * A peer's session id started as a pure function of the peer, which is exactly
 * what `/new` cannot work with: ending a session disposed the handle while the
 * persisted session survived, so the next message resumed the same conversation
 * the user had just ended. The session boundary offers no delete, so "start a new
 * conversation" has to mean "use a different id from now on" - and that choice
 * has to outlive the process, or a restart silently resumes the old one.
 *
 * This is channel state, not a credential, so it sits beside the cursor in the
 * directory this plugin owns.
 */

import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { PeerSessionStore, peerSessionFilePath } from '../../src/channel/peer-session-store.ts'

/** Every directory a test created, removed after it, pass or fail. */
const created: string[] = []

afterEach(() => {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** A temporary state directory; nothing touches the developer's home. */
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-peer-sessions-'))
  created.push(dir)
  return dir
}

describe('the peer session store', () => {
  it('reports generation zero for a peer that has never started a new conversation', async () => {
    // Zero is the id a peer had before `/new` existed, so an untouched peer keeps
    // resuming the conversation it already has.
    const store = new PeerSessionStore(tempDir())

    expect(await store.generation('user-7')).toBe(0)
  })

  it('advances one peer\u2019s generation each time a new conversation starts', async () => {
    const store = new PeerSessionStore(tempDir())

    expect(await store.startNew('user-7')).toBe(1)
    expect(await store.startNew('user-7')).toBe(2)
  })

  it('remembers the generation across a restart', async () => {
    // The whole point: a restart must not resume the conversation the user
    // ended. Reading it back from a fresh instance is what proves it was written.
    const dir = tempDir()
    await new PeerSessionStore(dir).startNew('user-7')

    expect(await new PeerSessionStore(dir).generation('user-7')).toBe(1)
  })

  it('keeps two peers apart', async () => {
    const store = new PeerSessionStore(tempDir())

    await store.startNew('user-7')

    expect(await store.generation('user-8')).toBe(0)
  })

  it('survives a corrupt file rather than failing the run', async () => {
    // A truncated write must not stop the channel. Treating it as "no rotation"
    // costs at worst a resumed conversation, which is far better than refusing
    // to start.
    const dir = tempDir()
    writeFileSync(peerSessionFilePath(dir), '{"peers": not json')

    expect(await new PeerSessionStore(dir).generation('user-7')).toBe(0)
  })

  it('ignores a stored value that is not a generation', async () => {
    const dir = tempDir()
    writeFileSync(peerSessionFilePath(dir), JSON.stringify({ peers: { 'user-7': 'two' } }))

    expect(await new PeerSessionStore(dir).generation('user-7')).toBe(0)
  })

  it('does not lose one peer\u2019s rotation to another\u2019s concurrent one', async () => {
    // Read-modify-write over one file: two peers typing `/new` together must not
    // have one overwrite the other's entry.
    const store = new PeerSessionStore(tempDir())

    await Promise.all([store.startNew('user-7'), store.startNew('user-8')])

    expect(await store.generation('user-7')).toBe(1)
    expect(await store.generation('user-8')).toBe(1)
  })

  // POSIX mode bits are the mechanism this asserts; Windows has none - Node
  // reports 0o666 for every file and protection comes from the directory's
  // ACL, which the harness's own suites likewise do not assert on win32 (see
  // `packages/util/atomic-write/tests/atomic-write.spec.ts`). Skipped rather
  // than loosened so the POSIX guarantee stays covered.
  it.skipIf(process.platform === 'win32')('writes the file with owner-only permissions', async () => {
    const dir = tempDir()
    await new PeerSessionStore(dir).startNew('user-7')

    expect(statSync(peerSessionFilePath(dir)).mode & 0o777).toBe(0o600)
  })

  it('leaves no partial file behind for a reader to find', async () => {
    const dir = tempDir()
    await new PeerSessionStore(dir).startNew('user-7')

    expect(JSON.parse(readFileSync(peerSessionFilePath(dir), 'utf8'))).toEqual({ peers: { 'user-7': 1 } })
  })

  it('creates its directory on first write', async () => {
    const dir = join(tempDir(), 'nested')

    await new PeerSessionStore(dir).startNew('user-7')

    expect(await new PeerSessionStore(dir).generation('user-7')).toBe(1)
  })
})
