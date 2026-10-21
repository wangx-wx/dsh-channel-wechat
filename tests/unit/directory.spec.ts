/**
 * Checking a directory typed over WeChat.
 *
 * Every rejection here happens *before* a session is touched, because the value
 * it accepts is written into a session header that can never be rewritten: a
 * wrong path costs the user the conversation they were in the middle of.
 */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { resolveDirectory } from '../../src/channel/directory.ts'

/** Every directory a test created, removed after it, pass or fail. */
const created: string[] = []

afterEach(() => {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** A temporary directory; nothing touches the developer's own tree. */
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-directory-'))
  created.push(dir)
  return dir
}

describe('resolving a directory typed in chat', () => {
  it('accepts an existing absolute directory', async () => {
    const dir = tempDir()

    await expect(resolveDirectory(dir)).resolves.toBeTruthy()
  })

  it('returns the canonical path, not the typed one', async () => {
    // The value becomes a session's `cwd` and is later compared against what a
    // store holds. Two spellings of one directory that compare unequal would
    // make a session look like it is somewhere else.
    const dir = tempDir()

    const resolved = await resolveDirectory(join(dir, '..', dir.split(/[\\/]/u).pop() ?? ''))

    expect(resolved).not.toContain('..')
  })

  it('refuses a relative path instead of guessing what it meant', async () => {
    // The process's own directory is invisible from a phone, so resolving this
    // would put the conversation somewhere the user never named.
    await expect(resolveDirectory('some/relative/dir')).rejects.toThrow(/绝对路径/u)
  })

  it('refuses a path that does not exist', async () => {
    await expect(resolveDirectory(join(tempDir(), 'missing'))).rejects.toThrow(/不存在/u)
  })

  it('refuses a file', async () => {
    // A file has no directory to run in; accepting it would create a session
    // whose every tool call fails on its first resolution.
    const dir = tempDir()
    const file = join(dir, 'a.txt')
    writeFileSync(file, 'x')

    await expect(resolveDirectory(file)).rejects.toThrow(/不是目录/u)
  })

  it('accepts a nested directory that exists', async () => {
    const dir = tempDir()
    const nested = join(dir, 'a', 'b')
    mkdirSync(nested, { recursive: true })

    await expect(resolveDirectory(nested)).resolves.toBeTruthy()
  })

  it('does not create anything', async () => {
    // Creating the directory would hide a typo: the user would get a new empty
    // directory instead of the project they meant, and only notice much later.
    const dir = tempDir()
    const missing = join(dir, 'not-there')

    await expect(resolveDirectory(missing)).rejects.toThrow()
    await expect(resolveDirectory(missing)).rejects.toThrow()
  })
})
