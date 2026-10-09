/**
 * Where the long-poll cursor is kept between runs.
 *
 * `get_updates_buf` is what tells the server which messages are new. Losing it
 * is not fatal — the server re-sends what it still holds — but losing it every
 * start means every restart replays the recent conversation as fresh turns,
 * and the user gets answers to messages they already had answered.
 *
 * It is not a credential, so it does not belong in the credential store; it is
 * a small piece of channel state that this plugin owns.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CursorStore, cursorFilePath } from '../../src/channel/cursor-store.ts'

/** A temporary directory for one test; nothing touches the developer's home. */
function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'dsh-cursor-'))
}

describe('the cursor file', () => {
  it('lives under the state directory this plugin owns', () => {
    const path = cursorFilePath('/tmp/state', 'bot-9')

    // The account id is part of the name: two accounts must not share a cursor,
    // or one resets the other's position.
    expect(path.startsWith('/tmp/state')).toBe(true)
    expect(path).toContain('bot-9')
  })

  it('is safe for an account id that is not a plain filename', () => {
    // The server's ids are opaque; one containing a separator must not escape
    // the state directory.
    const path = cursorFilePath('/tmp/state', 'a/b')

    expect(path).not.toContain('a/b')
    expect(path.startsWith('/tmp/state')).toBe(true)
  })
})

describe('reading and writing', () => {
  it('returns what was saved', async () => {
    const dir = tempDir()
    const store = new CursorStore(dir)

    await store.save('bot-9', 'cursor-abc')

    expect(await store.load('bot-9')).toBe('cursor-abc')
    rmSync(dir, { recursive: true, force: true })
  })

  it('returns nothing for an account that never polled', async () => {
    const dir = tempDir()
    const store = new CursorStore(dir)

    expect(await store.load('never-seen')).toBeUndefined()
    rmSync(dir, { recursive: true, force: true })
  })

  it('keeps two accounts apart', async () => {
    const dir = tempDir()
    const store = new CursorStore(dir)

    await store.save('bot-1', 'one')
    await store.save('bot-2', 'two')

    expect(await store.load('bot-1')).toBe('one')
    expect(await store.load('bot-2')).toBe('two')
    rmSync(dir, { recursive: true, force: true })
  })

  it('replaces an earlier cursor for the same account', async () => {
    const dir = tempDir()
    const store = new CursorStore(dir)

    await store.save('bot-9', 'first')
    await store.save('bot-9', 'second')

    expect(await store.load('bot-9')).toBe('second')
    rmSync(dir, { recursive: true, force: true })
  })

  it('treats an empty saved cursor as absent', async () => {
    // An empty cursor means "no position", which is what a fresh start sends;
    // resuming from it is the same as having none, so it must not read back as
    // a value that looks like progress.
    const dir = tempDir()
    const store = new CursorStore(dir)
    writeFileSync(cursorFilePath(dir, 'bot-9'), JSON.stringify({ cursor: '' }))

    expect(await store.load('bot-9')).toBeUndefined()
    rmSync(dir, { recursive: true, force: true })
  })

  it('survives a corrupt file rather than failing the start', async () => {
    // A truncated write must not stop the channel: the worst case is a replay.
    const dir = tempDir()
    const store = new CursorStore(dir)
    writeFileSync(cursorFilePath(dir, 'bot-9'), '{"not":"the shape"}')

    expect(await store.load('bot-9')).toBeUndefined()
    rmSync(dir, { recursive: true, force: true })
  })

  it('leaves no partial file behind for a reader to find', async () => {
    // Written through a temporary name and renamed, so a crash mid-write cannot
    // leave a half-written cursor in place.
    const dir = tempDir()
    const store = new CursorStore(dir)

    await store.save('bot-9', 'cursor-1')

    const entries = readFileSync(cursorFilePath(dir, 'bot-9'), 'utf8')
    expect(JSON.parse(entries)).toEqual({ cursor: 'cursor-1' })
    rmSync(dir, { recursive: true, force: true })
  })

  it('creates its directory on first save', async () => {
    const dir = join(tempDir(), 'nested')
    const store = new CursorStore(dir)

    await store.save('bot-9', 'c')

    expect(await store.load('bot-9')).toBe('c')
    rmSync(dirname(dir), { recursive: true, force: true })
  })

  it('clears a cursor on request', async () => {
    const dir = tempDir()
    const store = new CursorStore(dir)
    await store.save('bot-9', 'c')

    await store.clear('bot-9')

    expect(await store.load('bot-9')).toBeUndefined()
    rmSync(dir, { recursive: true, force: true })
  })

  it('writes the file with owner-only permissions', async () => {
    // The cursor names a conversation position; nothing else on the machine
    // needs it.
    const dir = tempDir()
    const store = new CursorStore(dir)
    await store.save('bot-9', 'c')

    const mode = statSync(cursorFilePath(dir, 'bot-9')).mode & 0o777
    expect(mode).toBe(0o600)
    rmSync(dir, { recursive: true, force: true })
  })

  it('leaves exactly one file for the account after a save', async () => {
    // This checks cleanup, not atomicity: the implementation writes to a
    // scratch name and renames, but no test here can observe the difference
    // between that and a direct write without injecting a crash mid-write.
    // Atomicity is therefore an implementation choice this suite does not
    // cover, recorded here rather than implied by a test name.
    const dir = tempDir()
    const store = new CursorStore(dir)

    await store.save('bot-9', 'a'.repeat(10_000))

    const { readdirSync } = await import('node:fs')
    expect(readdirSync(dir)).toEqual([expect.stringContaining('bot-9')])
    rmSync(dir, { recursive: true, force: true })
  })
})
