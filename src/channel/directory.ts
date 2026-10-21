/**
 * Checking that a directory typed over WeChat can actually be used.
 *
 * `/cwd` is the only command that moves a conversation, and the value it moves
 * to is written into a session header that can never be rewritten. Every check
 * therefore has to happen *before* the session is torn down: a typo must cost
 * the user one message, not the conversation they were in the middle of.
 *
 * A relative path is refused rather than resolved. The process's own directory
 * is invisible from a phone, so resolving `src` would put the conversation
 * somewhere the user never named - and they would only find out when tools
 * started reading and writing in the wrong place.
 *
 * @module dsh-channel-wechat/channel/directory
 */

import { isAbsolute } from 'node:path'
import { realpath, stat } from 'node:fs/promises'

/**
 * Validate a path and return the directory it names, canonically.
 *
 * Canonical because the value becomes a session's `cwd` and is later compared
 * against what a store holds: `D:\work\proj` and `D:\work\proj\..\proj` are the
 * same directory but different strings, and a session created under one would
 * look "not the current directory" to the other.
 *
 * @param path - the path the user typed.
 * @returns the canonical absolute directory.
 * @throws when the path is relative, missing, or not a directory.
 */
export async function resolveDirectory(path: string): Promise<string> {
  if (!isAbsolute(path)) throw new Error('请给出绝对路径，例如 `/cwd D:\\workspace\\my-project`')
  let info
  try {
    info = await stat(path)
  } catch {
    throw new Error('目录不存在')
  }
  if (!info.isDirectory()) throw new Error('这不是目录')
  return await realpath(path)
}
